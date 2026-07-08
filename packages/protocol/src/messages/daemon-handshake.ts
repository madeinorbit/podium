import { z } from 'zod'

// ---- daemon handshake (pre-auth; NOT part of the Control/Daemon unions) ----
export const PairFrame = z.object({
  type: z.literal('pair'),
  code: z.string(),
  machineId: z.string(),
  hostname: z.string(),
  name: z.string().optional(),
})
export const HelloFrame = z.object({
  type: z.literal('hello'),
  machineId: z.string(),
  token: z.string(),
  hostname: z.string(),
})
export const DaemonHandshake = z.discriminatedUnion('type', [PairFrame, HelloFrame])
export type DaemonHandshake = z.infer<typeof DaemonHandshake>

export const PairedReply = z.object({
  type: z.literal('paired'),
  token: z.string(),
  machineId: z.string(),
  name: z.string(),
})
export const PairRejectedReply = z.object({ type: z.literal('pairRejected'), reason: z.string() })
export const HelloOkReply = z.object({ type: z.literal('helloOk'), name: z.string() })
export const HelloRejectedReply = z.object({ type: z.literal('helloRejected'), reason: z.string() })
export const DaemonHandshakeReply = z.discriminatedUnion('type', [
  PairedReply,
  PairRejectedReply,
  HelloOkReply,
  HelloRejectedReply,
])
export type DaemonHandshakeReply = z.infer<typeof DaemonHandshakeReply>

export function parseDaemonHandshake(raw: string): DaemonHandshake {
  return DaemonHandshake.parse(JSON.parse(raw))
}
export function parseDaemonHandshakeReply(raw: string): DaemonHandshakeReply {
  return DaemonHandshakeReply.parse(JSON.parse(raw))
}
