import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { Controller } from '../src/controller';
import { Documents } from '../src/documents';
import { Store } from '../src/store';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';
import type { ChatMessage, Provider, ToolCall } from '../src/types';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../src/provider', () => ({ chat: chatMock, listModels: vi.fn() }));

function fixture(text = '---\ntitle: Test\n---\n第一段。\n第二段。\n') {
  const a = new TFile('A.md'), b = new TFile('B.md'); const aEditor = new TestEditor(text), bEditor = new TestEditor('B 原文');
  const leaves = [{ view: new MarkdownView(a, aEditor) }, { view: new MarkdownView(b, bEditor) }]; let recent = leaves[0]!;
  const files = new Map([[a.path, a], [b.path, b]]); const disk = new Map([[a.path, text], [b.path, bEditor.text]]);
  const app = { workspace: { getLeavesOfType: () => leaves, getMostRecentLeaf: () => recent }, vault: { adapter: {}, getAbstractFileByPath: (p: string) => files.get(p), read: async (f: TFile) => disk.get(f.path)!, process: vi.fn() }, secretStorage: { getSecret: () => undefined } } as unknown as App;
  const store = new Store(null, async () => {}); const docs = new Documents(app, store.data.sessions); docs.focus(recent as unknown as WorkspaceLeaf);
  const controller = new Controller(app, store, docs, () => {}); const provider: Provider = { id: 'p', name: 'mock', baseUrl: 'http://mock/v1', secretRef: '', model: 'mock', stream: false, timeoutMs: 1000, toolMode: 'native' };
  store.data.providers = [provider]; store.data.activeProviderId = 'p';
  return { store, docs, controller, a, b, aEditor, bEditor,
    setA() { recent = leaves[0]!; docs.focus(recent as unknown as WorkspaceLeaf); },
    setB() { recent = leaves[1]!; docs.focus(recent as unknown as WorkspaceLeaf); },
  };
}
function ref(messages: ChatMessage[], label: string) { const value = messages[0]!.content!.match(new RegExp(`${label}=([\\w-]+)`))?.[1]; if (!value) throw new Error(`missing ${label}`); return value; }
function call(name: string, args: Record<string, unknown>, id = name): ToolCall { return { id: `call-${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }
function topicCheckCalls(documentRef: string, topicRef: string): ToolCall[] {
  return [call('plan_topic_selection', { document_ref: documentRef, topic_refs: [topicRef], reason: '一个材料充分的独立角度。' }), call('set_topic_checked', { document_ref: documentRef, topic_ref: topicRef, checked: true })];
}
function native(calls: ToolCall[], text = '') { return { text, finishReason: calls.length ? 'tool_calls' : 'stop', ...(calls.length ? { toolCalls: calls } : {}) }; }
beforeEach(() => { chatMock.mockReset(); });

describe('Controller.sendAgent integration', () => {
  it.each([0, 3])('accepts an adaptive complete plan of %s qualifying topics with no quota', async count => {
    const source = '## 选题库\n- [ ] 第一题\n- [ ] 第二题\n- [ ] 第三题\n- [ ] 第四题\n';
    const f = fixture(source); f.store.data.topicLibrary = f.docs.recordFor(f.a);
    let turn = 0;
    chatMock.mockImplementation(async (_p: Provider, _key: unknown, messages: ChatMessage[]) => {
      expect(messages[0]!.content).toContain('选题选择方式=adaptive');
      const documentRef = ref(messages, '文稿引用');
      if (turn++ === 0) return native([call('list_topic_items', { document_ref: documentRef })]);
      if (turn === 2) {
        const items = JSON.parse(messages.find(message => message.role === 'tool')!.content!).data.topic_items as { topic_ref: string }[];
        const refs = items.slice(0, count).map(item => item.topic_ref);
        return native([
          call('plan_topic_selection', { document_ref: documentRef, topic_refs: refs, reason: count ? '三个独立问题均有材料支撑。' : '目前材料不足，零结果，不凑数。' }),
          ...refs.map((topicRef, index) => call('set_topic_checked', { document_ref: documentRef, topic_ref: topicRef, checked: true }, `check-${index}`)),
        ]);
      }
      return native([], count ? '已按材料选择三个独立选题。' : '没有材料充分的选题，本轮没有勾选。');
    });
    await f.controller.sendAgent('帮我选择一些合适的选题');
    expect((f.aEditor.text.match(/\[x\]/g) ?? [])).toHaveLength(count);
    expect(f.controller.agentActions()).toHaveLength(count);
    if (!count) expect(f.aEditor.text).toBe(source);
  });

  it('does not silently reduce an explicit quantity or execute a partial insufficient plan', async () => {
    const source = '## 选题库\n- [ ] 第一题\n- [ ] 第二题\n', f = fixture(source);
    f.store.data.topicLibrary = f.docs.recordFor(f.a); let turn = 0;
    chatMock.mockImplementation(async (_p: Provider, _key: unknown, messages: ChatMessage[]) => {
      expect(messages[0]!.content).toContain('选题选择方式=exact');
      const documentRef = ref(messages, '文稿引用');
      if (turn++ === 0) return native([call('list_topic_items', { document_ref: documentRef })]);
      if (turn === 2) {
        const topicRef = JSON.parse(messages.find(message => message.role === 'tool')!.content!).data.topic_items[0].topic_ref;
        return native(topicCheckCalls(documentRef, topicRef));
      }
      return native([], '只有一个材料充分的选题，未满足两个，本轮没有勾选。');
    });
    await f.controller.sendAgent('帮我选 2 个选题');
    expect(f.aEditor.text).toBe(source); expect(f.controller.agentActions()).toHaveLength(0);
  });
  it.each([
    '帮我选择一些适合的选题来创作公众号。以及同时给我合适的爆款标题参考。',
    '结合爆款选题前置的公式，然后去然后帮我选择一些适合的选题来创作公众号。以及同时给我合适的爆款标题参考。',
  ])('executes natural topic selection without an intent request: %s', async input => {
    const source='## 选题库\n- [ ] **第一题** — 读者问题\n- [ ] **第二题** — 另一个问题\n';
    const f=fixture(source);f.store.data.topicLibrary=f.docs.recordFor(f.a);
    let round=0;
    chatMock.mockImplementation(async (_p:Provider,_k:unknown,messages:ChatMessage[],_chunk:unknown,_signal:unknown,options:{tools?:{function:{name:string}}[]} | undefined)=>{
      expect(options?.tools).toBeDefined();
      expect(messages[0]!.content).toContain('当前意图=select-topic');
      expect(messages[0]!.content).toContain('选题数量上限=5');
      expect(options!.tools!.map(t=>t.function.name)).not.toContain('replace_text_range');
      const documentRef=ref(messages,'文稿引用');
      if(round++===0)return native([call('list_topic_items',{document_ref:documentRef})]);
      if(round===2){
        const items=JSON.parse(messages.find(m=>m.role==='tool')!.content!).data.topic_items;
        return native(topicCheckCalls(documentRef, items[0].topic_ref));
      }
      return native([],'首推标题：把读者的问题写清楚。备选标题：A、B、C、D。');
    });
    await f.controller.sendAgent(input,{task:'auto'});
    expect(f.aEditor.text).toBe(source.replace('[ ] **第一题**','[x] **第一题**'));
    expect(f.controller.agentActions()).toHaveLength(1);
    expect(chatMock).toHaveBeenCalledTimes(3);
    await f.controller.undoAgentAction(f.controller.agentActions()[0]!.id);
    expect(f.aEditor.text).toBe(source);
  });

  it('reports the timed-out stage and keeps completed topic writes from being replayed',async()=>{
    const f=fixture('## 选题库\n- [ ] 第一题\n- [ ] 第二题\n');f.store.data.topicLibrary=f.docs.recordFor(f.a);
    const input='帮我选择一些适合的选题';let turn=0;
    chatMock.mockImplementation(async(_p:Provider,_k:unknown,messages:ChatMessage[])=>{
      const documentRef=ref(messages,'文稿引用');
      if(turn++===0)return native([call('list_topic_items',{document_ref:documentRef})]);
      if(turn===2){const topicRef=JSON.parse(messages.find(m=>m.role==='tool')!.content!).data.topic_items[0].topic_ref;return native(topicCheckCalls(documentRef, topicRef));}
      throw Object.assign(new Error('private transport details'),{kind:'timeout',diagnostics:{code:'request_timeout'}});
    });
    await expect(f.controller.sendAgent(input)).rejects.toThrow('第3步');
    expect(f.aEditor.text).toContain('[x] 第一题');expect(f.controller.agentActions()).toHaveLength(1);
    expect(f.controller.currentSession()!.messages.at(-1)!.content).toContain('已完成修改保留');
    expect(f.controller.currentSession()!.messages.at(-1)!.content).not.toContain('private transport details');
    chatMock.mockClear();await expect(f.controller.sendAgent(input)).rejects.toThrow('同一要求不会重复写入');
    expect(chatMock).not.toHaveBeenCalled();expect(f.aEditor.text).toContain('[ ] 第二题');
  });

  it('distinguishes a service timeout from expiration of the configured local timer',async()=>{
    const f=fixture('## 选题库\n- [ ] 第一题\n');f.store.data.topicLibrary=f.docs.recordFor(f.a);
    chatMock.mockRejectedValue(Object.assign(new Error('服务未在时限内完成请求，请稍后重试或检查超时配置。'),{kind:'timeout',diagnostics:{httpStatus:504,code:'http_504'}}));
    await expect(f.controller.sendAgent('帮我选择一些适合的选题')).rejects.toThrow('服务返回超时');
    expect(f.controller.currentSession()!.messages.at(-1)!.content).not.toContain('本服务配置的');
    expect(f.aEditor.text).toContain('[ ] 第一题');expect(f.controller.agentActions()).toHaveLength(0);
  });

  it('freezes A selection, role, and provider for an intent-classified review after switching to B', async () => {
    const f = fixture(); const aDoc = f.docs.recordFor(f.a), aSession = f.store.sessionFor(aDoc);
    const from = f.aEditor.text.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    const originalRole = f.store.data.roles.find(role => role.id === aSession.selectedRoleId)!;
    const bRole = { ...originalRole, id: 'b-role', name: 'B 专属角色' };
    const bProvider: Provider = { ...f.store.data.providers[0]!, id: 'b-provider', name: 'B 服务', model: 'b-model' };
    f.store.data.roles.push(bRole); f.store.data.providers.push(bProvider);
    let request = 0;
    chatMock.mockImplementation(async () => {
      if (request++ === 0) {
        f.setB(); const bSession = f.controller.currentSession()!;
        bSession.selectedRoleId = bRole.id; f.store.data.activeProviderId = bProvider.id;
        return { text: '{"intent":"review"}', finishReason: 'stop' };
      }
      return { text: '{"summary":"A 的冻结选区审阅。","overall":[],"suggestions":[]}', finishReason: 'stop' };
    });
    await f.controller.sendAgent('请审阅选区', { task: 'auto', scope: 'auto' });
    const aReview = f.store.data.sessions[aDoc.id]!.review!.runs.at(-1)!;
    const bSession = f.store.data.sessions[f.docs.recordFor(f.b).id]!;
    expect(aReview).toMatchObject({ documentId: aDoc.id, path: 'A.md', model: 'mock', providerName: 'mock', scope: 'selection', selection: '第一段。' });
    expect(aReview.author.name).toBe(originalRole.name);
    expect(aReview.snapshot).toBe(f.aEditor.text);
    expect(bSession.review).toBeUndefined(); expect(bSession.candidate).toBeUndefined();
    expect(f.controller.target()?.id).toBe(f.docs.recordFor(f.b).id);
  });

  it('freezes A selection, role, and provider for an intent-classified proposal after switching to B', async () => {
    const f = fixture(); const aDoc = f.docs.recordFor(f.a), aSession = f.store.sessionFor(aDoc);
    const from = f.aEditor.text.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    const originalRole = f.store.data.roles.find(role => role.id === aSession.selectedRoleId)!;
    const bRole = { ...originalRole, id: 'b-role', name: 'B 专属角色' };
    const bProvider: Provider = { ...f.store.data.providers[0]!, id: 'b-provider', name: 'B 服务', model: 'b-model' };
    f.store.data.roles.push(bRole); f.store.data.providers.push(bProvider);
    let request = 0;
    chatMock.mockImplementation(async () => {
      if (request++ === 0) {
        f.setB(); const bSession = f.controller.currentSession()!;
        bSession.selectedRoleId = bRole.id; f.store.data.activeProviderId = bProvider.id;
        return { text: '{"intent":"propose"}', finishReason: 'stop' };
      }
      return { text: '{"explanation":"冻结 A 选区。","replacement":"候选新首段。","notes":[]}', finishReason: 'stop' };
    });
    await f.controller.sendAgent('请先给出选区改法', { task: 'auto', scope: 'auto' });
    const candidate = f.store.data.sessions[aDoc.id]!.candidate!;
    const bSession = f.store.data.sessions[f.docs.recordFor(f.b).id]!;
    expect(candidate).toMatchObject({ documentId: aDoc.id, path: 'A.md', scope: 'selection', baseline: f.aEditor.text, replacement: '候选新首段。', state: 'ready' });
    expect(candidate.from).toBe(from); expect(candidate.to).toBe(to);
    expect(bSession.review).toBeUndefined(); expect(bSession.candidate).toBeUndefined();
    expect(f.controller.target()?.id).toBe(f.docs.recordFor(f.b).id);
  });

  it('blocks a repeated topic command from A after B wrote once and its final continuation failed', async () => {
    const f = fixture(); const input = '帮我选一个并勾选';
    f.bEditor.text = '# 合成选题库\n- [ ] 第一题\n- [ ] 第二题\n';
    const library = f.docs.recordFor(f.b); f.store.data.topicLibrary = library;
    let turn = 0;
    chatMock.mockImplementation(async (_provider: Provider, _key: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"select-topic"}', finishReason: 'stop' };
      const documentRef = ref(messages, '文稿引用');
      if (turn++ === 0) return native([call('list_topic_items', { document_ref: documentRef })]);
      if (turn === 2) {
        const listed = JSON.parse(messages.find(message => message.role === 'tool')!.content!).data.topic_items as { topic_ref: string }[];
        return native(topicCheckCalls(documentRef, listed[0]!.topic_ref));
      }
      throw new Error('最终续问失败');
    });
    await expect(f.controller.sendAgent(input)).rejects.toThrow('最终续问失败');
    const topicSession = f.store.data.sessions[library.id]!;
    expect(f.bEditor.text).toContain('- [x] 第一题'); expect(topicSession.agentActions).toHaveLength(1);
    f.setA(); chatMock.mockClear();
    await expect(f.controller.sendAgent(input)).rejects.toThrow('同一要求不会重复写入');
    expect(chatMock).not.toHaveBeenCalled();
    expect(f.bEditor.text).toContain('- [x] 第一题'); expect(f.bEditor.text).toContain('- [ ] 第二题');
    expect(topicSession.agentActions).toHaveLength(1);
  });

  it('shows the bound topic library session and its undo receipt when starting from an ordinary article', async () => {
    const f = fixture(); const article = f.aEditor.text;
    f.bEditor.text = '# 合成选题库\n- [ ] 第一题\n- [ ] 第二题\n';
    const library = f.docs.recordFor(f.b); f.store.data.topicLibrary = library;
    let round = 0;
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"select-topic"}', finishReason: 'stop' };
      const documentRef = ref(messages, '文稿引用');
      if (round++ === 0) return native([call('list_topic_items', { document_ref: documentRef })]);
      if (round === 2) {
        const result = messages.find(message => message.role === 'tool')!;
        const topicRef = JSON.parse(result.content!).data.topic_items[0].topic_ref;
        return native(topicCheckCalls(documentRef, topicRef));
      }
      return native([], '已勾选第一题，标题和理由仅在侧栏。');
    });
    await f.controller.sendAgent('帮我选一个并勾选');
    expect(f.aEditor.text).toBe(article); expect(f.bEditor.text).toContain('- [x] 第一题');
    expect(f.controller.target()?.id).toBe(library.id);
    expect(f.controller.currentSession()!.agentActions).toHaveLength(1);
    expect(f.controller.currentSession()!.messages.at(-1)?.content).toContain('已勾选第一题');
  });

  it('selects exactly one topic through list/read/write tool rounds and returns natural feedback', async () => {
    const f = fixture('## 选题\n- [ ] **第一题** — 角度一\n- [ ] **第二题** — 角度二\n');
    let turn = 0;
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"select-topic","count":1}', finishReason: 'stop' };
      const documentRef = ref(messages, '文稿引用'); const toolMessages = messages.filter(message => message.role === 'tool');
      if (turn++ === 0) return native([call('list_topic_items', { document_ref: documentRef })]);
      if (turn === 2) {
        const topicRef = (JSON.parse(toolMessages[0]!.content!).data.topic_items as { topic_ref: string }[])[0]!.topic_ref;
        return native(topicCheckCalls(documentRef, topicRef));
      }
      return native([], '已选择第一题。切入角度：从真实问题开始。首推标题：第一题怎么写。备选：A、B、C、D。');
    });
    await f.controller.sendAgent('帮我选一个并勾选', { task: 'topic' });
    expect(f.aEditor.text).toContain('- [x] **第一题**'); expect(f.aEditor.text).toContain('- [ ] **第二题**');
    expect(f.controller.currentSession()!.agentActions).toHaveLength(1);
    const finalReply = f.controller.currentSession()!.messages.filter(message => message.role === 'assistant').at(-1);
    expect(finalReply?.content).toContain('首推标题');
  });

  it('keeps recommendations and legacy JSON discussion read-only', async () => {
    const f = fixture('## 选题\n- [ ] 第一题\n'); const before = f.aEditor.text;
    chatMock.mockResolvedValueOnce(native([], '只推荐：第一题。'));
    await f.controller.sendAgent('只推荐，不要勾选', { task: 'topic' }); expect(f.aEditor.text).toBe(before);
    chatMock.mockResolvedValueOnce({ text: '{"explanation":"旧 JSON","replacement":"越权","notes":[]}', finishReason: 'stop' });
    await f.controller.sendAgent('解释这个 JSON', { task: 'discuss' }); expect(f.aEditor.text).toBe(before);
  });

  it('keeps an explicit recommendation-only request read-only without asking a classifier for permission', async () => {
    const f = fixture('## 选题\n- [ ] 第一题\n'); const before = f.aEditor.text;
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"select-topic","count":1}', finishReason: 'stop' };
      expect(messages[0]!.content).toContain('当前意图=recommend-topic');
      return native([], '只推荐第一题，没有勾选。');
    });
    await f.controller.sendAgent('只推荐，不要勾选', { task: 'topic' });
    expect(f.aEditor.text).toBe(before); expect(f.controller.agentActions()).toHaveLength(0);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0]![5]).toHaveProperty('tools');
  });

  it('keeps a selected ordinary JSON discussion read-only when its classifier asks to replace', async () => {
    const f = fixture(); const from = f.aEditor.text.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to)); const before = f.aEditor.text;
    let request = 0;
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (request++ === 0) return { text: '{"intent":"replace","quote":"第一段。"}', finishReason: 'stop' };
      expect(options).toBeUndefined();
      return { text: '这是 JSON 字段的解释，没有修改正文。', finishReason: 'stop' };
    });
    await f.controller.sendAgent('请解释 JSON 里“第一段。”是什么意思', { task: 'auto', scope: 'auto' });
    expect(f.aEditor.text).toBe(before); expect(f.controller.agentActions()).toHaveLength(0);
  });

  it('caps a malicious eight-topic classification to the one topic the user asked to select', async () => {
    const f = fixture('## 选题\n- [ ] 第一题\n- [ ] 第二题\n'); let round = 0;
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"select-topic","count":8}', finishReason: 'stop' };
      expect(messages[0]!.content).toContain('选题数量上限=1');
      const documentRef = ref(messages, '文稿引用'); const toolMessages = messages.filter(message => message.role === 'tool');
      if (round++ === 0) return native([call('list_topic_items', { document_ref: documentRef })]);
      if (round === 2) {
        const topics = JSON.parse(toolMessages[0]!.content!).data.topic_items as { topic_ref: string }[];
        return native([
          call('plan_topic_selection', { document_ref: documentRef, topic_refs: [topics[0]!.topic_ref], reason: '只允许用户要求的一项。' }),
          call('set_topic_checked', { document_ref: documentRef, topic_ref: topics[0]!.topic_ref, checked: true }, 'first-topic'),
          call('set_topic_checked', { document_ref: documentRef, topic_ref: topics[1]!.topic_ref, checked: true }, 'second-topic'),
        ]);
      }
      return native([], '已只勾选用户要求的一项。');
    });
    await f.controller.sendAgent('帮我选一个并勾选', { task: 'topic' });
    expect(f.aEditor.text).toContain('- [x] 第一题'); expect(f.aEditor.text).toContain('- [ ] 第二题');
    expect(f.controller.agentActions()).toHaveLength(1);
  });

  it('writes only a frozen selection and undo keeps unrelated manual text', async () => {
    const f = fixture(); const from = f.aEditor.text.indexOf('第一段'), to = from + '第一段。'.length; f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _s: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"replace"}', finishReason: 'stop' };
      const doc = ref(messages, '文稿引用'), range = ref(messages, '授权范围引用');
      return messages.some(message => message.role === 'tool') ? native([], '已完成。') : native([call('replace_text_range', { document_ref: doc, range_ref: range, replacement: '新第一段。', label: '替换首段' })]);
    });
    await f.controller.sendAgent('直接修改选区', { task: 'auto', scope: 'auto' });
    f.aEditor.text += '作者后记'; f.docs.observeEditor(f.a, f.aEditor.text.slice(0, -4), f.aEditor.text, [{ from: f.aEditor.text.length - 4, to: f.aEditor.text.length - 4, insert: '作者后记' }]);
    await f.controller.undoAgentAction(f.controller.agentActions()[0]!.id);
    expect(f.aEditor.text).toContain('第一段。'); expect(f.aEditor.text).toContain('作者后记');
  });

  it('keeps the initial document and rejects a stopped late tool call before write', async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    chatMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = f.controller.sendAgent('直接修改“第一段。”', { task: 'auto' }); await Promise.resolve();
    f.aEditor.text = f.aEditor.text.replace('第一段。', '作者手工改写。'); f.setB(); f.controller.stop();
    resolve({ text: '{"intent":"replace","quote":"第一段。"}', finishReason: 'stop' }); await pending;
    expect(f.aEditor.text).toContain('作者手工改写。'); expect(f.bEditor.text).toBe('B 原文'); expect(f.controller.agentActions()).toHaveLength(0);
  });

  it('clears the confirmation-time session after switching documents and a stopped late reply cannot restore it', async () => {
    const f = fixture(); const aSession = f.controller.currentSession()!;
    const bSession = f.store.sessionFor(f.docs.recordFor(f.b));
    bSession.brief = '保留 B 的本文要求'; bSession.messages.push({ id: 'b-history', role: 'user', content: 'B 的历史', at: 1 });
    aSession.brief = '保留 A 的本文要求'; aSession.undo = { documentId: aSession.document.id, path: 'A.md', before: '第一段。', from: 0, to: 0, replacement: '', candidateId: 'old' };
    aSession.agentActions = [{ id: 'action-a', requestId: 'old-request', documentId: aSession.document.id, path: 'A.md', at: 1, kind: 'replace', label: '旧操作', before: '第一段。', replacement: '新第一段。', anchor: { from: 0, to: 0, text: '', valid: true }, beforeHash: 'before', afterHash: 'after', state: 'applied' }];
    let resolve!: (value: { text: string; finishReason: string }) => void;
    chatMock.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = f.controller.send('等待迟到回复', 'discuss', 'body');
    while (!resolve) await Promise.resolve();
    f.setB();
    await f.controller.clearSession(aSession.id);
    resolve({ text: '迟到的回复不能回到已清空会话。', finishReason: 'stop' });
    await pending;

    expect(aSession.messages).toEqual([]);
    expect(aSession.brief).toBe('保留 A 的本文要求'); expect(aSession.undo?.candidateId).toBe('old'); expect(aSession.agentActions).toHaveLength(1);
    expect(bSession).toMatchObject({ brief: '保留 B 的本文要求', messages: [{ id: 'b-history', content: 'B 的历史' }] });
    expect(f.controller.currentSession()?.id).toBe(bSession.id);
  });

  it('maps an unrelated edit made during intent classification and still writes only the frozen original document', async () => {
    const f = fixture(); const initial = f.aEditor.text;
    const from = initial.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) {
        f.aEditor.text = `${f.aEditor.text}手工附注。`;
        f.docs.observeEditor(f.a, initial, f.aEditor.text, [{ from: initial.length, to: initial.length, insert: '手工附注。' }]);
        f.setB();
        return { text: '{"intent":"replace"}', finishReason: 'stop' };
      }
      const documentRef = ref(messages, '文稿引用'), rangeRef = ref(messages, '授权范围引用');
      return messages.some(message => message.role === 'tool')
        ? native([], '已在原文档完成指定替换。')
        : native([call('replace_text_range', { document_ref: documentRef, range_ref: rangeRef, replacement: '模型改写首段。', label: '改写首段' })]);
    });
    await f.controller.sendAgent('改写第一段', { task: 'auto', scope: 'auto' });
    expect(f.aEditor.text).toContain('模型改写首段。');
    expect(f.aEditor.text).toContain('手工附注。');
    expect(f.bEditor.text).toBe('B 原文');
    expect(f.store.data.sessions[f.docs.recordFor(f.a).id]!.agentActions).toHaveLength(1);
  });

  it('invalidates a late native tool result when stopped before the write', async () => {
    const f = fixture(); const from = f.aEditor.text.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    let resolveTools!: (value: unknown) => void;
    chatMock.mockImplementation((_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return Promise.resolve({ text: '{"intent":"replace"}', finishReason: 'stop' });
      if (!messages.some(message => message.role === 'tool')) return new Promise(resolve => { resolveTools = resolve; });
      return Promise.resolve(native([], '不应抵达最终反馈。'));
    });
    const pending = f.controller.sendAgent('改写第一段', { task: 'auto', scope: 'auto' });
    while (!resolveTools) await Promise.resolve();
    f.controller.stop();
    resolveTools(native([call('replace_text_range', { document_ref: 'anything', range_ref: 'anything', replacement: '迟到写入', label: '迟到' })]));
    await pending;
    expect(f.aEditor.text).toContain('第一段。');
    expect(f.aEditor.text).not.toContain('迟到写入');
    expect(f.controller.agentActions()).toHaveLength(0);
  });

  it('retains a completed write when the final follow-up fails and rejects an identical retry', async () => {
    const f = fixture(); const from = f.aEditor.text.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: unknown) => {
      if (!options) return { text: '{"intent":"replace"}', finishReason: 'stop' };
      const documentRef = ref(messages, '文稿引用'), rangeRef = ref(messages, '授权范围引用');
      if (!messages.some(message => message.role === 'tool')) return native([call('replace_text_range', { document_ref: documentRef, range_ref: rangeRef, replacement: '已写入的新首段。', label: '写入首段' })]);
      throw new Error('最终反馈连接中断');
    });
    const input = '改写第一段并说明';
    await expect(f.controller.sendAgent(input, { task: 'auto', scope: 'auto' })).rejects.toThrow('最终反馈连接中断');
    expect(f.aEditor.text).toContain('已写入的新首段。');
    expect(f.controller.agentActions()).toHaveLength(1);
    expect(f.controller.currentSession()!.messages.filter(message => message.role === 'event').at(-1)?.content).toContain('已完成修改保留');
    await expect(f.controller.sendAgent(input, { task: 'auto', scope: 'auto' })).rejects.toThrow('同一要求不会重复写入');
    expect(f.controller.agentActions()).toHaveLength(1);
  });

  it('probes auto tool protocol once, caches it, and uses the native result thereafter', async () => {
    const f = fixture(); f.store.data.providers[0]!.toolMode = 'auto';
    const from = f.aEditor.text.indexOf('第一段。'), to = from + '第一段。'.length;
    f.aEditor.setSelection(f.aEditor.offsetToPos(from), f.aEditor.offsetToPos(to));
    let probes = 0;
    chatMock.mockImplementation(async (_p: Provider, _k: unknown, messages: ChatMessage[], _chunk: unknown, _signal: unknown, options: { toolChoice?: unknown } | undefined) => {
      if (!options) return { text: '{"intent":"replace"}', finishReason: 'stop' };
      if (typeof options.toolChoice === 'object') {
        probes++;
        return native([call('protocol_probe', { value: 'ok' })]);
      }
      const documentRef = ref(messages, '文稿引用'), rangeRef = ref(messages, '授权范围引用');
      return messages.some(message => message.role === 'tool')
        ? native([], '已完成。')
        : native([call('replace_text_range', { document_ref: documentRef, range_ref: rangeRef, replacement: '第一次改写。', label: '第一次' })]);
    });
    await f.controller.sendAgent('第一次改写', { task: 'auto', scope: 'auto' });
    expect(probes).toBe(1);
    expect(Object.values(f.store.data.toolCapabilities ?? {})).toEqual(['native']);

    f.aEditor.setSelection(f.aEditor.offsetToPos(f.aEditor.text.indexOf('第二段。')), f.aEditor.offsetToPos(f.aEditor.text.indexOf('第二段。') + '第二段。'.length));
    await f.controller.sendAgent('第二次改写', { task: 'auto', scope: 'auto' });
    expect(probes).toBe(1);
  });
});
