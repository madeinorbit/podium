/** Real web save -> JSON HTTP -> settings router/service -> SQLite. No agent is launched. */
import { asAccountId, firstAdminMemberId, type Capability, type UserId } from '@podium/model'
import { DEFAULT_SETTINGS, resolveRole } from '@podium/runtime'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { makeTrpc } from '../../apps/web/src/app/trpc'
import { saveSettingsAsCommands } from '../../apps/web/src/features/settings/save-settings'
import { resolvePrincipal } from '../../apps/server/src/command-principal'
import { PairingManager } from '../../apps/server/src/hub/pairing'
import { SuperagentService } from '../../apps/server/src/modules/superagent'
import { SessionRegistry } from '../../apps/server/src/relay'
import { RepoRegistry } from '../../apps/server/src/repo-registry'
import { appRouter } from '../../apps/server/src/router'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'

async function withSettingsHttp(run: (fixture: {
  client: ReturnType<typeof makeTrpc>
  store: Awaited<ReturnType<typeof openTestStore>>
  user: UserId
  patches: Record<string, unknown>[]
}) => Promise<void>): Promise<void> {
  const store = await openTestStore(':memory:')
  const user = await firstAdminMemberId(store)
  const capability: Capability = {
    role: 'admin', scope: { kind: 'all' }, actorUser: user, onBehalfOf: user,
  }
  const registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default', pairing: new PairingManager(),
  })
  const repos = new RepoRegistry(registry, store)
  const superagent = await SuperagentService.create(registry.modules, repos, store)
  const patches: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (req.method === 'POST' && new URL(req.url).pathname === '/trpc/settings.updatePersonal') {
        const batch = await req.clone().json() as Record<string, { values: Record<string, unknown> }>
        for (const input of Object.values(batch)) patches.push(input.values)
      }
      return fetchRequestHandler({
        endpoint: '/trpc', router: appRouter, req,
        createContext: () => ({
          registry, repos, superagent, capability,
          principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
        }),
      })
    },
  })
  try {
    await run({ client: makeTrpc(`http://127.0.0.1:${server.port}`, { report: false }), store, user, patches })
  } finally {
    server.stop(true)
    superagent.dispose()
    await registry.dispose()
    await store.close()
  }
}

describe('harness clears through the web save and HTTP transport', () => {
  it.each(['coding', 'background'] as const)(
    'switching %s from managed to native deletes the saved harness and resolves the native role',
    async (role) => withSettingsHttp(async ({ client, store, user, patches }) => {
      const path = `roles.${role}.harness`
      const previous = await client.settings.updatePersonal.mutate({ values: {
        [`roles.${role}.accountId`]: asAccountId('managed:anthropic'),
        [`roles.${role}.model`]: 'managed-model',
        [`roles.${role}.effort`]: 'high',
        [path]: 'claude-code',
      } })
      expect(await store.settings.userPreferences.keysFor(user)).toContain(path)
      patches.length = 0

      const next = {
        ...previous,
        roles: { ...previous.roles, [role]: {
          ...previous.roles[role], accountId: asAccountId('native:codex'),
          model: 'auto', effort: 'auto', harness: undefined,
        } },
      }
      const result = await saveSettingsAsCommands(client, previous, next, { online: true })
      expect(result.refusals).toEqual([])
      expect(patches).toEqual([{
        [`roles.${role}.accountId`]: 'native:codex', [path]: null,
        [`roles.${role}.model`]: 'auto', [`roles.${role}.effort`]: 'auto',
      }])
      expect(result.saved.roles[role]).not.toHaveProperty('harness')
      expect(await store.settings.userPreferences.keysFor(user)).not.toContain(path)

      // A fresh HTTP load and the server's next launch settings read both succeed.
      const loaded = await client.settings.get.query()
      expect(loaded.roles[role]).toEqual(result.saved.roles[role])
      const launchSettings = await store.settings.getSettingsFor(user)
      expect(resolveRole(launchSettings, role)).toMatchObject({
        accountId: 'native:codex', harness: 'codex',
        execution: role === 'background' ? 'api' : 'harness',
      })
    }),
  )

  it('resetting to defaults removes the superagent harness preference and settings still load',
    async () => withSettingsHttp(async ({ client, store, user, patches }) => {
      const path = 'roles.superagent.harness'
      const previous = await client.settings.updatePersonal.mutate({ values: { [path]: 'codex' } })
      expect(previous.roles.superagent.harness).toBe('codex')
      expect(DEFAULT_SETTINGS.roles.superagent).not.toHaveProperty('harness')
      patches.length = 0

      // SettingsView's reset action patches DEFAULT_SETTINGS into the edit form.
      const result = await saveSettingsAsCommands(client, previous, DEFAULT_SETTINGS, { online: true })
      expect(result.refusals).toEqual([])
      expect(patches).toEqual([{ [path]: null }])
      expect(await store.settings.userPreferences.keysFor(user)).not.toContain(path)
      expect(result.saved.roles.superagent).not.toHaveProperty('harness')
      expect((await client.settings.get.query()).roles.superagent).toEqual(DEFAULT_SETTINGS.roles.superagent)
    }),
  )
})
