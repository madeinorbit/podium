/**
 * WHAT A ROLLED-BACK SPAN INSTALLED ON A LIVE SESSION IS PUT BACK (POD-6160 D2f).
 *
 * A persist inside an enclosing span installs its draft on the live `Session`
 * at once (code later in the span reads it), while its baseline waits for the
 * outermost commit. When the enclosing span rolls back, the row keeps the old
 * value and, before this repair, the live object kept the new one: every
 * reader saw a value no commit kept, and the next unrelated persist wrote it
 * back to the row. The repository now puts those fields back from the committed
 * baseline the next time the session is drafted, persisted or read for
 * someone outside the span (`repository.repairRolledBack`).
 */
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  await attachHostDaemon(reg)
  const sessions = reg.modules.sessions
  const { sessionId } = await sessions.createSession({ agentKind: 'shell', cwd: '/x' })
  await sessions.renameSession({ sessionId, name: 'committed' })
  await sessions.flushActivity()
  return { store, reg, sessions, sessionId }
}

async function rowName(store: SessionStore, sessionId: SessionId) {
  return (await store.sessions.getSession(sessionId))?.name
}

async function renameInRolledBackSpan(f: Awaited<ReturnType<typeof fixture>>, name = 'rolled back') {
  await expect(
    f.store.transact(async () => {
      await f.sessions.renameSession({ sessionId: f.sessionId, name })
      // Inside the span the write is visible to the span's own code.
      expect(f.sessions.sessions.get(f.sessionId)?.name).toBe(name)
      throw new Error('enclosing span failed')
    }),
  ).rejects.toThrow('enclosing span failed')
}

describe('a rolled-back span on a live session (POD-6160 D2f)', () => {
  it('is never written back by a later unrelated persist', async () => {
    const f = await fixture()
    await renameInRolledBackSpan(f)
    expect(await rowName(f.store, f.sessionId)).toBe('committed')
    await f.sessions.setWorkState({ sessionId: f.sessionId, workState: 'done' } as never)
    await f.sessions.flushActivity()
    const row = await f.store.sessions.getSession(f.sessionId)
    expect(row?.workState).toBe('done')
    expect(row?.name).toBe('committed')
  })

  it('is not what the next view read, records read or publication shows', async () => {
    const f = await fixture()
    const published: string[] = []
    f.sessions.onSessionProjection((event) => published.push(JSON.stringify(event.changes)))
    await renameInRolledBackSpan(f)
    expect((await f.sessions.sessionById(f.sessionId))?.name).toBe('committed')
    expect((await f.sessions.records.resolve([f.sessionId])).get(f.sessionId)?.name).toBe('committed')
    expect((await f.sessions.readSessionFactsById(f.sessionId))?.name).toBe('committed')
    // The next publication of this session restates the committed name.
    published.length = 0
    await f.sessions.setWorkState({ sessionId: f.sessionId, workState: 'done' } as never)
    expect(published.join('\n')).toContain('"committed"')
    expect(published.join('\n')).not.toContain('rolled back')
    expect(f.sessions.sessions.get(f.sessionId)?.name).toBe('committed')
  })

  it('keeps a volatile field that changed after the rolled-back install', async () => {
    const f = await fixture()
    const session = f.sessions.sessions.get(f.sessionId)!
    const machine = session.machineId
    const moved = 'machine-moved' as typeof machine
    await expect(
      f.store.transact(async () => {
        await f.sessions.repository.write(session, (draft) => {
          draft.name = 'rolled back'
          draft.machineId = 'machine-in-span' as typeof machine
        })
        // A volatile change lands after the install, inside the window.
        session.machineId = moved
        f.sessions.repository.markVolatileSessionDirty(f.sessionId, ['machineId'])
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')
    expect(session.toMeta().name).toBe('committed')
    expect(session.machineId).toBe(moved)
  })

  it('keeps what an enclosing span that commits installed', async () => {
    const f = await fixture()
    await f.store.transact(async () => {
      await f.sessions.renameSession({ sessionId: f.sessionId, name: 'kept' })
    })
    expect((await f.sessions.sessionById(f.sessionId))?.name).toBe('kept')
    expect(await rowName(f.store, f.sessionId)).toBe('kept')
  })
})
