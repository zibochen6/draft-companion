import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, MarkdownView, TestEditor } from './obsidian-mock';
import { Documents } from '../src/documents';
import { Controller } from '../src/controller';
import { Store } from '../src/store';
import type { App, WorkspaceLeaf } from 'obsidian';
import type { ChatMessage, Provider } from '../src/types';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../src/provider', () => ({ chat: chatMock, listModels: vi.fn() }));

function fixture() {
  const a = new TFile('A.md'), b = new TFile('B.md');
  const aEditor = new TestEditor('---\ntitle: 稿件\n---\n原文 中文 😀\n[[双链]]\n![[图.png]]\n```js\n1\n```\n');
  const bEditor = new TestEditor('B 的原文');
  const aView = new MarkdownView(a, aEditor), bView = new MarkdownView(b, bEditor);
  const leaves = [{ view: aView }, { view: bView }];
  const files = new Map([[a.path, a], [b.path, b]]);
  const disk = new Map([[a.path, '旧落盘内容'], [b.path, bEditor.text]]);
  let recent = leaves[0]!;
  const app = {
    workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => recent },
    vault: { getAbstractFileByPath: (path: string) => files.get(path), read: async (file: TFile) => disk.get(file.path)!, process: vi.fn(async (file: TFile, callback: (content: string) => string) => { const next = callback(disk.get(file.path)!); disk.set(file.path, next); return next; }) },
    secretStorage: { getSecret: () => null }
  } as unknown as App;
  const store = new Store(null, async () => {});
  const docs = new Documents(app, store.data.sessions);
  docs.focus(leaves[0] as unknown as WorkspaceLeaf);
  const controller = new Controller(app, store, docs, () => {});
  const provider: Provider = { id: 'p', name: '模拟 Provider', baseUrl: 'http://localhost/v1', secretRef: '', model: '模拟模型', stream: true, timeoutMs: 1000 };
  store.data.providers = [provider]; store.data.activeProviderId = 'p';
  return { app, store, docs, controller, a, b, aEditor, bEditor, aView, bView, leaves, files, disk, setRecent: (index: number) => { recent = leaves[index]!; docs.focus(recent as unknown as WorkspaceLeaf); } };
}
beforeEach(() => { chatMock.mockReset(); });

describe('real controller with simulated Obsidian editor API', () => {
  it.each([
    { text: '', finishReason: 'stop' },
    { text: ' \n\t ', finishReason: 'stop' },
    { text: '', finishReason: 'done' },
    { text: ' \n\t ', finishReason: 'done' },
  ])('fails an empty completed discussion and preserves the prior candidate: %j', async result => {
    const f = fixture(); const original = f.aEditor.text;
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({ explanation: '保留待应用的候选', replacement: '有效候选正文', notes: [] }), finishReason: 'stop' });
    await f.controller.send('先生成候选，暂时不应用', 'edit', 'body');
    const session = f.controller.currentSession()!; const previous = session.candidate!;
    chatMock.mockResolvedValueOnce(result);
    await expect(f.controller.send('继续讨论当前文稿', 'discuss', 'body')).rejects.toThrow('没有返回可用的讨论内容');
    expect(f.controller.running).toBeUndefined();
    expect(session.messages.filter(message => message.role === 'assistant').at(-1)?.status).toBe('failed');
    expect(session.messages.at(-1)?.content).toContain('没有返回可用的讨论内容');
    expect(session.candidate).toBe(previous); expect(previous.state).toBe('ready');
    expect(f.aEditor.text).toBe(original); expect(f.aEditor.transactions).toBe(0);
    expect(chatMock).toHaveBeenCalledTimes(2);
    chatMock.mockResolvedValueOnce({ text: '恢复后的非空讨论。', finishReason: 'stop' });
    await f.controller.send('重新讨论', 'discuss', 'body');
    expect(session.messages.filter(message => message.role === 'assistant').at(-1)?.status).toBe('completed');
    expect(session.candidate).toBe(previous); expect(f.aEditor.text).toBe(original);
  });

  it('keeps malformed edit JSON on the existing failure path without a candidate or document write', async () => {
    const f = fixture(); const original = f.aEditor.text;
    chatMock.mockResolvedValue({ text: '{"replacement":"未闭合', finishReason: 'stop' });
    await expect(f.controller.send('生成改稿', 'edit', 'body')).rejects.toThrow('不是有效 JSON');
    expect(f.controller.currentSession()?.candidate).toBeUndefined();
    expect(f.controller.currentSession()?.messages.find(message => message.role === 'assistant')?.status).toBe('failed');
    expect(f.controller.running).toBeUndefined();
    expect(f.aEditor.text).toBe(original); expect(f.aEditor.transactions).toBe(0);
  });

  it('includes unsaved newest full text once; sidebar focus keeps binding', async () => {
    const f = fixture();
    f.aEditor.text += '尚未落盘的新段落';
    f.docs.focus({ view: {} } as WorkspaceLeaf);
    chatMock.mockImplementation(async (_p: Provider, _key: unknown, messages: ChatMessage[]) => {
      expect(messages.filter(m => m.content.includes('尚未落盘的新段落'))).toHaveLength(1);
      expect(messages.map(m => m.content).join('')).not.toContain('旧落盘内容');
      return { text: '讨论完成', finishReason: 'stop' };
    });
    await f.controller.send('审阅', 'discuss', 'auto');
    expect(f.controller.target()?.path).toBe('A.md');
    expect(f.aEditor.transactions).toBe(0);
  });
  it('pins A, selected role and model across switching; writes only frozen selection', async () => {
    const f = fixture();
    const from = f.aEditor.text.indexOf('原文'), to = f.aEditor.text.indexOf('\n[[双链]]');
    f.aEditor.selection = { anchor: f.aEditor.offsetToPos(from), head: f.aEditor.offsetToPos(to) };
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => started = resolve);
    chatMock.mockImplementation((provider: Provider) => {
      expect(provider.model).toBe('模拟模型'); started();
      return new Promise(resolve => { finish = resolve; });
    });
    const generation = f.controller.send('只改选区', 'edit', 'auto');
    await begun;
    f.setRecent(1); f.store.data.providers[0]!.model = '另一个模型';
    await f.controller.chooseRole(f.store.data.roles[3]!.id);
    f.aEditor.selection = { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } };
    finish({ text: JSON.stringify({ explanation: '改善表达', replacement: '新的 Chinese 🚀\n第二行', notes: ['待核实'] }), finishReason: 'stop' });
    await generation;
    const sessionA = Object.values(f.store.data.sessions).find(s => s.document.path === 'A.md')!;
    expect(f.controller.currentSession()?.messages).toHaveLength(0);
    expect(sessionA.messages.find(m => m.role === 'assistant')?.model).toBe('模拟模型');
    const before = f.aEditor.text;
    await f.controller.apply(sessionA.candidate!);
    expect(f.aEditor.text).toBe(before.slice(0, from) + '新的 Chinese 🚀\n第二行' + before.slice(to));
    expect(f.bEditor.text).toBe('B 的原文');
    await expect(f.controller.apply(sessionA.candidate!)).rejects.toThrow();
    f.setRecent(0);
    await f.controller.undo();
    expect(f.aEditor.text).toBe(before);
  });
  it('blocks modified baselines and undo conflicts', async () => {
    const f = fixture();
    chatMock.mockResolvedValue({ text: JSON.stringify({ explanation: '修改', replacement: '候选正文', notes: [] }), finishReason: 'stop' });
    await f.controller.send('改稿', 'edit', 'body');
    const session = f.controller.currentSession()!;
    f.aEditor.text += '手写新增';
    await expect(f.controller.apply(session.candidate!)).rejects.toThrow('已变化');
    expect(f.aEditor.text).toContain('手写新增');
    await f.controller.send('最新改稿', 'edit', 'body');
    await f.controller.apply(session.candidate!);
    f.aEditor.text += '后续手写';
    await expect(f.controller.undo()).rejects.toThrow();
    expect(f.aEditor.text).toContain('后续手写'); expect(session.undo).toBeDefined();
  });
  it('ignores late completion and chunks after stopping', async () => {
    const f = fixture(); let finish!: (value: unknown) => void; let chunk!: (text: string) => void; let started!: () => void;
    const begun = new Promise<void>(resolve => started = resolve);
    chatMock.mockImplementation((_p: unknown, _k: unknown, _m: unknown, onChunk: typeof chunk) => { chunk = onChunk; started(); return new Promise(resolve => finish = resolve); });
    const pending = f.controller.send('改稿', 'edit', 'body'); await begun;
    f.controller.stop(); chunk('迟到数据'); finish({ text: JSON.stringify({ explanation: '', replacement: '错误覆盖', notes: [] }), finishReason: 'stop' }); await pending;
    expect(f.controller.running).toBeUndefined(); expect(f.controller.currentSession()?.candidate).toBeUndefined();
    expect(f.controller.currentSession()?.messages.find(m => m.role === 'assistant')?.status).toBe('stopped');
    expect(f.aEditor.text).not.toContain('错误覆盖');
  });
  it('uses atomic process in preview and never recreates a deleted original', async () => {
    const f = fixture(); f.aView.mode = 'preview';
    f.disk.set('A.md', '阅读视图中的真实源文');
    await f.controller.deleteRange('body');
    const old = f.controller.currentSession()!;
    await f.controller.apply(old.candidate!);
    expect(f.app.vault.process).toHaveBeenCalledOnce(); expect(f.disk.get('A.md')).toBe('');
    f.docs.deleted(f.a as never); f.files.delete('A.md');
    const replacementFile = new TFile('A.md'); f.files.set('A.md', replacementFile); f.aView.file = replacementFile;
    expect(f.controller.currentSession()?.document.id).not.toBe(old.document.id);
    expect(old.candidate?.state).toBe('stale');
    await expect(f.controller.apply(old.candidate!)).rejects.toThrow();
  });
});

describe('independent provider connection test', () => {
  it.each(['stop', 'done'])('accepts a nonempty response completed with %s without sending article content', async finishReason => {
    const f = fixture();
    chatMock.mockImplementation(async (_provider: Provider, _key: unknown, messages: ChatMessage[]) => {
      expect(messages).toEqual([{ role: 'user', content: '这是连接测试，请简短回复：连接成功。' }]);
      expect(messages[0]!.content).not.toContain(f.aEditor.text);
      return { text: '连接成功。', finishReason };
    });
    await expect(f.controller.testProvider(f.store.data.providers[0]!)).resolves.toBe('连接成功。');
    expect(f.controller.running).toBeUndefined();
    expect(Object.values(f.store.data.sessions)).toHaveLength(0);
    expect(f.aEditor.transactions).toBe(0);
  });

  it.each(['length', 'content_filter', 'tool_calls', 'function_call', ''])('rejects %s as a successful connection test and releases generation state', async finishReason => {
    const f = fixture();
    chatMock.mockResolvedValue({ text: '部分回复', finishReason });
    await expect(f.controller.testProvider(f.store.data.providers[0]!)).rejects.toThrow('连接测试未正常完成');
    expect(f.controller.running).toBeUndefined();
    expect(f.aEditor.transactions).toBe(0);
  });

  it.each(['', ' \n\t '])('rejects empty or whitespace-only completed responses', async text => {
    const f = fixture();
    chatMock.mockResolvedValue({ text, finishReason: 'stop' });
    await expect(f.controller.testProvider(f.store.data.providers[0]!)).rejects.toThrow('没有返回正文');
    expect(f.controller.running).toBeUndefined();
  });

  it('rejects a late successful completion after stopping the connection test', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    let onChunk!: (text: string) => void;
    chatMock.mockImplementation((_p: unknown, _k: unknown, _m: unknown, chunk: typeof onChunk) => {
      onChunk = chunk;
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = f.controller.testProvider(f.store.data.providers[0]!);
    f.controller.stop();
    onChunk('迟到回复');
    finish({ text: '迟到的连接成功', finishReason: 'stop' });
    await expect(pending).rejects.toThrow('测试已停止');
    expect(f.controller.running).toBeUndefined();
    expect(Object.values(f.store.data.sessions)).toHaveLength(0);
  });
});
