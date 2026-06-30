import { z } from 'zod'

/** One-paste machine-join payload. base64url-encoded into the `--join <TOKEN>` arg. */
export const JoinPayload = z.object({
  v: z.literal(1),
  /** ws:// or wss:// relay URL the daemon dials (the instance's publicUrl, ws-ified). */
  serverUrl: z.string().min(1),
  /** Single-use, server-minted pairing code (~10 min TTL). */
  pairCode: z.string().min(1),
  /** Optional display name for the new machine. */
  name: z.string().optional(),
})
export type JoinPayload = z.infer<typeof JoinPayload>

export function encodeJoin(p: JoinPayload): string {
  return Buffer.from(JSON.stringify(JoinPayload.parse(p))).toString('base64url')
}

/** Decode + validate. Throws on malformed base64url, bad JSON, or schema mismatch. */
export function decodeJoin(token: string): JoinPayload {
  let json: string
  try {
    json = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    throw new Error('invalid join token (not base64url)')
  }
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    throw new Error('invalid join token (not JSON)')
  }
  return JoinPayload.parse(obj)
}
