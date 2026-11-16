/**
 * THE LOOPBACK LISTENER FOR SIGN IN WITH CHATGPT (credential management §11
 * "Sign-in"; epic Task 14).
 *
 * OpenAI returns the browser to `http://127.0.0.1:<port>/auth/callback`, which
 * is the person's own computer. A daemon there listens on that address for the
 * server and relays what the browser brought back. The server exchanges the
 * code itself, so the token set never passes through a daemon.
 *
 *  - server → daemon `oauthLoopbackRequest`: listen on `127.0.0.1:<port>` for
 *    `ttlMs`, answered at once by `oauthLoopbackResult` (listening or not).
 *  - daemon → server `oauthLoopbackCallback`: the callback's query fields, at
 *    most once per request. Strict: `code`, `state`, the issued `clientId`, the
 *    granted `scope`, or OpenAI's `error`; no other field, so no token can ride
 *    along.
 */

import { z } from 'zod'

/** The daemon listens on a loopback address for an OAuth callback. */
export const CAP_OAUTH_LOOPBACK = 'oauth.loopback.v1'

const field = (max: number) => z.string().min(1).max(max)

export const OauthLoopbackRequestMessage = z.object({
  type: z.literal('oauthLoopbackRequest'),
  requestId: z.string(),
  port: z.number().int().min(1024).max(65_535),
  path: z.literal('/auth/callback'),
  /** The listener closes after this long, or at its first callback. */
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(15 * 60_000),
})
export type OauthLoopbackRequestMessage = z.infer<typeof OauthLoopbackRequestMessage>

export const OauthLoopbackResultMessage = z.object({
  type: z.literal('oauthLoopbackResult'),
  requestId: z.string(),
  listening: z.boolean(),
  /** Why it is not listening (the port is taken). */
  error: z.string().max(300).optional(),
})
export type OauthLoopbackResultMessage = z.infer<typeof OauthLoopbackResultMessage>

export const OauthLoopbackCallbackMessage = z
  .object({
    type: z.literal('oauthLoopbackCallback'),
    /** The `oauthLoopbackRequest` this listener was opened for. */
    requestId: z.string(),
    code: field(4096).optional(),
    state: field(512).optional(),
    clientId: field(256).optional(),
    scope: field(1024).optional(),
    error: field(128).optional(),
    errorDescription: field(1024).optional(),
  })
  .strict()
export type OauthLoopbackCallbackMessage = z.infer<typeof OauthLoopbackCallbackMessage>
