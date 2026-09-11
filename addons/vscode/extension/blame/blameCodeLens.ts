/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {RepositoryContext} from 'isl-server/src/serverTypes';
import type {CommitInfo} from 'isl/src/types';
import type {
  CancellationToken,
  Disposable,
  DocumentSymbol,
  SymbolInformation,
  TextDocument,
} from 'vscode';
import type {VSCodeReposList} from '../VSCodeRepo';
import type {InlineBlameProvider} from './blame';

import {relativeDate} from 'isl/src/relativeDate';
import {ComparisonType} from 'shared/Comparison';
import {CodeLens, commands, EventEmitter, languages, Range, SymbolKind, workspace} from 'vscode';
import {getRealignedBlameInfo, mostRecentCommitInRange, shortenAuthorName} from './blameUtils';

const CONFIG_KEY = 'sapling.showBlameCodeLens';

/** Symbol kinds worth their own lens; excludes fields/variables/enum members etc. */
const RELEVANT_SYMBOL_KINDS = new Set<SymbolKind>([
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.Struct,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
]);

/** Keep a single lens line readable; the full message is still available via hover blame. */
const MAX_TITLE_LENGTH = 60;
function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

type LineRange = {startLine: number; endLine: number};

function isDocumentSymbol(sym: DocumentSymbol | SymbolInformation): sym is DocumentSymbol {
  return 'range' in sym;
}

/** Flatten a symbol tree (recursing into `DocumentSymbol.children`) into line ranges. */
function flattenSymbolRanges(
  symbols: ReadonlyArray<DocumentSymbol | SymbolInformation>,
): Array<LineRange> {
  const flat: Array<LineRange> = [];
  for (const sym of symbols) {
    const isRelevant = RELEVANT_SYMBOL_KINDS.has(sym.kind);
    if (isDocumentSymbol(sym)) {
      if (isRelevant) {
        flat.push({startLine: sym.range.start.line, endLine: sym.range.end.line});
      }
      if (sym.children.length > 0) {
        flat.push(...flattenSymbolRanges(sym.children));
      }
    } else if (isRelevant) {
      flat.push({startLine: sym.location.range.start.line, endLine: sym.location.range.end.line});
    }
  }
  return flat;
}

/**
 * A CodeLens anchored to a symbol (or the whole file). The blame commit shown by the lens is
 * only computed in `resolveCodeLens`, so it's only computed for lenses actually on screen -
 * `document` and the line range are stashed here so `resolveCodeLens` (which isn't given the
 * document) has what it needs.
 */
class BlameCodeLens extends CodeLens {
  constructor(
    range: Range,
    public document: TextDocument,
    public blameRange: LineRange,
  ) {
    super(range);
  }
}

/**
 * Shows a CodeLens above the file and above each function/method/class/interface/struct symbol,
 * displaying the most recently authored commit touching that symbol's lines. This bounds lens
 * density on the shape of the code rather than on blame data, so a heavily churned file (e.g.
 * alternating commits line by line) can't degrade back into one lens per line.
 *
 * Symbols come from `vscode.executeDocumentSymbolProvider`, the only supported way to reach
 * another extension's `DocumentSymbolProvider`. When no provider is available (plain text, no
 * language server, ...), only the file-level lens is shown.
 *
 * Reuses `InlineBlameProvider`'s blame cache and `sl blame` fetch path (`fetchBlameIfMissing`)
 * rather than issuing its own fetches. `provideCodeLenses` never awaits that fetch: it returns
 * lenses based on whatever is already cached (nothing, on a cold cache), kicks off a fetch in
 * the background, and relies on `InlineBlameProvider.onDidChangeBlame` to know when to refire
 * `onDidChangeCodeLenses` so VS Code re-queries once data is available.
 */
export class BlameCodeLensProvider implements Disposable {
  private disposables: Array<Disposable> = [];
  private readonly changeEmitter = new EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  /** Memoizes the realigned blame for the current document version, since multiple on-screen
   * lenses resolve against the same document and realignment is a synchronous diff. */
  private realignedCache = new Map<
    string,
    {version: number; lines: Array<[line: string, info: CommitInfo | undefined]>}
  >();

  constructor(
    private blame: InlineBlameProvider,
    private reposList: VSCodeReposList,
    private ctx: RepositoryContext,
  ) {
    this.disposables.push(
      languages.registerCodeLensProvider({scheme: 'file'}, this),
      this.blame.onDidChangeBlame(() => this.changeEmitter.fire()),
      workspace.onDidChangeConfiguration(configChange => {
        if (configChange.affectsConfiguration(CONFIG_KEY)) {
          this.changeEmitter.fire();
        }
      }),
    );
  }

  private isEnabled(): boolean {
    return workspace.getConfiguration().get<boolean>(CONFIG_KEY, false) === true;
  }

  async provideCodeLenses(
    document: TextDocument,
    token: CancellationToken,
  ): Promise<Array<BlameCodeLens>> {
    if (!this.isEnabled() || document.uri.scheme !== 'file') {
      return [];
    }

    // Never block on `sl blame`: kick off a fetch (no-op if already cached or in flight) and
    // build lenses from whatever is cached right now. `onDidChangeBlame` triggers a re-query
    // once new data is ready.
    this.blame
      .fetchBlameIfMissing(document)
      .catch(err => this.ctx.logger.error('Error fetching blame for CodeLens:', err));

    if (!this.blame.getCachedBlame(document)) {
      return [];
    }

    const symbolRanges = await this.getSymbolRanges(document, token);
    if (token.isCancellationRequested) {
      // Documents can change fast; stale symbol ranges would anchor lenses to the wrong lines.
      return [];
    }

    const fileRange: LineRange = {startLine: 0, endLine: Math.max(document.lineCount - 1, 0)};
    return [fileRange, ...symbolRanges].map(
      blameRange =>
        new BlameCodeLens(
          new Range(blameRange.startLine, 0, blameRange.startLine, 0),
          document,
          blameRange,
        ),
    );
  }

  resolveCodeLens(codeLens: BlameCodeLens, _token: CancellationToken): BlameCodeLens | undefined {
    const cached = this.blame.getCachedBlame(codeLens.document);
    if (!cached) {
      return undefined;
    }

    const blameLines = this.getRealignedLines(codeLens.document, cached.baseBlameLines);
    const commit = mostRecentCommitInRange(
      blameLines,
      codeLens.blameRange.startLine,
      codeLens.blameRange.endLine,
    );
    if (!commit) {
      return undefined;
    }

    const repoRoot = this.reposList.repoForPath(codeLens.document.uri.fsPath)?.repo.info.repoRoot;
    codeLens.command = {
      title: this.lensTitle(commit),
      command: 'sapling.open-comparison-view',
      arguments: [{type: ComparisonType.Committed, hash: commit.hash}, repoRoot],
    };
    return codeLens;
  }

  private async getSymbolRanges(
    document: TextDocument,
    token: CancellationToken,
  ): Promise<Array<LineRange>> {
    let symbols: Array<DocumentSymbol | SymbolInformation> | undefined;
    try {
      symbols = await commands.executeCommand<Array<DocumentSymbol | SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
    } catch (err) {
      // No symbol provider for this language, or it failed - fall back to just the file lens.
      this.ctx.logger.info('No document symbols available for blame CodeLens:', err);
      return [];
    }
    if (token.isCancellationRequested || symbols == null) {
      return [];
    }
    return flattenSymbolRanges(symbols);
  }

  private getRealignedLines(
    document: TextDocument,
    baseBlameLines: Array<[line: string, info: CommitInfo | undefined]>,
  ): Array<[line: string, info: CommitInfo | undefined]> {
    const key = document.uri.fsPath;
    const memo = this.realignedCache.get(key);
    if (memo != null && memo.version === document.version) {
      return memo.lines;
    }
    const lines = getRealignedBlameInfo(baseBlameLines, document.getText());
    this.realignedCache.set(key, {version: document.version, lines});
    return lines;
  }

  private lensTitle(commit: CommitInfo): string {
    const DOT = '•';
    return `${shortenAuthorName(commit.author)}, ${relativeDate(commit.date, {})} ${DOT} ${truncateTitle(
      commit.title.trim(),
    )}`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.realignedCache.clear();
    this.changeEmitter.dispose();
  }
}
