/**
 * ADDING A SUBSCRIPTION BY SIGNING IN ON A MACHINE (credential management §6
 * way 2, §10 "Homes"; epic plan Task 9).
 *
 * The person picks a machine and a harness's login type. Podium makes a home
 * for the login on that machine and opens the vendor's own sign-in in a
 * terminal there, with the harness's directory variable pointed at the home:
 * `claude auth login` (a link, then a code pasted back) or
 * `codex login --device-auth` (a link and a one-time code). Podium never sees
 * the login: the home keeps it, and the machine's inventory reports only who
 * it is (`AgentInventory.logins`).
 *
 * The credential row is written when that report arrives, not before, so a
 * sign-in that is cancelled, fails or is abandoned leaves no credential, and
 * the home it made is removed again. A home is only ever made on a machine
 * the person holds custody of or sent the credential to (§8).
 *
 * WHO SIGNED IN DECIDES (review focus 5). The identity the home reports is
 * the one the credential gets. If the person signed in as an account they
 * already hold a credential for, the home is attached to that credential; if
 * they re-signed a credential with another account and hold none for it, that
 * credential now names the account that signed in. Either way the result
 * names the account, so the switch is shown, not hidden.
 */

import { createLogger } from '@podium/logger'
import {
  asCredentialId,
  CREDENTIAL_TYPES,
  type CredentialId,
  type CredentialTypeId,
  type Inventory,
  isCredentialTypeId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { CAP_HARNESS_HOMES, type HomeHarness, homeIdFor } from '@podium/protocol'
import type { SessionStore } from '../../store'
import { type CredentialRecord, newCredentialId } from '../../store/credentials'
import { ACCESS_REFUSAL_MESSAGES, type AccessRefusal } from './access'
import { recordCredentialEvent } from './events'
import { homeHarnessFor } from './home-removers'

const log = createLogger('server:credentials')

/** How long a sign-in may wait for the person (Codex's device code lasts 15 minutes). */
export const SIGN_IN_TTL_MS = 30 * 60_000
/** After the sign-in command ended, how long to wait for the machine to report the login. */
export const SIGN_IN_REPORT_WAIT_MS = 30_000
/** How long a finished sign-in can still be asked about before it is forgotten. */
export const SIGN_IN_KEEP_MS = 15 * 60_000

export type SignInOutcome =
  /** A new credential for the account that signed in. */
  | 'new'
  /** The credential signed in again as the account it already named. */
  | 'same'
  /** The account already had a credential: the home now belongs to it. */
  | 'attached'
  /** The credential named another account; it now names the one that signed in. */
  | 'identity-changed'

export type SignInStatus =
  | { state: 'waiting'; machineId: MachineId; terminalSessionId: SessionId }
  | {
      state: 'signed-in'
      credentialId: CredentialId
      label: string
      email?: string
      outcome: SignInOutcome
      /** The account the credential named before, for `identity-changed`. */
      previousEmail?: string
    }
  | { state: 'failed'; reason: string }

/** A sign-in that cannot start; `refusal` when it is one of the closed list. */
export class SignInRefused extends Error {
  override readonly name = 'SignInRefused'
  constructor(
    message: string,
    readonly refusal?: AccessRefusal,
    readonly code: 'not-found' | 'refused' = 'refused',
  ) {
    super(message)
  }
}

const refused = (refusal: AccessRefusal): SignInRefused =>
  new SignInRefused(ACCESS_REFUSAL_MESSAGES[refusal], refusal)

/** A login one home reports, with who it is. */
export interface ReportedHomeLogin {
  homeId: string
  identity: { fingerprint: string; email?: string }
}

export interface HomeSignInDeps {
  store: Pick<SessionStore, 'credentials' | 'machines' | 'settingsAudit'>
  /** The machine's connection now. */
  daemon: {
    isOnline(machineId: MachineId): boolean
    supports(machineId: MachineId, cap: string): boolean
  }
  rpc: {
    homeEnsure(
      credentialId: string,
      harness: HomeHarness,
      machineId: MachineId,
    ): Promise<{ ok: boolean; homeId?: string; created?: boolean; error?: string }>
    homeRemove(homeId: string, machineId: MachineId): Promise<{ ok: boolean; error?: string }>
  }
  /** The terminal that runs the vendor's sign-in in the home. */
  terminals: {
    open(i: {
      ownerUserId: UserId
      machineId: MachineId
      harness: HomeHarness
      credentialId: CredentialId
      homeId: string
    }): Promise<SessionId>
    close(sessionId: SessionId): Promise<void>
  }
  /** Ask the machine to report its inventory again. */
  requestInventory(machineId: MachineId): void
  now?: () => number
  ttlMs?: number
  reportWaitMs?: number
}

interface Attempt {
  attemptId: CredentialId
  ownerUserId: UserId
  type: CredentialTypeId
  harness: HomeHarness
  machineId: MachineId
  label?: string
  /** The credential being signed in again, when it already exists. */
  existing?: CredentialId
  homeId: string
  /** This attempt made the home, so a failed attempt removes it. */
  created: boolean
  terminalSessionId: SessionId
  status: SignInStatus
  /** The sign-in command ended; the next report decides. */
  ended: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * One at a time per account identity: two reports of one new login create one
 * credential. In memory, per server; the database stays the record.
 */
export class IdentitySerial {
  private readonly tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    this.tails.set(key, next)
    try {
      return await next
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }
}

export const identityKey = (owner: UserId, type: string, fingerprint: string): string =>
  `${owner}\u0000${type}\u0000${fingerprint}`

/** The name a credential gets when the person gave none. */
export function defaultLabel(type: CredentialTypeId, email: string | undefined): string {
  return email ?? CREDENTIAL_TYPES[type].title
}

/** The login a machine's inventory reports for one home, when it has one with an identity. */
export function reportedLogin(
  inventory: Inventory | undefined,
  harness: HomeHarness,
  homeId: string,
): ReportedHomeLogin | undefined {
  const login = inventory?.agents
    .find((agent) => agent.kind === harness)
    ?.logins?.find((entry) => entry.homeId === homeId)
  if (login?.state !== 'in' || !login.identity?.fingerprint) return undefined
  return {
    homeId,
    identity: {
      fingerprint: login.identity.fingerprint,
      ...(login.identity.email ? { email: login.identity.email } : {}),
    },
  }
}

/**
 * Bind a home's reported login to a credential of `ownerUserId` (the rules in
 * the header), record the home placement, and say what happened. `existing`
 * is the credential the sign-in was for, if it already exists; `newId` is the
 * id a new credential gets (the home is named for it).
 */
export async function bindHomeLogin(
  deps: Pick<HomeSignInDeps, 'store'> & { serial: IdentitySerial; now: () => number },
  i: {
    ownerUserId: UserId
    actorUserId: UserId
    type: CredentialTypeId
    machineId: MachineId
    login: ReportedHomeLogin
    newId: CredentialId
    existing?: CredentialId
    label?: string
  },
): Promise<BoundHomeLogin> {
  const { store } = deps
  const { fingerprint, email } = i.login.identity
  return await deps.serial.run(identityKey(i.ownerUserId, i.type, fingerprint), async () => {
    const holder = await store.credentials.findByIdentity({
      ownerUserId: i.ownerUserId,
      type: i.type,
      fingerprint,
    })
    const target = i.existing ? await store.credentials.get(i.existing) : undefined
    const live = target && target.status !== 'revoked' ? target : undefined
    let credential: CredentialRecord
    let outcome: SignInOutcome
    let previousEmail: string | undefined
    if (holder) {
      credential = holder
      outcome = live && live.id === holder.id ? 'same' : 'attached'
    } else if (live) {
      previousEmail = live.identity.email
      await store.credentials.setIdentity(live.id, {
        ...live.identity,
        fingerprint,
        ...(email ? { email } : {}),
      })
      credential = { ...live, identity: { ...live.identity, fingerprint, email } }
      outcome = live.identity.fingerprint === undefined ? 'same' : 'identity-changed'
    } else {
      credential = await store.credentials.insert({
        id: i.newId,
        ownerUserId: i.ownerUserId,
        label: i.label?.trim() || defaultLabel(i.type, email),
        type: i.type,
        identity: { fingerprint, ...(email ? { email } : {}) },
      })
      outcome = 'new'
    }
    // One home per credential on a machine (§10): the home that just signed in
    // replaces one it had there, which the caller removes.
    const harness = homeHarnessFor(i.type)
    const before = (await store.credentials.listPlacements(credential.id)).find(
      (p) => p.kind === 'home' && p.machineId === i.machineId && p.state === 'present',
    )
    const beforeHome = before
      ? (before.homeId ?? (harness ? homeIdFor(credential.id, harness) : undefined))
      : undefined
    const replacedHomeId = beforeHome && beforeHome !== i.login.homeId ? beforeHome : undefined
    await store.credentials.recordPlacement({
      credentialId: credential.id,
      machineId: i.machineId,
      kind: 'home',
      homeId: i.login.homeId,
    })
    // The home the sign-in was for is now another credential's.
    if (live && live.id !== credential.id) {
      const theirs = (await store.credentials.listPlacements(live.id)).find(
        (p) => p.kind === 'home' && p.machineId === i.machineId && p.state !== 'removed',
      )
      if (theirs && (theirs.homeId ?? i.login.homeId) === i.login.homeId) {
        await store.credentials.setPlacementState(theirs, 'removed')
      }
    }
    if (credential.status !== 'ok') await store.credentials.setStatus(credential.id, 'ok')
    await store.credentials.markVerified(credential.id, new Date(deps.now()).toISOString())
    await recordCredentialEvent(store, {
      kind: outcome === 'new' ? 'add' : 'renew',
      credentialId: credential.id,
      actorUserId: i.actorUserId,
      machineId: i.machineId,
      detail: `signed in on a machine (${outcome})`,
    })
    return {
      state: 'signed-in',
      credentialId: credential.id,
      label: credential.label,
      ...(email ? { email } : {}),
      outcome,
      ...(outcome === 'identity-changed' && previousEmail ? { previousEmail } : {}),
      ...(replacedHomeId ? { replacedHomeId } : {}),
    }
  })
}

/** What binding a home's login did; `replacedHomeId` is a home the caller removes. */
export type BoundHomeLogin = Extract<SignInStatus, { state: 'signed-in' }> & {
  replacedHomeId?: string
}

export class HomeSignInService {
  readonly serial = new IdentitySerial()
  private readonly attempts = new Map<CredentialId, Attempt>()
  private readonly bySession = new Map<SessionId, CredentialId>()
  private readonly now: () => number

  constructor(private readonly deps: HomeSignInDeps) {
    this.now = deps.now ?? Date.now
  }

  /** A sign-in is waiting for a login in this home. */
  isWaitingFor(homeId: string): boolean {
    for (const attempt of this.attempts.values()) {
      if (attempt.homeId === homeId && attempt.status.state === 'waiting') return true
    }
    return false
  }

  async start(i: {
    ownerUserId: UserId
    type: string
    machineId: MachineId
    label?: string
    credentialId?: CredentialId
  }): Promise<{ credentialId: CredentialId; terminalSessionId: SessionId }> {
    const { store } = this.deps
    if (!isCredentialTypeId(i.type)) throw new SignInRefused(`Unknown credential type ${i.type}.`)
    const type = i.type
    const spec = CREDENTIAL_TYPES[type]
    const harness = homeHarnessFor(type)
    if (spec.store !== 'home' || !spec.obtain.includes('harness-sign-in') || !harness) {
      throw new SignInRefused(`${spec.title} is not added by signing in on a machine.`)
    }
    let existing: CredentialRecord | undefined
    if (i.credentialId) {
      existing = await store.credentials.get(i.credentialId)
      // Signing in again changes which account it is: the owner's own act.
      if (!existing || existing.status === 'revoked' || existing.ownerUserId !== i.ownerUserId) {
        throw new SignInRefused('no such credential', undefined, 'not-found')
      }
      if (existing.type !== type) throw refused('wrong-type')
      const running = this.attempts.get(existing.id)
      if (running?.status.state === 'waiting' && running.machineId === i.machineId) {
        return { credentialId: running.attemptId, terminalSessionId: running.terminalSessionId }
      }
    }
    const machine = await store.machines.getMachine(i.machineId)
    if (!machine || machine.revokedAt) {
      throw new SignInRefused('unknown machine', undefined, 'not-found')
    }
    // §8: only where the owner holds custody, or sent this credential.
    const custodian = await store.machines.custodian(i.machineId)
    const allowed =
      custodian === i.ownerUserId ||
      (existing !== undefined &&
        (await store.credentials.isMachineAllowed(existing.id, i.machineId)))
    if (!allowed) throw refused('machine-not-allowed')
    if (!this.deps.daemon.isOnline(i.machineId)) throw refused('machine-offline')
    if (!this.deps.daemon.supports(i.machineId, CAP_HARNESS_HOMES)) throw refused('daemon-too-old')
    const agent = machine.inventory?.agents.find((a) => a.kind === harness)
    if (agent && agent.installed === false) {
      throw new SignInRefused(
        `${spec.title} needs ${harness} on ${machine.name}; it is not installed there.`,
      )
    }

    const attemptId = existing?.id ?? newCredentialId()
    const ensured = await this.deps.rpc.homeEnsure(attemptId, harness, i.machineId)
    if (!ensured.ok) {
      throw new SignInRefused(
        ensured.error ?? `${machine.name} could not make a home for the login.`,
      )
    }
    const homeId = ensured.homeId ?? homeIdFor(attemptId, harness)
    const created = ensured.created === true
    let terminalSessionId: SessionId
    try {
      terminalSessionId = await this.deps.terminals.open({
        ownerUserId: i.ownerUserId,
        machineId: i.machineId,
        harness,
        credentialId: attemptId,
        homeId,
      })
    } catch (error) {
      if (created) await this.removeHome(homeId, i.machineId)
      throw error
    }
    const attempt: Attempt = {
      attemptId,
      ownerUserId: i.ownerUserId,
      type,
      harness,
      machineId: i.machineId,
      ...(i.label?.trim() ? { label: i.label.trim() } : {}),
      ...(existing ? { existing: existing.id } : {}),
      homeId,
      created,
      terminalSessionId,
      status: { state: 'waiting', machineId: i.machineId, terminalSessionId },
      ended: false,
    }
    this.attempts.set(attemptId, attempt)
    this.bySession.set(terminalSessionId, attemptId)
    attempt.timer = this.after(this.deps.ttlMs ?? SIGN_IN_TTL_MS, () =>
      this.fail(attempt, 'The sign-in was not finished in time.'),
    )
    return { credentialId: attemptId, terminalSessionId }
  }

  /** Where the caller's sign-in stands. Another person's answers as unknown. */
  status(attemptId: string, userId: UserId): SignInStatus {
    const attempt = this.attempts.get(asCredentialId(attemptId))
    if (!attempt || attempt.ownerUserId !== userId) {
      return { state: 'failed', reason: 'There is no such sign-in.' }
    }
    return attempt.status
  }

  /** The person gave up: close the terminal and remove the home it made. */
  async cancel(attemptId: string, userId: UserId): Promise<void> {
    const attempt = this.attempts.get(asCredentialId(attemptId))
    if (!attempt || attempt.ownerUserId !== userId) {
      throw new SignInRefused('There is no such sign-in.', undefined, 'not-found')
    }
    if (attempt.status.state !== 'waiting') return
    await this.fail(attempt, 'The sign-in was cancelled.')
  }

  /** A machine reported its inventory: a waiting sign-in there may be done. */
  async onInventory(machineId: MachineId, inventory: Inventory | undefined): Promise<void> {
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.machineId !== machineId || attempt.status.state !== 'waiting') continue
      const login = reportedLogin(inventory, attempt.harness, attempt.homeId)
      if (!login) continue
      try {
        await this.succeed(attempt, login)
      } catch (error) {
        log.warn('a home sign-in could not be recorded', { err: error, machineId })
        await this.fail(attempt, 'The login could not be recorded. Try again.')
      }
    }
  }

  /** The sign-in terminal ended. */
  async onExit(sessionId: SessionId, code: number): Promise<void> {
    const attemptId = this.bySession.get(sessionId)
    if (!attemptId) return
    this.bySession.delete(sessionId)
    const attempt = this.attempts.get(attemptId)
    if (attempt?.status.state !== 'waiting') return
    attempt.ended = true
    if (code !== 0) {
      await this.fail(attempt, `The sign-in ended without signing in (exit ${code}).`)
      return
    }
    // The command says it signed in: the machine's next report shows who.
    this.deps.requestInventory(attempt.machineId)
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.timer = this.after(this.deps.reportWaitMs ?? SIGN_IN_REPORT_WAIT_MS, () =>
      this.fail(attempt, 'The sign-in ended, but the machine reports no login in its home.'),
    )
  }

  private async succeed(attempt: Attempt, login: ReportedHomeLogin): Promise<void> {
    if (attempt.timer) clearTimeout(attempt.timer)
    const result = await bindHomeLogin(
      { store: this.deps.store, serial: this.serial, now: this.now },
      {
        ownerUserId: attempt.ownerUserId,
        actorUserId: attempt.ownerUserId,
        type: attempt.type,
        machineId: attempt.machineId,
        login,
        newId: attempt.attemptId,
        ...(attempt.existing ? { existing: attempt.existing } : {}),
        ...(attempt.label ? { label: attempt.label } : {}),
      },
    )
    const { replacedHomeId, ...status } = result
    attempt.status = status
    this.forgetLater(attempt)
    if (replacedHomeId) await this.removeHome(replacedHomeId, attempt.machineId)
    if (!attempt.ended) {
      this.bySession.delete(attempt.terminalSessionId)
      await this.closeTerminal(attempt)
    }
  }

  private async fail(attempt: Attempt, reason: string): Promise<void> {
    if (attempt.status.state !== 'waiting') return
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.status = { state: 'failed', reason }
    this.forgetLater(attempt)
    this.bySession.delete(attempt.terminalSessionId)
    if (!attempt.ended) await this.closeTerminal(attempt)
    // A home that held a login before this attempt is never touched.
    if (attempt.created) await this.removeHome(attempt.homeId, attempt.machineId)
  }

  private async closeTerminal(attempt: Attempt): Promise<void> {
    try {
      await this.deps.terminals.close(attempt.terminalSessionId)
    } catch (error) {
      log.warn('the sign-in terminal did not close', { err: error })
    }
  }

  private async removeHome(homeId: string, machineId: MachineId): Promise<void> {
    try {
      const result = await this.deps.rpc.homeRemove(homeId, machineId)
      if (!result.ok)
        log.warn('an unused sign-in home was not removed', {
          homeId,
          machineId,
          error: result.error,
        })
    } catch (error) {
      log.warn('an unused sign-in home was not removed', { err: error, homeId, machineId })
    }
  }

  /** A finished attempt answers its status for a while, then is dropped. */
  private forgetLater(attempt: Attempt): void {
    attempt.timer = this.after(SIGN_IN_KEEP_MS, async () => {
      if (this.attempts.get(attempt.attemptId) === attempt) this.attempts.delete(attempt.attemptId)
    })
  }

  private after(ms: number, fn: () => Promise<void>): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void fn().catch((error: unknown) => log.warn('a sign-in timer failed', { err: error }))
    }, ms)
    timer.unref?.()
    return timer
  }

  /** Stop every timer (server shutdown, tests). */
  dispose(): void {
    for (const attempt of this.attempts.values()) if (attempt.timer) clearTimeout(attempt.timer)
  }
}
