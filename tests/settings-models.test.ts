// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Keep this mock local: settings is deliberately tested with the same native
 * controls used by Obsidian, but without a desktop process or a real vault.
 */
vi.mock('obsidian', () => {
  class Modal {
    app: unknown;
    modalEl = document.createElement('section');
    titleEl = document.createElement('h2');
    contentEl = document.createElement('div');
    constructor(app: unknown) {
      this.app = app;
      this.modalEl.append(this.titleEl, this.contentEl);
    }
    open() { document.body.appendChild(this.modalEl); (this as unknown as { onOpen?: () => void }).onOpen?.(); }
    close() { (this as unknown as { onClose?: () => void }).onClose?.(); this.modalEl.remove(); }
  }
  class InputComponent {
    inputEl: HTMLInputElement;
    constructor(parent: HTMLElement, type = 'text') { this.inputEl = document.createElement('input'); this.inputEl.type = type; parent.appendChild(this.inputEl); }
    setValue(value: string) { this.inputEl.value = value; return this; }
    setPlaceholder(value: string) { this.inputEl.placeholder = value; return this; }
    onChange(callback: (value: string) => void) { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
  }
  class ToggleComponent {
    inputEl: HTMLInputElement;
    constructor(parent: HTMLElement) { this.inputEl = document.createElement('input'); this.inputEl.type = 'checkbox'; parent.appendChild(this.inputEl); }
    setValue(value: boolean) { this.inputEl.checked = value; return this; }
    onChange(callback: (value: boolean) => void) { this.inputEl.addEventListener('change', () => callback(this.inputEl.checked)); return this; }
  }
  class Setting {
    settingEl = document.createElement('div');
    controlEl = document.createElement('div');
    constructor(parent: HTMLElement) { this.settingEl.appendChild(this.controlEl); parent.appendChild(this.settingEl); }
    setName(value: string) { this.settingEl.prepend(Object.assign(document.createElement('label'), { textContent: value })); return this; }
    setDesc(value: string) { this.settingEl.append(Object.assign(document.createElement('small'), { textContent: value })); return this; }
    setHeading() { return this; }
    addText(callback: (input: InputComponent) => void) { callback(new InputComponent(this.controlEl)); return this; }
    addTextArea(callback: (input: { inputEl: HTMLTextAreaElement; setValue(value: string): unknown; onChange(fn: (value: string) => void): unknown }) => void) {
      const textarea = document.createElement('textarea'); this.controlEl.append(textarea);
      const control = { inputEl: textarea, setValue(value: string) { textarea.value = value; return control; }, onChange(fn: (value: string) => void) { textarea.addEventListener('input', () => fn(textarea.value)); return control; } };
      callback(control); return this;
    }
    addToggle(callback: (input: ToggleComponent) => void) { callback(new ToggleComponent(this.controlEl)); return this; }
    addDropdown(callback: (input: {addOptions(values:Record<string,string>):unknown;setValue(value:string):unknown;onChange(fn:(value:string)=>void):unknown})=>void) {
      const select=document.createElement('select');this.controlEl.append(select);
      const control={addOptions(values:Record<string,string>){for(const [value,label]of Object.entries(values))select.append(Object.assign(document.createElement('option'),{value,textContent:label}));return control;},setValue(value:string){select.value=value;return control;},onChange(fn:(value:string)=>void){select.addEventListener('change',()=>fn(select.value));return control;}};
      callback(control);return this;
    }
    addButton(callback: (button: { buttonEl: HTMLButtonElement; setButtonText: (text: string) => unknown; setCta: () => unknown; onClick: (fn: () => void) => unknown }) => void) {
      const buttonEl = document.createElement('button'); this.controlEl.appendChild(buttonEl);
      const control = { buttonEl, setButtonText(text: string) { buttonEl.textContent = text; return control; }, setCta() { return control; }, onClick(fn: () => void) { buttonEl.addEventListener('click', fn); return control; } };
      callback(control); return this;
    }
  }
  class SecretComponent extends InputComponent {
    constructor(_app: unknown, parent: HTMLElement) { super(parent); this.inputEl.className = 'dc-secret-input'; }
    setValue(value: string | null) { this.inputEl.value = value ?? ''; return this; }
  }
  class PluginSettingTab { containerEl = document.createElement('div'); constructor(_app: unknown, _plugin: unknown) {} }
  class Plugin { app = {}; register = vi.fn((callback: () => void) => callback); }
  return { Modal, Notice: class {}, Plugin, PluginSettingTab, SecretComponent, Setting };
});

import { DraftCompanionSettings, ProviderModal } from '../src/settings';
import { defaultDailyTopicData } from '../src/daily-types';
import { Store } from '../src/store';
import type { Provider, PluginData } from '../src/types';
import type { UIHost } from '../src/ui-host';

function nativeDom(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.createEl = function(this: HTMLElement, tag: string, info: Record<string, unknown> = {}) {
    const node = document.createElement(tag);
    if (info.text !== undefined) node.textContent = String(info.text);
    if (info.cls) node.className = String(info.cls);
    if (info.type) node.setAttribute('type', String(info.type));
    for (const [key, value] of Object.entries(info.attr as Record<string, string> || {})) node.setAttribute(key, value);
    this.appendChild(node); return node;
  };
  proto.createDiv = function(this: HTMLElement, info: Record<string, unknown> = {}) { return (this as unknown as { createEl: (tag: string, info: Record<string, unknown>) => HTMLElement }).createEl('div', info); };
  proto.empty = function(this: HTMLElement) { this.replaceChildren(); };
  proto.addClass = function(this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.removeClass = function(this: HTMLElement, cls: string) { this.classList.remove(cls); };
  proto.setText = function(this: HTMLElement, text: string) { this.textContent = text; };
}

const baseProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'provider-a', name: '已有服务', baseUrl: 'https://models.example/v1', secretRef: 'secret-a', model: '', stream: true, timeoutMs: 60_000, ...overrides,
});

function makeHost(provider: Provider | undefined, models = vi.fn<UIHost['models']>()): { host: UIHost; data: PluginData; save: ReturnType<typeof vi.fn> } {
  const data: PluginData = {
    version: 1, initialized: true, providers: provider ? [{ ...provider }] : [], activeProviderId: provider?.id || '', roles: [], preferences: '', sessions: {},
  };
  const save = vi.fn(async () => {});
  const host: UIHost = {
    data, running: undefined, currentSession: () => null, target: () => null, subscribe: () => () => {}, saveSettings: save,
    send: async () => {}, stop: () => {}, apply: async () => {}, discard: async () => {}, undo: async () => {}, deleteRange: async () => {}, clearSession: async () => {}, chooseRole: async () => {}, setBrief: async () => {},
    models, testProvider: async () => 'ok', openSettings: () => {},
  };
  return { host, data, save };
}

function button(text: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text));
  if (!node) throw new Error(`button not found: ${text}`);
  return node;
}

describe('daily topic native settings', () => {
  function setup() {
    const f = makeHost(baseProvider({ model: 'model' }));
    Object.assign(f.data, new Store(null, async () => {}).data, { providers: [baseProvider({ model: 'model' })], activeProviderId: 'provider-a', dailyTopics: defaultDailyTopicData(), topicLibrary: { id: 'topics', path: 'Projects/选题库.md', ctime: 1 } });
    const start = vi.fn(async () => {}), enabled = vi.fn(async (_value: boolean) => {}), records = vi.fn();
    Object.assign(f.host, { startDailyTopics: start, dailyEnabled: () => false, setDailyEnabled: enabled, openDailyResult: records, bindTopicLibrary: vi.fn(async () => {}) });
    const plugin = { app: {}, register: () => {} } as unknown as import('obsidian').Plugin;
    const settings = new DraftCompanionSettings(plugin, f.host); settings.display(); document.body.append(settings.containerEl);
    return { ...f, settings, start, enabled, records };
  }
  async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
  it('saves profiles and starts manually while daily scheduling remains disabled', async () => {
    const f = setup();
    const background = f.settings.containerEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="作者背景"]')!;
    background.value = '我熟悉 AI 工作流'; background.dispatchEvent(new Event('input'));
    button('立即开始').click(); await settle();
    expect(f.data.dailyTopics!.settings.authorBackground).toBe('我熟悉 AI 工作流'); expect(f.save).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce(); expect(f.enabled).not.toHaveBeenCalled();
    button('查看记录').click(); expect(f.records).toHaveBeenCalledOnce(); f.settings.hide();
  });
  it('validates HH:mm before saving, enabling or starting', async () => {
    const f = setup(), time = f.settings.containerEl.querySelector<HTMLInputElement>('input[aria-label="每日选题时间"]')!;
    time.value = '25:00'; time.dispatchEvent(new Event('input')); button('立即开始').click(); await settle();
    expect(f.start).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); expect(f.settings.containerEl.textContent).toContain('HH:mm'); expect(f.data.dailyTopics!.settings.time).toBe('09:00'); f.settings.hide();
  });
  it('uses the separate local toggle without serializing enabled into shared settings', async () => {
    const f = setup();
    const section = f.settings.containerEl.querySelector('.dc-daily-settings')!, toggles = section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    toggles[0]!.checked = true; toggles[0]!.dispatchEvent(new Event('change')); await settle();
    expect(f.enabled).toHaveBeenCalledWith(true); expect(f.data.dailyTopics!.settings).not.toHaveProperty('enabled'); expect(toggles[1]!.checked).toBe(true); f.settings.hide();
  });
});
function edit(input: HTMLInputElement, value: string): void { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { nativeDom(); document.body.replaceChildren(); vi.stubGlobal('crypto', { randomUUID: () => 'generated-id' }); });
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider model discovery in the service editor', () => {
  it('automatically loads an existing service, filters choices, and persists only after Save', async () => {
    const models = vi.fn(async () => [{ id: 'gpt-fast' }, { id: 'claude-write' }]);
    const { host, data, save } = makeHost(baseProvider(), models);
    const done = vi.fn(); const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], done);
    modal.open(); await flush();
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider-a' }), expect.any(AbortSignal));
    const search = document.querySelector<HTMLInputElement>('.dc-model-search')!;
    edit(search, 'claude');
    const choice = document.querySelector<HTMLButtonElement>('.dc-model-list button')!;
    expect(choice.textContent).toContain('claude-write'); expect(choice.getAttribute('aria-pressed')).toBe('false');
    choice.click(); await flush();
    expect(data.providers[0]!.model).toBe(''); expect(save).not.toHaveBeenCalled();
    button('保存配置').click(); await flush();
    expect(data.providers[0]!.model).toBe('claude-write'); expect(save).toHaveBeenCalledOnce(); expect(done).toHaveBeenCalledOnce();
  });

  it('never silently selects a model from a multi-model response', async () => {
    const { host, data } = makeHost(baseProvider(), vi.fn(async () => [{ id: 'first' }, { id: 'second' }]));
    const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], vi.fn());
    modal.open(); await flush();
    expect(data.providers[0]!.model).toBe('');
    expect([...document.querySelectorAll('.dc-model-list button')].every(item => item.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(document.querySelector('.dc-model-status')?.textContent).toContain('点击选择');
  });

  it('keeps a readable fetch failure, permits retry, and still permits manual-ID fallback', async () => {
    const models = vi.fn<UIHost['models']>().mockRejectedValueOnce(new Error('认证失败：API key 无效')).mockResolvedValueOnce([]);
    const { host, data, save } = makeHost(baseProvider(), models);
    const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], vi.fn());
    modal.open(); await flush();
    expect(document.querySelector('.dc-model-status')?.textContent).toContain('认证失败：API key 无效');
    button('重试获取').click(); await flush();
    expect(models).toHaveBeenCalledTimes(2);
    const manual = document.querySelector<HTMLInputElement>('.dc-advanced input[placeholder="由服务提供的模型 ID"]')!;
    edit(manual, 'manual-safe-model'); button('保存配置').click(); await flush();
    expect(data.providers[0]!.model).toBe('manual-safe-model'); expect(save).toHaveBeenCalledOnce();
  });

  it('invalidates late model responses after URL changes and aborts on close', async () => {
    vi.useFakeTimers();
    const first = deferred<{ id: string }[]>(); const second = deferred<{ id: string }[]>();
    const signals: AbortSignal[] = [];
    const models = vi.fn((_provider: Provider, signal?: AbortSignal) => { signals.push(signal!); return signals.length === 1 ? first.promise : second.promise; });
    const { host, data } = makeHost(baseProvider(), models);
    const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], vi.fn());
    modal.open(); await flush();
    const root = [...document.querySelectorAll<HTMLInputElement>('input')].find(input => input.value === 'https://models.example/v1')!;
    edit(root, 'https://other.example/v1');
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500); await flush();
    first.resolve([{ id: 'old-response' }]); await flush();
    expect(document.querySelector('.dc-model-list')?.textContent).not.toContain('old-response');
    expect(models).toHaveBeenCalledTimes(2);
    modal.close(); expect(signals[1]!.aborted).toBe(true);
    second.resolve([{ id: 'too-late' }]); await flush();
    expect(document.body.textContent).not.toContain('too-late');
  });

  it('for a new service, a completed key and URL automatically fetch choices and do not save or close without a selection', async () => {
    vi.useFakeTimers();
    const models = vi.fn(async () => [{ id: 'pick-me' }]);
    const { host, data, save } = makeHost(undefined, models);
    const done = vi.fn(); const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, undefined, done);
    modal.open();
    edit(document.querySelector<HTMLInputElement>('input[placeholder="例如：我的模型服务"]')!, '新服务');
    edit(document.querySelector<HTMLInputElement>('input[placeholder="https://example.com/v1"]')!, 'https://new.example/v1');
    edit(document.querySelector<HTMLInputElement>('.dc-secret-input')!, 'secret-new');
    await vi.advanceTimersByTimeAsync(500); await flush();
    expect(models).toHaveBeenCalledOnce(); expect(data.providers).toHaveLength(0); expect(save).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
    expect(document.querySelector('.dc-model-list button')?.textContent).toContain('pick-me');
    expect(button('请先选择模型').disabled).toBe(true);
  });

  it('lets an empty model list be deliberately saved without silently inventing a model', async () => {
    const { host, data, save } = makeHost(baseProvider(), vi.fn(async () => []));
    const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], vi.fn());
    modal.open(); await flush();
    expect(document.querySelector('.dc-model-status')?.textContent).toContain('没有返回任何模型');
    button('暂不选模型，保存服务').click(); await flush();
    expect(data.providers[0]!.model).toBe(''); expect(save).toHaveBeenCalledOnce();
  });

  it('allows a keyless new service to use the primary action only to discover models', async () => {
    const models = vi.fn(async () => [{ id: 'local-model' }]);
    const { host, data, save } = makeHost(undefined, models);
    const done = vi.fn(); const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, undefined, done);
    modal.open();
    edit(document.querySelector<HTMLInputElement>('input[placeholder="例如：我的模型服务"]')!, '本地服务');
    edit(document.querySelector<HTMLInputElement>('input[placeholder="https://example.com/v1"]')!, 'http://127.0.0.1:11434/v1');
    button('获取模型并继续').click(); await flush();
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ secretRef: '', baseUrl: 'http://127.0.0.1:11434/v1' }), expect.any(AbortSignal));
    expect(data.providers).toHaveLength(0); expect(save).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
    expect(document.querySelector('.dc-model-list')?.textContent).toContain('local-model');
  });

  it('does not issue a second model request while the refresh control is disabled', async () => {
    const pending = deferred<{ id: string }[]>();
    const models = vi.fn(() => pending.promise);
    const { host, data } = makeHost(baseProvider(), models);
    const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], vi.fn());
    modal.open(); await flush();
    const refresh = document.querySelector<HTMLButtonElement>('.dc-model-refresh')!;
    expect(refresh.disabled).toBe(true);
    refresh.click(); refresh.click(); await flush();
    expect(models).toHaveBeenCalledOnce();
    modal.close();
  });

  it('re-fetches when SecretComponent emits an unchanged reference, so a replaced secret is used', async () => {
    vi.useFakeTimers();
    const first = deferred<{ id: string }[]>(); const second = deferred<{ id: string }[]>();
    const signals: AbortSignal[] = [];
    const models = vi.fn((_provider: Provider, signal?: AbortSignal) => { signals.push(signal!); return signals.length === 1 ? first.promise : second.promise; });
    const { host, data } = makeHost(baseProvider(), models);
    const modal = new ProviderModal({ app: {}, register: vi.fn() } as never, host, data.providers[0], vi.fn());
    modal.open(); await flush();
    edit(document.querySelector<HTMLInputElement>('.dc-secret-input')!, 'secret-a');
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500); await flush();
    expect(models).toHaveBeenCalledTimes(2);
    first.resolve([{ id: 'from-old-secret' }]); second.resolve([{ id: 'from-replaced-secret' }]); await flush();
    expect(document.querySelector('.dc-model-list')?.textContent).not.toContain('from-old-secret');
    expect(document.querySelector('.dc-model-list')?.textContent).toContain('from-replaced-secret');
  });
});
