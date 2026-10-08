import type { App, WorkspaceLeaf } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { Controller } from '../src/controller';
import { Documents } from '../src/documents';
import { hashText } from '../src/editing';
import { Store } from '../src/store';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

interface PendingProcess {
  callback: (content: string) => string;
  resolve: (content: string) => void;
  reject: (reason: Error) => void;
}

function deferredPreview() {
  const file = new TFile('模拟异步写回.md');
  const view = new MarkdownView(file, new TestEditor('旧改稿正文')); view.mode = 'preview';
  const leaf = { view };
  const pending: PendingProcess[] = [];
  let disk = '旧改稿正文';
  let nextReadGate: Promise<void> | undefined;
  const app = {
    workspace: { getLeavesOfType: () => [leaf], getMostRecentLeaf: () => leaf },
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      read: async () => {
        const gate = nextReadGate; nextReadGate = undefined;
        if (gate) await gate;
        return disk;
      },
      process: (_file: TFile, callback: (content: string) => string) => new Promise<string>((resolve, reject) => pending.push({ callback, resolve, reject })),
    },
    secretStorage: { getSecret: () => null },
  } as unknown as App;
  const store = new Store(null, async () => {});
  const documents = new Documents(app, store.data.sessions); documents.focus(leaf as unknown as WorkspaceLeaf);
  const controller = new Controller(app, store, documents, () => {});
  const session = controller.currentSession()!;
  session.brief = '保留本文要求';
  session.undo = { documentId: session.document.id, path: file.path, before: '最初正文', from: 0, to: 4, replacement: disk, candidateId: 'prior-application' };
  session.candidate = {
    id: 'new-application', requestId: 'new-request', documentId: session.document.id, sessionId: session.id,
    path: file.path, scope: 'body', from: 0, to: disk.length, baseline: disk, baselineHash: hashText(disk),
    replacement: '最新改稿正文', explanation: '最新改稿', notes: [], state: 'ready', deletion: false,
  };
  function commit(index: number): void {
    const operation = pending[index]; if (!operation) throw new Error('Expected deferred process');
    try { disk = operation.callback(disk); operation.resolve(disk); }
    catch (error) { operation.reject(error instanceof Error ? error : new Error('process failed')); }
  }
  function pauseNextRead(): () => void {
    let release!: () => void;
    nextReadGate = new Promise<void>((resolve) => { release = resolve; });
    return release;
  }
  return { controller, session, pending, commit, pauseNextRead, disk: () => disk };
}

describe('per-document asynchronous edit exclusion', () => {
  it('blocks an older undo during pending apply and preserves the newest successful undo record', async () => {
    const f = deferredPreview(); const candidate = f.session.candidate!;
    const applying = f.controller.apply(candidate);
    expect(candidate.state).toBe('applying'); expect(f.pending).toHaveLength(1);
    await expect(f.controller.undo()).rejects.toThrow('正在应用或撤回');
    expect(f.session.undo?.candidateId).toBe('prior-application');
    expect(f.pending).toHaveLength(1);
    f.commit(0); await applying;
    expect(f.disk()).toBe('最新改稿正文');
    expect(f.session.undo?.candidateId).toBe('new-application');
    expect(candidate.state).toBe('applied');
    const undoing = f.controller.undo();
    expect(f.pending).toHaveLength(2);
    f.commit(1); await undoing;
    expect(f.disk()).toBe('旧改稿正文');
    expect(f.session.undo).toBeUndefined(); expect(candidate.state).toBe('undone');
  });

  it('does not let clearing, deleting or duplicate apply replace a pending application', async () => {
    const f = deferredPreview(); const candidate = f.session.candidate!;
    f.session.messages.push({ id: 'existing-discussion', role: 'user', content: '保留原讨论直到操作完成', at: 1 });
    const applying = f.controller.apply(candidate);
    await expect(f.controller.clearSession()).rejects.toThrow('操作完成');
    await expect(f.controller.deleteRange('body')).rejects.toThrow('操作完成');
    await expect(f.controller.apply(candidate)).rejects.toThrow();
    expect(f.session.candidate).toBe(candidate);
    expect(f.session.messages[0]?.content).toBe('保留原讨论直到操作完成');
    expect(f.pending).toHaveLength(1); expect(f.disk()).toBe('旧改稿正文');
    f.commit(0); await applying;
    expect(f.disk()).toBe('最新改稿正文'); expect(f.session.undo?.candidateId).toBe(candidate.id);
    await f.controller.clearSession();
    expect(f.session.brief).toBe('保留本文要求');
    expect(f.session.candidate).toBeUndefined();
    expect(f.session.undo?.candidateId).toBe(candidate.id);
    expect(f.disk()).toBe('最新改稿正文');
  });

  it('blocks apply while undo is pending, then expires the candidate based on the old version', async () => {
    const f = deferredPreview(); const candidate = f.session.candidate!;
    const undoing = f.controller.undo();
    await expect(f.controller.apply(candidate)).rejects.toThrow('正在应用或撤回');
    await expect(f.controller.clearSession()).rejects.toThrow('操作完成');
    await expect(f.controller.deleteRange('body')).rejects.toThrow('操作完成');
    expect(candidate.state).toBe('ready'); expect(f.pending).toHaveLength(1);
    f.commit(0); await undoing;
    expect(f.disk()).toBe('最初正文'); expect(candidate.state).toBe('stale');
    await f.controller.deleteRange('body');
    expect(f.session.candidate?.deletion).toBe(true);
    expect(f.session.candidate?.baseline).toBe('最初正文');
  });

  it('releases the edit lock after process failure without losing the previously valid undo record', async () => {
    const f = deferredPreview(); const candidate = f.session.candidate!;
    const applying = f.controller.apply(candidate);
    f.pending[0]!.reject(new Error('模拟原子写入失败'));
    await expect(applying).rejects.toThrow('模拟原子写入失败');
    expect(candidate.state).toBe('stale'); expect(f.disk()).toBe('旧改稿正文');
    expect(f.session.undo?.candidateId).toBe('prior-application');
    await f.controller.clearSession();
    expect(f.session.messages).toEqual([]); expect(f.session.undo?.candidateId).toBe('prior-application');
  });

  it('blocks clearing while deletion reads its frozen document, then releases the lock after creating the candidate', async () => {
    const f = deferredPreview(); const previous = f.session.candidate!;
    const releaseRead = f.pauseNextRead();
    const deleting = f.controller.deleteRange('body');
    await expect(f.controller.clearSession()).rejects.toThrow('操作完成');
    await expect(f.controller.apply(previous)).rejects.toThrow('正在应用或撤回');
    expect(f.session.candidate).toBe(previous); expect(f.pending).toHaveLength(0);
    releaseRead(); await deleting;
    const deletion = f.session.candidate!;
    expect(deletion.id).not.toBe(previous.id);
    expect(deletion.deletion).toBe(true); expect(deletion.state).toBe('ready');
    expect(deletion.baseline).toBe('旧改稿正文'); expect(previous.state).toBe('superseded');
    expect(f.disk()).toBe('旧改稿正文');
    await f.controller.clearSession();
    expect(f.session.candidate).toBeUndefined(); expect(f.disk()).toBe('旧改稿正文');
    expect(f.session.undo?.candidateId).toBe('prior-application');
  });
});
