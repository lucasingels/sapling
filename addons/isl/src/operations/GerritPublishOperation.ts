/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Operation} from './Operation';

/**
 * Push the current stack to Gerrit for review via `sl gerrit publish`.
 * Passing `draft: true` pushes changes as WIP (work-in-progress) by appending %wip.
 */
export class GerritPublishOperation extends Operation {
  static opName = 'gerrit publish';

  constructor(private options?: {draft?: boolean}) {
    super('GerritPublishOperation');
  }

  getArgs() {
    const args = ['gerrit', 'publish'];
    if (this.options?.draft) {
      args.push('--wip');
    }
    return args;
  }
}
