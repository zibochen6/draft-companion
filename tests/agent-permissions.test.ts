import { describe, expect, it, vi } from 'vitest';
import { AgentTools } from '../src/agent-tools';
import { agentMessages, runAgent } from '../src/agent-runtime';
import { agentFixture } from './agent-fixture';
import type { ToolCall } from '../src/types';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify({ document_ref: 'doc_opaque', ...args }) } };
}

describe('agent tool visibility and authority', () => {
  it.each([
    ['select-topic', ['read_document', 'list_topic_items', 'plan_topic_selection', 'set_topic_checked', 'reveal_location']],
    ['recommend-topic', ['read_document', 'list_topic_items', 'reveal_location']],
    ['replace', ['read_document', 'replace_text_range', 'reveal_location']],
    ['insert', ['read_document', 'insert_text', 'reveal_location']],
    ['propose', ['read_document', 'propose_edits', 'reveal_location']],
    ['undo', ['read_document', 'reveal_location', 'undo_action']],
    ['discuss', []],
  ] as const)('offers the bounded %s registry', (intent, names) => {
    const f = agentFixture('- [ ] 题目\n');
    const tools = new AgentTools(f.context(intent), f.services, f.actions);
    expect(tools.definitions().map(item => item.function.name)).toEqual(names);
  });

  it('rejects a write tool omitted from a recommendation request without changing the document', async () => {
    const f = agentFixture('- [ ] 题目\n');
    const tools = new AgentTools(f.context('recommend-topic'), f.services, f.actions);
    expect(tools.definitions().map(item => item.function.name)).not.toContain('set_topic_checked');
    const item = ((await tools.execute(call('list_topic_items', {}))).data as { topic_items: { topic_ref: string }[] }).topic_items[0]!;
    await expect(tools.execute(call('set_topic_checked', { topic_ref: item.topic_ref, checked: true }))).resolves.toMatchObject({
      status: 'failed', message: '当前请求没有授权这个操作。',
    });
    expect(f.text()).toBe('- [ ] 题目\n');
    expect(f.editor.transactions).toBe(0);
  });

  it('keeps the document read result small and exposes topic details only as bounded identifiers', async () => {
    const f = agentFixture('- [ ] **题目** — 这里是说明 | https://example.com/source\n');
    const tools = new AgentTools(f.context('select-topic'), f.services, f.actions);
    const read = await tools.execute(call('read_document', {}));
    const listed = await tools.execute(call('list_topic_items', {}));
    expect(JSON.stringify(read.data)).not.toContain('题目');
    expect(JSON.stringify(read.data)).not.toContain('example.com');
    expect(listed.data).toMatchObject({ topic_items: [{ item_index: 1, source_line: 1, title: '题目', checked: false }] });
    expect(JSON.stringify(listed.data)).not.toContain('这里是说明');
    expect(JSON.stringify(listed.data)).not.toContain('example.com');
  });

  it('uses the mapped anchor for a duplicate topic line and omits a line when that target is stale', async () => {
    const f = agentFixture('- [ ] 同名\n- [ ] 同名\n');
    const tools = new AgentTools(f.context('select-topic'), f.services, f.actions);
    f.edit(0, 0, '新增前言\n');
    let listed = (await tools.execute(call('list_topic_items', {}))).data as { topic_items: { source_line?: number; available: boolean }[] };
    expect(listed.topic_items).toMatchObject([
      { source_line: 2, available: true },
      { source_line: 3, available: true },
    ]);
    const target = f.text().indexOf('同名');
    f.edit(target, target + 2, '已变');
    listed = (await tools.execute(call('list_topic_items', {}))).data as { topic_items: { source_line?: number; available: boolean }[] };
    expect(listed.topic_items[0]).toMatchObject({ available: false });
    expect(listed.topic_items[0]).not.toHaveProperty('source_line');
    expect(listed.topic_items[1]).toMatchObject({ source_line: 3, available: true });
  });

  it('gives recommendation and selection calls distinct latest-input instructions', () => {
    const f = agentFixture('- [ ] 题目\n');
    const recommend = agentMessages(f.context('recommend-topic')).map(message => String(message.content)).join('\n');
    const select = agentMessages(f.context('select-topic')).map(message => String(message.content)).join('\n');
    expect(recommend).toContain('只能阅读和定位，绝不调用任何写入工具');
    expect(recommend).not.toContain('再调用 set_topic_checked');
    expect(select).toContain('再调用 set_topic_checked');
    expect(select).toContain('只执行当前用户这一次输入中明确表达的意图');
  });

  it('reports each request and first tool action as progress without re-running a repeated call', async () => {
    const f = agentFixture('- [ ] 题目\n');
    const execute = vi.fn(async () => ({ status: 'success' as const, message: '已读取' }));
    const progress = vi.fn();
    const transport = vi.fn()
      .mockResolvedValueOnce({ text: '', finishReason: 'tool_calls', toolCalls: [call('read_document', {})] })
      .mockResolvedValueOnce({ text: '已完成', finishReason: 'stop' });
    await expect(runAgent(f.context('select-topic'), { definitions: () => [], execute }, 'native', undefined, {
      chunk: () => undefined, outcome: () => undefined, latest: async () => f.text(), progress,
    }, transport)).resolves.toBe('已完成');
    expect(progress.mock.calls.map(([stage]) => stage)).toEqual(['正在请求模型（第1步）…', '正在读取当前文稿…', '正在请求模型（第2步）…']);
    expect(execute).toHaveBeenCalledOnce();
  });
});
