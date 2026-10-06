import { describe, expect, it, vi } from 'vitest';
import { buildMessages, estimateTokens } from '../src/prompts';
import { createDefaultRoles, DEFAULT_PREFERENCES } from '../src/roles';
import { Store } from '../src/store';
import type { Candidate, PluginData, RequestSnapshot, Session, UndoRecord } from '../src/types';

function fresh(): Store { return new Store(null, async () => {}); }

function session(store: Store, id = 'document-a', path = '测试/A.md'): Session {
  return store.sessionFor({ id, path, ctime: 100 });
}

function candidate(s: Session, state: Candidate['state'] = 'ready'): Candidate {
  return {
    id: 'candidate-1', requestId: 'request-1', documentId: s.document.id, sessionId: s.id,
    path: s.document.path, scope: 'selection', from: 2, to: 4, baseline: '开头原文结尾', baselineHash: 'hash-a',
    replacement: '改后', explanation: '只改选区', notes: [], state, deletion: false,
  };
}

function undo(s: Session): UndoRecord {
  return { documentId: s.document.id, path: s.document.path, before: '开头原文结尾', from: 2, to: 4, replacement: '改后', candidateId: 'candidate-1' };
}

function snapshot(overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    requestId: 'request-current', documentId: 'document-a', sessionId: 'session-a', path: '文章/A.md',
    fullText: '---\ntitle: 我的文稿\n---\n最新未落盘正文🙂\n', hash: 'hash-new',
    scope: 'body', from: 20, to: 32, selectedText: '',
    role: createDefaultRoles()[4]!,
    provider: { id: 'provider-a', name: '我的连接', baseUrl: 'https://example.test/custom', secretRef: 'PRIVATE_SECRET_REFERENCE', model: 'model-a', stream: true, timeoutMs: 30000 },
    input: '只改善衔接，保留我的观点。', mode: 'edit', preferences: DEFAULT_PREFERENCES, brief: '给中文工具读者。', history: [],
    ...overrides,
  };
}

describe('editable role seeds', () => {
  it('seeds all six complete distinct roles and returns independent editable data', () => {
    const roles = createDefaultRoles();
    expect(roles.map((role) => role.name)).toEqual(['选题编辑', '大纲编辑', '初稿作者', '责任编辑', '改稿编辑', '标题与发布检查']);
    expect(new Set(roles.map((role) => role.id)).size).toBe(6);
    expect(new Set(roles.map((role) => role.systemPrompt)).size).toBe(6);
    expect(roles.map((role) => role.defaultMode)).toEqual(['discuss', 'discuss', 'edit', 'discuss', 'edit', 'discuss']);
    const minimumRules = [9, 9, 12, 12, 10, 15];
    roles.forEach((role, index) => {
      expect(role.systemPrompt).toContain('职责：');
      expect(role.systemPrompt).toContain('默认输出：');
      expect(role.systemPrompt.match(/^\d+\./gm)?.length).toBe(minimumRules[index]);
      expect(role.quickTasks.length).toBeGreaterThanOrEqual(3);
    });
    expect(roles[3]!.systemPrompt).toContain('不伪造原文引用');
    expect(roles[4]!.systemPrompt).toContain('明确拒绝的意见不能再次自动执行');
    expect(roles[5]!.systemPrompt).toContain('不自动重命名 Markdown 文件');
    roles[0]!.systemPrompt = '用户编辑的规则'; roles[0]!.quickTasks.push('自定义');
    expect(createDefaultRoles()[0]!.systemPrompt).not.toBe('用户编辑的规则');
    expect(createDefaultRoles()[0]!.quickTasks).not.toContain('自定义');
  });

  it('never resurrects deleted roles or overwrites edited presets on restart', () => {
    const store = fresh();
    store.data.roles[0]!.systemPrompt = '用户保留的独立规则';
    store.data.roles.splice(1, 1);
    const restored = new Store(store.data, async () => {});
    expect(restored.data.roles).toHaveLength(5);
    expect(restored.data.roles[0]!.systemPrompt).toBe('用户保留的独立规则');
    store.data.roles = [];
    expect(new Store(store.data, async () => {}).data.roles).toEqual([]);
  });
});

describe('Store persistence and recovery', () => {
  it('isolates sessions by document identity, including distinct files at the same path', () => {
    const store = fresh(); const a = session(store); const b = session(store, 'document-b', '测试/B.md');
    a.brief = 'A 的要求'; a.messages.push({ id: 'user-a', role: 'user', content: 'A 的讨论', at: 1 });
    b.brief = 'B 的要求';
    const recreated = session(store, 'document-recreated', a.document.path);
    expect(recreated.id).not.toBe(a.id); expect(recreated.messages).toEqual([]);
    const restored = new Store(store.data, async () => {});
    expect(restored.sessionFor(a.document).messages[0]!.content).toBe('A 的讨论');
    expect(restored.sessionFor(b.document).brief).toBe('B 的要求');
    expect(restored.sessionFor(b.document).messages).toEqual([]);
  });

  it('updates paths for the same identity and invalidates deleted targets', () => {
    const store = fresh(); const a = session(store); a.candidate = candidate(a); a.undo = undo(a);
    expect(store.sessionFor({ ...a.document, path: '改名/新文稿.md' })).toBe(a);
    expect(a.candidate.path).toBe('改名/新文稿.md'); expect(a.undo.path).toBe('改名/新文稿.md');
    store.sessionFor({ ...a.document, deleted: true });
    expect(a.candidate.state).toBe('stale'); expect(a.undo).toBeUndefined();
  });

  it('interrupts unfinished generation, marks applying stale, preserves a ready candidate for document revalidation', () => {
    const store = fresh(); const a = session(store); const b = session(store, 'document-b', '测试/B.md');
    a.messages.push({ id: 'reply', role: 'assistant', content: '部分中文输出', at: 1, status: 'running', roleName: '已经删除的角色名' });
    a.candidate = candidate(a, 'applying'); a.undo = undo(a);
    b.candidate = { ...candidate(b), id: 'candidate-b' }; b.undo = undo(b);
    const restored = new Store(store.data, async () => {});
    const restoredA = restored.data.sessions[a.document.id]!;
    expect(restoredA.messages[0]!.status).toBe('interrupted');
    expect(restoredA.messages[0]!.roleName).toBe('已经删除的角色名');
    expect(restoredA.messages[0]!.content).toBe('部分中文输出');
    expect(restoredA.candidate!.state).toBe('stale');
    expect(restoredA.messages.filter((m) => m.role === 'event')).toHaveLength(2);
    expect(restored.data.sessions[b.document.id]!.candidate!.state).toBe('ready');
    expect(restored.data.sessions[b.document.id]!.undo).toEqual(b.undo);
    // Loading does not mutate the caller's raw object or auto-send any request.
    expect(a.messages[0]!.status).toBe('running'); expect(a.candidate.state).toBe('applying');
  });

  it('refuses future, corrupt, plaintext-key and cross-document data without writing', () => {
    const persist = vi.fn(async () => {}); const raw = fresh().data;
    expect(() => new Store({ ...raw, version: 99 }, persist)).toThrow('数据版本');
    expect(() => new Store({ ...raw, roles: 'invalid' }, persist)).toThrow('创作伙伴');
    expect(() => new Store({ ...raw, providers: [{ id: 'p', name: '连接', baseUrl: '', secretRef: '', model: '', stream: true, timeoutMs: 1000, apiKey: 'not-a-real-key' }] }, persist)).toThrow('未知字段');
    const a = session(new Store(raw, async () => {}));
    const invalid = fresh(); const s = session(invalid); s.candidate = { ...candidate(s), documentId: a.id };
    expect(() => new Store(invalid.data, persist)).toThrow('关联无效');
    expect(persist).not.toHaveBeenCalled();
    expect(raw.version).toBe(1);
  });

  it('deep-snapshots each save and writes queued snapshots in invocation order', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saved: PluginData[] = [];
    const store = new Store(null, async (data) => { saved.push(data); if (saved.length === 1) await gate; });
    const a = session(store); a.brief = '第一版'; const first = store.save();
    a.brief = '第二版'; const second = store.save(); a.brief = '仍在输入第三版';
    await Promise.resolve();
    expect(saved).toHaveLength(1); expect(saved[0]!.sessions[a.document.id]!.brief).toBe('第一版');
    release(); await Promise.all([first, second]);
    expect(saved.map((data) => data.sessions[a.document.id]!.brief)).toEqual(['第一版', '第二版']);
  });

  it('reports a failed save while allowing the next queued save to complete', async () => {
    let calls = 0;
    const store = new Store(null, async () => { if (++calls === 1) throw new Error('保存失败'); });
    const failed = store.save(); const next = store.save();
    await expect(failed).rejects.toThrow('保存失败'); await expect(next).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('clears discussion and the candidate, retaining brief and the last undo record', () => {
    const store = fresh(); const a = session(store); a.brief = '必须保留个人观点'; a.candidate = candidate(a); a.undo = undo(a);
    a.messages.push({ id: 'old', role: 'user', content: '旧讨论', at: 1 });
    const savedUndo = a.undo; const savedDocument = { ...a.document };
    store.clear(a);
    expect(a.brief).toBe('必须保留个人观点'); expect(a.undo).toBe(savedUndo); expect(a.document).toEqual(savedDocument);
    expect(a.candidate).toBeUndefined(); expect(a.messages).toHaveLength(1);
    expect(a.messages[0]!.role).toBe('event'); expect(a.messages[0]!.candidateId).toBe('candidate-1');
    expect(a.messages[0]!.content).toContain('当前候选已放弃');
  });
});

describe('request prompt boundaries', () => {
  it('injects latest unsaved full text once, one current system role and no credential reference', () => {
    const current = snapshot(); const messages = buildMessages(current);
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages[0]!.content).toContain(current.role.systemPrompt);
    const joined = messages.map((message) => message.content).join('\n');
    expect(joined.split(current.fullText)).toHaveLength(2);
    expect(joined).toContain('最新未落盘正文🙂');
    expect(joined).not.toContain('PRIVATE_SECRET_REFERENCE');
    for (const other of createDefaultRoles().filter((role) => role.id !== current.role.id)) expect(messages[0]!.content).not.toContain(other.systemPrompt);
    expect(messages[0]!.content).toContain('文件路径、身份、基线、位置与范围由插件控制');
    expect(messages[0]!.content).toContain('仅有三个字段');
  });

  it('retains an explicit refusal and plugin operation states across a role handoff', () => {
    const messages = buildMessages(snapshot({ history: [
      { id: 'review', role: 'assistant', roleName: '责任编辑', model: 'old-model', status: 'completed', at: 1, content: '建议删除这一段个人观点。' },
      { id: 'refusal', role: 'user', at: 2, content: '拒绝删除，这是我的观点。' },
      { id: 'discard', role: 'event', at: 3, content: '候选 candidate-old 已放弃，不代表正文改动。' },
      { id: 'applied', role: 'event', at: 4, content: '候选 candidate-other 已应用到 A。' },
      { id: 'undone', role: 'event', at: 5, content: '最近一次 AI 改稿已撤回。' },
    ] }));
    expect(messages[0]!.content).toContain('明确拒绝的意见不能再次自动执行');
    expect(messages.some((message) => message.role === 'user' && message.content === '拒绝删除，这是我的观点。')).toBe(true);
    expect(messages[1]!.content).toContain('角色：责任编辑'); expect(messages[1]!.content).toContain('模型：old-model');
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.filter((message) => message.content.includes('【插件操作记录；')).map((message) => message.role)).toEqual(['user', 'user', 'user']);
    expect(messages.at(-1)!.content).toContain('只改善衔接，保留我的观点。');
  });

  it('freezes selection text and offsets without duplicating a whole-document selection', () => {
    const selection = snapshot({ scope: 'selection', selectedText: '中文🙂\nEnglish', from: 22, to: 34 });
    const messages = buildMessages(selection);
    expect(messages.at(-1)!.content).toContain('[22, 34)');
    expect(messages.at(-1)!.content).toContain('中文🙂\nEnglish');
    const all = snapshot({ scope: 'selection' }); all.selectedText = all.fullText;
    expect(buildMessages(all).map((m) => m.content).join('\n').split(all.fullText)).toHaveLength(2);
  });

  it('does not turn an unfinished assistant placeholder into usable history or change the snapshot', () => {
    const current = snapshot({ history: [{ id: 'running', role: 'assistant', content: '未完成结果', at: 1, status: 'running' }] });
    const before = JSON.stringify(current);
    expect(buildMessages(current).map((message) => message.content).join('\n')).not.toContain('未完成结果');
    expect(JSON.stringify(current)).toBe(before);
    const discussion = buildMessages(snapshot({ mode: 'discuss', role: createDefaultRoles()[3]! }));
    expect(discussion[0]!.content).toContain('本轮方式：讨论');
    expect(discussion[0]!.content).not.toContain('仅有三个字段');
  });

  it('estimates Chinese and emoji costs without assuming a model context limit', () => {
    expect(estimateTokens([])).toBe(0);
    const english = estimateTokens([{ role: 'user', content: 'abcdef' }]);
    const chinese = estimateTokens([{ role: 'user', content: '中文字符测试' }]);
    expect(chinese).toBeGreaterThan(english);
    expect(estimateTokens([{ role: 'user', content: '🙂\n中文' }])).toBeGreaterThan(12);
  });
});
