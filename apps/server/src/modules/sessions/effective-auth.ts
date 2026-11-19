/**
 * WHAT THE HARNESS SAID, AGAINST WHAT THE SESSION WAS GIVEN (credential
 * management §9 "Launching", epic plan Task 10).
 *
 * After a harness starts, its daemon reads back which login the harness says it
 * is on (`sessionAuth`). This decides what the session records:
 *
 * - `effectiveAuth`: the method, and the identity where one is known. For a
 *   key the harness read exactly as delivered, that is the chosen credential's
 *   own fingerprint (the daemon compares the value; no secret crosses back).
 * - `credentialMismatch`, with both identities, when the harness answers on
 *   something other than the choice: another method, a key other than the one
 *   delivered, or a login on another account. A wrong pick still produces a
 *   working session that bills someone else, so it is flagged, not stopped.
 *
 * A harness that cannot say (`unknown`) is never a mismatch, and neither is a
 * session that chose no credential: the harness's own login is its choice.
 */

import {
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialMismatch,
  type CredentialTypeId,
  type EffectiveAuth,
  type EffectiveAuthMethod,
} from '@podium/model'
import type { SessionAuthMessage } from '@podium/protocol'

/** The credential the session was given, as its record holds it. */
export interface ChosenCredential {
  credentialId: CredentialId
  type: string
  identity: { fingerprint?: string | undefined; email?: string | undefined }
}

export type SessionAuthReport = Omit<SessionAuthMessage, 'type' | 'sessionId'>

/** How a harness running on each type should say it authenticated. A
 *  ChatGPT plan reaches the harness as a provider token, which no harness
 *  names consistently, so it has no expected method. */
const EXPECTED_METHOD: Readonly<Partial<Record<CredentialTypeId, EffectiveAuthMethod>>> = {
  'anthropic.api-key': 'api-key',
  'openai.api-key': 'api-key',
  'openrouter.api-key': 'api-key',
  'anthropic.claude-token': 'token',
  'anthropic.claude-login': 'subscription',
  'openai.chatgpt-login': 'subscription',
}

export function judgeEffectiveAuth(
  report: SessionAuthReport,
  chosen: ChosenCredential | null,
): { effectiveAuth: EffectiveAuth; credentialMismatch?: CredentialMismatch } {
  const delivered = chosen !== null && report.delivered === true
  const fingerprint = delivered ? chosen.identity.fingerprint : report.identity?.fingerprint
  const effectiveAuth: EffectiveAuth = {
    method: report.method,
    ...(fingerprint ? { fingerprint } : {}),
    ...(report.identity?.email ? { email: report.identity.email } : {}),
  }
  if (chosen === null || report.method === 'unknown') return { effectiveAuth }
  const expected = EXPECTED_METHOD[chosen.type as CredentialTypeId]
  const storedIn = CREDENTIAL_TYPES[chosen.type as CredentialTypeId]?.store
  const chosenPrint = chosen.identity.fingerprint
  const reportedPrint = report.identity?.fingerprint
  const mismatch =
    (expected !== undefined && report.method !== expected) ||
    (storedIn === 'vault' && report.delivered === false) ||
    (storedIn === 'home' &&
      chosenPrint !== undefined &&
      reportedPrint !== undefined &&
      chosenPrint !== reportedPrint)
  if (!mismatch) return { effectiveAuth }
  return {
    effectiveAuth,
    credentialMismatch: {
      chosen: {
        credentialId: chosen.credentialId,
        ...(expected ? { method: expected } : {}),
        ...(chosenPrint ? { fingerprint: chosenPrint } : {}),
        ...(chosen.identity.email ? { email: chosen.identity.email } : {}),
      },
      reported: effectiveAuth,
    },
  }
}
