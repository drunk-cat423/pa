export interface ChannelRoute {
  channel: string;
  accountId: string;
  roomId: string;
  roomType: 'group' | 'private';
}

export interface MessageQuote {
  messageId?: string;
  referenceIndex?: string;
  inlineMessages?: { text: string; senderId?: string; senderName?: string }[];
  truncated?: boolean;
}

export interface ExternalRunInput {
  eventId: string;
  senderId: string;
  existingMessageId?: string;
  sentAt?: string;
  mentionedSenderIds?: string[];
  senderName?: string;
  modelInputText: string;
  quote?: MessageQuote;
  responseFormat?: 'plain_text';
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
  mentionedSenderIds?: string[];
  quote?: MessageQuote;
}

export interface OutboundMessage {
  route: ChannelRoute;
  replyToMessageId?: string;
  text: string;
  deliveryMode?: 'passive' | 'active';
  partIndex?: number;
  plainText?: boolean;
}

export type DeliveryResult =
  | { status: 'sent'; externalMessageId: string }
  | { status: 'uncertain' | 'rejected' };
