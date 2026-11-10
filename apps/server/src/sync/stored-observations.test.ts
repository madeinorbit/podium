import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationDiscoveryWire, firstAdminMemberId, machineAccessRowId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { collectRecords } from '@podium/sync/record-builders'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { recordReadsOver } from '../sync-worker/record-reads'
import { assignHostMachine } from '../test-support/host-daemon'
import { rawSql } from '../test-support/issue-corpus'
import { openTestStore } from '../test-support/open-test-store'
import { quietShipping } from '../test-support/statement-count'
import { type RecordReads, serverRecordBuilders } from './record-builders'
import { atParity, kindParity } from './record-parity'

const kinds = ['conversation', 'machine', 'machineAccess', 'issueGitState'] as const
const AT = '2026-11-10T12:00:00.000Z'

describe('stored observations (POD-6765)', () => {
  it('rebuilds all four published kinds from a read-only connection after restart and log deletion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-6765-records-'))
    const path = join(dir, 'podium.db')
    const store = await openTestStore(path)
    await assignHostMachine(store)
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const builders = serverRecordBuilders()
    const owner = await firstAdminMemberId(store)
    const machine = store.hostMachineId
    const reads: RecordReads = {
      store,
      effectExecutors: registry.modules.effects!.executors,
      now: Date.now,
    }
    let expected: Map<string, unknown[]>
    try {
      await quietShipping(registry)
      await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
      await store.machines.recordContext.setFleetChannel('edge')
      expect(await store.machines.recordContext.setFleetChannel('edge')).toBe(false)
      await store.machines.setUpdateChannel(machine, 'edge')
      await store.updateRecovery.write(() => ({
        format: 1,
        lastGrantAuthority: 0,
        targets: [['edge', { version: '0.4.2', critical: false, artifacts: {} }]],
        machines: [],
        grants: [],
        rollouts: [],
      }))
      await store.machines.setMachineBuild(
        machine,
        { appVersion: '0.4.2', wireSchemaDigest: 'reported', installKind: 'installed' },
        [],
        AT,
        'supervisor',
      )
      const issue = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
        repoPath: '/repo',
        title: 'Stored git state',
        startNow: false,
      })
      await registry.issues.reports.store.setGitState(issue.id, {
        updatedAt: AT,
        branch: 'issue/stored',
        shared: false,
        dirtyFiles: 2,
        ahead: 1,
        commits: ['abc'],
      })
      const afterGit = await store.sync.maxChangeSeq()
      expect(
        await registry.issues.reports.store.setGitState(issue.id, {
          updatedAt: '2026-11-10T13:00:00.000Z',
          branch: 'issue/stored',
          shared: false,
          dirtyFiles: 2,
          ahead: 1,
          commits: ['abc'],
        }),
      ).toBe(false)
      expect(await store.sync.maxChangeSeq()).toBe(afterGit)

      await registry.modules.memory.onDiscovery(
        machine,
        [
          ConversationDiscoveryWire.parse({
            id: 'native-1',
            agentKind: 'claude-code',
            providerId: 'claude-code',
            title: 'Stored conversation',
            path: '/transcripts/native-1.jsonl',
            sizeBytes: 123,
            git: { branch: 'dropped' },
            statusHint: 'dropped',
            resume: { kind: 'claude-session', value: 'native-1' },
            updatedAt: AT,
          }),
        ],
        [],
      )
      await registry.modules.memory.setConversationMeta(
        registry.issues.reports.store.serverWriter,
        { kind: 'system', id: 'stored-observations-test' },
        { id: 'native-1', name: 'Curated', summary: 'Kept' },
      )
      const conversation = (await builders.build(reads, 'conversation', ['native-1']))[0]!.value
      expect(conversation).toMatchObject({
        name: 'Curated',
        summary: 'Kept',
        podiumId: expect.stringMatching(/^conv_/),
      })
      for (const field of ['statusHint', 'git', 'sizeBytes', 'path', 'updatedAt', 'messageCount'])
        expect(conversation).not.toHaveProperty(field)
      expect(await store.conversations.registry.segmentPath(machine, 'native-1')).toBe(
        '/transcripts/native-1.jsonl',
      )

      // A repeated harness observation advances internal lastSeen only.
      await registry.modules.machines.recordHarnessVersion(machine, {
        type: 'machineHarnessVersion',
        harness: 'codex',
        version: '0.154.0',
        probedAt: AT,
      })
      const beforeRepeat = await store.sync.maxChangeSeq()
      await registry.modules.machines.recordHarnessVersion(machine, {
        type: 'machineHarnessVersion',
        harness: 'codex',
        version: '0.154.0',
        probedAt: '2026-11-10T13:00:00.000Z',
      })
      expect(await store.sync.maxChangeSeq()).toBe(beforeRepeat)
      const access = (
        await builders.build(reads, 'machineAccess', [machineAccessRowId(owner, machine)])
      )[0]!.value
      expect(access).toMatchObject({
        hostsServer: true,
        harnessVersions: [expect.objectContaining({ version: '0.154.0', firstSeen: AT })],
      })
      expect(access).not.toHaveProperty('harnessVersions.0.lastSeen')
      expect((await builders.build(reads, 'machine', [machine]))[0]!.value).toMatchObject({
        versionState: 'current',
        updateChannel: 'edge',
      })

      expected = new Map()
      for (const kind of kinds) {
        const published = (await store.sync.installedStatesOf(kind)).map(
          ({ entityId, payload }) => ({ entityId, payload }),
        )
        expect(published.length, kind).toBeGreaterThan(0)
        const parity = await kindParity(builders, reads, kind, published, { keepValues: true })
        expect(atParity(parity), JSON.stringify(parity, null, 2)).toBe(true)
        expected.set(kind, await collectRecords(builders.streamAll(reads, kind)))
      }
      rawSql(store, 'DELETE FROM changes')
      rawSql(store, 'DELETE FROM change_latest')
    } finally {
      await registry.dispose()
      await store.close()
    }
    const database = openDatabase(path, { readOnly: true })
    const worker = recordReadsOver(database, { effectExecutors: { get: () => undefined } })
    try {
      for (const kind of kinds) {
        expect(await collectRecords(builders.streamAll(worker.reads, kind)), kind).toEqual(
          expected!.get(kind),
        )
        const ids = (expected!.get(kind) as { id: string }[]).map(({ id }) => id)
        expect(await builders.build(worker.reads, kind, ids), kind).toEqual(expected!.get(kind))
      }
    } finally {
      await worker.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('rolls back the stored git facts and publication with the enclosing transaction', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      await quietShipping(registry)
      await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
      const issue = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
        repoPath: '/repo',
        title: 'Rollback',
        startNow: false,
      })
      const before = await store.sync.maxChangeSeq()
      await expect(
        store.transact(async () => {
          await registry.issues.reports.store.setGitState(issue.id, {
            updatedAt: AT,
            branch: 'branch',
            shared: false,
            dirtyFiles: 1,
          })
          expect(await registry.issues.reports.store.gitState(issue.id)).toMatchObject({
            dirtyFiles: 1,
          })
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(await registry.issues.reports.store.gitState(issue.id)).toBeUndefined()
      expect(await store.sync.maxChangeSeq()).toBe(before)
    } finally {
      await registry.dispose()
      await store.close()
    }
  })
})
