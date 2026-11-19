/** SQLite blocking-read/write and V8 retained-cache measurements, VM only.
 * Run through remote-lane; all inputs are seeded public synthetic fixtures. */
import { Database } from 'bun:sqlite'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadavg } from 'node:os'
import { chromium } from '@playwright/test'
import { SqliteSyncStore } from '../../../packages/sync/src/adapters/mobile-sqlite/store'
const policyRows = await import('./policy-rows.ts').then(m => m.policyRows, () => undefined)
const policies = await import('../../../apps/server/src/sync/policy.ts').then(m => m.SYNC_POLICIES, () => undefined)

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const mode = arg('mode', 'sqlite'), round = arg('round', '1'), sample = Number(arg('sample', '0'))
const cell = arg('cell', 'h1a1'), client = arg('client', 'phone')
const out = resolve(arg('out', `.artifacts/7095/${mode}-${cell}-${client}-r${round}-s${sample}.json`))
if (existsSync(out)) throw Error(`Evidence already exists: ${out}`)
mkdirSync(resolve(out, '..'), { recursive: true })
const input = readFileSync(`.artifacts/old-vs-new/rows-${cell}.json`)
const corpus = JSON.parse(readFileSync(`.artifacts/old-vs-new/corpus-${cell}.json`, 'utf8'))
const rows = JSON.parse(input), policy = policies?.[client]
const split = policyRows && policy ? policyRows(rows, policy, corpus.fixedNow) : { whole: rows, stubs: [] }
const held = [...split.whole, ...split.stubs.map(row => ({ ...row, part: 'stub' }))]
const result = { mode, cell, client, sample, round, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  harnessSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  rowsSha256: createHash('sha256').update(input).digest('hex'), startedAt: new Date().toISOString(), loadStart: loadavg(), rows: held.length, main: split.whole.length, stubs: split.stubs.length }
const operations = held.map(row => ({ kind: 'upsert', entity: row.entity, entityId: row.entityId, value: row.value, provenance: { seq: 1 }, ...(row.part ? { part: row.part } : {}) }))
async function completeInstances(values, specs) {
  const { HeldIndex, comesWithOf } = await import('../../../packages/sync/src/replica/holdings')
  const { instanceKey } = await import('../../../packages/sync/src/replica/cache-state')
  const markers = new Map(specs.map(spec => [instanceKey(spec), spec]))
  const byKey = new Map(values.map(row => [`${row.entity}\0${row.entityId}`, row]))
  const store = { readRow: (entity, id) => byKey.get(`${entity}\0${id}`) }
  for (let pass = 0; pass < 10; pass++) {
    const count = markers.size
    const index = new HeldIndex(markers.values(), { recentDays: policy.recentDays })
    for (const row of values) {
      if (row.part === 'stub') continue
      const memberships = index.matching(row.entity, row.value, store, corpus.fixedNow)
      for (const spec of comesWithOf(row.entity, row.value, memberships, corpus.fixedNow)) markers.set(instanceKey(spec), spec)
    }
    if (markers.size === count) return [...markers.values()]
  }
  throw Error('Fixture companion markers did not settle')
}
if (mode === 'sqlite') {
  const file = `${out}.sqlite`
  const sql = { calls: 0, ms: 0, selectMs: 0 }
  const timed = (fn, select = false) => (...args) => {
    const start = performance.now()
    try { return fn(...args) } finally { const ms = performance.now() - start; sql.ms += ms; sql.calls++; if (select) sql.selectMs += ms }
  }
  const openDatabase = () => {
    const db = new Database(file)
    return { exec: timed(db.exec.bind(db)), close: () => db.close(), prepare: query => {
      const stmt = db.prepare(query), select = /^\s*select/i.test(query)
      return { all: timed(stmt.all.bind(stmt), select), get: timed(stmt.get.bind(stmt), select), run: timed(stmt.run.bind(stmt)) }
    } }
  }
  const open = () => SqliteSyncStore.open({ openDatabase, deleteDatabase: () => { throw Error('Unexpected cache reset') }, onDegraded: value => { throw Error(JSON.stringify(value)) } })
  let store = await open()
  const cache = store.viewFor('operator').cache
  sql.ms = sql.calls = sql.selectMs = 0
  let start = performance.now()
  cache.applyAtomic({ operations, cursor: { feedId: 'measurement', epoch: 'one', seq: 1 } })
  result.initialWriteMs = performance.now() - start
  result.initialSqlMs = sql.ms
  result.initialSqlCalls = sql.calls
  store.close()
  sql.ms = sql.calls = sql.selectMs = 0
  start = performance.now()
  const opening = open()
  // All synchronous SQL runs before open() yields its resolved promise.
  result.startupBlockingMs = performance.now() - start
  store = await opening
  result.startupOpenMs = performance.now() - start
  result.startupSqlMs = sql.ms
  result.startupSelectMs = sql.selectMs
  result.startupSqlCalls = sql.calls
  const reopened = store.viewFor('operator').cache
  if (reopened.readEntities().length !== split.whole.length) throw Error('SQLite hydration population mismatch')
  const updates = split.whole.slice(0, 100).map(row => ({ kind: 'upsert', entity: row.entity, entityId: row.entityId, value: { ...row.value }, provenance: { seq: 2 } }))
  sql.ms = sql.calls = sql.selectMs = 0
  start = performance.now()
  reopened.applyAtomic({ operations: updates, cursor: { feedId: 'measurement', epoch: 'one', seq: 2 } })
  result.feed100WriteMs = performance.now() - start
  result.feed100SqlMs = sql.ms
  store.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true })
} else if (mode === 'cache' || mode === 'feed') {
  if (mode === 'cache' && !policy) throw Error('Cache experiment requires the collection policy candidate')
  const cap = Number(arg('cap', '1000'))
  const present = new Set(split.whole.map(row => `${row.entity}\0${row.entityId}`))
  const extra = mode === 'feed' ? [] : rows.filter(row => !present.has(`${row.entity}\0${row.entityId}`) && row.entity === 'issueProjection')
    .slice(0, Math.ceil((cap + 250) / 2)).flatMap(row => [row, {
      entity: 'issueBrief', entityId: row.entityId,
      value: { id: row.entityId, text: (`Synthetic opened brief ${row.entityId}. `).repeat(100).slice(0, 2048) },
    }])
  let instances = [...(policy?.steps ?? []).flatMap(step => step.collections.map(collection => ({ collection, part: collection.endsWith('.stubs') ? 'stub' : 'main' }))),
    ...extra.map(row => row.entity === 'issueBrief'
      ? { collection: 'issueBrief.ofIssue', part: 'main', args: { issueId: row.entityId } }
      : { collection: `${row.entity}.one`, part: 'main', args: { id: row.entityId } })]
  let payloadRows = [...held, ...extra]
  if (mode === 'cache') {
    const { collectionFixture } = await import('./collection-fixture.ts')
    const world = new Map([...rows, ...extra].map(row => [`${row.entity}\0${row.entityId}`, row]))
    const fixture = collectionFixture([...world.values()], corpus.fixedNow, policy.recentDays)
    const answer = fixture.close(instances)
    fixture.validate(answer)
    payloadRows = answer.rows
    instances = answer.markers
    result.rows = answer.rows.length
    result.main = answer.rows.filter(row => row.part !== 'stub').length
    result.stubs = answer.rows.filter(row => row.part === 'stub').length
    result.cacheInput = { rows: answer.rows.length, markers: answer.markers.length, fullCompanionClosure: true }
  } else if (policy) instances = await completeInstances(payloadRows, instances)
  const { instanceKey } = policy ? await import('../../../packages/sync/src/replica/cache-state') : {}
  // The same hundred sidebar issues in BOTH arms, not the first hundred
  // residents of each different policy. Membership fields are unchanged.
  const updateIds = rows.filter(row => row.entity === 'issueProjection' &&
    ['backlog', 'planning', 'in_progress', 'review'].includes(row.value.stage) &&
    !row.value.archived && !row.value.deletedAt && !row.value.isDraftVessel).slice(0, 100).map(row => row.entityId)
  const payload = { rows: payloadRows, policy, instances: mode === 'cache' ? instances : instances.map(spec => ({kind:'mark',instance:{...spec,key:instanceKey(spec),completeAt:{feedId:'measurement',epoch:'one',seq:1}}})), now: corpus.fixedNow, cap, updateIds }
  if (mode === 'feed') result.feedIdsSha256 = createHash('sha256').update(JSON.stringify(updateIds)).digest('hex')
  const server = Bun.serve({ port: 0, fetch(req) {
    const name = new URL(req.url).pathname
    if (name === '/favicon.ico') return new Response(null, { status: 204 })
    const path = resolve('.artifacts/7095/cache-build', '.' + (name === '/' ? `/device-${mode === 'feed' ? 'feed' : 'cache'}.html` : name))
    if (!existsSync(path)) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(path))
  } })
  const env = { ...process.env }, libs = `${process.env.HOME}/.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu`
  if (existsSync(libs)) env.LD_LIBRARY_PATH = libs
  else delete env.LD_LIBRARY_PATH
  const browser = await chromium.launch({ channel: 'chromium', headless: true, env, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    await page.goto(`http://127.0.0.1:${server.port}`)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
    if (mode === 'cache') {
      await page.waitForFunction(() => typeof window.measureDeviceCache === 'function')
      result.cache = await page.evaluate(payload => window.measureDeviceCache(payload), payload)
      await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage')
      result.heap = await cdp.send('Runtime.getHeapUsage')
    } else {
      await page.waitForFunction(() => typeof window.measureDeviceFeed === 'function')
      result.feedSetup = await page.evaluate(payload => window.measureDeviceFeed(payload), payload)
      const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]))
      result.feed = await page.evaluate(() => window.runDeviceFeed())
      const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]))
      result.feed.mainThreadMs = (after.TaskDuration - before.TaskDuration) * 1000
    }
    result.chromium = browser.version()
    if (errors.length) throw Error(errors.join('\n'))
  } finally { await browser.close(); server.stop(true) }
} else throw Error('Unknown mode')
result.endedAt = new Date().toISOString()
writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
console.log('DEVICE_COST ' + JSON.stringify(result))
