export interface ChannelRoute {
  channel: string;
  accountId: string;
  roomId: string;
  roomType: 'group' | 'private';
}

export interface ExternalRunInput {
  eventId: string;
  senderId: string;
  senderName?: string;
  modelInputText: string;
  messageKind?: 'chat' | 'memory';
  profileFields?: import('./memory-types.js').ProfileField[];
}

export interface InboundMessage {
  route: ChannelRoute;
  eventId: string;
  senderId: string;
  senderName?: string;
  text: string;
  sentAt: string;
  mentioned: boolean;
}

export interface OutboundMessage {
  route: ChannelRoute;
  replyToMessageId: string;
  text: string;
}

export type DeliveryResult =
  | { status: 'sent'; externalMessageId: string }
  | { status: 'uncertain' | 'rejected' };
