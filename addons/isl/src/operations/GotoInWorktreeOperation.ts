/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommandArg, Hash} from '../types';

import {Operation} from './Operation';

/** Checks out a commit in another worktree, keeping its uncommitted changes unless they conflict. */
export class GotoInWorktreeOperation extends Operation {
  static opName = 'GotoInWorktree';

  constructor(
    private worktreePath: string,
    private destination: Hash,
  ) {
    super('GotoInWorktreeOperation');
  }

  getArgs(): Array<CommandArg> {
    return [{type: 'worktree-cwd', path: this.worktreePath}, 'goto', '--check', this.destination];
  }
}
