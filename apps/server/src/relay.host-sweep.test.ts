import { asMachineId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

// POD-4657: the per-host-sample sweep must stay O(live), not O(retained).
// The session map holds every retained row (hibernated/exited/starting
// included) while every sweep consumer filters `status === 'live'` first, so
// the projection drops non-live rows before building views. This test pins
// the behavior that filter exists for: a live shell past the backstop is
// still reaped when it is outnumbered hundreds-to-one by dormant rows.
describe('host sweep over dormant rows', () => {
  it('reaps a backstop-quiet live shell among dormant sessions', async () => {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      await attachHostDaemon(reg, (message) => daemon.push(message))
      await store.settings.setSettings({
        ...(await store.settings.getSettings()),
        hibernation: {
          enabled: true,
          memoryPct: 80,
          loadPerCore: null,
          maxIdleSessions: null,
          idleMinutes: 30,
          idleShellMinutes: null,
          backstopMinutes: 60,
        },
      })
      const DORMANT = 200
      let liveId: SessionId | undefined
      for (let i = 0; i < DORMANT; i++) {
        const { sessionId } = await reg.modules.sessions.createSession({
          agentKind: 'shell',
          cwd: `/w${i}`,
          machineId: store.hostMachineId,
        })
        if (i === 0) liveId = sessionId
      }
      if (!liveId) throw new Error('no session created')
      // Only the first session binds: it alone is live, the rest stay
      // `starting` — dormant rows the sweep must skip.
      await reg.gateway.routeDaemonFrame(asMachineId(store.hostMachineId), {
        type: 'bind',
        sessionId: liveId,
        cmd: 'sh',
        cwd: '/w0',
        agentKind: 'shell',
        geometry: { cols: 80, rows: 24 },
      } as never)
      // Backstop-quiet: stamps 61 minutes old against a 60-minute backstop.
      const oldMs = Date.now() - 61 * 60_000
      const oldIso = new Date(oldMs).toISOString()
      const sessions = (
        reg.modules.sessions as unknown as {
          sessions: Map<SessionId, { lastActiveAt: string; terminal: Record<string, number> }>
        }
      ).sessions
      const live = sessions.get(liveId)
      if (!live) throw new Error('live session missing from map')
      live.lastActiveAt = oldIso
      live.terminal.resumedAtMs_ = oldMs
      live.terminal.inputAtMs_ = oldMs
      live.terminal.outputAtMs_ = oldMs

      await reg.modules.hosts.onHostMetrics(store.hostMachineId, {
        hostname: 'test',
        sampledAt: new Date().toISOString(),
        memory: {
          totalBytes: 8_000_000_000,
          availableBytes: 4_000_000_000,
          swapTotalBytes: 0,
          swapFreeBytes: 0,
        },
        load: { one: 1.0, five: 1.0, fifteen: 1.0, cpuCount: 8 },
      })

      // The backstop reaps the live shell (durable tombstone first), while the
      // dormant crowd is untouched: still listed, never a kill target.
      await expect
        .poll(async () => (await store.sessions.loadSessions()).some((s) => s.id === liveId))
        .toBe(false)
      const remaining = await store.sessions.loadSessions()
      expect(remaining).toHaveLength(DORMANT - 1)
      expect(
        daemon.filter((m) => m.type === 'kill' && (m as { sessionId?: unknown }).sessionId !== liveId),
      ).toEqual([])
    } finally {
      await reg.dispose()
    }
  })
})
