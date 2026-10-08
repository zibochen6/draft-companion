import { randomUUID } from 'node:crypto';
import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { ChatMessage, ChatResult, DocumentRecord, PluginData, Provider, Role, RunningRequest } from './types';
import type { ChangeKind, TextChange } from './review-types';
import type { DailyTopicData, DailyTopicRun, DailyTopicSettings, TopicBatchReceipt } from './daily-types';
import { defaultDailyTopicData } from './daily-types';
import { Documents } from './documents';
import { Store } from './store';
import { chat } from './provider';
import { estimateTokens } from './prompts';
import { runDailyPipeline, type DailyPipelineResult } from './daily-pipeline';
import { canonicalRepository, normalizeSourceUrl, SourceResponseCache } from './daily-sources';
import type { SourceOptions } from './daily-sources';
import { planDailyTopicUpdate, planDailyTopicRecount, applyDailyChanges } from './daily-notes';
import { makeTopicBatchReceipt, mapTopicReceipts, reconcileTopicReceipts, planTopicBatchUndo, canUndoTopicBatch, finishTopicBatchUndo } from './daily-receipts';
import { DailyTopicScheduler, shanghaiDate } from './daily-scheduler';
import { renderSafeMarkdown } from './render';
import { hashText } from './editing';
import { planDailyTopicReformat, type DailyTopicReformatResult, type DailyTopicReformatDiagnostics } from './daily-format';

export interface DailyRunnerHost {
  app: App; store: Store; documents: Documents; data: PluginData;
  running: RunningRequest | undefined; editing: Set<string>;
  changed(): void; key(provider: Provider): string | undefined;
}
interface FrozenJob {
  ready: boolean;
  run: DailyTopicRun; document: DocumentRecord; settings: DailyTopicSettings;
  provider: Provider; role: Role; preferences: string;
}
export interface DailyRunnerDependencies {
  pipeline?: typeof runDailyPipeline;
  chat?: (provider: Provider, key: string | undefined, messages: ChatMessage[], signal: AbortSignal) => Promise<ChatResult>;
  sourceOptions?: SourceOptions;
}

/** A fixed-target job, independent of chat drafts, sidebar tabs and editor selections. */
export class DailyTopicRunner {
  scheduler?: DailyTopicScheduler;
  dependencies: DailyRunnerDependencies = {};
  private pending?: FrozenJob;
  private active?: { job: FrozenJob; abort: AbortController };
  private closed = false;
  private pumping = false;
  private writingReceipt?: string;
  private undoingReceipt?: string;
  private previewStop?: () => void;
  private readonly sourceCache = new SourceResponseCache();
  private reformatting = false;
  constructor(private host: DailyRunnerHost) {}
  private effectiveSourceOptions(githubFallback: boolean): SourceOptions {
    return { ...this.dependencies.sourceOptions, cache: this.dependencies.sourceOptions?.cache ?? this.sourceCache, githubFallback };
  }
  /** A second pane can echo a committed transaction on the next editor update. Only
   * that known buffer conflict gets a bounded read-only wait; no write is replayed. */
  private async verifyCommittedText(document: DocumentRecord, expected: string, mismatchMessage: string): Promise<void> {
    const deadline = Date.now() + 1000;
    let waits = 0;
    for (;;) {
      try {
        const actual = await this.host.documents.read(document);
        if (actual !== expected) throw new Error(mismatchMessage);
        return;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!(error instanceof Error) || error.message !== '同一文稿的编辑缓冲不一致，请先同步或关闭重复视图。' || remaining <= 0 || waits >= 20) throw error;
        waits++;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, remaining)));
      }
    }
  }
  get data(): DailyTopicData { return this.host.data.dailyTopics ??= defaultDailyTopicData(); }
  status(): DailyTopicRun | undefined { return this.active?.job.run ?? this.pending?.run ?? this.data.runs.at(-1); }
  async start(origin: 'manual' | 'scheduled' = 'manual', date = shanghaiDate(Date.now())): Promise<void> {
    if (this.closed) throw new Error('插件已关闭。');
    if (this.reformatting) throw new Error('选题库正在整理，请稍后再启动采集。');
    if (this.active || this.pending) return;
    const document = this.host.data.topicLibrary;
    if (!document || document.deleted) throw new Error('请在“每日选题”设置中绑定选题库。');
    this.host.documents.resolve(document.id);
    const settings = structuredClone(this.data.settings);
    const provider = this.host.data.providers.find(p => p.id === (settings.providerId || this.host.data.activeProviderId));
    const role = this.host.data.roles.find(r => r.id === (settings.roleId || 'topic-editor')) ?? (!settings.roleId ? this.host.data.roles[0] : undefined);
    if (!provider?.model || !role) throw new Error('请在“每日选题”设置中选择可用的服务、模型和伙伴。');
    // Verify the official key reference without persisting its value into a job.
    this.host.key(provider);
    const run: DailyTopicRun = { id: randomUUID(), date, origin, status: 'queued', stage: this.host.running ? '等待当前聊天结束' : '准备开始', documentId: document.id, path: document.path, startedAt: Date.now(), sources: [], cards: [] };
    this.data.runs.push(run);
    const job: FrozenJob = { ready: false, run, document: { ...document }, settings, provider: structuredClone(provider), role: structuredClone(role), preferences: this.host.data.preferences };
    this.pending = job;
    try { await this.host.store.save(); }
    catch (error) { if(this.pending===job)this.pending=undefined;run.status='failed';run.stage='任务记录保存失败';throw error; }
    if(this.pending!==job)return; // Stopped while the queued record was being saved.
    job.ready=true;
    this.host.changed();
    await this.pump();
  }
  /** Called when the shared generation owner becomes idle. */
  async pump(): Promise<void> {
    if (this.closed || this.reformatting || this.pumping || this.host.running || !this.pending?.ready) return;
    const job = this.pending; this.pending = undefined; this.pumping = true;
    const abort = new AbortController(); this.active = { job, abort };
    const { run, document, provider } = job;
    const assertActive = () => {
      if (this.closed || abort.signal.aborted || this.host.running?.id !== run.id) throw new Error('选题任务已停止，未提交的内容不会写入。');
      this.scheduler?.assertLease();
    };
    const progress = (stage: string) => {
      assertActive(); run.stage = stage;
      run.status = stage.includes('采集') ? 'collecting' : stage.includes('读取') ? 'reading' : stage.includes('准备') ? 'preparing' : 'screening';
      this.host.running!.stage = stage; this.host.changed();
    };
    let committed = false, receipt: TopicBatchReceipt | undefined;
    try {
      if (this.scheduler && !this.scheduler.claim()) throw new Error('另一个窗口正在选题，请稍后重试。');
      const session = this.host.store.sessionFor(document);
      this.host.running = { id: run.id, origin: 'daily', documentId: document.id, path: document.path, sessionId: session.id, roleName: job.role.name, mode: 'discuss', text: '', stage: '采集中', stop: () => this.stop() };
      progress('采集中');
      const text = await this.host.documents.read(document); assertActive();
      const existing = new Map(Object.entries(this.data.seen).map(([id, seen]) => [id, seen.fingerprint]));
      const protectedIds = new Set(Object.entries(this.data.seen).filter(([, record]) => record.selected).map(([id]) => id));
      for(const previous of this.data.receipts.filter(receipt=>receipt.documentId===document.id))for(const block of previous.blocks){
        const marker=`<!-- draft-companion:topic:${block.id}:start -->`, from=text.indexOf(marker);
        if(previous.state==='undone'||previous.state==='needs-check'||from<0||text.indexOf(marker,from+marker.length)>=0||text.slice(from,from+block.anchor.text.length)!==block.anchor.text)
          protectedIds.add(block.canonicalId);
      }
      // Existing authored lists are used only locally for deduplication.
      for (const match of text.matchAll(/https?:\/\/[^\s<>\)]+/g)) {
        const repo = canonicalRepository(match[0]);
        if (repo && !existing.has(`repository:${repo}`)) existing.set(`repository:${repo}`, '*');
        try { const url = normalizeSourceUrl(match[0]); if (!existing.has(url)) existing.set(url, '*'); if (!existing.has(`news:${url}`)) existing.set(`news:${url}`, '*'); } catch { /* prose is not a URL registry */ }
      }
      const profile = [`作者背景：${job.settings.authorBackground || '未提供'}`, `目标读者：${job.settings.targetReader}`, `兴趣：${job.settings.interests}`, `排除：${job.settings.exclusions || '无'}`].join('\n');
      const result = await (this.dependencies.pipeline ?? runDailyPipeline)({
        profile, preferences: job.preferences, roleRules: job.role.systemPrompt, signal: abort.signal, existing,
        existingSelected: protectedIds,
        onStage: progress, assertActive,
        sourceOptions: this.effectiveSourceOptions(job.settings.githubFallback),
        chat: async messages => {
          assertActive();
          if (provider.contextLimit && estimateTokens(messages) + 4096 > provider.contextLimit) throw new Error('选题材料超过配置的模型容量，请更换模型或调整容量；没有截断文稿。');
          const value = await (this.dependencies.chat ? this.dependencies.chat(provider, this.host.key(provider), messages, abort.signal)
            : chat(provider, this.host.key(provider), messages, () => undefined, abort.signal));
          assertActive(); return value;
        },
      });
      assertActive(); run.sources = result.sources; run.cards = result.cards;
      run.entries = result.items.filter(item => result.cards.some(card => card.sourceId === item.id)).map(item => ({ sourceId: item.id, title: item.title, url: item.url, source: item.source }));
      const entries = result.cards.map(card => ({ card, item: result.items.find(item => item.id === card.sourceId)! }));
      if (entries.some(entry => !entry.item)) throw new Error('选题结果与来源不一致，未写入。');
      progress('准备写入');
      if (this.host.editing.has(document.id)) throw new Error('选题库正在进行其他写入，请稍后重试。');
      this.host.editing.add(document.id);
      try {
        const before = await this.host.documents.read(document); assertActive();
        const plan = planDailyTopicUpdate(before, run.date, Date.now(), result.sources, entries, run.id);
        if (plan.changes.length) {
          run.status = 'committing'; run.stage = '准备写入';
          receipt = plan.blocks.length ? makeTopicBatchReceipt(document, run.id, before, plan, run.date, Date.now()) : undefined;
          if (receipt) { this.data.receipts.push(receipt); run.receiptId = receipt.id; }
          await this.host.store.save(); assertActive();
          this.writingReceipt = receipt?.id;
          await this.host.documents.applyChangesValidated(document, before, plan.changes, current => {
            assertActive();
            // Rebuild inside the final synchronous callback to detect changed markers.
            const verified = planDailyTopicUpdate(current, run.date, receipt?.at ?? Date.now(), result.sources, entries, run.id);
            if (plan.blocks.length && !verified.blocks.length) throw new Error('这些选题已经写入，本次不会重复添加。');
          });
          committed = true;
          await this.verifyCommittedText(document, plan.after, '写入后文稿又有变化，请查看已写入的选题记录。');
          if (receipt) receipt.state = 'applied';
        }
        for (const observation of result.observations) {
          const item = result.items.find(item => item.canonicalId === observation.canonicalId);
          const card = item && result.cards.find(card => card.sourceId === item.id);
          this.data.seen[observation.canonicalId] = { fingerprint: observation.fingerprint, selected: card?.selected ?? this.data.seen[observation.canonicalId]?.selected ?? false, runId: run.id, at: Date.now() };
        }
        run.status = plan.blocks.length ? 'completed' : 'no-new'; run.stage = '已完成'; run.completedAt = Date.now();
        run.message = plan.blocks.length ? `已新增 ${plan.countCandidates} 个候选，其中 ${plan.countSelected} 个优选已勾选。` : '没有新增选题；已有条目和勾选保持不变。';
        if (plan.blocks.length) session.messages.push({ id: randomUUID(), role: 'event', content: `自动选题：${run.message}`, at: Date.now() });
        await this.host.store.save();
      } finally { this.host.editing.delete(document.id); this.writingReceipt = undefined; }
    } catch (error) {
      if (Array.isArray((error as { sources?: unknown })?.sources)) run.sources = (error as { sources: DailyTopicRun['sources'] }).sources;
      if (committed) {
        run.status = 'completed'; run.stage = '已修改，记录待检查'; run.completedAt = Date.now();
        run.message = '已写入，记录保存或结果确认失败；请检查选题库，不要重复执行。';
      } else if (abort.signal.aborted || this.closed) { run.status = this.closed ? 'interrupted' : 'stopped'; run.stage = '已停止'; }
      else { run.status = 'failed'; run.stage = '选题失败'; run.error = error instanceof Error ? error.message : '选题失败。'; }
      if (receipt && (!committed || receipt.state === 'prepared')) {
        receipt.state = 'needs-check';
        receipt.invalidReason = committed ? '已写入，但编辑缓冲或结果版本无法确认；请检查正文，不会重复提交。' : '本次提交未完成，请检查正文；不会自动重放。';
      }
      try { await this.host.store.save(); } catch { run.message = committed ? '已写入，记录保存失败；不要重复执行。' : '任务状态保存失败，请检查存储空间。'; }
      if (!abort.signal.aborted && !this.closed) new Notice(run.message || run.error || '选题未完成。', 8000);
    } finally {
      if (this.host.running?.id === run.id) this.host.running = undefined;
      this.active = undefined; this.pumping = false; this.scheduler?.release(); this.host.changed();
    }
  }
  stop(): void {
    this.previewStop?.();
    if (this.pending) { this.pending.run.status = 'stopped'; this.pending.run.stage = '已取消排队'; this.pending = undefined; }
    if (this.active) {
      if (this.host.running?.id === this.active.job.run.id) this.host.running = undefined;
      this.active.abort.abort();
    }
    this.host.changed(); void this.host.store.save().catch(() => undefined);
  }
  /** Diagnostic acceptance uses the production public-source/model path, with zero document writes. */
  async preview(): Promise<DailyPipelineResult> {
    if(this.closed || this.reformatting || this.host.running || this.pending || this.active || this.pumping)throw new Error('请先等待当前任务完成。');
    const settings=structuredClone(this.data.settings);
    const provider=this.host.data.providers.find(p=>p.id===(settings.providerId||this.host.data.activeProviderId));
    const role=this.host.data.roles.find(r=>r.id===(settings.roleId||'topic-editor')) ?? this.host.data.roles[0];
    if(!provider?.model || !role)throw new Error('请先配置服务、模型与选题伙伴。');
    const frozen=structuredClone(provider), abort=new AbortController(), id=randomUUID();
    if(this.scheduler && !this.scheduler.claim())throw new Error('另一个窗口正在选题。');
    const active=()=>{if(this.closed||abort.signal.aborted||this.host.running?.id!==id)throw new Error('验证已停止。');this.scheduler?.assertLease();};
    this.previewStop=()=>{if(this.host.running?.id===id)this.host.running=undefined;abort.abort();this.host.changed();};
    this.host.running={id,origin:'daily',documentId:'',path:'公开来源只读验证',sessionId:'',roleName:role.name,mode:'discuss',text:'',stop:this.previewStop};
    try{
      return await runDailyPipeline({signal:abort.signal,assertActive:active,
        profile:'作者背景：AI 实践创作者\n目标读者：希望把 AI 用到实际工作中的中文读者\n兴趣：AI 实用工具、Agent、知识管理、内容创作、可复用工作流\n排除：无',
        roleRules:role.systemPrompt,sourceOptions:this.effectiveSourceOptions(settings.githubFallback),
        onStage:stage=>{active();this.host.running!.stage=stage;this.host.changed();},
        chat:async messages=>{active();if(frozen.contextLimit&&estimateTokens(messages)+4096>frozen.contextLimit)throw new Error('公开材料超过配置的模型容量。');const result=await chat(frozen,this.host.key(frozen),messages,()=>undefined,abort.signal);active();return result;},
      });
    }finally{this.previewStop=undefined;if(this.host.running?.id===id)this.host.running=undefined;this.scheduler?.release();this.host.changed();}
  }
  map(documentId: string, before: string, after: string, changes: TextChange[], kind: ChangeKind): void {
    mapTopicReceipts(this.data.receipts.filter(r => r.documentId === documentId && r.id !== this.writingReceipt && r.id !== this.undoingReceipt), before, after, changes, kind);
  }
  renamed(oldPath: string, newPath: string): void {
    for(const job of [this.pending,this.active?.job]) if(job && (job.document.path===oldPath || job.document.path.startsWith(oldPath+'/'))){
      job.document.path=newPath+job.document.path.slice(oldPath.length);job.run.path=job.document.path;
      if(this.host.running?.id===job.run.id)this.host.running.path=job.document.path;
    }
  }
  async reconcile(documentId: string): Promise<void> {
    const receipts = this.data.receipts.filter(r => r.documentId === documentId);
    if (!receipts.length) return;
    const document = this.host.data.sessions[documentId]?.document;
    if (!document) return;
    reconcileTopicReceipts(receipts, document, await this.host.documents.read(document));
  }
  canUndo(id: string): boolean {
    const receipt = this.data.receipts.find(r => r.id === id), document = receipt && this.host.data.sessions[receipt.documentId]?.document;
    if (!receipt || !document || this.host.running || this.host.editing.has(document.id)) return false;
    try { const text = this.host.documents.bufferText(document); return typeof text === 'string' ? canUndoTopicBatch(receipt, text) : receipt.state === 'applied' && receipt.blocks.every(block => block.anchor.valid); }
    catch { return false; }
  }
  async undo(id: string): Promise<void> {
    const receipt = this.data.receipts.find(r => r.id === id), document = receipt && this.host.data.sessions[receipt.documentId]?.document;
    if (!receipt || !document) throw new Error('这次选题记录不存在。');
    if (this.host.running || this.host.editing.has(document.id)) throw new Error('请等待或停止当前任务。');
    this.host.editing.add(document.id);
    try {
      const before = await this.host.documents.read(document); reconcileTopicReceipts([receipt], document, before);
      const removals = planTopicBatchUndo(receipt, before);
      const removed = applyDailyChanges(before, removals);
      const recount = planDailyTopicRecount(removed, receipt.date);
      // The metadata precedes all day entries, so its original coordinates are unchanged by removal.
      const changes = [...removals, ...recount].sort((a,b)=>a.from-b.from);
      this.undoingReceipt = id;
      await this.host.documents.applyChangesValidated(document, before, changes, current => { if (!canUndoTopicBatch(receipt, current)) throw new Error('新增选题已被修改，不能安全撤回。'); });
      finishTopicBatchUndo(receipt, before, changes);
      try { await this.host.store.save(); } catch { throw new Error('已撤回，记录保存失败；不要重复操作。'); }
    } finally { this.undoingReceipt = undefined; this.host.editing.delete(document.id); this.host.changed(); }
  }
  private latestReformatTarget(): { run: DailyTopicRun; receipt: TopicBatchReceipt; document: DocumentRecord } {
    const run = [...this.data.runs].reverse().find(item => item.status === 'completed');
    const receipt = run?.receiptId && this.data.receipts.find(item => item.id === run.receiptId);
    const document = receipt && this.host.data.sessions[receipt.documentId]?.document;
    if (!run || !receipt || !document || document.deleted || this.host.data.topicLibrary?.id !== document.id)
      throw new Error('没有可可靠关联到当前选题库的最新完成批次，不能安全整理。');
    this.host.documents.resolve(document.id);
    return { run, receipt, document: { ...document } };
  }
  /** Diagnostics never write, save data, contact sources, or call a model. */
  async reformatLatestDiagnostics(): Promise<DailyTopicReformatDiagnostics> {
    try {
      const { run, receipt, document } = this.latestReformatTarget();
      const plan = planDailyTopicReformat(await this.host.documents.read(document), run, receipt);
      return { canReformat: true, path: document.path, receiptId: receipt.id, candidates: plan.countCandidates, selected: plan.countSelected, changeRanges: plan.changes.length };
    } catch (error) { return { canReformat: false, reason: error instanceof Error ? error.message : '本次选题无法安全整理。' }; }
  }
  /** Only the latest proven batch is changed. Its ordinary batch undo remains available. */
  async reformatLatest(): Promise<DailyTopicReformatResult> {
    if (this.closed || this.reformatting || this.host.running || this.pending || this.active || this.pumping) throw new Error('请先等待或停止当前任务，再整理选题。');
    const { run, receipt: original, document } = this.latestReformatTarget();
    if (this.host.editing.has(document.id)) throw new Error('选题库正在进行其他写入，请稍后重试。');
    this.reformatting = true; this.host.editing.add(document.id);
    let prepared: TopicBatchReceipt | undefined, originalSnapshot: TopicBatchReceipt | undefined;
    let before = '', after = '', committed = false, attempted = false, backup: string | undefined;
    const receiptIndex = this.data.receipts.indexOf(original);
    const originalFingerprint = hashText(JSON.stringify(original)), runFingerprint = hashText(JSON.stringify(run));
    const assertUnchanged = (): void => {
      if (this.closed || this.host.running || this.pending || this.active || this.pumping || this.host.data.topicLibrary?.id !== document.id
        || hashText(JSON.stringify(original)) !== originalFingerprint || hashText(JSON.stringify(run)) !== runFingerprint)
        throw new Error('整理准备期间目标或批次发生变化，未重新写入。');
      this.host.documents.resolve(document.id);
    };
    try {
      before = await this.host.documents.read(document); assertUnchanged();
      const plan = planDailyTopicReformat(before, run, original); after = plan.after;
      const result = { documentId: document.id, path: document.path, receiptId: original.id, candidates: plan.countCandidates, selected: plan.countSelected };
      if (!plan.changes.length) return { ...result, status: 'unchanged', changed: false, message: '本批选题已是清晰版式，无需重复整理。' };
      originalSnapshot = structuredClone(original);
      await this.host.store.save(); assertUnchanged();
      const pluginApp = this.host.app as App & { plugins?: { plugins?: Record<string, { manifest?: { dir?: string } }> } };
      const dir = pluginApp.plugins?.plugins?.['draft-companion']?.manifest?.dir ?? `${this.host.app.vault.configDir}/plugins/draft-companion`;
      const adapter = this.host.app.vault.adapter, rawData = await adapter.read(`${dir}/data.json`);
      if (JSON.stringify(JSON.parse(rawData)) !== JSON.stringify(this.host.data)) throw new Error('整理备份前配置已变化，请稍后重试。');
      backup = `${dir}/backup-topic-format-${Date.now()}-${randomUUID()}`;
      await adapter.mkdir(backup);
      await adapter.write(`${backup}/document-before.md`, before);
      await adapter.write(`${backup}/data-before.json`, rawData);
      if (await adapter.read(`${backup}/document-before.md`) !== before || await adapter.read(`${backup}/data-before.json`) !== rawData)
        throw new Error('选题整理备份回读失败，原文未修改。');
      assertUnchanged();
      if (this.data.receipts[receiptIndex] !== original) throw new Error('原选题回执已变化，原文未修改。');
      prepared = makeTopicBatchReceipt(document, run.id, before, plan, run.date, Date.now()); prepared.id = original.id;
      this.data.receipts[receiptIndex] = prepared;
      const preparedFingerprint = hashText(JSON.stringify(prepared));
      await this.host.store.save(); assertUnchanged();
      this.writingReceipt = prepared.id;
      await this.host.documents.applyChangesValidated(document, before, plan.changes, current => {
        assertUnchanged();
        if (current !== before || this.data.receipts[receiptIndex] !== prepared || hashText(JSON.stringify(prepared)) !== preparedFingerprint)
          throw new Error('文稿或准备回执已变化，原文未再次覆盖。');
        const verified = planDailyTopicReformat(current, run, originalSnapshot!);
        if (verified.after !== plan.after || JSON.stringify(verified.changes) !== JSON.stringify(plan.changes)) throw new Error('最终整理范围校验失败。');
        attempted = true;
      });
      committed = true;
      await this.verifyCommittedText(document, plan.after, '整理后文稿又有变化，需要检查记录。');
      prepared.state = 'applied'; delete prepared.invalidReason;
      await this.host.store.save();
      return { ...result, backup, status: 'formatted', changed: true, message: `已整理本批 ${plan.countCandidates} 个选题，${plan.countSelected} 个推荐排在前；旧选题库保持不变。` };
    } catch (error) {
      let actual: string | undefined;
      if (prepared && attempted && !committed) {
        try { actual = await this.host.documents.read(document); } catch { /* A submitted write can no longer be proved. */ }
        if (actual === after) committed = true;
      }
      if (prepared && (committed || (attempted && actual !== before))) {
        prepared.state = 'needs-check'; prepared.invalidReason = '已提交整理，但结果确认或记录保存失败；请检查正文，不要重复执行。';
        try { await this.host.store.save(); } catch { /* The prepared durable record remains available for restart recovery. */ }
        return { status: 'needs-check', changed: committed, documentId: document.id, path: document.path, receiptId: prepared.id,
          candidates: prepared.blocks.length, selected: run.cards.filter(card => card.selected).length, backup,
          message: committed ? '已整理，记录待检查；请查看正文，不要重复执行。' : '整理提交后的状态无法确认，记录待检查；不会重复写入。' };
      }
      if (prepared && originalSnapshot && this.data.receipts[receiptIndex] === prepared) {
        const restored = structuredClone(originalSnapshot);
        if (run.path) restored.path = run.path;
        this.data.receipts[receiptIndex] = restored;
        try {
          const live = this.host.data.sessions[document.id]?.document;
          if (!live) throw new Error('文稿身份已变化。');
          reconcileTopicReceipts([restored], live, await this.host.documents.read(live));
        } catch { restored.state = 'needs-check'; restored.invalidReason = '整理未提交，但原文稿或版本无法确认。'; }
        try { await this.host.store.save(); } catch { throw new Error('整理未写入，原回执恢复保存失败；请检查存储，勿重复执行。'); }
      }
      throw error;
    } finally { this.writingReceipt = undefined; this.reformatting = false; this.host.editing.delete(document.id); this.host.changed(); }
  }
  openResult(): void {
    const modal = new Modal(this.host.app); modal.titleEl.setText('每日选题记录'); modal.modalEl.addClass('dc-daily-modal');
    const runs = [...this.data.runs].reverse().slice(0, 20);
    if (!runs.length) modal.contentEl.createEl('p', { text: '点击“立即选题”，无需在聊天框输入内容。' });
    for (const run of runs) {
      const section = modal.contentEl.createEl('section', { cls: 'dc-daily-run' });
      section.createEl('h3', { text: `${run.date} · ${run.stage} · ${run.origin === 'manual' ? '手动' : '定时'}` });
      section.createEl('p', { text: run.path || '选题库', cls: 'dc-muted dc-small' });
      section.createEl('p', { text: run.message || run.error || run.stage });
      section.createEl('p', { text: new Date(run.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), cls: 'dc-muted dc-small' });
      for (const source of run.sources) section.createEl('p', { text: `${source.name}：${source.message}`, cls: 'dc-small' });
      for (const card of run.cards) {
        const details = section.createEl('details');
        details.createEl('summary', { text: `${card.selected ? '✓ 优选' : '候选'} · ${run.entries?.find(item => item.sourceId === card.sourceId)?.title || card.primaryTitle || card.sourceId}` });
        const content = details.createDiv({ cls: 'dc-message-content' });
        renderSafeMarkdown(content, [card.reason, card.angle, card.primaryTitle, ...(card.alternativeTitles || []), card.opening, ...(card.outline || []), ...card.gaps].filter(Boolean).join('\n\n'));
      }
      if (run.receiptId) {
        const undo = section.createEl('button', { text: '撤回本次新增' }); undo.disabled = !this.canUndo(run.receiptId);
        undo.addEventListener('click', () => { undo.disabled = true; void this.undo(run.receiptId!).then(() => { modal.close(); this.openResult(); }).catch(error => { new Notice(String(error)); undo.disabled = !this.canUndo(run.receiptId!); }); });
      }
      const locate = section.createEl('button', { text: '查看选题库' });
      locate.addEventListener('click', () => { void (async () => { if (!run.documentId) return; const file = this.host.documents.resolve(run.documentId); await this.host.app.workspace.getLeaf('tab').openFile(file); modal.close(); })().catch(error => new Notice(String(error))); });
    }
    modal.open();
  }
  close(): void {
    this.closed = true;
    if (this.pending) { this.pending.run.status = 'interrupted'; this.pending.run.stage = '插件关闭，未自动重发'; }
    this.pending = undefined; this.stop(); this.scheduler?.close();
  }
}
