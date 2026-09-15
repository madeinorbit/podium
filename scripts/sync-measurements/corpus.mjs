/** Benchmark-only fixture. Uses the same store append seam as feed-bootstrap-scaling.test.ts. */

import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Fixed xorshift seed per row; 2,200 distinct base64-alphabet symbols carry
// about 1,650 bytes of entropy in a 10 KiB text field (roughly 6x compression).
export function rowPayload(index) {
  let state = (0x6d2b79f5 ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let unique = ''
  for (let i = 0; i < 2200; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    unique += alphabet[state >>> 26]
  }
  return JSON.stringify({ text: unique + 'x'.repeat(10 * 1024 - unique.length) })
}

export async function generateCorpus(root, dbPath, { smoke = false } = {}) {
  if (existsSync(dbPath)) throw new Error(`Refusing to overwrite ${dbPath}`)
  const { openTestStore } = await import(
    pathToFileURL(resolve(root, 'apps/server/src/test-support/open-test-store.ts')).href
  )
  const store = await openTestStore(dbPath)
  try {
    const rows = smoke ? 16 : 5120
    const deltaRows = smoke ? 40 : 20000
    const payload = rowPayload(0)
    const digest = createHash('sha256')
    // Public repo rows give each transport the same visible slice. This corpus
    // measures payload scaling, not a realistic distribution of private grants.
    for (let start = 0; start < rows; start += 128) {
      await store.sync.appendChanges(
        Array.from({ length: Math.min(128, rows - start) }, (_, offset) => ({
          entity: 'repo',
          entityId: `measurement-repo-${start + offset}`,
          op: 'upsert',
          payload: rowPayload(start + offset),
        })),
        Date.now(),
      )
    }
    const from = await store.sync.maxChangeSeq()
    // Repeated updates retain a full delta range without growing the world.
    for (let start = 0; start < deltaRows; start += 128) {
      await store.sync.appendChanges(
        Array.from({ length: Math.min(128, deltaRows - start) }, (_, offset) => ({
          entity: 'repo',
          entityId: `measurement-repo-${(start + offset) % rows}`,
          op: 'upsert',
          payload: rowPayload((start + offset) % rows),
        })),
        Date.now(),
      )
    }
    const through = await store.sync.maxChangeSeq()
    if (through - from !== deltaRows) throw new Error('Delta range control failed')
    const latest = await store.sync.latestChangeStates()
    const scopedPayloadBytes = latest.reduce((n, row) => n + Buffer.byteLength(row.payload), 0)
    if (!smoke && scopedPayloadBytes < 50 * 1024 * 1024)
      throw new Error('World payload is below 50 MiB')
    for (let i = 0; i < rows; i++) digest.update(rowPayload(i))
    const manifest = {
      schema: 2,
      seed: 'xorshift32:6d2b79f5',
      entropyCharacters: 2200,
      payloadSha256: digest.digest('hex'),
      targetZstdRatio: [5, 7],
      rows,
      deltaRows,
      from,
      through,
      scopedPayloadBytes,
      payloadBytesPerRow: Buffer.byteLength(payload),
      shape: 'public repo rows, unique seeded entropy plus repeated text; target roughly 6x Zstd',
      scope:
        'all fixture repo rows are visible to one ordinary user; no private-grant scaling claim',
    }
    writeFileSync(`${dbPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } finally {
    await store.close()
  }
}
