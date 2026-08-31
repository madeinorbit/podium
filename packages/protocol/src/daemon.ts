/**
 * Daemon-only wire surface.
 *
 * The browser speaks ClientMessage and ServerMessage. ControlMessage,
 * DaemonMessage, and shipping effects live on the server-to-daemon socket and
 * must not enter the common protocol barrel: their eager Zod schemas otherwise
 * become part of every browser bundle that imports @podium/protocol.
 */

import type { DaemonHandshake, DaemonHandshakeReply } from './messages/daemon-handshake'
import type { ClientMessage } from './messages/client'
import { ControlMessage } from './messages/control'
import { DaemonMessage } from './messages/daemon'
import type { ServerMessage } from './messages/server'

export * from './messages/control'
export * from './messages/fleet-logs'
export * from './messages/daemon'
export * from './messages/shipping'

type DaemonWireMessage =
  | ClientMessage
  | ServerMessage
  | ControlMessage
  | DaemonMessage
  | DaemonHandshake
  | DaemonHandshakeReply

/** Serialize a daemon-plane frame without routing its schemas through the
 * browser/common codec. */
export function encodeDaemonMessage(message: DaemonWireMessage): string {
  return JSON.stringify(message)
}

export function parseDaemonMessage(raw: string): DaemonMessage {
  return DaemonMessage.parse(JSON.parse(raw))
}

export function parseControlMessage(raw: string): ControlMessage {
  return ControlMessage.parse(JSON.parse(raw))
}
