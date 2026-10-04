import { describe, expect, it } from 'vitest'
import baseline from '../../../docs/measurements/click-speed-baseline.json'
import { promoteSpeedBaseline } from '../harness/speed-baseline'

describe('speed baseline promotion', () => {
  it('preserves a separately captured action and its provenance during a five-action promotion', () => {
    const saved = structuredClone(baseline)
    const report = {
      sourceSha: 'new-green-source',
      actions: {
        'sidebar-issue': { medianMs: 101, worstMs: 111 },
        'mission-switch': { medianMs: 102, worstMs: 112 },
        'session-pane': { medianMs: 103, worstMs: 113 },
        'issue-rename': { medianMs: 104, worstMs: 114 },
        'background-update': { medianMs: 105, worstMs: 115 },
      },
      targets: { ...saved.targets, rename: 'new-target' },
    }

    const promoted = promoteSpeedBaseline(saved, report)
    expect(promoted).toEqual({
      ...saved,
      sourceSha: report.sourceSha,
      targets: report.targets,
      actions: { ...report.actions, 'issue-page-open': saved.actions['issue-page-open'] },
    })
    expect(promoted.actions['issue-page-open']).toEqual({ medianMs: 538.107, worstMs: 814.717 })
    expect(promoted.issuePageOpening).toEqual(saved.issuePageOpening)
    expect(saved).toEqual(baseline)
  })
})
