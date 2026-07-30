import { describe, expect, it } from 'vitest'
import { toIssueTreeSession } from './session-read'

/**
 * These pin the KEY SET `toIssueTreeSession` emits, not its values.
 *
 * The mapper replaced a conditional-spread literal in
 * `apps/server/src/modules/issues/service/reads.ts`
 * (`...(label ? { label } : {})`, one arm per optional key). That idiom drops a
 * key when its value is FALSY; a mapper that dropped only `undefined` would
 * start emitting `label: ''` where the old producer emitted nothing. The
 * difference is invisible to a values-only assertion and survives JSON, so it is
 * asserted on `Object.keys` here (POD-366).
 */
describe('toIssueTreeSession key set', () => {
  const required = { sessionId: 's1', agentKind: 'claude-code', status: 'live' }

  it('omits every optional key when the source carries none', () => {
    expect(Object.keys(toIssueTreeSession(required)).sort()).toEqual([
      'agentKind',
      'sessionId',
      'status',
    ])
  })

  it('omits an optional key whose value is the empty string, not just undefined', () => {
    // The whole reason this test exists: '' must be ABSENT, matching the retired
    // `...(x ? { x } : {})` producer, rather than present-and-empty.
    const out = toIssueTreeSession({ ...required, displayRef: '', model: '', name: '' })
    expect(Object.keys(out).sort()).toEqual(['agentKind', 'sessionId', 'status'])
  })

  it('keeps optional keys that carry a value', () => {
    const out = toIssueTreeSession({
      ...required,
      displayRef: 'POD-366-A',
      model: 'claude-opus-5',
      name: 'named',
      agentState: { phase: 'working' },
      coordinator: true,
    })
    expect(out).toEqual({
      sessionId: 's1',
      agentKind: 'claude-code',
      status: 'live',
      displayRef: 'POD-366-A',
      model: 'claude-opus-5',
      label: 'named',
      phase: 'working',
      coordinator: true,
    })
  })

  it('drops coordinator when false rather than emitting it', () => {
    // The retired producer only ever ADDED `coordinator: true`; `false` never
    // appeared on the wire. A fixture with `true` in it would not show this, so
    // the counterfactual is the point: same call shape, coordinator false.
    expect('coordinator' in toIssueTreeSession({ ...required, coordinator: false })).toBe(false)
    expect('coordinator' in toIssueTreeSession({ ...required, coordinator: true })).toBe(true)
  })

  describe('label flattening picks the same branch as the retired producer', () => {
    it('prefers name over title', () => {
      expect(toIssueTreeSession({ ...required, name: 'n', title: 't' }).label).toBe('n')
    })

    it('falls back to title when name is absent', () => {
      expect(toIssueTreeSession({ ...required, title: 't' }).label).toBe('t')
    })

    it('ignores a title that merely repeats the harness name', () => {
      expect(toIssueTreeSession({ ...required, title: 'claude-code' }).label).toBeUndefined()
    })

    it('does NOT fall through to title when name is the empty string', () => {
      // `??` semantics: '' is not nullish, so it wins and is then dropped as
      // falsy. `||` would have emitted label: 't' here — a real behaviour change
      // the empty-string case is the only witness to.
      const out = toIssueTreeSession({ ...required, name: '', title: 't' })
      expect('label' in out).toBe(false)
    })
  })
})
