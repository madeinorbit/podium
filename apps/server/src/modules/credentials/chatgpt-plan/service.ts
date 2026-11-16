/**
 * THE CHATGPT PLAN MODULE (credential management §11; epic Task 14): the
 * sign-in, the keeper, and the daemon that listens for the browser's return.
 * The credential commands reach it as `CredentialsState.chatgpt`; the
 * composition root builds it (`registry.modules.chatgptPlan`).
 */

import { createLogger } from '@podium/logger'
import type { CredentialId, MachineId, UserId } from '@podium/model'
import {
  CHATGPT_SIGN_IN_TTL_MS,
  type ChatgptCallback,
  type ChatgptSignIn,
  type ChatgptSignInStatus,
  parseCallbackAddress,
  SignInRefused,
} from './authorize'
import type { ChatgptPlanKeeper } from './keeper'
import { CHATGPT_DEFAULT_PORT } from './openai'

const log = createLogger('server:chatgpt-plan')

/** How the server reaches a daemon that listens on its loopback address. */
export interface ChatgptLoopbackPort {
  /** `offline`: not connected; `too-old`: its daemon does not offer `CAP_OAUTH_LOOPBACK`. */
  canListen(machineId: MachineId): 'ok' | 'offline' | 'too-old'
  listen(
    machineId: MachineId,
    i: { port: number; ttlMs: number },
    onCallback: (callback: ChatgptCallback) => void,
  ): Promise<{ listening: boolean; error?: string }>
}

/** The machine cannot listen for this sign-in; the person can paste instead. */
export class LoopbackUnavailable extends Error {
  override readonly name = 'LoopbackUnavailable'
}

export type ChatgptSignInVia = 'machine' | 'paste'

/** A port OpenAI accepts when 1455 is taken: only the port may vary (§11). */
const fallbackPort = (random: () => number): number => 49_152 + Math.floor(random() * 16_000)

export class ChatgptPlanService {
  constructor(
    readonly signIn: ChatgptSignIn,
    readonly keeper: ChatgptPlanKeeper,
    readonly loopback?: ChatgptLoopbackPort,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Start a sign-in. With a machine, it listens first (on 1455, else on one
   * other port), so the authorize address names a port that is open.
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
    // Set once the attempt exists; the browser cannot return before that.
    let attemptId: string | undefined
    const onCallback = (callback: ChatgptCallback) => {
      if (!attemptId) return
      void this.signIn
        .complete({ attemptId, callback, actorUserId: i.ownerUserId })
        .catch((err: unknown) => {
          log.warn('a relayed ChatGPT sign-in was refused', {
            reason: err instanceof SignInRefused ? err.message : String(err),
          })
        })
    }
    let lastError = ''
    for (const port of [CHATGPT_DEFAULT_PORT, fallbackPort(this.random)]) {
      const answer = await loopback.listen(
        machineId,
        { port, ttlMs: CHATGPT_SIGN_IN_TTL_MS },
        onCallback,
      )
      if (answer.listening) {
        const started = await this.signIn.start({ ...base, port })
        attemptId = started.attemptId
        return { ...started, via: 'machine' }
      }
      lastError = answer.error ?? 'It could not listen.'
    }
    throw new LoopbackUnavailable(`${lastError} Paste the address instead.`)
  }

  /** Complete an attempt from the address the person pasted. */
  async completePasted(i: {
    attemptId: string
    pastedUrl: string
    actorUserId: UserId
  }): Promise<ChatgptSignInStatus> {
    const callback = parseCallbackAddress(i.pastedUrl)
    if ('invalid' in callback) throw new SignInRefused(callback.invalid)
    return await this.signIn.complete({
      attemptId: i.attemptId,
      callback,
      actorUserId: i.actorUserId,
    })
  }

  status(attemptId: string, ownerUserId: UserId): ChatgptSignInStatus {
    return this.signIn.status(attemptId, ownerUserId)
  }
}
