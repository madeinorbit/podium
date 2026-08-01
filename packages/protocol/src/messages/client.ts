import { z } from 'zod'
import {
  PresenceSubscribeMessage,
  PresenceUnsubscribeMessage,
  PresenceUpdateMessage,
} from '../planes/presence-rooms'
import { SessionOpenUrlCallbackMessage, SessionOpenUrlDismissMessage } from './browser-open'
import {
  AttachMessage,
  DetachMessage,
  DraftEditMessage,
  HelloMessage,
  InputMessage,
  PingMessage,
  PresenceMessage,
  RedrawRequestMessage,
  RequestControlMessage,
  ResizeMessage,
  SetSessionDraftMessage,
  ViewStateMessage,
} from './terminal'
import { TranscriptSubscribeMessage, TranscriptUnsubscribeMessage } from './transcript'

// ---- Browser client -> server ----
export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  AttachMessage,
  DetachMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
  PingMessage,
  PresenceMessage,
  ViewStateMessage,
  TranscriptSubscribeMessage,
  TranscriptUnsubscribeMessage,
  SetSessionDraftMessage,
  DraftEditMessage,
  SessionOpenUrlCallbackMessage,
  SessionOpenUrlDismissMessage,
  PresenceSubscribeMessage,
  PresenceUnsubscribeMessage,
  PresenceUpdateMessage,
])
export type ClientMessage = z.infer<typeof ClientMessage>
