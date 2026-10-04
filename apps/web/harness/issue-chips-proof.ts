import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import type {} from '../test/issue-chips.browser'

const origin = 'http://127.0.0.1:41678'
const out = '.artifacts/issue-chips'
const tailProof = process.argv.includes('--tail-proof')
const correctnessOnly = process.argv.includes('--correctness-only') || tailProof
const modes = ['pool'] as const
await mkdir(out, { recursive: true })
const server = Bun.spawn(
  [
    'timeout',
    '600s',
    process.execPath,
    'run',
    '--cwd',
    'apps/web',
    'dev',
    '--',
    '--config',
    'vite.chips-perf.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '41678',
  ],
  { stdout: 'ignore', stderr: 'inherit' },
)
console.log(`Issue-chip browser server PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const until = Date.now() + 60000
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/test/issue-chips.browser.html`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        break
    } catch {}
    if (Date.now() > until) throw new Error('Chip browser server did not start')
    await Bun.sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Array<Record<string, unknown>> = []
  for (const mode of modes) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
      reducedMotion: 'reduce',
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.origin === origin || ['data:', 'blob:'].includes(url.protocol)
        ? route.continue()
        : route.abort()
    })
    const fixtureUrl = `${origin}/test/issue-chips.browser.html?issues=4887`
    const waitReady = async (phase: string) => {
      try {
        await page.waitForFunction(() => window.__issueChips?.ready(), null, { timeout: 30000 })
      } catch (error) {
        console.error(
          JSON.stringify({
            phase,
            url: page.url(),
            errors,
            status: await page.evaluate(() => window.__issueChips?.status()),
            failures: await page.evaluate(() => window.__issueChips?.failures()),
          }),
        )
        throw error
      }
    }
    await page.goto(fixtureUrl, { waitUntil: 'networkidle', timeout: 60000 })
    await waitReady(`${mode}:boot`)
    // Warm development module delivery without warming a measured session's
    // transcript cache. Each measured page reload creates a fresh runtime.
    await page.evaluate(() => window.__issueChips.open())
    await page.waitForFunction(
      () => document.querySelectorAll('a[data-issue-availability="present"]').length >= 361,
    )
    const times: number[] = []
    for (let sample = 0; sample < (correctnessOnly ? 1 : 5); sample++) {
      // ChatView writes the selected session into the browser URL. A reload
      // there loads the app entry, so return to the private fixture explicitly.
      await page.goto(fixtureUrl, { waitUntil: 'networkidle', timeout: 60000 })
      await waitReady(`${mode}:reload:${sample}`)
      if (correctnessOnly) {
        await page.evaluate(() => window.__issueChips.open())
        await page.waitForFunction(
          () => document.querySelectorAll('a[data-issue-availability="present"]').length >= 361,
        )
        continue
      }
      const ms = await page.evaluate(async () => {
        const start = performance.now()
        window.__issueChips.open()
        const deadline = start + 30000
        while (document.querySelectorAll('a[data-issue-availability="present"]').length < 361) {
          if (performance.now() > deadline)
            throw new Error('Conversation chips did not become ready')
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        return performance.now() - start
      })
      await page.waitForFunction(
        () => document.querySelectorAll('a[data-issue-availability="present"]').length >= 361,
      )
      times.push(ms)
    }
    // Drain mount-time observers before measuring unrelated session traffic.
    // This wait is outside the conversation-open timing window above.
    await page.waitForTimeout(200)
    const before = await page.evaluate(() => window.__issueChips.stats())
    const shape = await page.evaluate(() => window.__issueChips.status())
    const captureChips = () =>
      page.evaluateHandle(
        () =>
          new Map(
            [...document.querySelectorAll('a.ref-link--issue, [data-issue-reference]')].map(
              (el) => [
                el,
                [
                  el.getAttribute('data-issue-stage'),
                  el.getAttribute('data-issue-availability'),
                  el.getAttribute('aria-label'),
                ].join('\0'),
              ],
            ),
          ),
      )
    const mountsSince = (previous: Awaited<ReturnType<typeof captureChips>>) =>
      page.evaluate((previous) => {
        let added = 0,
          changed = 0
        for (const el of document.querySelectorAll('a.ref-link--issue, [data-issue-reference]')) {
          if (!previous.has(el)) {
            added++
            continue
          }
          const value = [
            el.getAttribute('data-issue-stage'),
            el.getAttribute('data-issue-availability'),
            el.getAttribute('aria-label'),
          ].join('\0')
          if (previous.get(el) !== value) changed++
        }
        return { added, changed }
      }, previous)
    const mounted = await captureChips()
    const conversation = await page.evaluateHandle(() => ({
      rows: [...document.querySelectorAll('[data-row-key]')].map((row) => ({
        key: row.getAttribute('data-row-key')!,
        element: row,
        body: row.querySelector('.chat-md'),
        paragraph: row.querySelector('.chat-md')?.firstChild,
      })),
      pinned: document.querySelector('.brief-shelf-text'),
      pinnedParagraph: document.querySelector('.brief-shelf-text')?.firstChild,
    }))
    const retainedConversation = () =>
      page.evaluate(
        (previous) => ({
          rows: previous.rows.length,
          retainedRows: previous.rows.filter(({ key, element, body, paragraph }) => {
            const row = document.querySelector(`[data-row-key="${key}"]`)
            return (
              row === element &&
              row.querySelector('.chat-md') === body &&
              row.querySelector('.chat-md')?.firstChild === paragraph
            )
          }).length,
          pinnedPresent: previous.pinned !== null,
          pinnedRetained:
            document.querySelector('.brief-shelf-text') === previous.pinned &&
            document.querySelector('.brief-shelf-text')?.firstChild === previous.pinnedParagraph,
        }),
        conversation,
      )
    await page.evaluate(() => window.__issueChips.traffic())
    await page.waitForTimeout(200)
    const traffic = await page.evaluate(() => window.__issueChips.stats())
    const trafficMounts = await mountsSince(mounted)
    const trafficDom = await retainedConversation()
    await mounted.dispose()
    if (tailProof) {
      const evidence = {
        mode,
        shape,
        trafficMounts,
        trafficDom,
        reads: traffic.reads - before.reads,
        paints: traffic.redraws - before.redraws,
      }
      await writeFile(`${out}/tail-${mode}.json`, JSON.stringify(evidence, null, 2))
      if (
        trafficMounts.added !== 0 ||
        trafficMounts.changed !== 0 ||
        trafficDom.rows !== 120 ||
        trafficDom.retainedRows !== 120 ||
        !trafficDom.pinnedPresent ||
        !trafficDom.pinnedRetained ||
        evidence.reads !== 0 || evidence.paints !== 0
      )
        throw new Error(`Unchanged conversation DOM replaced: ${JSON.stringify(evidence)}`)
    }
    if (
      trafficMounts.changed !== 0 ||
        traffic.redraws - before.redraws !== trafficMounts.added ||
        traffic.reads - before.reads > trafficMounts.added * 4
    )
      throw new Error(
        `Session traffic woke unchanged pool chips: ${JSON.stringify({ before, traffic, trafficMounts })}`,
      )
    const paint = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('a.ref-link--issue, [data-issue-reference]')].map((el) => ({
          ref: el.getAttribute('data-ref') ?? el.getAttribute('data-issue-reference'),
          stage: el.getAttribute('data-issue-stage'),
          availability: el.getAttribute('data-issue-availability'),
          label: el.getAttribute('aria-label'),
          text: el.textContent,
        })),
      )
    const initial = await paint()
    await page.screenshot({ path: `${out}/${mode}.png`, fullPage: false })
    const issueBefore = await captureChips()
    await page.evaluate(() =>
      window.__issueChips.patch(0, { title: 'Changed chip title', stage: 'review' }),
    )
    await page.waitForFunction(
      () =>
        document.querySelector('a[data-ref="SYN-1000"]')?.getAttribute('data-issue-stage') ===
          'review' &&
        document
          .querySelector('[data-issue-reference="SYN-1000"]')
          ?.getAttribute('data-issue-stage') === 'review',
    )
    await page.waitForTimeout(200)
    const changed = await paint()
    const issueMounts = await mountsSince(issueBefore)
    const issueDom = await retainedConversation()
    await issueBefore.dispose()
    await conversation.dispose()
    if (
      tailProof &&
      (issueMounts.added !== 0 || issueDom.retainedRows !== 120 || !issueDom.pinnedRetained)
    )
      throw new Error(
        `Issue decoration replaced conversation DOM: ${JSON.stringify({ issueMounts, issueDom })}`,
      )
    const after = await page.evaluate(() => window.__issueChips.stats())
    const changedChips = changed.filter(
      (row, i) => JSON.stringify(row) !== JSON.stringify(initial[i]),
    ).length
    if (changedChips < 2 || changedChips > 12) throw new Error(`Wrong chip fanout: ${changedChips}`)
    if (
        after.redraws - traffic.redraws !== issueMounts.added + issueMounts.changed ||
        after.reads - traffic.reads > issueMounts.added * 4 + issueMounts.changed * 2
      )
        throw new Error(
          `Chip census exceeded the changed-chip fanout: ${JSON.stringify({ changedChips, issueMounts, traffic, after })}`,
        )
    if (errors.length || (await page.evaluate(() => window.__issueChips.failures())).length)
      throw new Error(`Browser errors: ${errors.join('; ')}`)
    // The full conversation owns the existing Markdown click router. Drive
    // one chip through it and inspect the actual floating card's header.
    await page.locator('a.ref-link--issue[data-ref="SYN-1000"]').last().click()
    const card = page.getByRole('dialog', { name: 'Reference SYN-1000' })
    await card.getByText('Changed chip title', { exact: true }).waitFor()
    const miniview = await card.locator('[data-issue-reference="SYN-1000"]').evaluate((el) => ({
      ref: el.getAttribute('data-issue-reference'),
      stage: el.getAttribute('data-issue-stage'),
      availability: el.getAttribute('data-issue-availability'),
      label: el.getAttribute('aria-label'),
      text: el.textContent,
    }))
    await page.screenshot({ path: `${out}/${mode}-miniview.png`, fullPage: false })
    let streaming: unknown = null
    if (tailProof) {
      const tail = page.locator('[data-row-key="message-119"]')
      const tailElement = await tail.elementHandle()
      if (!tailElement) throw new Error('Transcript tail absent')
      const waitForText = async (id: string, text: string) => {
        try {
          await page.waitForFunction(
            ({ id, text }) =>
              document.querySelector(`[data-row-key="${id}"] .chat-md`)?.textContent?.trim() ===
              text,
            { id, text },
          )
        } catch (error) {
          throw new Error(`Streamed transcript did not update ${id}`, { cause: error })
        }
      }
      const partial = 'Streamed partial SYN-1000'
      await page.evaluate((text) => window.__issueChips.streamTail(text), partial)
      await waitForText('message-119', partial)
      const complete = 'Streamed partial completed SYN-1001'
      await page.evaluate((text) => window.__issueChips.streamTail(text), complete)
      await waitForText('message-119', complete)
      const tailRetained = await page.evaluate(
        (previous) => document.querySelector('[data-row-key="message-119"]') === previous,
        tailElement,
      )
      const text = 'Appended streamed reply SYN-1002'
      const appendedId = await page.evaluate(
        (text) => window.__issueChips.streamTail(text, true),
        text,
      )
      await waitForText(appendedId, text)
      const retainedOnAppend = await page.evaluate(
        (previous) => document.querySelector('[data-row-key="message-119"]') === previous,
        tailElement,
      )
      await tailElement.dispose()
      if (!tailRetained || !retainedOnAppend)
        throw new Error('Streaming replaced the existing tail row')
      streaming = {
        sameIdPartial: true,
        sameIdComplete: true,
        append: true,
        tailRetained,
        retainedOnAppend,
      }
    }
    if (errors.length || (await page.evaluate(() => window.__issueChips.failures())).length)
      throw new Error(`Browser errors after streaming: ${errors.join('; ')}`)
    times.sort((a, b) => a - b)
    results.push({
      mode,
      cold: true,
      issues: shape.issues,
      sessions: shape.sessions,
      messages: 120,
      chips: initial.length,
      openMs: correctnessOnly ? undefined : times,
      medianOpenMs: correctnessOnly ? undefined : times[2],
      before,
      traffic,
      trafficMounts,
      ...(tailProof ? { trafficDom, issueDom, streaming } : {}),
      after,
      changedChips,
      issueMounts,
      miniview,
    })
    await page.close()
  }
  await writeFile(
    `${out}/result.json`,
    JSON.stringify(
      { results },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await server.exited
}
