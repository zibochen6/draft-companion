import type { TextAnchor, TextChange } from './review-types';

export interface DailyTopicSettings {
  time: string; timeZone: 'Asia/Shanghai'; providerId: string; roleId: string;
  authorBackground: string; targetReader: string; interests: string; exclusions: string;
  githubFallback: boolean;
}
export interface SourceMaterial {
  url: string; title?: string; text: string; status: 'verified' | 'unavailable'; message?: string; truncated?: boolean;
}
export interface SourceItem {
  id: string; canonicalId: string; kind: 'repository' | 'news'; title: string; summary: string;
  url: string; source: string; fingerprint: string; createdAt?: string; publishedAt?: string;
  primaryUrl?: string; repository?: string; stars?: number; sourceIds?: string[];
  metadata?: Record<string, string | number | boolean>; materials?: SourceMaterial[];
}
export interface SourceStatus {
  name: string; status: 'success' | 'failed' | 'fallback'; message: string; at: number;
}
export interface TopicCard {
  sourceId: string; selected: boolean; description?: string; reason: string; gaps: string[];
  potential: 'high' | 'medium' | 'needs-materials'; angle?: string; primaryTitle?: string;
  alternativeTitles?: string[]; opening?: string; outline?: string[];
  evidence?: { sourceId: string; quote: string }[];
}
export type DailyTopicStatus = 'queued' | 'collecting' | 'screening' | 'reading' | 'preparing' | 'committing' | 'completed' | 'no-new' | 'failed' | 'stopped' | 'interrupted';
export interface DailyTopicRun {
  id: string; date: string; origin: 'manual' | 'scheduled'; status: DailyTopicStatus; stage: string;
  documentId?: string; path?: string;
  startedAt: number; completedAt?: number; sources: SourceStatus[]; cards: TopicCard[];
  entries?: { sourceId: string; title: string; url: string; source: string }[];
  receiptId?: string; message?: string; error?: string;
}
export interface TopicBatchBlock { id: string; canonicalId: string; anchor: TextAnchor }
export interface TopicBatchReceipt {
  id: string; runId: string; documentId: string; path: string; date: string; at: number;
  state: 'prepared' | 'applied' | 'undone' | 'needs-check'; beforeHash: string; afterHash: string;
  blocks: TopicBatchBlock[]; invalidReason?: string;
}
export interface DailySeenRecord { fingerprint: string; selected: boolean; runId: string; at: number }
export interface DailyTopicData {
  settings: DailyTopicSettings; runs: DailyTopicRun[]; receipts: TopicBatchReceipt[];
  seen: Record<string, DailySeenRecord>;
}
export interface DailyTopicEntry { item: SourceItem; card: TopicCard }
export interface DailyTopicUpdate {
  changes: TextChange[]; after: string; blocks: TopicBatchBlock[]; countCandidates: number; countSelected: number;
}
export type DailySourceItem = SourceItem;
export type DailySourceStatus = SourceStatus;

export function defaultDailyTopicSettings(): DailyTopicSettings {
  return {
    time: '09:00', timeZone: 'Asia/Shanghai', providerId: '', roleId: '', authorBackground: '',
    targetReader: '希望把 AI 用到实际工作中的中文读者',
    interests: 'AI 实用工具、Agent、知识管理、内容创作、可复用工作流', exclusions: '', githubFallback: true,
  };
}
export function defaultDailyTopicData(): DailyTopicData {
  return { settings: defaultDailyTopicSettings(), runs: [], receipts: [], seen: {} };
}
