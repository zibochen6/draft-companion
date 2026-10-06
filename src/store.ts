import { createDefaultRoles, DEFAULT_PREFERENCES } from './roles';
import type { DocumentRecord, Message, PluginData, Session } from './types';

export const DATA_VERSION = 1;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`稿伴数据损坏：${label} 应为对象。原数据未覆盖。`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`稿伴数据格式不兼容：${label} 含未知字段。原数据未覆盖。`);
}

function string(value: unknown, label: string, nonempty = false): void {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) throw new Error(`稿伴数据损坏：${label} 应为${nonempty ? '非空' : ''}文本。原数据未覆盖。`);
}

function number(value: unknown, label: string, minimum = 0): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(`稿伴数据损坏：${label} 数值无效。原数据未覆盖。`);
}

function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`稿伴数据损坏：${label} 应为布尔值。原数据未覆盖。`);
}

function enumeration(value: unknown, allowed: string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`稿伴数据损坏：${label} 状态无效。原数据未覆盖。`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`稿伴数据损坏：${label} 应为列表。原数据未覆盖。`);
  return value;
}

function strings(value: unknown, label: string): void {
  for (const item of array(value, label)) string(item, label);
}

function document(value: unknown): Record<string, unknown> {
  const data = object(value, '文稿关联');
  keys(data, ['id', 'path', 'ctime', 'deleted'], '文稿关联');
  string(data.id, '文稿 ID', true);
  string(data.path, '文稿路径', true);
  number(data.ctime, '文稿创建时间');
  if (data.deleted !== undefined) boolean(data.deleted, '文稿删除状态');
  return data;
}

function offsets(data: Record<string, unknown>, text: unknown): void {
  number(data.from, '编辑起点'); number(data.to, '编辑终点');
  if (!Number.isInteger(data.from) || !Number.isInteger(data.to) || (data.from as number) > (data.to as number) || (data.to as number) > (text as string).length) {
    throw new Error('稿伴数据损坏：编辑范围越界。原数据未覆盖。');
  }
}

/** Refuse corrupt/future data before the caller can save over the original. */
function validate(raw: unknown): asserts raw is PluginData {
  const data = object(raw, '配置');
  if (data.version !== DATA_VERSION) throw new Error('稿伴数据版本不受此版本插件支持。请保留原数据并使用匹配的插件版本；原数据未覆盖。');
  keys(data, ['version', 'initialized', 'providers', 'activeProviderId', 'roles', 'preferences', 'sessions'], '配置');
  boolean(data.initialized, '初始化状态'); string(data.activeProviderId, '当前连接'); string(data.preferences, '全局偏好');
  const providerIds = new Set<string>();
  for (const item of array(data.providers, '连接')) {
    const provider = object(item, '连接');
    keys(provider, ['id', 'name', 'baseUrl', 'secretRef', 'model', 'stream', 'timeoutMs', 'contextLimit'], '连接');
    for (const key of ['id', 'name', 'baseUrl', 'secretRef', 'model']) string(provider[key], '连接字段', key === 'id');
    boolean(provider.stream, '流式设置'); number(provider.timeoutMs, '超时', 1);
    if (provider.contextLimit !== undefined) number(provider.contextLimit, '上下文上限', 1);
    if (providerIds.has(provider.id as string)) throw new Error('稿伴数据损坏：连接 ID 重复。原数据未覆盖。');
    providerIds.add(provider.id as string);
  }
  const roleIds = new Set<string>();
  for (const item of array(data.roles, '创作伙伴')) {
    const role = object(item, '创作伙伴');
    keys(role, ['id', 'name', 'description', 'systemPrompt', 'defaultMode', 'quickTasks'], '创作伙伴');
    for (const key of ['id', 'name', 'description', 'systemPrompt']) string(role[key], '创作伙伴字段', key === 'id');
    enumeration(role.defaultMode, ['discuss', 'edit'], '默认方式'); strings(role.quickTasks, '快捷任务');
    if (roleIds.has(role.id as string)) throw new Error('稿伴数据损坏：创作伙伴 ID 重复。原数据未覆盖。');
    roleIds.add(role.id as string);
  }
  const sessions = object(data.sessions, '会话');
  const sessionIds = new Set<string>();
  for (const [documentId, value] of Object.entries(sessions)) {
    const session = object(value, '会话');
    keys(session, ['id', 'document', 'brief', 'selectedRoleId', 'mode', 'messages', 'candidate', 'undo'], '会话');
    string(session.id, '会话 ID', true); string(session.brief, '本文要求'); string(session.selectedRoleId, '所选角色');
    enumeration(session.mode, ['discuss', 'edit'], '会话方式');
    const doc = document(session.document);
    if (doc.id !== documentId || sessionIds.has(session.id as string)) throw new Error('稿伴数据损坏：会话与文稿关联无效。原数据未覆盖。');
    sessionIds.add(session.id as string);
    for (const item of array(session.messages, '会话消息')) {
      const message = object(item, '消息');
      keys(message, ['id', 'role', 'content', 'at', 'roleName', 'model', 'providerName', 'status', 'candidateId'], '消息');
      string(message.id, '消息 ID', true); string(message.content, '消息内容'); number(message.at, '消息时间');
      enumeration(message.role, ['user', 'assistant', 'event'], '消息角色');
      for (const key of ['roleName', 'model', 'providerName', 'candidateId']) if (message[key] !== undefined) string(message[key], '消息信息');
      if (message.status !== undefined) enumeration(message.status, ['running', 'completed', 'stopped', 'failed', 'interrupted'], '消息状态');
    }
    if (session.candidate !== undefined) {
      const candidate = object(session.candidate, '候选');
      keys(candidate, ['id', 'requestId', 'documentId', 'sessionId', 'path', 'scope', 'from', 'to', 'baseline', 'baselineHash', 'replacement', 'explanation', 'notes', 'state', 'deletion'], '候选');
      for (const key of ['id', 'requestId', 'documentId', 'sessionId', 'path', 'baseline', 'baselineHash', 'replacement', 'explanation']) string(candidate[key], '候选字段', ['id', 'requestId', 'documentId', 'sessionId', 'path'].includes(key));
      strings(candidate.notes, '候选说明'); boolean(candidate.deletion, '删除候选');
      enumeration(candidate.scope, ['body', 'selection'], '候选范围');
      enumeration(candidate.state, ['ready', 'applying', 'applied', 'discarded', 'superseded', 'stale', 'undone'], '候选状态');
      offsets(candidate, candidate.baseline);
      if (candidate.documentId !== doc.id || candidate.sessionId !== session.id) throw new Error('稿伴数据损坏：候选与文稿或会话关联无效。原数据未覆盖。');
    }
    if (session.undo !== undefined) {
      const undo = object(session.undo, '撤回记录');
      keys(undo, ['documentId', 'path', 'before', 'from', 'to', 'replacement', 'candidateId'], '撤回记录');
      for (const key of ['documentId', 'path', 'before', 'replacement', 'candidateId']) string(undo[key], '撤回字段', ['documentId', 'path', 'candidateId'].includes(key));
      offsets(undo, undo.before);
      if (undo.documentId !== doc.id) throw new Error('稿伴数据损坏：撤回记录关联无效。原数据未覆盖。');
    }
  }
}

function event(content: string, candidateId?: string): Message {
  return { id: crypto.randomUUID(), role: 'event', content, at: Date.now(), ...(candidateId ? { candidateId } : {}) };
}

export class Store {
  readonly data: PluginData;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(raw: unknown, private readonly persist: (data: PluginData) => Promise<void>) {
    if (raw === null || raw === undefined) {
      this.data = {
        version: DATA_VERSION, initialized: true, providers: [], activeProviderId: '',
        roles: createDefaultRoles(), preferences: DEFAULT_PREFERENCES, sessions: {},
      };
      return;
    }
    validate(raw);
    this.data = clone(raw);
    for (const session of Object.values(this.data.sessions)) {
      let interrupted = false;
      for (const message of session.messages) {
        if (message.status === 'running') { message.status = 'interrupted'; interrupted = true; }
      }
      if (interrupted) session.messages.push(event('上次生成因插件关闭或重启而中断；未自动重发，未产生可应用的新候选。'));
      if (session.candidate?.state === 'applying') {
        session.candidate.state = 'stale';
        session.messages.push(event('上次候选应用过程被中断，写回状态无法确认；候选已失效，请检查当前正文后重新生成。', session.candidate.id));
      }
      if (session.document.deleted) {
        if (session.candidate) session.candidate.state = 'stale';
        delete session.undo;
      }
    }
  }

  /** Each call owns its exact deep snapshot; a failed save does not block later saves. */
  save(): Promise<void> {
    const snapshot = clone(this.data);
    const save = this.saveQueue.then(() => this.persist(snapshot));
    this.saveQueue = save.catch(() => undefined);
    return save;
  }

  sessionFor(documentRecord: DocumentRecord): Session {
    const existing = Object.prototype.hasOwnProperty.call(this.data.sessions, documentRecord.id)
      ? this.data.sessions[documentRecord.id] : undefined;
    if (existing) {
      existing.document = { ...documentRecord };
      if (existing.candidate) existing.candidate.path = documentRecord.path;
      if (existing.undo) existing.undo.path = documentRecord.path;
      if (documentRecord.deleted) {
        if (existing.candidate) existing.candidate.state = 'stale';
        delete existing.undo;
      }
      return existing;
    }
    const role = this.data.roles[0];
    const session: Session = {
      id: crypto.randomUUID(), document: { ...documentRecord }, brief: '', selectedRoleId: role?.id ?? '',
      mode: role?.defaultMode ?? 'discuss', messages: [],
    };
    // defineProperty also makes an unexpected '__proto__' document ID harmless.
    Object.defineProperty(this.data.sessions, documentRecord.id, { value: session, enumerable: true, writable: true, configurable: true });
    return session;
  }

  clear(session: Session): void {
    const candidateId = session.candidate?.id;
    if (session.candidate) session.candidate.state = 'discarded';
    delete session.candidate;
    session.messages = [event(candidateId
      ? '已重新开始当前文稿会话；旧讨论已清空，当前候选已放弃。本文要求、正文和最近一次 AI 改稿撤回记录保留。'
      : '已重新开始当前文稿会话；本文要求、正文和最近一次 AI 改稿撤回记录保留。', candidateId)];
  }
}
