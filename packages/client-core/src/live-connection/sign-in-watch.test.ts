import { SIGN_IN_ENDED_CLOSE } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { AuthStatus, LiveAuthCheck } from '../accounts/auth'
import type { HubEvents } from '../socket-transport/socket-hub'
import { type SignedOutReason, type SignInWatchHub, watchSignIn } from './sign-in-watch'

type LinkHandler = (...payload: HubEvents['link']) => void

class FakeHub implements SignInWatchHub {
  handlers = new Set<LinkHandler>()
  on(_kind: 'link', handler: LinkHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  lost(code = 1006): void {
    for (const handler of [...this.handlers])
      handler('lost', { cause: 'close-event', code, reason: '', wasClean: code !== 1006 })
  }
  welcomed(): void {
    for (const handler of [...this.handlers]) handler('welcomed')
  }
}

const BOB = 'bob'
const signedOutStatus: AuthStatus = { needsAuth: true, authed: false, userId: null }
const bobStatus = {
  needsAuth: true,
  authed: true,
  userId: BOB,
  memberId: BOB,
} as unknown as AuthStatus

const expired = (status: AuthStatus = signedOutStatus): LiveAuthCheck => ({
  kind: 'expired',
  status,
})
const valid = (status: AuthStatus = bobStatus): LiveAuthCheck => ({ kind: 'valid', status })
const unreachable: LiveAuthCheck = { kind: 'unreachable', cause: new TypeError('fetch failed') }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function watch(answers: LiveAuthCheck[] | (() => Promise<LiveAuthCheck>)) {
  const hub = new FakeHub()
  const reasons: SignedOutReason[] = []
  const queue = Array.isArray(answers) ? [...answers] : undefined
  const check = vi.fn(
    Array.isArray(answers)
      ? async () => queue?.shift() ?? unreachable
      : (answers as () => Promise<LiveAuthCheck>),
  )
  const stop = watchSignIn(hub, {
    check,
    memberId: BOB,
    onSignedOut: (reason) => reasons.push(reason),
  })
  return { hub, reasons, check, stop }
}

describe('a sign-in the server ended is not an outage (POD-6910)', () => {
  it('a device sign-out: the server closes with signed_out and says not signed in', async () => {
    const { hub, reasons, check } = watch([expired()])
    hub.lost(SIGN_IN_ENDED_CLOSE.signedOut.code)
    await settle()
    expect(reasons).toEqual(['signed-out'])
    expect(check).toHaveBeenCalledOnce()
    // Fired once, and the watch let go of the hub: no more questions.
    expect(hub.handlers.size).toBe(0)
  })

  it('a removal: the server closes with access_ended, so the screen says access ended', async () => {
    const { hub, reasons } = watch([expired()])
    hub.lost(SIGN_IN_ENDED_CLOSE.accessEnded.code)
    await settle()
    expect(reasons).toEqual(['access-ended'])
  })

  it('a removal seen only through the status answer (the device was offline)', async () => {
    const { hub, reasons } = watch([
      expired({ ...signedOutStatus, denied: 'not_workspace_member' }),
    ])
    hub.lost()
    await settle()
    expect(reasons).toEqual(['access-ended'])
  })

  it('a refused redial with no close code still asks, and the status answer decides', async () => {
    const { hub, reasons } = watch([expired()])
    hub.lost()
    await settle()
    expect(reasons).toEqual(['signed-out'])
  })

  it('a network outage keeps the runtime: no answer is never a sign-out', async () => {
    const { hub, reasons, check } = watch([unreachable, unreachable, unreachable])
    hub.lost()
    await settle()
    hub.lost()
    await settle()
    hub.lost()
    await settle()
    expect(reasons).toEqual([])
    // Each lost link asked again: the watch is still listening.
    expect(check).toHaveBeenCalledTimes(3)
    expect(hub.handlers.size).toBe(1)
  })

  it('a close code alone erases nothing: a server that still says signed in wins', async () => {
    const { hub, reasons } = watch([valid()])
    hub.lost(SIGN_IN_ENDED_CLOSE.signedOut.code)
    await settle()
    expect(reasons).toEqual([])
  })

  it('a server that answers with another member means this sign-in is gone', async () => {
    const { hub, reasons } = watch([
      valid({ ...bobStatus, userId: 'carol', memberId: 'carol' } as unknown as AuthStatus),
    ])
    hub.lost()
    await settle()
    expect(reasons).toEqual(['signed-out'])
  })

  it('a status request that never answers counts as an outage and is asked again', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const { hub, reasons, check } = watch(() => {
        calls += 1
        return calls === 1 ? new Promise<LiveAuthCheck>(() => {}) : Promise.resolve(expired())
      })
      hub.lost()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(reasons).toEqual([])
      hub.lost()
      await vi.advanceTimersByTimeAsync(0)
      expect(check).toHaveBeenCalledTimes(2)
      expect(reasons).toEqual(['signed-out'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an answer to a question asked before the server welcomed this device again is stale', async () => {
    let answer: (result: LiveAuthCheck) => void = () => {}
    const { hub, reasons } = watch(
      () =>
        new Promise<LiveAuthCheck>((resolve) => {
          answer = resolve
        }),
    )
    hub.lost()
    hub.welcomed()
    answer(expired())
    await settle()
    expect(reasons).toEqual([])
  })

  it('losses during one question are answered by one more question, not one each', async () => {
    const answers: ((result: LiveAuthCheck) => void)[] = []
    const { hub, reasons, check } = watch(
      () =>
        new Promise<LiveAuthCheck>((resolve) => {
          answers.push(resolve)
        }),
    )
    hub.lost()
    hub.lost()
    hub.lost()
    expect(check).toHaveBeenCalledOnce()
    answers[0]?.(unreachable)
    await settle()
    expect(check).toHaveBeenCalledTimes(2)
    answers[1]?.(expired())
    await settle()
    expect(reasons).toEqual(['signed-out'])
  })

  it('stopping the watch ignores an answer still in flight', async () => {
    let answer: (result: LiveAuthCheck) => void = () => {}
    const { hub, reasons, stop } = watch(
      () =>
        new Promise<LiveAuthCheck>((resolve) => {
          answer = resolve
        }),
    )
    hub.lost()
    stop()
    answer(expired())
    await settle()
    expect(reasons).toEqual([])
  })
})
