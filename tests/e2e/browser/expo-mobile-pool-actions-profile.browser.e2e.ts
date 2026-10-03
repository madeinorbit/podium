/** POD-5391: the phone pilot's steady-state costs after a warm start, on the
 * production phone export with the operator-sized synthetic corpus.
 *
 * Each sample is one warm launch of /mobile/work with the pilot latched OFF or
 * ON, settled for 3 s, then:
 *  - updates: 20 live server-side title updates of one visible started issue,
 *    each awaited until its row label shows the new title. Main-thread task
 *    time comes from CDP Performance.TaskDuration (POD-5172's measure).
 *  - row tap: a trusted press on another started issue's row; input → the end
 *    of the first main-renderer Paint after the mission screen's DOM appears
 *    (POD-4977's measure).
 * Traced samples carry V8 CPU samples for tests/e2e/phone-profile-analyze.ts.
 *
 * Opt-in only: PODIUM_PHONE_PROFILE=1, run while holding bench:flatblock. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { resolve } from 'node:path'
import { type CDPSession, expect, type Page, test } from '@playwright/test'
import { paintOf, traceStart as paintTraceStart } from '../../../apps/web/harness/browser-paint'
import { RELAY } from './_harness'
import {
  firstLaunch,
  observeErrors,
  rpc,
  SIZED_CORPUS,
  saveTrace,
  seedSession,
  setPilot,
  sizedBootstrap,
  traceStart,
} from './_phone-profile'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium phone export profile',
)
test.use({ serviceWorkers: 'block' })
const screens = process.env.PODIUM_PHONE_SCREENS === '1'
const artifacts = resolve(
  import.meta.dirname,
  '../../../.artifacts',
  screens ? 'POD-5081' : 'POD-5391',
)
const samples = Number(process.env.PODIUM_PHONE_PROFILE_SAMPLES ?? 3)
const UPDATES = 20
const stamp = Date.now().toString(36)
const tapTitle = `Phone tap target ${stamp}`
const updateTitle = `Phone update target ${stamp}`
const prefix = '(?:[A-Z]+-\\d+|#\\d+)'

interface Sample {
  pool: boolean
  traced: boolean
  load: number[]
  updates: { taskMs: number; wallMs: number; perUpdateTaskMs: number }
  tap: { inputToPaintMs: number; selectedDomMs: number }
  traces?: { updates: string; tap: string }
  screens?: {
    missionUpdate: UpdateTiming
    detailsOpen: PaintTiming
    detailsUpdate: UpdateTiming
    tasksOpen: PaintTiming
    tasksUpdate: UpdateTiming
  }
}
type UpdateTiming = { taskMs: number; wallMs: number; perUpdateTaskMs: number }
type PaintTiming = ReturnType<typeof paintOf>

async function taskSeconds(cdp: CDPSession) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return metrics.find((metric) => metric.name === 'TaskDuration')!.value
}

const rowNamed = (page: Page, title: string) =>
  page.getByRole('button', { name: new RegExp(`^${prefix} ${title}$`) })

test('phone pilot work-list updates and row tap, timed and profiled', async ({ page }) => {
  test.skip(
    process.env.PODIUM_PHONE_PROFILE !== '1',
    'Run only while holding bench:flatblock, with PODIUM_PHONE_PROFILE=1',
  )
  test.setTimeout(2_400_000)
  mkdirSync(artifacts, { recursive: true })
  const observed = observeErrors(page),
    seed = await seedSession(page, `Phone action seed ${stamp}`),
    corpus = await sizedBootstrap(page, seed)
  // Two started issues with their own agents: POD-4977's row target shape, in
  // the repo it started them in (the e2e repo's HEAD cannot add a worktree).
  const [repoPath] = await rpc<string[]>(page, 'repos.list')
  expect(repoPath).toBeDefined()
  const tapIssue = await rpc<{ id: string }>(page, 'issues.create', {
    repoPath,
    title: tapTitle,
    startNow: true,
  })
  const updateIssue = await rpc<{ id: string }>(page, 'issues.create', {
    repoPath,
    title: updateTitle,
    startNow: true,
  })
  expect(tapIssue.id).not.toBe(updateIssue.id)
  const detailTitle = `Phone detail task ${stamp}`
  const detailIssue = screens
    ? await rpc<{ id: string }>(page, 'issues.create', {
        repoPath,
        parentId: tapIssue.id,
        title: detailTitle,
        startNow: false,
      })
    : null
  if (detailIssue)
    await rpc(page, 'issues.update', { id: detailIssue.id, patch: { stage: 'in_progress' } })
  await firstLaunch(page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  let current = false,
    updateLabel = updateTitle,
    tapLabel = tapTitle,
    detailLabel = detailTitle,
    revision = 0

  async function launchWork(pool: boolean) {
    await setPilot(page, pool, current)
    current = pool
    await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
    await expect(rowNamed(page, tapLabel)).toBeVisible({ timeout: 60_000 })
    await expect(rowNamed(page, updateLabel)).toBeVisible({ timeout: 60_000 })
    // Steady state: the pool attachment and startup work end before input.
    await page.waitForTimeout(3_000)
    expect(corpus.installations(), 'every measured launch is warm').toBe(1)
  }

  async function measureUpdates(
    issueId: string,
    title: string,
    visible: (next: string) => Promise<void>,
    trace?: string,
  ) {
    const stop = trace ? await traceStart(cdp) : undefined
    const before = await taskSeconds(cdp),
      started = Date.now()
    await page.evaluate(() => performance.mark('phone:updates-start'))
    for (let index = 0; index < UPDATES; index++) {
      revision++
      const next = `${title} r${revision}`
      await rpc(page, 'issues.update', { id: issueId, patch: { title: next } })
      await visible(next)
    }
    await page.evaluate(() => performance.mark('phone:updates-end'))
    const wallMs = Date.now() - started,
      taskMs = ((await taskSeconds(cdp)) - before) * 1000
    const events = await stop?.()
    if (events && trace) saveTrace(resolve(artifacts, trace), events)
    return { taskMs, wallMs, perUpdateTaskMs: taskMs / UPDATES }
  }
  const updates = (trace?: string) =>
    measureUpdates(
      updateIssue.id,
      updateTitle,
      async (next) => {
        await expect(rowNamed(page, next)).toBeVisible({ timeout: 30_000 })
        updateLabel = next
      },
      trace,
    )

  async function tap(trace?: string) {
    const label = await rowNamed(page, tapLabel).getAttribute('aria-label')
    await page.evaluate((target) => {
      const element = [...document.querySelectorAll('[aria-label]')].find(
        (node) => node.getAttribute('aria-label') === target,
      )
      if (!element) throw new Error('missing work-list row')
      performance.clearMarks('phone:input')
      performance.clearMarks('phone:dom')
      const capture = { input: false, ready: false }
      Object.assign(window, { __phoneTap: capture })
      element.addEventListener(
        'pointerdown',
        () => {
          capture.input = true
          performance.mark('phone:input')
        },
        { once: true },
      )
      const observer = new MutationObserver(() => {
        if (!capture.input || !document.querySelector('[aria-label="Mission actions"]')) return
        observer.disconnect()
        performance.mark('phone:dom')
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            capture.ready = true
          }),
        )
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    }, label)
    const stop = trace ? await traceStart(cdp) : await paintTraceStart(cdp)
    let events: Parameters<typeof paintOf>[0] = []
    try {
      await rowNamed(page, tapLabel).click()
      await expect(page).toHaveURL(/\/mobile\/mission\//)
      await page.waitForFunction(() => Reflect.get(window, '__phoneTap')?.ready, undefined, { timeout: 30_000 })
    } finally {
      events = (await stop()) as typeof events
    }
    if (trace) saveTrace(resolve(artifacts, trace), events as Parameters<typeof saveTrace>[1])
    return paintOf(events, 'phone:input', 'phone:dom')
  }

  // POD-5081 extends the SAME production capture, after the original cold
  // mission tap so visiting Tasks cannot warm its legacy all-issue cache.
  async function openScreen(label: string, path: string, selector: string) {
    console.info('[phone screen]', label, page.url())
    const action = page.getByRole('button', { name: label, exact: true })
    await action.evaluate((element, { path, selector }) => {
      performance.clearMarks('phone:input')
      performance.clearMarks('phone:dom')
      const capture = { input: false, ready: false }
      Object.assign(window, { __phoneScreenAction: capture })
      element.addEventListener('pointerdown', () => {
        capture.input = true
        performance.mark('phone:input')
      }, { once: true })
      const check = () => {
        if (capture.ready || !capture.input) return
        if (!location.pathname.endsWith(path) || !document.querySelector(selector)) {
          requestAnimationFrame(check)
          return
        }
        observer.disconnect()
        performance.mark('phone:dom')
        requestAnimationFrame(() => requestAnimationFrame(() => { capture.ready = true }))
      }
      const observer = new MutationObserver(check)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    }, { path, selector })
    const stop = await paintTraceStart(cdp)
    let events: Parameters<typeof paintOf>[0] = []
    try {
      await action.click({ timeout: 15_000 })
      await page.waitForFunction(() => Reflect.get(window, '__phoneScreenAction')?.ready, undefined, { timeout: 30_000 })
    } catch (error) {
      console.info('[phone screen pending]', label, await page.evaluate((selector) => ({
        path: location.pathname,
        matches: document.querySelectorAll(selector).length,
        capture: Reflect.get(window, '__phoneScreenAction'),
      }), selector))
      throw error
    } finally { events = await stop() }
    return paintOf(events, 'phone:input', 'phone:dom')
  }

  async function screenActions(pool: boolean): Promise<NonNullable<Sample['screens']>> {
    console.info('[phone screen]', pool ? 'ON' : 'OFF', 'mission updates')
    const missionUpdate = await measureUpdates(tapIssue.id, tapTitle, async (next) => {
      await expect(page.getByText(next, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 })
      tapLabel = next
    })
    const detailsOpen = await openScreen('Mission details', '/details', '[aria-label="Launch an agent on this mission"]')
    const detailsUpdate = await measureUpdates(detailIssue!.id, detailTitle, async (next) => {
      await expect(page.getByText(next, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 })
      detailLabel = next
    })
    await expect(page.getByText(detailLabel, { exact: true }).filter({ visible: true }).first()).toBeVisible()
    // A new Work document preserves the first-visit Tasks cost, including the
    // legacy cache that the OFF work list warms and the ON work list bypasses.
    await launchWork(pool)
    const tasksOpen = await openScreen('Tasks', '/issues', `[aria-label^="Task "][aria-label*="${updateLabel}"]`)
    const tasksUpdate = await measureUpdates(updateIssue.id, updateTitle, async (next) => {
      await expect(page.getByRole('button', { name: new RegExp(`^Task \\d+: ${next}(?:,|$)`) })).toBeVisible({ timeout: 30_000 })
      updateLabel = next
    })
    return { missionUpdate, detailsOpen, detailsUpdate, tasksOpen, tasksUpdate }
  }

  // Warm both pilot paths once.
  await launchWork(false)
  await launchWork(true)
  const order = Array.from({ length: samples }, (_, index) =>
    index % 2 === 0 ? [false, true] : [true, false],
  ).flat()
  const timed: Sample[] = [],
    traced: Sample[] = []
  for (const pool of order) {
    console.info('[phone arm]', pool ? 'ON' : 'OFF', 'timed', timed.length, loadavg())
    await launchWork(pool)
    timed.push({ pool, traced: false, load: loadavg(), updates: await updates(), tap: await tap(),
      ...(screens ? { screens: await screenActions(pool) } : {}) })
  }
  for (const [index, pool] of order.entries()) {
    console.info('[phone arm]', pool ? 'ON' : 'OFF', 'traced', index, loadavg())
    const name = `${pool ? 'on' : 'off'}-${index}.trace.json.gz`
    await launchWork(pool)
    traced.push({
      pool,
      traced: true,
      load: loadavg(),
      updates: await updates(`updates-${name}`),
      tap: await tap(`tap-${name}`),
      traces: { updates: `updates-${name}`, tap: `tap-${name}` },
      ...(screens ? { screens: await screenActions(pool) } : {}),
    })
  }
  expect(observed.errors, observed.errors.join('\n')).toEqual([])
  const median = (pool: boolean, list: Sample[], pick: (sample: Sample) => number) => {
    const values = list
      .filter((sample) => sample.pool === pool)
      .map(pick)
      .sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  }
  const perUpdate = (sample: Sample) => sample.updates.perUpdateTaskMs,
    paint = (sample: Sample) => sample.tap.inputToPaintMs
  const screenMetrics: Array<[string, (sample: Sample) => number]> = [
    ['missionUpdateTask', (sample) => sample.screens!.missionUpdate.perUpdateTaskMs],
    ['detailsOpenPaint', (sample) => sample.screens!.detailsOpen.inputToPaintMs],
    ['detailsUpdateTask', (sample) => sample.screens!.detailsUpdate.perUpdateTaskMs],
    ['tasksOpenPaint', (sample) => sample.screens!.tasksOpen.inputToPaintMs],
    ['tasksUpdateTask', (sample) => sample.screens!.tasksUpdate.perUpdateTaskMs],
  ]
  const report = {
    device: 'production build, Pixel 7 emulation',
    corpus: SIZED_CORPUS,
    browser: page.context().browser()?.version(),
    method:
      'One warm /mobile/work launch per sample (pilot latched by the previous launch, zero bootstrap fetches asserted), settled 3 s. updates: 20 server title updates of one visible started issue, each awaited to its row label; task ms = CDP Performance.TaskDuration delta over the loop, including the harness evaluate calls (equal in both arms). tap: trusted press on another started row → end of the first main-renderer Paint after the mission DOM (paintOf).',
    order,
    medians: {
      perUpdateTaskOff: median(false, timed, perUpdate),
      perUpdateTaskOn: median(true, timed, perUpdate),
      tapPaintOff: median(false, timed, paint),
      tapPaintOn: median(true, timed, paint),
      tracedTapPaintOff: median(false, traced, paint),
      tracedTapPaintOn: median(true, traced, paint),
      ...(screens ? Object.fromEntries(
        [false, true].flatMap(pool => screenMetrics.map(([key, pick]) =>
          [`${key}${pool ? 'On' : 'Off'}`, median(pool, timed, pick)])),
      ) : {}),
    },
    timed,
    traced,
    errors: observed.errors.length,
    resource401: observed.resource401(),
  }
  writeFileSync(resolve(artifacts, 'actions.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.info('[phone actions]', JSON.stringify(report.medians))
})
