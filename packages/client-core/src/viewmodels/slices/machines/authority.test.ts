import { describe, expect, it } from 'vitest'
import {
  machineViews,
  NO_MACHINE_GRANTS,
  resolveSpawnTargetMachine,
  usableMachines,
  type MachineGrants,
} from './authority'

// ---------------------------------------------------------------------------
// POD-330 / multi-user doc §3.1.4 — MACHINES PUBLISH VERBS, NOT A BOOLEAN.
//
// M1  see / use / manage are separable.
// M2  `use` is a CODE-EXECUTION boundary, not a privacy one, so it must never
//     be published as the same flag as visibility.
// M5  UNAUTHORIZED must be distinguishable from UNREACHABLE — both produce the
//     same empty list, and the recovery is completely different ("ask the
//     owner" versus "wait, or wake the host").
//
// And the acceptance property: a resolved spawn target is NEVER a machine the
// principal lacks `use` on.
// ---------------------------------------------------------------------------

const machine = (id: string, online: boolean) => ({ id, online })

const grants = (over: Partial<MachineGrants> = {}): MachineGrants => ({
  see: true,
  use: true,
  manage: false,
  ...over,
})

/** A repo present on both machines. */
const repo = {
  machines: [
    { machineId: 'm-mine', path: '/repo' },
    { machineId: 'm-theirs', path: '/repo' },
  ],
}

const sessions = [{ machineId: 'm-mine', createdAt: '2026-07-01T00:00:00.000Z' }]

describe('machineViews — the three verbs stay separate', () => {
  it('a machine you may SEE but not USE is visible AND unauthorized', () => {
    const views = machineViews([machine('m-theirs', true)], () => grants({ use: false }))
    expect(views).toHaveLength(1)
    // Visibility is NOT execution: the row is still there...
    expect(views[0]!.grants.see).toBe(true)
    // ...and the execution verb is independently false.
    expect(views[0]!.grants.use).toBe(false)
    // Online, but you still may not run on it.
    expect(views[0]!.availability).toBe('unauthorized')
  })

  it('a machine you may USE but that is offline is unreachable, not unauthorized', () => {
    const views = machineViews([machine('m-mine', false)], () => grants())
    expect(views[0]!.availability).toBe('unreachable')
    expect(views[0]!.availability).not.toBe('unauthorized')
  })

  it('a machine you cannot SEE is absent entirely — the one verb that removes a row', () => {
    expect(machineViews([machine('m-secret', true)], () => grants({ see: false }))).toEqual([])
  })

  it('manage is independent of use — granting execution does not grant unpair', () => {
    const views = machineViews([machine('m-mine', true)], () => grants({ manage: false }))
    expect(views[0]!.grants.use).toBe(true)
    expect(views[0]!.grants.manage).toBe(false)
  })

  it('the default is closed — an unclassified machine grants nothing', () => {
    expect(NO_MACHINE_GRANTS).toEqual({ see: false, use: false, manage: false })
    expect(machineViews([machine('m-x', true)], () => NO_MACHINE_GRANTS)).toEqual([])
  })

  it('usableMachines yields only available hosts', () => {
    const views = machineViews(
      [machine('m-mine', true), machine('m-theirs', true), machine('m-off', false)],
      (m) => (m.id === 'm-theirs' ? grants({ use: false }) : grants()),
    )
    expect(usableMachines(views).map((m) => m.id)).toEqual(['m-mine'])
  })
})

describe('resolveSpawnTargetMachine — never returns a machine you lack USE on', () => {
  it('picks the used machine and skips the one you may only see', () => {
    const views = machineViews([machine('m-mine', true), machine('m-theirs', true)], (m) =>
      m.id === 'm-theirs' ? grants({ use: false }) : grants(),
    )
    expect(resolveSpawnTargetMachine(repo, sessions, views).machineId).toBe('m-mine')
  })

  it('REFUSES rather than falling back when the only repo host is unauthorized', () => {
    // m-theirs holds the repo, is online, and is the most recently used — every
    // reason to be chosen except the one that matters.
    const views = machineViews([machine('m-theirs', true)], () => grants({ use: false }))
    const r = resolveSpawnTargetMachine(
      { machines: [{ machineId: 'm-theirs', path: '/repo' }] },
      [{ machineId: 'm-theirs', createdAt: '2026-07-02T00:00:00.000Z' }],
      views,
    )
    expect(r.machineId).toBeUndefined()
    expect(r.refusal).toBe('unauthorized')
  })

  it('distinguishes unreachable from unauthorized', () => {
    const offline = machineViews([machine('m-mine', false)], () => grants())
    const r = resolveSpawnTargetMachine(
      { machines: [{ machineId: 'm-mine', path: '/repo' }] },
      sessions,
      offline,
    )
    expect(r.refusal).toBe('unreachable')
    expect(r.refusal).not.toBe('unauthorized')
  })

  it('distinguishes "no host has this repo" from both', () => {
    const views = machineViews([machine('m-mine', true)], () => grants())
    expect(resolveSpawnTargetMachine({ machines: [] }, sessions, views).refusal).toBe('no-repo')
  })

  it('an unauthorized host is never chosen even when it is the ONLY online one', () => {
    const views = machineViews([machine('m-mine', false), machine('m-theirs', true)], (m) =>
      m.id === 'm-theirs' ? grants({ use: false }) : grants(),
    )
    const r = resolveSpawnTargetMachine(repo, sessions, views)
    expect(r.machineId).not.toBe('m-theirs')
    // You may use m-mine, so the honest answer is "wait", not "ask permission".
    expect(r.refusal).toBe('unreachable')
  })
})
