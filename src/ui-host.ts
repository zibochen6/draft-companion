import type { Candidate, DocumentRecord, EditScope, ModelInfo, PluginData, Provider, RunningRequest, Session, TaskMode } from './types';

/** UI contract. Provider and role edits mutate data, then await saveSettings(). No API secrets live in data. */
export interface UIHost {
  readonly data: PluginData;
  readonly running: RunningRequest | undefined;
  currentSession(): Session | null;
  target(): DocumentRecord | null;
  subscribe(listener: () => void): () => void;
  saveSettings(): Promise<void>;
  send(input: string, mode: TaskMode, scope: EditScope): Promise<void>;
  stop(): void;
  apply(candidate: Candidate): Promise<void>;
  discard(candidate: Candidate): Promise<void>;
  undo(): Promise<void>;
  deleteRange(scope: EditScope): Promise<void>;
  clearSession(): Promise<void>;
  chooseRole(roleId: string): Promise<void>;
  setBrief(brief: string): Promise<void>;
  models(provider: Provider): Promise<ModelInfo[]>;
  testProvider(provider: Provider): Promise<string>;
  openSettings(): void;
}
