import { describe, expect, it } from 'vitest';
import { AgentTools } from '../src/agent-tools';
import { agentFixture } from './agent-fixture';
import type { ToolCall } from '../src/types';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call', type: 'function', function: { name, arguments: JSON.stringify({ document_ref: 'doc_opaque', ...args }) } };
}
async function listed(tools: AgentTools) {
  const outcome = await tools.execute(call('list_topic_items', {}));
  return (outcome.data as { topic_items: { topic_ref: string; title: string; available: boolean }[] }).topic_items;
}
async function planned(tools: AgentTools, refs: string[]) {
  return tools.execute(call('plan_topic_selection', { topic_refs: refs, reason: '材料充分、读者问题明确，按质量选择。' }));
}

describe('request-scoped agent tools', () => {
  it('offers only the topic-selection tools and reads metadata without duplicating the article', async () => {
    const f = agentFixture('# 选题\n- [ ] **重复标题** — 第一份资料\n- [ ] **重复标题** — 第二份资料\n'), tools = new AgentTools(f.context('select-topic'), f.services, f.actions);
    expect(tools.definitions().map(item => item.function.name)).toEqual(['read_document', 'list_topic_items', 'plan_topic_selection', 'set_topic_checked', 'reveal_location']);
    for (const definition of tools.definitions()) expect(definition.function.parameters.additionalProperties).toBe(false);
    const first = await listed(tools), second = await listed(tools); expect(first.map(item => item.topic_ref)).toEqual(second.map(item => item.topic_ref));
    expect(first[0]!.topic_ref).not.toBe(first[1]!.topic_ref);
    const read = await tools.execute(call('read_document', {}));
    expect(JSON.stringify(read.data)).not.toContain(f.text()); expect(read.data).not.toHaveProperty('fullText');
    tools.dispose(); expect((await tools.execute(call('read_document', {}))).status).toBe('failed');
  });
  it('marks exactly the referenced duplicate-title item and freezes the one-choice budget', async () => {
    const f = agentFixture('- [ ] 同名\n- [ ] 同名\n'), context = f.context('select-topic'), tools = new AgentTools(context, f.services, f.actions);
    const items = await listed(tools), chosen = items[1]!.topic_ref;
    expect((await planned(tools, [chosen])).status).toBe('success');
    const outcome = await tools.execute(call('set_topic_checked', { topic_ref: chosen, checked: true }));
    expect(outcome).toMatchObject({ status: 'success', data: { title: '同名', checked: true, revealed: true, path: f.document.path } });
    expect(f.text()).toBe('- [ ] 同名\n- [x] 同名\n'); expect(f.services.reveal).toHaveBeenCalledOnce();
    expect((await tools.execute(call('set_topic_checked', { topic_ref: chosen, checked: true }))).status).toBe('noop');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[0]!.topic_ref, checked: true }))).status).toBe('failed');
    expect(f.editor.transactions).toBe(1);
  });
  it('does not turn a failed reveal into a failed write', async () => {
    const f = agentFixture('- [ ] 标题\n'), tools = new AgentTools(f.context('select-topic'), { ...f.services, reveal: async () => { throw new Error('定位暂不可用'); } }, f.actions);
    const item = (await listed(tools))[0]!;
    await planned(tools, [item.topic_ref]);
    expect(await tools.execute(call('set_topic_checked', { topic_ref: item.topic_ref, checked: true }))).toMatchObject({ status: 'success', data: { verified: true, revealed: false, revealReason: '定位暂不可用' } });
    expect(f.text()).toBe('- [x] 标题\n');
  });
  it('rejects role-prompt escalation, foreign references, extra path/offset fields and unchecking', async () => {
    const f = agentFixture('- [ ] 标题\n'), tools = new AgentTools(f.context('discuss'), f.services, f.actions), item = (await listed(tools))[0]!;
    const attempts = [
      call('set_topic_checked', { topic_ref: item.topic_ref, checked: true }),
      call('read_document', { document_ref: 'other_document' }), call('read_document', { path: '其他.md' }),
      call('reveal_location', { target_ref: 'unknown' }), call('replace_text_range', { range_ref: 'unknown', replacement: '越权', from: 0 }),
    ];
    for (const attempt of attempts) expect((await tools.execute(attempt)).status).toBe('failed');
    const allowed = new AgentTools(f.context('select-topic'), f.services, f.actions), ref = (await listed(allowed))[0]!.topic_ref;
    expect((await allowed.execute(call('set_topic_checked', { topic_ref: item.topic_ref, checked: true }))).status).toBe('failed');
    expect((await allowed.execute(call('set_topic_checked', { topic_ref: ref, checked: false }))).status).toBe('failed');
    expect(f.text()).toBe('- [ ] 标题\n'); expect(f.editor.transactions).toBe(0);
  });
  it('replays network-period changes once and keeps source locations correct after further edits', async () => {
    const f = agentFixture('- [ ] 第一项\n- [ ] 第二项\n'), context = f.context('select-topic');
    context.changeChain = [f.edit(0, 0, '# 网络期间新增\n')];
    const tools = new AgentTools(context, f.services, f.actions), items = await listed(tools);
    await planned(tools, [items[1]!.topic_ref]);
    expect(items.every(item => item.available)).toBe(true);
    f.edit(0, 0, '普通前言\n');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[1]!.topic_ref, checked: true }))).status).toBe('success');
    expect(f.text()).toBe('普通前言\n# 网络期间新增\n- [ ] 第一项\n- [x] 第二项\n');
    expect(f.services.reveal).toHaveBeenCalledWith(f.document, f.text().indexOf('- [x]'), f.text().length);
  });
  it('invalidates a changed item without switching to another topic after an attempted selection', async () => {
    const f = agentFixture('- [ ] 第一项\n- [ ] 第二项\n'), tools = new AgentTools(f.context('select-topic'), f.services, f.actions), items = await listed(tools);
    await planned(tools, [items[0]!.topic_ref]);
    f.edit(f.text().indexOf('第一项'), f.text().indexOf('第一项') + 3, '已经变化');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[0]!.topic_ref, checked: true }))).status).toBe('conflict');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[1]!.topic_ref, checked: true }))).status).toBe('failed');
    expect(f.editor.transactions).toBe(0);
  });
  it.each([0, 1, 3, 5])('freezes an adaptive quality-based choice of %s topics without treating five as a quota', async count => {
    const f = agentFixture(Array.from({ length: 6 }, (_, i) => `- [ ] 项目${i + 1}\n`).join('')), context = f.context('select-topic');
    context.topicPolicy = { mode: 'adaptive', min: 0, max: 5 }; context.topicBudget = 5;
    const tools = new AgentTools(context, f.services, f.actions), items = await listed(tools), refs = items.slice(0, count).map(item => item.topic_ref);
    expect(await planned(tools, refs)).toMatchObject({ status: 'success', data: { count } });
    expect(f.editor.transactions).toBe(0);
    for (const ref of refs) expect((await tools.execute(call('set_topic_checked', { topic_ref: ref, checked: true }))).status).toBe('success');
    expect(f.editor.transactions).toBe(count);
    expect((f.text().match(/\[x\]/g) ?? [])).toHaveLength(count);
    expect((await planned(tools, refs)).status).toBe('noop');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[5]!.topic_ref, checked: true }))).status).toBe('failed');
  });
  it('requires a frozen plan and refuses duplicate, foreign, checked or excessive planned references', async () => {
    const f = agentFixture('- [x] 已选\n- [ ] 未选\n'), context = f.context('select-topic');
    context.topicPolicy = { mode: 'adaptive', min: 0, max: 5 };
    const tools = new AgentTools(context, f.services, f.actions), items = await listed(tools), ref = items[1]!.topic_ref;
    expect((await tools.execute(call('set_topic_checked', { topic_ref: ref, checked: true }))).status).toBe('failed');
    expect((await planned(tools, [ref, ref])).status).toBe('failed');
    expect((await planned(tools, ['foreign'])).status).toBe('failed');
    expect((await planned(tools, [items[0]!.topic_ref])).status).toBe('conflict');
    expect((await planned(tools, [ref])).status).toBe('failed');
    expect(f.editor.transactions).toBe(0);
  });
  it('makes an insufficient exact request zero-write and does not silently pick more later', async () => {
    const f = agentFixture('- [ ] 第一项\n- [ ] 第二项\n'), context = f.context('select-topic');
    context.topicPolicy = { mode: 'exact', min: 2, max: 2 }; context.topicBudget = 2;
    const tools = new AgentTools(context, f.services, f.actions), items = await listed(tools);
    expect(await planned(tools, [items[0]!.topic_ref])).toMatchObject({ status: 'conflict', message: expect.stringContaining('本轮没有勾选') });
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[0]!.topic_ref, checked: true }))).status).toBe('conflict');
    expect((await planned(tools, items.map(item => item.topic_ref))).status).toBe('failed');
    expect(f.editor.transactions).toBe(0);
  });
  it('checks all remaining frozen items before each write and preserves completed writes after a conflict', async () => {
    const f = agentFixture('- [ ] 第一项\n- [ ] 第二项\n- [ ] 第三项\n'), context = f.context('select-topic');
    context.topicPolicy = { mode: 'adaptive', min: 0, max: 5 };
    const tools = new AgentTools(context, f.services, f.actions), items = await listed(tools);
    await planned(tools, [items[0]!.topic_ref, items[1]!.topic_ref]);
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[0]!.topic_ref, checked: true }))).status).toBe('success');
    const from = f.text().indexOf('第二项'); f.edit(from, from + 3, '作者修改');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[1]!.topic_ref, checked: true }))).status).toBe('conflict');
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[2]!.topic_ref, checked: true }))).status).toBe('failed');
    expect(f.editor.transactions).toBe(1); expect(f.text()).toContain('- [x] 第一项'); expect(f.text()).toContain('- [ ] 作者修改');
  });
  it('does not write a still-present checkbox after its frozen item changes during persistence', async () => {
    const f = agentFixture('- [ ] 第一项\n'), tools = new AgentTools(f.context('select-topic'), f.services, f.actions), items = await listed(tools);
    await planned(tools, [items[0]!.topic_ref]);
    f.save.mockImplementationOnce(async () => { const from = f.text().indexOf('第一项'); f.edit(from, from + 3, '另一个项目'); });
    expect((await tools.execute(call('set_topic_checked', { topic_ref: items[0]!.topic_ref, checked: true }))).status).toBe('conflict');
    expect(f.editor.transactions).toBe(0); expect(f.text()).toBe('- [ ] 另一个项目\n');
  });
  it('only replaces the authorized range and only inserts at the frozen point', async () => {
    const f = agentFixture('第一句。第二句。'), context = f.context('replace', '第二句。'), tools = new AgentTools(context, f.services, f.actions);
    expect((await tools.execute(call('replace_text_range', { range_ref: 'fake', replacement: '越界' }))).status).toBe('failed');
    expect((await tools.execute(call('replace_text_range', { range_ref: context.rangeRef, replacement: '新句。' }))).status).toBe('success');
    expect(f.text()).toBe('第一句。新句。');
    const insertion = f.context('insert', undefined, '第一句。'.length), next = new AgentTools(insertion, f.services, f.actions);
    expect((await next.execute(call('insert_text', { insertion_ref: insertion.insertionRef, text: '补充。' }))).status).toBe('success');
    expect(f.text()).toBe('第一句。补充。新句。');
  });
  it('keeps proposal output pending and gates undo to a known action in an explicit undo request', async () => {
    const f = agentFixture('原句'), propose = new AgentTools(f.context('propose', '原句'), f.services, f.actions);
    expect((await propose.execute(call('propose_edits', { explanation: '调整表达', replacement: '候选', notes: [] }))).status).toBe('success');
    expect(f.services.propose).toHaveBeenCalledOnce(); expect(f.text()).toBe('原句');
    const replace = f.context('replace', '原句'), tools = new AgentTools(replace, f.services, f.actions);
    const outcome = await tools.execute(call('replace_text_range', { range_ref: replace.rangeRef, replacement: '改后' }));
    expect((await tools.execute(call('undo_action', { action_id: outcome.actionId }))).status).toBe('failed');
    const undo = new AgentTools(f.context('undo'), f.services, f.actions);
    expect((await undo.execute(call('undo_action', { action_id: 'unknown' }))).status).toBe('failed');
    expect((await undo.execute(call('undo_action', { action_id: outcome.actionId }))).status).toBe('success'); expect(f.text()).toBe('原句');
  });
});
