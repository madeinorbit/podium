/**
 * HARNESS HOMES (credential management §10 "Homes"; epic plan Task 8).
 *
 * A home is a harness's configuration directory that holds one subscription
 * login on one machine. The daemon keeps Podium's homes under its state
 * directory, one per credential and harness, and a session on that credential
 * starts with the harness's directory variable (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`) pointed at it. The harness's own directory is the home Podium
 * did not create: {@link DEFAULT_HOME_ID}.
 *
 * Nothing in these messages is secret. A home holds a login, but the login
 * never crosses the wire: the server only asks for a home to exist, to go, or
 * for a copied login file to be removed when its fingerprint still matches.
 */

import { HOME_HARNESS_KINDS } from '@podium/model'
import { z } from 'zod'

/** A daemon that offers this keeps homes, launches sessions in them, and
 *  answers `homeEnsureRequest`, `homeRemoveRequest` and
 *  `credentialRemoveRequest`. An older daemon is not asked. */
export const CAP_HARNESS_HOMES = 'harness.homes.v1'

/** The harness's own directory: not created, never removed by Podium. */
export const DEFAULT_HOME_ID = 'default'

/** The harnesses whose login lives in a directory a variable can move. */
export const HOME_HARNESSES = HOME_HARNESS_KINDS
export const HomeHarness = z.enum(HOME_HARNESSES)
export type HomeHarness = z.infer<typeof HomeHarness>

/**
 * A credential id as it may name a directory: `cred_` and then letters,
 * digits, `-` or `_`. Anything else (a `.`, a `/`) is refused, so a home can
 * never be made outside the homes directory.
 */
const CREDENTIAL_SEGMENT = /^cred_[A-Za-z0-9_-]{1,80}$/
export const HomeCredentialId = z.string().regex(CREDENTIAL_SEGMENT)

/** The home of `credentialId` for `harness`: `<credentialId>:<harness>`. */
export function homeIdFor(credentialId: string, harness: HomeHarness): string {
  if (!CREDENTIAL_SEGMENT.test(credentialId)) {
    throw new Error(`not a credential id a home can be named for: ${credentialId}`)
  }
  return `${credentialId}:${harness}`
}

/** The credential and harness a Podium home id names; null for `default` and
 *  for anything that is not a well-formed home id. */
export function parseHomeId(homeId: string): { credentialId: string; harness: HomeHarness } | null {
  const parts = homeId.split(':')
  if (parts.length !== 2) return null
  const [credentialId, harness] = parts as [string, string]
  if (!CREDENTIAL_SEGMENT.test(credentialId)) return null
  const parsed = HomeHarness.safeParse(harness)
  return parsed.success ? { credentialId, harness: parsed.data } : null
}

/** Server → daemon: make sure the home for this credential and harness exists. */
export const HomeEnsureRequestMessage = z.object({
  type: z.literal('homeEnsureRequest'),
  requestId: z.string(),
  credentialId: HomeCredentialId,
  harness: HomeHarness,
})
export type HomeEnsureRequestMessage = z.infer<typeof HomeEnsureRequestMessage>

/** `ok` with `homeId` and `created`, or not `ok` with `error`. One object, not
 *  a union: it is itself an arm of the daemon union. */
export const HomeEnsureResultMessage = z.object({
  type: z.literal('homeEnsureResult'),
  requestId: z.string(),
  ok: z.boolean(),
  homeId: z.string().optional(),
  /** False when the home already existed. */
  created: z.boolean().optional(),
  error: z.string().optional(),
})
export type HomeEnsureResultMessage = z.infer<typeof HomeEnsureResultMessage>

/**
 * Server → daemon: remove a Podium home. The daemon stops what runs in it
 * (the engines of its sessions, Codex's own app-server daemon) and deletes the
 * directory. `default` is refused: Podium never removes the harness's own
 * directory. With `signOut`, the vendor's sign-out runs in the home first.
 */
export const HomeRemoveRequestMessage = z.object({
  type: z.literal('homeRemoveRequest'),
  requestId: z.string(),
  homeId: z.string(),
  /**
   * Run the harness's own sign-out in the home before deleting it (§8). The
   * server sends it only while its sign-out switch is on (Task 9); a sign-out
   * that fails does not keep the home.
   */
  signOut: z.boolean().optional(),
})
export type HomeRemoveRequestMessage = z.infer<typeof HomeRemoveRequestMessage>

export const HomeRemoveResultMessage = z.object({
  type: z.literal('homeRemoveResult'),
  requestId: z.string(),
  ok: z.boolean(),
  /** False when there was no such home (already gone): also a confirmation. */
  removed: z.boolean().optional(),
  /** What the directory held, Codex's own installed copy included. */
  freedBytes: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
})
export type HomeRemoveResultMessage = z.infer<typeof HomeRemoveResultMessage>

/**
 * Server → daemon: remove the login file propagation copied for `harness`
 * (the harness's allowlisted login file in its own directory), only if the
 * login there still has `fingerprint`. A login someone signed in to since is
 * left in place and reported as `changed`.
 */
export const CredentialRemoveRequestMessage = z.object({
  type: z.literal('credentialRemoveRequest'),
  requestId: z.string(),
  harness: HomeHarness,
  fingerprint: z.string().min(1).max(256),
})
export type CredentialRemoveRequestMessage = z.infer<typeof CredentialRemoveRequestMessage>

export const CredentialRemoveOutcome = z.enum(['removed', 'absent', 'changed', 'failed'])
export type CredentialRemoveOutcome = z.infer<typeof CredentialRemoveOutcome>

export const CredentialRemoveResultMessage = z.object({
  type: z.literal('credentialRemoveResult'),
  requestId: z.string(),
  outcome: CredentialRemoveOutcome,
  error: z.string().optional(),
})
export type CredentialRemoveResultMessage = z.infer<typeof CredentialRemoveResultMessage>
