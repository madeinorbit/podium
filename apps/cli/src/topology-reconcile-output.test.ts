import { describe, expect, it } from 'vitest'
import { convergedObservation } from '@podium/runtime/topology-migration'
import type { ReconcileResult } from './topology-reconcile'
import { reconcileSentences } from './topology-reconcile-output'

function result(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return { actions: ['noop'], armed: 'new', observation: convergedObservation(), ...overrides }
}

describe('reconcileSentences', () => {
  it('explains the unfinished handover in action order with its recovery command and kill classification', () => {
    expect(reconcileSentences(result({
      actions: ['write-parent', 'enable-parent', 'mask-legacy', 'await-healthy'],
      armed: 'both',
      observation: { ...convergedObservation(), parentHealthy: false },
    }))).toEqual([
      'Wrote parent service podium.service.',
      'Enabled parent service podium.service for boot.',
      'Runtime-masked legacy services until reboot.',
      'Topology handover is unfinished: waiting for podium.service to report healthy before retiring legacy services.',
      "Run `systemctl --user start podium.service` to start the parent if needed; the handover finishes after its health gate, or on the parent's next boot once healthy.",
      'Armed if killed: both.',
    ])
  })

  it('uses the named instance parent for refresh, start, and recovery', () => {
    const sentences = reconcileSentences(result({
      actions: ['refresh-parent', 'start-parent', 'await-healthy'],
      observation: { ...convergedObservation('flatblock'), parentHealthy: false },
    }))
    expect(sentences[0]).toBe('Refreshed parent service podium-flatblock.service and reloaded systemd.')
    expect(sentences[1]).toBe('Started parent service podium-flatblock.service.')
    expect(sentences[3]).toContain('`systemctl --user start podium-flatblock.service`')
  })

  it('does not report an earlier health wait as unfinished after retirement', () => {
    expect(reconcileSentences(result({ actions: ['await-healthy', 'retire-legacy', 'noop'] }))).toEqual([
      'Stopped and removed legacy service units after the parent became healthy.',
      'Armed if killed: new.',
    ])
  })

  it('says nothing at all for a no-op, leaving the status block to speak', () => {
    expect(reconcileSentences(result())).toEqual([])
  })

  it('explains an aborted handover without suggesting another start', () => {
    expect(reconcileSentences(result({ actions: ['await-healthy', 'abort-keep-legacy'], armed: 'legacy' }))).toEqual([
      'The parent health wait expired; restored legacy services and disabled the parent service.',
      'Armed if killed: legacy.',
    ])
  })

  it('includes the problem reason and remedy even without actions', () => {
    expect(reconcileSentences(result({
      actions: [], armed: 'neither',
      problem: { ok: false, reason: 'No systemd user session.', remedy: 'Enable lingering and reconnect.' },
    }))).toEqual([
      'Problem: No systemd user session.',
      'Remedy: Enable lingering and reconnect.',
      'Armed if killed: neither.',
    ])
  })

  it('omits absent optional problem text, and then has nothing to report', () => {
    expect(reconcileSentences(result({ problem: { ok: false } }))).toEqual([])
  })

  it('still reports the kill classification whenever it changed anything', () => {
    expect(reconcileSentences(result({ actions: ['start-parent'], armed: 'both' })).at(-1)).toBe(
      'Armed if killed: both.',
    )
  })
})
