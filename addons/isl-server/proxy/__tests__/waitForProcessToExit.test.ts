/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawn} from 'node:child_process';
import {waitForProcessToExit} from '../serverLifecycle';

describe('waitForProcessToExit', () => {
  it('resolves true once the process has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    const pid = child.pid;
    expect(pid).toBeDefined();
    await expect(waitForProcessToExit(pid as number, 5000, 20)).resolves.toBe(true);
  });

  it('resolves false if the process is still alive after the timeout', async () => {
    // our own process is certainly still running
    await expect(waitForProcessToExit(process.pid, 100, 20)).resolves.toBe(false);
  });
});
