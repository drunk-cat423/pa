import type { ChannelRoute } from './channel-types.js';

export interface ReminderInput { key: string; goal: string; remindAt: string; timezone: 'Asia/Shanghai' }
export type WorkStatus = 'scheduled' | 'running' | 'waiting_user' | 'cancel_requested' | 'cancelled' | 'completed';
export interface WorkItem {
  id: string; ownerPersonId: string; kind: 'reminder'; goal: string; originMessageId: string;
  sourceConversationId: string; sourceRoute: ChannelRoute; status: WorkStatus; version: number;
  remindAt: string; timezone: 'Asia/Shanghai'; createdAt: string; updatedAt: string;
}
export interface ReminderLease {
  workId: string; version: number; attempt: number; token: string; goal: string;
  route: ChannelRoute; ownerPersonId: string;
}
export interface WorkNotification { id: string; workId: string; eventSeq: number; route: ChannelRoute; text: string; status: 'queued'|'sending'|'sent'|'rejected'|'uncertain' }
export type NotificationOutcome = 'sent' | 'rejected' | 'uncertain';
