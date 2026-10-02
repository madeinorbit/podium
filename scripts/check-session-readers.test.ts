import { describe, expect, it } from 'vitest'
import { checkSessionReaders, legacySessionReads } from './check-session-readers'

describe('session reader lint boundary', () => {
  it('keeps production web, shared view models and graph readers behind SessionView', () =>
    expect(checkSessionReaders()).toEqual([]))
  it.each([
    "import type { SessionMeta } from '@podium/model'",
    "import { type SessionMeta as Raw } from '@podium/model/browser'",
    "const session = store.replica.row('sessions', id)",
    "store.replica.rows('sessions').map(s => s.displayRef)",
    '(row as SessionMeta).unread',
    "(row as SessionMeta)['snoozedUntil']",
  ])('rejects a planted raw reader: %s', (source) =>
    expect(legacySessionReads(source)).not.toEqual([]))
  it('accepts the shared view, logical pool rows and unrelated entity cells', () => {
    expect(
      legacySessionReads(
        "import type { SessionView } from '@podium/client-core/session-values'; pool.row('session', id); issue.readAt; machine.name",
      ),
    ).toEqual([])
  })
  it('allows only the single fallback module to read raw legacy cells', () => {
    const source = '(row as SessionMeta).readAt'
    expect(legacySessionReads(source, 'packages/client-core/src/session-values.ts')).toEqual([])
    expect(legacySessionReads(source, 'packages/client-core/src/engine/overlay.ts')).not.toEqual([])
  })
})
