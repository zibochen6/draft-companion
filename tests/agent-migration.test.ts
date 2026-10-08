import { describe, expect, it, vi } from 'vitest';
import type { AgentActionReceipt } from '../src/agent-types';
import { DATA_VERSION, Store } from '../src/store';
import type { PluginData, Session } from '../src/types';

function action(session: Session, state: AgentActionReceipt['state'] = 'applied'): AgentActionReceipt {
  const before = '甲原文乙';
  const replacement = '新句';
  const target = state === 'applied' ? replacement : state === 'undone' ? before : '原文';
  return {
    id: 'agent-action', requestId: 'agent-request', documentId: session.document.id, path: session.document.path, at: 1,
    kind: 'replace', label: '替换原句', before, replacement,
    anchor: { from: 10_000, to: 10_000 + target.length, text: target, valid: true },
    beforeHash: 'before', afterHash: 'after', state,
  };
}

function currentStore(): { store: Store; session: Session } {
  const store = new Store(null, async () => {});
  const session = store.sessionFor({ id: 'document-a', path: '文章/A.md', ctime: 1 });
  return { store, session };
}

describe('schema 3 migration and persisted agent actions', () => {
  it.each([1, 2])('backs up a valid schema %i byte-for-byte before upgrading it to schema 3', async version => {
    const { store, session } = currentStore();
    session.messages.push({ id: 'old-message', role: 'user', content: '保留旧会话', at: 1 });
    const legacy = structuredClone(store.data) as PluginData & { version: number };
    legacy.version = version; delete legacy.dailyTopics;
    const before = JSON.stringify(legacy);
    let backup = '';
    const migrated = await Store.migrate(legacy, async () => { backup = JSON.stringify(legacy); }) as PluginData;
    expect(backup).toBe(before);
    expect(legacy.version).toBe(version);
    expect(migrated.version).toBe(DATA_VERSION);
    expect(migrated.sessions['document-a']!.messages[0]!.content).toBe('保留旧会话');
    expect(new Store(migrated, async () => {}).data.sessions['document-a']!.document.path).toBe('文章/A.md');
  });

  it('rejects invalid legacy fields before calling the backup callback', async () => {
    const { store } = currentStore();
    const legacy = structuredClone(store.data) as PluginData & { version: number; untrusted?: string };
    legacy.version = 2; delete legacy.dailyTopics;
    legacy.untrusted = 'forbidden';
    const backup = vi.fn(async () => {});
    await expect(Store.migrate(legacy, backup)).rejects.toThrow('未知字段');
    expect(backup).not.toHaveBeenCalled();
  });

  it.each([1, 2])('rejects schema %i document native identity before migration backup', async version => {
    const { store, session } = currentStore();
    const legacy = structuredClone(store.data) as PluginData & { version: number };
    legacy.version = version; delete legacy.dailyTopics;
    (legacy.sessions[session.document.id]!.document as unknown as Record<string, unknown>).nativeId = 'dev:1:ino:2:birth:3';
    const backup = vi.fn(async () => {});
    await expect(Store.migrate(legacy, backup)).rejects.toThrow('未知字段');
    expect(backup).not.toHaveBeenCalled();
  });

  it.each([1, 2])('rejects schema %i undo needs-check state before migration backup', async version => {
    const { store, session } = currentStore();
    const legacy = structuredClone(store.data) as PluginData & { version: number };
    legacy.version = version; delete legacy.dailyTopics;
    legacy.sessions[session.document.id]!.undo = {
      documentId: session.document.id, path: session.document.path, before: '原文', from: 0, to: 1, replacement: '新', candidateId: 'old-candidate',
    };
    (legacy.sessions[session.document.id]!.undo as unknown as Record<string, unknown>).needsCheck = true;
    const backup = vi.fn(async () => {});
    await expect(Store.migrate(legacy, backup)).rejects.toThrow('未知字段');
    expect(backup).not.toHaveBeenCalled();
  });

  it('accepts optional schema 3 native identities on sessions and the topic library', () => {
    const { store, session } = currentStore();
    const nativeId = 'dev:1:ino:2:birth:3';
    (session.document as unknown as Record<string, unknown>).nativeId = nativeId;
    store.data.topicLibrary = { id: 'topics', path: '资料/选题.md', ctime: 2 };
    (store.data.topicLibrary as unknown as Record<string, unknown>).nativeId = nativeId;
    const restored = new Store(store.data, async () => {}).data;
    expect(restored.sessions[session.document.id]!.document).toMatchObject({ nativeId });
    expect(restored.topicLibrary).toMatchObject({ nativeId });
  });

  it('accepts the schema 3 undo needs-check marker', () => {
    const { store, session } = currentStore();
    session.undo = { documentId: session.document.id, path: session.document.path, before: '原文', from: 0, to: 1, replacement: '新', candidateId: 'old-candidate', needsCheck: true };
    expect(new Store(store.data, async () => {}).data.sessions[session.document.id]!.undo).toMatchObject({ needsCheck: true });
  });

  it('strictly validates schema 3 action receipts, message links, and optional provider capabilities', () => {
    const persist = vi.fn(async () => {});
    const { store, session } = currentStore();
    store.data.providers.push({ id: 'provider-a', name: '服务', baseUrl: 'https://example.test/v1', secretRef: '', model: 'model', stream: true, timeoutMs: 20, toolMode: 'native' });
    const capability = 'a'.repeat(64);
    store.data.toolCapabilities = { [capability]: 'native' };
    store.data.topicLibrary = { id: 'topics', path: '资料/选题.md', ctime: 2 };
    session.agentActions = [action(session)];
    session.messages.push({ id: 'tool-message', role: 'assistant', content: '已执行工具。', at: 2, presentation: 'tool', actionIds: ['agent-action'] });
    expect(new Store(store.data, persist).data.sessions['document-a']!.agentActions).toHaveLength(1);

    const unknownAction = structuredClone(store.data);
    (unknownAction.sessions['document-a']!.agentActions![0] as unknown as Record<string, unknown>).secret = 'forbidden';
    expect(() => new Store(unknownAction, persist)).toThrow('未知字段');

    const unlinkedMessage = structuredClone(store.data);
    unlinkedMessage.sessions['document-a']!.messages.at(-1)!.actionIds = ['not-a-receipt'];
    expect(() => new Store(unlinkedMessage, persist)).toThrow('消息操作关联无效');

    const invalidCapability = structuredClone(store.data);
    invalidCapability.toolCapabilities = { foreign: 'native' };
    expect(() => new Store(invalidCapability, persist)).toThrow('工具能力缓存键无效');
    expect(persist).not.toHaveBeenCalled();
  });

  it('turns prepared receipts into needs-check on restart and never resumes an interrupted message', () => {
    const { store, session } = currentStore();
    session.agentActions = [action(session, 'prepared')];
    session.messages.push({ id: 'running', role: 'assistant', content: '部分输出', at: 1, status: 'running', presentation: 'tool', actionIds: ['agent-action'] });
    const restored = new Store(store.data, async () => {});
    const restoredSession = restored.data.sessions['document-a']!;
    expect(restoredSession.agentActions![0]!.state).toBe('needs-check');
    expect(restoredSession.agentActions![0]!.invalidReason).toContain('未自动重发');
    expect(restoredSession.messages.find(message => message.id === 'running')!.status).toBe('interrupted');
    expect(restoredSession.messages.filter(message => message.role === 'event')).toHaveLength(1);
    const restarted = new Store(restored.data, async () => {}).data.sessions['document-a']!;
    expect(restarted.messages.filter(message => message.role === 'event')).toHaveLength(1);
    expect(session.agentActions![0]!.state).toBe('prepared');
  });

  it('invalidates action receipts when their document is deleted while retaining them for inspection', () => {
    const { store, session } = currentStore();
    session.agentActions = [action(session, 'undone')];
    const existing = store.sessionFor({ ...session.document, deleted: true });
    expect(existing.agentActions).toHaveLength(1);
    expect(existing.agentActions![0]!.state).toBe('needs-check');
    expect(existing.agentActions![0]!.invalidReason).toContain('已删除');
  });

  it('accepts a receipt mapped near the end of a long document without treating its local before text as a full baseline', () => {
    const { store, session } = currentStore();
    const receipt = action(session, 'applied');
    receipt.beforeContext = { from: 9_960, to: 9_964, text: '无关前文', valid: false };
    receipt.afterContext = { from: 10_020, to: 10_024, text: '无关后文', valid: false };
    session.agentActions = [receipt];
    const restored = new Store(store.data, async () => {}).data.sessions['document-a']!;
    expect(restored.agentActions![0]!.anchor).toEqual(receipt.anchor);
    expect(restored.agentActions![0]!.before).toBe('甲原文乙');
  });
});
