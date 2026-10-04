import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chromium, type Browser } from '@playwright/test'
import { resolve } from 'node:path'

// A fake IDB cannot establish what happens when the owning document disappears.
// Serve only the production enqueue helper, with real Chromium storage.
let browser: Browser
let server: ReturnType<typeof Bun.serve>
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [resolve('packages/sync/src/adapters/indexeddb/write-batch.ts')],
    target: 'browser', format: 'esm',
  })
  if (!build.success) throw Error('Native write helper did not bundle')
  const source = await build.outputs[0]!.text()
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
    new URL(request.url).pathname === '/batch.js'
      ? new Response(source, { headers: { 'content-type': 'text/javascript' } })
      : new Response('<!doctype html><title>Native write boundary</title>', {
          headers: { 'content-type': 'text/html' },
        }),
  })
  browser = await chromium.launch({
    headless: true, executablePath: chromium.executablePath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
})
afterAll(async () => { await browser?.close(); server?.stop(true) })

for (const boundary of ['complete', 'reload', 'close'] as const) {
  test(`native batches keep all regions atomic through ${boundary}`, async () => {
    const context = await browser.newContext()
    try {
      const reader = await context.newPage()
      await reader.goto(`http://127.0.0.1:${server.port}/`)
      await reader.evaluate(async () => {
        const request = indexedDB.open('native-batch-boundary', 1)
        request.onupgradeneeded = () => {
          for (const name of ['entities', 'cursor', 'outbox']) request.result.createObjectStore(name, { keyPath: ['id'] })
        }
        const db = await new Promise<IDBDatabase>((yes, no) => { request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error) })
        const tx = db.transaction(['entities', 'cursor', 'outbox'], 'readwrite')
        const done = new Promise<void>((yes, no) => { tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error) })
        tx.objectStore('entities').put({ id: 'old', value: 'PRE' })
        tx.objectStore('cursor').put({ id: 'cursor', value: 'PRE' })
        tx.objectStore('outbox').put({ id: 'command', value: 'PRE' })
        await done; db.close()
      })
      const writer = await context.newPage()
      await writer.goto(`http://127.0.0.1:${server.port}/`)
      const initial = await writer.evaluate(async boundary => {
        // The helper is the exact production source bundled above.
        const { enqueueWrites } = await import('/batch.js')
        const request = indexedDB.open('native-batch-boundary', 1)
        const db = await new Promise<IDBDatabase>((yes, no) => { request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error) })
        const tx = db.transaction(['entities', 'cursor', 'outbox'], 'readwrite')
        const done = new Promise<void>((yes, no) => { tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error) })
        let issued = 0
        const objectStore = tx.objectStore.bind(tx)
        tx.objectStore = name => {
          const store = objectStore(name), put = store.put.bind(store), remove = store.delete.bind(store)
          store.put = (value, key) => { issued++; return put(value, key) }
          store.delete = key => { issued++; return remove(key) }
          return store
        }
        const ops = [
          { kind: 'delete', store: 'entities', key: ['old'] },
          ...Array.from({ length: 4096 }, (_, i) => ({ kind: 'put', store: 'entities', value: { id: `new-${i}`, value: 'x'.repeat(1024) } })),
          { kind: 'put', store: 'cursor', value: { id: 'cursor', value: 'POST' } },
          { kind: 'delete', store: 'outbox', key: ['command'] },
        ]
        const queued = enqueueWrites(tx, ops), initial = issued
        const committed = Promise.all([queued, done])
        if (boundary === 'complete') { await committed; db.close() }
        else committed.catch(() => undefined)
        return initial
      }, boundary)
      expect(initial).toBeGreaterThan(0)
      expect(initial).toBeLessThanOrEqual(256)
      if (boundary === 'reload') await writer.reload()
      if (boundary === 'close') await writer.close()
      const state = await reader.evaluate(async () => {
        const request = indexedDB.open('native-batch-boundary', 1)
        const db = await new Promise<IDBDatabase>((yes, no) => { request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error) })
        const tx = db.transaction(['entities', 'cursor', 'outbox'], 'readonly')
        const rows = await Promise.all(['entities', 'cursor', 'outbox'].map(name => new Promise<unknown[]>((yes, no) => {
          const request = tx.objectStore(name).getAll(); request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error)
        })))
        db.close(); return rows
      })
      if (state[0]!.length === 1 && boundary !== 'complete') {
        expect(state).toEqual([[{ id: 'old', value: 'PRE' }], [{ id: 'cursor', value: 'PRE' }], [{ id: 'command', value: 'PRE' }]])
      } else {
        expect(state[0]).toHaveLength(4096)
        expect(state[1]).toEqual([{ id: 'cursor', value: 'POST' }])
        expect(state[2]).toEqual([])
      }
    } finally { await context.close() }
  }, 30_000)
}
