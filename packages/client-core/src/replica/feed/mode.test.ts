/**
 * POD-376 — the flag cannot select an unscoped read path against a scoped
 * authority.
 *
 * The table is TOTAL over (kernelReplicaEnabled × shadowEnabled × grade), because
 * the thing being asserted is that one input combination is refused, and a
 * partial table cannot distinguish "refused" from "not covered". The
 * grade-permissive half is written first throughout: a resolver that answered
 * `kernel` unconditionally would satisfy every refusal case here, and only the
 * legacy cases can catch it.
 */

import { describe, expect, it } from 'vitest'
import { explainReplicaMode, resolveReplicaMode, type ResolveReplicaModeInput } from './mode'

const resolve = (over: Partial<ResolveReplicaModeInput> = {}) =>
  resolveReplicaMode({
    kernelReplicaEnabled: false,
    shadowEnabled: false,
    serverGrade: 'device-unscoped',
    ...over,
  })

describe('against a device-unscoped authority the flags are simply obeyed', () => {
  it('off is the legacy path — the shipped behaviour, and the case a broken gate would break', () => {
    expect(resolve()).toEqual({ path: 'legacy', reason: 'as-configured', overridden: false })
  })

  it('on is the kernel path', () => {
    expect(resolve({ kernelReplicaEnabled: true })).toEqual({
      path: 'kernel',
      reason: 'as-configured',
      overridden: false,
    })
  })

  it('on + shadow runs both', () => {
    expect(resolve({ kernelReplicaEnabled: true, shadowEnabled: true })).toEqual({
      path: 'kernel-with-shadow',
      reason: 'as-configured',
      overridden: false,
    })
  })

  it('shadow WITHOUT the cutover is not a path — there is nothing to compare against', () => {
    // The shadow flag is a comparison, not a read path. On its own it must not
    // quietly turn the cutover on, and must not turn the legacy path into
    // something else either.
    expect(resolve({ shadowEnabled: true })).toEqual({
      path: 'legacy',
      reason: 'as-configured',
      overridden: false,
    })
  })
})

describe('against a per-principal authority the legacy path is REFUSED, not preferred', () => {
  it('off resolves to the kernel path, and says it was overridden', () => {
    expect(resolve({ serverGrade: 'per-principal' })).toEqual({
      path: 'kernel',
      reason: 'legacy-refused-scoped-authority',
      overridden: true,
    })
  })

  it('on is untouched — the refusal is about the legacy path, not about scoping', () => {
    expect(resolve({ kernelReplicaEnabled: true, serverGrade: 'per-principal' })).toEqual({
      path: 'kernel',
      reason: 'as-configured',
      overridden: false,
    })
  })

  it('on + shadow drops the SHADOW, because the shadow IS a wire-v1 connection', () => {
    // The trap this guards: keeping the shadow would leave a second connection
    // the server refuses, and a comparison against a path that received no rows
    // reports zero divergence forever — a rubber stamp that looks like evidence.
    expect(resolve({ kernelReplicaEnabled: true, shadowEnabled: true, serverGrade: 'per-principal' })).toEqual(
      { path: 'kernel', reason: 'legacy-refused-scoped-authority', overridden: true },
    )
  })

  it('the override is EXPLAINED, and only when it happened', () => {
    expect(explainReplicaMode(resolve({ serverGrade: 'per-principal' }))).toContain(
      'per principal',
    )
    // A resolver that always returned an explanation would make the string
    // meaningless: the honoured case must produce nothing to render.
    expect(explainReplicaMode(resolve())).toBe('')
    expect(explainReplicaMode(resolve({ kernelReplicaEnabled: true }))).toBe('')
  })
})

describe('an unreadable grade fails toward the SERVER being able to refuse', () => {
  // Documented as a deliberate fail-open in mode.ts: this function is not the
  // security boundary, the server's admission gate is. These cases pin the
  // direction so a later "tighten it" edit has to argue with the reasoning.
  it.each([undefined, '', 'per-principal-ish', 'PER-PRINCIPAL', 'unknown-future-grade'])(
    'treats %p as device-unscoped, leaving the flag in charge',
    (grade) => {
      expect(resolve({ serverGrade: grade as string | undefined }).path).toBe('legacy')
    },
  )

  it('but the EXACT string does scope — so the check is a comparison, not a truthiness test', () => {
    // Without this, `serverGrade !== undefined` would pass every case above.
    expect(resolve({ serverGrade: 'per-principal' }).path).toBe('kernel')
  })
})
