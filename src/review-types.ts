import type { DocumentSnapshot, Role } from './types';

export interface ReviewResult {
  summary: string;
  overall: { type: string; title: string; reason: string }[];
  suggestions: ReviewSuggestionInput[];
}
export interface ReviewSuggestionInput {
  type: string; title: string; quote: string; contextBefore: string; contextAfter: string;
  reason: string; replacement: string | null; evidenceQuotes?: string[];
}
export interface AuthorSnapshot { id: string; name: string; systemPrompt: string }
export const authorSnapshot = (role: Role): AuthorSnapshot => ({ id: role.id, name: role.name, systemPrompt: role.systemPrompt });
export interface TextAnchor { from: number; to: number; text: string; valid: boolean }
export interface ScopeAnchor { from: number; to: number; valid: boolean }
export interface SuggestionAnchors {
  target: TextAnchor; before?: TextAnchor; after?: TextAnchor; evidence: TextAnchor[]; scope: ScopeAnchor;
}
export type SuggestionState = 'pending' | 'comment' | 'unlocated' | 'needs-check' | 'applying' | 'applied' | 'ignored';
export interface SuggestionVersion {
  id: string; at: number; author: AuthorSnapshot; reason: string; replacement: string | null;
  evidenceQuotes: string[]; supersededBy?: string;
}
export interface SuggestionReply { id: string; at: number; author: AuthorSnapshot; input: string; content: string; status: 'completed' | 'failed' | 'stopped' | 'interrupted' }
export interface Suggestion {
  id: string; documentId: string; runId: string; number: number; type: string; title: string;
  quote: string; contextBefore: string; contextAfter: string; author: AuthorSnapshot;
  versions: SuggestionVersion[]; currentVersionId: string; anchors?: SuggestionAnchors;
  state: SuggestionState; invalidReason?: string; fingerprint: string; replies: SuggestionReply[];
  handledAt?: number;
}
export interface ApplyReceipt {
  id: string; suggestionId: string; versionId: string; documentId: string; at: number;
  before: string; replacement: string; anchor: TextAnchor; beforeContext?: TextAnchor; afterContext?: TextAnchor;
  state: 'applied' | 'undone' | 'needs-check'; beforeHash: string; afterHash: string;
}
export interface ReviewDiagnostic {
  category: string; httpStatus?: number; code?: string;
  stage?: 'configuration' | 'models' | 'chat' | 'review';
}
export interface ReviewRun {
  id: string; requestId: string; at: number; author: AuthorSnapshot; model: string; providerName: string;
  snapshotHash: string; scope: 'body' | 'selection'; status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  summary: string; overall: ReviewResult['overall']; added: number; duplicates: number; error?: string;
  /** Optional only for older schema-2 history; every new captured request stores these. */
  documentId?: string; path?: string; providerId?: string; from?: number; to?: number;
  selection?: string; snapshot?: string; input?: string; preferences?: string; brief?: string;
  errorKind?: string; errorDiagnostic?: ReviewDiagnostic;
}
export interface DocumentReview {
  verifiedHash: string; runs: ReviewRun[]; suggestions: Suggestion[]; receipts: ApplyReceipt[]; selectedId?: string;
}
export interface TextChange { from: number; to: number; insert: string }
export type ChangeKind = 'edit' | 'undo' | 'redo' | 'apply' | 'revert';
export interface ReviewCapture { snapshot: DocumentSnapshot; sequence: number }
export interface SelectionSummary { kind: 'body' | 'selection' | 'multiple'; characters: number }
export interface SuggestionPreview {
  documentId: string; path: string; suggestion: Suggestion; version: SuggestionVersion;
  before: string; after?: string; from?: number; to?: number; valid: boolean; reason?: string;
}
export function currentVersion(suggestion: Suggestion): SuggestionVersion {
  const version = suggestion.versions.find(v => v.id === suggestion.currentVersionId);
  if (!version) throw new Error('批注版本缺失，请重新审阅。');
  return version;
}
export function ensureReview(session: { review?: DocumentReview }): DocumentReview {
  return session.review ??= { verifiedHash: '', runs: [], suggestions: [], receipts: [] };
}
