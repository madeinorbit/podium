/**
 * NO SERVER PATH WRITES `reconnecting` (POD-6646, ADR 12 D1).
 *
 * The type system refuses it as a session status; this pins the rest. A drop
 * of the daemon link changes no session row: the row stays `live`, the
 * session is only marked (server-side) as awaiting its rebind, and readers show
 * "reconnecting" from the machine's link. The source scan keeps the literal out
 * of every server write path; the one display word left (the chat bridge's) is
 * listed, as is the migration that retires stored values.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'

const SERVER_SRC = join(import.meta.dirname, '..', '..')

/** Where the quoted word may appear outside tests, and why. */
const ALLOWED = new Set([
  // The migration that rewrites stored values to `live`, and its bundled copy.
  'migrations/drizzle-manifest.generated.ts',
  // The chat bridge's display word, derived from the machine's link.
  'modules/messaging/session-attachment.ts',
])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('reconnecting is not stored', () => {
  it('appears quoted in no server source outside its listed display and migration', () => {
    const found = sources(SERVER_SRC)
      .filter((path) => /['"]reconnecting['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SERVER_SRC, path))
      .filter((path) => !ALLOWED.has(path))
    expect(found).toEqual([])
  })

  it('a daemon drop leaves the row live and marks it awaiting a rebind; the bind clears it', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      await attachHostDaemon(registry)
      const host = registry.sessionStore.hostMachineId
      const { sessionId } = await registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      const bind = {
        type: 'bind' as const,
        sessionId,
        cmd: 'claude',
        cwd: '/p',
        agentKind: 'claude-code' as const,
        geometry: { cols: 80, rows: 24 },
      }
      await registry.gateway.routeDaemonFrame(host, bind)
      const session = registry.modules.sessions.sessions.get(sessionId)!
      expect(session.awaitingRebind).toBe(false)

      registry.gateway.detachDaemon(host)
      await registry.modules.sessions.flushActivity()
      expect(session.status).toBe('live')
      expect(session.awaitingRebind).toBe(true)
      expect((await store.sessions.getSession(sessionId))?.status).toBe('live')

      // The next daemon is asked to reattach exactly this session, and its bind
      // clears the mark.
      const sent: { type: string; sessionId?: string }[] = []
      await attachHostDaemon(registry, (m) => sent.push(m as { type: string; sessionId?: string }))
      expect(sent.some((m) => m.type === 'reattach' && m.sessionId === sessionId)).toBe(true)
      await registry.gateway.routeDaemonFrame(host, bind)
      expect(session.awaitingRebind).toBe(false)
      expect(session.status).toBe('live')
    } finally {
      await registry.dispose()
    }
  })
})
