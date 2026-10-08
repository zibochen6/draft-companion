import { vi } from 'vitest';
import { TFile, MarkdownView, TestEditor } from './obsidian-mock';
import { Documents } from '../src/documents';
import { AgentActions } from '../src/agent-actions';
import { hashText, replaceExact } from '../src/editing';
import type { App, WorkspaceLeaf } from 'obsidian';
import type { AgentActionReceipt, AgentIntent, AgentRequestContext, AgentToolServices } from '../src/agent-types';
import type { ChangeKind } from '../src/review-types';

export function agentFixture(initial: string, preview = false) {
  const file = new TFile('文稿.md'), editor = new TestEditor(initial), view = new MarkdownView(file, editor);
  if (preview) view.mode = 'preview';
  const leaf = { view }, disk = new Map([[file.path, initial]]), receipts: AgentActionReceipt[] = [], editing = new Set<string>();
  const app = {
    workspace: { getLeavesOfType: () => [leaf], getMostRecentLeaf: () => leaf },
    vault: { getAbstractFileByPath: (path: string) => path === file.path ? file : undefined,
      read: async () => disk.get(file.path)!, process: vi.fn(async (_file: unknown, callback: (value: string) => string) => { const next = callback(disk.get(file.path)!); disk.set(file.path, next); return next; }) },
  } as unknown as App;
  const documents = new Documents(app, {}); documents.focus(leaf as unknown as WorkspaceLeaf);
  const document = documents.recordFor(file), save = vi.fn(async () => {}), changed = vi.fn();
  const actions = new AgentActions({ documents, receipts: () => receipts, save, changed, editing });
  documents.onChange(change => actions.map(change));
  const text = () => preview ? disk.get(file.path)! : editor.text;
  const services: AgentToolServices = { latest: async () => documents.snapshot(document, 'body'), save, changed,
    propose: vi.fn(async () => {}), reveal: vi.fn(async () => {}), receipts: () => receipts };
  let sequence = 0;
  const context = (intent: AgentIntent, quote?: string, insertAt?: number): AgentRequestContext => {
    const value = text(), from = quote ? value.indexOf(quote) : 0, to = quote ? from + quote.length : value.length;
    const abort = new AbortController();
    return { document, documentRef: 'doc_opaque', intent: { intent }, topicBudget: 1, selectedTopicRefs: new Set(), signal: abort.signal,
      assertActive: () => { if (abort.signal.aborted) throw new Error('已停止'); },
      range: quote ? { from, to, text: quote, valid: true } : undefined, rangeRef: quote ? 'range_opaque' : undefined,
      insertion: insertAt !== undefined ? { from: insertAt, to: insertAt, text: '', valid: true } : undefined, insertionRef: insertAt !== undefined ? 'insert_opaque' : undefined,
      snapshot: { requestId: `request_${++sequence}`, documentId: document.id, sessionId: document.id, path: document.path, fullText: value, hash: hashText(value),
        scope: quote ? 'selection' : 'body', from, to, selectedText: value.slice(from, to), role: { id: 'role', name: '编辑', description: '', systemPrompt: '', defaultMode: 'discuss', quickTasks: [] },
        provider: { id: 'provider', name: '测试', model: 'test', baseUrl: 'https://example.com', secretRef: '', stream: false, timeoutMs: 1000 }, input: '', mode: 'discuss', preferences: '', brief: '', history: [] } };
  };
  const edit = (from: number, to: number, insert: string, kind: ChangeKind = 'edit') => {
    const before = text(), after = replaceExact(before, from, to, insert);
    if (preview) disk.set(file.path, after); else editor.text = after;
    const change = { documentId: document.id, before, after, changes: [{ from, to, insert }], kind };
    documents.observeEditor(file, before, after, change.changes, kind); return change;
  };
  return { app, file, view, editor, disk, document, documents, actions, receipts, save, changed, editing, text, context, services, edit };
}
