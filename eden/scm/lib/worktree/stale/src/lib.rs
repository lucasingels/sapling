/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Stale checkouts of a git worktree group.
//!
//! The checkouts of a worktree group share their commits. Rewriting a commit
//! (amend, rebase, restack, ...) only moves the checkout running the command.
//! Another checkout that has the old version checked out, or its own commits
//! stacked on it, is then stale, the way jj marks a workspace stale when
//! another workspace rewrites its working-copy commit.
//!
//! This crate only detects that state, and which checkouts are done with
//! (their commit landed or was abandoned, or they sit unused on a public
//! commit) for `sl worktree prune` and `sl worktree list`. Moving a stale
//! checkout onto the latest versions (`sl update-stale`) lives in Python, in
//! `worktreestale.py`, which calls into this crate through the `repo`
//! bindings.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use anyhow::Result;
use async_runtime::block_on;
use commits_trait::DagCommits;
use configmodel::ConfigExt;
use dag::Set;
use dag::Vertex;
use mutationstore::MutationStore;
use pathmatcher::TreeMatcher;
use repo::repo::Repo;
use repo_minimal_info::RepoMinimalInfo;
use repostate::command_state::Conflict;
use repostate::command_state::Operation;
use types::HgId;

/// How a checkout is stale.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StaleKind {
    /// The working copy parent itself was rewritten.
    Rewritten,
    /// A commit below the working copy parent was rewritten.
    Orphaned,
}

impl StaleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StaleKind::Rewritten => "rewritten",
            StaleKind::Orphaned => "orphaned",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaleState {
    pub kind: StaleKind,
    /// The rewritten commit: the working copy parent, or one below it.
    pub commit: HgId,
}

impl StaleState {
    /// Why the checkout is stale, for messages.
    pub fn message(&self, repo: &Repo) -> String {
        let commit = describe(repo, &self.commit);
        match self.kind {
            StaleKind::Rewritten => {
                format!("this worktree's commit {commit} was rewritten in another worktree")
            }
            StaleKind::Orphaned => {
                format!("{commit}, below this worktree's commit, was rewritten in another worktree")
            }
        }
    }

    /// The note read-only commands print in a stale checkout.
    pub fn note(&self, repo: &Repo) -> String {
        format!(
            "note: {}; '{} update-stale' moves it onto the latest versions\n",
            self.message(repo),
            repo.ident().cli_name(),
        )
    }
}

/// Whether `repo` is a checkout of a git worktree group with other checkouts.
pub fn in_group(repo: &Repo) -> bool {
    in_group_at(repo, repo.path())
}

/// Whether the checkout at `root`, of the same repo as `repo`, is in a git
/// worktree group with other checkouts.
fn in_group_at(repo: &Repo, root: &Path) -> bool {
    if !repo.requirements.contains("dotgit") {
        return false;
    }
    let dotgit = root.join(".git");
    if dotgit.is_file() {
        // A linked worktree: ".git" points into the main checkout's git dir.
        return true;
    }
    fs::read_dir(dotgit.join("worktrees"))
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// The stale state of the checkout at `repo`, whose working copy parents are
/// `parents`, or None when there is nothing to check: outside a worktree
/// group, during a merge or an unfinished rebase, graft, ..., which own the
/// working copy, or on a public commit.
pub fn checkout_state(repo: &Repo, parents: &[HgId]) -> Result<Option<StaleState>> {
    checkout_state_at(repo, repo.path(), repo.dot_hg_path(), parents)
}

/// Like [`checkout_state`], for another checkout of `repo`'s group, the one
/// at `root` with working copy parents `parents`, judged the way that checkout
/// would judge itself.
pub fn other_checkout_state(
    repo: &Repo,
    root: &Path,
    parents: &[HgId],
) -> Result<Option<StaleState>> {
    if !in_group_at(repo, root) {
        return Ok(None);
    }
    let info = RepoMinimalInfo::from_repo_root(root.to_path_buf())?;
    checkout_state_at(repo, root, &info.dot_hg_path, parents)
}

fn checkout_state_at(
    repo: &Repo,
    root: &Path,
    dot_path: &Path,
    parents: &[HgId],
) -> Result<Option<StaleState>> {
    if !in_group_at(repo, root) {
        return Ok(None);
    }
    let mut parents = parents.iter().filter(|p| !p.is_null());
    let Some(p1) = parents.next() else {
        return Ok(None);
    };
    if parents.next().is_some() {
        return Ok(None);
    }
    if has_unfinished_operation(dot_path)? {
        return Ok(None);
    }
    let dag = repo.dag_commits()?;
    let dag = dag.read();
    block_on(async {
        let graph = Graph::new(repo, &**dag, &[*p1]).await?;
        if !graph.has_node(p1).await? || graph.is_public(p1).await? {
            return Ok(None);
        }
        graph.stale_state(p1).await
    })
}

/// Whether a merge, rebase, graft, ... is unfinished in the checkout whose
/// dot dir is `dot_path`.
fn has_unfinished_operation(dot_path: &Path) -> Result<bool> {
    match repostate::command_state::try_operation(dot_path, Operation::Other) {
        Ok(()) => Ok(false),
        Err(err) if err.downcast_ref::<Conflict>().is_some() => Ok(true),
        Err(err) => Err(err),
    }
}

/// The note for read-only commands when the checkout at `repo` is stale.
/// Best effort: a read-only command should not fail because the check did.
pub fn checkout_note(repo: &Repo, parents: &[HgId]) -> Option<String> {
    match checkout_state(repo, parents) {
        Ok(state) => state.map(|state| state.note(repo)),
        Err(err) => {
            tracing::warn!("cannot check whether this worktree is stale: {err:?}");
            None
        }
    }
}

/// The stale state of a checkout at `node`, judged by the visibility of the
/// repo running the command, whose working copy parents are `wdir_parents`.
/// Unlike [`checkout_state`] this does not look at the checkout itself; a
/// rewriting command uses it for the other checkouts of its group.
pub fn stale_state(repo: &Repo, node: &HgId, wdir_parents: &[HgId]) -> Result<Option<StaleState>> {
    let dag = repo.dag_commits()?;
    let dag = dag.read();
    block_on(async {
        let graph = Graph::new(repo, &**dag, wdir_parents).await?;
        graph.stale_state(node).await
    })
}

/// Why a checkout's commit is done with, so the checkout can go.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Finished {
    /// The commit, or a later version of it, is public.
    Landed,
    /// The commit is public, and the checkout was made on it while it was a
    /// draft, but nothing was committed there. Whoever made the checkout may
    /// still be using it, so, like an idle one, it is only done with once it
    /// has not been used for a while.
    LandedUnused,
    /// The commit is hidden and no later version of it is visible.
    Abandoned,
    /// The commit is public and never was this checkout's draft. A fresh
    /// checkout looks like this, so it is only done with once it has not been
    /// used for a while.
    Idle,
}

impl Finished {
    pub fn as_str(self) -> &'static str {
        match self {
            Finished::Landed | Finished::LandedUnused => "landed",
            Finished::Abandoned => "abandoned",
            Finished::Idle => "idle",
        }
    }

    /// Whether the checkout is only done with once it has not been used for
    /// a while.
    pub fn needs_age(self) -> bool {
        matches!(self, Finished::LandedUnused | Finished::Idle)
    }
}

/// Whether a checkout at `node` is done with, judged by the visibility of the
/// repo running the command, whose working copy parents are `wdir_parents`.
/// None while the commit is visible and draft, and also when it is hidden but
/// a later draft version is visible: that checkout is stale, its work goes on
/// in the later version.
pub fn finished_state(repo: &Repo, node: &HgId, wdir_parents: &[HgId]) -> Result<Option<Finished>> {
    let dag = repo.dag_commits()?;
    let dag = dag.read();
    block_on(async {
        let graph = Graph::new(repo, &**dag, wdir_parents).await?;
        graph.finished_state(node).await
    })
}

/// Like [`finished_state`], for the checkout at `root` of `repo`'s group,
/// which has `node` checked out. None while an operation (merge, rebase, ...)
/// is unfinished there: that checkout is in use. For a public `node`, the
/// checkout's own records tell [`Finished::Landed`], [`Finished::LandedUnused`]
/// and [`Finished::Idle`] apart (see `Graph::public_verdict`).
pub fn other_checkout_finished(
    repo: &Repo,
    root: &Path,
    node: &HgId,
    wdir_parents: &[HgId],
) -> Result<Option<Finished>> {
    Ok(summarize(repo, root, node, wdir_parents, false)?.finished)
}

/// What `sl worktree list` says about another checkout of `repo`'s group.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CheckoutSummary {
    /// See [`other_checkout_finished`].
    pub finished: Option<Finished>,
    /// A merge, rebase, graft, ... is unfinished there.
    pub unfinished: bool,
    /// The number of draft commits in the checked out stack, the checked out
    /// commit included.
    pub drafts: u64,
}

/// [`other_checkout_finished`] for the checkout at `root`, which has `node`
/// checked out, along with whether an operation is unfinished there and how
/// many drafts its stack has.
pub fn other_checkout_summary(
    repo: &Repo,
    root: &Path,
    node: &HgId,
    wdir_parents: &[HgId],
) -> Result<CheckoutSummary> {
    summarize(repo, root, node, wdir_parents, true)
}

fn summarize(
    repo: &Repo,
    root: &Path,
    node: &HgId,
    wdir_parents: &[HgId],
    count_drafts: bool,
) -> Result<CheckoutSummary> {
    let info = RepoMinimalInfo::from_repo_root(root.to_path_buf())?;
    let unfinished = has_unfinished_operation(&info.dot_hg_path)?;
    let dag = repo.dag_commits()?;
    let dag = dag.read();
    block_on(async {
        let graph = Graph::new(repo, &**dag, wdir_parents).await?;
        let mut finished = if unfinished {
            None
        } else {
            graph.finished_state(node).await?
        };
        if finished == Some(Finished::Landed) && graph.is_public(node).await? {
            finished = Some(graph.public_verdict(&info.dot_hg_path, node).await?);
        }
        let drafts = if count_drafts {
            graph.draft_count(node).await?
        } else {
            0
        };
        Ok(CheckoutSummary {
            finished,
            unfinished,
            drafts,
        })
    })
}

/// Whether a merge, rebase, graft, ... is unfinished in the checkout at
/// `root`.
pub fn other_checkout_unfinished(root: &Path) -> Result<bool> {
    let info = RepoMinimalInfo::from_repo_root(root.to_path_buf())?;
    has_unfinished_operation(&info.dot_hg_path)
}

/// In a checkout's dot dir: the commit `sl commit` or `sl amend` last made
/// there, written by `worktreestale.recordcommit`.
const LAST_COMMIT_FILE: &str = "worktree-last-commit";

/// In a checkout's dot dir: the draft commit `sl worktree add` made it on.
const DRAFT_BASE_FILE: &str = "worktree-draft-base";

/// Note in the dot dir `dot_path` of a new checkout of `repo`'s group that it
/// was made on `node`, when `node` is a draft, so that it does not count as
/// idle once `node` lands (see [`other_checkout_finished`]).
pub fn record_checkout_base(repo: &Repo, dot_path: &Path, node: &HgId) -> Result<()> {
    let dag = repo.dag_commits()?;
    let dag = dag.read();
    let public = block_on(async {
        let graph = Graph::new(repo, &**dag, &[*node]).await?;
        graph.is_public(node).await
    })?;
    if !public {
        fs::write(dot_path.join(DRAFT_BASE_FILE), format!("{}\n", node.to_hex()))?;
    }
    Ok(())
}

/// The commit graph as the stale check sees it, matching Python's
/// `mutation.getisvisiblefunc` and `getispublicfunc` under narrow-heads.
struct Graph<'a> {
    dag: &'a (dyn DagCommits + Send),
    /// Opened afresh: Python keeps its own mutation store, so a cached one
    /// would miss what the current Python command just recorded.
    mutation: MutationStore,
    public: Set,
    visible: Set,
}

impl<'a> Graph<'a> {
    async fn new(
        repo: &Repo,
        dag: &'a (dyn DagCommits + Send),
        wdir_parents: &[HgId],
    ) -> Result<Graph<'a>> {
        let mutation = MutationStore::open(repo.store_path().join("mutation"))?;

        let (public_heads, remote_draft_heads) = remote_heads(repo)?;
        let metalog = repo.metalog()?;
        let metalog = metalog.read();
        let draft_heads: Vec<HgId> = wdir_parents
            .iter()
            .copied()
            .chain(metalog.get_bookmarks()?.into_values())
            .chain(remote_draft_heads)
            .chain(metalog.get_visibleheads()?)
            .collect();

        let public_heads = local_set(dag, public_heads).await?;
        let draft_heads = local_set(dag, draft_heads).await?;
        let public = dag.ancestors(public_heads.clone()).await?;
        let visible = dag.ancestors(public_heads | draft_heads).await?;
        Ok(Graph {
            dag,
            mutation,
            public,
            visible,
        })
    }

    async fn has_node(&self, node: &HgId) -> Result<bool> {
        let found = self
            .dag
            .contains_vertex_name_locally(&[vertex(node)])
            .await?;
        Ok(found.first().copied().unwrap_or(false))
    }

    async fn is_public(&self, node: &HgId) -> Result<bool> {
        Ok(self.has_node(node).await? && self.public.contains(&vertex(node)).await?)
    }

    async fn is_visible(&self, node: &HgId) -> Result<bool> {
        Ok(self.has_node(node).await? && self.visible.contains(&vertex(node)).await?)
    }

    async fn parents(&self, node: &HgId) -> Result<Vec<HgId>> {
        self.dag
            .parent_names(vertex(node))
            .await?
            .iter()
            .map(|p| Ok(HgId::from_slice(p.as_ref())?))
            .collect()
    }

    /// Whether a later version of `node` (a successor at any depth) is
    /// visible.
    async fn has_newer_version(&self, node: &HgId) -> Result<bool> {
        Ok(!self.visible_newer_versions(node, true).await?.is_empty())
    }

    /// The visible later versions of `node` (successors at any depth), or only
    /// the first one found with `first_only`. Like `mutation.allsuccessors`,
    /// this does not follow successors of public commits.
    async fn visible_newer_versions(&self, node: &HgId, first_only: bool) -> Result<Vec<HgId>> {
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        let mut level = vec![*node];
        let mut depth = 0;
        while !level.is_empty() {
            let mut next = Vec::new();
            for current in level {
                if !seen.insert(current) {
                    continue;
                }
                if depth > 0 && self.is_visible(&current).await? {
                    found.push(current);
                    if first_only {
                        return Ok(found);
                    }
                }
                if self.is_public(&current).await? {
                    continue;
                }
                for successors in self.mutation.get_successors_sets(current)? {
                    next.extend(successors);
                }
            }
            depth += 1;
            level = next;
        }
        Ok(found)
    }

    /// What the checkout with dot dir `dot_path` did with the public commit
    /// `node` it is on: [`Finished::Landed`] when `node` is the commit it last
    /// made with `sl commit` or `sl amend`, or a later version of that commit,
    /// [`Finished::LandedUnused`] when `sl worktree add` made it on `node`
    /// while `node` was a draft, else [`Finished::Idle`].
    ///
    /// Only the checkout's own records can tell: the repo-wide history does
    /// not say which checkout a draft belonged to, so a fresh checkout on a
    /// commit another checkout landed would look landed too. Those records are
    /// a linked git worktree's, in its dot dir `<admin dir>/sl`. Other
    /// checkouts are idle.
    async fn public_verdict(&self, dot_path: &Path, node: &HgId) -> Result<Finished> {
        let in_git_worktree = dot_path
            .parent()
            .is_some_and(|admin_dir| admin_dir.join("commondir").is_file());
        if !in_git_worktree {
            return Ok(Finished::Idle);
        }
        if self.committed_here(dot_path, node).await? {
            return Ok(Finished::Landed);
        }
        let base = fs::read_to_string(dot_path.join(DRAFT_BASE_FILE)).unwrap_or_default();
        if base.trim() == node.to_hex() {
            return Ok(Finished::LandedUnused);
        }
        Ok(Finished::Idle)
    }

    /// Whether `node` is the commit that `sl commit` or `sl amend` last made
    /// in the checkout with dot dir `dot_path`, which they record there
    /// (`worktreestale.recordcommit`), or a later version of it, e.g. the one
    /// that landed. A checkout that committed and then moved elsewhere, e.g.
    /// `sl goto origin/main` for its next task, is not on its own commit, even
    /// when the commit there has the same message.
    async fn committed_here(&self, dot_path: &Path, node: &HgId) -> Result<bool> {
        let recorded = fs::read_to_string(dot_path.join(LAST_COMMIT_FILE)).unwrap_or_default();
        let Ok(recorded) = HgId::from_hex(recorded.trim().as_bytes()) else {
            return Ok(false);
        };
        if recorded == *node {
            return Ok(true);
        }
        Ok(self
            .visible_newer_versions(&recorded, false)
            .await?
            .contains(node))
    }

    /// The number of draft (not public) commits that `node` is on, itself
    /// included.
    async fn draft_count(&self, node: &HgId) -> Result<u64> {
        if !self.has_node(node).await? {
            return Ok(0);
        }
        let stack = self
            .dag
            .ancestors(Set::from_static_names([vertex(node)]))
            .await?
            - self.public.clone();
        Ok(stack.count().await?)
    }

    async fn finished_state(&self, node: &HgId) -> Result<Option<Finished>> {
        if !self.has_node(node).await? {
            return Ok(None);
        }
        if self.is_public(node).await? {
            return Ok(Some(Finished::Landed));
        }
        if self.is_visible(node).await? {
            return Ok(None);
        }
        let newer = self.visible_newer_versions(node, false).await?;
        for version in &newer {
            if self.is_public(version).await? {
                return Ok(Some(Finished::Landed));
            }
        }
        Ok(newer.is_empty().then_some(Finished::Abandoned))
    }

    /// The commit graph is walked instead of asking for obsolete commits:
    /// another checkout's commits are hidden here once rewritten here, and
    /// obsolescence only covers visible commits.
    async fn stale_state(&self, node: &HgId) -> Result<Option<StaleState>> {
        if !self.has_node(node).await? {
            return Ok(None);
        }
        if self.has_newer_version(node).await? {
            return Ok(Some(StaleState {
                kind: StaleKind::Rewritten,
                commit: *node,
            }));
        }
        let mut seen = HashSet::from([*node]);
        let mut pending = self.parents(node).await?;
        while let Some(n) = pending.pop() {
            if n.is_null() || seen.contains(&n) || self.is_public(&n).await? {
                continue;
            }
            seen.insert(n);
            if self.has_newer_version(&n).await? {
                return Ok(Some(StaleState {
                    kind: StaleKind::Orphaned,
                    commit: n,
                }));
            }
            pending.extend(self.parents(&n).await?);
        }
        Ok(None)
    }
}

/// (public heads, draft heads) from remote bookmarks, as `_remotenodes` in
/// localrepo.py splits them.
fn remote_heads(repo: &Repo) -> Result<(Vec<HgId>, Vec<HgId>)> {
    let config = repo.config();
    let public_matcher = config.get_opt::<TreeMatcher>("remotenames", "publicheads")?;
    let draft_pattern = config
        .get_opt::<String>("infinitepush", "branchpattern")?
        .filter(|p| !p.is_empty())
        .map(|p| StringMatcher::new(&p))
        .transpose()?;

    let mut public = Vec::new();
    let mut draft = Vec::new();
    for (name, node) in repo.remote_bookmarks()? {
        let fullname = name.as_str();
        let is_public = match (&public_matcher, &draft_pattern) {
            (Some(matcher), _) => matcher.matches(fullname),
            (None, Some(pattern)) => {
                let short = fullname.split_once('/').map_or(fullname, |(_, rest)| rest);
                !pattern.matches(short)
            }
            (None, None) => true,
        };
        if is_public {
            public.push(node);
        } else {
            draft.push(node);
        }
    }
    Ok((public, draft))
}

/// `util.stringmatcher`: `re:` for a regex search, otherwise an exact name
/// (optionally prefixed with `literal:`).
enum StringMatcher {
    Regex(regex::Regex),
    Literal(String),
}

impl StringMatcher {
    fn new(pattern: &str) -> Result<Self> {
        Ok(match pattern.strip_prefix("re:") {
            Some(re) => StringMatcher::Regex(regex::Regex::new(re)?),
            None => StringMatcher::Literal(
                pattern
                    .strip_prefix("literal:")
                    .unwrap_or(pattern)
                    .to_string(),
            ),
        })
    }

    fn matches(&self, name: &str) -> bool {
        match self {
            StringMatcher::Regex(re) => re.is_match(name),
            StringMatcher::Literal(literal) => literal == name,
        }
    }
}

async fn local_set(dag: &(dyn DagCommits + Send), nodes: Vec<HgId>) -> Result<Set> {
    let vertexes: Vec<Vertex> = nodes.iter().filter(|n| !n.is_null()).map(vertex).collect();
    let present = dag.contains_vertex_name_locally(&vertexes).await?;
    Ok(Set::from_static_names(
        vertexes
            .into_iter()
            .zip(present)
            .filter_map(|(v, present)| present.then_some(v)),
    ))
}

fn vertex(node: &HgId) -> Vertex {
    Vertex::copy_from(node.as_ref())
}

/// `<short hash> "<title>"`, or the short hash alone when the commit is unknown.
fn describe(repo: &Repo, node: &HgId) -> String {
    let short = &node.to_hex()[..12];
    let title = repo.dag_commits().ok().and_then(|dag| {
        let fields = block_on(dag.read().get_commit_fields(&vertex(node))).ok()??;
        let description = fields.description().ok()?;
        Some(description.lines().next().unwrap_or("").to_string())
    });
    match title {
        Some(title) => format!("{short} \"{title}\""),
        None => short.to_string(),
    }
}
