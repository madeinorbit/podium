/**
 * TWO WORKSPACES' FILES NEVER CROSS (POD-6963 design 2.2 and section 3; the file
 * part of POD-6966's isolation suite; POD-7057).
 *
 * Workspaces `ws_a` and `ws_b` share ONE in-memory bucket, as hosted workspaces
 * share one bucket with a prefix each (design 2.2, B1), and use the SAME ids
 * everywhere: issue `iss_1`, artifact `art1`, CLI upload ids, the composer
 * upload id, and lake segment `m1/s1`. So every relative key below exists in
 * both workspaces, and only the handle's prefix tells them apart.
 *
 * Both workspaces share ONE database too. Since the key migration (POD-7024)
 * every key of the issue, artifact, upload and segment tables leads with
 * `workspace_id`, so the same ids are two rows, one per workspace, beside the
 * same keys in the one bucket.
 *
 * For reads, writes, both sweeps, the orphan audit and the `/files` route: an
 * operation in one workspace sees, changes and deletes only that workspace's
 * objects, even where the other workspace holds the same key, and even where
 * the other workspace's rows are as old as its own.
 */

import { type BlobStore, blobKey } from '@podium/blob-store'
import { MemoryBlobStorage, MemoryBucket } from '@podium/blob-store/memory'
import {
  type ArtifactId,
  ArtifactUploadPacket,
  asArtifactId,
  asIssueId,
  asIssuePanelItemId,
  asMachineId,
  asUserId,
  asWorkspaceId,
  type IssuePanelArtifactWire,
  type WorkspaceId,
} from '@podium/model'
import { type LakeSegment, PartedLake } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { registerArtifactRoute } from '../../file-artifact-route'
import type { SessionStore } from '../../store'
import { issueRowFixture } from '../../test-support/issue-row'
import { openWorkspaceStores } from '../../test-support/workspace-stores'
import { type ArtifactRpc, IssueArtifactStore } from '../issues/artifact-store'
import {
  PENDING_UPLOAD_MAX_AGE_MS,
  PendingUploadStore,
  pendingUploadKey,
} from '../issues/pending-uploads'
import { auditWorkspaceFiles, type OrphanAuditRecords } from './orphan-audit'

const DAY = PENDING_UPLOAD_MAX_AGE_MS
const HOUR = 60 * 60 * 1000
const P = 8
const AT = '2026-11-17T00:00:00Z'
const ISSUE = asIssueId('iss_1')
const ARTIFACT = asArtifactId('art1')
const MACHINE = asMachineId('m1')
const SEGMENT: LakeSegment = { machineId: MACHINE, nativeId: 's1', incarnation: 1 }
/** The same client-chosen CLI upload ids in both workspaces. */
const PUBLISHED_UPLOAD = '00000000-0000-4000-8000-00000000000a'
const STAGED_UPLOAD = '00000000-0000-4000-8000-00000000000b'
const WS = { a: asWorkspaceId('ws_a'), b: asWorkspaceId('ws_b') } as const
type Tag = keyof typeof WS
const TAGS = ['a', 'b'] as const
const scope = fixtureWriteScope()
const text = (s: string) => new TextEncoder().encode(s)
/** Exactly 20 bytes: three parts at P = 8. */
const lakeBytes = (tag: string) => `lake bytes of ws ${tag}!!`
const noRpc: ArtifactRpc = {
  readAsset: async () => ({ ok: false, error: 'unused' }),
  listDir: async (input) => ({ ok: false, path: input.root, entries: [] }),
}

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

interface Workspace {
  id: WorkspaceId
  store: SessionStore
  files: BlobStore
  artifacts: IssueArtifactStore
  pending: PendingUploadStore
  lake: PartedLake
  records: OrphanAuditRecords
  /** The composer upload's id: the same in both workspaces. */
  uploadId: string
}

/** Every packet of a one-member CLI upload; committed or left staged. */
async function upload(
  artifacts: IssueArtifactStore,
  uploadId: string,
  body: string,
): Promise<void> {
  await artifacts.transfer(
    ISSUE,
    ArtifactUploadPacket.parse({
      action: 'begin',
      uploadId,
      path: 'report',
      entry: 'r.md',
      files: [{ path: 'r.md', size: body.length }],
    }),
  )
  await artifacts.transfer(
    ISSUE,
    ArtifactUploadPacket.parse({
      action: 'chunk',
      uploadId,
      file: 'r.md',
      offset: 0,
      dataBase64: Buffer.from(body).toString('base64'),
    }),
  )
}

async function readText(w: Workspace, artifactId: ArtifactId = ARTIFACT): Promise<string | null> {
  const found = await w.artifacts.readStream(ISSUE, artifactId, 'r.md')
  return found ? await new Response(found.body).text() : null
}

async function lakeText(w: Workspace): Promise<string> {
  const cursor = await w.store.conversations.mirror.mirrorCursor(MACHINE, SEGMENT.nativeId)
  const source = w.lake.source(SEGMENT, () => cursor)
  return new TextDecoder().decode(await source.read(0, await source.size()))
}

/**
 * Both workspaces, each seeded with its own bytes under the same ids: a
 * published artifact with a panel entry, a staged CLI upload, a composer
 * upload, and a mirrored lake segment of 20 bytes (three parts at P = 8).
 */
async function twoWorkspaces() {
  let clock = 0
  const bucket = new MemoryBucket({ now: () => clock })
  const storage = new MemoryBlobStorage(bucket)
  let composerId: string | undefined
  // ONE database for both workspaces: the same issue, artifact and segment ids are two rows
  // each, one per workspace (POD-7024). Closing the first store closes the database.
  const [first, second] = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  opened.push(first)
  const stores = { a: first, b: second } as const
  const make = async (tag: Tag): Promise<Workspace> => {
    const id = WS[tag]
    const store = stores[tag]
    const files = storage.forWorkspace(id)
    const artifacts = new IssueArtifactStore({
      files,
      uploads: store.artifactUploads,
      rpc: noRpc,
      now: () => clock,
    })
    const pending = new PendingUploadStore({
      files,
      records: store.pendingUploads,
      now: () => clock,
    })
    const lake = new PartedLake(files, id, { partBytes: P })
    const records: OrphanAuditRecords = {
      pendingUploads: store.pendingUploads,
      artifactUploads: store.artifactUploads,
      panelArtifacts: async (issueIds) =>
        (await store.issues.panel.forIssues(
          'issuePanelArtifact',
          issueIds,
        )) as IssuePanelArtifactWire[],
      lake: store.conversations.mirror,
    }

    await store.issues.upsertIssue(
      scope,
      issueRowFixture({
        id: ISSUE,
        parentId: null,
        machineId: null,
        worktreePath: null,
        createdAt: AT,
      }),
    )
    await upload(artifacts, PUBLISHED_UPLOAD, `report of ${tag}`)
    expect(await artifacts.publishUpload(ISSUE, PUBLISHED_UPLOAD, ARTIFACT)).toBeDefined()
    await store.issues.panel.save(scope, 'issuePanelArtifact', {
      id: asIssuePanelItemId('panel-1'),
      issueId: ISSUE,
      position: 0,
      path: 'report',
      addedAt: AT,
      artifactId: ARTIFACT,
      entry: 'r.md',
      files: [{ path: 'r.md', size: 11 }],
    })
    await upload(artifacts, STAGED_UPLOAD, `staged by ${tag}`)

    // The composer upload: minted in A, recorded under the same id in B.
    const owner = asUserId(`user:${tag}`)
    if (composerId === undefined) {
      composerId = (
        await pending.put({
          ownerUserId: owner,
          filename: 'pic.png',
          mediaType: 'image/png',
          bytes: text(`pic of ${tag}`),
        })
      ).id
    } else {
      const row = {
        id: composerId,
        ownerUserId: owner,
        filename: 'pic.png',
        entry: 'pic.png',
        mediaType: 'image/png',
        size: 8,
        createdAt: clock,
      }
      await files.put(pendingUploadKey(row), text(`pic of ${tag}`))
      expect(await store.pendingUploads.insert(row)).toBe(true)
    }

    const mirror = store.conversations.mirror
    await store.conversations.registry.ensure({
      machineId: MACHINE,
      nativeId: SEGMENT.nativeId,
      providerId: 'claude-code-jsonl',
      path: '/native/s1.jsonl',
      sizeBytes: 20,
    })
    await mirror.startIncarnation(MACHINE, SEGMENT.nativeId, { device: '1', inode: '1' }, AT)
    const writer = await lake.openWriter(SEGMENT, 0)
    await writer.append(text(lakeBytes(tag)))
    expect(await mirror.setMirrorCursor(MACHINE, SEGMENT.nativeId, 0, 20, AT)).toBe(true)

    return { id, store, files, artifacts, pending, lake, records, uploadId: composerId }
  }
  const a = await make('a')
  const b = await make('b')
  const keysOf = (ws: WorkspaceId) =>
    bucket
      .names()
      .filter((name) => name.startsWith(`${ws}/`))
      .map((name) => name.slice(ws.length + 1))
  return {
    a,
    b,
    bucket,
    storage,
    keysOf,
    at(ms: number) {
      clock = ms
    },
  }
}

describe('two workspaces over one bucket, with the same ids', () => {
  it('hold the same relative keys, and each reads only its own bytes', async () => {
    const t = await twoWorkspaces()
    expect(t.keysOf(WS.a)).toEqual(t.keysOf(WS.b))
    expect(t.keysOf(WS.a)).toEqual([
      `artifacts/.uploads/${ISSUE}/${STAGED_UPLOAD}/0000/000000000000`,
      `artifacts/${ISSUE}/${ARTIFACT}/r.md`,
      `pending-uploads/${t.a.uploadId}/file/pic.png`,
      t.a.lake.partKey(SEGMENT, 0),
      t.a.lake.partKey(SEGMENT, 1),
      t.a.lake.partKey(SEGMENT, 2),
    ])
    for (const tag of TAGS) {
      const w = t[tag]
      expect(await readText(w)).toBe(`report of ${tag}`)
      expect(
        new TextDecoder().decode(await w.pending.bytes({ id: w.uploadId, entry: 'pic.png' })),
      ).toBe(`pic of ${tag}`)
      expect(await lakeText(w)).toBe(lakeBytes(tag))
    }
  })

  it('change and delete only their own objects', async () => {
    const t = await twoWorkspaces()
    const before = new Map(t.bucket.objects)
    const ownB = () =>
      [...t.bucket.objects]
        .filter(([name]) => name.startsWith(`${WS.b}/`))
        .map(([n, o]) => [n, o.etag])
    const bEtags = ownB()

    // A replaces its artifact's bytes, extends its lake segment, claims and
    // moves its composer upload, then deletes its artifact and its issue's files.
    await t.a.files.put(blobKey(`artifacts/${ISSUE}/${ARTIFACT}/r.md`), text('rewritten'))
    const writer = await t.a.lake.openWriter(SEGMENT, 20)
    await writer.append(text('-more'))
    await t.a.artifacts.adopt({
      issueId: ISSUE,
      artifactId: asArtifactId('art2'),
      from: t.a.pending.fileKey({ id: t.a.uploadId, entry: 'pic.png' }),
      entry: 'pic.png',
    })
    expect(await readText(t.a)).toBe('rewritten')
    await t.a.artifacts.remove(ISSUE, ARTIFACT)
    await t.a.artifacts.removeIssue(ISSUE)

    expect(t.keysOf(WS.a).filter((k) => k.startsWith('artifacts/'))).toEqual([])
    expect(ownB()).toEqual(bEtags)
    for (const [name, object] of before) {
      if (name.startsWith(`${WS.b}/`)) expect(t.bucket.objects.get(name)).toBe(object)
    }
    expect(await readText(t.b)).toBe('report of b')
    expect(await t.b.store.artifactUploads.get(ISSUE, STAGED_UPLOAD)).toBeDefined()
    expect(await lakeText(t.b)).toBe(lakeBytes('b'))
  })

  it('sweep only their own uploads, though the other workspace’s rows are as old', async () => {
    const t = await twoWorkspaces()
    const bKeys = t.keysOf(WS.b)
    t.at(DAY + HOUR)

    expect(await t.a.pending.sweep()).toBe(1)
    await t.a.artifacts.sweepUploads()
    // Twice, as two processes before POD-6962's leases would.
    expect(await t.a.pending.sweep()).toBe(0)
    await t.a.artifacts.sweepUploads()

    expect(t.keysOf(WS.a)).toEqual([
      `artifacts/${ISSUE}/${ARTIFACT}/r.md`,
      t.a.lake.partKey(SEGMENT, 0),
      t.a.lake.partKey(SEGMENT, 1),
      t.a.lake.partKey(SEGMENT, 2),
    ])
    expect(t.keysOf(WS.b)).toEqual(bKeys)
    expect(await t.b.pending.meta(t.b.uploadId)).toBeDefined()
    expect(await t.b.store.artifactUploads.get(ISSUE, STAGED_UPLOAD)).toBeDefined()
  })

  it('audit only their own prefix: orphans go in one, identical keys stay in the other', async () => {
    const t = await twoWorkspaces()
    // The same orphans in both: an artifact no panel names, staging with no
    // row, and a lake part past the cursor.
    for (const tag of TAGS) {
      const w = t[tag]
      await w.files.put(blobKey(`artifacts/${ISSUE}/orphan/r.md`), text(`orphan of ${tag}`))
      await w.files.put(
        blobKey(
          `artifacts/.uploads/${ISSUE}/00000000-0000-4000-8000-00000000000c/0000/000000000000`,
        ),
        text('x'),
      )
      await w.files.put(w.lake.partKey(SEGMENT, 5), text('past'))
    }
    // B's panel names an artifact that exists only in A, as an orphan there.
    await t.a.files.put(blobKey(`artifacts/${ISSUE}/onlyb/r.md`), text('not b’s'))
    await t.b.store.issues.panel.save(scope, 'issuePanelArtifact', {
      id: asIssuePanelItemId('panel-2'),
      issueId: ISSUE,
      position: 1,
      path: 'other',
      addedAt: AT,
      artifactId: asArtifactId('onlyb'),
    })
    const bKeys = t.keysOf(WS.b)
    const aKept = t.keysOf(WS.a).filter((k) => !k.includes('orphan') && !k.includes('onlyb'))
    t.at(DAY + HOUR)

    const report = await auditWorkspaceFiles(t.storage, WS.a, t.a.records, {
      now: () => DAY + HOUR,
      partBytes: P,
    })
    await auditWorkspaceFiles(t.storage, WS.a, t.a.records, { now: () => DAY + HOUR, partBytes: P })

    expect(report.workspaceId).toBe(WS.a)
    expect(report.roots.artifacts.deleted).toBe(3)
    expect(report.roots.transcripts.deleted).toBe(1)
    expect(t.keysOf(WS.a)).toEqual(
      aKept.filter((k) => !k.includes('00000000000c') && k !== t.a.lake.partKey(SEGMENT, 5)),
    )
    expect(t.keysOf(WS.b)).toEqual(bKeys)
    expect(await readText(t.b)).toBe('report of b')
  })
})

describe('the /files route over two workspaces', () => {
  /** A fake POD-6960 binding: the request names its workspace in a header. */
  async function app() {
    const t = await twoWorkspaces()
    const server = new Hono()
    registerArtifactRoute(
      server,
      (ws) => (ws === WS.a ? t.a.artifacts : ws === WS.b ? t.b.artifacts : undefined),
      {
        bound: (c) => asWorkspaceId(c.req.header('x-bound-workspace') ?? 'none'),
        mayName: (c, segment) => segment === c.req.header('x-bound-workspace'),
      },
    )
    const get = (path: string, bound: string, headers: Record<string, string> = {}) =>
      server.request(path, { headers: { 'x-bound-workspace': bound, ...headers } })
    return { t, get }
  }

  const plain = `/files/artifact/${ISSUE}/${ARTIFACT}/r.md`
  const named = (ws: string) => `/files/artifact/workspace/${ws}/${ISSUE}/${ARTIFACT}/r.md`

  it('serves each request from its bound workspace only', async () => {
    const { get } = await app()
    for (const tag of TAGS) {
      const res = await get(plain, WS[tag])
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`report of ${tag}`)
      const prefixed = await get(named(WS[tag]), WS[tag])
      expect(await prefixed.text()).toBe(`report of ${tag}`)
      const ranged = await get(plain, WS[tag], { range: 'bytes=10-' })
      expect(ranged.status).toBe(206)
      expect(await ranged.text()).toBe(tag)
    }
  })

  it('answers not found for another workspace’s path, an unknown workspace, and a staging key', async () => {
    const { get } = await app()
    expect((await get(named(WS.b), WS.a)).status).toBe(404)
    expect((await get(named(WS.a), WS.b)).status).toBe(404)
    expect((await get(plain, 'ws_c')).status).toBe(404)
    expect(
      (await get(`/files/artifact/.uploads/${ISSUE}/${STAGED_UPLOAD}/0000/000000000000`, WS.a))
        .status,
    ).toBe(404)
  })

  it('keeps serving one workspace’s artifact after the other removed the same ids', async () => {
    const { t, get } = await app()
    await t.a.artifacts.remove(ISSUE, ARTIFACT)
    expect((await get(plain, WS.a)).status).toBe(404)
    const res = await get(plain, WS.b)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('report of b')
  })
})
