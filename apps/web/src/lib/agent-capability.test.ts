/**
 * THE SPAWN-ROW CAPABILITY READING (POD-1201).
 *
 * The invariant these cases exist to hold is that `reason` is BOTH the disable
 * decision and the sentence: a row that refuses a click always says why, and a
 * row that says why always refuses. Every case below therefore asserts the pair,
 * never one half of it — a regression that greys a row without words, or prints
 * words on a live row, has to fail here.
 *
 * Each fixture also carries its COUNTERFACTUAL: the same machine one field
 * different, accepted. Without that, "everything is refused" passes too.
 */
import { describe, expect, it } from 'vitest'
import {
  agentFleetStatus,
  agentLabel,
  candidateFromAvailability,
  SIGNED_OUT_HINT,
} from './agent-capability'

const harness = (kind: string, installed: boolean | null, state: 'in' | 'out' = 'in') => ({
  kind,
  installed,
  ...(installed === null
    ? { probeError: { reason: 'timed-out' as const, timeoutMs: 60_000 } }
    : {}),
  login: { state },
})

const host = (name: string, agents: ReturnType<typeof harness>[] | undefined, online = true) => ({
  id: name,
  name,
  online,
  ...(agents ? { inventory: { agents } } : {}),
})

describe('candidateFromAvailability', () => {
  it('reads the harness only after use and liveness, and each refusal keeps its own name', () => {
    const runnable = host('mine', [harness('cursor', true)])
    // The counterfactual first: this exact machine IS a valid candidate.
    expect(candidateFromAvailability(runnable, 'available', 'cursor').rejection).toBeUndefined()
    expect(candidateFromAvailability(runnable, 'unreachable', 'cursor').rejection).toBe('offline')
    expect(candidateFromAvailability(runnable, 'unauthorized', 'cursor').rejection).toBe(
      'unauthorized',
    )
    expect(
      candidateFromAvailability(host('mine', [harness('cursor', false)]), 'available', 'cursor')
        .rejection,
    ).toBe('harness-missing')
    // A harness absent from a REPORTED inventory is missing, not unknown.
    expect(
      candidateFromAvailability(host('mine', [harness('claude-code', true)]), 'available', 'cursor')
        .rejection,
    ).toBe('harness-missing')
  })

  /**
   * SINGLE-USER PARITY. A daemon publishes its inventory after connecting, and
   * legacy/fixture payloads carry none at all — so refusing on an ABSENT
   * inventory would grey every agent row on one healthy machine. This is the case
   * that separates "not probed" from "not installed"; if it ever flips, the
   * sidebar menu on a fresh daemon offers nothing.
   */
  it('treats an unprobed machine as unknowable rather than as empty', () => {
    expect(
      candidateFromAvailability(host('mine', undefined), 'available', 'cursor').rejection,
    ).toBeUndefined()
    // …but an inventory that exists and omits the harness still refuses, so this
    // leniency cannot be mistaken for "never refuse".
    expect(candidateFromAvailability(host('mine', []), 'available', 'cursor').rejection).toBe(
      'harness-missing',
    )
  })

  it('keeps an explicit probe timeout distinct and carries its retry detail', () => {
    const candidate = candidateFromAvailability(
      host('mine', [harness('cursor', null)]),
      'available',
      'cursor',
    )
    expect(candidate.rejection).toBe('harness-probe-timed-out')
    expect(candidate.probeDescription).toBe('timed out after 60s')
  })

  it('marks a logged-out harness as startable-with-a-warning, not as refused', () => {
    const candidate = candidateFromAvailability(
      host('mine', [harness('cursor', true, 'out')]),
      'available',
      'cursor',
    )
    expect(candidate.rejection).toBeUndefined()
    expect(candidate.loggedOut).toBe(true)
  })
})

describe('agentFleetStatus', () => {
  it('offers the agent when any host can run it', () => {
    const status = agentFleetStatus(
      [{ machineName: 'a', rejection: 'harness-missing' }, { machineName: 'b' }],
      'New Cursor',
    )
    expect(status.reason).toBeUndefined()
    expect(status.hint).toBeUndefined()
  })

  it('speaks one host’s own words when there is only one host', () => {
    const status = agentFleetStatus(
      [{ machineName: 'vmi34', rejection: 'harness-missing' }],
      'New Cursor',
    )
    expect(status.reason).toBe('Cursor is not installed on vmi34.')
    expect(status.hint).toBe('not installed')
  })

  it('states the bounded probe failure on a single-host row', () => {
    const status = agentFleetStatus(
      [
        {
          machineName: 'vmi34',
          rejection: 'harness-probe-timed-out',
          probeDescription: 'timed out after 60s',
        },
      ],
      'New Cursor',
    )
    expect(status.reason).toBe(
      'Couldn’t determine whether Cursor is installed on vmi34; probe timed out after 60s. Retry.',
    )
    expect(status.hint).toBe('probe timed out')
  })

  it('names the fix when several hosts are all missing the CLI', () => {
    const status = agentFleetStatus(
      [
        { machineName: 'a', rejection: 'harness-missing' },
        { machineName: 'b', rejection: 'harness-missing' },
      ],
      'New Cursor',
    )
    expect(status.reason).toContain('not installed')
    expect(status.hint).toBe('not installed')
  })

  /**
   * Readiness §3.1.4 M5: an unreachable host and an unauthorized one need
   * opposite responses from a person, so a summary must not pick one of them and
   * print it as if it were the whole answer.
   */
  it('refuses to speak for a mixed set of refusals', () => {
    const status = agentFleetStatus(
      [
        { machineName: 'asleep', rejection: 'offline' },
        { machineName: 'theirs', rejection: 'unauthorized' },
      ],
      'New Cursor',
    )
    expect(status.hint).toBe('no host')
    expect(status.reason).not.toContain('asleep')
    expect(status.reason).not.toContain('theirs')
  })

  it('warns without refusing when every host that could run it is signed out', () => {
    const status = agentFleetStatus([{ machineName: 'mine', loggedOut: true }], 'New Cursor')
    expect(status.reason).toBeUndefined()
    expect(status.warning).toContain('mine')
    // The hint column carries CONDITIONS as well as refusals (POD-1322): the row
    // stays clickable, and `signed out` is what it says instead of turning amber.
    expect(status.hint).toBe(SIGNED_OUT_HINT)
  })

  it('says "no host" when nothing is a candidate at all', () => {
    expect(agentFleetStatus([], 'New Cursor').hint).toBe('no host')
  })
})

describe('agentLabel', () => {
  it('recovers the harness name from either menu’s copy', () => {
    expect(agentLabel('New Claude')).toBe('Claude')
    expect(agentLabel('Claude Code (default)')).toBe('Claude Code')
    expect(agentLabel('Cursor')).toBe('Cursor')
  })
})
