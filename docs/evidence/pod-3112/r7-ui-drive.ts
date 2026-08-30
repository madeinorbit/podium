import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ORIGIN = 'http://127.0.0.1:20317'
const PASSWORD = 'p3112-oc-ui-stop-r7'
const INSTANCE = 'p3112-oc-ui-stop-r7'
const BASE = '/tmp/pod-3112-oc-ui-stop-r7'
const REPO = join(BASE, 'dummy-repo')
const CWD = join(REPO, '.worktrees/issue-2-r7-seeded-workspace')
const seedSid = '697f881d-b5fa-444d-a61c-81474c9644ea'
const EPIC = 'd954387e81cc29e5b8432cc06a66ecbee95db4d9'
const OUT = join(process.cwd(), 'docs/evidence/pod-3112/readings')
const mono = () => performance.now()
const wall = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

mkdirSync(CWD, { recursive: true })
if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: CWD }).status !== 0) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: CWD })
}

const login = await fetch(`${ORIGIN}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie) throw new Error('login produced no cookie')
const [cookieName, cookieValue] = cookie.split('=') as [string, string]
async function mutate(path: string, body: unknown) {
  const r = await fetch(`${ORIGIN}/trpc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
  return r.json() as Promise<any>
}
async function query(path: string, body: unknown = {}) {
  const r = await fetch(`${ORIGIN}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(body))}`, { headers: { cookie } })
  return r.json() as Promise<any>
}
await mutate('repos.add', { path: REPO })
const before = (await query('sessions.list')).result?.data ?? []
const beforeIds = new Set(before.map((x: { sessionId: string }) => x.sessionId))

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512'] })
const context = await browser.newContext({ viewport: { width: 1360, height: 880 } })
await context.addCookies([{ name: cookieName, value: cookieValue, url: ORIGIN, httpOnly: true, sameSite: 'Lax' }])
const page = await context.newPage()
const createRequests: Array<{ at: string; body: string | null }> = []
const interruptRequests: Array<{ at: string; body: string | null }> = []
page.on('request', (request) => {
  if (request.url().includes('/trpc/sessions.create')) createRequests.push({ at: wall(), body: request.postData() })
  if (request.url().includes('/trpc/sessions.interrupt')) interruptRequests.push({ at: wall(), body: request.postData() })
})

let sid = ''
try {
  await page.goto(`${ORIGIN}/?e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.getByText('r7 seeded workspace', { exact: true }).click({ timeout: 30_000 })
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, { timeout: 90_000 })
  const dismiss = page.getByRole('button', { name: /^Dismiss$/i }).first()
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  await page.locator('button[aria-label="New panel"]:visible').first().waitFor({ state: 'visible', timeout: 30_000 })
  const clickAt = wall()
  await page.locator('button[aria-label="New panel"]:visible').first().click()
  const standard = page.getByRole('menuitem', { name: /New OpenCode/i }).first()
  await standard.waitFor({ state: 'visible', timeout: 10_000 })
  const experimentalRowsVisible = await page.getByRole('menuitem', { name: /OpenCode.*server|server.*OpenCode/i }).count()
  await standard.click()

  let identity: any = null
  for (let i = 0; i < 160; i++) {
    const rows = (await query('sessions.list')).result?.data ?? []
    identity = rows.find((x: { sessionId: string; cwd?: string }) => !beforeIds.has(x.sessionId) && x.cwd === CWD)
    if (identity?.driverId) break
    await sleep(250)
  }
  if (!identity) throw new Error('UI click created no session row')
  sid = identity.sessionId
  if (identity.driverId !== 'opencode-server') {
    throw new Error(`REFUSED identity mismatch ${JSON.stringify(identity)}`)
  }
  const createBody = createRequests.at(-1)?.body ?? ''
  if (!createBody.includes('"runtimeContract":true')) throw new Error(`REFUSED create did not request manifest selection: ${createBody}`)

  const nativeTab = page.locator('[data-testid="mode-native"]')
  await nativeTab.waitFor({ state: 'visible', timeout: 30_000 })
  const nativeFirst = (await nativeTab.getAttribute('aria-selected')) === 'true'
  if (!nativeFirst) throw new Error('REFUSED standard New OpenCode did not open Native first')
  await page.waitForFunction(() => Boolean((window as any).__podium), undefined, { timeout: 60_000 })
  let screen = ''
  for (let i = 0; i < 240; i++) {
    screen = await page.evaluate(() => (window as any).__podium?.screenText() ?? '')
    if (screen.length > 100 && /opencode/i.test(screen)) break
    await sleep(250)
  }
  const authenticatedAttachedCli = screen.length > 100 && /opencode/i.test(screen) && !/not logged in|sign in required/i.test(screen)
  if (!authenticatedAttachedCli) throw new Error('REFUSED no authenticated attached OpenCode CLI')

  const interruptNonce = `P3112-R7-FINAL-${Date.now().toString(36).toUpperCase()}`
  const prompt = `Count slowly from 1 through 2000, printing each integer on its own line. Do not use tools. Only after 2000 print ${interruptNonce}.`
  const screenBefore = screen.length
  const sendAtMono = mono()
  const sendAtWall = wall()
  await page.evaluate((text) => (window as any).__podium.sendInput(text + '\r'), prompt)
  let firstWorkingMs: number | null = null
  let firstGrowthMs: number | null = null
  const controlSamples: Array<Record<string, unknown>> = []
  for (let i = 0; i < 240; i++) {
    const [st, current] = await Promise.all([
      query('sessions.status', { ref: sid }).then((x) => x.result?.data ?? null),
      page.evaluate(() => (window as any).__podium?.screenText() ?? ''),
    ])
    const ms = mono() - sendAtMono
    if (firstWorkingMs === null && st?.phase === 'working') firstWorkingMs = ms
    if (firstGrowthMs === null && current.length > screenBefore) firstGrowthMs = ms
    controlSamples.push({ ms, at: wall(), phase: st?.phase ?? null, status: st?.status ?? null, screenLength: current.length })
    if (firstWorkingMs !== null && firstGrowthMs !== null) break
    await sleep(250)
  }
  if (firstWorkingMs === null || firstGrowthMs === null) throw new Error('positive working/growth control did not fire')

  await page.locator('[data-testid="mode-chat"]').click()
  const stop = page.locator('[data-testid="composer-stop"]')
  await stop.waitFor({ state: 'visible', timeout: 30_000 })
  const stopAtMono = mono()
  const stopAtWall = wall()
  await stop.click()
  let idleMs: number | null = null
  let finalStatus: any = null
  for (let i = 0; i < 240; i++) {
    finalStatus = (await query('sessions.status', { ref: sid })).result?.data ?? null
    if (finalStatus?.phase !== 'working') { idleMs = mono() - stopAtMono; break }
    await sleep(250)
  }
  const stopBody = interruptRequests.at(-1)?.body ?? ''
  if (!stopBody.includes(sid)) throw new Error('product Stop emitted no matching sessions.interrupt request')

  let interruptedItems: any[] = []
  let afterInterruptItems: any[] = []
  for (let i = 0; i < 240; i++) {
    afterInterruptItems = (await query('sessions.read', { sessionId: sid, turns: 500 })).result?.data?.items ?? []
    interruptedItems = afterInterruptItems.filter((x: { event?: string; text?: string }) => x.event === 'interrupt' || /request interrupted by user/i.test(String(x.text ?? '')))
    if (interruptedItems.length > 0) break
    await sleep(250)
  }
  const liveAfterStop = ((await query('sessions.list')).result?.data ?? []).find((x: { sessionId: string }) => x.sessionId === sid)
  const chatSyncedAfterStop = await page.locator('[data-testid="chat-surface"]').innerText().then((x) => x.includes(prompt.slice(0, 50))).catch(() => false)

  await nativeTab.click()
  const followNonce = `P3112-R7-FOLLOW-${Date.now().toString(36).toUpperCase()}`
  const followPrompt = `Reply with exactly ${followNonce} and nothing else. Do not use tools.`
  const followAtMono = mono()
  const followAtWall = wall()
  await page.evaluate((text) => (window as any).__podium.sendInput(text + '\r'), followPrompt)
  await page.locator('[data-testid="mode-chat"]').click()
  let followItems: any[] = []
  let followMs: number | null = null
  for (let i = 0; i < 480; i++) {
    followItems = (await query('sessions.read', { sessionId: sid, turns: 500 })).result?.data?.items ?? []
    const assistantCount = followItems.filter((x: { role?: string; text?: string }) => x.role === 'assistant' && String(x.text ?? '').includes(followNonce)).length
    if (assistantCount === 1) { followMs = mono() - followAtMono; break }
    await sleep(250)
  }
  const userFollowCount = followItems.filter((x: { role?: string; text?: string }) => x.role === 'user' && String(x.text ?? '').includes(followNonce)).length
  const assistantFollowCount = followItems.filter((x: { role?: string; text?: string }) => x.role === 'assistant' && String(x.text ?? '').includes(followNonce)).length
  const chatText = await page.locator('[data-testid="chat-surface"]').innerText()
  const chatFollowOccurrences = chatText.split(followNonce).length - 1

  const web = await fetch(`${ORIGIN}/podium-build.json`).then((r) => r.json())
  const reading = {
    at: wall(), issue: 'POD-3112', kind: 'r7-ui-drive', journeyId: 'opencode-paired-final-tip', acceptance: true,
    epicPin: EPIC, evidenceHeadBeforeDrive: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    instance: INSTANCE, stateRoot: `/home/mgw/.local/state/podium/${INSTANCE}`, agentHome: `/home/mgw/.local/state/podium/${INSTANCE}/agent-home`, cwd: CWD,
    ports: [20317, 47322, 47323], serverPid: Number(readFileSync(join(BASE, 'server.pid'), 'utf8')), daemonPid: Number(readFileSync(join(BASE, 'daemon.pid'), 'utf8')),
    pins: { server: EPIC, daemon: EPIC, web, opencodeVersion: '1.18.25', opencodeSha256: 'd91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb' },
    experiment: { runtimeDriversEnabled: false, experimentalRowsVisible },
    creation: { clickAt, createRequests, runtimeContractTrue: createBody.includes('"runtimeContract":true'), identity: { sessionId: sid, driverId: identity.driverId, requestedDriverId: identity.requestedDriverId, driverFamily: identity.driverFamily }, nativeFirst, authenticatedAttachedCli, initialScreenLength: screen.length },
    interrupt: { sendAtWall, prompt, firstWorkingMs, firstGrowthMs, controlSamples, stopAtWall, interruptRequests, promptProtocolCancellation: stopBody.includes(sid), requestToIdleMs: idleMs, finalPhase: finalStatus?.phase ?? null, finalStatus: finalStatus?.status ?? null, cliSurvived: liveAfterStop?.status === 'live', naturalFinalNonceSeen: afterInterruptItems.some((x: { text?: string }) => String(x.text ?? '').includes(interruptNonce)), durableInterruptCount: interruptedItems.length, durableInterruptItems: interruptedItems, chatSyncedAfterStop },
    followUp: { followAtWall, prompt: followPrompt, nonce: followNonce, nativeOrigin: true, chatObservedMs: followMs, userCount: userFollowCount, assistantCount: assistantFollowCount, chatTextOccurrences: chatFollowOccurrences },
  }
  const verdict = reading.creation.runtimeContractTrue && identity.driverId === 'opencode-server' && nativeFirst && authenticatedAttachedCli && firstWorkingMs !== null && firstGrowthMs !== null && reading.interrupt.promptProtocolCancellation && idleMs !== null && liveAfterStop?.status === 'live' && !reading.interrupt.naturalFinalNonceSeen && interruptedItems.length === 1 && chatSyncedAfterStop && userFollowCount === 1 && assistantFollowCount === 1 && chatFollowOccurrences === 2 ? 'PASS' : 'FAIL'
  const complete = { ...reading, verdict }
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, `opencode-server.r7-ui.${new Date().toISOString().replaceAll(/[-:.]/g, '')}.json`)
  writeFileSync(path, JSON.stringify(complete, null, 2) + '\n')
  console.log(JSON.stringify({ path, verdict, identity: reading.creation.identity, nativeFirst, authenticatedAttachedCli, firstWorkingMs, firstGrowthMs, requestToIdleMs: idleMs, cliSurvived: reading.interrupt.cliSurvived, durableInterruptCount: interruptedItems.length, chatSyncedAfterStop, followMs, userFollowCount, assistantFollowCount, chatFollowOccurrences }, null, 2))
} finally {
  await browser.close().catch(() => {})
  if (sid) await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  await mutate('sessions.kill', { sessionId: seedSid }).catch(() => {})
}
