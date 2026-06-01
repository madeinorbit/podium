import { z } from 'zod'

const positiveInt = z.number().int().positive()

export const Geometry = z.object({ cols: positiveInt, rows: positiveInt })
export type Geometry = z.infer<typeof Geometry>

export const Viewport = z.object({
  cols: positiveInt,
  rows: positiveInt,
  dpr: z.number().positive(),
})
export type Viewport = z.infer<typeof Viewport>

// ---- Browser client -> server ----
export const HelloMessage = z.object({
  type: z.literal('hello'),
  clientId: z.string(),
  viewport: Viewport,
})
export const InputMessage = z.object({ type: z.literal('input'), data: z.string() })
// Client's requested terminal grid (client -> server). Same shape as Geometry.
export const ResizeMessage = z.object({ type: z.literal('resize'), ...Geometry.shape })
export const RequestControlMessage = z.object({ type: z.literal('requestControl') })
export const RedrawRequestMessage = z.object({ type: z.literal('redrawRequest') })

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  InputMessage,
  ResizeMessage,
  RequestControlMessage,
  RedrawRequestMessage,
])
export type ClientMessage = z.infer<typeof ClientMessage>

// ---- Server -> browser client ----
export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  clientId: z.string(),
  sessionId: z.string(),
  controllerId: z.string(),
  geometry: Geometry,
})
export const OutputFrameMessage = z.object({
  type: z.literal('outputFrame'),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  data: z.string(),
})
export const ControllerChangedMessage = z.object({
  type: z.literal('controllerChanged'),
  controllerId: z.string(),
  geometry: Geometry,
})
// Server's authoritative PTY size, for spectator letterboxing (server -> client).
export const GeometryMessage = z.object({ type: z.literal('geometry'), ...Geometry.shape })
export const AgentExitMessage = z.object({ type: z.literal('agentExit'), code: z.number().int() })

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>

// ---- Daemon <-> server ----
export const BindMessage = z.object({
  type: z.literal('bind'),
  sessionId: z.string(),
  cmd: z.string(),
  geometry: Geometry,
})
export const RedrawMessage = z.object({ type: z.literal('redraw') })

// daemon -> server
export const DaemonMessage = z.discriminatedUnion('type', [
  BindMessage,
  OutputFrameMessage,
  AgentExitMessage,
])
export type DaemonMessage = z.infer<typeof DaemonMessage>

// server -> daemon
export const ControlMessage = z.discriminatedUnion('type', [
  InputMessage,
  ResizeMessage,
  RedrawMessage,
])
export type ControlMessage = z.infer<typeof ControlMessage>

// Codecs. parse* functions throw on malformed JSON (SyntaxError) or on a schema
// mismatch (ZodError); callers handle both.
// ---- codec ----
type AnyMessage = ClientMessage | ServerMessage | DaemonMessage | ControlMessage

export function encode(msg: AnyMessage): string {
  return JSON.stringify(msg)
}

export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw))
}
export function parseServerMessage(raw: string): ServerMessage {
  return ServerMessage.parse(JSON.parse(raw))
}
export function parseDaemonMessage(raw: string): DaemonMessage {
  return DaemonMessage.parse(JSON.parse(raw))
}
export function parseControlMessage(raw: string): ControlMessage {
  return ControlMessage.parse(JSON.parse(raw))
}
