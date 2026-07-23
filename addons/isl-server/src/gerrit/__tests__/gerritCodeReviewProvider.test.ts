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
        'Code-Review': {approved: {name: 'Bob'}, all: [{value: 2}, {value: 1}]},
        Verified: {approved: {name: 'CI'}, all: [{value: 1}]},
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

  it('still fetches when no diffs are provided, since it fetches all owned changes regardless', async () => {
    // Matches the GitHub provider's approach: fetch all of the user's changes so
    // badges populate even before any smartlog commit has a known Change-Id.
    const changeId = 'Iabc1234567890abcdef1234567890abcdef12345';
    mockHttpsResponse(GERRIT_CHANGE_RESPONSE(changeId, 142));

    const results: Array<Map<string, unknown>> = [];
    provider.onChangeDiffSummaries(r => {
      if (r.value) {
        results.push(r.value);
      }
    });

    provider.triggerDiffSummariesFetch([]);

    // Wait for async debounce
    await new Promise(r => setTimeout(r, 50));
    expect(https.get).toHaveBeenCalledTimes(1);
    expect(results[0]?.has(changeId)).toBe(true);
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

    // The diffs argument is intentionally ignored (see triggerDiffSummariesFetch's
    // docstring) — the query is scoped by owner+project, not by Change-Id.
    provider.triggerDiffSummariesFetch([changeId]);
    await new Promise(r => setTimeout(r, 50));

    expect(https.get).toHaveBeenCalledTimes(1);
    const [[url]] = (https.get as jest.Mock).mock.calls;
    expect(url).toMatchObject({
      hostname: 'code.example.com',
      path: '/changes/?q=project:my-repo&o=DETAILED_LABELS&o=SUBMIT_REQUIREMENTS',
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
      codeReview: 'approved',
      signalSummary: 'pass',
      commentCount: 0,
      anyUnresolvedComments: false,
      submittable: true,
      isWorkInProgress: false,
      isPrivate: false,
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

    it('includes general (patchset-level) comments, both resolved and unresolved', async () => {
      mockHttpsResponse(
        `)]}'\n` +
          JSON.stringify({
            '/PATCHSET_LEVEL': [
              {
                id: 'g1',
                author: {name: 'Alice', email: 'alice@example.com'},
                message: 'Please split this into two changes',
                updated: '2024-01-01 10:00:00.000000000',
                unresolved: true,
              },
              {
                id: 'g2',
                author: {name: 'Bob', email: 'bob@example.com'},
                message: 'LGTM',
                updated: '2024-01-02 10:00:00.000000000',
                unresolved: false,
              },
            ],
          }),
      );
      const comments = await provider.fetchComments(changeId);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toMatchObject({
        id: 'g1',
        author: 'Alice',
        filename: undefined,
        line: undefined,
        isResolved: false,
      });
      expect(comments[1]).toMatchObject({
        id: 'g2',
        author: 'Bob',
        filename: undefined,
        line: undefined,
        isResolved: true,
      });
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

  it('does not restrict the changes query to status:open, so merged/abandoned changes keep updating', async () => {
    mockHttpsResponse(`)]}'\n` + JSON.stringify([]));
    provider.triggerDiffSummariesFetch(['Iabc123']);
    await new Promise(r => setTimeout(r, 50));

    const [[url]] = (https.get as jest.Mock).mock.calls;
    expect(url.path).not.toContain('status:open');
  });

  it('parses work_in_progress and is_private flags off the Gerrit change', async () => {
    const wip = 'Iwip00000000000000000000000000000000000000';
    const priv = 'Iprivate000000000000000000000000000000000';
    const plain = 'Iplain0000000000000000000000000000000000000';
    mockHttpsResponse(
      `)]}'\n` +
        JSON.stringify([
          {change_id: wip, _number: 1, subject: 'W', status: 'NEW', labels: {}, work_in_progress: true},
          {change_id: priv, _number: 2, subject: 'P', status: 'NEW', labels: {}, is_private: true},
          {change_id: plain, _number: 3, subject: 'N', status: 'NEW', labels: {}},
        ]),
    );

    const results: Array<Map<string, unknown>> = [];
    provider.onChangeDiffSummaries(r => {
      if (r.value) {
        results.push(r.value);
      }
    });

    provider.triggerDiffSummariesFetch([wip, priv, plain]);
    await new Promise(r => setTimeout(r, 50));

    expect(results[0].get(wip)).toMatchObject({isWorkInProgress: true, isPrivate: false});
    expect(results[0].get(priv)).toMatchObject({isWorkInProgress: false, isPrivate: true});
    expect(results[0].get(plain)).toMatchObject({isWorkInProgress: false, isPrivate: false});
  });
});
