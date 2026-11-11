import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asIssuePanelItemId, firstAdminMemberId } from '@podium/model'
import {
  Authority,
  DEVICE_GRADE_PRINCIPAL,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
} from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { expect, it } from 'vitest'
import { makeFeedVisibility } from '../feed-visibility'
import { EventBus } from '../modules/bus'
import { WriteFunnel } from '../modules/funnel'
import { produceBootstrap } from '../sync-worker/producer'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import { testStoreRecords } from '../test-support/record-writer'

const kinds = ['issuePanelArtifact', 'issuePanelTodo', 'issuePanelDeferred'] as const

for (const kind of kinds) {
  for (const removal of ['item', 'issue'] as const) {
    it.each([
      'funnel',
      'worker',
    ] as const)(`%s catches up past ${kind} after removing its ${removal}`, async (path) => {
      const dir = mkdtempSync(join(tmpdir(), 'panel-catch-up-'))
      const dbPath = join(dir, 'test.db')
      const store = await openTestStore(dbPath)
      try {
        await store.repos.addRepo('/repo', store.hostMachineId)
        const owner = await firstAdminMemberId(store)
        const issueId = asIssueId('issue')
        await store.issues.upsertIssue(
          fixtureWriteScope(),
          issueRowFixture({
            id: issueId,
            ownerUserId: owner,
            parentId: null,
            repoId: null,
            machineId: null,
          }),
        )
        const principal = { ...DEVICE_GRADE_PRINCIPAL, user: owner }
        const records = testStoreRecords(store)
        const feed = makeFeedVisibility({
          store,
          currentRecords: records.build,
          audiencesFor: async () => new Map(),
          authorizationRevision: async () => 0,
        })
        const authority = new Authority({
          store: store.sync,
          now: Date.now,
          transact: (fn) => store.transact(fn),
          records,
          visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()),
          anchors: feed.anchors,
        })
        const funnel = new WriteFunnel({
          authority,
          bus: new EventBus(),
          serving: {
            publish: () => {},
            flushPending: () => {},
            identity: () => ({ feedId: 'feed', epoch: 'epoch' }),
            retentionFloor: () => 1,
          },
          onPublished: () => {},
        })
        const id = asIssuePanelItemId(randomUUID())
        const value = {
          id,
          issueId,
          position: 0,
          ...(kind === 'issuePanelArtifact'
            ? { path: 'review.html', addedAt: 't' }
            : kind === 'issuePanelTodo'
              ? { text: 'Task', done: false }
              : { text: 'Later', addedAt: 't' }),
        }
        const affects = [{ entity: kind, entityId: id }]
        const from = await authority.cursor()
        await authority.commit({
          affects,
          write: () => store.issues.panel.save(fixtureWriteScope(), kind, value),
        })
        const addedAt = await authority.cursor()
        expect(addedAt).toBeGreaterThan(from)
        expect(await funnel.changesSince(from, principal)).toMatchObject([
          { entity: kind, op: 'upsert' },
        ])
        await authority.commit({
          affects,
          write: async () => {
            if (removal === 'item')
              await store.issues.panel.remove(fixtureWriteScope(), kind, issueId, id)
            else await store.issues.deleteIssue(issueId)
          },
        })
        const through = await authority.cursor()
        expect(through).toBeGreaterThan(addedAt)
        if (path === 'funnel') {
          expect(await funnel.changesSince(from, principal)).toMatchObject([
            { entity: kind, op: 'remove' },
          ])
          expect(await funnel.changesSince(through, principal)).toEqual([])
        } else {
          let output = ''
          for await (const bytes of produceBootstrap(
            dbPath,
            {
              mode: 'delta',
              transferId: 'catch-up',
              principal,
              feedId: 'feed',
              epoch: 'epoch',
              encoding: 'identity',
              from,
              pageRows: 1,
            },
            new AbortController().signal,
            () => {},
          ))
            output += new TextDecoder().decode(bytes)
          const lines = output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          expect(lines.at(-1)).toMatchObject({ type: 'syncComplete', seq: through })
          expect(
            lines.filter((line) => line.type === 'feedDelta').flatMap((line) => line.changes),
          ).toMatchObject([{ entity: kind, entityId: id, op: 'remove' }])
        }
        if (kind === 'issuePanelArtifact') {
          const state = await feed.state.forBatch!([{ entity: kind, entityId: id }])
          expect(state.shapeFor!(owner, { entity: kind, entityId: id }, value)).toBeUndefined()
        }
      } finally {
        await store.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}
