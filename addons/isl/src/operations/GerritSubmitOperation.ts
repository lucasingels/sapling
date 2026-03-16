/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Operation} from './Operation';

/**
 * Push the current stack to Gerrit for review via `sl push`.
 * Passing `draft: true` pushes changes as WIP (work-in-progress) by adding --draft.
 */
export class GerritSubmitOperation extends Operation {
  static opName = 'push';

  constructor(private options?: {draft?: boolean}) {
    super('GerritSubmitOperation');
  }

  getArgs() {
    const args = ['push'];
    if (this.options?.draft) {
      args.push('--draft');
    }
    return args;
  }
}
