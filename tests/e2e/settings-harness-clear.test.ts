/** Real web save -> JSON HTTP -> settings router/service -> SQLite. No agent is launched. */
import { applySettingsPatch, readSettingsLeaf } from '@podium/commands'
import { asAccountId, firstAdminMemberId, settingsLeafPaths, type Capability, type UserId } from '@podium/model'
import { DEFAULT_SETTINGS, PodiumSettings, resolveRole } from '@podium/runtime'
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
      if (req.method === 'POST' && /^\/trpc\/settings\.update(Personal|Instance)$/.test(new URL(req.url).pathname)) {
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

describe('optional instance resets through the web save and HTTP transport', () => {
  const configured = {
    'transcripts.mirror': false,
    'deployment.authOpenMode': true,
    'deployment.updateChannel': 'dev',
    'deployment.connectEnabled': false,
    'deployment.telemetryUsage': 'off',
    'deployment.telemetryCrash': 'on',
    'deployment.telemetryInstallId': 'saved-install',
    'deployment.telemetrySince': 0,
  }
  const instanceClears = Object.fromEntries(Object.keys(configured).map((path) => [path, null]))
  const harnesses = Object.fromEntries(
    ['coding', 'superagent', 'background', 'shipwright'].map((role) => [`roles.${role}.harness`, 'codex']),
  )
  const nullableHibernation = {
    'hibernation.loadPerCore': null,
    'hibernation.maxIdleSessions': null,
    'hibernation.idleShellMinutes': null,
    'hibernation.backstopMinutes': null,
  }

  it('audits every settings leaf omitted by DEFAULT_SETTINGS', () => {
    expect(settingsLeafPaths(PodiumSettings)
      .filter((path) => readSettingsLeaf(DEFAULT_SETTINGS, path) === undefined).sort()).toEqual([
      ...Object.keys(configured), ...Object.keys(harnesses),
    ].sort())
  })

  it('resetting all omitted optional leaves clears persisted preferences and settings still load',
    async () => withSettingsHttp(async ({ client, store, user, patches }) => {
      await client.settings.updatePersonal.mutate({ values: harnesses })
      const previous = await client.settings.updateInstance.mutate({ values: {
        ...configured, ...nullableHibernation,
      } })
      for (const [path, value] of Object.entries(configured)) {
        expect(readSettingsLeaf(previous, path)).toBe(value)
        expect(readSettingsLeaf(await store.settings.getSettings(), path)).toBe(value)
      }
      patches.length = 0

      // SettingsView's Reset everything action patches this same default object.
      const result = await saveSettingsAsCommands(client, previous, DEFAULT_SETTINGS, { online: true })
      expect(result.refusals).toEqual([])
      const received = Object.assign({}, ...patches)
      expect(patches).toHaveLength(2)
      expect(received).toEqual({
        ...instanceClears,
        ...Object.fromEntries(Object.keys(harnesses).map((path) => [path, null])),
        ...Object.fromEntries(Object.keys(nullableHibernation)
          .map((path) => [path, readSettingsLeaf(DEFAULT_SETTINGS, path)])),
      })
      expect(result.saved).toEqual(DEFAULT_SETTINGS)
      expect(await client.settings.get.query()).toEqual(DEFAULT_SETTINGS)
      expect(await store.settings.getSettings()).toEqual(DEFAULT_SETTINGS)
      for (const path of Object.keys(harnesses)) {
        expect(await store.settings.userPreferences.keysFor(user)).not.toContain(path)
      }
      for (const path of Object.keys(configured)) {
        expect(await store.settings.getSettings()).not.toHaveProperty(path)
      }

      patches.length = 0
      await saveSettingsAsCommands(client, result.saved, DEFAULT_SETTINGS, { online: true })
      expect(patches).toEqual([])
    }),
  )

  it('clears a transcript preference beside meaningful nulls and leaves omitted patch keys unchanged',
    async () => withSettingsHttp(async ({ client, store, patches }) => {
      const previous = await client.settings.updateInstance.mutate({ values: configured })
      patches.length = 0
      const next = applySettingsPatch(previous, { 'transcripts.mirror': undefined, ...nullableHibernation })
      const result = await saveSettingsAsCommands(client, previous, next, { online: true })
      expect(result.refusals).toEqual([])
      expect(patches).toEqual([{ 'transcripts.mirror': null, ...nullableHibernation }])
      for (const settings of [result.saved, await client.settings.get.query(), await store.settings.getSettings()]) {
        expect(settings).not.toHaveProperty('transcripts.mirror')
        expect(settings.deployment).toEqual(previous.deployment)
        for (const path of Object.keys(nullableHibernation)) {
          expect(readSettingsLeaf(settings, path)).toBeNull()
        }
      }
    }),
  )
})
