import { asClientPrincipal } from '@podium/client-core/principal'
import { allIssueViewModels, type IssueViewModel } from '@podium/client-core/replica'
import { asUserId, ISSUE_STAGES, IssueWire, issueUserStateRowId } from '@podium/model/browser'
import { IDBFactory } from 'fake-indexeddb'
import { CLIENT_WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueListView } from '@/features/issues/IssueListView'
import { IssuesKanban } from '@/features/issues/IssuesKanban'
import { DEFAULT_DISPLAY } from '@/features/issues/issues-display'
import { normalizedFixtureStore } from '@/test-support/normalized-issues'
import { openKernelAssembly, type KernelAssembly } from './kernelReplica'
import { makeIssue } from './test-issue'

const principal = JSON.stringify(['installation-a', 'alice'])
const assemblies: KernelAssembly[] = []
beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  for (const assembly of assemblies.splice(0)) await assembly.dispose()
  vi.unstubAllGlobals()
})
async function open(factory: IDBFactory, dropLegacyIssues?: boolean) {
  const assembly = await openKernelAssembly({
    trpc: {} as never,
    principal,
    factory: factory as never,
    evidence: { kind: 'single-account', principal },
    dropLegacyIssues,
    broadcastChannelFactory: () => ({ onmessage: null, postMessage() {}, close() {} }),
  })
  assemblies.push(assembly)
  return {
    assembly,
    replica: assembly.createReplicaFn(asClientPrincipal(asUserId('alice'), 'installation-a')),
  }
}
function screenOutput(models: IssueViewModel[]) {
  const common = {
    focusId: null,
    selected: [],
    onOpen: vi.fn(),
    onCreateIn: vi.fn(),
    onToggleSelect: vi.fn(),
    onContextMenu: vi.fn(),
  }
  const list = render(
    <IssueListView
      {...common}
      display={DEFAULT_DISPLAY}
      groups={ISSUE_STAGES.map((stage) => ({
        stage,
        rows: models
          .filter((i) => i.stage === stage)
          .map((issue) => ({ issue, depth: 0, childCount: 0, expanded: false })),
      }))}
      onToggleExpand={vi.fn()}
      onStatusPick={vi.fn()}
    />,
  )
  const listText = list.container.textContent
  const listRows = [...list.container.querySelectorAll('[data-issue-id]')].map((row) =>
    row.getAttribute('data-issue-id'),
  )
  list.unmount()
  const board = render(
    <IssuesKanban
      {...common}
      columns={ISSUE_STAGES.map((stage) => ({
        stage,
        issues: models.filter((i) => i.stage === stage),
      }))}
      allIssues={models}
      sessions={[]}
      now={Date.parse('2026-10-01T12:00:00Z')}
      badges={DEFAULT_DISPLAY.badges}
      ordering="priority"
      stageCounts={new Map()}
      epicProgress={new Map()}
      onMoveIssue={vi.fn()}
      onApprove={vi.fn()}
    />,
  )
  const boardText = board.container.textContent
  const boardRows = [...board.container.querySelectorAll('[data-issue-id]')].map((row) =>
    row.getAttribute('data-issue-id'),
  )
  board.unmount()
  return { listText, listRows, boardText, boardRows }
}

describe('web legacy issue retention', () => {
  it('defaults on and loads an old IndexedDB cache with identical issue list and board screens', async () => {
    const factory = new IDBFactory()
    const before = await open(factory, false)
    const wires = [
      makeIssue({
        id: 'i1',
        seq: 1,
        title: 'Offline task',
        stage: 'backlog',
        pinned: true,
        readAt: 'read',
      }),
      makeIssue({
        id: 'i2',
        seq: 2,
        title: 'Waiting to merge',
        stage: 'review',
        humanQuestion: 'Approve?',
        humanQuestionOptions: ['Yes', 'No'],
        gitState: {
          updatedAt: 'probe',
          branch: 'feature',
          ahead: 2,
          shared: false,
          dirtyFiles: 0,
          merged: false,
        },
      }),
    ]
    const fixture = normalizedFixtureStore({ issues: wires })
    const records = [
      ...wires.map((wire) => ({
        entity: 'issue',
        entityId: wire.id,
        value: IssueWire.parse(wire),
        provenance: { seq: 1 },
      })),
      ...(['issueProjections', 'issueUserStates', 'issueGitStates', 'repos'] as const).flatMap(
        (kind) =>
          fixture.replica.rows(kind).map((value) => ({
            entity: {
              issueProjections: 'issueProjection',
              issueUserStates: 'issueUserState',
              issueGitStates: 'issueGitState',
              repos: 'repo',
            }[kind],
            entityId: 'id' in value ? value.id : issueUserStateRowId(value.userId, value.entityId),
            value,
            provenance: { seq: 1 },
          })),
      ),
    ]
    const cache = before.assembly.store.viewFor(principal).cache
    cache.installSnapshot(records, { feedId: 'f', epoch: 'e', seq: 10 }, [])
    await before.assembly.store.settled()
    expect(cache.readEntities().filter((row) => row.entity === 'issue')).toHaveLength(2)
    const beforeModels = allIssueViewModels(before.replica)
    expect(beforeModels).toHaveLength(2)
    const screens = screenOutput(beforeModels)
    expect(screens.listRows).toEqual(['i1', 'i2'])
    expect(screens.boardRows).toEqual(['i1', 'i2'])
    await before.assembly.dispose()
    assemblies.splice(assemblies.indexOf(before.assembly), 1)

    const after = await open(factory)
    const hydrated = await after.replica.hydrate()
    expect(after.replica.dropLegacyIssues).toBe(true)
    expect(hydrated.issues).toEqual([])
    expect(hydrated.schemaReset).toBe(false)
    expect(after.replica.getCursor()).toBe(10)
    expect(
      after.assembly.store
        .viewFor(principal)
        .cache.readEntities()
        .filter((row) => row.entity === 'issue'),
    ).toEqual([])
    expect(allIssueViewModels(after.replica)).toEqual(beforeModels)
    expect(screenOutput(allIssueViewModels(after.replica))).toEqual(screens)
    // A dropped row remains ignored on the live feed; its sequence still commits.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            [
              {
                type: 'syncMeta',
                formatVersion: 1,
                mode: 'delta',
                transferId: 't',
                feedId: 'f',
                epoch: 'e',
                fromSeq: 10,
                seq: 10,
                minAvailableSeq: 0,
                wireVersion: CLIENT_WIRE_VERSION,
                wireSchemaDigest: wireSchemaDigest(),
              },
              { type: 'syncComplete', transferId: 't', seq: 10, records: 0, rows: 0 },
            ]
              .map((record) => JSON.stringify(record) + '\n')
              .join(''),
            { headers: { 'content-type': 'application/x-ndjson' } },
          ),
      ),
    )
    after.assembly.feed.connected(true)
    await vi.waitFor(() => expect(after.assembly.progress.getSnapshot().phase).toBe('ready'))
    after.assembly.feed.frame({
      type: 'feedDelta',
      feedId: 'f',
      epoch: 'e',
      fromSeq: 10,
      seq: 11,
      minAvailableSeq: 0,
      changes: [
        {
          seq: 11,
          entity: 'issue',
          entityId: wires[0]!.id,
          op: 'upsert',
          value: IssueWire.parse(wires[0]),
        },
      ],
    })
    await vi.waitFor(() => expect(after.replica.getCursor()).toBe(11))
    expect(after.replica.rows('issues')).toEqual([])
    expect(allIssueViewModels(after.replica)).toEqual(beforeModels)
  })
})
