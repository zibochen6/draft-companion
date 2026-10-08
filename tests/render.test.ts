// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderSafeMarkdown, safeLink } from '../src/render';

describe('safe message Markdown', () => {
  it('keeps prose, lists, fenced code and tables readable', () => {
    const target = document.createElement('div');
    renderSafeMarkdown(target, '**中文**\n\n- 甲\n- 乙\n\n```html\n<script>bad()</script>\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    expect(target.querySelector('strong')?.textContent).toBe('中文');
    expect(target.querySelectorAll('li')).toHaveLength(2);
    expect(target.querySelector('code')?.textContent).toContain('<script>');
    expect(target.querySelector('table')).not.toBeNull();
    expect(target.querySelector('script')).toBeNull();
  });
  it('renders raw HTML and note links as inert text and never creates image/network elements', () => {
    const target = document.createElement('div');
    renderSafeMarkdown(target, '<img src="https://tracker.example/pixel" onerror="bad()">\n\n![封面](https://tracker.example/image)\n\n![[private-note]] [[other-note]]\n\n<iframe src="https://tracker.example"></iframe>');
    expect(target.querySelector('img, iframe, svg, script')).toBeNull();
    expect(target.textContent).toContain('图片引用：封面');
    expect(target.textContent).toContain('[[other-note]]');
    expect(target.querySelectorAll('a')).toHaveLength(0);
  });
  it('allows only explicit web/mail links without unsafe attributes', () => {
    const target = document.createElement('div');
    renderSafeMarkdown(target, '[安全](https://example.com) [脚本](javascript:alert%281%29) [本地](file:///etc/passwd) [笔记](obsidian://open)');
    const links = target.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(target.querySelector('[onclick], [onerror]')).toBeNull();
    expect(safeLink('data:text/html,bad')).toBe(false);
    expect(safeLink('/relative.md')).toBe(false);
    expect(safeLink('mailto:hello@example.com')).toBe(true);
  });
  it('does not regress to an HTML parser or direct element factory for message content', () => {
    const implementation = readFileSync('src/render.ts', 'utf8');
    expect(implementation).not.toMatch(/\b(?:innerHTML|outerHTML)\b|\.createElement\(/);
  });
});

// A small native control mock verifies interaction invariants without depending on the Obsidian desktop process.
import { vi } from 'vitest';
vi.mock('obsidian', () => ({
  ItemView: class {
    app = {};
    contentEl = document.createElement('div');
    constructor(_leaf: unknown) { document.body.appendChild(this.contentEl); }
    addAction() { return document.createElement('button'); }
  },
  Modal: class {
    modalEl = document.createElement('div');
    titleEl = document.createElement('h2');
    contentEl = document.createElement('div');
    constructor(_app: unknown) { this.modalEl.className = 'modal'; this.modalEl.append(this.titleEl, this.contentEl); }
    open() { document.body.appendChild(this.modalEl); }
    close() { this.modalEl.remove(); }
  },
  Notice: class {},
  setIcon: (element: HTMLElement, icon: string) => { element.dataset.icon = icon; },
}));
import { DraftCompanionView } from '../src/sidebar';
import { DraftReviewView } from '../src/review-view';
import type { UIHost } from '../src/ui-host';
import type { Session, PluginData, RunningRequest } from '../src/types';
import type { ReviewRun, Suggestion } from '../src/review-types';
import type { DailyTopicRun } from '../src/daily-types';

function nativeDom(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.createEl = function(this: HTMLElement, tag: string, info: Record<string, unknown> = {}) {
    const el = document.createElement(tag);
    if (info.text !== undefined) el.textContent = String(info.text);
    if (info.cls) el.className = String(info.cls);
    if (info.type) el.setAttribute('type', String(info.type));
    if (info.value !== undefined) el.setAttribute('value', String(info.value));
    for (const [key, value] of Object.entries(info.attr as Record<string, string> || {})) el.setAttribute(key, value);
    this.appendChild(el); return el;
  };
  proto.createDiv = function(this: HTMLElement, info: Record<string, unknown> = {}) { return (this as unknown as { createEl: (tag: string, info: Record<string, unknown>) => HTMLElement }).createEl('div', info); };
  proto.empty = function(this: HTMLElement) { this.replaceChildren(); };
  proto.addClass = function(this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.removeClass = function(this: HTMLElement, cls: string) { this.classList.remove(cls); };
  proto.setText = function(this: HTMLElement, text: string) { this.textContent = text; };
}

function setupView() {
  nativeDom();
  const a: Session = { id: 'a', document: { id: 'doc-a', path: 'A.md', ctime: 1 }, brief: '', selectedRoleId: 'writer', mode: 'discuss', messages: [] };
  const b: Session = { ...a, id: 'b', document: { id: 'doc-b', path: 'B.md', ctime: 2 }, messages: [] };
  const data: PluginData = { version: 1, initialized: true, providers: [{ id: 'provider', name: 'Local', baseUrl: 'http://localhost/v1', secretRef: '', model: 'mock', stream: true, timeoutMs: 1000 }], activeProviderId: 'provider', roles: [{ id: 'writer', name: '写作伙伴', description: '', systemPrompt: 'write', defaultMode: 'discuss', quickTasks: ['帮我拟大纲'] }], preferences: '', sessions: { a, b } };
  let current: Session | null = a; let running: RunningRequest | undefined; let dailyStatus: DailyTopicRun | undefined; let notify: (() => void) | undefined;
  const send = vi.fn(async () => {}); const sendAgent = vi.fn(async () => {}); const stop = vi.fn(() => { running = undefined; notify?.(); });
  const acceptSuggestion = vi.fn(async () => {}); const openReview = vi.fn(async () => {});
  const review = vi.fn(async () => {}), retryReview = vi.fn(async () => {}), locateSuggestion = vi.fn(async () => {}), openSettings = vi.fn();
  const startDailyTopics = vi.fn(async () => {}), stopDailyTopics = vi.fn(() => { if (dailyStatus) dailyStatus = { ...dailyStatus, status: 'stopped', stage: '已停止' }; notify?.(); });
  const openDailyResult = vi.fn();
  const host: UIHost = {
    data, get running() { return running; }, currentSession: () => current, target: () => current?.document || null,
    subscribe: listener => { notify = listener; return () => { notify = undefined; }; }, saveSettings: async () => {},
    send, sendAgent, bindTopicLibrary: async () => {}, agentActions: () => [], undoAgentAction: async () => {}, canUndoAgentAction: () => false, locateAgentAction: async () => {}, stop, apply: async () => {}, discard: async () => {}, undo: async () => {}, deleteRange: async () => {}, clearSession: async () => {},
    chooseRole: async () => {}, setBrief: async () => {}, models: async () => [], testProvider: async () => 'ok', openSettings,
    review, retryReview, selectionSummary: () => ({ kind: 'body', characters: 0 }), selectSuggestion: () => {}, selectedSuggestion: () => undefined,
    startDailyTopics, stopDailyTopics, dailyStatus: () => dailyStatus, dailyEnabled: () => false, openDailyResult,
    locateSuggestion, previewSuggestion: async () => { throw new Error('没有预览'); }, acceptSuggestion, ignoreSuggestion: async () => {}, undoSuggestion: async () => {},
    canUndoSuggestion: () => false, canUndoWhole: () => false, askSuggestion: async () => {}, openReview, bindReview: () => {},
  };
  const view = new DraftCompanionView({} as ConstructorParameters<typeof DraftCompanionView>[0], host);
  return { view, host, a, b, data, send, sendAgent, stop, review, retryReview, locateSuggestion, openSettings, acceptSuggestion, openReview, startDailyTopics, stopDailyTopics, openDailyResult, daily: (status: DailyTopicRun | undefined) => { dailyStatus = status; notify?.(); }, switchTo: (session: Session | null) => { current = session; notify?.(); }, run: (request: RunningRequest | undefined) => { running = request; notify?.(); }, notify: () => notify?.() };
}

describe('sidebar interaction contract', () => {
  it('keeps Enter as newline, shortcuts fill only, and IME suppresses Cmd/Ctrl+Enter', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    input.value = '写中文'; input.dispatchEvent(new Event('input'));
    const plain = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }); input.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false); expect(setup.send).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
    expect(setup.send).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend'));
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!.click();
    document.querySelector<HTMLButtonElement>('.dc-secondary-popover .dc-quick-task')!.click();
    expect(input.value).toBe('帮我拟大纲'); expect(setup.send).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
    expect(setup.sendAgent).toHaveBeenCalledWith('帮我拟大纲', { task: 'auto', scope: 'auto' });
    await setup.view.onClose();
  });
  it('isolates drafts and shows a global stop entry while another document generates', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    input.value = 'A 的要求'; input.dispatchEvent(new Event('input'));
    setup.run({ id: 'request-a', documentId: 'doc-a', path: 'A.md', sessionId: 'a', roleName: '写作伙伴', mode: 'edit', text: '{"replacement":"not complete', stop: () => {} });
    expect(setup.view.contentEl.querySelector('.dc-streaming')?.textContent).toContain('正在生成修改候选');
    expect(setup.view.contentEl.querySelector('.dc-streaming')?.textContent).not.toContain('replacement');
    setup.switchTo(setup.b);
    expect(input.value).toBe(''); expect(setup.view.contentEl.querySelector('.dc-target')?.textContent).toBe('文稿：B.md');
    const global = setup.view.contentEl.querySelector<HTMLElement>('.dc-global-running')!;
    expect(global.textContent).toContain('A.md'); global.querySelector<HTMLButtonElement>('button')!.click();
    expect(setup.stop).toHaveBeenCalledOnce();
    setup.switchTo(setup.a); expect(input.value).toBe('A 的要求');
    await setup.view.onClose();
  });
  it('preserves reading position and input focus during streaming and unsubscribes on close', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    const conversation = setup.view.contentEl.querySelector<HTMLElement>('.dc-reader')!;
    Object.defineProperties(conversation, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    conversation.scrollTop = 120; input.focus();
    setup.run({ id: 'request-a', documentId: 'doc-a', path: 'A.md', sessionId: 'a', roleName: '写作伙伴', mode: 'discuss', text: '新段落', stop: () => {} });
    expect(conversation.scrollTop).toBe(120); expect(document.activeElement).toBe(input);
    await setup.view.onClose(); setup.notify(); expect(setup.view.contentEl.childElementCount).toBe(0);
  });
  it('updates only the streaming text between chunks, keeping history DOM and IME composition intact', async () => {
    const setup = setupView();
    setup.a.messages.push({ id: 'history', role: 'assistant', content: '已经完成的历史回复。', at: 1, status: 'completed' });
    await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    const first: RunningRequest = { id: 'request-a', documentId: 'doc-a', path: 'A.md', sessionId: 'a', roleName: '写作伙伴', mode: 'discuss', text: '第一段', stop: () => {} };
    setup.run(first);
    const history = setup.view.contentEl.querySelector<HTMLElement>('.dc-message:not(.dc-streaming)')!;
    const streaming = setup.view.contentEl.querySelector<HTMLElement>('.dc-streaming .dc-message-content')!;
    input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart'));
    setup.run({ ...first, text: '第一段，第二段' });
    expect(setup.view.contentEl.querySelector('.dc-message:not(.dc-streaming)')).toBe(history);
    expect(setup.view.contentEl.querySelector('.dc-streaming .dc-message-content')).toBe(streaming);
    expect(streaming.textContent).toBe('第一段，第二段'); expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
    expect(setup.sendAgent).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend'));
    await setup.view.onClose();
  });
});

describe('daily topic button contract', () => {
  function job(status: DailyTopicRun['status'], stage: string): DailyTopicRun {
    return { id: 'daily-job', date: '2026-10-08', origin: 'manual', status, stage, documentId: 'topic-document', path: 'Projects/选题库.md', startedAt: 1, sources: [], cards: [] };
  }
  it('starts from the document row with empty input and scheduling disabled, independently of chat/review tabs', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const button = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-start')!;
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    const row = setup.view.contentEl.querySelector('.dc-document-meta')!;
    expect(button.parentElement).toBe(row); expect(row.lastElementChild).toBe(button);
    expect(setup.view.contentEl.querySelector('.dc-composer .dc-daily-start')).toBeNull();
    expect(button.textContent).toBe('立即选题'); expect(button.disabled).toBe(false);
    expect(input.value).toBe(''); expect(setup.host.dailyEnabled!()).toBe(false);
    button.click(); await vi.waitFor(() => expect(setup.startDailyTopics).toHaveBeenCalledOnce());
    Array.from(setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-reader-tab')).find(tab => tab.textContent?.includes('批注'))!.click();
    expect(button.parentElement).toBe(row); expect(button.disabled).toBe(false);
    button.click(); await vi.waitFor(() => expect(setup.startDailyTopics).toHaveBeenCalledTimes(2));
    expect(setup.sendAgent).not.toHaveBeenCalled(); expect(setup.send).not.toHaveBeenCalled(); expect(setup.review).not.toHaveBeenCalled();
    expect(input.value).toBe(''); await setup.view.onClose();
  });
  it('does not depend on the currently focused article or consume an unrelated draft', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    input.value = 'A 的未发送草稿'; input.dispatchEvent(new Event('input'));
    setup.switchTo(setup.b); input.value = 'B 的未发送草稿'; input.dispatchEvent(new Event('input'));
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-start')!.click();
    await vi.waitFor(() => expect(setup.startDailyTopics).toHaveBeenCalledOnce());
    expect(input.value).toBe('B 的未发送草稿'); setup.switchTo(setup.a); expect(input.value).toBe('A 的未发送草稿');
    setup.switchTo(null); expect(setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-start')!.disabled).toBe(false);
    await setup.view.onClose();
  });
  it('shows queue/cancel states separately from an existing chat and cancels only the daily job', async () => {
    const setup = setupView(); await setup.view.onOpen();
    setup.run({ id: 'chat', documentId: 'doc-b', path: 'B.md', sessionId: 'b', roleName: '写作伙伴', mode: 'discuss', text: '', stop: () => {} });
    setup.daily(job('queued', '等待当前聊天结束'));
    const button = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-start')!;
    expect(button.textContent).toBe('取消排队'); expect(button.disabled).toBe(false);
    expect(setup.view.contentEl.querySelector('.dc-daily-status')?.textContent).toContain('等待当前聊天结束');
    expect(setup.view.contentEl.querySelector('.dc-global-running')?.textContent).toContain('B.md');
    button.click(); expect(setup.stopDailyTopics).toHaveBeenCalledOnce(); expect(setup.stop).not.toHaveBeenCalled(); expect(setup.startDailyTopics).not.toHaveBeenCalled();
    expect(button.textContent).toBe('立即选题'); await setup.view.onClose();
  });
  it.each(['collecting', 'screening', 'reading', 'preparing', 'committing'] as const)('keeps a stop action for the %s stage', async status => {
    const setup = setupView(); await setup.view.onOpen(); setup.daily(job(status, '合成阶段'));
    const button = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-start')!;
    expect(button.textContent).toBe('停止'); button.click(); expect(setup.stopDailyTopics).toHaveBeenCalledOnce();
    expect(setup.startDailyTopics).not.toHaveBeenCalled(); await setup.view.onClose();
  });
  it('updates daily progress without injecting chat streaming, replacing history or disturbing a composing draft', async () => {
    const setup = setupView(); setup.a.messages.push({ id: 'history', role: 'assistant', content: '保留的历史回答。', at: 1, status: 'completed' });
    await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!, reader = setup.view.contentEl.querySelector<HTMLElement>('.dc-reader')!;
    Object.defineProperties(reader, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    input.value = '组词中的草稿'; input.dispatchEvent(new Event('input')); input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart')); reader.scrollTop = 180;
    const history = reader.querySelector('.dc-message');
    setup.run({ id: 'daily', origin: 'daily', documentId: 'doc-a', path: 'Projects/选题库.md', sessionId: 'a', roleName: '选题编辑', mode: 'discuss', text: '内部合成数据，不属于聊天回复', stage: '采集中', stop: () => {} });
    for (const [status, stage] of [['collecting', '采集中'], ['screening', '筛选中'], ['preparing', '准备写入']] as const) setup.daily(job(status, stage));
    expect(reader.querySelector('.dc-streaming')).toBeNull(); expect(reader.textContent).not.toContain('内部合成数据');
    expect(reader.querySelector('.dc-message')).toBe(history); expect(reader.scrollTop).toBe(180);
    expect(input.value).toBe('组词中的草稿'); expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true })); expect(setup.sendAgent).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend')); await setup.view.onClose();
  });
  it('shows run feedback and an explicit result entry, and opens settings for missing pipeline configuration', async () => {
    const setup = setupView(); await setup.view.onOpen(); setup.daily({ ...job('no-new', '已完成'), message: '没有新增选题；已有条目保持不变。' });
    expect(setup.view.contentEl.querySelector('.dc-daily-status')?.textContent).toContain('没有新增选题');
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-status button')!.click(); expect(setup.openDailyResult).toHaveBeenCalledOnce();
    setup.startDailyTopics.mockRejectedValueOnce(new Error('请先绑定选题库。')); setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-daily-start')!.click();
    await vi.waitFor(() => expect(setup.openSettings).toHaveBeenCalledOnce());
    expect(setup.view.contentEl.querySelector('.dc-error')?.textContent).toContain('请先绑定选题库');
    await setup.view.onClose();
  });
  it('opens daily results on the first click when sidebar focus refreshes after mousedown', async () => {
    const setup = setupView(); await setup.view.onOpen();
    setup.daily({ ...job('completed', '已完成'), message: '已新增合成选题。' });
    const status = setup.view.contentEl.querySelector<HTMLElement>('.dc-daily-status')!;
    const label = status.querySelector('span'), result = status.querySelector<HTMLButtonElement>('button')!;
    result.addEventListener('mousedown', () => setup.notify(), { once: true });
    result.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(result.isConnected).toBe(true);
    expect(status.querySelector('button')).toBe(result); expect(status.querySelector('span')).toBe(label);
    result.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    result.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
    expect(setup.openDailyResult).toHaveBeenCalledOnce();
    await setup.view.onClose();
  });
  it('updates daily status text and error state while preserving the result action', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const status = setup.view.contentEl.querySelector<HTMLElement>('.dc-daily-status')!;
    const label = status.querySelector<HTMLElement>('span')!, result = status.querySelector('button');
    expect(status.hidden).toBe(true);
    setup.daily(job('collecting', '采集中'));
    expect(status.hidden).toBe(false); expect(label.textContent).toContain('采集中'); expect(label.title).toBe('Projects/选题库.md');
    setup.daily({ ...job('failed', '选题失败'), error: '合成失败反馈。' });
    expect(label.textContent).toBe('合成失败反馈。'); expect(status.classList.contains('is-error')).toBe(true);
    setup.daily({ ...job('completed', '已完成'), message: '合成任务完成。' });
    expect(label.textContent).toBe('合成任务完成。'); expect(status.classList.contains('is-error')).toBe(false);
    setup.daily(undefined); expect(status.hidden).toBe(true); expect(label.textContent).toBe('');
    expect(status.querySelector('button')).toBe(result); expect(status.querySelector('span')).toBe(label);
    await setup.view.onClose();
  });
});

describe('sidebar final usability', () => {
  it('clears current history and both tab drafts from the visible button while preserving another document', async () => {
    const setup = setupView();
    setup.a.messages.push({ id: 'old-a', role: 'assistant', content: 'A 的旧聊天', at: 1, status: 'completed' });
    setup.b.messages.push({ id: 'old-b', role: 'user', content: 'B 的旧聊天', at: 1 });
    setup.a.brief = '保留本文要求';
    setup.host.clearSession = vi.fn(async id => { expect(id).toBe('a'); setup.a.messages = []; setup.notify(); });
    await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    input.value = 'A 对话草稿'; input.dispatchEvent(new Event('input'));
    Array.from(setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-reader-tab')).find(b => b.textContent?.includes('批注'))!.click();
    input.value = 'A 批注页草稿'; input.dispatchEvent(new Event('input'));
    Array.from(setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-reader-tab')).find(b => b.textContent === '对话')!.click();
    setup.switchTo(setup.b); input.value = 'B 未发送内容'; input.dispatchEvent(new Event('input')); setup.switchTo(setup.a);
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dc-task-item')).find(b => b.textContent?.includes('标题'))!.click();
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-header-clear')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button')).find(b => b.textContent === '清空对话')!.click();
    await vi.waitFor(() => { expect(input.value).toBe(''); expect(document.querySelector('.modal')).toBeNull(); });
    expect(setup.a.messages).toEqual([]); expect(setup.a.brief).toBe('保留本文要求');
    expect(setup.view.contentEl.querySelectorAll('.dc-message')).toHaveLength(0);
    expect(setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-task-tag')!.hidden).toBe(true);
    Array.from(setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-reader-tab')).find(b => b.textContent?.includes('批注'))!.click();
    expect(input.value).toBe('');
    setup.switchTo(setup.b); expect(input.value).toBe('B 未发送内容'); expect(setup.b.messages).toHaveLength(1);
    await setup.view.onClose();
  });

  it('keeps the confirmed document frozen if focus changes while its clear dialog is open', async () => {
    const setup = setupView(); setup.a.messages.push({ id: 'a', role: 'user', content: '只清 A', at: 1 });
    setup.host.clearSession = vi.fn(async id => { expect(id).toBe('a'); setup.a.messages = []; setup.notify(); });
    await setup.view.onOpen(); const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    input.value = 'A 草稿'; input.dispatchEvent(new Event('input'));
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-header-clear')!.click();
    setup.switchTo(setup.b); input.value = '保留 B 草稿'; input.dispatchEvent(new Event('input'));
    Array.from(document.querySelectorAll<HTMLButtonElement>('.modal button')).find(b => b.textContent === '清空对话')!.click();
    await vi.waitFor(() => expect(document.querySelector('.modal')).toBeNull());
    expect(input.value).toBe('保留 B 草稿'); setup.switchTo(setup.a); expect(input.value).toBe('');
    expect(setup.a.messages).toEqual([]); await setup.view.onClose();
  });

  it('resets new document scroll and restores the previous document position', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const conversation = setup.view.contentEl.querySelector<HTMLElement>('.dc-reader')!;
    Object.defineProperties(conversation, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    conversation.scrollTop = 230; setup.switchTo(setup.b);
    expect(conversation.scrollTop).toBe(0);
    setup.switchTo(setup.a); expect(conversation.scrollTop).toBe(230);
    await setup.view.onClose();
  });
  it('selection edit quick tasks set edit and selection while still requiring Send', async () => {
    const setup = setupView(); setup.data.roles[0]!.quickTasks = ['只起草当前选中部分。'];
    await setup.view.onOpen();
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!.click();
    document.querySelector<HTMLButtonElement>('.dc-secondary-popover .dc-quick-task')!.click();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    expect(input.value).toBe('只起草当前选中部分。');
    expect(setup.send).not.toHaveBeenCalled();
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    await setup.view.onClose();
  });
  it('keeps a long pasted draft intact while capping only the visible input height', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 2400 });
    const pasted = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行内容`).join('\n');
    input.value = pasted; input.dispatchEvent(new Event('input'));
    expect(input.value).toBe(pasted);
    expect(input.style.height).toBe('130px');
    const send = setup.view.contentEl.querySelector<HTMLButtonElement>('.mod-cta')!;
    expect(send.getAttribute('aria-label')).toBe('发送'); expect(send.dataset.icon).toBe('arrow-up');
    await setup.view.onClose();
  });
  it('keeps secondary actions in one temporary body popover and removes it on repeated close', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const more = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!;
    const composer = setup.view.contentEl.querySelector<HTMLElement>('.dc-composer')!;
    more.click();
    const menu = document.querySelector<HTMLElement>('.dc-secondary-popover')!;
    expect(menu.parentElement).toBe(document.body);
    expect(composer.querySelector('.dc-secondary-popover')).toBeNull();
    expect(document.querySelectorAll('.dc-secondary-popover')).toHaveLength(1);
    more.click(); expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    more.click(); expect(document.querySelectorAll('.dc-secondary-popover')).toHaveLength(1);
    await setup.view.onClose();
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
  });
  it('closes the action popover with Escape and restores the trigger focus', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const more = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!;
    more.focus(); more.click();
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.dc-secondary-popover button[role="menuitem"]:not(:disabled)'));
    items[0]!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[1]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items.at(-1));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[0]);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
    await setup.view.onClose();
  });
  it('closes the action popover when Tab leaves its final menu item', async () => {
    const setup = setupView(); await setup.view.onOpen();
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!.click();
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.dc-secondary-popover button[role="menuitem"]:not(:disabled)'));
    items.at(-1)!.focus(); items.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    await setup.view.onClose();
  });
  it('lets an outside click close the popover without taking focus and closes stale menus on context changes', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const more = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!;
    const outside = document.createElement('button'); document.body.appendChild(outside);
    more.click(); outside.focus(); outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    expect(document.activeElement).toBe(outside);
    more.click(); setup.data.roles.push({ id: 'editor', name: '编辑', description: '', systemPrompt: '', defaultMode: 'discuss', quickTasks: [] });
    setup.a.selectedRoleId = 'editor'; setup.notify();
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    more.click(); setup.switchTo(setup.b);
    expect(document.querySelector('.dc-secondary-popover')).toBeNull();
    outside.remove(); await setup.view.onClose();
  });
  it('copies the assistant source Markdown through an explicit user action', async () => {
    const setup = setupView();
    setup.a.messages.push({ id: 'reply', role: 'assistant', content: '**可复制**\n\n- 中文', at: 1, status: 'completed' });
    const copy = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    await setup.view.onOpen();
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-copy-message')!.click();
    expect(copy).toHaveBeenCalledWith('**可复制**\n\n- 中文');
    await setup.view.onClose();
  });
  it('uses verified tool receipts instead of assistant prose to present a write action', async () => {
    const setup = setupView();
    setup.a.messages.push({ id: 'tool', role: 'assistant', content: '我已经修改正文。', at: 1, presentation: 'tool', actionIds: ['receipt'] });
    setup.host.agentActions = () => [{ id: 'receipt', requestId: 'request', documentId: 'doc-a', path: 'A.md', at: 1, kind: 'replace', label: '替换标题', before: '旧标题', replacement: '新标题', anchor: { from: 0, to: 3, text: '新标题', valid: true }, beforeHash: 'before', afterHash: 'after', state: 'prepared' }];
    await setup.view.onOpen();
    const receipt = setup.view.contentEl.querySelector('.dc-tool-receipt')!;
    expect(receipt.textContent).toContain('已准备，尚未写入');
    expect(receipt.textContent).not.toContain('我已经修改正文');
    await setup.view.onClose();
  });
  it('keeps unknown historical JSON diagnostic and read-only', async () => {
    const setup = setupView();
    setup.a.messages.push({ id: 'json', role: 'assistant', content: '{"status":"done","claim":"正文已修改"}', at: 1, presentation: 'legacy' });
    await setup.view.onOpen();
    const diagnostic = setup.view.contentEl.querySelector('.dc-structured-message')!;
    expect(diagnostic.textContent).toContain('无法识别的结构化历史回复');
    expect(diagnostic.querySelector('button')).toBeNull();
    await setup.view.onClose();
  });
  it('keeps an explicit task visible and lets its tag restore automatic sending', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dc-secondary-popover .dc-task-item')).find(item => item.textContent?.includes('选题'))!.click();
    const tag = setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-task-tag')!;
    expect(tag.hidden).toBe(false); expect(tag.textContent).toContain('选题');
    expect(input.value).toContain('按读者价值和材料充分程度'); expect(input.value).toContain('没有合适的可以不选'); expect(input.value).not.toContain('帮我选一个'); expect(input.value).toContain('只放在侧栏');
    tag.click(); expect(tag.hidden).toBe(true);
    input.value = '给我三个方向'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
    expect(setup.sendAgent).toHaveBeenCalledWith('给我三个方向', { task: 'auto', scope: 'auto' });
    await setup.view.onClose();
  });
  it('shows a tool reply without action ids as read-only text instead of an unverified receipt', async () => {
    const setup = setupView();
    setup.a.messages.push({ id: 'tool-read', role: 'assistant', content: '请先确认替换范围。', at: 1, presentation: 'tool' });
    await setup.view.onOpen();
    expect(setup.view.contentEl.querySelector('.dc-tool-receipt')).toBeNull();
    expect(setup.view.contentEl.querySelector('.dc-message-content')?.textContent).toContain('请先确认替换范围');
    await setup.view.onClose();
  });
  it('keeps chat and annotation reader positions separately and expands the selected annotation', async () => {
    const setup = setupView();
    const version = { id: 'version', at: 1, author: { id: 'writer', name: '写作伙伴', systemPrompt: 'write' }, reason: '语气太重复', replacement: '更简洁的句子。', evidenceQuotes: [] };
    const suggestion: Suggestion = { id: 'suggestion', documentId: 'doc-a', runId: 'run', number: 1, type: '冗余', title: '收紧表达', quote: '原句。', contextBefore: '', contextAfter: '', author: version.author, versions: [version], currentVersionId: 'version', state: 'pending', anchors: {target: {from: 0, to: 3, text: '原句。', valid: true}, scope: {from: 0, to: 3, valid: true}, evidence: []}, fingerprint: 'f', replies: [] };
    setup.a.review = { verifiedHash: '', runs: [{ id: 'run', requestId: 'req', at: 1, author: version.author, model: 'mock', providerName: 'Local', snapshotHash: '', scope: 'body', status: 'completed', summary: '', overall: [], added: 1, duplicates: 0 }], suggestions: [suggestion], receipts: [], selectedId: 'suggestion' };
    await setup.view.onOpen();
    const reader = setup.view.contentEl.querySelector<HTMLElement>('.dc-reader')!;
    Object.defineProperties(reader, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    expect(setup.view.contentEl.querySelector('.dc-suggestion.is-selected')?.textContent).toContain('收紧表达');
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-suggestion.is-selected button.mod-cta')!.click();
    expect(setup.openReview).toHaveBeenCalledWith('doc-a', 'suggestion');
    expect(setup.acceptSuggestion).not.toHaveBeenCalled();
    reader.scrollTop = 160;
    setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-tabs button')[0]!.click();
    reader.scrollTop = 70;
    setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-tabs button')[1]!.click();
    expect(reader.scrollTop).toBe(160);
    suggestion.state = 'applied'; setup.host.canUndoSuggestion = () => true; setup.notify();
    expect(setup.view.contentEl.querySelector<HTMLDetailsElement>('.dc-processed')?.open).toBe(true);
    expect(setup.view.contentEl.querySelector('.dc-processed .dc-suggestion.is-selected')?.textContent).toContain('收紧表达');
    expect(Array.from(setup.view.contentEl.querySelectorAll('button')).some(node => node.textContent === '撤回')).toBe(true);
    await setup.view.onClose();
  });
  it('review tab only asks for a preview when switching original/revision/after', async () => {
    nativeDom();
    const version = { id: 'version', at: 1, author: { id: 'writer', name: '写作伙伴', systemPrompt: 'write' }, reason: '收紧句子', replacement: '建议句。', evidenceQuotes: [] };
    const suggestion: Suggestion = { id: 'suggestion', documentId: 'doc', runId: 'run', number: 1, type: '冗余', title: '收紧表达', quote: '原句。', contextBefore: '', contextAfter: '', author: version.author, versions: [version], currentVersionId: 'version', state: 'pending', anchors: {target: {from: 0, to: 3, text: '原句。', valid: true}, scope: {from: 0, to: 3, valid: true}, evidence: []}, fingerprint: 'f', replies: [] };
    const session: Session = { id: 'session', document: { id: 'doc', path: '测试.md', ctime: 1 }, brief: '', selectedRoleId: 'writer', mode: 'discuss', messages: [], review: { verifiedHash: '', runs: [{ id: 'run', requestId: 'req', at: 1, author: version.author, model: 'mock', providerName: 'Local', snapshotHash: '', scope: 'body', status: 'completed', summary: '', overall: [], added: 1, duplicates: 0 }], suggestions: [suggestion], receipts: [], selectedId: 'suggestion' } };
    const preview = vi.fn(async () => ({ documentId: 'doc', path: '测试.md', suggestion, version, before: '开头\n\n原句。\n\n结尾', after: '开头\n\n建议句。\n\n结尾', from: 4, to: 7, valid: true }));
    const write = vi.fn(async () => {});
    const accept = vi.fn(async () => {});
    const host: UIHost = { data: { version: 2, initialized: true, providers: [], activeProviderId: '', roles: [], preferences: '', sessions: { doc: session } }, running: undefined,
      currentSession: () => session, target: () => session.document, subscribe: () => () => {}, saveSettings: write, send: write, stop: () => {}, apply: write, discard: write, undo: write, deleteRange: write, clearSession: write, chooseRole: write, setBrief: write, models: async () => [], testProvider: async () => '', openSettings: () => {}, review: write, retryReview: write, selectionSummary: () => ({ kind: 'body', characters: 0 }), selectSuggestion: () => {}, selectedSuggestion: () => suggestion, locateSuggestion: write, previewSuggestion: preview, acceptSuggestion: accept, ignoreSuggestion: write, undoSuggestion: write, canUndoSuggestion: () => false, canUndoWhole: () => false, askSuggestion: write, openReview: write, bindReview: () => {} };
    const view = new DraftReviewView({} as ConstructorParameters<typeof DraftReviewView>[0], host);
    await view.onOpen(); await view.setState({ documentId: 'doc', suggestionId: 'suggestion' });
    view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-review-switcher button')[0]!.click();
    await Promise.resolve(); await Promise.resolve();
    view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-review-switcher button')[2]!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(preview).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(view.contentEl.textContent).toContain('尚未写入');
    view.contentEl.querySelector<HTMLButtonElement>('.dc-review-meta button.mod-cta')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(accept).toHaveBeenCalledWith('doc', 'suggestion');
    await view.onClose();
  });
});

function annotationTab(setup: ReturnType<typeof setupView>): void {
  setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-tabs button')[1]!.click();
}
function reviewRun(status: ReviewRun['status'] = 'completed', override: Partial<ReviewRun> = {}): ReviewRun {
  return { id: 'run', requestId: 'request', at: 1700000000000, author: { id: 'writer', name: '写作伙伴', systemPrompt: 'write' },
    model: 'configured-model', providerName: '已配置服务', snapshotHash: 'hash', scope: 'body', status,
    summary: '保留作者口吻，缩短重复表达。', overall: [], added: 0, duplicates: 0, documentId: 'doc-a', path: 'A.md', ...override };
}
function uiSuggestion(run: ReviewRun, override: Partial<Suggestion> = {}): Suggestion {
  return { id: 'suggestion', documentId: 'doc-a', runId: run.id, number: 1, type: 'expression', title: '收紧表达', quote: '原句。',
    contextBefore: '', contextAfter: '', author: run.author, versions: [{ id: 'version', at: run.at, author: run.author, reason: '删去重复修饰，让读者更容易理解。', replacement: '新句。', evidenceQuotes: [] }], currentVersionId: 'version',
    anchors: { target: { from: 0, to: 3, text: '原句。', valid: true }, scope: { from: 0, to: 3, valid: true }, evidence: [] },
    state: 'pending', fingerprint: 'fingerprint', replies: [], ...override };
}

describe('real review UI states', () => {
  it('sets review as an explicit task without letting the reading tab send automatically', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const input = setup.view.contentEl.querySelector<HTMLTextAreaElement>('.dc-input')!;
    input.value = '普通聊天草稿'; input.dispatchEvent(new Event('input'));
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-more-button')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dc-task-item')).find(item => item.textContent?.includes('审阅全文'))!.click();
    expect(setup.sendAgent).not.toHaveBeenCalled();
    expect(setup.view.contentEl.querySelector('.dc-tabs .is-active')?.textContent).toContain('批注');
    setup.view.contentEl.querySelectorAll<HTMLButtonElement>('.dc-tabs button')[0]!.click(); expect(input.value).toBe('普通聊天草稿');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
    expect(setup.sendAgent).toHaveBeenCalledWith('普通聊天草稿', { task: 'review', scope: 'auto' });
    await setup.view.onClose();
  });
  it('distinguishes missing service, no document, empty body and not reviewed', async () => {
    const setup = setupView(); setup.data.providers = []; await setup.view.onOpen(); annotationTab(setup);
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('尚未配置模型服务');
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-review-state button')!.click(); expect(setup.openSettings).toHaveBeenCalledOnce();
    setup.data.providers = [{ id: 'provider', name: 'Local', baseUrl: 'http://localhost/v1', secretRef: '', model: 'configured-model', stream: true, timeoutMs: 1000 }];
    setup.switchTo(null); annotationTab(setup); expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('没有可审阅文稿');
    setup.switchTo(setup.a); annotationTab(setup);
    Object.assign(setup.view.app, { workspace: { getLeavesOfType: () => [{ view: { file: { path: 'A.md' }, editor: { getValue: () => '---\ntitle: 空稿\n---\n   ' } } }] } }); setup.notify();
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('正文为空');
    Object.assign(setup.view.app, { workspace: { getLeavesOfType: () => [{ view: { file: { path: 'A.md' }, editor: { getValue: () => '尚未保存的正文。' } } }] } }); setup.notify();
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('尚未审阅');
    await setup.view.onClose();
  });
  it('shows completed empty suggestions separately from failure and hides earlier failure in history', async () => {
    const setup = setupView(), earlier = reviewRun('failed', { id: 'old-run', error: '旧的连接失败', errorKind: 'connection' }), latest = reviewRun();
    setup.a.review = { verifiedHash: '', runs: [earlier, latest], suggestions: [], receipts: [] };
    await setup.view.onOpen(); annotationTab(setup);
    const state = setup.view.contentEl.querySelector('.dc-review-state')!;
    expect(state.textContent).toContain('本次未提出具体修改建议'); expect(state.textContent).toContain(latest.summary);
    expect(state.textContent).not.toContain('旧的连接失败'); expect(state.querySelector('button')).toBeNull();
    const history = setup.view.contentEl.querySelector<HTMLDetailsElement>('.dc-review-history')!; expect(history.open).toBe(false); expect(history.textContent).toContain('A.md');
    latest.status = 'failed'; latest.error = '模型不可用，检查当前模型。'; latest.errorKind = 'model-unavailable';
    latest.errorDiagnostic = { category: 'model-unavailable', httpStatus: 404, code: 'model-unavailable', stage: 'chat' }; setup.notify();
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('模型不可用');
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-review-state > button')!.click(); await Promise.resolve();
    expect(setup.retryReview).toHaveBeenCalledWith('doc-a', latest.id); expect(setup.review).not.toHaveBeenCalled();
    await setup.view.onClose();
  });
  it('keeps unlocated comments readable while disabling location and writable actions', async () => {
    const setup = setupView(), run = reviewRun('completed', { added: 1 }), suggestion = uiSuggestion(run, { state: 'unlocated', anchors: undefined, invalidReason: '重复原句的上下文不足，无法唯一定位。' });
    setup.a.review = { verifiedHash: '', runs: [run], suggestions: [suggestion], receipts: [], selectedId: suggestion.id };
    await setup.view.onOpen();
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('本次生成 1 条批注');
    const card = setup.view.contentEl.querySelector('.dc-suggestion')!;
    expect(card.textContent).toContain(suggestion.invalidReason); expect(card.textContent).toContain(suggestion.versions[0]!.reason);
    const location = Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === '定位')!;
    expect(location.disabled).toBe(true); expect(Array.from(card.querySelectorAll('button')).some(node => node.textContent === '预览采纳')).toBe(false);
    card.querySelector<HTMLButtonElement>('.dc-suggestion-title')!.click(); expect(setup.locateSuggestion).not.toHaveBeenCalled();
    await setup.view.onClose();
  });
  it('safely locates a validated annotation without accepting it', async () => {
    const setup = setupView(), run = reviewRun('completed', { added: 1 }), suggestion = uiSuggestion(run);
    setup.a.review = { verifiedHash: '', runs: [run], suggestions: [suggestion], receipts: [], selectedId: suggestion.id };
    await setup.view.onOpen(); setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-suggestion-title')!.click();
    expect(setup.locateSuggestion).toHaveBeenCalledWith('doc-a', suggestion.id); expect(setup.acceptSuggestion).not.toHaveBeenCalled();
    await setup.view.onClose();
  });
  it('shows request progress and stops on explicit stop and sidebar close', async () => {
    const setup = setupView(), run = reviewRun('running'); setup.a.review = { verifiedHash: '', runs: [run], suggestions: [], receipts: [] };
    await setup.view.onOpen(); annotationTab(setup);
    const request: RunningRequest = { id: 'request', documentId: 'doc-a', path: 'A.md', sessionId: 'a', roleName: '写作伙伴', mode: 'review', text: '{half JSON', stop: () => {} };
    setup.run(request); expect(setup.view.contentEl.querySelector('.dc-review-state')?.getAttribute('aria-busy')).toBe('true');
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).not.toContain('half JSON');
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-review-stop')!.click(); run.status = 'stopped'; setup.notify();
    expect(setup.view.contentEl.querySelector('.dc-review-state')?.textContent).toContain('本次审阅已停止');
    setup.run(request); await setup.view.onClose(); expect(setup.stop).toHaveBeenCalledTimes(2); setup.notify();
    expect(setup.view.contentEl.childElementCount).toBe(0);
  });
  it('does not repaint a closed preview from a late result or stop another open sidebar request', async () => {
    const setup = setupView(), run = reviewRun('completed', { added: 1 }), suggestion = uiSuggestion(run);
    setup.a.review = { verifiedHash: '', runs: [run], suggestions: [suggestion], receipts: [], selectedId: suggestion.id };
    let resolve: (value: Awaited<ReturnType<UIHost['previewSuggestion']>>) => void = () => {};
    setup.host.previewSuggestion = () => new Promise(done => { resolve = done; });
    const view = new DraftReviewView({} as ConstructorParameters<typeof DraftReviewView>[0], setup.host); await view.onOpen();
    const waiting = view.setState({ documentId: 'doc-a', suggestionId: suggestion.id }); await Promise.resolve();
    setup.run({ id: 'another', documentId: 'doc-a', path: 'A.md', sessionId: 'a', roleName: '写作伙伴', mode: 'review', text: '', stop: () => {} });
    await view.onClose(); resolve({ documentId: 'doc-a', path: 'A.md', suggestion, version: suggestion.versions[0]!, before: '原句。', after: '新句。', from: 0, to: 3, valid: true });
    await waiting; expect(view.contentEl.childElementCount).toBe(0); expect(setup.stop).not.toHaveBeenCalled();
  });
});
