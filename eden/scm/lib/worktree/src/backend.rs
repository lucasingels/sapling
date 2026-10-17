/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use configmodel::Config;
use configmodel::ConfigExt;
use fs_err as fs;
use gitcompat::GitCmd;
use gitcompat::RepoGit;
use repo_minimal_info::RepoMinimalInfo;

use crate::dissolve_group;
use crate::dissolve_group_if_empty;
use crate::load_registry;
use crate::with_registry_lock;

#[derive(Debug, Eq, PartialEq)]
/// A worktree presented through the backend-independent listing API.
pub struct ListedWorktree {
    /// Absolute path to the working tree.
    pub path: PathBuf,
    /// Whether this is the repository's main working tree.
    pub is_main: bool,
    /// Optional Sapling label associated with this working tree.
    pub label: Option<String>,
    /// Whether this is the working tree from which the command was run.
    pub current: bool,
}

/// What a repository's linked worktrees are.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeKind {
    /// EdenFS checkouts of a shared backing repo, tracked in the Sapling registry.
    Eden,
    /// Linked git worktrees of a dotgit repo. Git tracks which exist; the
    /// registry only keeps their labels.
    Git,
}

impl WorktreeKind {
    /// The command a user would run by hand to remove a checkout of this kind.
    pub fn remove_command(self) -> &'static str {
        match self {
            WorktreeKind::Eden => "eden rm",
            WorktreeKind::Git => "git worktree remove",
        }
    }
}

trait WorktreeBackend {
    fn kind(&self) -> WorktreeKind;

    fn list(&self) -> Result<Vec<ListedWorktree>>;

    /// Create a linked checkout at `dest` of commit `target` (hex), or of the
    /// current commit. EdenFS clones need edenfs-client, which this crate cannot
    /// depend on, so the worktree command makes those itself.
    fn add(&self, _dest: &Path, _target: Option<&str>) -> Result<()> {
        anyhow::bail!("{:?} worktrees cannot be added by this backend", self.kind())
    }

    /// Tear down the linked checkout at `path`. See `add` for EdenFS.
    fn remove(&self, _path: &Path) -> Result<()> {
        anyhow::bail!("{:?} worktrees cannot be removed by this backend", self.kind())
    }
}

struct SaplingBackend {
    repo_path: PathBuf,
    shared_store_path: PathBuf,
}

struct GitBackend {
    repo_path: PathBuf,
    ident: identity::Identity,
    git: RepoGit,
}

impl WorktreeBackend for SaplingBackend {
    fn kind(&self) -> WorktreeKind {
        WorktreeKind::Eden
    }

    fn list(&self) -> Result<Vec<ListedWorktree>> {
        let current = util::path::strip_unc_prefix(
            util::path::canonicalize_best_effort(&self.repo_path)
                .with_context(|| format!("failed to canonicalize {}", self.repo_path.display()))?,
        );

        with_registry_lock(&self.shared_store_path, |registry| {
            let Some(group_id) = registry.find_group_for_path(&current) else {
                return Ok(Vec::new());
            };

            let Some(group) = registry.groups.get(&group_id) else {
                anyhow::bail!("worktree group '{group_id}' disappeared from the registry");
            };

            if !group.main.exists() {
                dissolve_group(registry, &group_id);
                return Ok(Vec::new());
            }

            if group.worktrees.keys().any(|path| !path.exists()) {
                let Some(group) = registry.groups.get_mut(&group_id) else {
                    anyhow::bail!("worktree group '{group_id}' disappeared from the registry");
                };
                group.worktrees.retain(|path, _| path.exists());
                dissolve_group_if_empty(registry, &group_id);
            }

            Ok(registry
                .groups
                .get(&group_id)
                .map(|group| {
                    group
                        .worktrees
                        .iter()
                        .map(|(path, entry)| ListedWorktree {
                            path: path.clone(),
                            is_main: *path == group.main,
                            label: entry.label.clone(),
                            current: *path == current,
                        })
                        .collect()
                })
                .unwrap_or_default())
        })
        .context("failed to list Sapling worktrees")
    }
}

impl WorktreeBackend for GitBackend {
    fn kind(&self) -> WorktreeKind {
        WorktreeKind::Git
    }

    fn list(&self) -> Result<Vec<ListedWorktree>> {
        let shared_store_path = self.git.common_dir().join("sl").join("store");
        let labels = load_labels(&shared_store_path)?;
        let current = canonicalize_or_original(&self.repo_path);

        Ok(self
            .git
            .list_worktrees()
            .context("failed to list Git worktrees")?
            .into_iter()
            // A linked worktree deleted behind git's back stays listed (as prunable) until
            // `git worktree prune`; it is not a usable checkout, so leave it out.
            .filter(|worktree| worktree.is_main || worktree.path.exists())
            .map(|worktree| {
                let canonical_path = canonicalize_or_original(&worktree.path);
                ListedWorktree {
                    path: worktree.path,
                    is_main: worktree.is_main,
                    label: labels.get(&canonical_path).cloned(),
                    current: canonical_path == current,
                }
            })
            .collect())
    }

    /// `git worktree add --detach`, then initialise sl's per-worktree dot dir so
    /// the label marker and ISL have something to read before the first `sl`
    /// command runs there.
    fn add(&self, dest: &Path, target: Option<&str>) -> Result<()> {
        let dest_arg = dest.display().to_string();
        let mut args = vec!["add", "--detach", dest_arg.as_str()];
        args.extend(target);
        self.git
            .call("worktree", &args)
            .with_context(|| format!("git worktree add {}", dest.display()))?;
        gitcompat::init::maybe_init_inside_dotgit(dest, self.ident)
            .with_context(|| format!("initializing sl state for {}", dest.display()))?;
        let main = self.git.list_worktrees()?.into_iter().find(|wt| wt.is_main);
        match main {
            Some(main) => exclude_nested_worktree(self.git.common_dir(), &main.path, dest),
            None => Ok(()),
        }
    }

    /// `--force` because the point of `sl worktree remove` is to discard the
    /// checkout; the caller has already confirmed with the user. The prune also
    /// drops the admin dirs of worktrees deleted behind git's back, `path`
    /// included when it is already gone; without `--expire now` git keeps them
    /// for `gc.worktreePruneExpire` (three months by default).
    fn remove(&self, path: &Path) -> Result<()> {
        if path.exists() {
            self.git
                .call("worktree", &["remove", "--force", &path.display().to_string()])
                .with_context(|| format!("git worktree remove {}", path.display()))?;
        }
        self.git
            .call("worktree", &["prune", "--expire", "now"])
            .context("git worktree prune")?;
        Ok(())
    }
}

/// A worktree created inside the main checkout (e.g. `<root>/.worktrees/<name>`)
/// would otherwise show up as an untracked directory in the main checkout's
/// status. Add its parent directory (or the worktree itself when created directly
/// under the root) to the common git dir's `info/exclude`, which every worktree of
/// the repo reads and which is not a tracked file.
fn exclude_nested_worktree(common_git_dir: &Path, main_root: &Path, dest: &Path) -> Result<()> {
    let main_root = canonicalize_or_original(main_root);
    let dest = canonicalize_or_original(dest);
    let Ok(rel) = dest.strip_prefix(&main_root) else {
        return Ok(());
    };
    // Exclude the containing directory when the worktree is one level down (the
    // usual `.worktrees/<name>` layout), so later siblings are covered too.
    let excluded: &Path = match rel.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => rel,
    };
    let mut pattern = String::from("/");
    for component in excluded.components() {
        pattern.push_str(&component.as_os_str().to_string_lossy());
        pattern.push('/');
    }

    let info_dir = common_git_dir.join("info");
    let exclude_path = info_dir.join("exclude");
    let existing = match fs::read_to_string(&exclude_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    if existing.lines().any(|line| line.trim() == pattern) {
        return Ok(());
    }
    fs::create_dir_all(&info_dir)?;
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("# sl worktree: linked worktrees created inside this checkout\n");
    content.push_str(&pattern);
    content.push('\n');
    fs::write(&exclude_path, content)
        .with_context(|| format!("updating {}", exclude_path.display()))?;
    Ok(())
}

/// Access to the worktrees associated with one repository.
pub struct Worktrees {
    backend: Box<dyn WorktreeBackend>,
}

impl Worktrees {
    /// Open the worktree implementation appropriate for `repo`.
    pub fn open(repo: &RepoMinimalInfo, config: &dyn Config) -> Result<Self> {
        let is_git =
            repo.requirements.contains("dotgit") && repo.store_requirements.contains("git-store");
        let backend: Box<dyn WorktreeBackend> = if is_git {
            if !config
                .get_or("worktree", "git-enabled", || true)
                .context("invalid worktree.git-enabled configuration")?
            {
                anyhow::bail!("worktree commands for git are disabled by worktree.git-enabled");
            }
            Box::new(GitBackend {
                repo_path: repo.path.clone(),
                ident: repo.ident,
                git: RepoGit::from_root_and_config(repo.path.clone(), config),
            })
        } else if repo.requirements.contains("eden") {
            Box::new(SaplingBackend {
                repo_path: repo.path.clone(),
                shared_store_path: repo.store_path.clone(),
            })
        } else {
            anyhow::bail!("worktree commands require an EdenFS-backed or git-backed (.git) repository");
        };

        Ok(Self { backend })
    }

    pub fn kind(&self) -> WorktreeKind {
        self.backend.kind()
    }

    /// List the repository's worktrees using the backend's source of truth.
    pub fn list(&self) -> Result<Vec<ListedWorktree>> {
        self.backend.list()
    }

    /// Create a linked checkout at `dest` of commit `target` (hex), or of the
    /// current commit. Git worktrees only; see `WorktreeBackend::add`.
    pub fn add(&self, dest: &Path, target: Option<&str>) -> Result<()> {
        self.backend.add(dest, target)
    }

    /// Tear down the linked checkout at `path`. Git worktrees only.
    pub fn remove(&self, path: &Path) -> Result<()> {
        self.backend.remove(path)
    }
}

fn load_labels(shared_store_path: &Path) -> Result<BTreeMap<PathBuf, String>> {
    Ok(load_registry(shared_store_path)
        .with_context(|| {
            format!(
                "failed to load worktree labels from {}",
                shared_store_path.display()
            )
        })?
        .groups
        .into_values()
        .flat_map(|group| group.worktrees)
        .filter_map(|(path, entry)| {
            entry
                .label
                .map(|label| (canonicalize_or_original(&path), label))
        })
        .collect())
}

fn canonicalize_or_original(path: &Path) -> PathBuf {
    util::path::canonicalize_best_effort(path)
        .map(util::path::strip_unc_prefix)
        .unwrap_or_else(|_| path.to_owned())
}
