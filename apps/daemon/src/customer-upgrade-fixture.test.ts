import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, asUserId } from '@podium/model'
import { BindingStore } from './binding-store'
import { describe, expect, it } from 'vitest'
import { daemonBindings, manifest } from '../../../packages/runtime/src/fixtures/customer-upgrade'

describe('customer upgrade fixture: daemon', () => {
  it('contains handoff residue and a receipt for a session absent on the server', () => {
    expect(daemonBindings.bindings).toHaveLength(2)
    expect(daemonBindings.bindings.some((binding) => binding.sessionId === manifest.daemon.handoffSession && binding.claimantMachineId === manifest.daemon.handoffMachine)).toBe(true)
    expect(daemonBindings.legacyReceipt).toEqual({ sessionId: manifest.daemon.deletedSessionReceipt, serverState: 'missing' })
  })

  it('quarantines only the moved binding and keeps healthy sessions serving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-customer-upgrade-daemon-'))
    try {
      const store = await BindingStore.open({
        dir: join(root, 'bindings'),
        singleOperatorUserId: asUserId(manifest.retiredPrincipal),
        legacyBindings: daemonBindings.bindings.map((binding) => ({
          sessionId: asSessionId(binding.sessionId),
          agentKind: 'codex' as const,
          control: { durableLabel: `podium-${binding.sessionId}`, cwd: '/fixture' },
        })),
      })
      const healthy = await store.read(asSessionId('session-healthy'))
      const moved = await store.read(asSessionId(manifest.daemon.handoffSession))
      expect(healthy?.state).toBe('ready')
      expect(moved?.state).toBe('quarantined')
      expect(manifest.daemon.expectedQuarantineCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
