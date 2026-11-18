/** POD-7122 diagnosis: what IndexedDB writes cost in this Chromium, by transaction count,
 *  durability hint and value size. Same N puts per case; one fresh database per case. */
import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'

const userLib = `${process.env.HOME}/.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu`
const env = { ...process.env }
if (existsSync(userLib)) env.LD_LIBRARY_PATH = userLib
else delete env.LD_LIBRARY_PATH
const browser = await chromium.launch({ headless: true, channel: 'chromium', env, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.route('http://bench.local/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>idb</title>' }))
await page.goto('http://bench.local/')
const cases = []
for (const size of ['marker', 'issue'])
  for (const transactions of [1, 20, 200, 2000])
    for (const durability of ['default', 'relaxed']) cases.push({ size, transactions, durability, puts: 20000 })
for (const c of cases) {
  const result = await page.evaluate(async ({ size, transactions, durability, puts }) => {
    const name = `bench-${size}-${transactions}-${durability}-${Math.random()}`
    const db = await new Promise((yes, no) => {
      const r = indexedDB.open(name, 1)
      r.onupgradeneeded = () => r.result.createObjectStore('s', { keyPath: ['p', 'k', 'i'] })
      r.onsuccess = () => yes(r.result)
      r.onerror = () => no(r.error)
    })
    const body = 'x'.repeat(size === 'issue' ? 900 : 40)
    const value = (i) => (size === 'issue'
      ? { p: 'u', k: 'issueProjection', i: `i${i}`, value: { id: `i${i}`, title: body, stage: 'backlog', repoId: 'r1', seq: i, updatedAt: '2026-11-01T00:00:00Z', labels: ['a', 'b'] }, asOf: 70 }
      : { p: 'u', k: `instance:issueUserState.ofIssue|main|issueProjection|{"issueId":"i${i}"}`, i: '', value: { completeAt: { feedId: 'f', epoch: 'e', seq: 70 }, collection: 'issueUserState.ofIssue', args: { issueId: `i${i}` }, part: 'main', via: 'issueProjection' } })
    const per = puts / transactions
    const began = performance.now()
    let main = 0
    for (let t = 0; t < transactions; t++) {
      const tx = db.transaction(['s'], 'readwrite', { durability })
      const store = tx.objectStore('s')
      const m = performance.now()
      for (let i = t * per; i < (t + 1) * per; i++) store.put(value(i))
      main += performance.now() - m
      await new Promise((yes, no) => { tx.oncomplete = yes; tx.onerror = () => no(tx.error) })
    }
    const ms = performance.now() - began
    db.close()
    indexedDB.deleteDatabase(name)
    return { ms, main }
  }, c)
  console.log(JSON.stringify({ ...c, ms: Math.round(result.ms), putMainMs: Math.round(result.main), usPerPut: Math.round((result.ms * 1000) / c.puts) }))
}
await browser.close()
