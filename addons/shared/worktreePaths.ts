/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Helpers to derive the default location of a new worktree from its label.
 * Kept free of node imports so both the ISL webview and the VS Code extension can use them.
 */

/** Name of the hidden directory inside the main worktree that holds nested worktrees. */
export const WORKTREES_DIR_NAME = '.worktrees';

/** Prefix used when a label is missing or contains nothing usable as a directory name. */
const FALLBACK_DIR_NAME = 'wt';

/** Characters kept verbatim in a worktree directory name. */
const UNSAFE_CHARS = /[^A-Za-z0-9._-]+/g;

/** Leading/trailing characters that make for an awkward directory name. */
const EDGE_CHARS = /^[-.]+|[-.]+$/g;

/**
 * Derive a directory name from a user-provided worktree label, preserving case.
 * Every run of characters outside `[A-Za-z0-9._-]` becomes a single `-`, and leading
 * or trailing `-`/`.` are dropped. Returns undefined if nothing usable is left.
 *
 * ```
 * worktreeDirNameFromLabel('My Feature') -> 'My-Feature'
 * worktreeDirNameFromLabel('  ') -> undefined
 * ```
 */
export function worktreeDirNameFromLabel(label: string): string | undefined {
  const name = label.trim().replace(UNSAFE_CHARS, '-').replace(EDGE_CHARS, '');
  return name === '' ? undefined : name;
}

/**
 * Pick a directory name for a new worktree with the given label, avoiding names
 * `isTaken` reports as unavailable by appending `_2`, `_3`, ... A label that yields
 * no usable name falls back to `wt_2`, `wt_3`, ...
 *
 * With `maxSuffix` given, only suffixes up to and including it are tried, and
 * undefined is returned if every candidate is taken.
 */
export function pickWorktreeDirName(label: string, isTaken: (name: string) => boolean): string;
export function pickWorktreeDirName(
  label: string,
  isTaken: (name: string) => boolean,
  maxSuffix: number,
): string | undefined;
export function pickWorktreeDirName(
  label: string,
  isTaken: (name: string) => boolean,
  maxSuffix?: number,
): string | undefined {
  const limit = maxSuffix ?? Number.MAX_SAFE_INTEGER;
  const fromLabel = worktreeDirNameFromLabel(label);
  if (fromLabel != null && !isTaken(fromLabel)) {
    return fromLabel;
  }
  const base = fromLabel ?? FALLBACK_DIR_NAME;
  for (let suffix = 2; suffix <= limit; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Directory holding worktrees for the checkout rooted at `mainRoot`. */
export function defaultWorktreesDir(mainRoot: string, sep: string): string {
  return `${mainRoot}${sep}${WORKTREES_DIR_NAME}`;
}
