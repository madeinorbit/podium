import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

interface TerminalDiagnostic {
  mountId: string
  event: string
  data?: { view?: { renderer?: string } }
}

interface ResidencySample {
  visits: number
  mountedPanels: number
  panelDomNodes: number
  documentDomNodes: number
  xterms: number
  renderers: { webgl: number; dom: number; unknown: number }
  hubTerminalAttaches: number
  hubTranscriptSubscriptions: number
  heapBytes: number | null
  afterGc: {
    mountedPanels: number
    panelDomNodes: number
    documentDomNodes: number
    xterms: number
    renderers: { webgl: number; dom: number; unknown: number }
    hubTerminalAttaches: number
    hubTranscriptSubscriptions: number
    heapBytes: number | null
  }
}

type DiagnosticsWindow = Window & {
  __podiumTerminalDiagnostics?: { snapshot(): TerminalDiagnostic[] }
  __podiumSwitchTraces?: {
    recent(): Array<{
      cold: boolean
      timedOut: boolean
      totalMs: number
      marks: Array<{ name: string }>
    }>
  }
}

const milestones = [1, 3, 8, 20] as const
const outPath = resolve(process.env.PODIUM_RESIDENCY_OUT ?? 'artifacts/POD-847/residency.json')
const phase = process.env.PODIUM_RESIDENCY_PHASE ?? 'measurement'

const percentile = (values: number[], quantile: number): number | null => {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1)] ?? null
}

async function domSample(page: Page): Promise<Omit<ResidencySample, 'visits' | 'afterGc'>> {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll<HTMLElement>('[data-panel-resident]')]
    const diagnostics = (window as DiagnosticsWindow).__podiumTerminalDiagnostics?.snapshot() ?? []
    const latestByMount = new Map<string, TerminalDiagnostic>()
    for (const entry of diagnostics) latestByMount.set(entry.mountId, entry)
    const live = [...latestByMount.values()].filter((entry) => entry.event !== 'dispose')
    const renderers = { webgl: 0, dom: 0, unknown: 0 }
    for (const entry of live) {
      const renderer = entry.data?.view?.renderer
      if (renderer === 'webgl') renderers.webgl += 1
      else if (renderer === 'dom') renderers.dom += 1
      else renderers.unknown += 1
    }
    return {
      mountedPanels: panels.length,
      panelDomNodes: panels.reduce((sum, panel) => sum + panel.querySelectorAll('*').length + 1, 0),
      documentDomNodes: document.querySelectorAll('*').length,
      xterms: document.querySelectorAll('.xterm').length,
      renderers,
      // AgentPanel owns exactly one terminal connection and one transcript subscription
      // for its mounted lifetime. The diagnostics-derived live mount count is the
      // terminal attach count; the panel count is the matching transcript count.
      hubTerminalAttaches: live.length,
      hubTranscriptSubscriptions: panels.length,
      heapBytes: null,
    }
  })
}

async function sample(page: Page, visits: number): Promise<ResidencySample> {
  await page.waitForTimeout(500)
  const cdp = await page.context().newCDPSession(page)
  const settled = await domSample(page)
  const settledHeap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize?: number }
  await cdp.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(100)
  const afterGc = await domSample(page)
  const gcHeap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize?: number }
  await cdp.detach()
  return {
    visits,
    ...settled,
    heapBytes: settledHeap.usedSize ?? null,
    afterGc: {
      mountedPanels: afterGc.mountedPanels,
      panelDomNodes: afterGc.panelDomNodes,
      documentDomNodes: afterGc.documentDomNodes,
      xterms: afterGc.xterms,
      renderers: afterGc.renderers,
      hubTerminalAttaches: afterGc.hubTerminalAttaches,
      hubTranscriptSubscriptions: afterGc.hubTranscriptSubscriptions,
      heapBytes: gcHeap.usedSize ?? null,
    },
  }
}

test('measures warm-panel residency at the required visit counts', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('podium.panelModeDefault', 'native')
  })
  await openApp(page)
  await expect(page.locator('[data-panel-resident]')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.xterm')).toHaveCount(1, { timeout: 30_000 })

  const samples: ResidencySample[] = [await sample(page, 1)]
  for (let visits = 2; visits <= 20; visits += 1) {
    await newSession(page, 'Claude')
    if (milestones.includes(visits as (typeof milestones)[number])) {
      samples.push(await sample(page, visits))
    }
  }

  const tabIds = await page.$$eval('.overflow-x-auto [data-session]', (elements) =>
    elements.map((element) => (element as HTMLElement).dataset.session ?? '').filter(Boolean),
  )
  const residentIds = tabIds.slice(-3)
  expect(residentIds).toHaveLength(3)
  const traceStart = await page.evaluate(
    () => (window as DiagnosticsWindow).__podiumSwitchTraces?.recent().length ?? 0,
  )
  for (let index = 0; index < 30; index += 1) {
    const id = residentIds[index % residentIds.length]
    await page.locator(`.overflow-x-auto [data-session="${id}"]`).click()
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(500)
  const traces = await page.evaluate(
    (start) => (window as DiagnosticsWindow).__podiumSwitchTraces?.recent().slice(start) ?? [],
    traceStart,
  )
  const warmTraces = traces.filter(
    (trace) =>
      !trace.cold &&
      !trace.timedOut &&
      trace.marks.some((mark) => mark.name === 'term:interactable'),
  )
  const warmMs = warmTraces.map((trace) => trace.totalMs)

  const report = {
    phase,
    measuredAt: new Date().toISOString(),
    browser: 'chromium-desktop',
    viewport: { width: 1440, height: 900 },
    samples,
    warmSwitch: {
      requested: 30,
      completed: warmMs.length,
      p50Ms: percentile(warmMs, 0.5),
      p95Ms: percentile(warmMs, 0.95),
      samplesMs: warmMs,
    },
  }
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`)
})
