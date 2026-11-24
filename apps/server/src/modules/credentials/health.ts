/**
 * CREDENTIAL HEALTH AND RENEWAL (credential management §7 "Health and renewal",
 * §8 "cleanup"; epic Task 13).
 *
 * One place decides what happens to a credential that stopped working, is
 * about to expire, was renewed or was removed:
 *
 *  - VERIFY: a pasted key is tried with one cheap provider call before it is
 *    stored, and a Claude token is checked for its shape; a refusal stores
 *    nothing and names the provider's reason.
 *  - ATTENTION: a launch or a call the provider rejects moves the credential to
 *    `attention` with the reason, once: the store moves it only from `ok`, so a
 *    second rejection raises no second notice. A plan or rate limit is not a
 *    broken credential: it sets `limitReachedUntil` and nothing else.
 *  - EXPIRY: a recorded expiry two weeks ahead raises one notice; a passed one
 *    is `attention`.
 *  - RENEW: the same id and the next version; the notices resolve, the status
 *    returns to `ok`, and every session that holds the old secret restarts with
 *    resume at its next turn boundary. A turn in progress is never interrupted.
 *  - REMOVE EVERYWHERE: the secrets go, the record becomes `revoked`, each
 *    placement is removed (or stays `removal-pending` until its machine
 *    confirms), and each session still running on it is flagged and stopped at
 *    once, its turn cut (POD-7591; before, at its next turn boundary).
 *
 * It reaches sessions, notices and machines only through the ports below, which
 * the composition root binds; a port left out does nothing, so a hand-built
 * module set is a server that does less, not a broken one.
 *
 * WHAT IS KEPT IN MEMORY. A restart waiting for a session's turn boundary is an
 * intent, not a copy of a table: if the server restarts first it is lost, and the
 * session keeps its old process until it is revived (when it gets the new secret).
 * A stop after removal is not lost: every turn boundary of a session also checks
 * whether its credential was removed. A stop after a withdrawn grant or machine
 * (POD-7591) is: but a restarted server probes every survivor again when its
 * daemon reattaches, with a refresh that the resolver refuses, and that refusal
 * stops it.
 *
 *  - WITHDRAWN: a grant that ends or a machine withdrawn re-judges each running
 *    session on the credential; a refresh refused for a running process does the
 *    same, and so does a member removed or disabled (POD-7594). A withdrawal
 *    (`WITHDRAWS_ACCESS`) flags and stops it: at once, its turn cut, when the
 *    credential is gone or its grant was taken back (`STOPS_AT_ONCE`); otherwise
 *    at its next turn boundary, and at the latest after
 *    {@link TURN_STOP_CEILING_MS} (POD-7594). Until the stop has run, no queued
 *    input reaches it.
 */

import { createLogger, describeError } from '@podium/logger'
import {
  asUserId,
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialTypeId,
  isCredentialTypeId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { SessionStore } from '../../store'
import type { CredentialRecord } from '../../store/credentials'
import { type AccessRefusal, STOPS_AT_ONCE, WITHDRAWS_ACCESS } from './access'
import { recordCredentialEvent } from './events'
import { CREDENTIAL_RESOURCE_KIND } from './may-use'
import type { Placements } from './placements'

const log = createLogger('server:credentials')

const DAY_MS = 86_400_000
/** A notice goes out this long before a recorded expiry (spec §7). */
export const EXPIRY_NOTICE_MS = 14 * DAY_MS
/** A Claude token is issued for a year (`claude setup-token`). */
export const CLAUDE_TOKEN_LIFETIME_MS = 365 * DAY_MS
/** How long a limit is assumed to last when the provider does not say. */
export const DEFAULT_LIMIT_MS = 60 * 60_000
/** How often the server looks for credentials that expire soon or expired. */
export const CREDENTIAL_EXPIRY_SWEEP_MS = 60 * 60_000
/**
 * The agent phases that are between turns: entering one is the turn boundary a
 * restart after renewal, or a stop after removal, waits for.
 */
export const CREDENTIAL_TURN_BOUNDARY: ReadonlySet<string> = new Set([
  'idle',
  'needs_user',
  'errored',
  'ended',
])
/** A reason is cut to this length before it is stored or shown. */
const REASON_MAX = 300
/**
 * The longest a stop waits for a turn boundary (POD-7594). A turn that never
 * ends (a hung tool, a harness that never reports `idle`) is cut then, so "at its
 * next turn boundary" has a worst case. A failed stop is tried again after the
 * same time.
 */
export const TURN_STOP_CEILING_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type CredentialNoticeKind = 'credential-attention' | 'credential-shared'

/** The input of `emitNotice` (epic Task 16), as this module raises it. */
export interface CredentialNotice {
  recipientUserId: UserId
  kind: CredentialNoticeKind
  subject: { kind: 'credential'; id: CredentialId }
  title: string
  body?: string
  dedupeKey: string
}

/**
 * The notification inbox (Task 16). Until it is bound this does nothing; the
 * composition root binds `emitNotice` and `resolveNotices` to it.
 */
export interface CredentialNoticePort {
  emit(notice: CredentialNotice): Promise<void>
  resolve(dedupeKey: string): Promise<void>
}

export const NO_NOTICES: CredentialNoticePort = {
  emit: async () => {},
  resolve: async () => {},
}

/** Where a session stands for a restart or stop that must not cut a turn. */
export type SessionStanding = 'in-turn' | 'between-turns' | 'not-running'

/** What this module asks of the running sessions. Bound by the composition root. */
export interface CredentialSessionPort {
  /**
   * The live sessions that run on this credential: by the session's credential,
   * and the headless sessions that name it as their account (POD-7594, F5).
   */
  liveSessionIds(credentialId: CredentialId): Promise<SessionId[]>
  /**
   * The running sessions that may run on a credential (POD-7594): each with its
   * owner and its credential, `null` for an account from before credentials
   * that only the resolver can read. A session on a machine's own login is not
   * listed: Podium put no secret into it.
   */
  runningOnCredentials(): Promise<
    { sessionId: SessionId; ownerUserId: UserId; credentialId: CredentialId | null }[]
  >
  standing(sessionId: SessionId): Promise<SessionStanding>
  /** Stop the harness and start it again with resume, under the same session. */
  restartWithResume(sessionId: SessionId): Promise<{ ok: boolean; reason?: string }>
  stop(sessionId: SessionId): Promise<void>
  /**
   * Tell the people watching the session that it may no longer use its
   * credential: `revoked` when it was removed, otherwise the withdrawal the
   * resolver refused with (POD-7591). `stops` says whether it stops now, its
   * turn cut, or at the end of its current turn.
   */
  flagWithdrawn(
    sessionId: SessionId,
    credential: { id: CredentialId; label: string },
    refusal: AccessRefusal,
    stops: 'now' | 'at-turn-end',
  ): Promise<void>
  /**
   * Judge a running session's credential again for its owner and machine, as a
   * launch would: no secret is read and nothing is delivered. A refusal is
   * recorded on the trail by the resolver, and names the credential the session
   * runs on, read as a revival reads it (its account for a headless session or
   * one from before credentials, POD-7594). A session on no credential is `ok`.
   */
  accessOf(
    sessionId: SessionId,
  ): Promise<{ ok: true } | { ok: false; refusal: AccessRefusal; credentialId: CredentialId }>
}

export const NO_SESSIONS: CredentialSessionPort = {
  liveSessionIds: async () => [],
  runningOnCredentials: async () => [],
  standing: async () => 'not-running',
  restartWithResume: async () => ({ ok: false, reason: 'no session runtime' }),
  stop: async () => {},
  flagWithdrawn: async () => {},
  accessOf: async () => ({ ok: true }),
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type HealthStore = Pick<SessionStore, 'credentials' | 'settingsAudit' | 'users' | 'grants'>

export interface CredentialHealthDeps {
  store: HealthStore
  notices?: CredentialNoticePort
  sessions?: CredentialSessionPort
  placements?: Pick<Placements, 'removePlacement'>
  /** The provider calls of verification. Defaults to the global `fetch`. */
  fetch?: FetchLike
  now?: () => number
  /** Runs `run` after `ms`; the default is an unref'd timer. Tests drive it. */
  schedule?: (ms: number, run: () => void) => { cancel(): void }
  /** Defaults to {@link TURN_STOP_CEILING_MS}. */
  turnStopCeilingMs?: number
}

const scheduleTimer = (ms: number, run: () => void): { cancel(): void } => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * `providerChecked`: a provider call accepted it (a key), as opposed to a shape
 * check (a Claude token). Only the first sets `verifiedAt`.
 */
export type Verification =
  | { ok: true; providerChecked: boolean; expiresAt?: string }
  | { ok: false; reason: string }

/** One cheap, read-only call per key type that answers "is this key accepted". */
const VERIFY_CALLS: Partial<
  Record<CredentialTypeId, (secret: string) => { url: string; headers: Record<string, string> }>
> = {
  'anthropic.api-key': (secret) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
  }),
  'openai.api-key': (secret) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${secret}` },
  }),
  'openrouter.api-key': (secret) => ({
    url: 'https://openrouter.ai/api/v1/key',
    headers: { authorization: `Bearer ${secret}` },
  }),
}

/** The shape `claude setup-token` prints. */
const CLAUDE_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/

const VERIFY_TIMEOUT_MS = 15_000

function providerTitle(type: string): string {
  if (!isCredentialTypeId(type)) return 'The provider'
  const provider = CREDENTIAL_TYPES[type].provider
  return provider === 'anthropic'
    ? 'Anthropic'
    : provider === 'openai'
      ? 'OpenAI'
      : provider === 'openrouter'
        ? 'OpenRouter'
        : provider === 'xai'
          ? 'xAI'
          : provider
}

/** A short reason, with the secret cut out if a provider echoed it. */
export function cleanReason(text: string, secret?: string): string {
  let out = text
  if (secret) out = out.split(secret).join('[redacted]')
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > REASON_MAX ? `${out.slice(0, REASON_MAX - 1)}…` : out
}

/** The provider's own sentence from an error body, if it has one. */
async function providerMessage(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json()
    const error = (body as { error?: unknown })?.error
    if (typeof error === 'string') return error
    const message = (error as { message?: unknown })?.message
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

/**
 * Is this pasted secret accepted by its provider? A key is tried with one
 * read-only call; a Claude token, which has no call that is not a model call,
 * is checked for its shape and given its one-year expiry. A rate limit means
 * the provider recognised the key, so it is accepted.
 */
export async function verifyPastedSecret(
  type: string,
  secret: string,
  opts: { fetch: FetchLike; now: number },
): Promise<Verification> {
  if (type === 'anthropic.claude-token') {
    if (!CLAUDE_TOKEN.test(secret.trim())) {
      return {
        ok: false,
        reason:
          'This does not look like a Claude token. Run `claude setup-token` and paste the token it prints; it starts with sk-ant-oat.',
      }
    }
    return {
      ok: true,
      providerChecked: false,
      expiresAt: new Date(opts.now + CLAUDE_TOKEN_LIFETIME_MS).toISOString(),
    }
  }
  const call = isCredentialTypeId(type) ? VERIFY_CALLS[type] : undefined
  if (!call) return { ok: true, providerChecked: false }
  const provider = providerTitle(type)
  const { url, headers } = call(secret)
  let res: Response
  try {
    res = await opts.fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      ok: false,
      reason: cleanReason(
        `Could not reach ${provider} to check this key (${describeError(err)}). Nothing was stored; try again.`,
        secret,
      ),
    }
  }
  if (res.ok || res.status === 429) return { ok: true, providerChecked: true }
  const said = await providerMessage(res)
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: cleanReason(`${provider} rejected this key: ${said ?? `HTTP ${res.status}`}`, secret),
    }
  }
  return {
    ok: false,
    reason: cleanReason(
      `${provider} could not check this key (HTTP ${res.status}${said ? `: ${said}` : ''}). Nothing was stored; try again.`,
      secret,
    ),
  }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** What a failed launch or call says about its credential. */
export type CredentialFailure = 'rejected' | 'limit' | 'other'

const LIMIT_CLASS = /usage[_ -]?limit|rate[_ -]?limit|quota|billing|credit|spend|overloaded/i
const AUTH_CLASS = /auth|login|credential|unauthor|forbidden|api[_-]?key/i

/**
 * Classify a failure from whichever signal the caller has: a harness error
 * class (`agentState.error.class`), a runtime turn failure reason, or an HTTP
 * status. A limit is checked first: "billing_error" is not a bad key.
 */
export function classifyCredentialFailure(signal: {
  errorClass?: string
  turnFailure?: string
  httpStatus?: number
}): CredentialFailure {
  if (signal.turnFailure === 'rate-limit') return 'limit'
  if (signal.turnFailure === 'auth-expired') return 'rejected'
  if (signal.httpStatus !== undefined) {
    if (signal.httpStatus === 429 || signal.httpStatus === 402) return 'limit'
    if (signal.httpStatus === 401 || signal.httpStatus === 403) return 'rejected'
  }
  if (signal.errorClass !== undefined) {
    if (LIMIT_CLASS.test(signal.errorClass)) return 'limit'
    if (AUTH_CLASS.test(signal.errorClass)) return 'rejected'
  }
  return 'other'
}

/** The HTTP status a provider adapter put in its error (`"<base> 401: …"`). */
export function httpStatusOf(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const match = /(?:^|\s)(\d{3}):/.exec(message)
  return match ? Number(match[1]) : undefined
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export const attentionNoticeKey = (id: CredentialId): string => `credential-attention:${id}`
export const expiringNoticeKey = (id: CredentialId): string => `credential-expiring:${id}`

type PendingAction = { kind: 'restart' } | { kind: 'stop'; credential: { id: CredentialId } }

export class CredentialHealth {
  private readonly store: HealthStore
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  notices: CredentialNoticePort
  sessions: CredentialSessionPort
  placements: Pick<Placements, 'removePlacement'> | undefined
  /** Restarts and stops waiting for a session's next turn boundary. */
  private readonly pending = new Map<SessionId, PendingAction>()
  /**
   * Sessions that take no input until their credential stop has run (POD-7591),
   * keyed by the credential that was withdrawn: a session that moved to another
   * credential takes input again (review F1). Set before any await (review F3),
   * already when a reattach probe's refresh was refused; cleared when the stop
   * succeeds, when the session is found not running (a stop whose kill was not
   * confirmed still parked the row), or when a refusal at the probe is dropped.
   */
  private readonly holding = new Map<SessionId, CredentialId>()
  /** The ceiling of each stop that waits (POD-7594), by session. */
  private readonly ceilings = new Map<SessionId, { credentialId: CredentialId; cancel(): void }>()
  private readonly schedule: NonNullable<CredentialHealthDeps['schedule']>
  private readonly turnStopCeilingMs: number

  constructor(deps: CredentialHealthDeps) {
    this.store = deps.store
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? scheduleTimer
    this.turnStopCeilingMs = deps.turnStopCeilingMs ?? TURN_STOP_CEILING_MS
    this.notices = deps.notices ?? NO_NOTICES
    this.sessions = deps.sessions ?? NO_SESSIONS
    this.placements = deps.placements
  }

  /** Try a pasted secret with its provider before it is stored. */
  async verify(type: string, secret: string): Promise<Verification> {
    return await verifyPastedSecret(type, secret, { fetch: this.fetchImpl, now: this.now() })
  }

  /** It worked just now: record when. */
  async markVerified(credentialId: CredentialId): Promise<void> {
    await this.store.credentials.markVerified(credentialId, new Date(this.now()).toISOString())
  }

  /**
   * A launch or a call failed in a way that names the credential. A rejection
   * moves it to `attention` (once); a limit records until when; anything else
   * says nothing about the credential.
   */
  async noteFailure(i: {
    credentialId: CredentialId
    failure: CredentialFailure
    reason: string
    /** Whose launch or call it was; the owner when nobody else is known. */
    actorUserId?: UserId
    sessionId?: SessionId
    limitUntil?: string
  }): Promise<void> {
    if (i.failure === 'limit') {
      const until = i.limitUntil ?? new Date(this.now() + DEFAULT_LIMIT_MS).toISOString()
      await this.store.credentials.setLimitReachedUntil(i.credentialId, until)
      return
    }
    if (i.failure !== 'rejected') return
    const actor = i.actorUserId ?? (await this.store.credentials.get(i.credentialId))?.ownerUserId
    if (!actor) return
    await this.markAttention(i.credentialId, cleanReason(i.reason), actor, i.sessionId)
  }

  /** Move to `attention` with an event and one notice; nothing if it already needs it. */
  private async markAttention(
    credentialId: CredentialId,
    reason: string,
    actorUserId: UserId,
    sessionId?: SessionId,
  ): Promise<boolean> {
    if (!(await this.store.credentials.markAttention(credentialId, reason))) return false
    await recordCredentialEvent(this.store, {
      kind: 'attention',
      credentialId,
      actorUserId,
      ...(sessionId ? { sessionId } : {}),
      detail: reason,
    })
    const record = await this.store.credentials.get(credentialId)
    if (record) {
      await this.safeEmit({
        recipientUserId: record.ownerUserId,
        kind: 'credential-attention',
        subject: { kind: 'credential', id: credentialId },
        title: `${record.label} needs attention`,
        body: `${reason} Renew it, or switch its sessions to another credential.`,
        dedupeKey: attentionNoticeKey(credentialId),
      })
    }
    return true
  }

  /**
   * The expiry sweep: a credential past its recorded expiry needs attention;
   * one within two weeks of it raises a notice (the inbox keeps one per key).
   */
  async checkExpiry(): Promise<void> {
    const now = this.now()
    for (const record of await this.store.credentials.listWithExpiry()) {
      if (!record.expiresAt) continue
      const at = Date.parse(record.expiresAt)
      if (!Number.isFinite(at)) continue
      if (at <= now) {
        await this.markAttention(
          record.id,
          `It expired on ${record.expiresAt.slice(0, 10)}.`,
          record.ownerUserId,
        )
        continue
      }
      if (record.status !== 'ok' || at - now > EXPIRY_NOTICE_MS) continue
      const days = Math.max(1, Math.ceil((at - now) / DAY_MS))
      await this.safeEmit({
        recipientUserId: record.ownerUserId,
        kind: 'credential-attention',
        subject: { kind: 'credential', id: record.id },
        title: `${record.label} expires in ${days} ${days === 1 ? 'day' : 'days'}`,
        body: 'Renew it before then: create a new token and paste it into Renew.',
        dedupeKey: expiringNoticeKey(record.id),
      })
    }
  }

  /**
   * After a renewal is stored: its notices resolve, any limit is cleared, and
   * every running session on it restarts with resume at its next turn boundary
   * (now, when it is between turns). The renew event itself is the command's.
   */
  async afterRenew(
    record: Pick<CredentialRecord, 'id'>,
    verification: { providerChecked: boolean },
  ): Promise<void> {
    await this.store.credentials.setLimitReachedUntil(record.id, null)
    if (verification.providerChecked) await this.markVerified(record.id)
    await this.safeResolve(attentionNoticeKey(record.id))
    await this.safeResolve(expiringNoticeKey(record.id))
    for (const sessionId of await this.sessions.liveSessionIds(record.id)) {
      if (this.pending.get(sessionId)?.kind === 'stop') continue
      this.pending.set(sessionId, { kind: 'restart' })
      await this.actIfBetweenTurns(sessionId)
    }
  }

  /**
   * Remove everywhere (§8): secrets deleted and the record `revoked`, its grants
   * gone, every placement removed or left `removal-pending`, every running
   * session flagged and stopped at once, its turn cut (POD-7591), and the event.
   */
  async removeEverywhere(credentialId: CredentialId, actorUserId: UserId): Promise<void> {
    const record = await this.store.credentials.get(credentialId)
    if (!record || record.status === 'revoked') return
    await this.store.credentials.remove(credentialId)
    await this.store.grants.removeAllForResource(CREDENTIAL_RESOURCE_KIND, credentialId)
    await recordCredentialEvent(this.store, { kind: 'remove', credentialId, actorUserId })
    await this.safeResolve(attentionNoticeKey(credentialId))
    await this.safeResolve(expiringNoticeKey(credentialId))
    for (const placement of await this.store.credentials.listPlacements(credentialId)) {
      if (placement.state === 'removed') continue
      try {
        if (this.placements) {
          await this.placements.removePlacement(placement)
        } else {
          await this.store.credentials.setPlacementState(placement, 'removal-pending')
        }
      } catch (err) {
        log.warn('placement removal failed; left pending', { err, credentialId })
        await this.store.credentials.setPlacementState(placement, 'removal-pending')
      }
    }
    for (const sessionId of await this.sessions.liveSessionIds(credentialId)) {
      await this.flagAndStop(sessionId, record, 'revoked')
    }
  }

  /**
   * A grant on the credential ended or a machine was withdrawn from it
   * (`credentials.unshare`, `credentials.disallowMachine`), POD-7591. Each
   * session running on it is judged again; one the resolver now refuses with a
   * withdrawal is flagged and stopped: at once when the grant was taken back,
   * at its next turn boundary when a machine was withdrawn.
   * A session that does not run holds no secret: its next revival is judged
   * then.
   */
  async afterWithdraw(record: Pick<CredentialRecord, 'id' | 'label'>): Promise<void> {
    for (const sessionId of await this.sessions.liveSessionIds(record.id)) {
      await this.judgeRunning(sessionId, record)
    }
  }

  /**
   * A member was removed or disabled (POD-7594, review F2). Each running session
   * whose right to its credential could hang on that person is judged again, as
   * {@link afterWithdraw} judges a credential's: the member's own sessions (a
   * person who is no longer a member may use nothing), and every session on a
   * credential its owner did not make, since the member may own that credential
   * or have given its grant as a manager.
   *
   * A removal stops a withdrawn session at once (`not-yours`), its turn cut. A
   * disable keeps the members' policy of letting running agents finish
   * (`runningAgentPolicy: 'let-finish'`, coordinator decision): the session
   * finishes its current turn and then stops, its input held meanwhile and the
   * stop bounded by {@link TURN_STOP_CEILING_MS}; no new turn and no refresh is
   * allowed, since the resolver refuses the member.
   *
   * Runs after the membership change commits. Never throws: a session that
   * cannot be judged is logged and left, and its next revival or refresh is
   * judged.
   */
  async afterMemberLeft(memberId: UserId, change: 'removed' | 'disabled'): Promise<void> {
    const stops = change === 'disabled' ? 'at-turn-end' : undefined
    let running: Awaited<ReturnType<CredentialSessionPort['runningOnCredentials']>>
    let owners: Map<CredentialId, UserId>
    try {
      running = await this.sessions.runningOnCredentials()
      const ids = [...new Set(running.flatMap((r) => (r.credentialId ? [r.credentialId] : [])))]
      // Removed credentials are left out: such a session is judged, and refused.
      owners = new Map(
        (await this.store.credentials.getMany(ids)).map((c) => [c.id, c.ownerUserId]),
      )
    } catch (err) {
      log.warn('could not list the running sessions after a member left', { err, memberId })
      return
    }
    for (const r of running) {
      const owner = r.credentialId ? owners.get(r.credentialId) : undefined
      // The member's own session, or one on a key its owner did not make (the
      // member may own it or have given its grant), or on a removed key.
      const mayHangOnMember =
        r.ownerUserId === memberId || (r.credentialId !== null && owner !== r.ownerUserId)
      if (!mayHangOnMember) continue
      await this.judgeRunning(
        r.sessionId,
        r.credentialId ? { id: r.credentialId } : undefined,
        stops,
      )
    }
  }

  /**
   * Judge one running session's credential again and stop it on a withdrawal.
   * When the credential is known, the session is held from before the first
   * await (review N-b), and the hold is released when the judgement passes,
   * unless a stop now waits or someone else held it first. A thrown error is
   * logged and leaves the process (fail-open: its next revival is judged).
   */
  private async judgeRunning(
    sessionId: SessionId,
    expected?: Pick<CredentialRecord, 'id'> & Partial<Pick<CredentialRecord, 'label'>>,
    /** `at-turn-end`: let the current turn finish even for an at-once refusal. */
    stops?: 'at-turn-end',
  ): Promise<void> {
    const heldHere = expected !== undefined && this.holding.get(sessionId) !== expected.id
    if (heldHere) this.holding.set(sessionId, expected.id)
    try {
      if ((await this.sessions.standing(sessionId)) === 'not-running') return
      const access = await this.sessions.accessOf(sessionId)
      if (access.ok || !WITHDRAWS_ACCESS.has(access.refusal)) return
      const label =
        (access.credentialId === expected?.id ? expected.label : undefined) ??
        (await this.labelOf(access.credentialId))
      await this.flagAndStop(sessionId, { id: access.credentialId, label }, access.refusal, stops)
    } catch (err) {
      log.warn('could not judge a running session after its access was withdrawn', {
        err,
        sessionId,
      })
    } finally {
      if (heldHere && expected) this.releaseHold(sessionId, expected.id)
    }
  }

  /** The credential's label for a flag; a read that fails names it plainly (review N-a). */
  private async labelOf(credentialId: CredentialId): Promise<string> {
    try {
      return (await this.store.credentials.get(credentialId))?.label ?? 'its credential'
    } catch (err) {
      log.warn('could not read a withdrawn credential for its label', { err, credentialId })
      return 'its credential'
    }
  }

  /**
   * A running session's credential was refused when it was judged again (a
   * refresh to a daemon that reattached it, POD-7591). A withdrawal flags it and
   * stops it, at once or at its next turn boundary by the refusal; any other
   * refusal leaves the process alone.
   */
  async accessWithdrawn(
    sessionId: SessionId,
    credentialId: CredentialId,
    refusal: AccessRefusal,
  ): Promise<void> {
    if (!WITHDRAWS_ACCESS.has(refusal)) return
    // Held before the label is read (review F3). A read that fails still stops
    // the session, under a plain name (review N-a).
    this.holding.set(sessionId, credentialId)
    const label = await this.labelOf(credentialId)
    await this.flagAndStop(sessionId, { id: credentialId, label }, refusal)
  }

  /** A member was removed: each of their credentials is removed everywhere. */
  async removeMemberCredentials(memberId: UserId, actorUserId: UserId): Promise<void> {
    for (const record of await this.store.credentials.listVisibleTo(memberId)) {
      await this.removeEverywhere(record.id, actorUserId)
    }
  }

  /** Someone was given use or manage of a credential: tell them. */
  async afterShare(
    record: Pick<CredentialRecord, 'id' | 'label' | 'ownerUserId'>,
    grantee: 'all-members' | { userId: UserId },
    verb: 'use' | 'manage',
    sharedBy: UserId,
  ): Promise<void> {
    const recipients =
      grantee === 'all-members'
        ? (await this.store.users.list())
            .filter((u) => !u.disabledAt)
            .map((u) => asUserId(u.id))
            .filter((id) => id !== sharedBy && id !== record.ownerUserId)
        : [grantee.userId]
    const by = (await this.store.users.get(sharedBy))?.displayName ?? 'Another member'
    for (const recipientUserId of recipients) {
      await this.safeEmit({
        recipientUserId,
        kind: 'credential-shared',
        subject: { kind: 'credential', id: record.id },
        title: `${by} shared ${record.label} with you`,
        body:
          verb === 'manage'
            ? 'You may use it for your sessions and model calls, and rename, renew, share or remove it.'
            : 'You may use it for your sessions and model calls.',
        dedupeKey: `credential-shared:${record.id}:${recipientUserId}:${verb}`,
      })
    }
  }

  /**
   * A session reached a turn boundary (or is between turns now). A restart or
   * stop waiting for it runs; a session whose credential was removed stops even
   * when no intent survived a server restart.
   */
  async onTurnBoundary(sessionId: SessionId, credentialId: CredentialId | null): Promise<void> {
    const action = this.pending.get(sessionId)
    if (action?.kind === 'stop' && action.credential.id !== credentialId) {
      // The session moved to another credential: that stop is not its own any
      // more, and a revival never inherits it (review F1).
      this.dropStop(sessionId, action.credential.id)
    } else if (action) {
      await this.run(sessionId, action)
      return
    }
    if (credentialId === null) return
    const record = await this.store.credentials.get(credentialId)
    if (record?.status === 'revoked')
      await this.run(sessionId, { kind: 'stop', credential: record })
  }

  /**
   * Restart one session with resume at its next turn boundary (now, when it is
   * between turns), so that it starts again on freshly delivered access. A
   * stop already waiting wins. Used to hand a running Codex engine a new
   * ChatGPT plan token before the one it holds runs out (epic Task 15); the
   * same path `afterRenew` takes for every session on a renewed credential.
   */
  async restartAtTurnBoundary(sessionId: SessionId): Promise<void> {
    if (this.pending.get(sessionId)?.kind === 'stop') return
    this.pending.set(sessionId, { kind: 'restart' })
    await this.actIfBetweenTurns(sessionId)
  }

  /** Whether a restart or stop is waiting for this session's turn boundary. */
  waitingFor(sessionId: SessionId): PendingAction['kind'] | undefined {
    return this.pending.get(sessionId)?.kind
  }

  /**
   * Whether the session must take no input: its credential was withdrawn or
   * removed and its stop has not run yet (POD-7591). The inbox keeps its queued
   * rows queued (review F6).
   */
  holdsInput(sessionId: SessionId, credentialId: CredentialId | null): boolean {
    return credentialId !== null && this.holding.get(sessionId) === credentialId
  }

  /**
   * A reattach probe's refresh was refused and its reattach went out (POD-7591,
   * review F3): hold the session's input now, so nothing starts a turn between
   * its bind going live and the refusal being acted on.
   */
  holdFor(sessionId: SessionId, credentialId: CredentialId, refusal: AccessRefusal): void {
    if (WITHDRAWS_ACCESS.has(refusal)) this.hold(sessionId, credentialId)
  }

  /** Hold the session's input while its credential is judged again (review F3). */
  hold(sessionId: SessionId, credentialId: CredentialId): void {
    this.holding.set(sessionId, credentialId)
  }

  /** A hold above ended without a withdrawal (a dropped refusal, a judgement that passed): release it, not a stop's. */
  releaseHold(sessionId: SessionId, credentialId: CredentialId): void {
    const action = this.pending.get(sessionId)
    if (action?.kind === 'stop' && action.credential.id === credentialId) return
    if (this.holding.get(sessionId) === credentialId) this.holding.delete(sessionId)
  }

  private dropStop(sessionId: SessionId, credentialId: CredentialId): void {
    const action = this.pending.get(sessionId)
    if (action?.kind === 'stop' && action.credential.id === credentialId) {
      this.pending.delete(sessionId)
    }
    if (this.holding.get(sessionId) === credentialId) this.holding.delete(sessionId)
    const ceiling = this.ceilings.get(sessionId)
    if (ceiling?.credentialId === credentialId) {
      ceiling.cancel()
      this.ceilings.delete(sessionId)
    }
  }

  /**
   * Bound the wait of a stop for a turn boundary (POD-7594, review F9): after
   * {@link TURN_STOP_CEILING_MS} a stop still waiting for this credential runs,
   * and cuts the turn. One ceiling per session; a stop that ran cancels it.
   */
  private armCeiling(sessionId: SessionId, credentialId: CredentialId): void {
    const armed = this.ceilings.get(sessionId)
    if (armed?.credentialId === credentialId) return
    armed?.cancel()
    const timer = this.schedule(this.turnStopCeilingMs, () => {
      if (this.ceilings.get(sessionId)?.credentialId === credentialId) {
        this.ceilings.delete(sessionId)
      }
      const action = this.pending.get(sessionId)
      if (action?.kind !== 'stop' || action.credential.id !== credentialId) return
      log.warn('a stop waited too long for a turn boundary; the turn is cut', { sessionId })
      void this.run(sessionId, action).catch((err: unknown) => {
        log.warn('the ceiling stop of a session failed', { err, sessionId })
      })
    })
    this.ceilings.set(sessionId, { credentialId, cancel: () => timer.cancel() })
  }

  private async flagAndStop(
    sessionId: SessionId,
    credential: Pick<CredentialRecord, 'id' | 'label'>,
    refusal: AccessRefusal,
    stops?: 'at-turn-end',
  ): Promise<void> {
    const now = stops !== 'at-turn-end' && STOPS_AT_ONCE.has(refusal)
    const waiting = this.pending.get(sessionId)
    // Flagged once per session and credential (review F8): a reconnect that is
    // refused again while the stop waits raises no second flag.
    const repeat = waiting?.kind === 'stop' && waiting.credential.id === credential.id
    // Held before any await (review F3).
    this.pending.set(sessionId, { kind: 'stop', credential: { id: credential.id } })
    this.holding.set(sessionId, credential.id)
    const standing = await this.sessions.standing(sessionId)
    if (standing === 'not-running') {
      // Parked: nothing holds the secret, and its next revival is judged. No
      // flag that would tell it a turn was cut (review F8).
      this.dropStop(sessionId, credential.id)
      return
    }
    if (!repeat) {
      try {
        await this.sessions.flagWithdrawn(
          sessionId,
          { id: credential.id, label: credential.label },
          refusal,
          now ? 'now' : 'at-turn-end',
        )
      } catch (err) {
        log.warn('could not flag a session on a withdrawn credential', { err, sessionId })
      }
    }
    if (now) {
      // Removed, or the grant taken back: the turn in flight is cut (POD-7591).
      await this.run(sessionId, { kind: 'stop', credential: { id: credential.id } })
      return
    }
    this.armCeiling(sessionId, credential.id)
    await this.actIfBetweenTurns(sessionId)
  }

  private async actIfBetweenTurns(sessionId: SessionId): Promise<void> {
    const standing = await this.sessions.standing(sessionId)
    if (standing === 'in-turn') return
    const action = this.pending.get(sessionId)
    if (!action) return
    if (standing === 'not-running') {
      // Nothing holds the old secret; the next revival resolves afresh.
      this.pending.delete(sessionId)
      if (action.kind === 'stop') this.dropStop(sessionId, action.credential.id)
      return
    }
    await this.run(sessionId, action)
  }

  private async run(sessionId: SessionId, action: PendingAction): Promise<void> {
    this.pending.delete(sessionId)
    if (action.kind === 'stop') {
      try {
        await this.sessions.stop(sessionId)
        this.dropStop(sessionId, action.credential.id)
      } catch (err) {
        log.warn('a session on a withdrawn credential did not stop', { err, sessionId })
        // A stop whose kill was not confirmed has still parked the row and queued
        // the kill: nothing waits for a turn boundary that will not come (review
        // F1). A restart's probe or the census judges any survivor again.
        const standing = await this.sessions.standing(sessionId).catch(() => 'in-turn' as const)
        if (standing === 'not-running') {
          this.dropStop(sessionId, action.credential.id)
          return
        }
        // Still running: fail closed. The input stays held and the stop is tried
        // again at the next turn boundary, or after the ceiling if no boundary
        // comes (POD-7594), unless another action took its place.
        if (!this.pending.has(sessionId)) {
          this.pending.set(sessionId, action)
          this.armCeiling(sessionId, action.credential.id)
        }
      }
      return
    }
    try {
      const restarted = await this.sessions.restartWithResume(sessionId)
      if (!restarted.ok) {
        // A turn began between the check and the stop: wait for its end.
        if ((await this.sessions.standing(sessionId)) === 'in-turn') {
          this.pending.set(sessionId, action)
          return
        }
        log.warn('session did not restart after its credential was renewed', {
          sessionId,
          reason: restarted.reason,
        })
      }
    } catch (err) {
      log.warn('credential follow-up on a session failed', { err, sessionId, kind: action.kind })
    }
  }

  private async safeEmit(notice: CredentialNotice): Promise<void> {
    try {
      await this.notices.emit(notice)
    } catch (err) {
      log.warn('credential notice failed', { err, kind: notice.kind })
    }
  }

  private async safeResolve(key: string): Promise<void> {
    try {
      await this.notices.resolve(key)
    } catch (err) {
      log.warn('credential notice resolve failed', { err })
    }
  }
}
