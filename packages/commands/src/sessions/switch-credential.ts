/**
 * THE `sessions.switchCredential` CONTRACT (credential management §9,
 * "Switching a session to another credential"; epic plan Task 11).
 *
 * Moves a session to another credential, or to none (the harness's own login),
 * and continues the same conversation. The server resolves the new credential
 * for the session's harness and machine and refuses with the resolver's reason
 * when it does not fit; the session then keeps the credential it had. Otherwise
 * it records the choice, and:
 *
 * - a stopped or hibernated session changes only its record: `next-wake`;
 * - a running session between turns is stopped and started again with its
 *   conversation resumed on the new credential: `resume`;
 * - a running session in a turn waits for the turn's end (`whenBusy: 'wait'`) or
 *   has the turn stopped first (`'interrupt'`): `resume` with `waitingForTurnEnd`;
 * - where the conversation cannot be resumed, a new session opens with a
 *   handoff summary and the old one stops: `handoff`.
 *
 * The handler is `apps/server/src/modules/sessions/switch-credential.ts`.
 */

import { CredentialIdField, SessionIdField } from '@podium/model'
import { z } from 'zod'
import type { CommandDef } from '../framework'

export const sessionSwitchCredentialInput = z.object({
  sessionId: SessionIdField,
  /** `null`: the harness's own login on the session's machine. */
  credentialId: CredentialIdField.nullable(),
  whenBusy: z.enum(['wait', 'interrupt']),
})
export type SessionSwitchCredentialInput = z.infer<typeof sessionSwitchCredentialInput>

export const SwitchContinuation = z.enum(['resume', 'handoff', 'next-wake'])
export type SwitchContinuation = z.infer<typeof SwitchContinuation>

export const sessionSwitchCredentialOutput = z.object({
  continuedAs: SwitchContinuation,
  /** The session was in a turn: the switch runs when that turn ends. */
  waitingForTurnEnd: z.literal(true).optional(),
  /** `handoff`: the session that continues the conversation. */
  handoffSessionId: SessionIdField.optional(),
})
export type SessionSwitchCredentialOutput = z.infer<typeof sessionSwitchCredentialOutput>

export const switchCredential: CommandDef<typeof sessionSwitchCredentialInput> = {
  input: sessionSwitchCredentialInput,
  action: 'write',
  // A session is the private class (POD-6284, the `ownerReaches` gate in
  // `apps/server/src/modules/sessions/session-access.ts`): the session's own
  // owner only, so a grant reaches no switch. The policy vocabulary has no
  // `owner` scope, so the declaration keeps `owner-or-grant`; read it as narrowed
  // by that private-class override, never as a grant.
  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write', machineVerb: 'use' },
  visibility: 'personal',
  exposure: ['trpc'],
  offline: 'online-only',
  redaction: {
    fields: [],
    note: 'A session id and a credential id are not secrets; the credential itself never crosses this command.',
  },
  conflict: 'cmd',
  decision:
    'trpc ONLY, a plain command: it restarts a process on the session’s machine, so it is never queued (a credential applied later than chosen could bill the wrong account). The credential is resolved for the person the session runs for, as at launch; a refusal changes nothing. The UI control is Task 18’s.',
}
