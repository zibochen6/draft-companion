import type { AgentRequestContext, AgentToolServices, ToolOutcome, TopicSelectionPolicy } from './agent-types';
import type { ToolCall, ToolDefinition, DocumentSnapshot } from './types';
import type { TextAnchor } from './review-types';
import { AgentActions } from './agent-actions';
import { parseTopicItems, type TopicItem } from './topics';

interface TrackedTopic { item: TopicItem; anchor: TextAnchor; status: TextAnchor }
const schemaString = { type: 'string', minLength: 1 };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
function anchorMatches(text: string, anchor: TextAnchor): boolean {
  return anchor.valid && anchor.from >= 0 && anchor.to >= anchor.from && anchor.to <= text.length && text.slice(anchor.from, anchor.to) === anchor.text;
}

/** Every reference is scoped to one frozen request and one document. */
export class AgentTools {
  private topics = new Map<string, TrackedTopic>();
  private releases: (() => void)[] = [];
  private actionIds: Set<string>;
  private topicsListed = false;
  private topicPlan?: { refs: string[]; reason: string; blocked?: string };
  private disposed = false;
  constructor(private context: AgentRequestContext, private services: AgentToolServices, private actions: AgentActions) {
    actions.trackContext(context);
    for (const change of context.changeChain ?? []) actions.mapContext(context, change);
    for (const item of parseTopicItems(context.snapshot.fullText, context.documentRef)) {
      const anchor: TextAnchor = { from: item.from, to: item.to, text: item.raw, valid: true };
      const status: TextAnchor = { from: item.statusFrom, to: item.statusTo, text: context.snapshot.fullText.slice(item.statusFrom, item.statusTo), valid: true };
      actions.replayAnchor(context.document.id, anchor, context.snapshot.fullText, context.changeChain ?? []);
      actions.replayAnchor(context.document.id, status, context.snapshot.fullText, context.changeChain ?? []);
      this.releases.push(actions.trackAnchor(context.document.id, anchor), actions.trackAnchor(context.document.id, status));
      this.topics.set(item.ref, { item, anchor, status });
    }
    this.actionIds = new Set(services.receipts(context.document.id).map(receipt => receipt.id));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.releases) release();
    this.releases = []; this.actions.releaseContext(this.context);
  }
  definitions(): ToolDefinition[] {
    const allowed = new Set(this.allowedToolNames());
    return this.allDefinitions().filter(item => allowed.has(item.function.name));
  }
  /**
   * Keep the complete schema locally so that an omitted tool is still parsed
   * and rejected as an authorization failure.  The definitions sent to a
   * provider are only the small, request-specific subset above.
   */
  private allDefinitions(): ToolDefinition[] {
    const doc = { document_ref: schemaString };
    return [
      definition('read_document', '获取当前授权文稿引用、最新版本和授权范围。全文已在初始上下文中，不重复返回。', doc, ['document_ref']),
      definition('list_topic_items', '列出当前授权文稿中的顶层选题任务及请求内引用。重复标题是独立条目，过期条目不可操作。', doc, ['document_ref']),
      definition('plan_topic_selection', '读取选题后一次确定本轮选择集合。只填未勾选、有效、不重复的topic_ref；质量不足可零个，明确数量必须满足，否则不能写入。计划成功后不能换题或扩张集合。', { ...doc, topic_refs: { type: 'array', items: schemaString, maxItems: 8 }, reason: schemaString }, ['document_ref', 'topic_refs', 'reason']),
      definition('set_topic_checked', '只勾选已成功冻结计划中的一个条目；先调用plan_topic_selection，不能增加候选、换题或取消其他条目。', { ...doc, topic_ref: schemaString, checked: { type: 'boolean', const: true } }, ['document_ref', 'topic_ref', 'checked']),
      definition('replace_text_range', '只替换当前请求已冻结授权的range_ref文字；不能提供路径、偏移或扩大范围。', { ...doc, range_ref: schemaString, replacement: schemaString, label: schemaString }, ['document_ref', 'range_ref', 'replacement']),
      definition('insert_text', '只在当前请求已冻结授权的insertion_ref单点插入文字。', { ...doc, insertion_ref: schemaString, text: schemaString, label: schemaString }, ['document_ref', 'insertion_ref', 'text']),
      definition('propose_edits', '建立待用户确认的改稿候选，不直接写入文稿。', { ...doc, explanation: schemaString, replacement: schemaString, notes: { type: 'array', items: { type: 'string' } } }, ['document_ref', 'explanation', 'replacement', 'notes']),
      definition('reveal_location', '定位本请求已知的选题、授权范围或插入位置引用。', { ...doc, target_ref: schemaString }, ['document_ref', 'target_ref']),
      definition('undo_action', '在用户明确要求撤回时，安全撤回当前文稿内已列出的局部操作。', { ...doc, action_id: schemaString }, ['document_ref', 'action_id']),
    ];
  }
  private allowedToolNames(): string[] {
    switch (this.context.intent.intent) {
      case 'select-topic': return ['read_document', 'list_topic_items', 'plan_topic_selection', 'set_topic_checked', 'reveal_location'];
      case 'recommend-topic': return ['read_document', 'list_topic_items', 'reveal_location'];
      case 'replace': return ['read_document', 'replace_text_range', 'reveal_location'];
      case 'insert': return ['read_document', 'insert_text', 'reveal_location'];
      case 'propose': return ['read_document', 'propose_edits', 'reveal_location'];
      case 'undo': return ['read_document', 'undo_action', 'reveal_location'];
      default: return [];
    }
  }
  private active(): void {
    if (this.disposed || this.context.signal.aborted) throw new Error('本次请求已停止。');
    this.context.assertActive();
  }
  private args(call: ToolCall): Record<string, unknown> {
    if (call.type !== 'function' || !call.function || typeof call.function.arguments !== 'string') throw new Error('工具调用格式无效。');
    const def = this.allDefinitions().find(item => item.function.name === call.function.name);
    if (!def) throw new Error('未知工具，未执行。');
    let value: unknown;
    try { value = JSON.parse(call.function.arguments); } catch { throw new Error('工具参数必须是完整 JSON 对象。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是对象。');
    const args = value as Record<string, unknown>, schema = def.function.parameters;
    const properties = schema.properties as Record<string, { type: string; const?: unknown }>;
    if (Object.keys(args).some(key => !Object.prototype.hasOwnProperty.call(properties, key))) throw new Error('工具参数包含未授权字段。');
    for (const key of schema.required as string[]) if (!Object.prototype.hasOwnProperty.call(args, key)) throw new Error(`缺少工具参数：${key}。`);
    for (const [key, entry] of Object.entries(args)) {
      const spec = properties[key]!;
      if (spec.type === 'string' && (typeof entry !== 'string' || !entry.trim() || entry.length > 1_000_000)) throw new Error(`工具参数 ${key} 必须是非空文字。`);
      if (spec.type === 'boolean' && typeof entry !== 'boolean') throw new Error(`工具参数 ${key} 必须是布尔值。`);
      if (spec.type === 'array' && (!Array.isArray(entry) || entry.some(item => typeof item !== 'string'))) throw new Error(`工具参数 ${key} 必须是文字数组。`);
      if (spec.const !== undefined && entry !== spec.const) throw new Error('本次选题请求只允许打勾；取消请明确要求撤回。');
    }
    if (args.document_ref !== this.context.documentRef) throw new Error('文稿引用不属于本次请求。');
    return args;
  }
  private requireIntent(intent: string): void {
    if (this.context.intent.intent !== intent) throw new Error('当前请求没有授权这个操作。');
  }
  private async latest(): Promise<DocumentSnapshot> {
    this.active();
    const snapshot = await this.services.latest(this.context.document); this.active();
    if (snapshot.documentId !== this.context.document.id || snapshot.path !== this.context.document.path) throw new Error('当前文稿身份已变化。');
    this.actions.reconcile(this.context.document, snapshot.fullText); return snapshot;
  }
  private topicData(text: string): unknown[] {
    return [...this.topics.values()].map(({ item, anchor, status }, index) => {
      const available = anchorMatches(text, anchor) && anchorMatches(text, status);
      return {
        topic_ref: item.ref, item_index: index + 1,
        ...(available ? { source_line: text.slice(0, anchor.from).split('\n').length } : {}),
        title: item.title, checked: item.checked, section: item.section, available,
      };
    });
  }
  private knownActions(): unknown[] {
    return this.services.receipts(this.context.document.id).filter(receipt => this.actionIds.has(receipt.id))
      .map(receipt => ({ action_id: receipt.id, label: receipt.label, kind: receipt.kind, state: receipt.state, can_undo: this.actions.canUndo(this.context.document, receipt.id) }));
  }
  private selectionPolicy(): TopicSelectionPolicy {
    const policy = this.context.topicPolicy ?? this.context.intent.topicSelection;
    if (policy) {
      const exact = policy.mode === 'exact' && Number.isInteger(policy.min) && policy.min >= 1 && policy.min <= 8 && policy.max === policy.min;
      const adaptive = policy.mode === 'adaptive' && policy.min === 0 && Number.isInteger(policy.max) && policy.max >= 0 && policy.max <= 5;
      if (!exact && !adaptive) throw new Error('选题授权数量无效，未执行操作。');
      return policy;
    }
    // Legacy request fixtures retain their explicit budget, while all new
    // controller requests provide the locally constrained exact/adaptive policy.
    const count = this.context.intent.count ?? this.context.topicBudget;
    return Number.isInteger(count) && count > 0 && count <= 8 ? { mode: 'exact', min: count, max: count } : { mode: 'adaptive', min: 0, max: 5 };
  }
  private planData(): unknown {
    return this.topicPlan ? { topic_refs: [...this.topicPlan.refs], count: this.topicPlan.refs.length, reason: this.topicPlan.reason, blocked: this.topicPlan.blocked } : undefined;
  }
  private validateRemainingPlan(text: string): void {
    if (!this.topicPlan || this.topicPlan.blocked) throw new Error(this.topicPlan?.blocked ?? '请先读取选题并一次确定本轮选择集合，再执行勾选。');
    for (const ref of this.topicPlan.refs) {
      if (this.context.selectedTopicRefs.has(ref)) continue;
      const topic = this.topics.get(ref)!;
      if (!anchorMatches(text, topic.anchor) || !anchorMatches(text, topic.status) || topic.item.checked) {
        this.topicPlan.blocked = '本轮计划中的选题已变化，已停止其余勾选。已完成的修改保留，不能改选其他条目。';
        throw new Error(this.topicPlan.blocked);
      }
    }
  }
  async execute(call: ToolCall): Promise<ToolOutcome> {
    try {
      this.active(); const args = this.args(call), name = call.function.name;
      if (name === 'read_document') {
        const latest = await this.latest();
        return { status: 'success', message: '完整正文已在初始上下文中；这里返回最新版本和授权引用。', data: {
          document_ref: this.context.documentRef, hash: latest.hash,
          authorized_range: this.context.rangeRef ? { range_ref: this.context.rangeRef, available: !!this.context.range && anchorMatches(latest.fullText, this.context.range), characters: this.context.range?.text.length ?? 0 } : undefined,
          insertion_ref: this.context.insertionRef,
          actions: this.knownActions(),
          selection_budget: this.selectionPolicy().max, selection_policy: this.selectionPolicy(), selection_plan: this.planData(),
        } };
      }
      if (name === 'list_topic_items') {
        const latest = await this.latest();
        this.topicsListed = true;
        return { status: 'success', message: '已列出本次请求冻结的顶层选题；简介和链接已在唯一全文中。', data: {
          document_ref: this.context.documentRef,
          topic_items: this.topicData(latest.fullText),
          selection_budget: this.selectionPolicy().max, selection_policy: this.selectionPolicy(), selection_plan: this.planData(),
        } };
      }
      if (name === 'plan_topic_selection') {
        this.requireIntent('select-topic');
        if (!this.topicsListed) throw new Error('请先读取本轮选题列表，再确定选择集合。');
        const refs = args.topic_refs as string[], reason = args.reason as string, policy = this.selectionPolicy();
        if (this.topicPlan) {
          const same = refs.length === this.topicPlan.refs.length && refs.every(ref => this.topicPlan!.refs.includes(ref));
          if (!same) throw new Error('本轮选题计划已固定，不能换题或追加其他条目。');
          return { status: this.topicPlan.blocked ? 'conflict' : 'noop', message: this.topicPlan.blocked ?? '本轮选择集合已固定，未重复执行计划或写入。', data: this.planData() };
        }
        if (refs.length > policy.max || new Set(refs).size !== refs.length || refs.some(ref => !this.topics.has(ref))) throw new Error('选择集合超出授权数量、包含重复条目或未知引用，未执行操作。');
        this.topicPlan = { refs: [...refs], reason };
        if (refs.length < policy.min) {
          this.topicPlan.blocked = `本轮明确需要${policy.min}个，但只有${refs.length}个合适选题；材料不足，本轮没有勾选。请明确调整要求后重新发起请求。`;
          return { status: 'conflict', message: this.topicPlan.blocked, data: this.planData() };
        }
        const latest = await this.latest();
        try { this.validateRemainingPlan(latest.fullText); }
        catch (error) { return { status: 'conflict', message: error instanceof Error ? error.message : '选题计划已变化。', data: this.planData() }; }
        return { status: 'success', message: refs.length ? `已固定${refs.length}个合适选题，尚未写入正文。` : '没有材料充分且值得写的选题，本轮零勾选。', data: this.planData() };
      }
      if (name === 'set_topic_checked') {
        this.requireIntent('select-topic');
        const topic = this.topics.get(args.topic_ref as string);
        if (!topic) throw new Error('选题引用不属于本次请求。');
        if (!this.topicPlan || !this.topicPlan.refs.includes(topic.item.ref)) throw new Error('这个选题不在已冻结的选择集合中，未执行勾选。');
        if (this.topicPlan.blocked) return { status: 'conflict', message: this.topicPlan.blocked };
        const latest = await this.latest();
        try { this.validateRemainingPlan(latest.fullText); }
        catch (error) { return { status: 'conflict', message: error instanceof Error ? error.message : '选题已变化。' }; }
        if (topic.item.checked) return { status: 'noop', message: '这个选题已打勾，本次没有写入。' };
        const raw = topic.anchor.text, relative = topic.status.from - topic.anchor.from;
        const outcome = await this.actions.apply(this.context, topic.status, 'x', `勾选「${topic.item.title}」`, 'topic-check', current => this.validateRemainingPlan(current));
        if (outcome.actionId) this.actionIds.add(outcome.actionId);
        if (outcome.status === 'success') {
          this.context.selectedTopicRefs.add(topic.item.ref);
          topic.anchor.text = raw.slice(0, relative) + 'x' + raw.slice(relative + 1); topic.anchor.valid = true;
          const receipt = this.services.receipts(this.context.document.id).find(item => item.id === outcome.actionId);
          if (receipt) { topic.status.from = receipt.anchor.from; topic.status.to = receipt.anchor.to; }
          topic.status.text = 'x'; topic.status.valid = true; topic.item.checked = true; topic.item.raw = topic.anchor.text;
          let revealed = false, revealReason: string | undefined;
          try {
            this.active();
            const current = await this.services.latest(this.context.document);
            if (!anchorMatches(current.fullText, topic.anchor)) { topic.anchor.valid = false; throw new Error('选题条目其他文字已变化，定位需要重新确认。'); }
            this.active(); await this.services.reveal(this.context.document, topic.anchor.from, topic.anchor.to); revealed = true;
          } catch (error) { revealReason = error instanceof Error ? error.message : '定位未完成。'; }
          outcome.data = { ...(outcome.data as Record<string, unknown> | undefined), topic_ref: topic.item.ref, title: topic.item.title,
            section: topic.item.section, checked: true, path: this.context.document.path, revealed, revealReason };
          if (!revealed) outcome.message += ' 自动定位未完成，可以稍后重新定位。';
        } else if (outcome.status !== 'noop') this.topicPlan.blocked = '本轮勾选未安全完成，已停止其余操作。已完成的修改保留，不能替换为其他选题。';
        return outcome;
      }
      if (name === 'replace_text_range' || name === 'insert_text') {
        const replace = name === 'replace_text_range'; this.requireIntent(replace ? 'replace' : 'insert');
        const ref = replace ? this.context.rangeRef : this.context.insertionRef, target = replace ? this.context.range : this.context.insertion;
        if (!ref || args[replace ? 'range_ref' : 'insertion_ref'] !== ref || !target) throw new Error('操作引用不属于本次授权范围。');
        const result = await this.actions.apply(this.context, target, args[replace ? 'replacement' : 'text'] as string,
          (args.label as string | undefined) ?? (replace ? '替换授权文字' : '插入授权文字'), replace ? 'replace' : 'insert');
        if (result.actionId) this.actionIds.add(result.actionId); return result;
      }
      if (name === 'propose_edits') {
        this.requireIntent('propose'); await this.latest(); this.active();
        await this.services.propose(this.context, args.explanation as string, args.replacement as string, args.notes as string[]);
        return { status: 'success', message: '已建立待确认的改稿候选，文稿未直接修改。' };
      }
      if (name === 'reveal_location') {
        const ref = args.target_ref as string;
        const target = ref === this.context.rangeRef ? this.context.range : ref === this.context.insertionRef ? this.context.insertion : this.topics.get(ref)?.anchor;
        if (!target) throw new Error('位置引用不属于本次请求。');
        const latest = await this.latest();
        if (!anchorMatches(latest.fullText, target)) return { status: 'conflict', message: '位置引用已失效，未定位到其他相似文字。' };
        this.active(); await this.services.reveal(this.context.document, target.from, target.to);
        return { status: 'success', message: '已定位到授权位置。' };
      }
      if (name === 'undo_action') {
        this.requireIntent('undo');
        const id = args.action_id as string;
        if (!this.actionIds.has(id)) throw new Error('撤回引用不属于本次请求已知的文稿操作。');
        this.active(); return await this.actions.undo(this.context.document, id, this.context.signal);
      }
      return { status: 'failed', message: '未知工具，未执行。' };
    } catch (error) { return { status: 'failed', message: error instanceof Error ? error.message : '工具未执行。' }; }
  }
}
