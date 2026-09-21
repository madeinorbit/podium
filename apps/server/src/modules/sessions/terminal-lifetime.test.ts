/**
 * THE SHELL LIFETIME TABLE (POD-4435): one server-side rule decides whether a
 * shell is kept, parked or killed, from who owns it and whether it was used.
 *
 * Each row is one DONE WHEN case plus the two last-resort timers. The table is
 * order-sensitive: first match wins, and the reasons are stable strings the
 * triggers log.
 */
import { describe, expect, it } from 'vitest'
import { decideShellLifetime, type ShellLifetimeInputs } from './terminal-lifetime'

const HOUR = 60_000
const DAY = 24 * 60 * HOUR

function inputs(overrides: Partial<ShellLifetimeInputs> = {}): ShellLifetimeInputs {
  return {
    purpose: 'shell',
    hasInput: true,
    heldByTab: true,
    watched: true,
    lastTabReleased: false,
    issueClosed: false,
    worktreeFreed: false,
    quietMs: HOUR,
    unheldMs: 0,
    unwatchedMs: 0,
    warmTtlMs: 30 * HOUR,
    backstopMs: 2 * DAY,
    exited: false,
    ...overrides,
  }
}

describe('decideShellLifetime', () => {
  it('touched + open issue stays, however long it is quiet (short of the backstop)', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: true, heldByTab: true, quietMs: 59 * HOUR }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('untouched + last tab released dies immediately', () => {
    const decision = decideShellLifetime(
      inputs({
        hasInput: false,
        heldByTab: false,
        lastTabReleased: true,
        watched: false,
        unheldMs: 0,
      }),
    )
    expect(decision.verdict).toBe('kill')
    expect(decision.reason).toBe('untouched-shell-last-tab-released')
  })

  it('touched + released stays: a used shell survives its tab closing', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: true, heldByTab: false, lastTabReleased: true, watched: false }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('touched + worktree freed parks (it does not die with the checkout)', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: true, worktreeFreed: true, heldByTab: false }),
    )
    expect(decision.verdict).toBe('park')
    expect(decision.reason).toBe('touched-shell-owner-gone')
  })

  it('touched + issue closed parks', () => {
    const decision = decideShellLifetime(inputs({ hasInput: true, issueClosed: true }))
    expect(decision.verdict).toBe('park')
  })

  it('login pane is kept until it exits, even past every threshold', () => {
    const decision = decideShellLifetime(
      inputs({
        purpose: 'login',
        hasInput: false,
        heldByTab: false,
        issueClosed: true,
        worktreeFreed: true,
        quietMs: 10 * DAY,
      }),
    )
    expect(decision.verdict).toBe('keep')
    expect(decision.reason).toBe('login-pane-kept-until-exit')
  })

  it('attach TUI unwatched past its warm TTL parks', () => {
    const decision = decideShellLifetime(
      inputs({
        purpose: 'attach-tui',
        watched: false,
        heldByTab: false,
        unwatchedMs: 31 * HOUR,
        warmTtlMs: 30 * HOUR,
      }),
    )
    expect(decision.verdict).toBe('park')
    expect(decision.reason).toBe('attach-tui-unwatched-past-warm-ttl')
  })

  it('attach TUI watched inside its window stays', () => {
    const decision = decideShellLifetime(
      inputs({ purpose: 'attach-tui', watched: true, unwatchedMs: 10 * HOUR }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('the multi-day backstop kills as the last resort, even a touched shell', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: true, heldByTab: true, quietMs: 3 * DAY, backstopMs: 2 * DAY }),
    )
    expect(decision.verdict).toBe('kill')
    expect(decision.reason).toBe('multi-day-backstop')
  })

  it('no backstop configured means no backstop kill', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: true, quietMs: 30 * DAY, backstopMs: undefined }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('release while another tab still holds it keeps: no cross-client kill', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: false, lastTabReleased: true, heldByTab: true }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('untouched + unheld past the idle grace dies without any release edge', () => {
    const decision = decideShellLifetime(
      inputs({
        hasInput: false,
        heldByTab: false,
        watched: false,
        unheldMs: 61 * HOUR,
        idleGraceMs: 60 * HOUR,
        lastTabReleased: false,
      }),
    )
    expect(decision.verdict).toBe('kill')
    expect(decision.reason).toBe('untouched-shell-unheld-past-grace')
  })

  it('untouched + unheld inside the grace stays: a network blip is not a tab close', () => {
    const decision = decideShellLifetime(
      inputs({
        hasInput: false,
        heldByTab: false,
        watched: false,
        unheldMs: 5 * HOUR,
        idleGraceMs: 60 * HOUR,
        lastTabReleased: false,
      }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('no grace configured means no grace kill', () => {
    const decision = decideShellLifetime(
      inputs({
        hasInput: false,
        heldByTab: false,
        unheldMs: 30 * DAY,
        idleGraceMs: undefined,
        lastTabReleased: false,
        backstopMs: undefined,
      }),
    )
    expect(decision.verdict).toBe('keep')
  })

  it('untouched + owner gone dies rather than lingering as a parked row', () => {
    const decision = decideShellLifetime(
      inputs({ hasInput: false, heldByTab: false, issueClosed: true }),
    )
    expect(decision.verdict).toBe('kill')
    expect(decision.reason).toBe('untouched-shell-owner-gone')
  })

  it('an already-exited shell needs nothing', () => {
    const decision = decideShellLifetime(inputs({ exited: true }))
    expect(decision.verdict).toBe('keep')
    expect(decision.reason).toBe('already-exited')
  })
})
