import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type {
  MachineSupervisorControlMessage,
  UpdateGrantMessage,
  UpdateTarget,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'
import { UPDATE_OPERATION_KIND, UPDATE_STEP_MACHINES } from './operation'
import { updateOperationContext } from './trpc'

const host = asMachineId('coordinator')
const target: UpdateTarget = {
  version: '0.4.2',
  critical: false,
  artifacts: { headless: { delivery: 'feed', platforms: {} } },
}
const build = (appVersion: string) => ({
  appVersion,
  wireSchemaDigest: 'test-schema',
  installKind: 'installed' as const,
})

/** Actual production composition, with transport sinks instead of sockets.
 * Every reboot closes/reopens SQLite and constructs a new SessionRegistry. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'podium-canary-recovery-'))
  const file = join(dir, 'podium.db')
  let store: SessionStore
  let registry: SessionRegistry
  const open = async (recoveryOnly = false) => {
    store = await SessionStore.open(file, host, recoveryOnly ? { queryOnly: true } : {})
    registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'canary-recovery',
      recoveryOnly,
    })
    return registry
  }
  await open()
  const sent: Array<{ id: string; grant: UpdateGrantMessage }> = []
  return {
    get registry() {
      return registry
    },
    get store() {
      return store
    },
    sent,
    async add(id: string, version = '0.4.1') {
      await store.machines.upsertMachine({
        id,
        name: id,
        hostname: id,
        tokenHash: '',
        ownerUserId: FIRST_ADMIN_USER_ID,
      })
      await store.machines.setUpdateChannel(id, 'dev')
      await this.hello(id, version)
    },
    async hello(id: string, version = target.version) {
      await registry.modules.machines.attachSupervisor(
        asMachineId(id),
        (message: MachineSupervisorControlMessage) => {
          if (message.type === 'updateGrant') sent.push({ id, grant: message })
        },
        build(version),
        ['update.delivery.feed'],
      )
    },
    context(ids: string[]) {
      return updateOperationContext({
        updates: registry.modules.updates,
        operations: registry.modules.operations,
        channel: 'dev',
        appVersion: () => target.version,
        onlyMachines: ids,
        createDatabaseSnapshot: () => {
          throw new Error('No server step in this fleet-only regression')
        },
      })
    },
    async reboot(recoveryOnly = false) {
      await registry.dispose()
      await store.close()
      return await open(recoveryOnly)
    },
    async close() {
      await registry.dispose()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('production adoption restores supervised execution proof', () => {
  it.each([
    1, 2,
  ])('holds an unconfirmed canary with %i awaited machines across coordinator restart', async (count) => {
    const h = await fixture()
    try {
      const ids = count === 1 ? ['a'] : ['a', 'b']
      // Planning must observe completed enrollment and supervisor attachment.
      for (const id of ids) await h.add(id)
      await h.add('already-healthy', target.version)
      h.registry.modules.updates.setTarget('dev', target)
      const started = await h.registry.modules.operations.engine.start(
        UPDATE_OPERATION_KIND,
        h.context(ids),
        { createdBy: 'user' },
      )
      expect(started.started).toBe(true)
      if (!started.started) throw new Error('operation did not start')
      const id = started.operation.id
      await h.registry.modules.operations.engine.whenSettled(id)
      expect(h.sent.map((s) => s.id)).toEqual(['a'])
      const grant = h.sent[0]!.grant
      // This is the production pre-health supervisor hello: its build is now
      // persisted while the grant has no healthy execution report.
      await h.hello('a')
      expect((await h.store.machines.listMachines()).find((m) => m.id === 'a')?.appVersion).toBe(
        target.version,
      )
      const boot = await h.reboot()
      expect((await boot.modules.updates.fleet()).find((m) => m.id === 'a')).toMatchObject({
        online: false,
        state: 'granted',
      })
      // server.ts ordering: adoption consumes updates.fleet() BEFORE transports
      // attach, then builds the production context for the resumed runner.
      await boot.modules.operations.engine.adoptOnBoot(
        async () => ({
          appVersion: target.version,
          servedWebDigest: undefined,
          machineDirectory: await boot.modules.updates.fleet(),
          now: Date.now(),
        }),
        () => h.context(ids),
      )
      await boot.modules.operations.engine.whenSettled(id)
      const machines = async () =>
        (await h.store.operations.get(id))?.operation?.steps?.find(
          (s) => s.id === UPDATE_STEP_MACHINES,
        )
      expect((await machines())?.state).not.toBe('done')
      expect((await machines())?.places?.find((p) => p.id === 'a')?.state).not.toBe('current')
      expect(h.sent.map((s) => s.id)).toEqual(['a'])
      for (const machine of ids)
        await h.hello(machine, machine === 'a' ? target.version : '0.4.1')
      await boot.modules.updateFleetBridge?.onFleetChanged()
      await boot.modules.operations.engine.whenSettled(id)
      expect(h.sent.map((s) => s.id)).toEqual(['a'])
      const report = {
        type: 'updateStatus' as const,
        state: 'current' as const,
        grantId: grant.grantId,
        targetVersion: target.version,
        version: target.version,
        phaseDetail: 'current',
      }
      await boot.modules.updates.onStatus(asMachineId('a'), { ...report, grantId: 'stale' })
      await boot.modules.updateFleetBridge?.onFleetChanged()
      await boot.modules.operations.engine.whenSettled(id)
      expect(h.sent.map((s) => s.id)).toEqual(['a'])
      await boot.modules.updates.onStatus(asMachineId('a'), report)
      await boot.modules.updateFleetBridge?.onFleetChanged()
      await boot.modules.operations.engine.whenSettled(id)
      expect((await machines())?.places?.find((p) => p.id === 'a')?.state).toBe('current')
      expect(h.sent.map((s) => s.id)).toEqual(ids)
      expect((await boot.modules.updates.fleet()).find((m) => m.id === 'already-healthy')?.state).toBe(
        'current',
      )
      if (count === 1) expect((await machines())?.state).toBe('done')
      else expect(boot.modules.updates.waveRounds('dev')[0]?.gate).toBe('widen')
    } finally {
      await h.close()
    }
  })

  it.each([false, true])(
    'keeps a canceled rollout canceled when its canary finishes late (reboot=%s)',
    async (reboot) => {
      const h = await fixture()
      try {
        for (const machine of ['a', 'b']) await h.add(machine)
        const updates = h.registry.modules.updates
        updates.setTarget('dev', target)
        const started = await h.registry.modules.operations.engine.start(
          UPDATE_OPERATION_KIND, h.context(['a', 'b']), { createdBy: 'user' },
        )
        if (!started.started) throw new Error('operation did not start')
        const id = started.operation.id
        await h.registry.modules.operations.engine.whenSettled(id)
        expect(h.sent.map((s) => s.id)).toEqual(['a'])
        const grant = h.sent[0]!.grant
        await updates.onStatus(asMachineId('a'), {
          type: 'updateStatus', state: 'restarting', version: '0.4.1',
          targetVersion: target.version, grantId: grant.grantId, phaseDetail: 'restarting',
        })
        expect(await h.registry.modules.operations.engine.cancel(id)).toMatchObject({ canceled: true })
        expect(await updates.operationActive('dev')).toBe(false)
        expect(h.store.updateRecovery.read()?.retiredGrants?.[0]?.[1].grantId).toBe(grant.grantId)
        if (reboot) {
          const boot = await h.reboot()
          await boot.modules.operations.engine.adoptOnBoot(
            async () => ({ appVersion: target.version, servedWebDigest: undefined,
              machineDirectory: await boot.modules.updates.fleet(), now: Date.now() }),
            () => h.context(['a', 'b']),
          )
        }
        await h.hello('a')
        await h.hello('b', '0.4.1')
        const current = h.registry.modules.updates
        expect((await current.fleet()).find((m) => m.id === 'a')?.state).toBe('stuck')
        const report = {
          type: 'updateStatus' as const, state: 'current' as const, version: target.version,
          targetVersion: target.version, grantId: grant.grantId, phaseDetail: 'current',
        }
        await current.onStatus(asMachineId('a'), { ...report, grantId: 'unrelated' })
        expect(await current.machineBootedAtTarget(asMachineId('a'), target.version)).toBe(false)
        for (let replay = 0; replay < 3; replay++) {
          await current.onStatus(asMachineId('a'), report)
          await h.registry.modules.updateFleetBridge?.onFleetChanged()
          await h.registry.modules.operations.engine.whenSettled(id)
          expect((await current.fleet()).find((m) => m.id === 'a')?.state).toBe('current')
          expect(await current.machineBootedAtTarget(asMachineId('a'), target.version)).toBe(true)
          expect(await current.operationActive('dev')).toBe(false)
          expect((await h.store.operations.get(id))?.state).toBe('canceled')
          expect(h.sent.map((s) => s.id)).toEqual(['a'])
        }
        const boot = await h.reboot()
        await h.hello('a')
        await h.hello('b', '0.4.1')
        expect((await boot.modules.updates.fleet()).find((m) => m.id === 'a')?.state).toBe('current')
        expect(await boot.modules.updates.machineBootedAtTarget(asMachineId('a'), target.version)).toBe(true)
        expect((await h.store.operations.get(id))?.state).toBe('canceled')
        expect(h.sent.map((s) => s.id)).toEqual(['a'])
      } finally {
        await h.close()
      }
    },
  )

  it('accepts retired proof in recovery-only memory without writing the reopened query-only database', async () => {
    const h = await fixture()
    try {
      await h.add('a')
      await h.add('b')
      const updates = h.registry.modules.updates
      updates.setTarget('dev', target)
      await updates.authorize()
      const grant = h.sent[0]!.grant
      updates.withdrawAuthorization()
      await updates.releaseInFlightGrants('Canceled')
      await h.hello('a')
      const saved = h.store.updateRecovery.read()
      const boot = await h.reboot(true)
      const write = vi.spyOn(h.store.updateRecovery, 'write')
      await boot.modules.updates.onStatus(asMachineId('a'), {
        type: 'updateStatus', state: 'current', version: target.version,
        targetVersion: target.version, grantId: grant.grantId, phaseDetail: 'current',
      })
      for (let read = 0; read < 3; read++) {
        expect((await boot.modules.updates.fleet()).find((m) => m.id === 'a')?.state).toBe('current')
        expect(await boot.modules.updates.operationActive('dev')).toBe(false)
      }
      expect(write).not.toHaveBeenCalled()
      expect(h.store.updateRecovery.read()).toEqual(saved)
      expect(h.sent.map((s) => s.id)).toEqual(['a'])
    } finally {
      await h.close()
    }
  })

  it.each([
    false,
    true,
  ])('serves repeated query-only fleet reads without writes or poisoned proof (legacy=%s)', async (legacy) => {
    const h = await fixture()
    try {
      await h.add('a')
      const updates = h.registry.modules.updates
      updates.setTarget('dev', target)
      await updates.authorize()
      const grant = h.sent[0]!.grant
      await h.hello('a')
      await updates.onStatus(asMachineId('a'), {
        type: 'updateStatus',
        state: 'current',
        grantId: grant.grantId,
        version: target.version,
        targetVersion: target.version,
        phaseDetail: 'current',
      })
      if (legacy) {
        const saved = h.store.updateRecovery.read()!
        saved.machines[0]![1].requiresExecutionConfirmation = false
        h.store.updateRecovery.write(saved)
      }
      const before = h.store.updateRecovery.read()
      const boot = await h.reboot(true)
      const write = vi.spyOn(h.store.updateRecovery, 'write')
      // Projection would set canaryHealthy and (for a legacy grant) retire rows.
      // Those are precisely the writes that a constructor-only fix missed.
      for (let read = 0; read < 3; read++) {
        expect((await boot.modules.updates.fleet()).find((m) => m.id === 'a')?.state).toBe('current')
        expect(await boot.modules.updates.machineBootedAtTarget(asMachineId('a'), target.version)).toBe(
          false,
        )
      }
      expect(write).not.toHaveBeenCalled()
      expect(h.store.updateRecovery.read()).toEqual(before)
      expect(h.sent).toHaveLength(1)
    } finally {
      await h.close()
    }
  })
})
