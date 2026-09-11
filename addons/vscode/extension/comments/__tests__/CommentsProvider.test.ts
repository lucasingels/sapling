/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {DiffComment} from 'isl/src/types';
import type {VSCodeRepo, VSCodeReposList} from '../../VSCodeRepo';

import {mockLogger, nextTick} from 'shared/testUtils';
import * as vscode from 'vscode';
import {
  CommentsProvider,
  groupCommentsByLocation,
  threadState,
  toVSCodeComment,
} from '../CommentsProvider';

jest.mock('vscode', () => jest.requireActual('../../../__mocks__/vscode'));

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    author: 'alice',
    html: '<p>hello</p>',
    created: new Date('2024-01-01T00:00:00Z'),
    reactions: [],
    replies: [],
    ...overrides,
  };
}

describe('groupCommentsByLocation', () => {
  it('skips diff-level comments with no filename/line', () => {
    const comments = [makeComment({filename: undefined, line: undefined})];
    expect(groupCommentsByLocation(comments)).toEqual([]);
  });

  it('groups separate top-level comments at the same location into one thread', () => {
    const first = makeComment({id: '1', filename: 'foo.ts', line: 10, content: 'first'});
    const second = makeComment({id: '2', filename: 'foo.ts', line: 10, content: 'second'});
    const other = makeComment({id: '3', filename: 'bar.ts', line: 5, content: 'other file'});

    const groups = groupCommentsByLocation([first, second, other]);

    expect(groups).toHaveLength(2);
    const fooGroup = groups.find(g => g.filename === 'foo.ts');
    expect(fooGroup?.line).toBe(10);
    expect(fooGroup?.comments.map(c => c.id)).toEqual(['1', '2']);
  });

  it('flattens replies into the same thread instead of creating a thread per reply', () => {
    const reply = makeComment({id: 'reply', content: 'a reply'});
    const parent = makeComment({
      id: 'parent',
      filename: 'foo.ts',
      line: 3,
      content: 'top comment',
      replies: [reply],
    });

    const groups = groupCommentsByLocation([parent]);

    expect(groups).toHaveLength(1);
    expect(groups[0].comments.map(c => c.id)).toEqual(['parent', 'reply']);
  });
});

describe('threadState', () => {
  it('is undefined (no resolution UI) when isResolved is not resolvable', () => {
    const comments = [makeComment({isResolved: undefined})];
    expect(threadState(comments)).toBeUndefined();
  });

  it('is Resolved when marked resolved', () => {
    const comments = [makeComment({isResolved: true})];
    expect(threadState(comments)).toBe(vscode.CommentThreadState.Resolved);
  });

  it('is Unresolved when marked unresolved', () => {
    const comments = [makeComment({isResolved: false})];
    expect(threadState(comments)).toBe(vscode.CommentThreadState.Unresolved);
  });

  it('prefers Unresolved when comments in the thread disagree', () => {
    const comments = [makeComment({isResolved: true}), makeComment({isResolved: false})];
    expect(threadState(comments)).toBe(vscode.CommentThreadState.Unresolved);
  });
});

describe('toVSCodeComment', () => {
  it('prefers content over html for the body', () => {
    const comment = makeComment({content: 'plain text', html: '<b>bold</b>'});
    expect(toVSCodeComment(comment).body).toBe('plain text');
  });

  it('falls back to a tag-stripped version of html when content is missing', () => {
    const comment = makeComment({content: undefined, html: '<p>hello <b>world</b></p>'});
    expect(toVSCodeComment(comment).body).toBe('hello world');
  });

  it('is always read-only preview mode', () => {
    expect(toVSCodeComment(makeComment()).mode).toBe(vscode.CommentMode.Preview);
  });

  it('uses authorName over author when present', () => {
    const comment = makeComment({author: 'alice123', authorName: 'Alice'});
    expect(toVSCodeComment(comment).author.name).toBe('Alice');
  });
});

function makeFakeRepo(options: {
  diffId?: string;
  fetchComments?: jest.Mock<Promise<Array<DiffComment>>, [string]>;
}): {
  vscodeRepo: VSCodeRepo;
  fireHeadChange: (diffId: string | undefined) => void;
} {
  let headCallback: ((head: {diffId?: string} | undefined) => void) | undefined;
  let dotCommitDiffId = options.diffId;
  const vscodeRepo = {
    rootUri: vscode.Uri.file('/repo'),
    repo: {
      codeReviewProvider:
        options.fetchComments == null ? undefined : {fetchComments: options.fetchComments},
    },
    getDotCommit: jest.fn(() => (dotCommitDiffId == null ? undefined : {diffId: dotCommitDiffId})),
    onChangeDotCommit: jest.fn((cb: (head: {diffId?: string} | undefined) => void) => {
      headCallback = cb;
      return new vscode.Disposable(() => {});
    }),
  } as unknown as VSCodeRepo;

  return {
    vscodeRepo,
    fireHeadChange: (diffId: string | undefined) => {
      dotCommitDiffId = diffId;
      headCallback?.(diffId == null ? undefined : {diffId});
    },
  };
}

function makeFakeReposList(repos: Array<VSCodeRepo>): VSCodeReposList {
  const perRepoDisposables: Array<vscode.Disposable> = [];
  return {
    subscribeWithinAllRepos: jest.fn((cb: (repo: VSCodeRepo) => vscode.Disposable) => {
      for (const repo of repos) {
        perRepoDisposables.push(cb(repo));
      }
      return new vscode.Disposable(() => {
        for (const disposable of perRepoDisposables) {
          disposable.dispose();
        }
      });
    }),
    getCurrentActiveRepos: jest.fn(() => repos),
  } as unknown as VSCodeReposList;
}

function getCreatedController() {
  const createCommentController = vscode.comments.createCommentController as jest.Mock;
  return createCommentController.mock.results[createCommentController.mock.results.length - 1]
    .value as vscode.CommentController;
}

describe('CommentsProvider', () => {
  beforeEach(() => {
    (vscode.workspace.getConfiguration as jest.Mock) = jest.fn(() => ({
      get: jest.fn(() => true),
    }));
  });

  it('creates one thread per inline comment location on construction', async () => {
    const fetchComments = jest
      .fn()
      .mockResolvedValue([
        makeComment({id: '1', filename: 'foo.ts', line: 5, content: 'hi'}),
        makeComment({id: '2', filename: 'foo.ts', line: 9, content: 'there'}),
      ]);
    const {vscodeRepo} = makeFakeRepo({diffId: 'D1', fetchComments});
    const reposList = makeFakeReposList([vscodeRepo]);

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    const controller = getCreatedController();
    expect(fetchComments).toHaveBeenCalledWith('D1');
    expect((controller.createCommentThread as jest.Mock).mock.calls).toHaveLength(2);

    provider.dispose();
  });

  it('converts the 1-based DiffComment.line to a 0-based Range', async () => {
    const fetchComments = jest
      .fn()
      .mockResolvedValue([makeComment({filename: 'foo.ts', line: 5, content: 'hi'})]);
    const {vscodeRepo} = makeFakeRepo({diffId: 'D1', fetchComments});
    const reposList = makeFakeReposList([vscodeRepo]);

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    const controller = getCreatedController();
    const [, range] = (controller.createCommentThread as jest.Mock).mock.calls[0];
    expect(range.start.line).toBe(4);
    expect(range.end.line).toBe(4);

    provider.dispose();
  });

  it('sets canReply to false since there is no write API', async () => {
    const fetchComments = jest
      .fn()
      .mockResolvedValue([makeComment({filename: 'foo.ts', line: 1, content: 'hi'})]);
    const {vscodeRepo} = makeFakeRepo({diffId: 'D1', fetchComments});
    const reposList = makeFakeReposList([vscodeRepo]);

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    const controller = getCreatedController();
    const thread = (controller.createCommentThread as jest.Mock).mock.results[0]
      .value as vscode.CommentThread;
    expect(thread.canReply).toBe(false);

    provider.dispose();
  });

  it('disposes old threads and creates new ones when the head commit changes', async () => {
    const fetchComments = jest
      .fn()
      .mockResolvedValueOnce([makeComment({filename: 'foo.ts', line: 1, content: 'old'})])
      .mockResolvedValueOnce([makeComment({filename: 'bar.ts', line: 2, content: 'new'})]);
    const {vscodeRepo, fireHeadChange} = makeFakeRepo({diffId: 'D1', fetchComments});
    const reposList = makeFakeReposList([vscodeRepo]);

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    const controller = getCreatedController();
    const firstThread = (controller.createCommentThread as jest.Mock).mock.results[0]
      .value as vscode.CommentThread;

    fireHeadChange('D2');
    await nextTick();

    expect(firstThread.dispose).toHaveBeenCalled();
    expect(fetchComments).toHaveBeenCalledWith('D2');
    expect((controller.createCommentThread as jest.Mock).mock.calls).toHaveLength(2);

    provider.dispose();
  });

  it('skips fetching and clears threads when disabled via config', async () => {
    const fetchComments = jest
      .fn()
      .mockResolvedValue([makeComment({filename: 'foo.ts', line: 1, content: 'hi'})]);
    const {vscodeRepo} = makeFakeRepo({diffId: 'D1', fetchComments});
    const reposList = makeFakeReposList([vscodeRepo]);

    (vscode.workspace.getConfiguration as jest.Mock) = jest.fn(() => ({get: jest.fn(() => false)}));

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    expect(fetchComments).not.toHaveBeenCalled();

    provider.dispose();
  });

  it('does nothing for a repo with no comment provider', async () => {
    const {vscodeRepo} = makeFakeRepo({diffId: 'D1'});
    const reposList = makeFakeReposList([vscodeRepo]);

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    const controller = getCreatedController();
    expect((controller.createCommentThread as jest.Mock).mock.calls).toHaveLength(0);

    provider.dispose();
  });

  it('disposes all repo threads on provider dispose', async () => {
    const fetchComments = jest
      .fn()
      .mockResolvedValue([makeComment({filename: 'foo.ts', line: 1, content: 'hi'})]);
    const {vscodeRepo} = makeFakeRepo({diffId: 'D1', fetchComments});
    const reposList = makeFakeReposList([vscodeRepo]);

    const provider = new CommentsProvider(reposList, mockLogger);
    await nextTick();

    const controller = getCreatedController();
    const thread = (controller.createCommentThread as jest.Mock).mock.results[0]
      .value as vscode.CommentThread;

    provider.dispose();

    expect(thread.dispose).toHaveBeenCalled();
    expect(controller.dispose).toHaveBeenCalled();
  });
});
