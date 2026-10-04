import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { SocketHub } from '@podium/client-core/socket-transport'
import { canonicalIssueRef, issueReferenceModel } from '@podium/client-core/values'
import { asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { chipReplayLegacy, chipReplayTokens } from '../../../../../diagnostics/issue-chips-replay'

describe('chip replay coverage', () => {
  it('seeds the legacy oracle in the actual ClientRuntime replica-order on a reference tie', () => {
    const stamp = '2026-10-01T00:00:00.000Z'
    const raw = ['iss_z', 'iss_a'].map((id) => ({
      id,
      seq: 17,
      prefix: 'POD',
      repoId: 'repo',
      repoPath: '/synthetic',
      title: id,
      stage: 'in_progress',
      description: { value: '' },
      createdAt: stamp,
      updatedAt: stamp,
      archived: false,
      deps: [],
    }))
    // Transport puts z before a; the runtime orders by opaque id instead.
    const records = [
      {
        entity: 'repo',
        entityId: 'repo',
        value: { id: 'repo', prefix: 'POD' },
        provenance: { seq: 1 },
      },
      ...raw.flatMap((row) =>
        ['issue', 'issueProjection'].map((entity) => ({
          entity,
          entityId: row.id,
          value: row,
          provenance: { seq: 1 },
        })),
      ),
    ]
    const replica = createKernelReplica({
      cache: {
        readCursor: () => null,
        readEntities: () => records,
        read: (entity, id) => records.find((row) => row.entity === entity && row.entityId === id),
        durability: () => 'durable',
      },
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const app = createClientRuntime({
      principal: asClientPrincipal(asUserId('synthetic-chip-order')),
      config: { httpOrigin: 'http://synthetic.invalid', wsClientUrl: 'ws://synthetic.invalid' },
      api: {} as PodiumClientApi,
      onFatalError: () => {},
      networkEnabled: false,
      createReplicaFn: () => replica,
      routerWindow: createMemoryRouterWindow(),
      createHub: () => ({ dispose() {} }) as unknown as SocketHub,
    })
    try {
      const store = referenceState(app)
      const actual = allIssueViewModels(replica, store.issueProjections, store.issueUserStates)
      const replay = chipReplayLegacy(replica)
      expect(actual.map((row) => row.id)).toEqual(['iss_a', 'iss_z'])
      expect(replay.map(issueReferenceModel)).toEqual(actual.map(issueReferenceModel))
      const expected = new Map(actual.map((row) => [canonicalIssueRef(row), row.id]))
      const replayed = new Map(replay.map((row) => [canonicalIssueRef(row), row.id]))
      expect(replayed.get('POD-17')).toBe(expected.get('POD-17'))
      expect(replayed.get('POD-17')).toBe('iss_z')
      expect(chipReplayTokens(replay)).toEqual(['POD-17', 'POD-17'])
    } finally {
      app.destroy()
    }
  })
})
