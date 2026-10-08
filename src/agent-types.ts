import type { DocumentRecord, DocumentSnapshot, EditScope, RequestSnapshot } from './types';
import type { TextAnchor, TextChange, ChangeKind } from './review-types';

export type AgentTask = 'auto' | 'discuss' | 'review' | 'propose' | 'execute' | 'topic' | 'titles' | 'outline';
export interface AgentSubmitOptions { task?: AgentTask; scope?: EditScope }
export type AgentIntent = 'discuss' | 'select-topic' | 'recommend-topic' | 'replace' | 'insert' | 'propose' | 'clarify' | 'undo' | 'review';
export interface TopicSelectionPolicy { mode: 'exact' | 'adaptive'; min: number; max: number }
export interface IntentResult { intent: AgentIntent; quote?: string; count?: number; topicSelection?: TopicSelectionPolicy; question?: string }
export interface AgentActionReceipt {
  id: string; requestId: string; documentId: string; path: string; at: number;
  kind: 'topic-check' | 'replace' | 'insert'; label: string;
  before: string; replacement: string; anchor: TextAnchor;
  beforeContext?: TextAnchor; afterContext?: TextAnchor;
  beforeHash: string; afterHash: string;
  state: 'prepared' | 'applied' | 'undone' | 'needs-check';
  invalidReason?: string;
}
export interface ToolOutcome {
  status: 'success' | 'noop' | 'conflict' | 'failed'; message: string;
  data?: unknown; actionId?: string;
}
export interface AgentRequestContext {
  snapshot: RequestSnapshot; document: DocumentRecord; documentRef: string;
  intent: IntentResult; range?: TextAnchor; rangeRef?: string; insertion?: TextAnchor; insertionRef?: string;
  selectedTopicRefs: Set<string>; topicBudget: number; topicPolicy?: TopicSelectionPolicy;
  signal: AbortSignal; assertActive: () => void;
  changeChain?: AgentDocumentChange[];
}
export interface AgentToolServices {
  latest(document: DocumentRecord): Promise<DocumentSnapshot>;
  save(): Promise<void>;
  changed(): void;
  propose(context: AgentRequestContext, explanation: string, replacement: string, notes: string[]): Promise<void>;
  receipts(documentId: string): AgentActionReceipt[];
  reveal(document: DocumentRecord, from: number, to: number): Promise<void>;
}
export interface AgentDocumentChange { documentId: string; before: string; after: string; changes: TextChange[]; kind: ChangeKind }
