export type TaskMode = 'discuss' | 'edit';
export type EditScope = 'auto' | 'body' | 'selection';
export interface Provider {
  id: string; name: string; baseUrl: string; secretRef: string; model: string;
  stream: boolean; timeoutMs: number; contextLimit?: number;
}
export interface Role {
  id: string; name: string; description: string; systemPrompt: string;
  defaultMode: TaskMode; quickTasks: string[];
}
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Message {
  id: string; role: 'user' | 'assistant' | 'event'; content: string; at: number;
  roleName?: string; model?: string; providerName?: string;
  status?: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted'; candidateId?: string;
}
export interface DocumentRecord { id: string; path: string; ctime: number; deleted?: boolean }
export type CandidateState = 'ready' | 'applying' | 'applied' | 'discarded' | 'superseded' | 'stale' | 'undone';
export interface Candidate {
  id: string; requestId: string; documentId: string; sessionId: string; path: string;
  scope: 'body' | 'selection'; from: number; to: number;
  baseline: string; baselineHash: string; replacement: string;
  explanation: string; notes: string[]; state: CandidateState; deletion: boolean;
}
export interface UndoRecord {
  documentId: string; path: string; before: string; from: number; to: number;
  replacement: string; candidateId: string;
}
export interface Session {
  id: string; document: DocumentRecord; brief: string; selectedRoleId: string;
  mode: TaskMode; messages: Message[]; candidate?: Candidate; undo?: UndoRecord;
}
export interface PluginData {
  version: number; initialized: boolean; providers: Provider[]; activeProviderId: string;
  roles: Role[]; preferences: string; sessions: Record<string, Session>;
}
export interface DocumentSnapshot {
  documentId: string; path: string; fullText: string; hash: string;
  scope: 'body' | 'selection'; from: number; to: number; selectedText: string;
}
export interface RequestSnapshot extends DocumentSnapshot {
  requestId: string; sessionId: string; role: Role; provider: Provider;
  input: string; mode: TaskMode; preferences: string; brief: string; history: Message[];
}
export interface ParsedEdit { explanation: string; replacement: string; notes: string[] }
export interface RunningRequest {
  id: string; documentId: string; path: string; sessionId: string; roleName: string;
  text: string; mode: TaskMode; stop: () => void;
}
export interface ModelInfo { id: string }
export interface ChatResult { text: string; finishReason: string }
