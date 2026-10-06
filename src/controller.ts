import { randomUUID } from 'node:crypto';
import { Notice, type App } from 'obsidian';
import { Documents } from './documents';
import { candidateAfter, parseEdit } from './editing';
import { chat, listModels } from './provider';
import { buildMessages, estimateTokens } from './prompts';
import { Store } from './store';
import type { UIHost } from './ui-host';
import type { Candidate, DocumentRecord, EditScope, Message, Provider, RequestSnapshot, RunningRequest, Session, TaskMode } from './types';

export class Controller implements UIHost {
  running: RunningRequest | undefined;
  private listeners = new Set<() => void>();
  private testAbort: AbortController | undefined;
  private editing = new Set<string>();
  private closed = false;
  constructor(readonly app: App, readonly store: Store, readonly documents: Documents, readonly openSettings: () => void) {}
  get data() { return this.store.data; }
  target(): DocumentRecord | null { return this.documents.current(); }
  currentSession(): Session | null { const doc = this.target(); return doc ? this.store.sessionFor(doc) : null; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(): void { if (!this.closed) for (const listener of this.listeners) listener(); }
  async saveSettings(): Promise<void> { await this.store.save(); this.changed(); }
  private event(session: Session, content: string): void { session.messages.push({ id: randomUUID(), role: 'event', content, at: Date.now() }); }
  private requireSession(): Session { const session = this.currentSession(); if (!session) throw new Error('请先打开一篇 Markdown 文稿。'); return session; }
  private key(provider: Provider): string | undefined {
    if (!provider.secretRef) return undefined;
    const value = this.app.secretStorage.getSecret(provider.secretRef);
    if (!value) throw new Error('所选密钥不存在，请在设置中选择或创建密钥。');
    return value;
  }
  async send(input: string, mode: TaskMode, scope: EditScope): Promise<void> {
    if (!input.trim()) throw new Error('请输入本轮创作要求。');
    if (this.running) throw new Error('已有生成请求，请先等待完成或停止。');
    const session = this.requireSession();
    const configuredRole = this.data.roles.find(r => r.id === session.selectedRoleId);
    const configuredProvider = this.data.providers.find(p => p.id === this.data.activeProviderId);
    if (!configuredRole) throw new Error('请先选择或创建创作伙伴。');
    if (!configuredProvider?.model) throw new Error('请先在设置中配置连接并选择模型。');
    const role = structuredClone(configuredRole), provider = structuredClone(configuredProvider);
    const key = this.key(provider);
    const history = structuredClone(session.messages);
    const abort = new AbortController();
    const requestId = randomUUID();
    const reply: Message = { id: requestId, role: 'assistant', content: '', at: Date.now(), roleName: role.name, model: provider.model, providerName: provider.name, status: 'running' };
    session.mode = mode;
    session.messages.push({ id: randomUUID(), role: 'user', content: input, at: Date.now() }, reply);
    this.running = { id: requestId, documentId: session.document.id, path: session.document.path, sessionId: session.id, roleName: role.name, mode, text: '', stop: () => {
      // Invalidate identity before cancelling the network; late callbacks become inert.
      if (this.running?.id !== requestId) return;
      this.running = undefined;
      reply.status = 'stopped';
      this.event(session, '本轮已停止；未完成内容没有产生可应用改稿。');
      abort.abort();
      this.changed();
      void this.store.save().catch(e => new Notice(`停止状态保存失败：${String(e)}`));
    } };
    const preferences = this.data.preferences, brief = session.brief;
    this.changed();
    try {
      const document = await this.documents.snapshot(session.document, scope, mode === 'edit');
      if (this.running?.id !== requestId) return;
      const snapshot: RequestSnapshot = { ...document, requestId, sessionId: session.id, role, provider, input, mode, preferences, brief, history };
      const messages = buildMessages(snapshot);
      if (provider.contextLimit && estimateTokens(messages) + 1024 > provider.contextLimit) throw new Error('估算上下文加输出余量超过配置的模型容量。请更换模型、重新开始会话或调整材料；全文没有被截断。');
      await this.store.save();
      if (this.running?.id !== requestId) return;
      const result = await chat(provider, key, messages, chunk => {
        if (this.running?.id !== requestId || abort.signal.aborted) return;
        this.running.text += chunk;
        reply.content = this.running.text;
        this.changed();
      }, abort.signal);
      if (this.running?.id !== requestId || abort.signal.aborted || this.closed) return;
      if (result.finishReason !== 'stop' && result.finishReason !== 'done') throw new Error(`模型未正常完成（${result.finishReason || '未知结束状态'}），不能生成可应用改稿。`);
      if (mode === 'discuss' && !result.text.trim()) throw new Error('模型没有返回可用的讨论内容。请检查模型配置后重新发送。');
      this.documents.resolve(snapshot.documentId);
      reply.content = result.text;
      if (mode === 'edit') {
        const edit = parseEdit(result.text);
        const candidate: Candidate = {
          id: randomUUID(), requestId, documentId: snapshot.documentId, sessionId: session.id,
          path: this.documents.resolve(snapshot.documentId).path, scope: snapshot.scope, from: snapshot.from, to: snapshot.to,
          baseline: snapshot.fullText, baselineHash: snapshot.hash, ...edit, state: 'ready', deletion: false
        };
        candidateAfter(candidate);
        const latest = await this.documents.snapshot(session.document, 'body', false);
        if (this.running?.id !== requestId || abort.signal.aborted || this.closed) return;
        if (latest.fullText !== snapshot.fullText) candidate.state = 'stale';
        this.supersede(session);
        session.candidate = candidate;
        reply.candidateId = candidate.id;
        reply.content = this.editMessage(candidate);
        this.event(session, candidate.state === 'ready'
          ? '生成了一份尚未应用的候选修改；当前正文仍是文稿最新内容。'
          : '生成期间文稿已变化；新候选已失效，请基于最新文稿重新生成。');
      }
      reply.status = 'completed';
      this.running = undefined;
      this.changed();
      await this.store.save();
    } catch (error) {
      if (this.running?.id !== requestId) {
        if (reply.status === 'completed') throw new Error('生成已完成，但会话保存失败。请检查存储空间后重试保存。');
        return;
      }
      this.running = undefined;
      reply.status = 'failed';
      const reason = error instanceof Error ? error.message : '请求失败。';
      this.event(session, `本轮失败：${reason} 原文未改动。`);
      this.changed();
      await this.store.save();
      throw error;
    }
  }
  private editMessage(candidate: Candidate): string {
    return `${candidate.explanation}\n\n候选正文（${candidate.scope === 'selection' ? '选中部分' : '正文'}，尚未应用）：\n\n${candidate.replacement}${candidate.notes.length ? '\n\n待补充或核实：\n' + candidate.notes.map(n => `- ${n}`).join('\n') : ''}`;
  }
  private supersede(session: Session): void {
    if (session.candidate?.state === 'ready') {
      session.candidate.state = 'superseded'; this.event(session, '上一份候选已被新候选替代，未应用。');
    }
  }
  stop(): void { this.running?.stop(); }
  private candidateSession(candidate: Candidate): Session {
    const session = this.data.sessions[candidate.documentId];
    if (!session || session.id !== candidate.sessionId || session.candidate?.id !== candidate.id) throw new Error('这份候选已被替代或会话已重开。');
    return session;
  }
  async apply(candidate: Candidate): Promise<void> {
    const session = this.candidateSession(candidate);
    if (candidate.state !== 'ready') throw new Error('这份候选已经处理或失效。');
    if (this.editing.has(candidate.documentId)) throw new Error('此文稿正在应用或撤回修改，请稍后重试。');
    this.editing.add(candidate.documentId);
    candidate.state = 'applying'; this.changed();
    try {
      candidateAfter(candidate);
      if (session.document.id !== candidate.documentId) throw new Error('目标文稿身份不匹配，请重新生成。');
      await this.documents.applyRange(session.document, candidate.baseline, candidate.from, candidate.to, candidate.replacement);
      candidate.state = 'applied';
      if (session.candidate !== candidate && session.candidate?.state === 'ready') session.candidate.state = 'stale';
      session.undo = { documentId: candidate.documentId, path: this.documents.resolve(candidate.documentId).path, before: candidate.baseline, from: candidate.from, to: candidate.to, replacement: candidate.replacement, candidateId: candidate.id };
      this.event(session, `已应用候选 ${candidate.id}，范围：${candidate.scope === 'selection' ? '选中部分' : '正文'}。后续应以修改后的文稿为依据。`);
    } catch (error) {
      candidate.state = 'stale'; this.event(session, `候选已失效：${error instanceof Error ? error.message : '无法应用'}`); throw error;
    } finally { this.editing.delete(candidate.documentId); this.changed(); await this.store.save(); }
  }
  async discard(candidate: Candidate): Promise<void> {
    const session = this.candidateSession(candidate);
    if (candidate.state !== 'ready' && candidate.state !== 'stale') return;
    candidate.state = 'discarded';
    this.event(session, `已放弃候选 ${candidate.id}，这份建议没有写入文稿。`);
    await this.saveSettings();
  }
  async undo(): Promise<void> {
    const session = this.requireSession();
    const record = session.undo;
    if (!record) throw new Error('没有可撤回的最近 AI 修改。');
    if (this.editing.has(record.documentId)) throw new Error('此文稿正在应用或撤回修改，请稍后重试。');
    this.editing.add(record.documentId);
    // Claim the record synchronously to make repeated clicks harmless.
    session.undo = undefined;
    try {
      if (session.document.id !== record.documentId) throw new Error('撤回记录的文稿身份不匹配。');
      await this.documents.restoreRange(session.document, record);
      if (session.candidate?.id === record.candidateId) session.candidate.state = 'undone';
      else if (session.candidate?.state === 'ready') session.candidate.state = 'stale';
      this.event(session, `已撤回候选 ${record.candidateId}。正文已恢复至该次修改前版本。`);
    } catch (error) {
      if (!session.undo) session.undo = record;
      this.event(session, '撤回未执行：当前文稿已有后续变化，请查看旧版本或基于最新正文继续改稿。');
      throw error;
    } finally { this.editing.delete(record.documentId); this.changed(); await this.store.save(); }
  }
  async deleteRange(scope: EditScope): Promise<void> {
    if (this.running) throw new Error('请先停止或等待当前生成。');
    const session = this.requireSession();
    if (this.editing.has(session.document.id)) throw new Error('请等待此文稿的修改操作完成。');
    this.editing.add(session.document.id);
    try {
      const snapshot = await this.documents.snapshot(session.document, scope);
      if (snapshot.from === snapshot.to) throw new Error('当前范围为空，无需删除。');
      this.documents.resolve(session.document.id);
      this.supersede(session);
      const candidate: Candidate = { id: randomUUID(), requestId: randomUUID(), documentId: snapshot.documentId, sessionId: session.id, path: snapshot.path, scope: snapshot.scope, from: snapshot.from, to: snapshot.to, baseline: snapshot.fullText, baselineHash: snapshot.hash, replacement: '', explanation: '删除当前范围（仅在差异预览确认后执行）', notes: [], state: 'ready', deletion: true };
      session.candidate = candidate;
      this.event(session, '用户明确创建了删除候选，尚未应用。');
      await this.saveSettings();
    } finally { this.editing.delete(session.document.id); this.changed(); }
  }
  async clearSession(): Promise<void> {
    const session = this.requireSession();
    if (this.editing.has(session.document.id)) throw new Error('请等待此文稿的修改操作完成后再清空会话。');
    if (this.running?.documentId === session.document.id) this.stop();
    this.store.clear(session); await this.saveSettings();
  }
  async chooseRole(roleId: string): Promise<void> {
    const session = this.requireSession(); const role = this.data.roles.find(r => r.id === roleId);
    if (!role) throw new Error('创作伙伴不存在。');
    session.selectedRoleId = role.id; session.mode = role.defaultMode; await this.saveSettings();
  }
  async setBrief(brief: string): Promise<void> { this.requireSession().brief = brief; await this.saveSettings(); }
  async models(provider: Provider) { return listModels(structuredClone(provider), this.key(provider)); }
  async testProvider(provider: Provider): Promise<string> {
    if (this.running) throw new Error('已有生成请求，请等待完成或停止后测试。');
    if (!provider.model.trim()) throw new Error('请先选择模型或在高级选项填写模型 ID。');
    const abort = new AbortController(); this.testAbort = abort;
    const id = randomUUID();
    this.running = { id, documentId: '', path: '连接测试（不发送文稿）', sessionId: '', roleName: '连接测试', mode: 'discuss', text: '', stop: () => { if (this.running?.id === id) this.running = undefined; abort.abort(); this.changed(); } };
    this.changed();
    try {
      const result = await chat(structuredClone(provider), this.key(provider), [{ role: 'user', content: '这是连接测试，请简短回复：连接成功。' }], chunk => { if (this.running?.id === id) { this.running.text += chunk; this.changed(); } }, abort.signal);
      if (abort.signal.aborted) throw new Error('测试已停止。');
      if (result.finishReason !== 'stop' && result.finishReason !== 'done') throw new Error(`连接测试未正常完成（${result.finishReason || '未知结束状态'}），请检查模型配置后重试。`);
      if (!result.text.trim()) throw new Error('连接测试没有返回正文，不能确认聊天调用成功。请检查模型配置后重试。');
      return result.text;
    } finally { if (this.running?.id === id) this.running = undefined; this.testAbort = undefined; this.changed(); }
  }
  close(): void {
    const running = this.running;
    this.closed = true;
    this.stop(); this.testAbort?.abort();
    if (running?.documentId) {
      const session = this.data.sessions[running.documentId];
      const reply = session?.messages.find(message => message.id === running.id);
      if (session && reply) {
        reply.status = 'interrupted';
        this.event(session, '插件关闭使上次生成中断；不会自动重发，未完成内容不能应用。');
        void this.store.save().catch(() => undefined);
      }
    }
    this.listeners.clear();
  }
}
