import { asAccountId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type HarnessCandidate,
  pickSuperagentDefault,
  SUPERAGENT_HARNESS_DEFAULTS,
  SUPERAGENT_HARNESS_PRIORITY,
  superagentBackendIsUnset,
  superagentDefaultFor,
} from './harness-defaults'
import { normalizeSettings } from './settings'

const candidate = (
  harness: HarnessCandidate['harness'],
  state: 'logged-in' | 'installed' | 'absent',
): HarnessCandidate => ({
  harness,
  installed: state !== 'absent',
  loggedIn: state === 'logged-in',
})

describe('superagent harness priority', () => {
  it('prefers codex, then grok, then claude', () => {
    expect(SUPERAGENT_HARNESS_PRIORITY).toEqual(['codex', 'grok', 'claude-code'])
  })

  it('picks the highest-priority logged-in harness', () => {
    const pick = pickSuperagentDefault([
      candidate('claude-code', 'logged-in'),
      candidate('grok', 'logged-in'),
      candidate('codex', 'logged-in'),
    ])
    expect(pick).toEqual({
      accountId: 'native:codex',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'max',
    })
  })

  it('falls to grok when codex is absent, and to claude when neither is there', () => {
    expect(
      pickSuperagentDefault([
        candidate('grok', 'logged-in'),
        candidate('claude-code', 'logged-in'),
      ]),
    ).toMatchObject({ harness: 'grok', model: 'grok-4.6', effort: 'medium' })
    expect(pickSuperagentDefault([candidate('claude-code', 'logged-in')])).toMatchObject({
      harness: 'claude-code',
      model: 'opus',
      effort: 'medium',
    })
  })

  // The pass order is the whole point: a logged-out codex must not beat a grok
  // that is demonstrably ready, but it must still beat nothing at all.
  it('ranks a ready lower-priority harness above a logged-out higher-priority one', () => {
    expect(
      pickSuperagentDefault([candidate('codex', 'installed'), candidate('grok', 'logged-in')]),
    ).toMatchObject({ harness: 'grok' })
  })

  it('still settles for installed-but-logged-out when nothing is ready', () => {
    expect(
      pickSuperagentDefault([candidate('codex', 'installed'), candidate('grok', 'installed')]),
    ).toMatchObject({ harness: 'codex' })
  })

  it('picks nothing when the fleet carries no harness it would choose', () => {
    expect(pickSuperagentDefault([])).toBeUndefined()
    expect(
      pickSuperagentDefault([candidate('codex', 'absent'), candidate('grok', 'absent')]),
    ).toBeUndefined()
  })

  // opencode/cursor are omitted from the priority list on purpose; a table entry
  // exists for every harness so adding one to the list cannot compile un-answered.
  it('never picks a harness outside the priority list', () => {
    expect(pickSuperagentDefault([candidate('opencode', 'logged-in')])).toBeUndefined()
    expect(SUPERAGENT_HARNESS_DEFAULTS.opencode).toEqual({ model: 'auto', effort: 'auto' })
  })

  it('names the native account of the harness it picked', () => {
    expect(superagentDefaultFor('grok').accountId).toBe('native:grok')
  })
})

describe('superagentBackendIsUnset', () => {
  it('is true only for a backend nobody has chosen', () => {
    const roles = normalizeSettings({}).roles
    expect(superagentBackendIsUnset(roles.superagent)).toBe(true)
    expect(
      superagentBackendIsUnset({ ...roles.superagent, accountId: asAccountId('native:grok') }),
    ).toBe(false)
    expect(superagentBackendIsUnset({ ...roles.superagent, harness: 'grok' })).toBe(false)
    // A model alone is not an account choice — the seeder decides that leaf
    // separately, so this predicate must not report it as "chosen".
    expect(superagentBackendIsUnset({ ...roles.superagent, model: 'opus' })).toBe(true)
  })
})
