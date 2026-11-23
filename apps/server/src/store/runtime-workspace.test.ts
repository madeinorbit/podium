/** The named process-wide seams share code, never another workspace's state (POD-7289). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asUserId, INSTANCE_PREFERENCES_ROW_ID, Inventory } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INSTALL_FAILING_NOTICE_MS } from '../modules/machines/install-notices'
import { asSystemWrite } from '../plain-command-scope'
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import { openWorkerReadSession } from '../sync-worker/read-session'
import { jobWorkspaceId, type SyncJob } from '../sync-worker/types'
import { bootstrapVisibility } from '../sync-worker/visibility'
import { countStatements, settledCommand } from '../test-support/statement-count'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { writeProcedureBuilder } from '../trpc'
import { memberFacts } from './fixtures/test-support'

type Tag = 'a' | 'b'
const TAGS = ['a', 'b'] as const
const USER = asUserId('member-shared')
const MACHINE = asMachineId('machine-shared')
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
let directory: string
let stores: Record<Tag, SessionStore>
let registries: Partial<Record<Tag, SessionRegistry>>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'workspace-runtime-'))
  const [a, b] = await openWorkspaceStores(['ws_a', 'ws_b'], { path: join(directory, 'store.db') })
  stores = { a, b }
  registries = {}
  for (const tag of TAGS) {
    await memberFacts(stores[tag]).create({
      id: USER,
      displayName: `Member ${tag}`,
      email: `member-${tag}@example.com`,
      role: 'admin',
      createdAt: new Date(NOW).toISOString(),
      disabledAt: null,
    })
    await stores[tag].machines.upsertMachine({
      id: MACHINE,
      name: `Machine ${tag}`,
      hostname: 'fixture-machine',
      tokenHash: 'fixture-token',
      ownerUserId: USER,
    })
  }
  for (const tag of TAGS) {
    registries[tag] = await SessionRegistry.create(stores[tag], undefined, {
      instanceId: 'workspace-test',
      recoveryOnly: true,
      now: () => NOW,
    })
  }
})

afterEach(async () => {
  try {
    for (const tag of TAGS) await registries?.[tag]?.dispose()
  } finally {
    try {
      await stores?.a.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

const inventory = (failing: boolean) =>
  Inventory.parse({
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [
      {
        kind: 'codex',
        installed: true,
        login: { state: 'in' },
        install: {
          managed: {
            paused: false,
            ...(failing
              ? { failingSince: new Date(NOW - INSTALL_FAILING_NOTICE_MS - 1).toISOString() }
              : {}),
          },
        },
      },
    ],
  })

function registry(tag: Tag): SessionRegistry {
  const registry = registries[tag]
  if (!registry) throw new Error(`workspace ${tag} has no registry`)
  return registry
}

const report = async (tag: Tag, failing: boolean) =>
  await settledCommand(() =>
    asSystemWrite(() =>
      registry(tag).modules.machines.recordInventory(MACHINE, inventory(failing)),
    ),
  )

const feature = async (tag: Tag) => {
  const service = registry(tag).modules.concertmaster
  if (!service) throw new Error('workspace has no concertmaster service')
  return await service.enabled()
}

describe('two workspaces in one process', () => {
  it('a notice, table write and settings change in A never reach B, even with the same ids', async () => {
    const heard: Record<Tag, string[]> = { a: [], b: [] }
    for (const tag of TAGS)
      stores[tag].tableWrites.subscribe('repos', () => heard[tag].push('repos'))
    expect(await feature('a')).toBe(false)
    expect(await feature('b')).toBe(false)
    const beforeB = await stores.b.settings.getSettings()

    // B was constructed last: the old global notice binding wrote A's notice into B.
    await report('a', true)
    const noticesA = await stores.a.notices.listOpen(USER, { limit: 20 })
    expect(noticesA).toHaveLength(1)
    expect(noticesA[0]?.title).toContain('Machine a')
    expect(await stores.b.notices.listOpen(USER, { limit: 20 })).toEqual([])
    stores.a.tableWrites.wrote('repos')
    expect(heard).toEqual({ a: ['repos'], b: [] })

    // Another request changes A through its repository, without the service graph's bus.
    // Feature policy must read the store rather than a boot/event snapshot.
    await asSystemWrite(() =>
      stores.a.settings.setSettings(
        normalizeSettings({ experimental: { concertmaster: true, workflows: true } }),
      ),
    )
    const read = await countStatements(stores.a, () => feature('a'))
    expect(read.result).toBe(true)
    expect(read.statements).toBe(1)
    expect(await feature('b')).toBe(false)
    expect(await stores.b.settings.getSettings()).toEqual(beforeB)

    // The same dedupe key is independent, including resolution in the earlier workspace.
    await report('b', true)
    expect(await stores.a.notices.countUnread(USER)).toBe(1)
    expect(await stores.b.notices.countUnread(USER)).toBe(1)
    await report('a', false)
    expect(await stores.a.notices.countUnread(USER)).toBe(0)
    expect(await stores.b.notices.countUnread(USER)).toBe(1)

    // The code-only write builder can serve both workspaces without a global claim.
    for (const tag of TAGS) {
      const route = writeProcedureBuilder().mutation(() => stores[tag].workspaceId)
      expect(route._def.type).toBe('mutation')
    }
  })

  it('sync visibility reads the explicitly named workspace; a missing job scope is refused', async () => {
    for (const tag of TAGS) {
      await asSystemWrite(() =>
        stores[tag].settings.setSettings(
          normalizeSettings({
            experimental: { concertmaster: tag === 'a' },
          }),
        ),
      )
    }
    const session = await openWorkerReadSession(stores.a.database.location)
    try {
      const contexts = await Promise.all(
        TAGS.map(
          async (tag) =>
            await bootstrapVisibility(session.executor, {
              workspaceId: stores[tag].workspaceId,
            }).context,
        ),
      )
      for (const [index, tag] of TAGS.entries()) {
        const context = contexts[index]
        if (!context) throw new Error(`workspace ${tag} has no sync context`)
        expect(await context.sync.readFeedIdentity()).toEqual(
          await stores[tag].sync.readFeedIdentity(),
        )
        const rows = await context.records.build('instancePreferences', [
          INSTANCE_PREFERENCES_ROW_ID,
        ])
        expect(rows).toHaveLength(1)
        expect(rows[0]?.value).toMatchObject({ 'experimental.concertmaster': tag === 'a' })
        const job: SyncJob = {
          workspaceId: stores[tag].workspaceId,
          transferId: tag,
          principal: { ...DEVICE_GRADE_PRINCIPAL, user: USER },
          feedId: 'feed',
          epoch: 'epoch',
          encoding: 'identity',
        }
        expect(jobWorkspaceId(job)).toBe(stores[tag].workspaceId)
        const { workspaceId: _workspace, ...missing } = job
        expect(() => jobWorkspaceId(missing as SyncJob)).toThrow('explicit workspace')
      }
      expect(await contexts[0]?.sync.readFeedIdentity()).not.toEqual(
        await contexts[1]?.sync.readFeedIdentity(),
      )
    } finally {
      await session.close()
    }
  })
})
