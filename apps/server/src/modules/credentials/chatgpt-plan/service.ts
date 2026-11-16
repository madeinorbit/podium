/**
 * THE CHATGPT PLAN MODULE (credential management §11; epic Task 14): the
 * sign-in, the keeper, and the daemon that listens for the browser's return.
 * The credential commands reach it as `CredentialsState.chatgpt`; the
 * composition root builds it with {@link composeChatgptPlan}
 * (`registry.modules.chatgptPlan`).
 */

import { createLogger } from '@podium/logger'
import type { CredentialId, MachineId, UserId } from '@podium/model'
import { CAP_OAUTH_LOOPBACK } from '@podium/protocol'
import type { SessionStore } from '../../../store'
import type { CredentialRecord } from '../../../store/credentials'
import {
  CHATGPT_SIGN_IN_TTL_MS,
  type ChatgptCallback,
  ChatgptSignIn,
  type ChatgptSignInStatus,
  parseCallbackAddress,
  SignInRefused,
} from './authorize'
import { chatgptHostId } from './host-id'
import { ChatgptPlanKeeper, type KeeperHealthPort } from './keeper'
import { CHATGPT_DEFAULT_PORT, type FetchLike } from './openai'

const log = createLogger('server:chatgpt-plan')

/** How the server reaches a daemon that listens on its loopback address. */
export interface ChatgptLoopbackPort {
  /** `offline`: not connected; `too-old`: its daemon does not offer `CAP_OAUTH_LOOPBACK`. */
  canListen(machineId: MachineId): 'ok' | 'offline' | 'too-old'
  listen(
    machineId: MachineId,
    i: { port: number; state: string; ttlMs: number },
    onCallback: (callback: ChatgptCallback) => void,
  ): Promise<{ listening: boolean; error?: string; listenerId?: string }>
  cancel(machineId: MachineId, listenerId: string): void
}

/** The machine cannot listen for this sign-in; the person can paste instead. */
export class LoopbackUnavailable extends Error {
  override readonly name = 'LoopbackUnavailable'
}

export type ChatgptSignInVia = 'machine' | 'paste'

/** A port OpenAI accepts when 1455 is taken: only the port may vary (§11). */
const fallbackPort = (random: () => number): number => 49_152 + Math.floor(random() * 16_000)

export class ChatgptPlanService {
  /** The listener each attempt opened, to close it when the attempt ends another way. */
  private readonly listeners = new Map<string, { machineId: MachineId; listenerId: string }>()

  constructor(
    readonly signIn: ChatgptSignIn,
    readonly keeper: ChatgptPlanKeeper,
    readonly loopback?: ChatgptLoopbackPort,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Start a sign-in. With a machine, it listens for this attempt's `state`
   * first (on 1455, else on one other port), so the authorize address names a
   * port that is open.
   */
  async start(i: {
    ownerUserId: UserId
    label?: string
    machineId?: MachineId
    credentialId?: CredentialId
  }): Promise<{ attemptId: string; authorizeUrl: string; via: ChatgptSignInVia }> {
    const base = {
      ownerUserId: i.ownerUserId,
      ...(i.label ? { label: i.label } : {}),
      ...(i.credentialId ? { credentialId: i.credentialId } : {}),
    }
    if (!i.machineId) {
      const started = await this.signIn.start({ ...base, port: CHATGPT_DEFAULT_PORT })
      return { ...started, via: 'paste' }
    }
    const machineId = i.machineId
    const loopback = this.loopback
    const can = loopback ? loopback.canListen(machineId) : 'too-old'
    if (!loopback || can !== 'ok') {
      throw new LoopbackUnavailable(
        can === 'offline'
          ? 'That machine is not connected. Pick another, or paste the address instead.'
          : 'Podium on that machine is too old to listen for a sign-in. Update it, or paste the address instead.',
      )
    }
    let lastError = ''
    for (const port of [CHATGPT_DEFAULT_PORT, fallbackPort(this.random)]) {
      const started = await this.signIn.start({ ...base, port })
      const state = new URL(started.authorizeUrl).searchParams.get('state') ?? ''
      const answer = await loopback.listen(
        machineId,
        { port, state, ttlMs: CHATGPT_SIGN_IN_TTL_MS },
        (callback) => this.relayed(started.attemptId, i.ownerUserId, callback),
      )
      if (answer.listening) {
        if (answer.listenerId) {
          this.listeners.set(started.attemptId, { machineId, listenerId: answer.listenerId })
        }
        return { ...started, via: 'machine' }
      }
      this.signIn.discard(started.attemptId)
      lastError = answer.error ?? 'It could not listen.'
    }
    throw new LoopbackUnavailable(`${lastError} Paste the address instead.`)
  }

  /** Complete an attempt from the address the person pasted; its listener closes. */
  async completePasted(i: {
    attemptId: string
    pastedUrl: string
    actorUserId: UserId
  }): Promise<ChatgptSignInStatus> {
    const callback = parseCallbackAddress(i.pastedUrl)
    if ('invalid' in callback) throw new SignInRefused(callback.invalid)
    const outcome = await this.signIn.complete({
      attemptId: i.attemptId,
      callback,
      actorUserId: i.actorUserId,
    })
    this.closeListener(i.attemptId)
    return outcome
  }

  status(attemptId: string, ownerUserId: UserId): ChatgptSignInStatus {
    return this.signIn.status(attemptId, ownerUserId)
  }

  private relayed(attemptId: string, ownerUserId: UserId, callback: ChatgptCallback): void {
    this.listeners.delete(attemptId)
    void this.signIn
      .complete({ attemptId, callback, actorUserId: ownerUserId })
      .catch((err: unknown) => {
        log.warn('a relayed ChatGPT sign-in was refused', {
          reason: err instanceof SignInRefused ? err.message : String(err),
        })
      })
  }

  private closeListener(attemptId: string): void {
    const listener = this.listeners.get(attemptId)
    if (!listener) return
    this.listeners.delete(attemptId)
    this.loopback?.cancel(listener.machineId, listener.listenerId)
  }
}

/**
 * Build the module for a server: the keeper, the sign-in (with this server's
 * host id) and the daemons' loopback listeners. `health` is read when it is
 * needed, because the composition root builds the health service later.
 */
export function composeChatgptPlan(deps: {
  store: SessionStore
  now: () => number
  /** OpenAI's endpoints; tests pass a fake. Absent: the global `fetch`. */
  fetch?: FetchLike | undefined
  health: () => KeeperHealthPort & {
    afterRenew(record: CredentialRecord, v: { providerChecked: boolean }): Promise<void>
  }
  machines: {
    hasDaemon(id: MachineId): boolean
    daemonSupports(id: MachineId, cap: string): boolean
  }
  rpc: {
    oauthLoopbackListen: ChatgptLoopbackPort['listen']
    oauthLoopbackCancel: ChatgptLoopbackPort['cancel']
  }
}): ChatgptPlanService {
  const fetch = deps.fetch ? { fetch: deps.fetch } : {}
  const keeper = new ChatgptPlanKeeper({
    store: deps.store,
    now: deps.now,
    ...fetch,
    health: { noteFailure: async (failure) => await deps.health().noteFailure(failure) },
  })
  const signIn = new ChatgptSignIn({
    store: deps.store,
    hostId: async () => chatgptHostId(await deps.store.secrets.installationIdentity()),
    now: deps.now,
    afterRenew: async (record) => await deps.health().afterRenew(record, { providerChecked: true }),
    ...fetch,
  })
  return new ChatgptPlanService(signIn, keeper, {
    canListen: (machineId) =>
      !deps.machines.hasDaemon(machineId)
        ? 'offline'
        : deps.machines.daemonSupports(machineId, CAP_OAUTH_LOOPBACK)
          ? 'ok'
          : 'too-old',
    listen: async (machineId, i, onCallback) =>
      await deps.rpc.oauthLoopbackListen(machineId, i, onCallback),
    cancel: (machineId, listenerId) => deps.rpc.oauthLoopbackCancel(machineId, listenerId),
  })
}
