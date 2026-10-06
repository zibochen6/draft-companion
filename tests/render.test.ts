// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
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
  Modal: class {},
  Notice: class {},
}));
import { DraftCompanionView } from '../src/sidebar';
import type { UIHost } from '../src/ui-host';
import type { Session, PluginData, RunningRequest } from '../src/types';

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
  let current = a; let running: RunningRequest | undefined; let notify: (() => void) | undefined;
  const send = vi.fn(async () => {}); const stop = vi.fn(() => { running = undefined; notify?.(); });
  const host: UIHost = {
    data, get running() { return running; }, currentSession: () => current, target: () => current.document,
    subscribe: listener => { notify = listener; return () => { notify = undefined; }; }, saveSettings: async () => {},
    send, stop, apply: async () => {}, discard: async () => {}, undo: async () => {}, deleteRange: async () => {}, clearSession: async () => {},
    chooseRole: async () => {}, setBrief: async () => {}, models: async () => [], testProvider: async () => 'ok', openSettings: () => {},
  };
  const view = new DraftCompanionView({} as ConstructorParameters<typeof DraftCompanionView>[0], host);
  return { view, a, b, data, send, stop, switchTo: (session: Session) => { current = session; notify?.(); }, run: (request: RunningRequest | undefined) => { running = request; notify?.(); }, notify: () => notify?.() };
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
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-quick-task')!.click();
    expect(input.value).toBe('帮我拟大纲'); expect(setup.send).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
    expect(setup.send).toHaveBeenCalledWith('帮我拟大纲', 'discuss', 'auto');
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
    const conversation = setup.view.contentEl.querySelector<HTMLElement>('.dc-conversation')!;
    Object.defineProperties(conversation, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    conversation.scrollTop = 120; input.focus();
    setup.run({ id: 'request-a', documentId: 'doc-a', path: 'A.md', sessionId: 'a', roleName: '写作伙伴', mode: 'discuss', text: '新段落', stop: () => {} });
    expect(conversation.scrollTop).toBe(120); expect(document.activeElement).toBe(input);
    await setup.view.onClose(); setup.notify(); expect(setup.view.contentEl.childElementCount).toBe(0);
  });
});

describe('sidebar final usability', () => {
  it('resets new document scroll and restores the previous document position', async () => {
    const setup = setupView(); await setup.view.onOpen();
    const conversation = setup.view.contentEl.querySelector<HTMLElement>('.dc-conversation')!;
    Object.defineProperties(conversation, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    conversation.scrollTop = 230; setup.switchTo(setup.b);
    expect(conversation.scrollTop).toBe(0);
    setup.switchTo(setup.a); expect(conversation.scrollTop).toBe(230);
    await setup.view.onClose();
  });
  it('selection edit quick tasks set edit and selection while still requiring Send', async () => {
    const setup = setupView(); setup.data.roles[0]!.quickTasks = ['只起草当前选中部分。'];
    await setup.view.onOpen();
    setup.view.contentEl.querySelector<HTMLButtonElement>('.dc-quick-task')!.click();
    const selects = setup.view.contentEl.querySelectorAll<HTMLSelectElement>('.dc-mode-controls select');
    expect(selects[0]!.value).toBe('edit'); expect(selects[1]!.value).toBe('selection');
    expect(setup.send).not.toHaveBeenCalled();
    await setup.view.onClose();
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
});
