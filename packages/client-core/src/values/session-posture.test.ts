import { describe, expect, it } from 'vitest'
import { postureNotices, sessionModeReadout } from './session-posture'

/**
 * WHAT A SESSION SAYS ABOUT ITS LAUNCH TERMS (POD-6858 Task 11,
 * harness-session-posture.md §4.9 and §5).
 *
 * One notice per requirement the launch could not meet, naming the harness
 * and the reason; and the mode shown is the one the harness reports, or the
 * one Podium asked for where the harness reports none.
 */
describe('postureNotices', () => {
  it('turns one unmet requirement into one notice with the exact words', () => {
    const notices = postureNotices({
      agentKind: 'pi',
      launchPosture: {
        requestedMode: null,
        unmet: [
          { requirement: 'autonomy', reason: 'Pi has no approval gate, so it cannot ask first' },
        ],
      },
    })
    expect(notices).toEqual([
      'Pi cannot run in the chosen mode here: Pi has no approval gate, so it cannot ask first',
    ])
  })

  it('names each of the five requirements in words', () => {
    const notices = postureNotices({
      agentKind: 'cursor',
      launchPosture: {
        requestedMode: null,
        unmet: [
          { requirement: 'workspace-trust', reason: 'r1' },
          { requirement: 'podium-cli', reason: 'r2' },
          { requirement: 'autonomy', reason: 'r3' },
          { requirement: 'quiet-start', reason: 'r4' },
          { requirement: 'podium-material', reason: 'r5' },
        ],
      },
    })
    expect(notices).toEqual([
      'Cursor cannot skip its folder trust question here: r1',
      'Cursor cannot run the Podium CLI without asking here: r2',
      'Cursor cannot run in the chosen mode here: r3',
      'Cursor cannot start without a menu here: r4',
      'Cursor cannot open chat attachments without asking here: r5',
    ])
  })

  it('says nothing for a session with no report or nothing unmet', () => {
    expect(postureNotices({ agentKind: 'claude-code' })).toEqual([])
    expect(
      postureNotices({
        agentKind: 'claude-code',
        launchPosture: { requestedMode: 'auto', unmet: [] },
      }),
    ).toEqual([])
  })
})

describe('sessionModeReadout', () => {
  it('shows the mode the harness reports over the one Podium asked for', () => {
    expect(
      sessionModeReadout({
        observedMode: 'default',
        launchPosture: { requestedMode: 'auto', unmet: [] },
      }),
    ).toEqual({ mode: 'default', source: 'observed' })
  })

  it('shows the requested mode where the harness reports none', () => {
    expect(sessionModeReadout({ launchPosture: { requestedMode: 'auto', unmet: [] } })).toEqual({
      mode: 'auto',
      source: 'requested',
    })
  })

  it('shows nothing when neither is known', () => {
    expect(sessionModeReadout({})).toBeUndefined()
    expect(
      sessionModeReadout({ launchPosture: { requestedMode: null, unmet: [] } }),
    ).toBeUndefined()
  })
})
