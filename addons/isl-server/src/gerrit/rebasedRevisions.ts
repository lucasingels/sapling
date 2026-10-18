/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {DiffId, Hash} from 'isl/src/types';

export type RunSl = (args: Array<string>) => Promise<string>;

type LogEntry = {node: Hash; desc: string; phase: string; parents: Array<Hash>};

const CHANGE_ID_RE = /^Change-Id: (I[0-9a-f]{40})\s*$/m;

/**
 * Finds the local commits that are an uploaded patchset moved onto a new base and nothing
 * else, which is what Gerrit itself calls a trivial rebase: the same commit message and the
 * same changed lines. Republishing one would only add a patchset nobody needs to look at.
 *
 * Context lines are ignored, so a commit whose surroundings changed upstream still counts.
 * The parent must also be equivalent, or reordering a stack would slip through: either both
 * parents are public (the stack moved to a newer trunk), or the local parent is itself the
 * uploaded patchset of its change or a trivial rebase of it.
 *
 * Needs the uploaded commit locally, which it is when it was published from this checkout
 * (it is the rebased commit's predecessor). When it is not, the commit is left out and
 * still shows as changed.
 */
export class RebasedRevisionFinder {
  /** Keyed by commit hash, which fixes the content, so entries never go stale. */
  private patchCache = new Map<Hash, Promise<string>>();

  constructor(private runSl: RunSl) {}

  /** Maps each change to its local commits that are a trivial rebase of `uploaded`. */
  async find(uploaded: ReadonlyMap<DiffId, Hash>): Promise<Map<DiffId, Array<Hash>>> {
    const candidates = (await this.log('draft() - obsolete()')).flatMap(commit => {
      const changeId = CHANGE_ID_RE.exec(commit.desc)?.[1];
      if (changeId == null) {
        return [];
      }
      const revision = uploaded.get(changeId);
      return revision == null || revision === commit.node ? [] : [{commit, changeId, revision}];
    });
    if (candidates.length === 0) {
      return new Map();
    }

    const revisions = [...new Set(candidates.map(c => c.revision))];
    // One lookup each: a hash can be known to the graph with its content missing, and that
    // aborts the whole `sl log`.
    const uploadedCommits = new Map(
      (await Promise.all(revisions.map(r => this.logOne(r)))).flatMap(c =>
        c == null ? [] : [[c.node, c]],
      ),
    );
    const sameMessage = candidates.flatMap(c => {
      const up = uploadedCommits.get(c.revision);
      return up != null && up.desc === c.commit.desc ? [{...c, uploaded: up}] : [];
    });

    const samePatch = await Promise.all(
      sameMessage.map(async c => {
        const [a, b] = await Promise.all([this.patch(c.commit.node), this.patch(c.revision)]);
        return a != null && a === b;
      }),
    );
    const matches = sameMessage.filter((_, i) => samePatch[i]);

    const parentPhases = await this.phases(
      matches.flatMap(m => [...m.commit.parents.slice(0, 1), ...m.uploaded.parents.slice(0, 1)]),
    );

    // Maps a commit to the uploaded revision it is, or is a trivial rebase of.
    const equivalentTo = new Map<Hash, Hash>(revisions.map(r => [r, r]));
    // Repeat until settled: whether a commit passes depends on whether its parent did.
    let changed = true;
    while (changed) {
      changed = false;
      for (const {commit, uploaded: up} of matches) {
        if (equivalentTo.has(commit.node)) {
          continue;
        }
        // Root commits have no parent; '' makes two roots compare equal.
        const p = commit.parents[0] ?? '';
        const q = up.parents[0] ?? '';
        if (
          p === q ||
          (parentPhases.get(p) === 'public' && parentPhases.get(q) === 'public') ||
          equivalentTo.get(p) === q
        ) {
          equivalentTo.set(commit.node, up.node);
          changed = true;
        }
      }
    }

    const result = new Map<DiffId, Array<Hash>>();
    for (const {commit, changeId, revision} of matches) {
      if (equivalentTo.get(commit.node) === revision) {
        result.set(changeId, [...(result.get(changeId) ?? []), commit.node]);
      }
    }
    return result;
  }

  private async log(revset: string): Promise<Array<LogEntry>> {
    return JSON.parse(await this.runSl(['log', '-r', revset, '-Tjson'])) as Array<LogEntry>;
  }

  private async logOne(hash: Hash): Promise<LogEntry | undefined> {
    try {
      return (await this.log(`present(${hash})`))[0];
    } catch {
      return undefined;
    }
  }

  /** Phases come from the graph alone, so unlike `log` this works for commits missing content. */
  private async phases(hashes: Array<Hash>): Promise<Map<Hash, string>> {
    const unique = [...new Set(hashes)];
    if (unique.length === 0) {
      return new Map();
    }
    const revset = unique.map(h => `present(${h})`).join(' + ');
    const out = await this.runSl(['log', '-r', revset, '-T', '{node} {phase}\\n']);
    return new Map(
      out
        .split('\n')
        .filter(line => line !== '')
        .map(line => line.split(' ') as [Hash, string]),
    );
  }

  private async patch(hash: Hash): Promise<string | undefined> {
    let cached = this.patchCache.get(hash);
    if (cached == null) {
      cached = this.runSl(['diff', '-c', hash]).then(changedLines);
      this.patchCache.set(hash, cached);
    }
    try {
      return await cached;
    } catch {
      this.patchCache.delete(hash);
      return undefined;
    }
  }
}

/**
 * Keeps what a diff changes and drops where: context lines and hunk headers. Hunk headers
 * go entirely because new upstream lines can split or merge hunks without changing the patch.
 */
export function changedLines(diff: string): string {
  return diff
    .split('\n')
    .filter(line => line !== '' && !line.startsWith(' ') && !line.startsWith('@@'))
    .join('\n');
}
