import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { serverDriverAdoptionCandidates } from '../control/session'
import { grokAcpVersionProbe, resetGrokAcpVersionProbe } from './grok-acp-server'
import { availableDriverIds } from './registry'

afterEach(() => resetGrokAcpVersionProbe())

describe('Grok ACP daemon gate', () => {
  it('admits a supported binary into driver selection', () => {
    expect(grokAcpVersionProbe(() => ({ ok: true, output: 'grok 1.0.3' }))).toEqual({
      drivable: true,
    })
    expect(availableDriverIds({ opencodeDrivable: false, grokDrivable: true })).toContain(
      'grok-acp',
    )
  })

  it('does not memoize an unprobeable result', () => {
    let calls = 0
    const first = grokAcpVersionProbe(() => {
      calls += 1
      return { ok: false, output: 'timed out' }
    })
    const second = grokAcpVersionProbe(() => {
      calls += 1
      return { ok: true, output: 'grok 0.2.118' }
    })
    expect(first).toMatchObject({ drivable: false, reason: 'unprobeable' })
    expect(second).toEqual({ drivable: true })
    expect(calls).toBe(2)
  })

  it('memoizes a definitive unsupported version', () => {
    let calls = 0
    const probe = () => {
      calls += 1
      return { ok: true, output: 'grok 0.2.22' }
    }
    expect(grokAcpVersionProbe(probe)).toMatchObject({
      drivable: false,
      reason: 'unsupported',
    })
    expect(grokAcpVersionProbe(probe)).toMatchObject({ reason: 'unsupported' })
    expect(calls).toBe(1)
  })
})

describe('server restart adoption registry', () => {
  it('pins every shipped server runtime, including Grok ACP', () => {
    const opencodeRuntime = { marker: 'opencode' }
    const codexRuntime = { marker: 'codex' }
    const grokRuntime = { marker: 'grok' }
    const ctx = {
      opencodeRuntime,
      codexRuntime,
      grokRuntime,
    } as unknown as DaemonContext
    expect(
      serverDriverAdoptionCandidates(ctx).map(({ runtime, what }) => ({
        marker: (runtime as unknown as { marker: string }).marker,
        what,
      })),
    ).toEqual([
      { marker: 'opencode', what: 'opencode serve' },
      { marker: 'codex', what: 'codex app-server' },
      { marker: 'grok', what: 'grok agent stdio' },
    ])
  })
})
