/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CodeReviewSystem} from 'isl/src/types';
import {mockLogger} from 'shared/testUtils';
import {GerritCodeReviewProvider} from '../gerritCodeReviewProvider';

// Mock node:https so we don't make real network requests
jest.mock('node:https', () => ({
  get: jest.fn(),
}));
jest.mock('node:http', () => ({
  get: jest.fn(),
}));
jest.mock('node:child_process', () => ({
  execFile: jest.fn((_cmd, _args, cb) => {
    // Default: no credentials stored
    cb(new Error('no credentials'), '', '');
    return {stdin: {end: jest.fn()}};
  }),
}));

import {execFile} from 'node:child_process';
import https from 'node:https';

const GERRIT_SYSTEM: CodeReviewSystem & {type: 'gerrit'} = {
  type: 'gerrit',
  remoteUrl: 'https://code.example.com/my-repo',
};

/** Make https.get resolve with the given body string. */
function mockHttpsResponse(body: string, statusCode = 200) {
  const mockRes = {
    statusCode,
    setEncoding: jest.fn(),
    on: jest.fn((event: string, handler: (arg?: string) => void) => {
      if (event === 'data') {
        handler(body);
      }
      if (event === 'end') {
        handler();
      }
    }),
  };
  const mockReq = {
    on: jest.fn(),
    setTimeout: jest.fn(),
    destroy: jest.fn(),
  };
  (https.get as jest.Mock).mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
    cb(mockRes);
    return mockReq;
  });
}

/** Standard Gerrit REST API response for one change. */
const GERRIT_CHANGE_RESPONSE = (changeId: string, number: number) =>
  `)]}'\n` +
  JSON.stringify([
    {
      change_id: changeId,
      _number: number,
      subject: 'My feature',
      status: 'NEW',
      submittable: true,
      labels: {
        'Code-Review': {all: [{value: 2}, {value: 1}]},
        Verified: {all: [{value: 1}]},
      },
    },
  ]);

describe('GerritCodeReviewProvider', () => {
  let provider: GerritCodeReviewProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new GerritCodeReviewProvider(GERRIT_SYSTEM, mockLogger, '/repo');
  });

  afterEach(() => {
    provider.dispose();
  });

  it('emits an empty map when no diffs are provided', async () => {
    const results: Array<Map<string, unknown>> = [];
    provider.onChangeDiffSummaries(r => {
      if (r.value) {
        results.push(r.value);
      }
    });

    await (provider.triggerDiffSummariesFetch as unknown as {flush: () => Promise<void>}).flush?.();
    provider.triggerDiffSummariesFetch([]);

    // Wait for async debounce
    await new Promise(r => setTimeout(r, 0));
    expect(results[0]).toEqual(new Map());
    expect(https.get).not.toHaveBeenCalled();
  });

  it('fetches from REST API and emits summaries keyed by Change-Id', async () => {
    const changeId = 'Iabc1234567890abcdef1234567890abcdef12345';
    mockHttpsResponse(GERRIT_CHANGE_RESPONSE(changeId, 142));

    const results: Array<Map<string, unknown>> = [];
    provider.onChangeDiffSummaries(r => {
      if (r.value) {
        results.push(r.value);
      }
    });

    provider.triggerDiffSummariesFetch([changeId]);
    await new Promise(r => setTimeout(r, 50));

    expect(https.get).toHaveBeenCalledTimes(1);
    const [[url]] = (https.get as jest.Mock).mock.calls;
    expect(url).toMatchObject({
      hostname: 'code.example.com',
      path: expect.stringContaining(changeId),
    });

    expect(results).toHaveLength(1);
    const summary = results[0].get(changeId);
    expect(summary).toEqual({
      type: 'gerrit',
      title: 'My feature',
      commitMessage: '',
      state: 'NEW',
      number: '142',
      url: 'https://code.example.com/c/my-repo/+/142',
      branchName: undefined,
      codeReview: 2,
      verified: 1,
      signalSummary: 'pass',
      commentCount: 0,
      anyUnresolvedComments: false,
      submittable: true,
    });
  });

  it('attaches Basic auth when git credential fill returns credentials', async () => {
    const changeId = 'Iabc1234567890abcdef1234567890abcdef12345';
    mockHttpsResponse(GERRIT_CHANGE_RESPONSE(changeId, 142));

    jest.mocked(execFile).mockImplementation((_cmd, _args, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        'protocol=https\nhost=code.example.com\nusername=alice\npassword=secret\n',
        '',
      );
      return {stdin: {end: jest.fn()}} as unknown as ReturnType<typeof execFile>;
    });

    provider.triggerDiffSummariesFetch([changeId]);
    await new Promise(r => setTimeout(r, 50));

    const [[options]] = (https.get as jest.Mock).mock.calls;
    expect(options).toMatchObject({
      headers: {Authorization: expect.stringMatching(/^Basic /)},
    });
    const decoded = Buffer.from(
      (options.headers.Authorization as string).replace('Basic ', ''),
      'base64',
    ).toString();
    expect(decoded).toBe('alice:secret');
  });

  it('emits an error when the REST API returns unparseable JSON', async () => {
    mockHttpsResponse('not json at all');

    const errors: Error[] = [];
    provider.onChangeDiffSummaries(r => {
      if (r.error) {
        errors.push(r.error as Error);
      }
    });

    provider.triggerDiffSummariesFetch(['Iabc123']);
    await new Promise(r => setTimeout(r, 50));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/failed to parse REST API response/);
  });

  describe('fetchComments', () => {
    const changeId = 'Iabc1234567890abcdef1234567890abcdef12345';

    /** Gerrit REST /comments response */
    const COMMENTS_RESPONSE = `)]}'\n` +
      JSON.stringify({
        'src/foo.ts': [
          {
            id: 'c1',
            author: {name: 'Alice', email: 'alice@example.com'},
            message: 'This needs fixing',
            line: 10,
            updated: '2024-01-01 10:00:00.000000000',
            unresolved: true,
          },
          {
            id: 'c2',
            author: {name: 'Bob', email: 'bob@example.com'},
            message: 'Looks good',
            line: 20,
            updated: '2024-01-02 10:00:00.000000000',
            unresolved: false,
          },
        ],
        '/COMMIT_MSG': [
          {
            id: 'c3',
            author: {name: 'Bot', email: 'bot@example.com'},
            message: 'CI: build passed',
            line: 1,
            updated: '2024-01-01 09:00:00.000000000',
            unresolved: false,
          },
        ],
      });

    it('fetches inline comments and excludes meta-files', async () => {
      mockHttpsResponse(COMMENTS_RESPONSE);
      const comments = await provider.fetchComments(changeId);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toMatchObject({
        id: 'c1',
        author: 'Alice',
        filename: 'src/foo.ts',
        line: 10,
        isResolved: false, // unresolved: true → not resolved
      });
      expect(comments[1]).toMatchObject({
        id: 'c2',
        author: 'Bob',
        filename: 'src/foo.ts',
        line: 20,
        isResolved: true, // unresolved: false → resolved
      });
    });

    it('excludes /COMMIT_MSG comments', async () => {
      mockHttpsResponse(COMMENTS_RESPONSE);
      const comments = await provider.fetchComments(changeId);
      expect(comments.every(c => c.filename !== '/COMMIT_MSG')).toBe(true);
    });

    it('HTML-escapes plain text comment content', async () => {
      mockHttpsResponse(
        `)]}'\n` +
          JSON.stringify({
            'src/foo.ts': [
              {
                id: 'c1',
                author: {name: 'Alice'},
                message: 'Use <T> not any',
                line: 1,
                updated: '2024-01-01 10:00:00.000000000',
              },
            ],
          }),
      );
      const comments = await provider.fetchComments(changeId);
      expect(comments[0].html).toBe('Use &lt;T&gt; not any');
    });

    it('returns empty array when response is unparseable', async () => {
      mockHttpsResponse('not json');
      const comments = await provider.fetchComments(changeId);
      expect(comments).toEqual([]);
    });

    it('returns empty array when request fails', async () => {
      const mockReq = {on: jest.fn(), setTimeout: jest.fn(), destroy: jest.fn()};
      (https.get as jest.Mock).mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        cb({statusCode: 401, setEncoding: jest.fn(), on: jest.fn()});
        return mockReq;
      });
      const comments = await provider.fetchComments(changeId);
      expect(comments).toEqual([]);
    });

    it('uses gerrit.url as the web URL when set', async () => {
      const providerWithWebUrl = new GerritCodeReviewProvider(
        {type: 'gerrit', remoteUrl: 'ssh://user@ssh.code.example.com:29418/my-repo', webUrl: 'https://code.example.com'},
        mockLogger,
        '/repo',
      );
      mockHttpsResponse(COMMENTS_RESPONSE);
      await providerWithWebUrl.fetchComments(changeId);

      const [[options]] = (https.get as jest.Mock).mock.calls;
      expect(options.hostname).toBe('code.example.com');
      providerWithWebUrl.dispose();
    });
  });

  it('correctly maps MERGED and ABANDONED states', async () => {
    const merged = 'Imerged00000000000000000000000000000000000';
    const abandoned = 'Iabandoned0000000000000000000000000000000';
    mockHttpsResponse(
      `)]}'\n` +
        JSON.stringify([
          {change_id: merged, _number: 1, subject: 'M', status: 'MERGED', labels: {}},
          {change_id: abandoned, _number: 2, subject: 'A', status: 'ABANDONED', labels: {}},
        ]),
    );

    const results: Array<Map<string, unknown>> = [];
    provider.onChangeDiffSummaries(r => {
      if (r.value) {
        results.push(r.value);
      }
    });

    provider.triggerDiffSummariesFetch([merged, abandoned]);
    await new Promise(r => setTimeout(r, 50));

    expect((results[0].get(merged) as {state: string}).state).toBe('MERGED');
    expect((results[0].get(abandoned) as {state: string}).state).toBe('ABANDONED');
  });
});
