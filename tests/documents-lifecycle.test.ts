import type { App, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { Controller } from '../src/controller';
import { Documents } from '../src/documents';
import { hashText } from '../src/editing';
import { Store } from '../src/store';
import type { PluginData } from '../src/types';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

const ORIGINAL = '---\ntitle: 身份测试\n---\n中文原文🙂\n';

function appFixture(file = new TFile('测试/A.md')) {
  const editor = new TestEditor(ORIGINAL); const view = new MarkdownView(file, editor); const leaf = { view };
  const leaves = [leaf]; const files = new Map([[file.path, file]]);
  const getByPath = vi.fn((path: string) => files.get(path) ?? null);
  const app = {
    workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => leaf },
    vault: { getAbstractFileByPath: getByPath, read: async () => ORIGINAL, process: vi.fn() },
    secretStorage: { getSecret: () => null },
  } as unknown as App;
  return { app, file, editor, view, leaf, leaves, files, getByPath };
}

function withSavedEdit(): { raw: PluginData; sessionId: string; documentId: string; candidateId: string } {
  const store = new Store(null, async () => {});
  const s = store.sessionFor({ id: 'stable-document-a', path: '测试/A.md', ctime: 1 });
  const from = ORIGINAL.indexOf('中文原文');
  s.messages.push({ id: 'history', role: 'user', content: '原文稿的讨论', at: 1 });
  s.candidate = {
    id: 'saved-candidate', requestId: 'saved-request', documentId: s.document.id, sessionId: s.id,
    path: s.document.path, scope: 'body', from, to: ORIGINAL.length,
    baseline: ORIGINAL, baselineHash: hashText(ORIGINAL), replacement: '新的中文正文🙂\n',
    explanation: '身份验证后的替换', notes: [], state: 'ready', deletion: false,
  };
  s.undo = { documentId: s.document.id, path: s.document.path, before: ORIGINAL, from, to: ORIGINAL.length, replacement: '前一次改稿', candidateId: 'older-candidate' };
  return { raw: store.data, sessionId: s.id, documentId: s.document.id, candidateId: s.candidate.id };
}

function restored(raw: PluginData, f: ReturnType<typeof appFixture>) {
  const store = new Store(raw, async () => {});
  const documents = new Documents(f.app, store.data.sessions);
  documents.focus(f.leaf as unknown as WorkspaceLeaf);
  const controller = new Controller(f.app, store, documents, () => {});
  return { store, documents, controller };
}

describe('document identity and conservative lifecycle recovery', () => {
  it('can undo AI-introduced YAML while still protecting the original frontmatter', async () => {
    for (const replacement of ['---\ntitle: 新增 YAML\n---\n新的正文', '---\n未闭合的新增 YAML']) {
      const saved = withSavedEdit(); const f = appFixture(); const r = restored(saved.raw, f);
      const session = r.controller.currentSession()!;
      const candidate = session.candidate!;
      candidate.baseline = '原始正文🙂'; candidate.baselineHash = hashText(candidate.baseline);
      candidate.from = 0; candidate.to = candidate.baseline.length; candidate.replacement = replacement;
      f.editor.text = candidate.baseline;
      await r.controller.apply(candidate);
      expect(f.editor.text).toBe(replacement);
      await r.controller.undo();
      expect(f.editor.text).toBe(candidate.baseline);
      expect(candidate.state).toBe('undone');
    }
  });

  it('validates the registered document, bounds, and frontmatter at the final edit boundary', async () => {
    const saved = withSavedEdit(); const f = appFixture(); const r = restored(saved.raw, f);
    const document = r.documents.current()!;
    const start = ORIGINAL.indexOf('中文原文');
    await expect(r.documents.applyRange({ ...document, path: '其他文稿.md' }, ORIGINAL, start, ORIGINAL.length, '新稿')).rejects.toThrow('身份');
    await expect(r.documents.applyRange({ ...document, id: 'unknown-document' }, ORIGINAL, start, ORIGINAL.length, '新稿')).rejects.toThrow('身份无法确认');
    for (const [from, to] of [[-1, start], [start + 0.5, ORIGINAL.length], [start, ORIGINAL.length + 1]]) {
      await expect(r.documents.applyRange(document, ORIGINAL, from!, to!, '新稿')).rejects.toThrow('范围无效');
    }
    await expect(r.documents.applyRange(document, ORIGINAL, 0, start, '新稿')).rejects.toThrow('frontmatter');
    expect(f.editor.text).toBe(ORIGINAL); expect(f.editor.transactions).toBe(0);
  });

  it('restores confirmed path/ctime identity and still compares the full editor baseline on apply', async () => {
    const saved = withSavedEdit(); const f = appFixture(); const r = restored(saved.raw, f);
    expect(r.documents.current()?.id).toBe(saved.documentId);
    expect(r.controller.currentSession()?.id).toBe(saved.sessionId);
    const s = r.controller.currentSession()!;
    expect(s.candidate?.state).toBe('ready'); expect(s.undo).toBeDefined();
    f.editor.text += '重启后手工新增';
    await expect(r.controller.apply(s.candidate!)).rejects.toThrow('已变化');
    expect(f.editor.text).toContain('重启后手工新增');
    expect(s.candidate?.state).toBe('stale'); expect(f.editor.transactions).toBe(0);
  });

  it('applies a recovered ready candidate only to the confirmed unchanged original', async () => {
    const saved = withSavedEdit(); const f = appFixture(); const r = restored(saved.raw, f);
    const s = r.controller.currentSession()!; const candidate = s.candidate!;
    await r.controller.apply(candidate);
    expect(f.editor.text).toBe(ORIGINAL.slice(0, candidate.from) + candidate.replacement);
    expect(f.editor.transactions).toBe(1); expect(candidate.state).toBe('applied');
  });

  it('does not revive a prior candidate when the saved path now has a different creation-time identity', async () => {
    const saved = withSavedEdit(); const recreated = new TFile('测试/A.md'); recreated.stat.ctime = 2;
    const f = appFixture(recreated); const r = restored(saved.raw, f);
    const originalSession = r.store.data.sessions[saved.documentId]!;
    expect(originalSession.candidate?.state).toBe('stale'); expect(originalSession.undo).toBeUndefined();
    const newSession = r.controller.currentSession()!;
    expect(newSession.document.id).not.toBe(saved.documentId);
    expect(newSession.messages).toEqual([]);
    await expect(r.controller.apply(originalSession.candidate!)).rejects.toThrow();
    expect(f.editor.text).toBe(ORIGINAL); expect(f.editor.transactions).toBe(0);
  });

  it('keeps an offline-renamed session detached without scanning or guessing from identical content', async () => {
    const saved = withSavedEdit(); const renamed = new TFile('离线改名/B.md');
    const f = appFixture(renamed); const r = restored(saved.raw, f);
    const originalSession = r.store.data.sessions[saved.documentId]!;
    expect(originalSession.document.path).toBe('测试/A.md');
    expect(originalSession.messages[0]!.content).toBe('原文稿的讨论');
    expect(originalSession.candidate?.state).toBe('stale'); expect(originalSession.undo).toBeUndefined();
    expect(r.controller.currentSession()?.document.id).not.toBe(saved.documentId);
    expect(() => r.documents.resolve(saved.documentId)).toThrow('身份无法确认');
    expect(new Set(f.getByPath.mock.calls.map(([path]) => path))).toEqual(new Set(['测试/A.md', '离线改名/B.md']));
    expect(f.editor.text).toBe(ORIGINAL);
  });

  it('follows an online rename without losing the original file identity, candidate or undo path', async () => {
    const saved = withSavedEdit(); const f = appFixture(); const r = restored(saved.raw, f);
    const s = r.controller.currentSession()!;
    const oldPath = f.file.path;
    f.files.delete(oldPath); f.file.path = '改名后/稿件.md'; f.files.set(f.file.path, f.file);
    r.documents.renamed(f.file as unknown as TAbstractFile, oldPath);
    expect(r.documents.current()?.id).toBe(saved.documentId);
    expect(s.document.path).toBe('改名后/稿件.md');
    expect(s.candidate!.path).toBe('改名后/稿件.md'); expect(s.undo!.path).toBe('改名后/稿件.md');
    await r.controller.apply(s.candidate!);
    expect(f.editor.text).toContain('新的中文正文🙂');
    expect(s.undo!.path).toBe('改名后/稿件.md');
  });

  it('tombstones an online deleted file even if a new object has the same path and creation time', async () => {
    const saved = withSavedEdit(); const f = appFixture(); const r = restored(saved.raw, f);
    const oldSession = r.controller.currentSession()!; const oldFile = f.file;
    r.documents.deleted(oldFile as unknown as TAbstractFile); f.files.delete(oldFile.path);
    const recreated = new TFile(oldFile.path); recreated.stat.ctime = oldFile.stat.ctime;
    f.files.set(recreated.path, recreated); f.view.file = recreated; r.documents.focus(f.leaf as unknown as WorkspaceLeaf);
    const current = r.controller.currentSession()!;
    expect(current.document.id).not.toBe(saved.documentId);
    expect(oldSession.document.deleted).toBe(true);
    expect(oldSession.candidate?.state).toBe('stale'); expect(oldSession.undo).toBeUndefined();
    await expect(r.controller.apply(oldSession.candidate!)).rejects.toThrow();
    expect(current.messages).toEqual([]); expect(f.editor.text).toBe(ORIGINAL); expect(f.editor.transactions).toBe(0);
  });

  it('blocks inconsistent duplicate source buffers instead of selecting a potentially stale editor', async () => {
    const saved = withSavedEdit(); const f = appFixture();
    const conflicting = new TestEditor(ORIGINAL + '另一个缓冲的新增');
    f.leaves.push({ view: new MarkdownView(f.file, conflicting) });
    const r = restored(saved.raw, f);
    await expect(r.documents.snapshot(r.controller.currentSession()!.document, 'body')).rejects.toThrow('编辑缓冲不一致');
    await expect(r.controller.apply(r.controller.currentSession()!.candidate!)).rejects.toThrow('编辑缓冲不一致');
    expect(f.editor.transactions).toBe(0); expect(conflicting.transactions).toBe(0);
  });
});
