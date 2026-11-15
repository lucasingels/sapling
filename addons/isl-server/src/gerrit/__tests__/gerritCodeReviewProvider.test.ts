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
jest.mock('shared/ejeca', () => ({
  // Default: no credentials stored
  ejeca: jest.fn(() => Promise.reject(new Error('no credentials'))),
}));

import https from 'node:https';
import {ejeca} from 'shared/ejeca';

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
      current_revision: 'f00df00df00df00df00df00df00df00df00df00d',
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
    provider = new GerritCodeReviewProvider(GERRIT_SYSTEM, mockLogger);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('skips the request and emits an empty map when no Change-Ids are on screen', async () => {
    const results: Array<Map<string, unknown>> = [];
    provider.onChangeDiffSummaries(r => {
      if (r.value) {
        results.push(r.value);
      }
    });

    provider.triggerDiffSummariesFetch([]);
    await new Promise(r => setTimeout(r, 50));

    expect(https.get).not.toHaveBeenCalled();
    expect(results).toEqual([new Map()]);
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
      path:
        '/changes/?q=' +
        encodeURIComponent(`project:my-repo (change:${changeId})`) +
        '&o=DETAILED_LABELS&o=SUBMIT_REQUIREMENTS&o=CURRENT_REVISION',
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
      currentRevision: 'f00df00df00df00df00df00df00df00df00df00d',
    });
  });

  it('attaches Basic auth when git credential fill returns credentials', async () => {
    const changeId = 'Iabc1234567890abcdef1234567890abcdef12345';
    mockHttpsResponse(GERRIT_CHANGE_RESPONSE(changeId, 142));

    jest.mocked(ejeca).mockImplementation(
      () =>
        Promise.resolve({
          stdout: 'protocol=https\nhost=code.example.com\nusername=alice\npassword=secret',
        }) as unknown as ReturnType<typeof ejeca>,
    );

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

  it('reports a failed fetch per Change-Id, so the client keeps what it already shows', async () => {
    mockHttpsResponse('', 500);

    const results: Array<unknown> = [];
    provider.onChangeDiffSummaries(r => results.push(r));

    provider.triggerDiffSummariesFetch(['Iabc123', 'Idef456']);
    await new Promise(r => setTimeout(r, 50));

    expect(results).toEqual([
      {
        error: expect.any(Error),
        failures: [{error: expect.any(Error), diffIds: ['Iabc123', 'Idef456']}],
      },
    ]);
  });

  describe('fetchComments', () => {
    const changeId = 'Iabc1234567890abcdef1234567890abcdef12345';

    /** Gerrit REST /comments response */
    const COMMENTS_RESPONSE =
      `)]}'\n` +
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
        {
          type: 'gerrit',
          remoteUrl: 'ssh://user@ssh.code.example.com:29418/my-repo',
          webUrl: 'https://code.example.com',
        },
        mockLogger,
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

  it('queries only the Change-Ids asked about, in any status, chunked', async () => {
    mockHttpsResponse(`)]}'\n` + JSON.stringify([]));
    const ids = Array.from({length: 45}, (_, i) => `I${String(i).padStart(40, '0')}`);
    provider.triggerDiffSummariesFetch([...ids, 'not a change id']);
    await new Promise(r => setTimeout(r, 50));

    const paths = (https.get as jest.Mock).mock.calls.map(([opts]) =>
      decodeURIComponent(opts.path as string),
    );
    expect(paths).toHaveLength(2);
    expect(paths.join()).not.toContain('status:open');
    expect(paths.join()).not.toContain('owner:');
    expect(paths.join()).not.toContain('not a change id');
    const queried = paths.flatMap(p => [...p.matchAll(/change:(I\w+)/g)].map(m => m[1]));
    expect(queried).toEqual(ids);
  });

  it('coalesces calls during the wait into one trailing fetch of every Change-Id', async () => {
    jest.useFakeTimers();
    try {
      mockHttpsResponse(`)]}'\n` + JSON.stringify([]));
      provider.triggerDiffSummariesFetch(['Ione']);
      await jest.advanceTimersByTimeAsync(0);
      expect(https.get).toHaveBeenCalledTimes(1);

      provider.triggerDiffSummariesFetch(['Itwo']);
      provider.triggerDiffSummariesFetch(['Ithree']);
      await jest.advanceTimersByTimeAsync(500);
      expect(https.get).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2000);
      expect(https.get).toHaveBeenCalledTimes(2);
      const path = decodeURIComponent((https.get as jest.Mock).mock.calls[1][0].path);
      expect(path).toContain('change:Itwo OR change:Ithree');
    } finally {
      jest.useRealTimers();
    }
  });

  it('parses work_in_progress and is_private flags off the Gerrit change', async () => {
    const wip = 'Iwip00000000000000000000000000000000000000';
    const priv = 'Iprivate000000000000000000000000000000000';
    const plain = 'Iplain0000000000000000000000000000000000000';
    mockHttpsResponse(
      `)]}'\n` +
        JSON.stringify([
          {
            change_id: wip,
            _number: 1,
            subject: 'W',
            status: 'NEW',
            labels: {},
            work_in_progress: true,
          },
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
