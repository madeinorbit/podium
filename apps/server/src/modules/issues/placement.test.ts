/**
 * POD-679 — `issues.setPlacement`: where discovered work lives.
 *
 * The two placements are already expressible as `reparent` + `depAdd`/
 * `depRemove`, and that is exactly why this command exists: the halves can land
 * separately, and an issue that lost its parent before it gained its
 * provenance edge is work with no way back to what discovered it. So the
 * assertions here are about the RESULTING SHAPE — parent link and edge
 * together — not about the calls made to get there.
 *
 * Driven against the real dispatcher (`asIssueTrpc`), the same object the web
 * client and the in-process MCP tools call.
 */
import { asIssueId, asSessionId, type Capability, FIRST_ADMIN_USER_ID } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'

import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'

const registries: SessionRegistry[] = []
const fresh = (): SessionRegistry => {
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  return registry
}
afterAll(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

/** origin + the work an agent filed under it, as a sub-issue. */
function discovered() {
  const registry = fresh()
  const origin = registry.issues.create({ repoPath: '/r', title: 'Origin', startNow: false })
  const found = registry.issues.create({
    repoPath: '/r',
    title: 'Found while working',
    parentId: origin.id,
    startNow: false,
  })
  return { registry, origin, found, client: registry.issueCommands.asIssueTrpc(OPERATOR) }
}

const depsOf = (registry: SessionRegistry, id: string, type: string): string[] =>
  (registry.issues.get(id)?.deps ?? []).filter((dep) => dep.type === type).map((dep) => dep.id)

describe('issues.setPlacement', () => {
  it('sends a sub-task out on its own — top level, with the way back intact', async () => {
    const { registry, origin, found, client } = discovered()

    await client.issues.setPlacement.mutate({
      id: found.id,
      placement: 'own',
      originId: origin.id,
    })

    const moved = registry.issues.get(found.id)
    expect(moved?.parentId ?? null).toBeNull()
    // The edge is the whole point: without it the work is orphaned, and the
    // mission it came from can no longer say what left.
    expect(depsOf(registry, found.id, 'discovered-from')).toEqual([origin.id])
  })

  it('takes a spin-off back into the mission, edge and all', async () => {
    const { registry, origin, found, client } = discovered()
    await client.issues.setPlacement.mutate({
      id: found.id,
      placement: 'own',
      originId: origin.id,
    })

    await client.issues.setPlacement.mutate({
      id: found.id,
      placement: 'mission',
      originId: origin.id,
    })

    expect(registry.issues.get(found.id)?.parentId).toBe(origin.id)
    // The stale edge must go: departure keys on it, so leaving it behind would
    // leave the work showing as gone from the very mission it just rejoined.
    expect(depsOf(registry, found.id, 'discovered-from')).toEqual([])
  })

  it('leaves an unrelated provenance edge alone', async () => {
    const { registry, origin, found, client } = discovered()
    const elsewhere = registry.issues.create({
      repoPath: '/r',
      title: 'Somewhere else',
      startNow: false,
    })
    registry.issues.addDep(found.id, elsewhere.id, 'discovered-from')

    await client.issues.setPlacement.mutate({
      id: found.id,
      placement: 'mission',
      originId: origin.id,
    })

    expect(depsOf(registry, found.id, 'discovered-from')).toEqual([elsewhere.id])
  })

  it('is the operator’s decision — a scoped worker is refused', async () => {
    const { origin, found, registry } = discovered()
    const worker: Capability = {
      role: 'worker',
      scope: { kind: 'subtree', rootId: asIssueId(origin.id) },
      actorSessionId: asSessionId('s-agent'),
      onBehalfOf: FIRST_ADMIN_USER_ID,
    }
    const asWorker = registry.issueCommands.asIssueTrpc(worker)

    await expect(
      asWorker.issues.setPlacement.mutate({
        id: found.id,
        placement: 'own',
        originId: origin.id,
      }),
    ).rejects.toThrow(/only an operator/)
  })

  it('refuses an issue as its own origin rather than writing a self-edge', async () => {
    const { found, client } = discovered()

    await expect(
      client.issues.setPlacement.mutate({
        id: found.id,
        placement: 'own',
        originId: found.id,
      }),
    ).rejects.toThrow(/its own origin/)
  })
})
