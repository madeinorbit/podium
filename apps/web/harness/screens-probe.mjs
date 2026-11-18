/**
 * POD-7163 — THE SCREENS PROBE: open every main screen in the production web
 * and phone builds, move between them, reopen them offline, and report per
 * screen what the opening asked the server for, how long it showed LOADING,
 * its longest main-thread task and the heap after a GC.
 *
 * Two modes, one walk:
 * - operator (default): the harness server (tests/e2e/serve-harness.ts) with
 *   the synthetic operator corpus (measurement-corpus.ts: 8,687 issues, 6,941
 *   sessions, a 970-issue mission) served through the first download and the
 *   collection route at the same boundaries as the server (staged-bootstrap,
 *   collection-fixture), above every device budget. Runs on an agent VM under
 *   remote-lane's lock, never on ludovico. Driver: screens-probe.py.
 * - --live=<url>: the live install, read-only. A short session is minted
 *   (`podium auth mint-session --print-only`); every write is refused at the
 *   network (any non-GET request but the collection route, and command frames
 *   on the socket) and counted.
 *
 * The walk: startup to the sidebar; then the deck (the largest mission),
 * the board, an issue page, search (the board's task filter) and the sidebar,
 * cold; the same again, warm (moving between them); then offline (the
 * browser's network cut) the same again, in-app, without a reload. On the
 * phone: its Work list, then the mission's details, cold, warm and offline.
 *
 * Per screen: data requests (/sync/ and issue search, attempts offline
 * included), load hops (a request asked for once an earlier one's answer was
 * in, the unit tests' rule), LOADING ms (from the action to the screen's ready
 * DOM), the longest main-thread task (Long Tasks API, 50 ms and up), and the
 * JS heap after two forced GCs.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, loadavg } from 'node:os'
import { resolve } from 'node:path'
import { chromium, devices } from '@playwright/test'

const arg = (key, fallback) => process.argv.find((x) => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const live = arg('live', '')
const out = resolve(arg('out', `.artifacts/screens-probe/${live ? 'live' : 'operator'}-${Date.now()}`))
const surfaces = arg('surfaces', 'web,phone').split(',').filter(Boolean)
const timeoutMs = Number(arg('timeout-ms', '60000'))
if (!live && hostname() === 'ludovico') throw Error('The operator-size probe runs on an agent VM, never on ludovico')
if (existsSync(resolve(out, 'run.json'))) throw Error('Probe output already exists; use a fresh --out')
mkdirSync(out, { recursive: true })

/** The declared hop maxima (design POD-7157, "Testing rules"). */
const DECLARED_HOPS = { sidebar: 0, deck: 2, board: 1, issuePage: 2, search: 1, phoneMission: 2 }

const sha = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return null } })()
const result = { version: 1, mode: live ? 'live' : 'operator', sha, host: arg('host', hostname()), startedAt: new Date().toISOString(),
  loadStart: loadavg(), surfaces, screens: [], blockedWrites: [], errors: [], status: 'running' }
const save = () => writeFileSync(resolve(out, 'run.json'), JSON.stringify(result, null, 2) + '\n')
save()
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------- operator data
let server, base, corpus, extraRows, memberId, seq = 0, meta, seeded = false
const fixtures = new Map()
let collectionFixture, augmentAnswer
if (!live) {
  ;({ collectionFixture } = await import('./collection-fixture.ts'))
  ;({ augmentAnswer } = await import('./staged-bootstrap.mjs'))
  corpus = JSON.parse(readFileSync('.artifacts/old-vs-new/corpus-operator.json', 'utf8'))
  const port = Number(arg('port', '19581'))
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, PORT: String(port), PODIUM_NO_RELAY: '1' }
  for (const key of Object.keys(env)) if (/^PODIUM_(SESSION|AGENT|CODEX_HOOK|ISSUE_RELAY|INSTANCE|HOME|STATE_DIR|AGENT_HOME|SERVER|PORT)/.test(key)) delete env[key]
  server = spawn(process.execPath, ['--conditions=@podium/source', 'tests/e2e/serve-harness.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  // A setup failure must not leave the harness running on the shared VM.
  process.on('exit', () => { if (server.exitCode === null) server.kill('SIGKILL') })
  let log = ''
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => { log = (log + data).slice(-20000) })
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw Error(`Harness exited ${server.exitCode}: ${log.slice(-2000)}`)
    try { if ((await fetch(`${base}/health`)).ok) break } catch {}
    if (i > 360) throw Error('Harness did not become healthy')
    await pause(500)
  }
  memberId = (await (await fetch(`${base}/auth/status`)).json()).memberId
  const model = await import('@podium/model')
  extraRows = JSON.parse(readFileSync('.artifacts/old-vs-new/rows-operator.json', 'utf8')).map((row) => {
    const value = { ...row.value }
    if (['issueUserState', 'sessionUserState'].includes(row.entity)) value.userId = memberId
    return { ...row, value, entityId: row.entity === 'issueUserState' ? model.issueUserStateRowId(memberId, value.entityId)
      : row.entity === 'sessionUserState' ? model.sessionUserStateRowId(memberId, value.sessionId) : row.entityId }
  })
  for (const days of [7, 30]) fixtures.set(days, collectionFixture(extraRows, corpus.fixedNow, days))
  // The staged answer extends the server's own first download, which must have
  // moved past the fixture's seq range first (cold-start.mjs's same guard).
  const rpc = async (path, input) => {
    const response = await fetch(`${base}/trpc/${path}`, input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!response.ok) throw Error(`${path} ${response.status}: ${await response.text()}`)
    return (await response.json()).result.data
  }
  let repoPath
  for (let i = 0; !repoPath; i++) {
    repoPath = (await rpc('repos.list')).find((x) => x.includes('zz-podium-e2e-repo-')) ?? undefined
    if (i > 120) throw Error('Harness repository did not become ready')
    if (!repoPath) await pause(250)
  }
  for (let i = 0; ; i++) {
    const first = (await (await fetch(`${base}/sync/bootstrap`, { headers: { 'Podium-Client-Type': 'browser' } })).text()).split('\n')[0]
    if (JSON.parse(first).seq >= 64) break
    if (i > 60) throw Error('The harness feed never passed seq 64')
    await rpc('issues.create', { repoPath, title: `Probe filler ${i}`, description: 'Moves the feed past the fixture range', parentBranch: 'main', startNow: false })
  }
}

/** The corpus targets: the 970-issue mission, a closed issue nobody shows, a search term. */
function operatorTargets() {
  const trees = [...corpus.measurementTrees].sort((a, b) => b.size - a.size)
  const tree = trees[0]
  const inTree = new Set(trees.flatMap((t) => t.ids))
  const old = corpus.issues.filter((x) => !inTree.has(x.id) && (x.closedAt || x.stage === 'done') && !x.archived && !x.deletedAt && x.title)
  const titles = new Map()
  for (const x of corpus.issues) titles.set(x.title, (titles.get(x.title) ?? 0) + 1)
  const unique = old.filter((x) => titles.get(x.title) === 1)
  const page = unique[0], search = unique[1]
  if (!tree || !page || !search) throw Error('The operator corpus lacks a probe target')
  const issue = corpus.issues.find((x) => x.id === tree.root)
  return {
    deck: { id: tree.root, title: tree.title, repoPath: issue?.repoPath, childIds: tree.ids.filter((id) => id !== tree.root) },
    issuePage: { id: page.id, title: page.title },
    search: { id: search.id, title: search.title },
  }
}

// ---------------------------------------------------------------- contexts
async function bindOperator(context, surface) {
  let policyDays = surface === 'phone' ? 7 : 30
  const fixtureFor = (days) => fixtures.get(days) ?? fixtures.get(30)
  await context.route('**/sync/bootstrap*', async (route) => {
    const response = await route.fetch()
    const records = (await response.text()).trim().split('\n').map((x) => JSON.parse(x))
    const first = records[0]
    if (first?.type !== 'syncMeta' || first.mode !== 'snapshot' || !first.policy) return route.fulfill({ response })
    policyDays = first.policy.recentDays
    const requested = JSON.parse(new URL(route.request().url()).searchParams.get('view') ?? '[]')
    const prepared = augmentAnswer(records, fixtureFor(policyDays), requested)
    const chunk = records.find((x) => x.type === 'feedBootstrap')
    meta = { ...chunk }; seq = meta.seq; seeded = true
    const headers = { ...response.headers(), 'content-type': 'application/x-ndjson' }
    for (const key of ['content-length', 'content-encoding', 'transfer-encoding']) delete headers[key]
    await route.fulfill({ status: 200, headers, body: prepared.body })
  })
  await context.route('**/sync/collections', async (route) => {
    const request = route.request().postDataJSON()
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    const records = (await response.text()).trim().split('\n').map((x) => JSON.parse(x))
    const prepared = augmentAnswer(records, fixtureFor(policyDays), request.instances)
    const headers = { ...response.headers(), 'content-type': 'application/x-ndjson' }
    for (const key of ['content-length', 'content-encoding', 'transfer-encoding']) delete headers[key]
    await route.fulfill({ status: 200, headers, body: prepared.body })
  })
  // Server search knows only the harness's own rows: answer the corpus's
  // titles too (a title substring), as the server's search would. tRPC
  // batches procedures into one path, so patch the search inside a batch.
  await context.route('**/trpc/**', async (route) => {
    const url = new URL(route.request().url())
    const procedures = decodeURIComponent(url.pathname.slice(url.pathname.indexOf('/trpc/') + 6)).split(',')
    if (!procedures.includes('issues.searchNormalized')) return route.fallback()
    const response = await route.fetch()
    let json
    try { json = await response.json() } catch { return route.fulfill({ response }) }
    let input = {}
    try { input = JSON.parse(url.searchParams.get('input') ?? '{}') } catch {}
    const batched = url.searchParams.get('batch') === '1'
    procedures.forEach((procedure, at) => {
      if (procedure !== 'issues.searchNormalized') return
      const raw = batched ? input[String(at)] : input
      const text = String(raw?.json?.text ?? raw?.text ?? '').trim().toLowerCase()
      const hits = text.length < 2 ? [] : corpus.issues.filter((x) => String(x.title ?? '').toLowerCase().includes(text)).slice(0, 50).map((x) => ({ id: x.id }))
      const entry = batched ? json[at] : json
      const data = entry?.result?.data
      const page = data?.json ?? data
      if (page && Array.isArray(page.hits)) { page.hits = [...hits, ...page.hits].slice(0, 50); page.next = null }
    })
    await route.fulfill({ response, json })
  })
  await context.route('**/trpc/discovery.refreshRepos*', async (route) => {
    const response = await route.fetch(), json = await response.json()
    if (json.result?.data?.repositories) { json.result.data.repositories = [...corpus.repos, ...json.result.data.repositories]; json.result.data.machines = [...corpus.machines, ...(json.result.data.machines ?? [])] }
    await route.fulfill({ response, json })
  })
  // The staged first download moved the feed's seq: renumber live deltas after it.
  await context.routeWebSocket('**', (client) => {
    const upstream = client.connectToServer()
    client.onClose(() => upstream.close())
    upstream.onMessage((message) => {
      if (typeof message !== 'string') return client.send(message)
      let frame
      try { frame = JSON.parse(message) } catch { return client.send(message) }
      if (frame.type === 'machinesChanged') frame.machines = [...corpus.machines, ...frame.machines]
      if (frame.type === 'feedDelta' && seeded) {
        const size = Math.max(1, frame.seq - frame.fromSeq), start = seq
        seq += size
        frame = { ...frame, fromSeq: start, seq, changes: frame.changes.map((row, index) => ({ ...row, seq: start + index + 1 })) }
      }
      client.send(JSON.stringify(frame))
    })
  })
}

async function bindLive(context) {
  // Read-only: every write is refused before it leaves the browser.
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'GET' || request.method() === 'HEAD' || url.pathname === '/sync/collections') return route.fallback()
    result.blockedWrites.push({ method: request.method(), path: url.pathname }); save()
    return route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**', (client) => {
    const upstream = client.connectToServer()
    client.onClose(() => upstream.close())
    client.onMessage((message) => {
      if (typeof message === 'string') {
        let type
        try { type = JSON.parse(message).type } catch {}
        if (typeof type === 'string' && /submit|mutat|command|write|update/i.test(type)) {
          result.blockedWrites.push({ socket: type }); save()
          return
        }
      }
      upstream.send(message)
    })
  })
}

const INIT = ({ fixedNow }) => {
  if (fixedNow) { const start = performance.now(); Date.now = () => fixedNow + Math.floor(performance.now() - start) }
  localStorage.setItem('podium.panelMode', 'chat')
  window.__syncTimeline = []
  window.__longTasks = []
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__longTasks.push({ start: entry.startTime, duration: entry.duration }) })
      .observe({ type: 'longtask', buffered: true })
  } catch {}
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(href, location.href).pathname
    const data = path.startsWith('/sync/') || path.includes('issues.search')
    if (!data) return nativeFetch(input, init)
    const entry = { path, startMs: performance.now(), collections: null }
    try { const body = init?.body; if (typeof body === 'string') entry.collections = [...new Set((JSON.parse(body).instances ?? []).map((x) => x.collection))] } catch {}
    window.__syncTimeline.push(entry)
    try {
      const response = await nativeFetch(input, init)
      entry.status = response.status
      if (!response.body) { entry.endMs = performance.now(); return response }
      const counter = new TransformStream({ flush() { entry.endMs = performance.now() } })
      return new Response(response.body.pipeThrough(counter), { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      entry.endMs = performance.now(); entry.failed = String(error).slice(0, 120)
      throw error
    }
  }
}

async function makeContext(browser, surface) {
  const context = await browser.newContext(surface === 'phone'
    ? { ...devices['Pixel 7'], serviceWorkers: 'block' }
    : { viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  if (live) {
    const token = execFileSync('podium', ['auth', 'mint-session', '--print-only', '--ttl', '20m'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!token) throw Error('No session minted')
    const secure = live.startsWith('https:')
    await context.addCookies([{ name: secure ? '__Secure-podium.session_token' : 'podium.session_token', value: token, url: live, secure }])
    await bindLive(context)
  } else await bindOperator(context, surface)
  const page = await context.newPage()
  page.setDefaultTimeout(timeoutMs)
  page.on('pageerror', (error) => result.errors.push({ surface, message: error.message.slice(0, 300) }))
  await page.addInitScript(INIT, { fixedNow: live ? 0 : corpus.fixedNow })
  const cdp = await context.newCDPSession(page)
  return { context, page, cdp, surface }
}

// ---------------------------------------------------------------- measuring a screen
function hopsOf(entries) {
  const sorted = [...entries].sort((a, b) => a.startMs - b.startMs)
  const hop = new Map()
  for (const entry of sorted) {
    // A search query is the screen's question, not a load: a request, never a hop.
    if (entry.path.includes('issues.search')) { hop.set(entry, 0); continue }
    let deepest = 0
    for (const earlier of sorted) if (earlier !== entry && earlier.endMs !== undefined && earlier.endMs <= entry.startMs) deepest = Math.max(deepest, hop.get(earlier) ?? 0)
    hop.set(entry, deepest + 1)
  }
  return Math.max(0, ...hop.values())
}

async function measure(f, screen, phase, go, ready, readyArg) {
  const t0 = await f.page.evaluate(() => performance.now())
  let ok = true, failure
  try {
    await go()
    await f.page.waitForFunction(ready, readyArg, { timeout: timeoutMs, polling: 'raf' })
  } catch (error) { ok = false; failure = String(error).split('\n')[0].slice(0, 300) }
  const t1 = await f.page.evaluate(() => performance.now())
  await pause(1500) // what the opening asks for after it painted belongs to it too
  const { entries, longest } = await f.page.evaluate((t0) => ({
    entries: window.__syncTimeline.filter((x) => x.startMs >= t0),
    longest: Math.max(0, ...window.__longTasks.filter((x) => x.start + x.duration >= t0).map((x) => x.duration)),
  }), t0)
  await f.cdp.send('HeapProfiler.collectGarbage'); await pause(100); await f.cdp.send('HeapProfiler.collectGarbage')
  const heap = await f.cdp.send('Runtime.getHeapUsage')
  const row = { surface: f.surface, phase, screen, ready: ok, loadingMs: Math.round(t1 - t0), requests: entries.length,
    collectionsRequests: entries.filter((x) => x.path === '/sync/collections').length, hops: hopsOf(entries),
    // Startup carries the first download, and the phone's Work list is the way
    // to the mission: neither is judged by a screen's hops.
    declaredHops: phase === 'startup' || screen === 'phoneWork' ? undefined : DECLARED_HOPS[screen], longestTaskMs: Math.round(longest), heapAfterGcMiB: +(heap.usedSize / 1048576).toFixed(1),
    collections: [...new Set(entries.flatMap((x) => x.collections ?? []))], failure }
  result.screens.push(row); save()
  if (!ok) await f.page.screenshot({ path: resolve(out, `${f.surface}-${phase}-${screen}.png`) }).catch(() => {})
  // What the screen showed instead: its columns and cards, for the report.
  if (!ok) row.shown = await f.page.evaluate((target) => ({
    columns: [...document.querySelectorAll('[data-kanban-column]')].map((c) => ({ column: c.getAttribute('data-kanban-column'), cards: c.querySelectorAll('[data-issue-id]').length, text: c.textContent.slice(0, 120) })),
    cards: document.querySelectorAll('[data-issue-id]').length,
    target: target?.id ? !!document.querySelector(`[data-issue-id="${target.id}"]`) : null,
    text: document.body.innerText.slice(0, 600),
  }), readyArg).catch((error) => String(error)), save()
  console.log(`${f.surface} ${phase} ${screen}: ready=${ok} LOADING ${row.loadingMs} ms, ${row.requests} requests, ${row.hops} hops, longest task ${row.longestTaskMs} ms, heap ${row.heapAfterGcMiB} MiB${failure ? ' — ' + failure : ''}`)
  return row
}

/** In-app navigation: the router follows history, so nothing reloads (works offline). */
const navigate = (page, path) => page.evaluate((path) => {
  const url = new URL(path, location.href); url.search = location.search
  history.pushState(null, '', url.pathname + url.search); dispatchEvent(new PopStateEvent('popstate'))
}, path)

// Ready predicates, evaluated in the page.
const visible = `(e)=>{if(!e||e.closest('[aria-hidden="true"]'))return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight}`
const READY = {
  sidebar: new Function(`const visible=${visible};return [...document.querySelectorAll('aside [data-issue-row]')].some(visible)&&!document.querySelector('[data-testid="pool-row-loading"]')`),
  deck: new Function('t', `const visible=${visible};if(document.querySelector('[data-testid="flight-settling"],[aria-label="Loading mission progress"]'))return false;
    if(![...document.querySelectorAll('.deck-header')].some(h=>(t.title===null||h.textContent.includes(t.title))&&visible(h)))return false;
    const ids=t.childIds?new Set(t.childIds):null;return [...document.querySelectorAll('[data-testid="flight-deck-scroller"] [data-flight-issue]:not([aria-busy="true"])')].some(e=>(ids===null||ids.has(e.getAttribute('data-flight-issue')))&&visible(e))`),
  board: new Function(`const visible=${visible};const col=document.querySelector('[data-testid="issue-column"][data-kanban-column="done"]');
    if(col)return visible(col)&&!/…/.test(col.querySelector('header,h2,h3')?.textContent??col.textContent.slice(0,80))&&(!!col.querySelector('[data-issue-id]')||/Nothing in Done/.test(col.textContent));
    const list=document.querySelector('[data-testid="issues-list"]');return !!list&&!!list.querySelector('[data-issue-id]')`),
  issuePage: new Function('t', `const visible=${visible};const p=document.querySelector('[data-testid="issue-page"]');return !!p&&visible(p)&&p.textContent.includes(t.title)&&visible(document.querySelector('[data-testid="issue-aside"]'))`),
  // The hit's card, wherever its column is (Done sits right of the viewport).
  search: new Function('t', `return [...document.querySelectorAll('[data-issue-id="'+t.id+'"]')].some(e=>e.getClientRects().length>0&&!e.closest('[aria-busy="true"]'))`),
  phoneWork: new Function(`return !!document.querySelector('[aria-label="Search work"]')&&!document.querySelector('[aria-label="Loading work"],[data-testid="bootstrap-placeholder"]')`),
  phoneMission: new Function('t', `const visible=${visible};if(document.querySelector('[aria-label="Loading task detail"],[aria-label="Loading task"]'))return false;
    if(!location.pathname.endsWith('/details'))return false;
    return visible(document.querySelector('[aria-label="Fold every branch"],[aria-label="Expand every branch"]'))&&!/Mission not found/.test(document.body.innerText)`),
}

// ---------------------------------------------------------------- the walk
async function webWalk(browser, targets) {
  const f = await makeContext(browser, 'web')
  const origin = live || base
  const query = live ? '' : `?server=${encodeURIComponent(base.replace('http', 'ws'))}&e2e=1`
  await measure(f, 'sidebar', 'startup', () => f.page.goto(`${origin}/${query}`, { waitUntil: 'domcontentloaded' }), READY.sidebar)
  if (live) Object.assign(targets, await liveTargets(f))
  const openDeck = async () => {
    await navigate(f.page, '/')
    const row = f.page.locator(`aside [data-issue-row="${targets.deck.id}"]`).first()
    if (!(await row.count()) && targets.deck.repoPath) {
      const group = f.page.getByTestId('project-group').filter({ has: f.page.getByTestId('project-group-label').filter({ hasText: targets.deck.repoPath.split('/').at(-1) }) }).first()
      if ((await group.getAttribute('data-collapsed').catch(() => null)) === 'true') await group.getByTestId('project-group-label').click()
    }
    await row.scrollIntoViewIfNeeded()
    await row.click()
    await f.page.waitForFunction((title) => [...document.querySelectorAll('button[aria-label="Open flight deck"]')].some((e) => e.getClientRects().length) ||
      [...document.querySelectorAll('.deck-header')].some((h) => title !== null && h.textContent?.includes(title)), targets.deck.title, { timeout: 30000 }).catch(() => {})
    const open = f.page.getByRole('button', { name: 'Open flight deck', exact: true })
    if (await open.isVisible().catch(() => false)) await open.click()
  }
  const steps = [
    ['deck', openDeck, READY.deck, targets.deck],
    ['board', () => navigate(f.page, '/issues'), READY.board],
    ['issuePage', () => navigate(f.page, `/issues/${targets.issuePage.id}`), READY.issuePage, targets.issuePage],
    ['search', async () => { await navigate(f.page, '/issues'); await f.page.getByLabel('Search tasks').fill(targets.search.title) }, READY.search, targets.search],
    ['sidebar', async () => { await f.page.getByLabel('Search tasks').fill('').catch(() => {}); await navigate(f.page, '/') }, READY.sidebar],
  ]
  for (const phase of ['cold', 'warm', 'offline']) {
    if (phase === 'offline') await f.context.setOffline(true)
    for (const [screen, go, ready, readyArg] of steps) await measure(f, screen, phase, go, ready, readyArg)
  }
  await f.context.setOffline(false)
  await f.context.close()
}

async function phoneWalk(browser, targets) {
  const f = await makeContext(browser, 'phone')
  const origin = live || base
  const query = live ? '' : `?server=${encodeURIComponent(base.replace('http', 'ws'))}&e2e=1`
  await measure(f, 'phoneWork', 'startup', () => f.page.goto(`${origin}/mobile/work${query}`, { waitUntil: 'domcontentloaded' }), READY.phoneWork)
  for (const phase of ['cold', 'warm', 'offline']) {
    if (phase === 'offline') await f.context.setOffline(true)
    await measure(f, 'phoneMission', phase, () => navigate(f.page, `/mobile/mission/${targets.deck.id}/details`), READY.phoneMission, targets.deck)
    await measure(f, 'phoneWork', phase, () => navigate(f.page, '/mobile/work'), READY.phoneWork)
  }
  await f.context.setOffline(false)
  await f.context.close()
}

/** Live: the first sidebar root with a deck, and two done tasks from the board. */
async function liveTargets(f) {
  const deck = await f.page.evaluate(() => {
    const row = document.querySelector('aside [data-issue-row]')
    return { id: row?.getAttribute('data-issue-row'), title: null, childIds: null }
  })
  await navigate(f.page, '/issues')
  await f.page.waitForFunction(READY.board, undefined, { timeout: timeoutMs })
  const done = await f.page.evaluate(() => [...document.querySelectorAll('[data-kanban-column="done"] [data-issue-id]')].slice(0, 2)
    // A card reads "<ref> <title> …": the title's first words find it, and are on its page.
    .map((e) => ({ id: e.getAttribute('data-issue-id'), title: e.textContent.trim().replace(/^[A-Z]+-\d+\s*/, '').slice(0, 20).trim() })))
  await navigate(f.page, '/')
  if (!deck.id || done.length < 2) throw Error('The live install shows no mission or too few done tasks to probe')
  // Live decks: ready once any task row is drawn, whichever it is.
  return { deck, issuePage: done[0], search: done[1] }
}

let browser
try {
  const userLib = `${process.env.HOME}/.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu`
  const browserEnv = { ...process.env }
  if (existsSync(userLib)) browserEnv.LD_LIBRARY_PATH = userLib
  else delete browserEnv.LD_LIBRARY_PATH
  const pinned = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
  const executablePath = process.env.PODIUM_CHROMIUM || (existsSync(pinned) ? pinned : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }), env: browserEnv, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'] })
  result.browser = browser.version()
  const targets = live ? {} : operatorTargets()
  result.targets = live ? undefined : { deck: { id: targets.deck.id, size: targets.deck.childIds.length + 1 }, issuePage: targets.issuePage.id, search: targets.search.id }
  if (surfaces.includes('web')) await webWalk(browser, targets)
  if (surfaces.includes('phone')) await phoneWalk(browser, targets)
  result.status = 'complete'
} catch (error) {
  result.status = 'failed'; result.failure = String(error?.stack ?? error).slice(0, 2000)
  console.error(result.failure)
} finally {
  result.endedAt = new Date().toISOString(); result.loadEnd = loadavg()
  // The rule: complete, within its declared hops, and offline with no request.
  result.violations = result.screens.filter((x) => !x.ready || (x.declaredHops !== undefined && x.hops > x.declaredHops) || (x.phase === 'offline' && x.requests > 0))
    .map((x) => `${x.surface} ${x.phase} ${x.screen}: ${!x.ready ? 'never ready' : x.hops > x.declaredHops ? `${x.hops} hops > ${x.declaredHops}` : `${x.requests} requests offline`}`)
  save()
  writeFileSync(resolve(out, 'report.md'), report())
  await browser?.close().catch(() => {})
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise((done) => server.once('exit', done)), pause(10000)]); if (server.exitCode === null) server.kill('SIGKILL') }
  if (!live && execFileSync('git', ['ls-files', 'packages/api-types/src/index.d.ts'], { encoding: 'utf8' }).trim())
    execFileSync('git', ['restore', '--source=HEAD', '--', 'packages/api-types/src/index.d.ts'])
}
console.log(report())
if (result.status !== 'complete' || result.violations.length) process.exitCode = 1

function report() {
  const lines = [
    `# Screens probe (${result.mode})`, '',
    `Commit ${result.sha ?? 'unknown'} on ${result.host}, ${result.startedAt}; browser ${result.browser ?? '?'}; status ${result.status}.`,
    result.mode === 'operator' ? 'Synthetic operator corpus: 8,687 issues, 6,941 sessions; deck of the 970-issue mission.' : `Live install ${live}, read-only (${result.blockedWrites.length} writes refused).`, '',
    '| surface | phase | screen | ready | LOADING ms | requests | hops (max) | longest task ms | heap after GC MiB |',
    '|---|---|---|---|---:|---:|---:|---:|---:|',
    ...result.screens.map((x) => `| ${x.surface} | ${x.phase} | ${x.screen} | ${x.ready ? 'yes' : 'NO'} | ${x.loadingMs} | ${x.requests} | ${x.hops} (${x.declaredHops ?? '-'}) | ${x.longestTaskMs < 50 ? '<50' : x.longestTaskMs} | ${x.heapAfterGcMiB} |`),
    '', `Violations: ${result.violations?.length ? '' : 'none'}`, ...(result.violations ?? []).map((x) => `- ${x}`),
    ...(result.failure ? ['', 'Failure: ' + result.failure.split('\n')[0]] : []), '',
  ]
  return lines.join('\n')
}
