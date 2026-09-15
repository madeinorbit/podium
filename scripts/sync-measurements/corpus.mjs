/** Benchmark-only fixture. Uses the same store append seam as feed-bootstrap-scaling.test.ts. */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { writeFileSync, existsSync } from 'node:fs'

export async function generateCorpus(root, dbPath, { smoke = false } = {}) {
  if (existsSync(dbPath)) throw new Error(`Refusing to overwrite ${dbPath}`)
  const { openTestStore } = await import(pathToFileURL(resolve(root, 'apps/server/src/test-support/open-test-store.ts')).href)
  const store = await openTestStore(dbPath)
  try {
    const rows = smoke ? 16 : 5120
    const deltaRows = smoke ? 40 : 20000
    const payload = JSON.stringify({ text: 'x'.repeat(10 * 1024) })
    // Public repo rows give each transport the same visible slice. This corpus
    // measures payload scaling, not a realistic distribution of private grants.
    for (let start = 0; start < rows; start += 128) {
      await store.sync.appendChanges(Array.from({ length: Math.min(128, rows - start) }, (_, offset) => ({
        entity: 'repo', entityId: `measurement-repo-${start + offset}`, op: 'upsert', payload,
      })), Date.now())
    }
    const from = await store.sync.maxChangeSeq()
    // Repeated updates retain a full delta range without growing the world.
    for (let start = 0; start < deltaRows; start += 128) {
      await store.sync.appendChanges(Array.from({ length: Math.min(128, deltaRows - start) }, (_, offset) => ({
        entity: 'repo', entityId: `measurement-repo-${(start + offset) % rows}`, op: 'upsert', payload,
      })), Date.now())
    }
    const through = await store.sync.maxChangeSeq()
    if (through - from !== deltaRows) throw new Error('Delta range control failed')
    const latest = await store.sync.latestChangeStates()
    const scopedPayloadBytes = latest.reduce((n, row) => n + Buffer.byteLength(row.payload), 0)
    if (!smoke && scopedPayloadBytes < 50 * 1024 * 1024) throw new Error('World payload is below 50 MiB')
    const manifest = { schema: 1, rows, deltaRows, from, through, scopedPayloadBytes,
      payloadBytesPerRow: Buffer.byteLength(payload), shape: 'public repo rows, repeated ASCII x payload',
      scope: 'all fixture repo rows are visible to one ordinary user; no private-grant scaling claim' }
    writeFileSync(`${dbPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } finally { await store.close() }
}
