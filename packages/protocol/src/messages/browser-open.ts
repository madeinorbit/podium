import { z } from 'zod'

/** The loopback listener inferred from an authorization URL's redirect_uri. */
export const BrowserOpenCallbackTarget = z.object({
  host: z.enum(['localhost', '127.0.0.1', '::1']),
  port: z.number().int().min(1).max(65_535),
  path: z.string().startsWith('/'),
})
export type BrowserOpenCallbackTarget = z.infer<typeof BrowserOpenCallbackTarget>

/** What the daemon believes the open is for: a login flow that may need the
 * callback paste-back affordance, or a plain link the user just opens.
 * Harness adapters classify first; the redirect_uri heuristic is the fallback.
 * Optional for daemons predating the field — absent means "infer from
 * callbackTarget presence". */
export const BrowserOpenIntent = z.enum(['login', 'link'])
export type BrowserOpenIntent = z.infer<typeof BrowserOpenIntent>

/** Daemon -> server -> browser: a session asked its host OS to open a URL. */
export const SessionOpenUrlMessage = z.object({
  type: z.literal('sessionOpenUrl'),
  sessionId: z.string(),
  requestId: z.string(),
  url: z.string().url(),
  intent: BrowserOpenIntent.optional(),
  callbackTarget: BrowserOpenCallbackTarget.optional(),
  expiresAt: z.number().int().positive(),
})
export type SessionOpenUrlMessage = z.infer<typeof SessionOpenUrlMessage>

/** Browser -> server -> owning daemon: execute the pasted callback on that host. */
export const SessionOpenUrlCallbackMessage = z.object({
  type: z.literal('sessionOpenUrlCallback'),
  sessionId: z.string(),
  requestId: z.string(),
  url: z.string().min(1).max(16_384),
})
export type SessionOpenUrlCallbackMessage = z.infer<typeof SessionOpenUrlCallbackMessage>

/** Browser -> server -> owning daemon: revoke an open request without completing it. */
export const SessionOpenUrlDismissMessage = z.object({
  type: z.literal('sessionOpenUrlDismiss'),
  sessionId: z.string(),
  requestId: z.string(),
})
export type SessionOpenUrlDismissMessage = z.infer<typeof SessionOpenUrlDismissMessage>

/** Daemon/server -> browser: terminal state (or retryable failure) for the affordance. */
export const SessionOpenUrlResultMessage = z.object({
  type: z.literal('sessionOpenUrlResult'),
  sessionId: z.string(),
  requestId: z.string(),
  status: z.enum(['completed', 'failed', 'dismissed', 'expired']),
  error: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
})
export type SessionOpenUrlResultMessage = z.infer<typeof SessionOpenUrlResultMessage>
