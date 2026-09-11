/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {RepositoryContext} from 'isl-server/src/serverTypes';
import type {CommitInfo} from 'isl/src/types';
import type {CancellationToken, DocumentSymbol, TextDocument} from 'vscode';
import type {VSCodeReposList} from '../../VSCodeRepo';
import type {CachedBlame, InlineBlameProvider} from '../blame';

import {mockLogger} from 'shared/testUtils';
import * as vscode from 'vscode';
import {BlameCodeLensProvider} from '../blameCodeLens';

jest.mock('vscode', () => jest.requireActual('../../../__mocks__/vscode'));

const NOOP_TOKEN = {isCancellationRequested: false} as CancellationToken;
const CANCELLED_TOKEN = {isCancellationRequested: true} as CancellationToken;

function makeDocument(fsPath: string, text: string, version = 1): TextDocument {
  const lines = text.split('\n');
  return {
    uri: vscode.Uri.file(fsPath),
    getText: () => text,
    version,
    lineCount: lines.length,
  } as unknown as TextDocument;
}

function makeCommit(hash: string, date: string, title = `commit ${hash}`): CommitInfo {
  return {
    hash,
    title,
    author: 'Person Name person@example.com',
    date: new Date(date),
  } as unknown as CommitInfo;
}

function makeDocumentSymbol(
  name: string,
  kind: vscode.SymbolKind,
  startLine: number,
  endLine: number,
  children: Array<DocumentSymbol> = [],
): DocumentSymbol {
  return {
    name,
    kind,
    range: new vscode.Range(startLine, 0, endLine, 0),
    selectionRange: new vscode.Range(startLine, 0, startLine, 0),
    children,
  } as unknown as DocumentSymbol;
}

class FakeBlameSource {
  cache = new Map<string, CachedBlame>();
  onDidChangeBlameEmitter = new vscode.EventEmitter<void>();
  onDidChangeBlame = this.onDidChangeBlameEmitter.event;
  fetchBlameIfMissing = jest.fn(() => Promise.resolve(true));
  getCachedBlame(document: TextDocument): CachedBlame | undefined {
    return this.cache.get(document.uri.fsPath);
  }
}

function makeReposList(repoRoot = '/repo'): VSCodeReposList {
  return {
    repoForPath: jest.fn(() => ({repo: {info: {repoRoot}}})),
  } as unknown as VSCodeReposList;
}

const ctx = {logger: mockLogger} as unknown as RepositoryContext;

describe('BlameCodeLensProvider', () => {
  let onDidChangeConfigCallback: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    onDidChangeConfigCallback = undefined;
    (vscode.workspace.onDidChangeConfiguration as jest.Mock).mockImplementation(cb => {
      onDidChangeConfigCallback = cb;
      return {dispose: jest.fn()};
    });
    mockConfig(false);
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
  });

  function mockConfig(enabled: boolean) {
    jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: jest.fn().mockReturnValue(enabled),
    } as never);
  }

  function makeProvider(fakeBlame: FakeBlameSource, reposList = makeReposList()) {
    return new BlameCodeLensProvider(fakeBlame as unknown as InlineBlameProvider, reposList, ctx);
  }

  it('returns no lenses and does not block when the cache is cold', async () => {
    mockConfig(true);
    const fakeBlame = new FakeBlameSource();
    const provider = makeProvider(fakeBlame);
    const document = makeDocument('/repo/file.txt', 'a\nb\nc\n');

    const lenses = await provider.provideCodeLenses(document, NOOP_TOKEN);

    expect(lenses).toEqual([]);
    expect(fakeBlame.fetchBlameIfMissing).toHaveBeenCalledWith(document);
    // A cold cache must not need document symbols at all.
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('fires onDidChangeCodeLenses once blame data arrives', () => {
    mockConfig(true);
    const fakeBlame = new FakeBlameSource();
    const provider = makeProvider(fakeBlame);
    const listener = jest.fn();
    provider.onDidChangeCodeLenses(listener);

    fakeBlame.onDidChangeBlameEmitter.fire();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not show lenses when the config is disabled', async () => {
    mockConfig(false);
    const fakeBlame = new FakeBlameSource();
    const person1 = makeCommit('A', '2020-01-01');
    const document = makeDocument('/repo/file.txt', 'a\nb\n');
    fakeBlame.cache.set(document.uri.fsPath, {
      baseBlameLines: [
        ['a\n', person1],
        ['b\n', person1],
      ],
      currentBlameLines: undefined,
    });
    const provider = makeProvider(fakeBlame);

    expect(await provider.provideCodeLenses(document, NOOP_TOKEN)).toEqual([]);
  });

  it('refires onDidChangeCodeLenses when the showBlameCodeLens config toggle changes', () => {
    mockConfig(false);
    const fakeBlame = new FakeBlameSource();
    const provider = makeProvider(fakeBlame);
    const listener = jest.fn();
    provider.onDidChangeCodeLenses(listener);

    onDidChangeConfigCallback?.({
      affectsConfiguration: (key: string) => key === 'sapling.showBlameCodeLens',
    } as vscode.ConfigurationChangeEvent);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe('with a cache populated', () => {
    const olderCommit = makeCommit('A', '2020-01-01', 'initial commit');
    const newerCommit = makeCommit('B', '2022-01-01', 'a much later fix');

    function setUpDocument(fakeBlame: FakeBlameSource) {
      // line 0: function foo() {   <- foo's own line, from olderCommit
      // line 1:   return 1;        <- newerCommit (most recent within foo's range)
      // line 2: }
      // line 3: function bar() {   <- bar's range, olderCommit only
      // line 4:   return 2;
      // line 5: }
      const text = 'function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}\n';
      const document = makeDocument('/repo/file.ts', text);
      fakeBlame.cache.set(document.uri.fsPath, {
        baseBlameLines: [
          ['function foo() {\n', olderCommit],
          ['  return 1;\n', newerCommit],
          ['}\n', olderCommit],
          ['function bar() {\n', olderCommit],
          ['  return 2;\n', olderCommit],
          ['}\n', olderCommit],
        ],
        currentBlameLines: undefined,
      });
      return document;
    }

    it('emits one lens per relevant symbol plus one file-level lens, including nested children', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      const method = makeDocumentSymbol('method', vscode.SymbolKind.Method, 1, 1);
      const foo = makeDocumentSymbol('foo', vscode.SymbolKind.Function, 0, 2, [method]);
      const bar = makeDocumentSymbol('bar', vscode.SymbolKind.Function, 3, 5);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([foo, bar]);
      const provider = makeProvider(fakeBlame);

      const lenses = await provider.provideCodeLenses(document, NOOP_TOKEN);

      // file-level + foo + foo's nested method child + bar
      expect(lenses).toHaveLength(4);
      expect(lenses.map(l => l.range.start.line)).toEqual([0, 0, 1, 3]);
    });

    it('picks the most recent commit within a symbol range when resolving', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      const foo = makeDocumentSymbol('foo', vscode.SymbolKind.Function, 0, 2);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([foo]);
      const provider = makeProvider(fakeBlame);

      const [, fooLens] = await provider.provideCodeLenses(document, NOOP_TOKEN);
      const resolved = provider.resolveCodeLens(fooLens, NOOP_TOKEN);

      expect(resolved?.command?.arguments?.[0]).toEqual({type: 'Commit', hash: newerCommit.hash});
      expect(resolved?.command?.title).toContain('a much later fix');
      expect(resolved?.command?.command).toEqual('sapling.open-comparison-view');
    });

    it('falls back to only the file-level lens when no symbol provider is available', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const provider = makeProvider(fakeBlame);

      const lenses = await provider.provideCodeLenses(document, NOOP_TOKEN);

      expect(lenses).toHaveLength(1);
      expect(lenses[0].range.start.line).toEqual(0);
      const resolved = provider.resolveCodeLens(lenses[0], NOOP_TOKEN);
      // most recent commit across the whole file is newerCommit.
      expect(resolved?.command?.arguments?.[0]).toEqual({type: 'Commit', hash: newerCommit.hash});
    });

    it('bails out without lenses if the token is cancelled while fetching symbols', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([
        makeDocumentSymbol('foo', vscode.SymbolKind.Function, 0, 2),
      ]);
      const provider = makeProvider(fakeBlame);

      expect(await provider.provideCodeLenses(document, CANCELLED_TOKEN)).toEqual([]);
    });

    it('invokes sapling.open-comparison-view with the commit hash and repo root', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const provider = makeProvider(fakeBlame, makeReposList('/my-repo'));

      const [fileLens] = await provider.provideCodeLenses(document, NOOP_TOKEN);
      const resolved = provider.resolveCodeLens(fileLens, NOOP_TOKEN);

      expect(resolved?.command).toEqual({
        title: expect.stringContaining('a much later fix') as unknown as string,
        command: 'sapling.open-comparison-view',
        arguments: [{type: 'Commit', hash: newerCommit.hash}, '/my-repo'],
      });
    });

    it('shifts a symbol lens to account for unsaved edits (realignment)', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      // insert one unattributed line at the top of the base blame's file.
      const editedText = '// inserted\nfunction foo() {\n  return 1;\n}\n';
      const document = makeDocument('/repo/file.ts', editedText);
      fakeBlame.cache.set(document.uri.fsPath, {
        baseBlameLines: [
          ['function foo() {\n', olderCommit],
          ['  return 1;\n', newerCommit],
          ['}\n', olderCommit],
        ],
        currentBlameLines: undefined,
      });
      // symbol ranges reflect the *current*, edited buffer (as a real language server would report).
      const foo = makeDocumentSymbol('foo', vscode.SymbolKind.Function, 1, 3);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([foo]);
      const provider = makeProvider(fakeBlame);

      const lenses = await provider.provideCodeLenses(document, NOOP_TOKEN);
      const fooLens = lenses.find(l => l.range.start.line === 1);
      expect(fooLens).toBeDefined();

      const resolved = provider.resolveCodeLens(fooLens!, NOOP_TOKEN);
      // still finds the commit despite the inserted line shifting everything down by one.
      expect(resolved?.command?.arguments?.[0]).toEqual({type: 'Commit', hash: newerCommit.hash});
    });

    it('excludes symbols with kinds that are not functions/methods/classes/interfaces/structs', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      const field = makeDocumentSymbol('someField', vscode.SymbolKind.Field, 4, 4);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([field]);
      const provider = makeProvider(fakeBlame);

      const lenses = await provider.provideCodeLenses(document, NOOP_TOKEN);

      // only the file-level lens, the field symbol is filtered out.
      expect(lenses).toHaveLength(1);
    });

    it('handles SymbolInformation[] shaped results (not just DocumentSymbol[])', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      const symbolInformation = {
        name: 'bar',
        kind: vscode.SymbolKind.Function,
        location: {uri: document.uri, range: new vscode.Range(3, 0, 5, 0)},
      };
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue([symbolInformation]);
      const provider = makeProvider(fakeBlame);

      const lenses = await provider.provideCodeLenses(document, NOOP_TOKEN);

      expect(lenses).toHaveLength(2);
      expect(lenses[1].range.start.line).toEqual(3);
    });

    it('returns undefined from resolveCodeLens when the cache was evicted before resolving', async () => {
      mockConfig(true);
      const fakeBlame = new FakeBlameSource();
      const document = setUpDocument(fakeBlame);
      (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
      const provider = makeProvider(fakeBlame);

      const [fileLens] = await provider.provideCodeLenses(document, NOOP_TOKEN);
      fakeBlame.cache.delete(document.uri.fsPath);

      expect(provider.resolveCodeLens(fileLens, NOOP_TOKEN)).toBeUndefined();
    });
  });
});
