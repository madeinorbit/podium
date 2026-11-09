/**
 * Real web save -> JSON HTTP -> sync.submit (the two preference records' edits,
 * POD-6673 and POD-6677) -> settings service -> SQLite. No agent is launched.
 *
 * The settings screen saves both preference tiers as generic edits: my
 * `userPreferences` record and the instance's `instancePreferences` record. The
 * outbox queues them in the app; here they are submitted over HTTP at once, which
 * is what the outbox's drain sends. There is no settings READ over HTTP any more
 * (the records reach an app on the feed), so a read here is the store's.
 */
import { applySettingsPatch, readSettingsLeaf } from '@podium/commands'
import {
  asAccountId,
  type Capability,
  firstAdminMemberId,
  INSTANCE_PREFERENCES_ROW_ID,
  settingsLeafPaths,
  type UserId,
  userPreferencesRowId,
} from '@podium/model'
import { DEFAULT_SETTINGS, PodiumSettings, resolveRole } from '@podium/runtime'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { resolvePrincipal } from '../../apps/server/src/command-principal'
import { PairingManager } from '../../apps/server/src/hub/pairing'
import { SuperagentService } from '../../apps/server/src/modules/superagent'
import { SessionRegistry } from '../../apps/server/src/relay'
import { RepoRegistry } from '../../apps/server/src/repo-registry'
import { appRouter } from '../../apps/server/src/router'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'
import { makeTrpc } from '../../apps/web/src/app/trpc'
import { saveSettingsAsCommands } from '../../apps/web/src/features/settings/save-settings'

type Client = ReturnType<typeof makeTrpc>
type Values = Readonly<Record<string, unknown>>

/** One record edit over HTTP, as the outbox drain sends it: a leaf set to
 *  `undefined` is a reset (`unset`). */
async function submitEdit(
  client: Client,
  command: string,
  id: string,
  values: Values,
): Promise<void> {
  const patch: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [path, value] of Object.entries(values)) {
    if (value === undefined) unset.push(path)
    else patch[path] = value
  }
  const reply = await (
    client as unknown as {
      sync: { submit: { mutate(input: unknown): Promise<{ outcome: string; refusal?: unknown }> } }
    }
  ).sync.submit.mutate({
    mutationId: crypto.randomUUID(),
    command,
    version: 1,
    input: { id, patch, ...(unset.length > 0 ? { unset } : {}) },
  })
  if (reply.outcome !== 'applied') throw new Error(`${command} refused: ${JSON.stringify(reply)}`)
}

/** The two writers the settings screen hands the save. */
const writers = (client: Client, user: UserId) => ({
  personal: async (values: Values) =>
    await submitEdit(client, 'records.userPreferences.edit', userPreferencesRowId(user), values),
  instance: async (values: Values) =>
    await submitEdit(
      client,
      'records.instancePreferences.edit',
      INSTANCE_PREFERENCES_ROW_ID,
      values,
    ),
})

async function withSettingsHttp(
  run: (fixture: {
    client: Client
    store: Awaited<ReturnType<typeof openTestStore>>
    user: UserId
    patches: Record<string, unknown>[]
    /** Write leaves as the settings screen does, then read what I now resolve. */
    seed: (values: Values) => Promise<PodiumSettings>
    save: (
      previous: PodiumSettings,
      next: PodiumSettings,
    ) => ReturnType<typeof saveSettingsAsCommands>
  }) => Promise<void>,
): Promise<void> {
  const store = await openTestStore(':memory:')
  const user = await firstAdminMemberId(store)
  const capability: Capability = {
    role: 'admin',
    scope: { kind: 'all' },
    actorUser: user,
    onBehalfOf: user,
  }
  const registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    pairing: new PairingManager(),
  })
  const repos = new RepoRegistry(registry, store)
  const superagent = await SuperagentService.create(registry.modules, repos, store)
  const patches: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      // Each record edit's leaves as the save sent them: a reset reads as null.
      if (req.method === 'POST' && new URL(req.url).pathname === '/trpc/sync.submit') {
        const batch = (await req.clone().json()) as Record<
          string,
          { command: string; input: { patch: Record<string, unknown>; unset?: string[] } }
        >
        for (const envelope of Object.values(batch)) {
          if (!envelope.command.endsWith('Preferences.edit')) continue
          patches.push({
            ...envelope.input.patch,
            ...Object.fromEntries((envelope.input.unset ?? []).map((path) => [path, null])),
          })
        }
      }
      return fetchRequestHandler({
        endpoint: '/trpc',
        router: appRouter,
        req,
        createContext: () => ({
          registry,
          repos,
          superagent,
          capability,
          principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
        }),
      })
    },
  })
  try {
    const client = makeTrpc(`http://127.0.0.1:${server.port}`, { report: false })
    const write = writers(client, user)
    const seed = async (values: Values) => {
      const personal: Record<string, unknown> = {}
      const instance: Record<string, unknown> = {}
      for (const [path, value] of Object.entries(values)) {
        if (path.startsWith('roles.')) personal[path] = value
        else instance[path] = value
      }
      if (Object.keys(personal).length > 0) await write.personal(personal)
      if (Object.keys(instance).length > 0) await write.instance(instance)
      return await store.settings.getSettingsFor(user)
    }
    const save = (previous: PodiumSettings, next: PodiumSettings) =>
      saveSettingsAsCommands(client, previous, next, { online: true, ...write })
    await run({ client, store, user, patches, seed, save })
  } finally {
    server.stop(true)
    superagent.dispose()
    await registry.dispose()
    await store.close()
  }
}

describe('harness clears through the web save and HTTP transport', () => {
  it.each([
    'coding',
    'background',
  ] as const)('switching %s from managed to native deletes the saved harness and resolves the native role', async (role) =>
    withSettingsHttp(async ({ store, user, patches, seed, save }) => {
      const path = `roles.${role}.harness`
      const previous = await seed({
        [`roles.${role}.accountId`]: asAccountId('managed:anthropic'),
        [`roles.${role}.model`]: 'managed-model',
        [`roles.${role}.effort`]: 'high',
        [path]: 'claude-code',
      })
      expect(await store.settings.userPreferences.keysFor(user)).toContain(path)
      patches.length = 0

      const next = {
        ...previous,
        roles: {
          ...previous.roles,
          [role]: {
            ...previous.roles[role],
            accountId: asAccountId('native:codex'),
            model: 'auto',
            effort: 'auto',
            harness: undefined,
          },
        },
      }
      const result = await save(previous, next)
      expect(result.refusals).toEqual([])
      expect(patches).toEqual([
        {
          [`roles.${role}.accountId`]: 'native:codex',
          [path]: null,
          [`roles.${role}.model`]: 'auto',
          [`roles.${role}.effort`]: 'auto',
        },
      ])
      // The local baseline holds the cleared leaf as `undefined`; the store drops it.
      expect(result.saved.roles[role].harness).toBeUndefined()
      expect(await store.settings.userPreferences.keysFor(user)).not.toContain(path)

      // What I now resolve and the server's next launch settings read agree.
      const launchSettings = await store.settings.getSettingsFor(user)
      expect(launchSettings.roles[role]).toEqual(result.saved.roles[role])
      expect(resolveRole(launchSettings, role)).toMatchObject({
        accountId: 'native:codex',
        harness: 'codex',
        execution: role === 'background' ? 'api' : 'harness',
      })
    }))

  it('resetting to defaults removes the superagent harness preference and settings still load', async () =>
    withSettingsHttp(async ({ store, user, patches, seed, save }) => {
      const path = 'roles.superagent.harness'
      const previous = await seed({ [path]: 'codex' })
      expect(previous.roles.superagent.harness).toBe('codex')
      expect(DEFAULT_SETTINGS.roles.superagent).not.toHaveProperty('harness')
      patches.length = 0

      // SettingsView's reset action patches DEFAULT_SETTINGS into the edit form.
      const result = await save(previous, DEFAULT_SETTINGS)
      expect(result.refusals).toEqual([])
      expect(patches).toEqual([{ [path]: null }])
      expect(await store.settings.userPreferences.keysFor(user)).not.toContain(path)
      expect(result.saved.roles.superagent.harness).toBeUndefined()
      expect((await store.settings.getSettingsFor(user)).roles.superagent).toEqual(
        DEFAULT_SETTINGS.roles.superagent,
      )
    }))
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
    ['coding', 'superagent', 'background', 'shipwright'].map((role) => [
      `roles.${role}.harness`,
      'codex',
    ]),
  )
  const nullableHibernation = {
    'hibernation.loadPerCore': null,
    'hibernation.maxIdleSessions': null,
    'hibernation.idleShellMinutes': null,
    'hibernation.backstopMinutes': null,
  }

  it('audits every settings leaf omitted by DEFAULT_SETTINGS', () => {
    expect(
      settingsLeafPaths(PodiumSettings)
        .filter((path) => readSettingsLeaf(DEFAULT_SETTINGS, path) === undefined)
        .sort(),
    ).toEqual([...Object.keys(configured), ...Object.keys(harnesses)].sort())
  })

  it('resetting all omitted optional leaves clears persisted preferences and settings still load', async () =>
    withSettingsHttp(async ({ store, user, patches, seed, save }) => {
      const previous = await seed({ ...harnesses, ...configured, ...nullableHibernation })
      for (const [path, value] of Object.entries(configured)) {
        expect(readSettingsLeaf(previous, path)).toBe(value)
        expect(readSettingsLeaf(await store.settings.getSettings(), path)).toBe(value)
      }
      patches.length = 0

      // SettingsView's Reset everything action patches this same default object.
      const result = await save(previous, DEFAULT_SETTINGS)
      expect(result.refusals).toEqual([])
      const received = Object.assign({}, ...patches)
      expect(patches).toHaveLength(2)
      expect(received).toEqual({
        ...instanceClears,
        ...Object.fromEntries(Object.keys(harnesses).map((path) => [path, null])),
        ...Object.fromEntries(
          Object.keys(nullableHibernation).map((path) => [
            path,
            readSettingsLeaf(DEFAULT_SETTINGS, path),
          ]),
        ),
      })
      expect(result.saved).toEqual(DEFAULT_SETTINGS)
      expect(await store.settings.getSettingsFor(user)).toEqual(DEFAULT_SETTINGS)
      expect(await store.settings.getSettings()).toEqual(DEFAULT_SETTINGS)
      for (const path of Object.keys(harnesses)) {
        expect(await store.settings.userPreferences.keysFor(user)).not.toContain(path)
      }
      for (const path of Object.keys(configured)) {
        expect(await store.settings.getSettings()).not.toHaveProperty(path)
      }

      patches.length = 0
      await save(result.saved, DEFAULT_SETTINGS)
      expect(patches).toEqual([])
    }))

  it('clears a transcript preference beside meaningful nulls and leaves omitted patch keys unchanged', async () =>
    withSettingsHttp(async ({ store, user, patches, seed, save }) => {
      const previous = await seed(configured)
      patches.length = 0
      const next = applySettingsPatch(previous, {
        'transcripts.mirror': undefined,
        ...nullableHibernation,
      })
      const result = await save(previous, next)
      expect(result.refusals).toEqual([])
      expect(patches).toEqual([{ 'transcripts.mirror': null, ...nullableHibernation }])
      for (const settings of [
        result.saved,
        await store.settings.getSettingsFor(user),
        await store.settings.getSettings(),
      ]) {
        expect(readSettingsLeaf(settings, 'transcripts.mirror')).toBeUndefined()
        expect(settings.deployment).toEqual(previous.deployment)
        for (const path of Object.keys(nullableHibernation)) {
          expect(readSettingsLeaf(settings, path)).toBeNull()
        }
      }
      // At rest the leaf is gone, not stored as a value.
      expect((await store.settings.getSettings()).transcripts).not.toHaveProperty('mirror')
    }))
})
