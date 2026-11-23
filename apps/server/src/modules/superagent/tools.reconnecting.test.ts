/**
 * MCP SHOWS RECONNECTING FROM THE SERVER'S OWN LINK (POD-6646, ADR 12 D1).
 *
 * `list_sessions` reports a running session as `reconnecting` while the server
 * has no daemon connection to its machine, and as its stored status otherwise.
 * The stored row never changes: it stays `live` throughout.
 */

import { asThreadId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { buildSuperagentTools } from './tools'

describe('MCP list_sessions while the machine link drops', () => {
  it('shows reconnecting from the server connection, and the row stays live', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      await attachHostDaemon(registry)
      const host = registry.sessionStore.hostMachineId
      const { sessionId } = await registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/p',
      })
      await registry.gateway.routeDaemonFrame(host, {
        type: 'bind',
        sessionId,
        cmd: 'claude',
        cwd: '/p',
        agentKind: 'claude-code',
        geometry: { cols: 80, rows: 24 },
      })
      const threadId = asThreadId('reconnecting-list')
      await store.superagent.upsertSuperagentThread({
        id: threadId,
        ownerUserId: await firstAdminMemberId(store),
        kind: 'global',
      })
      const listed = async () => {
        const tools = await buildSuperagentTools(
          { modules: registry.modules, store, repos: { list: async () => [] }, waitPollMs: 5 },
          '',
          threadId,
          { issueBelt: false },
        )
        const tool = tools.find((t) => t.spec.name === 'list_sessions')!
        const rows = JSON.parse(await tool.run({})) as { sessionId: string; status: string }[]
        return rows.find((r) => r.sessionId === sessionId)?.status
      }

      expect(await listed()).toBe('live')
      registry.gateway.detachDaemon(host)
      expect(await listed()).toBe('reconnecting')
      expect((await registry.modules.sessions.sessionById(sessionId))?.status).toBe('live')
    } finally {
      await registry.dispose()
    }
  })
})
