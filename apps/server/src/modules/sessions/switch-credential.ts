/**
 * SWITCHING A SESSION TO ANOTHER CREDENTIAL (credential management §9;
 * epic plan Task 11).
 *
 * `sessions.switchCredential`: resolve the new credential for the session's
 * harness and machine (a refusal changes nothing), record it on the session
 * with a `switch` event, then
 *
 * - stopped or hibernated: nothing more; the next wake resolves the stored
 *   credential (`next-wake`). When the machine is connected the conversation is
 *   placed for it now; otherwise the wake places it (`placeConversation`).
 * - between turns: park the harness, place the conversation for the target home
 *   and account (POD-6893 §3: the one file, Codex without the old account's
 *   reasoning), and start it again through the revival path (`resume`).
 * - in a turn: `wait` runs the same at the turn's end; `interrupt` stops the turn
 *   first. Nothing is dropped without one of the two having been chosen.
 * - where the conversation cannot be placed or the revival fails: a new session
 *   on the same issue opens with a handoff summary and the old one stops
 *   (`handoff`).
 *
 * The secret is never read here: the revival resolves and delivers it.
 */

import type { SessionSwitchCredentialInput, SessionSwitchCredentialOutput } from '@podium/commands'
import { codexModelProviderChange } from '@podium/harness/metadata'
import { createLogger } from '@podium/logger'
import type {
  AgentKind,
  CredentialId,
  IssueId,
  MachineId,
  ResumeRef,
  SessionId,
  UserId,
} from '@podium/model'
import {
  CAP_CONVERSATION_PREPARE,
  type ConversationPrepareRequestMessage,
  type ConversationPrepareResultMessage,
  DEFAULT_HOME_ID,
  HOME_HARNESSES,
} from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { type AccessDeps, resolveSessionAccess } from '../credentials/access'
import { recordCredentialEvent } from '../credentials/events'
import type { SessionStanding } from '../credentials/health'
import { credentialRefusedError } from '../credentials/refusal-error'

const log = createLogger('server:credential-switch')

/** The account name of the harness's own login on the wire. */
const NO_CREDENTIAL = 'none'

const accountOf = (credentialId: CredentialId | null | undefined): string =>
  credentialId ?? NO_CREDENTIAL

/** What a switch reads of a session. */
export interface SwitchSession {
  sessionId: SessionId
  agentKind: AgentKind
  machineId: MachineId
  ownerUserId: UserId
  credentialId: CredentialId | null
  cwd: string
  resume?: ResumeRef
  status: 'starting' | 'live' | 'hibernated' | 'exited'
  driverId?: string
  issueId?: IssueId
  title?: string
}

export interface ConversationPlacementPort {
  daemonSupports(machineId: MachineId, capability: string): boolean
  conversationPrepare(
    input: Omit<ConversationPrepareRequestMessage, 'type' | 'requestId'>,
    machineId: MachineId,
  ): Promise<Omit<ConversationPrepareResultMessage, 'type' | 'requestId'>>
}

export type Placement =
  | { kind: 'skipped' }
  | { kind: 'placed'; placed: string; droppedReasoning: boolean }
  | { kind: 'failed'; error: string }

/**
 * Put the session's conversation where a resume in `toHomeId` on `account`
 * finds it. Skipped for a harness that keeps no conversation in a home, a
 * session with nothing to resume, and a daemon that does not offer it.
 */
export async function placeConversation(
  port: ConversationPlacementPort,
  session: Pick<SwitchSession, 'sessionId' | 'agentKind' | 'machineId' | 'cwd' | 'resume'>,
  to: { credentialId: CredentialId | null; homeId: string },
  fromCredentialId?: CredentialId | null,
  modelProvider?: string,
): Promise<Placement> {
  if (!(HOME_HARNESSES as readonly string[]).includes(session.agentKind)) return { kind: 'skipped' }
  if (!session.resume) return { kind: 'skipped' }
  if (!port.daemonSupports(session.machineId, CAP_CONVERSATION_PREPARE)) return { kind: 'skipped' }
  const result = await port.conversationPrepare(
    {
      sessionId: session.sessionId,
      agentKind: session.agentKind,
      cwd: session.cwd,
      resume: session.resume,
      toHomeId: to.homeId,
      account: accountOf(to.credentialId),
      ...(fromCredentialId !== undefined ? { fromAccount: accountOf(fromCredentialId) } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
    },
    session.machineId,
  )
  if (!result.ok) return { kind: 'failed', error: result.error ?? 'the machine could not place it' }
  return {
    kind: 'placed',
    placed: result.placed ?? 'in-place',
    droppedReasoning: result.droppedReasoning === true,
  }
}

// Keep the existing public helper at the server entrypoint; the vendor format lives in its adapter.
export { codexModelProvider } from '@podium/harness/metadata'

/** The home a delivery runs the harness in. */
export const homeIdOfDelivery = (
  delivery: { kind: 'env' } | { kind: 'home'; homeId: string } | undefined,
): string => (delivery?.kind === 'home' ? delivery.homeId : DEFAULT_HOME_ID)

/** What the switch asks of the session lifecycle. Bound in relay.ts. */
export interface CredentialSwitchSessionPort {
  read(sessionId: SessionId): Promise<SwitchSession | undefined>
  standing(sessionId: SessionId): Promise<SessionStanding>
  /** Store the credential on the session's record. */
  record(sessionId: SessionId, credentialId: CredentialId | null): Promise<void>
  hibernate(sessionId: SessionId): Promise<{ ok: boolean; reason?: string }>
  resurrect(sessionId: SessionId): Promise<{ ok: boolean; reason?: string }>
  interrupt(sessionId: SessionId): Promise<{ ok: boolean; reason?: string }>
  stop(sessionId: SessionId): Promise<void>
  /** The latest user and agent messages, oldest first. */
  transcriptTail(sessionId: SessionId, limit: number): Promise<{ role: string; text: string }[]>
  /** A new session continuing `from` on `credentialId`, with `prompt` as its first turn. */
  startHandoff(input: {
    from: SwitchSession
    credentialId: CredentialId | null
    prompt: string
  }): Promise<SessionId>
}

export interface CredentialSwitchDeps {
  store: AccessDeps
  sessions: CredentialSwitchSessionPort
  /** Credential health's scheduler (`CredentialHealth.restartAtTurnBoundary`):
   *  it calls {@link CredentialSwitcher.restartWithResume} now or at the turn's end. */
  restarts: { restartAtTurnBoundary(sessionId: SessionId): Promise<void> }
  placement: ConversationPlacementPort
  /** How long a revival may stay `starting` before it counts as running. */
  reviveWaitMs?: number
  pollMs?: number
}

/** The transcript items a handoff summary carries. */
export const HANDOFF_TAIL = 30
const HANDOFF_ITEM_CHARS = 2_000

/** The first turn of a session that continues a conversation it could not resume. */
export function handoffPrompt(
  from: Pick<SwitchSession, 'sessionId' | 'title'>,
  tail: readonly { role: string; text: string }[],
  reason: string,
): string {
  const lines = tail.map((item) => {
    const text =
      item.text.length > HANDOFF_ITEM_CHARS
        ? `${item.text.slice(0, HANDOFF_ITEM_CHARS)}…`
        : item.text
    return `[${item.role}] ${text}`
  })
  return [
    `You continue the work of session ${from.sessionId}${from.title ? ` ("${from.title}")` : ''}, which moved to another credential and could not resume its conversation (${reason}).`,
    'Its latest messages follow, oldest first. Read them, then carry on with the work where it stopped.',
    '',
    ...(lines.length ? lines : ['(no messages could be read)']),
  ].join('\n')
}

interface PendingSwitch {
  from: CredentialId | null
  to: CredentialId | null
  toHomeId: string
  actorUserId: UserId
}

const refused = (message: string): TRPCError =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message })

export class CredentialSwitcher {
  /** Switches whose restart has not run yet: the account the conversation leaves. */
  private readonly moves = new Map<SessionId, PendingSwitch>()
  /** What a restart a caller is waiting on came to. */
  private readonly outcomes = new Map<SessionId, SessionSwitchCredentialOutput>()
  private readonly awaited = new Set<SessionId>()

  constructor(private readonly deps: CredentialSwitchDeps) {}

  /** Whether a switch is waiting for this session's restart. */
  waiting(sessionId: SessionId): boolean {
    return this.moves.has(sessionId)
  }

  async switchCredential(
    input: SessionSwitchCredentialInput,
    actorUserId: UserId,
  ): Promise<SessionSwitchCredentialOutput> {
    const session = await this.deps.sessions.read(input.sessionId)
    if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown session' })
    if (session.agentKind === 'shell') throw refused('A shell session runs on no credential.')
    const plan = await resolveSessionAccess(this.deps.store, {
      harness: session.agentKind,
      ...(session.driverId ? { driverId: session.driverId } : {}),
      credentialId: input.credentialId,
      actingUserId: session.ownerUserId,
      machineId: session.machineId,
      sessionId: session.sessionId,
    })
    if (!plan.ok) throw credentialRefusedError(plan.refusal, plan.message)
    const from = session.credentialId
    const to = plan.credentialId
    const toHomeId = homeIdOfDelivery(plan.delivery)
    const standing = await this.deps.sessions.standing(session.sessionId)
    // Already on it: nothing to record and nothing to restart.
    if (to === from) return { continuedAs: standing === 'not-running' ? 'next-wake' : 'resume' }
    await this.deps.sessions.record(session.sessionId, to)
    await this.event(session, actorUserId, {
      from,
      to,
      when: standing === 'not-running' ? 'next-wake' : standing === 'in-turn' ? 'turn-end' : 'now',
    })
    const pending: PendingSwitch = { from, to, toHomeId, actorUserId }

    if (standing === 'not-running') {
      // Placed now while the machine is here; otherwise the wake places it.
      await this.place(session, pending).catch((err: unknown) => {
        log.warn('placing a stopped session’s conversation failed; the wake retries', {
          sessionId: session.sessionId,
          err,
        })
      })
      return { continuedAs: 'next-wake' }
    }
    this.moves.set(session.sessionId, pending)
    if (standing === 'in-turn' && input.whenBusy === 'interrupt') {
      const stopped = await this.deps.sessions.interrupt(session.sessionId)
      if (!stopped.ok) {
        log.warn('could not stop the turn for a switch; it waits for the turn end', {
          sessionId: session.sessionId,
          reason: stopped.reason,
        })
      }
    }
    // ONE RESTART PATH (credential health, epic Tasks 13 and 15): it runs the
    // restart now between turns, or at the turn's end, through
    // `restartWithResume` below.
    this.awaited.add(session.sessionId)
    try {
      await this.deps.restarts.restartAtTurnBoundary(session.sessionId)
    } finally {
      this.awaited.delete(session.sessionId)
    }
    const outcome = this.outcomes.get(session.sessionId)
    this.outcomes.delete(session.sessionId)
    return outcome ?? { continuedAs: 'resume', waitingForTurnEnd: true }
  }

  /**
   * THE RESTART WITH RESUME (`CredentialSessionPort.restartWithResume`), for a
   * renewal, a plan token's replacement and a switch alike: park the harness
   * and start it again through revival, which resolves the session's stored
   * credential afresh. For a switch the conversation is first placed for the
   * new home and account, and a session that cannot continue that way hands
   * off. `ok: false` with the session in a turn makes the caller wait for the
   * turn's end and ask again.
   */
  async restartWithResume(sessionId: SessionId): Promise<{ ok: boolean; reason?: string }> {
    const move = this.moves.get(sessionId)
    const parked = await this.deps.sessions.hibernate(sessionId)
    if (!parked.ok) {
      if (!move || (await this.deps.sessions.standing(sessionId)) === 'in-turn') return parked
      this.moves.delete(sessionId)
      this.settle(
        sessionId,
        await this.handoff(sessionId, move, parked.reason ?? 'it could not be stopped'),
      )
      return { ok: true }
    }
    if (!move) return await this.deps.sessions.resurrect(sessionId)
    this.moves.delete(sessionId)
    this.settle(sessionId, await this.finishSwitch(sessionId, move))
    return { ok: true }
  }

  private settle(sessionId: SessionId, outcome: SessionSwitchCredentialOutput): void {
    if (this.awaited.has(sessionId)) this.outcomes.set(sessionId, outcome)
  }

  /** A parked session: place its conversation, revive it, or hand off. */
  private async finishSwitch(
    sessionId: SessionId,
    pending: PendingSwitch,
  ): Promise<SessionSwitchCredentialOutput> {
    const session = await this.deps.sessions.read(sessionId)
    if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown session' })
    const placement = await this.place(session, pending).catch(
      (err: unknown): Placement => ({
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    if (placement.kind === 'failed') {
      return await this.handoff(
        sessionId,
        pending,
        `its conversation could not be placed: ${placement.error}`,
      )
    }
    const revived = await this.deps.sessions.resurrect(sessionId)
    if (!revived.ok) {
      return await this.handoff(sessionId, pending, revived.reason ?? 'it did not start again')
    }
    if ((await this.settled(sessionId)) === 'exited') {
      return await this.handoff(sessionId, pending, 'the resumed harness exited')
    }
    return { continuedAs: 'resume' }
  }

  private async place(session: SwitchSession, pending: PendingSwitch): Promise<Placement> {
    return await placeConversation(
      this.deps.placement,
      session,
      { credentialId: pending.to, homeId: pending.toHomeId },
      pending.from,
      await this.providerChange(session.agentKind, pending),
    )
  }

  /** The provider a Codex thread must record, when the switch changes it. */
  private async providerChange(
    harness: AgentKind,
    pending: PendingSwitch,
  ): Promise<string | undefined> {
    const typeOf = async (id: CredentialId | null) =>
      id ? (await this.deps.store.credentials.get(id))?.type : undefined
    return await codexModelProviderChange(harness, async () => ({
      from: await typeOf(pending.from),
      to: await typeOf(pending.to),
    }))
  }

  /** Wait for a revived session to leave `starting`. */
  private async settled(sessionId: SessionId): Promise<'live' | 'exited' | 'starting'> {
    const deadline = Date.now() + (this.deps.reviveWaitMs ?? 20_000)
    for (;;) {
      const status = (await this.deps.sessions.read(sessionId))?.status
      if (status === 'exited') return 'exited'
      if (status !== 'starting') return 'live'
      if (Date.now() >= deadline) return 'starting'
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 250))
    }
  }

  private async handoff(
    sessionId: SessionId,
    pending: PendingSwitch,
    reason: string,
  ): Promise<SessionSwitchCredentialOutput> {
    const session = await this.deps.sessions.read(sessionId)
    if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown session' })
    const tail = await this.deps.sessions.transcriptTail(sessionId, HANDOFF_TAIL).catch(() => [])
    const handoffSessionId = await this.deps.sessions.startHandoff({
      from: session,
      credentialId: pending.to,
      prompt: handoffPrompt(session, tail, reason),
    })
    await this.deps.sessions.stop(sessionId)
    await this.event(session, pending.actorUserId, {
      from: pending.from,
      to: pending.to,
      when: 'handoff',
      handoffSessionId,
    })
    log.info('a switched session continued in a new session', {
      sessionId,
      handoffSessionId,
      reason,
    })
    return { continuedAs: 'handoff', handoffSessionId }
  }

  private async event(
    session: SwitchSession,
    actorUserId: UserId,
    i: {
      from: CredentialId | null
      to: CredentialId | null
      when: 'now' | 'turn-end' | 'next-wake' | 'handoff'
      handoffSessionId?: SessionId
    },
  ): Promise<void> {
    await recordCredentialEvent(this.deps.store, {
      kind: 'switch',
      credentialId: i.to,
      actorUserId,
      sessionId: session.sessionId,
      machineId: session.machineId,
      detail: `from ${accountOf(i.from)} to ${accountOf(i.to)} (${i.when}${
        i.handoffSessionId ? `: continued in ${i.handoffSessionId}` : ''
      })`,
    })
  }
}
