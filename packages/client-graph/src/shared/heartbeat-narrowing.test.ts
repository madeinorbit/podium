import { expect, it } from 'vitest'
import { createRelationIndex } from './relation-index'
import { collapseIds, SCHEMA } from './schema'
import { createSessionQuestions } from './session-questions'

it.each([1, 4])('matches rebuilt resume winners and order through group transitions at %sx', scale => {
  const index = createRelationIndex(SCHEMA)
  const rows = new Map<string, Record<string, unknown>>()
  const row = (status: string, conversationId = 'group', patch: object = {}) => ({
    resume: { kind: 'codex', conversationId }, status, lastActiveAt: '2026-10-01', ...patch,
  })
  const change = (id: string, next?: Record<string, unknown>) => {
    const existed = rows.has(id)
    if (next) rows.set(id, next)
    else rows.delete(id)
    index.begin(); index.changed('session', id, existed, next); index.flush()
    const rebuilt = collapseIds(SCHEMA.session.collapse, [...rows].map(([id, row]) => ({ id, row })))
    for (const member of rows.keys()) expect(index.collapsed('session', member)).toBe(rebuilt.has(member))
    // Rebuilding the old resolver also checks the first-member winner position.
    const groups = new Map<string, string[]>()
    for (const [member, value] of rows) {
      const key = SCHEMA.session.collapse!.groupKey(value)
      if (key) groups.set(key, [...(groups.get(key) ?? []), member])
    }
    for (const members of groups.values()) {
      const first = [...members].sort()[0]!
      for (const member of members) expect(index.orderKey('session', member)).toBe(
        members.some(id => rebuilt.has(id)) && !rebuilt.has(member) ? first : member,
      )
    }
  }
  for (let i = 0; i < 32 * scale; i++) change(`history-${i}`, row('exited'))
  change('active', row('live'))
  change('active', row('live', 'group', { lastActiveAt: '2026-10-09' }))
  change('history-0', row('exited', 'group', { lastActiveAt: '2026-10-10' }))
  change('second-active', row('live'))
  change('active', row('exited'))
  change('second-active', row('hibernated'))
  change('history-0', row('hibernated', 'group', { lastActiveAt: '2026-10-11' }))
  change('history-0', row('exited', 'other'))
  change('active', row('live', 'other'))
  change('second-active', row('live', 'other'))
  change('active', row('live', 'other', { headless: true }))
  change('second-active')
  change('history-0')
  index.clear()
  change('fresh', row('exited'))
})

it('matches rebuilt cwd activity and presence when paths, kind, and visibility change', () => {
  const rows = new Map<string, Record<string, unknown>>()
  const hidden = new Set<string>()
  const index = createSessionQuestions(id => hidden.has(id))
  const check = () => {
    const old = createSessionQuestions(id => hidden.has(id))
    old.replace(rows)
    for (const root of ['/repo', '/repo/nested', '/other', 'C:\\repo', 'C:\\repo\\nested'])
      for (const match of ['within', 'exact'] as const)
        for (const agentsOnly of [true, false]) {
          const q = { roots: [root], match, agentsOnly }
          expect(index.activity(q)).toBe(old.activity(q))
          expect(index.hasWithin(root)).toBe(old.hasWithin(root))
        }
  }
  const change = (id: string, patch: object) => {
    const next = { ...rows.get(id), ...patch }
    rows.set(id, next); index.set(id, next); check()
  }
  change('a', { cwd: '/repo/nested', agentKind: 'codex', lastActiveAt: '2026-10-01' })
  change('a', { lastActiveAt: '2026-10-09' })
  change('b', { cwd: '/repo', agentKind: 'codex', lastActiveAt: '2026-10-08' })
  change('a', { agentKind: 'shell' })
  change('a', { cwd: '/other' })
  change('a', { cwd: 'C:\\repo\\nested', agentKind: 'codex' })
  hidden.add('a'); index.visibilityChanged('a'); check()
  hidden.delete('a'); index.visibilityChanged('a'); check()
  rows.delete('a'); index.set('a', undefined); check()
})
