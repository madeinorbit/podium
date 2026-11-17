/**
 * THE ORPHAN AUDIT (POD-6963 design 2.9, POD-7057).
 *
 * One workspace's files over the in-memory bucket, whose clock ages objects,
 * and its rows in a real store. The audit lists the workspace's prefix and
 * deletes what nothing references once it is a day old: artifact members no
 * panel or claim names, staging and composer uploads with no row, lake parts
 * past their incarnation's cursor (a shrink a crash left half done) and keys of
 * no owner's shape. It keeps everything young, everything referenced, and
 * every key under `transcripts/` that is not a lake part.
 */

import { type BlobKey, blobKey, LOCAL_WORKSPACE_ID } from '@podium/blob-store'
import { MemoryBlobStorage, MemoryBucket } from '@podium/blob-store/memory'
import {
  type ArtifactId,
  asArtifactId,
  asIssueId,
  asIssuePanelItemId,
  asMachineId,
  asUserId,
  asWorkspaceId,
  type IssueId,
  type IssuePanelArtifactWire,
  type MachineId,
} from '@podium/model'
import { type LakeSegment, PartedLake } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { issueRowFixture } from '../../test-support/issue-row'
import { openTestStore } from '../../test-support/open-test-store'
import { expectArmed, expectConstantStatements } from '../../test-support/statement-count'
import { PendingUploadStore } from '../issues/pending-uploads'
import {
  auditWorkspaceFiles,
  lakePart,
  ORPHAN_MIN_AGE_MS,
  OrphanAudit,
  type OrphanAuditRecords,
} from './orphan-audit'

const DAY = ORPHAN_MIN_AGE_MS
const HOUR = 60 * 60 * 1000
/** A small part size, so a few bytes span several parts. */
const P = 10
const AT = '2026-11-17T00:00:00Z'
const M1 = asMachineId('m1')
const ALICE = asUserId('user:alice')
const scope = fixtureWriteScope()

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

/** The audit's records over one store, as the relay composes them. */
function auditRecords(store: SessionStore, lake = true): OrphanAuditRecords {
  return {
    pendingUploads: store.pendingUploads,
    artifactUploads: store.artifactUploads,
    panelArtifacts: async (issueIds) =>
      (await store.issues.panel.forIssues(
        'issuePanelArtifact',
        issueIds,
      )) as IssuePanelArtifactWire[],
    ...(lake ? { lake: store.conversations.mirror } : {}),
  }
}

interface Fixture {
  store: SessionStore
  bucket: MemoryBucket
  storage: MemoryBlobStorage
  files: ReturnType<MemoryBlobStorage['forWorkspace']>
  lake: PartedLake
  pending: PendingUploadStore
  /** Move the bucket's and the uploads' clock. */
  at(ms: number): void
  put(key: string, text?: string): Promise<BlobKey>
  keys(): string[]
  /** An issue with one panel entry per artifact id. */
  issue(id: string, artifacts: readonly string[]): Promise<IssueId>
  /** A segment row whose active incarnation (sequence 1) has `cursor` mirrored bytes. */
  segment(nativeId: string, cursor: number, machine?: MachineId): Promise<void>
  /** Retire the active incarnation with `archived` bytes; the next one starts at `cursor`. */
  rotate(nativeId: string, archived: number, cursor: number): Promise<void>
  /** Write `count` parts of an incarnation. */
  parts(segment: LakeSegment, from: number, to: number): Promise<void>
  audit(options?: { lake?: boolean }): ReturnType<OrphanAudit['run']>
}

async function fixture(): Promise<Fixture> {
  let clock = 0
  const store = await openTestStore(':memory:')
  opened.push(store)
  const bucket = new MemoryBucket({ now: () => clock })
  const storage = new MemoryBlobStorage(bucket)
  const files = storage.forWorkspace(LOCAL_WORKSPACE_ID)
  const lake = new PartedLake(files, LOCAL_WORKSPACE_ID, { partBytes: P })
  const pending = new PendingUploadStore({
    files,
    records: store.pendingUploads,
    now: () => clock,
  })
  const mirror = store.conversations.mirror
  return {
    store,
    bucket,
    storage,
    files,
    lake,
    pending,
    at(ms) {
      clock = ms
    },
    async put(key, text = 'x') {
      const k = blobKey(key)
      await files.put(k, new TextEncoder().encode(text))
      return k
    },
    keys() {
      const prefix = `${LOCAL_WORKSPACE_ID}/`
      return bucket.names().map((name) => name.slice(prefix.length))
    },
    async issue(id, artifacts) {
      const issueId = asIssueId(id)
      await store.issues.upsertIssue(
        scope,
        issueRowFixture({
          id,
          seq: Number(id.replace(/\D/g, '')) || 1,
          parentId: null,
          machineId: null,
          worktreePath: null,
          createdAt: AT,
        }),
      )
      for (const [position, artifactId] of artifacts.entries()) {
        await store.issues.panel.save(scope, 'issuePanelArtifact', {
          id: asIssuePanelItemId(`${id}-panel-${position}`),
          issueId,
          position,
          path: `shot-${position}.png`,
          addedAt: AT,
          artifactId: asArtifactId(artifactId),
          entry: 'a.png',
          files: [{ path: 'a.png', size: 1 }],
        })
      }
      return issueId
    },
    async segment(nativeId, cursor, machine = M1) {
      await store.conversations.registry.ensure({
        machineId: machine,
        nativeId,
        providerId: 'claude-code-jsonl',
        path: `/native/${nativeId}.jsonl`,
        sizeBytes: cursor,
      })
      await mirror.startIncarnation(machine, nativeId, { device: '1', inode: '1' }, AT)
      if (cursor > 0)
        expect(await mirror.setMirrorCursor(machine, nativeId, 0, cursor, AT)).toBe(true)
    },
    async rotate(nativeId, archived, cursor) {
      const active = await mirror.activeIncarnation(M1, nativeId)
      if (!active) throw new Error('no active incarnation')
      expect(
        await mirror.rotateIncarnation(
          M1,
          nativeId,
          active,
          { device: '1', inode: String(active.sequence + 1) },
          archived,
          AT,
        ),
      ).toBe(true)
      expect(await mirror.setMirrorCursor(M1, nativeId, 0, cursor, AT)).toBe(true)
    },
    async parts(segment, from, to) {
      for (let part = from; part < to; part++) {
        await files.put(lake.partKey(segment, part), new Uint8Array(P).fill(part))
      }
    },
    async audit(options = {}) {
      return await new OrphanAudit(
        files,
        LOCAL_WORKSPACE_ID,
        auditRecords(store, options.lake ?? true),
        {
          now: () => clock,
          partBytes: P,
        },
      ).run()
    },
  }
}

const seg = (nativeId: string, incarnation = 1, machineId: MachineId = M1): LakeSegment => ({
  machineId,
  nativeId,
  incarnation,
})

describe('the orphan audit', () => {
  it('deletes artifact members no panel or claim names, and keeps the named and the young', async () => {
    const f = await fixture()
    const iss = await f.issue('iss_1', ['kept'])
    await f.put('artifacts/iss_1/kept/a.png')
    await f.put('artifacts/iss_1/kept/assets/b.css')
    await f.put('artifacts/iss_1/replaced/a.png')
    // A composer upload's claim names an artifact before its panel entry exists.
    const upload = await f.pending.put({
      ownerUserId: ALICE,
      filename: 'c.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
    })
    await f.pending.markClaimed(upload.id, { issueId: iss, artifactId: asArtifactId('claimed') })
    await f.put('artifacts/iss_1/claimed/c.png')
    // An issue whose row is gone (hard deleted): nothing names its artifacts.
    await f.put('artifacts/iss_gone/a1/x.md')
    // Keys of no owner's shape under the artifact root.
    await f.put('artifacts/iss_1/stray')
    await f.put('artifacts/~mfrgg/a1/x.md')
    f.at(DAY + HOUR)
    await f.put('artifacts/iss_1/fresh/a.png')

    const report = await f.audit()

    expect(f.keys().filter((k) => k.startsWith('artifacts/'))).toEqual([
      'artifacts/iss_1/claimed/c.png',
      'artifacts/iss_1/fresh/a.png',
      'artifacts/iss_1/kept/a.png',
      'artifacts/iss_1/kept/assets/b.css',
    ])
    expect(report.roots.artifacts).toEqual({
      listed: 8,
      young: 1,
      referenced: 3,
      deleted: 4,
      foreign: 0,
    })
  })

  it('deletes CLI staging and composer uploads whose rows are gone, and keeps those with rows', async () => {
    const f = await fixture()
    const live = '00000000-0000-4000-8000-000000000001'
    expect(
      await f.store.artifactUploads.begin({
        issueId: asIssueId('iss_1'),
        uploadId: live,
        beginJson: '{}',
        received: [1],
        createdAt: 0,
      }),
    ).toBe(true)
    await f.put(`artifacts/.uploads/iss_1/${live}/0000/000000000000`)
    await f.put('artifacts/.uploads/iss_1/00000000-0000-4000-8000-000000000002/0000/000000000000')
    await f.put('artifacts/.uploads/iss_1/meta.json')
    const kept = await f.pending.put({
      ownerUserId: ALICE,
      filename: 'a.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
    })
    // A write whose row never landed, and a second file beside a recorded one.
    await f.put('pending-uploads/00000000-0000-4000-8000-000000000003/file/b.png')
    await f.put(`pending-uploads/${kept.id}/file/other.png`)
    await f.put('pending-uploads/not-a-uuid/file/x')
    f.at(DAY + HOUR)

    const report = await f.audit()

    expect(f.keys()).toEqual([
      `artifacts/.uploads/iss_1/${live}/0000/000000000000`,
      `pending-uploads/${kept.id}/file/a.png`,
    ])
    expect(report.roots.artifacts).toMatchObject({ listed: 3, referenced: 1, deleted: 2 })
    expect(report.roots['pending-uploads']).toMatchObject({ listed: 4, referenced: 1, deleted: 3 })
  })

  it('deletes lake parts past each incarnation’s cursor and leaves keys of other shapes alone', async () => {
    const f = await fixture()
    // Active incarnation 2 holds 25 bytes (parts 0-2); incarnation 1 was archived at 10 (part 0).
    await f.segment('s1', 5)
    await f.rotate('s1', 10, 25)
    await f.parts(seg('s1', 1), 0, 2)
    await f.parts(seg('s1', 2), 0, 5)
    // A sequence no row knows, and a segment shrunk to zero whose delete crashed.
    await f.parts(seg('s1', 7), 0, 1)
    await f.segment('s2', 0)
    await f.parts(seg('s2'), 1, 3)
    // A part of a segment with no row at all.
    await f.parts(seg('ghost'), 0, 1)
    // A co-located daemon's file, and an old-layout lake file: not lake parts.
    await f.put('transcripts/m1/legacy.jsonl')
    await f.put('transcripts/daemon/cache/state/00000001')
    f.at(DAY + HOUR)
    // Written since: a pull in flight past the cursor, not yet advanced.
    await f.parts(seg('s1', 2), 5, 6)

    const report = await f.audit()

    expect(f.keys()).toEqual([
      'transcripts/daemon/cache/state/00000001',
      'transcripts/m1/legacy.jsonl',
      f.lake.partKey(seg('s1', 1), 0),
      f.lake.partKey(seg('s1', 2), 0),
      f.lake.partKey(seg('s1', 2), 1),
      f.lake.partKey(seg('s1', 2), 2),
      f.lake.partKey(seg('s1', 2), 5),
    ])
    expect(report.roots.transcripts).toEqual({
      listed: 14,
      young: 1,
      referenced: 4,
      deleted: 7,
      foreign: 2,
    })
  })

  it('does not audit the lake root while the lake is off', async () => {
    const f = await fixture()
    await f.parts(seg('ghost'), 0, 2)
    f.at(DAY + HOUR)
    const report = await f.audit({ lake: false })
    expect(f.keys()).toHaveLength(2)
    expect(report.roots.transcripts.listed).toBe(0)
  })

  it('is safe to run twice, one after the other and side by side', async () => {
    const f = await fixture()
    await f.issue('iss_1', ['kept'])
    await f.put('artifacts/iss_1/kept/a.png')
    for (let n = 0; n < 20; n++) await f.put(`artifacts/iss_1/orphan${n}/a.png`)
    await f.segment('s1', 15)
    await f.parts(seg('s1'), 0, 6)
    f.at(DAY + HOUR)

    const [one, two] = await Promise.all([f.audit(), f.audit()])
    expect(one.roots.artifacts.deleted + two.roots.artifacts.deleted).toBeGreaterThanOrEqual(20)
    const after = f.keys()
    expect(after).toEqual([
      'artifacts/iss_1/kept/a.png',
      f.lake.partKey(seg('s1'), 0),
      f.lake.partKey(seg('s1'), 1),
    ])
    const again = await f.audit()
    expect(again.roots.artifacts.deleted + again.roots.transcripts.deleted).toBe(0)
    expect(f.keys()).toEqual(after)
  })

  it('lists and deletes only inside the workspace it is given', async () => {
    const f = await fixture()
    const other = f.storage.forWorkspace(asWorkspaceId('ws_other'))
    const same = blobKey('artifacts/iss_1/orphan/a.png')
    await f.files.put(same, new Uint8Array([1]))
    await other.put(same, new Uint8Array([2]))
    await other.put(
      blobKey('pending-uploads/00000000-0000-4000-8000-000000000009/file/a'),
      new Uint8Array([3]),
    )
    f.at(DAY + HOUR)

    const report = await auditWorkspaceFiles(f.storage, LOCAL_WORKSPACE_ID, auditRecords(f.store), {
      now: () => DAY + HOUR,
    })

    expect(report.workspaceId).toBe(LOCAL_WORKSPACE_ID)
    expect(report.roots.artifacts).toMatchObject({ listed: 1, deleted: 1 })
    expect(report.roots['pending-uploads'].listed).toBe(0)
    expect(f.bucket.names()).toEqual([
      'ws_other/artifacts/iss_1/orphan/a.png',
      'ws_other/pending-uploads/00000000-0000-4000-8000-000000000009/file/a',
    ])
  })

  it('parses only the lake’s own part keys', () => {
    expect(lakePart(blobKey('transcripts/m1/~mfrgg/00000002/00000003'))).toEqual({
      machineId: 'm1',
      nativeId: 'abc',
      incarnation: 2,
      part: 3,
    })
    for (const key of [
      'transcripts/m1/s1.jsonl',
      'transcripts/m1/s1/2/00000003',
      'transcripts/m1/s1/00000002/00000003/x',
      // A valid key segment that is not the canonical encoding of any id.
      'transcripts/m1/~mfrgga/00000002/00000003',
      'artifacts/m1/s1/00000002/00000003',
    ]) {
      expect(lakePart(blobKey(key)), key).toBeUndefined()
    }
  })
})

/**
 * The audit's statements do not grow with the workspace (server-data rule 8):
 * one page of each upload table, one panel read for the issues the listing met,
 * one page of segments and one of archived incarnations.
 */
describe('the orphan audit statement count', () => {
  interface PinFixture {
    store: SessionStore
    audit: OrphanAudit
    files: ReturnType<MemoryBlobStorage['forWorkspace']>
  }

  const pin = {
    name: 'orphan audit of one workspace',
    async setup(size: number): Promise<PinFixture> {
      const f = await fixture()
      for (let n = 1; n <= size; n++) {
        const artifact: ArtifactId = asArtifactId(`a${n}`)
        await f.issue(`iss_${n}`, [artifact])
        await f.put(`artifacts/iss_${n}/${artifact}/a.png`)
        await f.put(`artifacts/iss_${n}/orphan${n}/a.png`)
        await f.segment(`s${n}`, P)
        await f.parts(seg(`s${n}`), 0, 2)
        await f.pending.put({
          ownerUserId: ALICE,
          filename: 'a.png',
          mediaType: 'image/png',
          bytes: new Uint8Array([n % 256]),
        })
      }
      f.at(DAY + HOUR)
      const audit = new OrphanAudit(f.files, LOCAL_WORKSPACE_ID, auditRecords(f.store), {
        now: () => DAY + HOUR,
        partBytes: P,
      })
      return { store: f.store, audit, files: f.files }
    },
    target: (fixture: PinFixture) => fixture.store,
    run: async (fixture: PinFixture) => await fixture.audit.run(),
    check(result: unknown, _fixture: PinFixture, size: number) {
      const report = result as Awaited<ReturnType<OrphanAudit['run']>>
      expect(report.roots.artifacts).toMatchObject({ referenced: size, deleted: size })
      expect(report.roots.transcripts).toMatchObject({ referenced: size, deleted: size })
      expect(report.roots['pending-uploads']).toMatchObject({ young: 0, referenced: size })
    },
  }

  it('runs the same five statements at 5 and at 200 issues, segments and uploads', async () => {
    await expectConstantStatements(pin, 5)
  })

  it('fails when a per-row read is planted on its path', async () => {
    await expectArmed(pin, 5, (fixture) => {
      const page = fixture.store.pendingUploads.page.bind(fixture.store.pendingUploads)
      const spy = vi
        .spyOn(fixture.store.pendingUploads, 'page')
        .mockImplementation(async (after, limit) => {
          const rows = await page(after, limit)
          for (const row of rows) await fixture.store.pendingUploads.get(row.id)
          return rows
        })
      return () => spy.mockRestore()
    })
  })
})
