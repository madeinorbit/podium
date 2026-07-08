import { z } from 'zod'
import {
  AttachMessage,
  DetachMessage,
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
])
export type ClientMessage = z.infer<typeof ClientMessage>
