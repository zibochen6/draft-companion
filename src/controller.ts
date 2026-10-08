import { randomUUID } from 'node:crypto';
import { Notice, FuzzySuggestModal, TFile, type App } from 'obsidian';
import { Documents } from './documents';
import { candidateAfter, parseEdit, undoAfter } from './editing';
import { chat, listModels } from './provider';
import { buildMessages, estimateTokens } from './prompts';
import { Store } from './store';
import type { UIHost } from './ui-host';
import type { Candidate, DocumentRecord, EditScope, Message, Provider, RequestSnapshot, RunningRequest, Session, TaskMode } from './types';
import { Reviews } from './reviews';
import { authorSnapshot, currentVersion, ensureReview } from './review-types';
import type { ReviewCapture, ReviewRun, ReviewDiagnostic, Suggestion, SuggestionReply, TextChange, ChangeKind } from './review-types';
import { parseReview, parseSuggestionRevision, reviewMessages, suggestionMessages } from './review-protocol';
import { AgentActions } from './agent-actions';
import { AgentTools } from './agent-tools';
import { parseTopicItems } from './topics';
import { intentMessages, parseIntent, constrainIntent, inferLocalIntent } from './agent-intent';
import { capabilityKey, discoverToolProtocol, runAgent } from './agent-runtime';
import type { AgentSubmitOptions, AgentRequestContext, IntentResult, AgentActionReceipt } from './agent-types';
import { bodyStart } from './editing';
import { DailyTopicRunner } from './daily-runner';

class ReviewRequestError extends Error {
  readonly diagnostics: ReviewDiagnostic;
  constructor(readonly kind: string, message: string, code: string) {
    super(message); this.name = 'ReviewRequestError';
    this.diagnostics = { category: kind, code, stage: 'review' };
  }
}

/** Keep only the transport's safe classification; never retain a response body. */
function reviewDiagnostic(error: unknown): { kind: string; diagnostic: ReviewDiagnostic } {
  const known = ['auth','permission','rate-limit','quota','connection','timeout','model-unavailable','format',
    'context','unsupported','service','cancelled','empty-document','empty-output','truncated','refusal','stale'];
  const value = error as { kind?: unknown; diagnostics?: ReviewDiagnostic } | undefined;
  const kind = typeof value?.kind === 'string' && known.includes(value.kind) ? value.kind : 'review';
  const source = value?.diagnostics;
  const diagnostic: ReviewDiagnostic = { category: kind, stage: 'review' };
  if (source && typeof source === 'object') {
    if (typeof source.httpStatus === 'number' && Number.isInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599)
      diagnostic.httpStatus = source.httpStatus;
    if (typeof source.code === 'string' && /^[a-z\d_-]{1,80}$/i.test(source.code)) diagnostic.code = source.code;
    if (['configuration','models','chat','review'].includes(source.stage || '')) diagnostic.stage = source.stage;
  }
  return { kind, diagnostic };
}

export class Controller implements UIHost {
  running: RunningRequest | undefined;
  private listeners = new Set<() => void>();
  private testAbort: AbortController | undefined;
  private editing = new Set<string>();
  private closed = false;
  readonly reviews: Reviews;
  readonly actions: AgentActions;
  readonly daily: DailyTopicRunner;
  openReviewView?: (documentId: string, suggestionId?: string) => Promise<void>;
  private changeSaveTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly app: App, readonly store: Store, readonly documents: Documents, readonly openSettings: () => void) {
    this.reviews = new Reviews(store,documents,()=>this.changed(),(s,t)=>this.event(s,t),this.editing);
    this.actions=new AgentActions({documents,receipts:id=>this.data.sessions[id]?.agentActions ?? (this.data.sessions[id]!.agentActions=[]),save:()=>store.save(),changed:()=>this.changed(),editing:this.editing});
    const controller = this;
    this.daily = new DailyTopicRunner({ app, store, documents, get data() { return controller.data; },
      get running() { return controller.running; }, set running(value) { controller.running = value; },
      editing: this.editing, changed: () => this.changed(), key: provider => this.key(provider) });
    documents.setChangeListener(change => this.documentChanged(change.documentId,change.before,change.after,change.changes,change.kind));
  }
  get data() { return this.store.data; }
  target(): DocumentRecord | null { return this.documents.current(); }
  currentSession(): Session | null { const doc = this.target(); return doc ? this.store.sessionFor(doc) : null; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener();
    if (!this.running) queueMicrotask(() => { if (!this.closed) void this.daily.pump(); });
  }
  startDailyTopics(): Promise<void> { return this.daily.start(); }
  stopDailyTopics(): void { this.daily.stop(); }
  dailyStatus() { return this.daily.status(); }
  dailyEnabled(): boolean { return this.daily.scheduler?.enabled() ?? false; }
  async setDailyEnabled(enabled: boolean): Promise<void> { this.daily.scheduler?.setEnabled(enabled); }
  openDailyResult(): void { this.daily.openResult(); }
  canUndoTopicBatch(id: string): boolean { return this.daily.canUndo(id); }
  undoTopicBatch(id: string): Promise<void> { return this.daily.undo(id); }
  async saveSettings(): Promise<void> { await this.store.save(); this.changed(); }
  private event(session: Session, content: string): void { session.messages.push({ id: randomUUID(), role: 'event', content, at: Date.now() }); }
  private requireSession(): Session { const session = this.currentSession(); if (!session) throw new Error('请先打开一篇 Markdown 文稿。'); return session; }
  private key(provider: Provider): string | undefined {
    if (!provider.secretRef) return undefined;
    const value = this.app.secretStorage.getSecret(provider.secretRef);
    if (!value) throw new Error('所选密钥不存在，请在设置中选择或创建密钥。');
    return value;
  }
  agentActions():AgentActionReceipt[] { return this.currentSession()?.agentActions ?? []; }
  canUndoAgentAction(id:string):boolean { const session=this.currentSession();return !!session && this.actions.canUndo(session.document,id); }
  async undoAgentAction(id:string):Promise<void> {
    if(this.running)throw new Error('请先停止或等待当前生成。');
    const outcome=await this.actions.undo(this.requireSession().document,id);
    if(outcome.status!=='success' && outcome.status!=='noop')throw new Error(outcome.message);
  }
  async locateAgentAction(id:string):Promise<void> {
    const session=this.requireSession(),receipt=session.agentActions?.find(r=>r.id===id);
    if(!receipt || receipt.state!=='applied' || !receipt.anchor.valid)throw new Error('这次操作的位置需要重新检查。');
    const latest=await this.documents.snapshot(session.document,'body');
    if(latest.fullText.slice(receipt.anchor.from,receipt.anchor.to)!==receipt.replacement)throw new Error('原文已经变化，不能可靠定位。');
    await this.documents.locate(session.document,receipt.anchor.from,receipt.anchor.to);
  }
  async bindTopicLibrary():Promise<void> {
    const controller=this;
    await new Promise<void>(resolve=>{
      class Picker extends FuzzySuggestModal<TFile> {
        getItems():TFile[]{return controller.app.vault.getMarkdownFiles();}
        getItemText(file:TFile):string{return file.path;}
        onChooseItem(file:TFile):void { controller.data.topicLibrary=controller.documents.recordFor(file);controller.store.sessionFor(controller.data.topicLibrary);void controller.saveSettings().catch(e=>new Notice(String(e))); }
        onClose():void {resolve();}
      }
      const picker=new Picker(this.app);picker.setPlaceholder('选择选题库 Markdown 文件');picker.open();
    });
  }
  async sendAgent(input:string,options:AgentSubmitOptions={}):Promise<void> {
    if(!input.trim())throw new Error('请输入本轮要求。');
    if(options.task==='review')return this.review(input,options.scope ?? 'auto');
    if(options.task==='propose')return this.send(input,'edit',options.scope ?? 'auto');
    if(this.closed || this.running)throw new Error(this.closed?'插件已关闭。':'已有生成请求，请先等待或停止。');
    let session=this.requireSession();
    const assertSafeRetry=(target:Session)=>{
      const previous=target.messages.filter(m=>m.role==='assistant').at(-1),previousUser=target.messages.filter(m=>m.role==='user').at(-1);
      if(previousUser?.content===input && ['failed','stopped','interrupted'].includes(previous?.status ?? '') && previous?.actionIds?.some(id=>target.agentActions?.some(r=>r.id===id&&['applied','needs-check'].includes(r.state))))
        throw new Error('上一轮已经完成修改，后续回复未完成。请查看操作记录或撤回；同一要求不会重复写入。');
    };
    assertSafeRetry(session);
    const configuredRole=this.data.roles.find(r=>r.id===session.selectedRoleId),configuredProvider=this.data.providers.find(p=>p.id===this.data.activeProviderId);
    if(!configuredRole || !configuredProvider?.model)throw new Error('请先选择伙伴、配置服务并选择模型。');
    const role=structuredClone(configuredRole),provider=structuredClone(configuredProvider),key=this.key(provider);
    const requestId=randomUUID(),abort=new AbortController();
    let reply:Message={id:requestId,role:'assistant',content:'',at:Date.now(),roleName:role.name,model:provider.model,providerName:provider.name,status:'running',presentation:'text',actionIds:[]};
    const assertActive=()=>{if(this.closed || abort.signal.aborted || this.running?.id!==requestId)throw new Error('本轮已停止。');};
    const stop=()=>{
      if(this.running?.id!==requestId)return;
      this.running=undefined;abort.abort();reply.status='stopped';
      this.event(session,reply.actionIds?.length?'本轮已停止；已完成修改保留，未提交的调用已作废。':'本轮已停止；未提交的调用已作废。');
      this.changed();void this.store.save().catch(e=>new Notice(`停止状态保存失败：${String(e)}`));
    };
    this.running={id:requestId,documentId:session.document.id,path:session.document.path,sessionId:session.id,roleName:role.name,mode:'discuss',text:'',stop};this.changed();
    let requestStage='读取当前文稿';
    const progress=(stage:string)=>{assertActive();requestStage=stage;this.running!.stage=stage;this.changed();};
    let tools:AgentTools|undefined;
    let added=false;
    const chain:import('./agent-types').AgentDocumentChange[]=[];
    let collect=this.documents.onChange(change=>{if(change.documentId===session.document.id)chain.push(change);});
    try {
      const initial=await this.documents.snapshot(session.document,options.scope ?? 'auto',false);assertActive();
      const initialDocumentId=session.document.id;
      const frozenInsertion=this.documents.insertionAnchor(session.document,initial);
      const frozen:RequestSnapshot={...initial,requestId,sessionId:session.id,role,provider,input,mode:'discuss',preferences:this.data.preferences,brief:session.brief,history:structuredClone(session.messages)};
      const topicContext=role.id==='topic-editor' || /选题|topic/i.test(session.document.path.split('/').pop() ?? '');
      const local=inferLocalIntent(input,options,topicContext);
      let intent:IntentResult;
      if(['discuss','titles','outline'].includes(options.task ?? ''))intent={intent:'discuss'};
      else if(local)intent=constrainIntent(local,input,options,topicContext);
      else {
        progress('正在理解本轮要求……');
        const classification=intentMessages(input,options,role.id==='topic-editor');
        if(provider.contextLimit && estimateTokens(classification)+512>provider.contextLimit)throw new Error('本轮输入超过配置容量，请缩短指令或更换模型；未截断材料。');
        const classified=await chat({...provider,stream:false},key,classification,()=>undefined,abort.signal);
        assertActive();if(!['stop','done'].includes(classified.finishReason))throw new Error('意图判断未完整结束，未执行操作。');
        intent=constrainIntent(parseIntent(classified.text,input),input,options,topicContext);
      }
      if(intent.intent==='review' || intent.intent==='propose') {
        const latest=await this.documents.snapshot(session.document,'body',false);assertActive();
        if(latest.fullText!==initial.fullText)throw new Error('判断意图期间文稿已变化，请基于最新正文重新发送；未转移到其他文稿。');
        const start=bodyStart(frozen.fullText);
        if(frozen.scope==='selection' && frozen.from<start)throw new Error('选区进入了受保护的 frontmatter，请只选择正文。');
        if(frozen.scope==='body'){frozen.from=start;frozen.selectedText=frozen.fullText.slice(start);}
        this.running=undefined;
        return intent.intent==='review'?this.reviewRequest(session,input,options.scope ?? 'auto',undefined,false,undefined,frozen):this.send(input,'edit',options.scope ?? 'auto',frozen);
      }
      const topic=['select-topic','recommend-topic'].includes(intent.intent);
      if(topic) {
        const current=await this.documents.snapshot(session.document,'body');assertActive();
        const knownTopic=options.task==='topic' || /选题|topic/i.test(session.document.path.split('/').pop() ?? '');
        if(!knownTopic || !parseTopicItems(current.fullText,'test').length) {
          if(!this.data.topicLibrary || this.data.topicLibrary.deleted) {await this.bindTopicLibrary();assertActive();}
          const bound=this.data.topicLibrary;if(!bound || bound.deleted)throw new Error('尚未绑定选题库，本轮没有勾选。');
          const file=this.documents.resolve(bound.id);if(file.path!==bound.path)throw new Error('选题库关联已变化，请重新绑定。');
          session=this.store.sessionFor(bound);
          chain.length=0;
          // Display the deliberately chosen library, but respect a document switch made while classifying.
          if(this.documents.current()?.id===initialDocumentId)this.documents.bind(bound.id);
          this.running!.documentId=bound.id;this.running!.path=bound.path;this.running!.sessionId=session.id;
          this.changed();
        }
        assertSafeRetry(session);
      }
      const history=structuredClone(session.messages),document=session.document.id===initialDocumentId?{...initial}:await this.documents.snapshot(session.document,topic?'body':options.scope ?? 'auto',false);assertActive();
      if(topic){document.scope='body';document.from=bodyStart(document.fullText);document.to=document.fullText.length;document.selectedText=document.fullText.slice(document.from);}
      const snapshot:RequestSnapshot={...document,requestId,sessionId:session.id,role,provider,input,mode:'discuss',preferences:this.data.preferences,brief:session.brief,history};
      const context:AgentRequestContext={snapshot,document:{...session.document},documentRef:`document_${randomUUID()}`,intent,selectedTopicRefs:new Set(),topicPolicy:intent.topicSelection,topicBudget:topic?(intent.topicSelection?.max ?? intent.count ?? 5):0,signal:abort.signal,assertActive,changeChain:chain};
      if(['replace','propose'].includes(intent.intent)) {
        if(document.scope==='selection' && document.from>=bodyStart(document.fullText))context.range={from:document.from,to:document.to,text:document.selectedText,valid:true};
        else if(intent.quote) {
          const at=document.fullText.indexOf(intent.quote),next=document.fullText.indexOf(intent.quote,at+1);
          if(at<0 || next>=0 || at<bodyStart(document.fullText))intent={intent:'clarify',question:'这句原文无法唯一定位。请在编辑器中选中要改的文字，再说明怎么修改。'};
          else context.range={from:at,to:at+intent.quote.length,text:intent.quote,valid:true};
        } else intent={intent:'clarify',question:'请先选中要修改的段落，或逐字引用唯一原句并说明改法。'};
        if(context.range)context.rangeRef=`range_${randomUUID()}`;
      }
      if(intent.intent==='insert') {
        context.insertion=frozenInsertion;
        if(!context.insertion || context.insertion.from<bodyStart(document.fullText))intent={intent:'clarify',question:'请在正文编辑器中放置插入光标，再明确要求插入什么。'};
        else context.insertionRef=`insertion_${randomUUID()}`;
      }
      context.intent=intent;
      session.messages.push({id:randomUUID(),role:'user',content:input,at:Date.now()},reply);added=true;session.mode='discuss';this.changed();await this.store.save();assertActive();
      if(intent.intent==='clarify')reply.content=intent.question || '请明确本轮要讨论、审阅还是执行修改，以及目标范围。';
      else if(intent.intent==='discuss') {
        progress('正在生成回复……');
        const messages=buildMessages(snapshot);if(provider.contextLimit && estimateTokens(messages)+1024>provider.contextLimit)throw new Error('估算上下文加输出余量超过配置容量，请更换模型或重新开始会话；全文未截断。');
        const result=await chat(provider,key,messages,chunk=>{if(this.running?.id===requestId){reply.content+=chunk;this.running.text=reply.content;this.changed();}},abort.signal);
        assertActive();if(!['stop','done'].includes(result.finishReason) || !result.text.trim())throw new Error('回复未正常完整结束。');reply.content=result.text;
      } else {
        tools=new AgentTools(context,{latest:doc=>this.documents.snapshot(doc,'body'),save:()=>this.store.save(),changed:()=>this.changed(),receipts:id=>this.data.sessions[id]?.agentActions ?? [],reveal:(doc,from,to)=>this.revealWithoutFocus(doc,from,to),propose:async(ctx,explanation,replacement,notes)=>{
          assertActive();const latest=await this.documents.snapshot(ctx.document,'body');assertActive();const range=ctx.range;
          if(!range?.valid || latest.fullText.slice(range.from,range.to)!==range.text)throw new Error('授权范围已变化，请重新生成候选。');
          this.supersede(session);const candidate:Candidate={id:randomUUID(),requestId,documentId:ctx.document.id,sessionId:session.id,path:ctx.document.path,scope:'selection',from:range.from,to:range.to,baseline:latest.fullText,baselineHash:latest.hash,replacement,explanation,notes,state:'ready',deletion:false};
          session.candidate=candidate;reply.candidateId=candidate.id;reply.presentation='candidate';await this.store.save();this.changed();
        }},this.actions);
        collect();collect=()=>undefined;
        const cached=this.data.toolCapabilities ??= {};
        const fingerprint=capabilityKey(provider);
        if(!provider.toolMode || provider.toolMode==='auto')if(!cached[fingerprint])progress('正在检测模型的工具能力……');
        const protocol=provider.toolMode==='native' || provider.toolMode==='structured'?provider.toolMode:cached[fingerprint] ?? await discoverToolProtocol(provider,key,abort.signal);
        assertActive();if(cached[fingerprint]!==protocol){cached[fingerprint]=protocol;await this.store.save();assertActive();}
        reply.content=await runAgent(context,tools,protocol,key,{progress,chunk:chunk=>{if(this.running?.id===requestId){reply.content+=chunk;this.running.text=reply.content;this.changed();}},outcome:(call,outcome)=>{
          if(outcome.actionId && !reply.actionIds!.includes(outcome.actionId))reply.actionIds!.push(outcome.actionId);
          const receipt=outcome.actionId && session.agentActions?.find(r=>r.id===outcome.actionId);
          const event:Message={id:randomUUID(),role:'event',content:outcome.message,at:Date.now(),presentation:'tool',...(receipt?{actionIds:[receipt.id]}:{})};session.messages.push(event);this.changed();
        },latest:async()=> (await this.documents.snapshot(context.document,'body')).fullText});
        if(['replace','insert','select-topic'].includes(intent.intent) && !reply.actionIds?.length)reply.content=`本轮没有完成正文修改，请查看工具反馈。\n\n${reply.content}`;
      }
      assertActive();reply.status='completed';
      const replyIndex=session.messages.indexOf(reply);if(replyIndex>=0){session.messages.splice(replyIndex,1);session.messages.push(reply);}
      this.running=undefined;this.changed();await this.store.save();
    } catch(error) {
      if(this.running?.id!==requestId){if(reply.status==='completed'){reply.status='failed';this.event(session,'操作已完成，但会话记录保存失败；请勿重复执行，先查看正文与操作回执。');this.changed();throw new Error('操作已完成，但会话记录保存失败；请勿重复执行，先查看正文与操作回执。');}return;}
      this.running=undefined;reply.status='failed';
      const timeout=error as {kind?:unknown;diagnostics?:{code?:unknown}} | undefined;
      if(timeout?.kind==='timeout') {
        const stage=requestStage.replace(/…+$/,'');
        const reason=timeout.diagnostics?.code==='request_timeout'
          ? `${stage}超过本服务配置的 ${provider.timeoutMs/1000} 秒等待时限。请在服务配置中延长“请求超时”，或稍后重试；已完成操作请先查看回执。`
          : `${stage}时服务返回超时。${error instanceof Error?error.message:'请稍后重试。'}`;
        error=Object.assign(new Error(reason),{kind:'timeout',diagnostics:timeout.diagnostics});
      }
      const reason=error instanceof Error?error.message:'本轮未完成。';
      if(!added){session.messages.push({id:randomUUID(),role:'user',content:input,at:Date.now()},reply);}
      this.event(session,reply.actionIds?.length?`已完成修改保留；后续回复失败：${reason}`:`本轮未执行新的正文修改：${reason}`);this.changed();
      await this.store.save();throw error;
    } finally {collect();tools?.dispose();}
  }
  private async revealWithoutFocus(doc:DocumentRecord,from:number,to:number):Promise<void> {
    if(this.documents.current()?.id!==doc.id)throw new Error('你已切换文稿；写入结果保留，请点击“定位原文”查看。');
    const leaf=this.app.workspace.activeLeaf,focused=typeof document==='undefined'?undefined:document.activeElement;
    await this.documents.locate(doc,from,to);
    if(leaf && this.app.workspace.activeLeaf!==leaf)this.app.workspace.setActiveLeaf(leaf,{focus:false});
    if(focused && 'focus' in focused && focused.isConnected)(focused as HTMLElement).focus({preventScroll:true});
  }
  async send(input: string, mode: TaskMode, scope: EditScope, frozen?:RequestSnapshot): Promise<void> {
    if (mode === 'review') return this.review(input,scope);
    if (!input.trim()) throw new Error('请输入本轮创作要求。');
    if (this.running) throw new Error('已有生成请求，请先等待完成或停止。');
    const session = frozen ? this.data.sessions[frozen.documentId] : this.requireSession();
    if(!session || (frozen && session.id!==frozen.sessionId))throw new Error('原会话身份已变化，请重新发送。');
    const configuredRole = frozen?.role ?? this.data.roles.find(r => r.id === session.selectedRoleId);
    const configuredProvider = frozen?.provider ?? this.data.providers.find(p => p.id === this.data.activeProviderId);
    if (!configuredRole) throw new Error('请先选择或创建创作伙伴。');
    if (!configuredProvider?.model) throw new Error('请先在设置中配置连接并选择模型。');
    const role = structuredClone(configuredRole), provider = structuredClone(configuredProvider);
    const key = this.key(provider);
    const history = frozen?.history ?? structuredClone(session.messages);
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
    const preferences = frozen?.preferences ?? this.data.preferences, brief = frozen?.brief ?? session.brief;
    this.changed();
    try {
      const document = frozen ? {...frozen} : await this.documents.snapshot(session.document, scope, mode === 'edit');
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
  selectionSummary() { return this.documents.selectionSummary(this.target() ?? undefined); }
  bindReview(documentId: string): void { this.documents.bind(documentId); this.changed(); }
  selectSuggestion(documentId:string,id:string):void {
    this.reviews.suggestion(documentId,id); ensureReview(this.reviews.session(documentId)).selectedId=id;
    this.changed(); void this.store.save().catch(e=>new Notice(`批注选择保存失败：${String(e)}`));
  }
  selectedSuggestion():Suggestion|undefined {
    const r=this.currentSession()?.review;
    return r?.suggestions.find(s=>s.id===r.selectedId);
  }
  async locateSuggestion(documentId:string,id:string):Promise<void> {
    const preview=await this.reviews.preview(documentId,id);
    if (!preview.valid || preview.from===undefined || preview.to===undefined) throw new Error(preview.reason || '无法定位，请重新审阅。');
    this.selectSuggestion(documentId,id);
    await this.documents.locate(this.reviews.session(documentId).document,preview.from,preview.to);
  }
  previewSuggestion(documentId:string,id:string) { return this.reviews.preview(documentId,id); }
  acceptSuggestion(documentId:string,id:string) { return this.reviews.accept(documentId,id); }
  ignoreSuggestion(documentId:string,id:string) { return this.reviews.ignore(documentId,id); }
  undoSuggestion(documentId:string,id:string) { return this.reviews.undo(documentId,id); }
  canUndoSuggestion(documentId:string,id:string) { return this.reviews.canUndo(documentId,id); }
  async openReview(documentId:string,id?:string):Promise<void> {
    if (id) this.selectSuggestion(documentId,id);
    if (!this.openReviewView) throw new Error('审阅标签尚未准备好，请重新打开插件。');
    await this.openReviewView(documentId,id);
  }
  async review(input='请审阅这篇公众号文章，优先指出三至五个最重要的问题。',scope:EditScope='auto'):Promise<void> {
    return this.reviewRequest(this.requireSession(),input.trim() || '请审阅这篇公众号文章，优先指出三至五个最重要的问题。',scope);
  }
  async retryReview(documentId:string,runId:string):Promise<void> {
    const session=this.reviews.session(documentId), run=session.review?.runs.find(item=>item.id===runId);
    if (!run || run.documentId!==documentId || run.snapshot===undefined || run.from===undefined || run.to===undefined ||
      run.selection===undefined || run.input===undefined || !run.providerId)
      throw new Error('这次历史审阅缺少完整快照，请通过“审阅全文”或“审阅选区”重新审阅。');
    return this.reviewRequest(session,run.input,run.scope,undefined,false,run);
  }
  async askSuggestion(documentId:string,id:string,input:string,revise:boolean):Promise<void> {
    if (!input.trim()) throw new Error('请填写批注追问或新改法要求。');
    const session=this.reviews.session(documentId), s=this.reviews.suggestion(documentId,id);
    if (revise && !['pending','comment'].includes(s.state)) throw new Error('此意见已处理或需要重检，请重新审阅。');
    return this.reviewRequest(session,input,'body',s,revise);
  }
  private async reviewRequest(session:Session,input:string,scope:EditScope,suggestion?:Suggestion,revise=false,retry?:ReviewRun,frozen?:RequestSnapshot):Promise<void> {
    if (this.closed) throw new Error('插件已关闭，请重新打开后审阅。');
    if (this.running) throw new Error('已有生成请求，请先等待或停止。');
    const configuredRole=frozen?.role ?? this.data.roles.find(r=>r.id===(retry?.author.id ?? session.selectedRoleId)), configuredProvider=frozen?.provider ?? this.data.providers.find(p=>p.id===(retry?.providerId ?? this.data.activeProviderId));
    if (!configuredRole || !configuredProvider?.model) throw new Error('请先选择伙伴、配置服务并选择模型。');
    const role=structuredClone(configuredRole),provider=structuredClone(configuredProvider);
    if (retry) { role.name=retry.author.name;role.systemPrompt=retry.author.systemPrompt;provider.model=retry.model; }
    const key=this.key(provider);
    const history=frozen?.history ?? structuredClone(session.messages),preferences=frozen?.preferences ?? retry?.preferences ?? this.data.preferences,brief=frozen?.brief ?? retry?.brief ?? session.brief;
    const requestId=randomUUID(), abort=new AbortController(), r=ensureReview(session);
    const reply:Message={id:requestId,role:'assistant',content:'',at:Date.now(),roleName:role.name,model:provider.model,providerName:provider.name,status:'running'};
    const run:ReviewRun|undefined=suggestion ? undefined : {id:randomUUID(),requestId,at:Date.now(),author:authorSnapshot(role),model:provider.model,providerName:provider.name,
      documentId:session.document.id,path:session.document.path,providerId:provider.id,input,preferences,brief,
      snapshotHash:'',scope:'body',status:'running',summary:'',overall:[],added:0,duplicates:0};
    const followup:SuggestionReply|undefined=suggestion ? {id:requestId,at:Date.now(),author:authorSnapshot(role),input,content:'',status:'interrupted'} : undefined;
    if (run) r.runs.push(run); if (followup) suggestion!.replies.push(followup);
    session.messages.push({id:randomUUID(),role:'user',content:suggestion ? `批注 ${suggestion.number}${revise?'再改一版':'追问'}：${input}`:input,at:Date.now()},reply);
    session.mode='review';
    this.running={id:requestId,documentId:session.document.id,path:session.document.path,sessionId:session.id,roleName:role.name,mode:'review',text:'',stop:()=>{
      if (this.running?.id!==requestId) return;
      this.running=undefined;reply.status='stopped';if(run)run.status='stopped';if(followup)followup.status='stopped';abort.abort();
      this.event(session,'审阅已停止，未完成结果没有形成可应用批注。可以显式重试。');this.changed();
      void this.store.save().catch(e=>new Notice(`停止状态保存失败：${String(e)}`));
    }};
    this.changed(); let capture:ReviewCapture|undefined;
    try {
      const document=frozen ? {...frozen} : await this.documents.snapshot(session.document,retry ? 'body' : scope,true);
      if (this.running?.id!==requestId) return;
      if (retry) {
        if (document.fullText!==retry.snapshot || retry.from!<document.from || retry.to!>document.to ||
          document.fullText.slice(retry.from,retry.to)!==retry.selection)
          throw new ReviewRequestError('stale','原审阅范围或文稿已变化，请通过“审阅全文”或“审阅选区”重新审阅。','review-retry-snapshot-changed');
        document.from=retry.from!;document.to=retry.to!;document.selectedText=retry.selection!;document.scope=retry.scope;
      }
      if (!document.selectedText.trim()) throw new ReviewRequestError('empty-document','当前文稿正文为空，请输入 Markdown 内容后再审阅。','review-empty-document');
      this.reviews.anchors.track(document.documentId,document.fullText);
      if (suggestion && revise) {
        this.reviews.anchors.validate(suggestion,document.fullText);
        const target=suggestion.anchors!.target;
        document.from=target.from;document.to=target.to;document.selectedText=target.text;document.scope='selection';
      }
      capture=this.reviews.anchors.capture(document);
      if (run) {run.snapshotHash=document.hash;run.scope=document.scope;run.path=document.path;
        run.snapshot=document.fullText;run.from=document.from;run.to=document.to;run.selection=document.selectedText;}
      const snapshot:RequestSnapshot={...document,requestId,sessionId:session.id,role,provider,input,mode:'review',preferences,brief,history};
      const states=r.suggestions.map(s=>`${s.number} ${s.author.name} ${s.state} ${s.title}`).join('\n');
      const messages=suggestion ? suggestionMessages(snapshot,suggestion,revise) : reviewMessages(snapshot,states);
      if(provider.contextLimit && estimateTokens(messages)+2048>provider.contextLimit) throw new Error('估算上下文加输出余量超过模型容量。请更换模型或重新开始会话；全文未截断。');
      await this.store.save();if(this.running?.id!==requestId)return;
      const result=await chat(provider,key,messages,chunk=>{
        if(this.running?.id!==requestId||abort.signal.aborted)return;
        this.running.text+=chunk;reply.content=this.running.text;this.changed();
      },abort.signal);
      if(this.running?.id!==requestId||abort.signal.aborted||this.closed)return;
      if(!['stop','done'].includes(result.finishReason)) {
        if (['content_filter','refusal'].includes(result.finishReason)) throw new ReviewRequestError('refusal','模型拒绝了本次审阅，未形成批注。请调整要求后重新审阅。','review-refused');
        throw new ReviewRequestError('truncated','模型未完整结束，未形成可应用批注。请重试。','review-incomplete');
      }
      if(!result.text.trim())throw new ReviewRequestError('empty-output','模型未返回正文，未形成批注。请重试。','review-empty-output');
      reply.content=result.text;
      await this.reviews.latest(session.document.id);
      if(this.running?.id!==requestId||abort.signal.aborted||this.closed)return;
      if(suggestion) {
        if(revise) {
          const revision=parseSuggestionRevision(result.text);
          this.reviews.revise(suggestion,capture,role,revision);
          reply.content=`批注 ${suggestion.number} 的新版本（尚未采纳）：\n\n${revision.reason}\n\n${revision.replacement}`;
          this.event(session,`批注 ${suggestion.number} 已生成新版本，旧版本被替代并保留；原作者仍为 ${suggestion.author.name}。`);
        }
        followup!.content=reply.content;followup!.status='completed';
      } else {
        const parsed=parseReview(result.text);this.reviews.addResult(session,run!,capture,parsed,role);
        reply.content=`${parsed.summary}\n\n句级批注新增 ${run!.added} 条，重复 ${run!.duplicates} 条。请在“批注”中逐条查看；未采纳建议不属于正文。`;
      }
      reply.status='completed';this.running=undefined;this.changed();await this.store.save();
    } catch(error) {
      if(this.running?.id!==requestId) {if(reply.status==='completed')throw new Error('审阅完成，但记录保存失败。请检查存储空间后重新保存。');return;}
      this.running=undefined;reply.status='failed';const reason=error instanceof Error?error.message:'审阅失败。';
      if(run){const failure=reviewDiagnostic(error);run.status=failure.kind==='cancelled'?'stopped':'failed';run.error=reason;run.errorKind=failure.kind;run.errorDiagnostic=failure.diagnostic;}
      if(followup){followup.status='failed';followup.content=reply.content || reason;}
      this.event(session,`本轮未形成可应用的新批注：${reason}。原文未改动，可以重试。`);this.changed();await this.store.save();throw error;
    } finally {if(capture)this.reviews.anchors.release(capture);}
  }
  documentChanged(documentId:string,before:string,after:string,changes:TextChange[],kind:ChangeKind='edit'):void {
    this.actions.map({documentId,before,after,changes,kind});
    this.daily.map(documentId,before,after,changes,kind);
    this.reviews.anchors.update(documentId,before,after,changes,kind);
    const session=this.data.sessions[documentId];
    if(session?.candidate?.state==='ready' && session.candidate.baseline!==after)session.candidate.state='stale';
    this.changed();
    if(this.changeSaveTimer)clearTimeout(this.changeSaveTimer);
    this.changeSaveTimer=setTimeout(()=>{this.changeSaveTimer=undefined;void this.store.save().catch(e=>new Notice(`批注状态保存失败：${String(e)}`));},250);
  }
  async validateDocumentActions(documentId:string):Promise<void> {
    const session=this.data.sessions[documentId];
    if(session?.agentActions?.length){const text=await this.documents.read(session.document);this.actions.reconcile(session.document,text);}
    await this.daily.reconcile(documentId);this.changed();
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
  canUndoWhole(): boolean {
    const session=this.currentSession();if(!session?.undo||session.undo.needsCheck||this.editing.has(session.document.id))return false;
    try {return this.documents.bufferText(session.document)===undoAfter(session.undo);}catch{return false;}
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
  async clearSession(sessionId?: string): Promise<void> {
    // The modal captures a session ID before asking for confirmation. Resolve
    // that exact object here so a document switch cannot clear the new view.
    const session = sessionId
      ? Object.values(this.data.sessions).find(item => item.id === sessionId)
      : this.requireSession();
    if (!session) throw new Error('原会话已不存在，请关闭提示后重新打开。');
    if (this.editing.has(session.document.id)) throw new Error('请等待此文稿的修改操作完成后再清空会话。');
    // Do not interrupt a generation belonging to another document merely
    // because the user confirmed an older session's clear dialog.
    if (this.running?.origin !== 'daily' && this.running?.documentId === session.document.id && this.running.sessionId === session.id) this.running.stop();
    this.store.clear(session); await this.saveSettings();
  }
  async chooseRole(roleId: string): Promise<void> {
    const session = this.requireSession(); const role = this.data.roles.find(r => r.id === roleId);
    if (!role) throw new Error('创作伙伴不存在。');
    session.selectedRoleId = role.id; session.mode = role.defaultMode; await this.saveSettings();
  }
  async setBrief(brief: string): Promise<void> { this.requireSession().brief = brief; await this.saveSettings(); }
  async models(provider: Provider, signal?: AbortSignal) { return listModels(structuredClone(provider), this.key(provider), signal); }
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
    this.daily.close();
    this.stop(); this.testAbort?.abort();
    if (running?.documentId) {
      const session = this.data.sessions[running.documentId];
      const reply = session?.messages.find(message => message.id === running.id);
      if (session && reply) {
        reply.status = 'interrupted';
        const reviewRun=session.review?.runs.find(run=>run.requestId===running.id);
        if (reviewRun) reviewRun.status='interrupted';
        for (const suggestion of session.review?.suggestions || []) {
          const followup=suggestion.replies.find(item=>item.id===running.id);
          if (followup) followup.status='interrupted';
        }
        this.event(session, '插件关闭使上次生成中断；不会自动重发，未完成内容不能应用。');
        void this.store.save().catch(() => undefined);
      }
    }
    this.listeners.clear();
    if(this.changeSaveTimer){clearTimeout(this.changeSaveTimer);this.changeSaveTimer=undefined;void this.store.save().catch(()=>undefined);}
  }
}
