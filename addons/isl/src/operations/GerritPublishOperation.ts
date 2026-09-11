/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommandArg, ExactRevset, SucceedableRevset} from '../types';

import {Operation} from './Operation';

/**
 * Push a stack to Gerrit for review via `sl gerrit publish`.
 *
 * `rev` is the top of the stack to publish; `sl push` sends it and every
 * unpublished commit below it. Passing it is what lets a stack you are not
 * checked out on be published -- without it `sl push` starts from `.`, which
 * would quietly publish the wrong stack.
 *
 * Passing `draft: true` pushes changes as WIP (work-in-progress) by appending %wip.
 */
export class GerritPublishOperation extends Operation {
  static opName = 'gerrit publish';

  constructor(private options?: {draft?: boolean; rev?: SucceedableRevset | ExactRevset}) {
    super('GerritPublishOperation');
  }

  getArgs() {
    const args: Array<CommandArg> = ['gerrit', 'publish'];
    if (this.options?.draft) {
      args.push('--wip');
    }
    if (this.options?.rev != null) {
      args.push(this.options.rev);
    }
    return args;
  }
}
