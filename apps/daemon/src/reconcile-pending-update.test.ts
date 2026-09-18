import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPendingGrant, writePendingGrant } from './pending-grant'
import { reconcilePendingUpdate } from './reconcile-pending-update'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pending = { grantId: 'legacy-first', targetVersion: 'dev.171', previousVersion: 'dev.164', attempts: 1, startedAt: 1 }
function setup() {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'legacy-takeover-'))
  roots.push(runtimeDir)
  const send = vi.fn()
  const input = { runtimeDir, appVersion: pending.targetVersion,
    env: { PODIUM_MACHINE_UPDATE_OWNER: 'supervisor', PODIUM_UNDER_PARENT: '1' },
    parentHasServer: false, send, log: vi.fn() }
  return { input, send }
}

describe('legacy grant reconciliation after supervisor takeover', () => {
  it('confirms the exact legacy grant before retiring its marker', () => {
    const { input, send } = setup()
    writePendingGrant(input.runtimeDir, pending)
    send.mockImplementation(() => expect(readPendingGrant(input.runtimeDir)).toEqual(pending))
    expect(reconcilePendingUpdate(input)).toBe(pending.targetVersion)
    expect(send).toHaveBeenCalledWith({ type: 'updateStatus', grantId: pending.grantId,
      targetVersion: pending.targetVersion, version: pending.targetVersion, state: 'current', phaseDetail: 'current' })
    expect(readPendingGrant(input.runtimeDir)).toBeNull()
    reconcilePendingUpdate(input)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not invent a confirmation without a marker', () => {
    const { input, send } = setup()
    expect(reconcilePendingUpdate(input)).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['dev.171', 'another-target'])('keeps supervisor journal precedence for %s', (version) => {
    const { input, send } = setup()
    writePendingGrant(input.runtimeDir, pending)
    writeFileSync(join(input.runtimeDir, 'machine-update.json'), JSON.stringify({ format: 1,
      grant: { type: 'updateGrant', grantId: 'supervisor', target: { version, critical: false, artifacts: {} } },
      fingerprint: 'fingerprint', previousVersion: 'dev.164', phase: 'restarting', updatedAt: 1,
      completed: {}, authority: 1 }))
    expect(reconcilePendingUpdate(input)).toBe(version === input.appVersion ? version : undefined)
    expect(send).not.toHaveBeenCalled()
    expect(readPendingGrant(input.runtimeDir)).toEqual(pending)
  })

  it('preserves the spent attempt when boot did not reach the target', () => {
    const { input, send } = setup()
    writePendingGrant(input.runtimeDir, pending)
    expect(reconcilePendingUpdate({ ...input, appVersion: pending.previousVersion })).toBeUndefined()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ state: 'rejected', grantId: pending.grantId }))
    expect(send.mock.calls[0]![0].phaseDetail).toBeUndefined()
    expect(readPendingGrant(input.runtimeDir)?.attempts).toBe(2)
  })

  it('reports exhausted convergence as stuck and retires the marker', () => {
    const { input, send } = setup()
    writePendingGrant(input.runtimeDir, { ...pending, attempts: 2 })
    reconcilePendingUpdate({ ...input, appVersion: pending.previousVersion })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ state: 'stuck', grantId: pending.grantId }))
    expect(readPendingGrant(input.runtimeDir)).toBeNull()
  })

  it('leaves all-in-one confirmation to the parent health gate', () => {
    const { input, send } = setup()
    writePendingGrant(input.runtimeDir, pending)
    reconcilePendingUpdate({ ...input, parentHasServer: true })
    expect(send).not.toHaveBeenCalled()
    expect(readPendingGrant(input.runtimeDir)).toEqual(pending)
  })
})
