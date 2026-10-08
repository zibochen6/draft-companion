import { describe, expect, it } from 'vitest';
import { AgentActions } from '../src/agent-actions';
import { hashText } from '../src/editing';
import { agentFixture } from './agent-fixture';

describe('AgentActions local writes and receipts', () => {
  it('maps the frozen selection, writes only it, and undoes after unrelated edits', async () => {
    const original = `${'前'.repeat(50)}\n原句\n${'后'.repeat(50)}`;
    const f = agentFixture(original), context = f.context('replace', '原句'); f.actions.trackContext(context);
    f.edit(0, 0, '无关前缀\n');
    expect(context.range!.from).toBe(original.indexOf('原句') + 5);
    const outcome = await f.actions.apply(context, context.range!, '改后的句子', '替换原句', 'replace');
    expect(outcome.status).toBe('success'); expect(outcome.data).toMatchObject({ verified: true, path: f.document.path });
    expect(f.text()).toBe(`无关前缀\n${original.replace('原句', '改后的句子')}`);
    f.edit(f.text().length, f.text().length, '\n后续无关修改');
    expect(f.actions.canUndo(f.document, outcome.actionId!)).toBe(true);
    expect((await f.actions.undo(f.document, outcome.actionId!)).status).toBe('success');
    expect(f.text()).toBe(`无关前缀\n${original}\n后续无关修改`);
    expect((await f.actions.undo(f.document, outcome.actionId!)).status).toBe('noop');
  });
  it('does not repeat replacement or insertion within one request', async () => {
    const f = agentFixture('前 原句 后'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('success');
    expect((await f.actions.apply(context, context.range!, '重复改写', '替换', 'replace')).status).toBe('noop');
    expect(f.editor.transactions).toBe(1); expect(f.text()).toBe('前 改后 后');
    const insert = f.context('insert', undefined, f.text().length); f.actions.trackContext(insert);
    const outcome = await f.actions.apply(insert, insert.insertion!, '附录', '插入', 'insert');
    expect(outcome.status).toBe('success');
    expect((await f.actions.apply(insert, insert.insertion!, '附录', '插入', 'insert')).status).toBe('noop');
    expect(f.text()).toBe('前 改后 后附录');
    expect((await f.actions.undo(f.document, outcome.actionId!)).status).toBe('success');
    expect(f.text()).toBe('前 改后 后');
  });
  it.each(['replacement', 'context'])('invalidates an overlapping %s edit and never searches for another matching quote', async changed => {
    const f = agentFixture('前 原句 后\n另一个原句'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    const outcome = await f.actions.apply(context, context.range!, '改后', '替换', 'replace');
    const at = changed === 'replacement' ? f.text().indexOf('改后') : 0;
    f.edit(at, at + 1, '变');
    expect(f.receipts[0]!.state).toBe('needs-check');
    expect(f.actions.canUndo(f.document, outcome.actionId!)).toBe(false);
    expect((await f.actions.undo(f.document, outcome.actionId!)).status).toBe('conflict');
    expect(f.text()).toContain('另一个原句');
  });
  it('stops after preparing the receipt and also at the final synchronous host validation', async () => {
    const f = agentFixture('原句'), context = f.context('replace', '原句'); let active = true;
    context.assertActive = () => { if (!active) throw new Error('已停止'); }; f.actions.trackContext(context);
    f.save.mockImplementationOnce(async () => { active = false; });
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('failed');
    expect(f.editor.transactions).toBe(0); expect(f.text()).toBe('原句');
    const g = agentFixture('原句'), next = g.context('replace', '原句'); let running = true;
    next.assertActive = () => { if (!running) throw new Error('已停止'); }; g.actions.trackContext(next);
    g.app.vault.read = async () => { running = false; return '原句'; };
    expect((await g.actions.apply(next, next.range!, '改后', '替换', 'replace')).status).toBe('failed');
    expect(g.editor.transactions).toBe(0); expect(g.text()).toBe('原句');
  });
  it('preserves an existing write lock and blocks a stale target after an unknown external change', async () => {
    const f = agentFixture('原句'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    f.editing.add(f.document.id);
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('conflict');
    expect(f.editing.has(f.document.id)).toBe(true); f.editing.clear();
    f.editor.text = '外部新增原句';
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('conflict');
    expect(f.editor.transactions).toBe(0);
  });
  it('rejects an old untracked authorization even if another identical quote occupies its old offset', async () => {
    const f = agentFixture('相同句\n相同句'), old = f.context('replace', '相同句');
    f.edit(0, 0, '相同句\n');
    f.actions.trackContext(old);
    expect((await f.actions.apply(old, old.range!, '不应修改', '替换', 'replace')).status).toBe('conflict');
    expect(f.text()).toBe('相同句\n相同句\n相同句');
    const current = f.context('replace', '相同句'); f.actions.trackContext(current);
    expect((await f.actions.apply(current, current.range!, '新请求已授权', '替换', 'replace')).status).toBe('success');
  });
  it('blocks a failed intent save before writing and reports a verified write despite a final save failure', async () => {
    const f = agentFixture('原句'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    f.save.mockRejectedValueOnce(new Error('存储失败'));
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('failed');
    expect(f.text()).toBe('原句'); expect(f.editor.transactions).toBe(0);
    const g = agentFixture('原句'), next = g.context('replace', '原句'); g.actions.trackContext(next);
    g.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('存储失败'));
    const outcome = await g.actions.apply(next, next.range!, '改后', '替换', 'replace');
    expect(outcome).toMatchObject({ status: 'success', data: { verified: true, persistenceWarning: true } });
    expect(g.text()).toBe('改后'); expect(g.receipts[0]!.state).toBe('applied');
    expect((await g.actions.apply(next, next.range!, '改后', '替换', 'replace')).status).toBe('noop');
    expect(g.editor.transactions).toBe(1);
  });
  it('verifies actual host content after writing instead of assuming the computed result was saved', async () => {
    const f = agentFixture('原句'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    const apply = f.documents.applyRangeValidated.bind(f.documents);
    f.documents.applyRangeValidated = async (...args) => { await apply(...args); f.editor.text = '宿主实际不同内容'; };
    const outcome = await f.actions.apply(context, context.range!, '改后', '替换', 'replace');
    expect(outcome).toMatchObject({ status: 'conflict', data: { wrote: true, verified: false } });
    expect(outcome.actionId).toBe(f.receipts[0]!.id); expect(f.receipts[0]!.state).toBe('needs-check');
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('conflict');
    expect(f.editor.transactions).toBe(1);
  });
  it('requires whole-document hash verification at restart and invalidates unknown external changes', async () => {
    const f = agentFixture('前 原句 后'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    const outcome = await f.actions.apply(context, context.range!, '改后', '替换', 'replace');
    const restored = new AgentActions({ documents: f.documents, receipts: () => f.receipts, save: f.save, changed: f.changed, editing: f.editing });
    expect(restored.canUndo(f.document, outcome.actionId!)).toBe(true);
    f.editor.text += '\n未观察到的外部变更';
    expect(restored.canUndo(f.document, outcome.actionId!)).toBe(false);
    expect(f.receipts[0]!.state).toBe('needs-check');
    const g = agentFixture('前 原句 后'), next = g.context('replace', '原句'); g.actions.trackContext(next);
    const second = await g.actions.apply(next, next.range!, '改后', '替换', 'replace');
    g.editor.text += '\n原局部仍相同但全文不同';
    const restart = new AgentActions({ documents: g.documents, receipts: () => g.receipts, save: g.save, changed: g.changed, editing: g.editing });
    expect(restart.canUndo(g.document, second.actionId!)).toBe(false);
  });
  it('cannot use the first post-restart transaction to legitimize an unverified prior version', async () => {
    const f = agentFixture('前 原句 后'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    await f.actions.apply(context, context.range!, '改后', '替换', 'replace');
    const restart = new AgentActions({ documents: f.documents, receipts: () => f.receipts, save: f.save, changed: f.changed, editing: f.editing });
    const before = f.text() + '\n未记录的外部变更', after = before + '\n正常事务';
    restart.map({ documentId: f.document.id, before, after, changes: [{ from: before.length, to: before.length, insert: '\n正常事务' }], kind: 'edit' });
    expect(f.receipts[0]!.state).toBe('needs-check'); expect(f.receipts[0]!.anchor.valid).toBe(false);
  });
  it('keeps CRLF and NBSP unchanged around an atomic preview-mode checkbox edit', async () => {
    const source = '# 选题\r\n- [\u00a0] 标题\r\n', f = agentFixture(source, true), context = f.context('select-topic');
    f.actions.trackContext(context);
    const from = source.indexOf('\u00a0'), target = { from, to: from + 1, text: '\u00a0', valid: true };
    f.actions.trackAnchor(f.document.id, target);
    const outcome = await f.actions.apply(context, target, 'x', '勾选', 'topic-check');
    expect(outcome.status).toBe('success'); expect(f.text()).toBe(source.replace('\u00a0', 'x'));
    expect((await f.actions.undo(f.document, outcome.actionId!)).status).toBe('success');
    expect(f.text()).toBe(source); expect(f.editor.transactions).toBe(0);
  });
  it('reconciles proven native undo and redo while rejecting an invalid transaction chain', async () => {
    const f = agentFixture('前 原句 后'), context = f.context('replace', '原句'); f.actions.trackContext(context);
    const outcome = await f.actions.apply(context, context.range!, '共享前缀 新中间 共享后缀', '替换', 'replace');
    const receipt = f.receipts[0]!;
    f.edit(receipt.anchor.from, receipt.anchor.to, '原句', 'undo');
    expect(receipt.state).toBe('undone'); expect(receipt.beforeHash).toBe(hashText(f.text()));
    f.edit(receipt.anchor.from, receipt.anchor.to, receipt.replacement, 'redo');
    expect(receipt.state).toBe('applied'); expect(f.actions.canUndo(f.document, outcome.actionId!)).toBe(true);
    f.actions.map({ documentId: f.document.id, before: f.text(), after: '无可信坐标', changes: [], kind: 'edit' });
    expect(receipt.state).toBe('needs-check'); expect(f.actions.canUndo(f.document, outcome.actionId!)).toBe(false);
  });
  it('rejects protected boundaries, surrogate splits, and a forged authorization anchor', async () => {
    const f = agentFixture('---\ntitle: x\n---\n🙂正文'), context = f.context('replace', '正文'); f.actions.trackContext(context);
    expect((await f.actions.apply(context, { from: 0, to: 3, text: '---', valid: true }, '改后', '替换', 'replace')).status).toBe('conflict');
    context.range!.from = f.text().indexOf('🙂') + 1; context.range!.to = context.range!.from + 1; context.range!.text = f.text().slice(context.range!.from, context.range!.to);
    expect((await f.actions.apply(context, context.range!, '改后', '替换', 'replace')).status).toBe('conflict'); expect(f.editor.transactions).toBe(0);
    const g = agentFixture('原句'), next = g.context('replace', '原句'); g.actions.trackContext(next);
    expect((await g.actions.apply(next, next.range!, '---\nkey: x\n---\n', '替换', 'replace')).status).toBe('conflict');
    expect(g.text()).toBe('原句');
  });
});
