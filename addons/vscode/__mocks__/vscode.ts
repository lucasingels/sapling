/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type * as vscode from 'vscode';

// don't want to mock vscode.Uri, so use library for it
import {URI, Utils} from 'vscode-uri';
// vscode-uri's URI doesn't implement the `joinPath` static that real vscode.Uri has.
export const Uri = Object.assign(URI, {joinPath: Utils.joinPath});

export const env = proxyMissingFieldsWithJestFn({
  sessionId: 'test-session-id',
});
export const window = proxyMissingFieldsWithJestFn({
  activeTextEditor: undefined as vscode.TextEditor | undefined,
  withProgress: jest.fn(
    (
      _options: vscode.ProgressOptions,
      task: (
        progress: vscode.Progress<{message?: string; increment?: number}>,
        token: vscode.CancellationToken,
      ) => unknown,
    ) =>
      task({report: jest.fn()}, {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn(),
      } as never),
  ),
});
export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};
export const languages = proxyMissingFieldsWithJestFn({
  getDiagnostics: jest.fn().mockReturnValue([]),
});
export const commands = proxyMissingFieldsWithJestFn({
  executeCommand: jest.fn(),
});
export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
};
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};
export const workspace = proxyMissingFieldsWithJestFn({
  workspaceFolders: undefined,
  getConfiguration: () => ({get: jest.fn()}),
});
export const scm = proxyMissingFieldsWithJestFn({
  createSourceControl: jest.fn((): vscode.SourceControl => ({
    inputBox: {value: '', placeholder: '', enabled: true, visible: true},
    createResourceGroup: jest.fn(() => ({
      hideWhenEmpty: false,
      resourceStates: [],
      id: '',
      label: '',
      dispose: jest.fn(),
    })),
    id: '',
    dispose: jest.fn(),
    label: '',
    rootUri: Uri.file(''),
  })),
});

export class ThemeColor {
  constructor(public id: string) {}
}

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  public start: Position;
  public end: Position;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position, end: Position);
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

export const CommentMode = {
  Editing: 0,
  Preview: 1,
};

export const CommentThreadCollapsibleState = {
  Collapsed: 0,
  Expanded: 1,
};

export const CommentThreadState = {
  Unresolved: 0,
  Resolved: 1,
};

export const comments = {
  createCommentController: jest.fn(
    (id: string, label: string): vscode.CommentController =>
      ({
        id,
        label,
        createCommentThread: jest.fn(
          (
            uri: vscode.Uri,
            range: vscode.Range,
            threadComments: readonly vscode.Comment[],
          ): vscode.CommentThread => ({
            uri,
            range,
            comments: threadComments,
            collapsibleState: CommentThreadCollapsibleState.Collapsed,
            canReply: true,
            dispose: jest.fn(),
          }),
        ),
        dispose: jest.fn(),
      }) as unknown as vscode.CommentController,
  ),
};

export class Disposable implements vscode.Disposable {
  static from(...disposables: vscode.Disposable[]): vscode.Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }
  private callOnDispose?: () => void;
  constructor(callOnDispose?: () => void) {
    this.callOnDispose = callOnDispose;
  }
  dispose = jest.fn(() => {
    this.callOnDispose?.();
  });
}

// to avoid manually writing jest.fn() for every API,
// assume fields that we don't provide are jest.fn() which return disposables
function proxyMissingFieldsWithJestFn<T extends object>(t: T): T {
  return new Proxy(t, {
    get: ((_: unknown, key: keyof T) => {
      if (Object.prototype.hasOwnProperty.call(t, key)) {
        return t[key];
      }
      // make sure we keep the jest.fn() we make so it's not remade each time
      t[key] = jest.fn().mockReturnValue(new Disposable()) as unknown as (typeof t)[keyof T];
      return t[key];
    }) as unknown as ProxyHandler<T>['get'],
  });
}

interface Event<T> {
  (listener: (e: T) => unknown): Disposable;
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];
  event: Event<T> = (listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter(l => l !== listener);
    });
  };
  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class CodeLens {
  readonly isResolved: boolean;
  constructor(
    public range: Range,
    public command?: vscode.Command,
  ) {
    this.isResolved = command != null;
  }
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}
