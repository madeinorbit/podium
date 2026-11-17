import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type BlobStore, LOCAL_WORKSPACE_ID } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { type ChainEntry, fileByteSource, fileChainSource, fileIdFor } from '@podium/harness/store'
import { asMachineId, type MachineId } from '@podium/model'
import { type LakeSegment, PartedLake } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { transcriptRecordMapperFor } from '../harness-manifest'
import { DaemonRequestBroker } from '../modules/daemon-request'
import { TranscriptLake } from '../modules/memory/lake'
import { openTestStore } from '../test-support/open-test-store'
import {
  convertLakeToParts,
  LAKE_CONVERSION_MARGIN_BYTES,
  LAKE_PARTS_CONVERSION_MARKER,
  LakeConversionNoSpace,
  type LakePartsConversionOptions,
} from './lake-parts-conversion'

/** A small part size, so a few kilobytes span several parts. */
const P = 1000
const AT = '2026-11-17T00:00:00Z'
const machineId = asMachineId('m1')

const silent = { info: () => {}, warn: () => {} }

interface Fixture {
  stateDir: string
  store: Awaited<ReturnType<typeof openTestStore>>
  blobs: BlobStore
  lake: PartedLake
  /** Write a legacy lake file at `transcripts/<machine>/<name>`. */
  legacy(name: string, bytes: Buffer, machine?: MachineId): string
  /** A segment row with `cursor` mirrored bytes. */
  segment(
    nativeId: string,
    cursor: number,
    incarnation?: boolean,
    machine?: MachineId,
  ): Promise<void>
  /** Retire the active incarnation with `archived` bytes and start sequence + 1. */
  rotate(
    nativeId: string,
    sequence: number,
    archived: number,
    cursor: number,
    machine?: MachineId,
  ): Promise<void>
  /** Every stored byte of one incarnation. */
  stored(segment: LakeSegment): Promise<Buffer>
  run(overrides?: Partial<LakePartsConversionOptions>): ReturnType<typeof convertLakeToParts>
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function fixture(partBytes = P): Promise<Fixture> {
  const stateDir = mkdtempSync(join(tmpdir(), 'podium-lake-conversion-'))
  const store = await openTestStore(':memory:')
  const blobs = new LocalBlobStorage({ stateDir }).forWorkspace(LOCAL_WORKSPACE_ID)
  const lake = new PartedLake(blobs, LOCAL_WORKSPACE_ID, { partBytes })
  cleanups.push(
    () => rmSync(stateDir, { recursive: true, force: true }),
    () => store.close(),
  )
  const mirror = store.conversations.mirror
  return {
    stateDir,
    store,
    blobs,
    lake,
    legacy(name, bytes, machine = machineId) {
      const path = join(stateDir, 'transcripts', machine, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
      return path
    },
    async segment(nativeId, cursor, incarnation = true, machine = machineId) {
      await store.conversations.registry.ensure({
        machineId: machine,
        nativeId,
        providerId: 'claude-code-jsonl',
        path: `/native/${nativeId}.jsonl`,
        sizeBytes: cursor,
      })
      if (incarnation) {
        await mirror.startIncarnation(machine, nativeId, { device: '1', inode: '1' }, AT)
      }
      expect(await mirror.setMirrorCursor(machine, nativeId, 0, cursor, AT)).toBe(true)
    },
    async rotate(nativeId, sequence, archived, cursor, machine = machineId) {
      const active = await mirror.activeIncarnation(machine, nativeId)
      if (!active) throw new Error('no active incarnation')
      expect(
        await mirror.rotateIncarnation(
          machine,
          nativeId,
          active,
          { device: '1', inode: String(sequence + 1) },
          archived,
          AT,
        ),
      ).toBe(true)
      const expected = await mirror.activeIncarnation(machine, nativeId)
      expect(expected?.sequence).toBe(sequence + 1)
      expect(await mirror.setMirrorCursor(machine, nativeId, 0, cursor, AT)).toBe(true)
    },
    async stored(segment) {
      const source = lake.source(segment, () => 2 ** 30)
      return Buffer.from(await source.read(0, await source.size()))
    },
    run(overrides = {}) {
      return convertLakeToParts({
        stateDir,
        rows: mirror,
        blobs,
        workspaceId: LOCAL_WORKSPACE_ID,
        log: silent,
        freeBytes: () => Number.MAX_SAFE_INTEGER,
        partBytes,
        pageSize: 2,
        ...overrides,
      })
    },
  }
}

function bytesOf(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) % 251
  return out
}

describe('the lake parts conversion', () => {
  it('converts canonical and archived incarnation files and a row-less legacy segment', async () => {
    const f = await fixture()
    // A segment mirrored before incarnation rows existed: its bytes are sequence 1.
    const rowless = bytesOf(2500, 1)
    await f.segment('rowless', rowless.length, false)
    const rowlessPath = f.legacy('rowless.jsonl', rowless)
    // A segment rotated once: sequence 1 archived, sequence 2 active (exactly two parts).
    const archived = bytesOf(1700, 2)
    const active = bytesOf(2 * P, 3)
    await f.segment('rotated', archived.length)
    await f.rotate('rotated', 1, archived.length, active.length)
    const archivedPath = f.legacy('rotated.incarnation-1.jsonl', archived)
    const activePath = f.legacy('rotated.jsonl', active)

    const result = await f.run()

    expect(result).toMatchObject({ skipped: false, segments: 2, archived: 1, converted: 3 })
    expect(result.bytes).toBe(rowless.length + archived.length + active.length)
    expect(
      (await f.stored({ machineId, nativeId: 'rowless', incarnation: 1 })).equals(rowless),
    ).toBe(true)
    expect(
      (await f.stored({ machineId, nativeId: 'rotated', incarnation: 1 })).equals(archived),
    ).toBe(true)
    expect(
      (await f.stored({ machineId, nativeId: 'rotated', incarnation: 2 })).equals(active),
    ).toBe(true)
    for (const path of [rowlessPath, archivedPath, activePath]) expect(existsSync(path)).toBe(false)
    // Parts are 8-digit padded keys under the incarnation.
    expect(
      existsSync(join(f.stateDir, 'transcripts', 'm1', 'rotated', '00000002', '00000001')),
    ).toBe(true)
    expect(
      existsSync(join(f.stateDir, 'transcripts', 'm1', 'rotated', '00000002', '00000002')),
    ).toBe(false)

    const marker = JSON.parse(readFileSync(join(f.stateDir, LAKE_PARTS_CONVERSION_MARKER), 'utf8'))
    expect(marker).toMatchObject({ layout: 'parted', converted: 3 })
    // Later boots skip the step.
    expect(await f.run()).toMatchObject({ skipped: true, converted: 0 })
  })

  it('resumes a run killed mid-segment and ends byte-identical', async () => {
    const f = await fixture()
    const first = bytesOf(1500, 4)
    const second = bytesOf(4200, 5)
    await f.segment('first', first.length)
    await f.segment('second', second.length)
    f.legacy('first.jsonl', first)
    const secondPath = f.legacy('second.jsonl', second)
    // Parts a mirror wrote above the source's end before the conversion existed.
    const secondSegment = { machineId, nativeId: 'second', incarnation: 1 }
    await f.blobs.put(f.lake.partKey(secondSegment, 5), bytesOf(P, 6))
    await f.blobs.put(f.lake.partKey(secondSegment, 6), bytesOf(9, 6))

    // The process dies after the first file and two parts of the second.
    let puts = 0
    const dying: BlobStore = {
      conditionalWrites: f.blobs.conditionalWrites,
      list: (prefix) => f.blobs.list(prefix),
      copy: (from, to, opts) => f.blobs.copy(from, to, opts),
      put: async (key, body, opts) => {
        puts += 1
        if (puts > 4) throw new Error('killed')
        return await f.blobs.put(key, body, opts)
      },
      get: (key, range) => f.blobs.get(key, range),
      head: (key) => f.blobs.head(key),
      delete: (key, opts) => f.blobs.delete(key, opts),
    }
    await expect(f.run({ blobs: dying })).rejects.toThrow('killed')
    expect(existsSync(secondPath)).toBe(true)
    expect(existsSync(join(f.stateDir, LAKE_PARTS_CONVERSION_MARKER))).toBe(false)

    const result = await f.run()
    expect(result).toMatchObject({ converted: 1, absent: 1 })
    expect((await f.stored({ machineId, nativeId: 'first', incarnation: 1 })).equals(first)).toBe(
      true,
    )
    expect((await f.stored({ machineId, nativeId: 'second', incarnation: 1 })).equals(second)).toBe(
      true,
    )
    expect(await f.blobs.head(f.lake.partKey(secondSegment, 5))).toBeUndefined()
    expect(await f.blobs.head(f.lake.partKey(secondSegment, 6))).toBeUndefined()
    expect(existsSync(secondPath)).toBe(false)
  })

  it('refuses on insufficient free space with the number it needs', async () => {
    const f = await fixture()
    const small = bytesOf(300, 7)
    const large = bytesOf(3300, 8)
    await f.segment('small', small.length)
    await f.segment('large', large.length)
    const smallPath = f.legacy('small.jsonl', small)
    const largePath = f.legacy('large.jsonl', large)

    const refused = f.run({ freeBytes: () => 1000 })
    await expect(refused).rejects.toBeInstanceOf(LakeConversionNoSpace)
    await expect(refused).rejects.toMatchObject({
      neededBytes: large.length + LAKE_CONVERSION_MARGIN_BYTES,
      freeBytes: 1000,
      largestPath: largePath,
    })
    // Nothing moved, and the next boot tries again.
    expect(readFileSync(smallPath).equals(small)).toBe(true)
    expect(readFileSync(largePath).equals(large)).toBe(true)
    expect(
      await f.blobs.head(f.lake.partKey({ machineId, nativeId: 'small', incarnation: 1 }, 0)),
    ).toBe(undefined)
    expect(existsSync(join(f.stateDir, LAKE_PARTS_CONVERSION_MARKER))).toBe(false)

    // Enough for the largest file plus the margin, not for the whole lake.
    expect(
      await f.run({ freeBytes: () => large.length + LAKE_CONVERSION_MARGIN_BYTES }),
    ).toMatchObject({ converted: 2 })
  })

  it('leaves files that no row names untouched', async () => {
    const f = await fixture()
    const named = bytesOf(1200, 9)
    await f.segment('named', named.length)
    f.legacy('named.jsonl', named)
    // A segment with no mirrored bytes names no lake file.
    await f.segment('unmirrored', 0)
    const others = [
      f.legacy('unmirrored.jsonl', bytesOf(50, 10)),
      f.legacy('no-row.jsonl', bytesOf(60, 11)),
      f.legacy('named.incarnation-1.jsonl', bytesOf(70, 12)),
      // A co-located daemon's own files under the same root.
      f.legacy('state.json', bytesOf(80, 13), asMachineId('daemon')),
      f.legacy('named.jsonl', bytesOf(90, 14), asMachineId('m2')),
    ]
    const before = others.map((path) => readFileSync(path))

    expect(await f.run()).toMatchObject({ converted: 1, segments: 1, archived: 0 })

    others.forEach((path, i) => {
      expect(readFileSync(path).equals(before[i] as Buffer)).toBe(true)
    })
    expect(
      await f.blobs.head(f.lake.partKey({ machineId, nativeId: 'unmirrored', incarnation: 1 }, 0)),
    ).toBeUndefined()
  })

  it('leaves a file whose ids cannot form a lake key in place and still finishes', async () => {
    const f = await fixture()
    // Longer than the 158 UTF-8 bytes an encoded key segment can hold.
    const longId = 'é'.repeat(100)
    const bytes = bytesOf(500, 16)
    const ordinary = bytesOf(700, 17)
    await f.segment(longId, bytes.length)
    await f.segment('ordinary', ordinary.length)
    const longPath = f.legacy(`${longId}.jsonl`, bytes)
    f.legacy('ordinary.jsonl', ordinary)

    expect(await f.run()).toMatchObject({ converted: 1, unaddressable: 1 })
    expect(readFileSync(longPath).equals(bytes)).toBe(true)
    expect(
      (await f.stored({ machineId, nativeId: 'ordinary', incarnation: 1 })).equals(ordinary),
    ).toBe(true)
    expect(existsSync(join(f.stateDir, LAKE_PARTS_CONVERSION_MARKER))).toBe(true)
  })

  it('converts a source shorter than its cursor as it is', async () => {
    const f = await fixture()
    const bytes = bytesOf(1400, 15)
    await f.segment('short', 5000)
    f.legacy('short.jsonl', bytes)

    expect(await f.run()).toMatchObject({ converted: 1, bytes: bytes.length })
    expect((await f.stored({ machineId, nativeId: 'short', incarnation: 1 })).equals(bytes)).toBe(
      true,
    )
    // Readers see min(cursor, stored size): the guard repairs the cursor on the next pull.
    expect(await f.lake.readableSize({ machineId, nativeId: 'short', incarnation: 1 }, 5000)).toBe(
      bytes.length,
    )
  })

  it('serves the same transcript items before and after', async () => {
    // The real part size, with transcripts that span several parts.
    const f = await fixture(1024 * 1024)
    const mapper = transcriptRecordMapperFor('claude-code')
    if (!mapper) throw new Error('claude-code grammar missing')
    const record = (n: number, text: string) =>
      `${JSON.stringify({
        type: 'user',
        uuid: `u-${n}`,
        timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(),
        message: { role: 'user', content: `${text} ${n} ${'x'.repeat(40_000)}` },
      })}\n`
    const transcript = (from: number, count: number, text: string) =>
      Buffer.from(Array.from({ length: count }, (_, i) => record(from + i, text)).join(''))
    const archived = transcript(0, 40, 'archived')
    const active = transcript(40, 60, 'active')
    const rowless = transcript(100, 30, 'rowless')
    await f.segment('chain', archived.length)
    await f.rotate('chain', 1, archived.length, active.length)
    await f.segment('legacy', rowless.length, false)
    const paths = {
      archived: f.legacy('chain.incarnation-1.jsonl', archived),
      active: f.legacy('chain.jsonl', active),
      rowless: f.legacy('legacy.jsonl', rowless),
    }

    // Before: the pre-parts reader, a file chain over the legacy files.
    const readFiles = async (chain: ChainEntry[]) =>
      (await fileChainSource(chain, mapper).readSlice({ direction: 'before', limit: 1000 })).items
    const beforeChain = await readFiles([
      { source: fileByteSource(paths.archived), fileId: fileIdFor('chain', 1) },
      { source: fileByteSource(paths.active), fileId: fileIdFor('chain') },
    ])
    const beforeLegacy = await readFiles([
      { source: fileByteSource(paths.rowless), fileId: fileIdFor('legacy') },
    ])
    expect(beforeChain).toHaveLength(100)
    expect(beforeLegacy).toHaveLength(30)

    expect(await f.run()).toMatchObject({ converted: 3 })

    const lake = new TranscriptLake(
      {
        store: f.store.conversations,
        now: Date.now,
        daemonRequest: new DaemonRequestBroker({
          toMachine: () => {},
          defaultMachine: () => machineId,
        }),
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async () => undefined,
      },
      { transcriptLake: { blobs: f.blobs, workspaceId: LOCAL_WORKSPACE_ID } },
    )
    cleanups.push(() => lake.dispose())
    const read = async (nativeId: string) =>
      (
        await lake.readWindow(
          {
            machineId,
            agentKind: 'claude-code',
            resume: { kind: 'claude-session', value: nativeId },
          },
          { direction: 'before', limit: 1000 },
        )
      )?.items
    expect(await read('chain')).toEqual(beforeChain)
    expect(await read('legacy')).toEqual(beforeLegacy)
  })

  it('pages the work list in key order across many pages, skipping and repeating no row', async () => {
    const f = await fixture()
    const second = asMachineId('m2')
    // Two machines, ids that sort differently from their insertion order, rows
    // with no mirrored bytes between them (filtered out of the pages), segments
    // rotated several times (their archived rows span page boundaries), and
    // row-less segments (no active incarnation).
    const segments: { machine: MachineId; nativeId: string; cursor: number }[] = []
    const archived: { machine: MachineId; nativeId: string; sequence: number }[] = []
    for (const machine of [second, machineId]) {
      for (let n = 0; n < 9; n += 1) {
        const nativeId = `s-${(n * 7) % 9}`
        const cursor = n % 4 === 0 ? 0 : 100 + n
        const rotations = n % 3
        await f.segment(nativeId, cursor, n !== 5, machine)
        for (let sequence = 1; sequence <= rotations && n !== 5; sequence += 1) {
          // Every other rotation archives zero bytes: those rows are filtered.
          const bytes = sequence % 2 === 0 ? 0 : 50 + sequence
          await f.rotate(nativeId, sequence, bytes, cursor, machine)
          if (bytes > 0) archived.push({ machine, nativeId, sequence })
        }
        if (cursor > 0) segments.push({ machine, nativeId, cursor })
      }
    }
    const byKey = (a: readonly string[], b: readonly string[]) =>
      a.join('\0') < b.join('\0') ? -1 : 1
    segments.sort((a, b) => byKey([a.machine, a.nativeId], [b.machine, b.nativeId]))
    archived.sort((a, b) =>
      byKey(
        [a.machine, a.nativeId, String(a.sequence).padStart(4, '0')],
        [b.machine, b.nativeId, String(b.sequence).padStart(4, '0')],
      ),
    )
    expect(segments.length).toBeGreaterThan(9)
    expect(archived.length).toBeGreaterThan(3)

    // The repository's pages, three rows each, walked by their last key.
    const mirror = f.store.conversations.mirror
    const pagedSegments: { machineId: MachineId; nativeId: string }[] = []
    let pages = 0
    for (let after: { machineId: MachineId; nativeId: string } | undefined; ; pages += 1) {
      const page = await mirror.lakeConversionSegments(after, 3)
      pagedSegments.push(...page)
      const last = page.at(-1)
      if (last === undefined || page.length < 3) break
      after = { machineId: last.machineId, nativeId: last.nativeId }
    }
    expect(pages).toBeGreaterThan(3)
    expect(pagedSegments.map((row) => `${row.machineId}/${row.nativeId}`)).toEqual(
      segments.map((row) => `${row.machine}/${row.nativeId}`),
    )
    for (const row of await mirror.lakeConversionSegments(undefined, 100)) {
      const active = await mirror.activeIncarnation(row.machineId, row.nativeId)
      expect(row.activeSequence).toBe(active?.sequence)
      expect(row.mirroredBytes).toBe(
        segments.find((s) => s.machine === row.machineId && s.nativeId === row.nativeId)?.cursor,
      )
    }

    const pagedArchived: { machineId: MachineId; nativeId: string; sequence: number }[] = []
    for (let after: (typeof pagedArchived)[number] | undefined; ; ) {
      const page = await mirror.lakeConversionArchived(after, 2)
      pagedArchived.push(...page)
      const last = page.at(-1)
      if (last === undefined || page.length < 2) break
      after = { machineId: last.machineId, nativeId: last.nativeId, sequence: last.sequence }
    }
    expect(pagedArchived.map((row) => `${row.machineId}/${row.nativeId}#${row.sequence}`)).toEqual(
      archived.map((row) => `${row.machine}/${row.nativeId}#${row.sequence}`),
    )

    // The conversion over the same rows, at a page size that splits them.
    for (const row of segments)
      f.legacy(`${row.nativeId}.jsonl`, bytesOf(row.cursor, 1), row.machine)
    for (const row of archived) {
      f.legacy(`${row.nativeId}.incarnation-${row.sequence}.jsonl`, bytesOf(60, 2), row.machine)
    }
    expect(await f.run({ pageSize: 3 })).toMatchObject({
      segments: segments.length,
      archived: archived.length,
      converted: segments.length + archived.length,
      absent: 0,
    })
  })
})
