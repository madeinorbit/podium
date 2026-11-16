/** Focused proof for the shipping execution disclosure in command-execution.html. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const origin = process.env.PODIUM_COMMAND_HARNESS_ORIGIN ?? 'http://127.0.0.1:55752'
const evidence = process.env.PODIUM_COMMAND_EVIDENCE ?? '/tmp/podium-command-execution-evidence'
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const reports: unknown[] = []
try {
  for (const scene of ['codex', 'claude', 'states']) {
    const layouts: { width: number; paneWidth?: number }[] = [
      { width: 1100 },
      { width: 390 },
      { width: 320 },
    ]
    if (scene === 'claude') layouts.push({ width: 1100, paneWidth: 520 })
    for (const { width, paneWidth } of layouts) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        deviceScaleFactor: 1,
        permissions: ['clipboard-read', 'clipboard-write'],
        hasTouch: width === 390,
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}/harness/command-execution.html?scene=${scene}`, {
        waitUntil: 'networkidle',
      })
      if (paneWidth)
        await page.locator('.command-harness').evaluate((element, pixels) => {
          ;(element as HTMLElement).style.maxWidth = `${pixels}px`
        }, paneWidth)
      const root = page.getByTestId('turn-line')
      const toggle = root.locator(':scope > button[data-transcript-run-toggle]')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.focus()
      await page.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const executions = page.locator('.command-execution')
      await expect(executions).toHaveCount(scene === 'claude' ? 3 : 4)
      const first = executions.first()
      await first.locator(':scope > button').click()
      await expect(first).toHaveAttribute('data-open', 'true')
      await expect(first.locator('time')).toBeVisible()
      if (scene === 'codex') {
        await expect(first.locator('.execution-command')).toHaveCount(3)
        await expect(first.locator('.execution-output')).toHaveCount(1)
        await expect(first.locator('.execution-input button[aria-expanded]')).toHaveCount(0)
        await expect(executions.nth(2).locator('.execution-output-cue')).toHaveText('No output')
        await expect(executions.nth(3).locator('.execution-output-cue')).toHaveText(
          'Output unavailable',
        )
        await first.getByRole('button', { name: 'Copy full command', exact: true }).first().click()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('git status --short')
        await expect(
          first.getByRole('button', { name: 'Copy full command', exact: true }).first(),
        ).toHaveText('Copy')
        await first.getByRole('button', { name: 'Wrap', exact: true }).click()
        await expect(first.getByRole('button', { name: 'Wrap', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        )
      }
      if (scene === 'claude') {
        await expect(page.locator('.execution-batch')).toHaveCount(1)
        await expect(page.locator('.execution-batch-heading')).toContainText(
          'Inspect command rendering and transcript derivations',
        )
        await expect(first.locator('.execution-description')).toHaveText('Check the working tree ')
        await expect(first.locator('.execution-input-description')).toHaveCount(0)
        await expect(page.getByText('Native summary', { exact: true })).toHaveCount(0)
      }
      if (scene === 'states') {
        await expect(first.locator('.execution-empty-output')).toHaveText('No output was returned.')
        const partial = executions.nth(1)
        await partial.locator(':scope > button').click()
        await expect(partial.locator('.execution-more')).toContainText(
          'Showing 8 of 18 retained lines',
        )
        await partial.locator('.execution-more').click()
        await expect(partial.locator('.execution-output-text')).toContainText('case 18 passed')
        await partial.locator('.execution-output-text').focus()
        await page.keyboard.press('PageDown')
        await expect
          .poll(() =>
            partial.locator('.execution-output-text').evaluate((element) => element.scrollTop),
          )
          .toBeGreaterThan(0)
        await partial.locator('.execution-output-text').evaluate((element) => {
          element.scrollTop = 0
        })
        await expect(partial.locator('.execution-note')).toContainText(
          'Only the retained text is available',
        )
        await executions.nth(2).locator(':scope > button').click()
        await expect(executions.nth(2)).toHaveAttribute('data-verdict', 'err')
        await expect(executions.nth(3).locator('.execution-output-cue')).toHaveText(
          'Output not captured',
        )
      }
      const geometry = await page.evaluate(() => {
        const frames = [...document.querySelectorAll('.command-execution')].map((frame) => {
          const box = (selector: string) => {
            const element = frame.querySelector(selector)
            if (!element) throw new Error(`Execution is missing ${selector}`)
            return element.getBoundingClientRect()
          }
          const heading = box('.execution-heading')
          const title = box('.execution-title')
          const facts = box('.execution-facts')
          const open = frame.getAttribute('data-open') === 'true'
          const input = open ? box('.execution-inputs') : undefined
          const output = open ? box('.execution-output') : undefined
          const stamp = box('time')
          return {
            open,
            aligned:
              !input ||
              !output ||
              (Math.abs(input.x - output.x) < 1 && Math.abs(input.width - output.width) < 1),
            adjacent: !input || !output || Math.abs(input.bottom - output.top) < 1,
            timestampContained:
              (!open && stamp.width === 0) ||
              (stamp.width > 0 &&
                stamp.left >= heading.left &&
                stamp.right <= heading.right &&
                stamp.top >= heading.top &&
                stamp.bottom <= heading.bottom),
            metadataSeparate: title.right <= facts.left || title.bottom <= facts.top,
            metadataBelow: title.bottom <= facts.top,
            readableTitle: title.width >= Math.min(160, (heading.width * 2) / 3),
          }
        })
        return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, frames }
      })
      expect(geometry.pageWidth).toBeLessThanOrEqual(width)
      expect(geometry.frames.every((frame) => frame.aligned && frame.adjacent)).toBe(true)
      expect(
        geometry.frames.every((frame) => frame.timestampContained),
        'Timestamps must stay inside their execution header',
      ).toBe(true)
      expect(
        geometry.frames.every((frame) => frame.metadataSeparate),
        'Command titles and execution metadata must never overlap',
      ).toBe(true)
      if (width < 500 || paneWidth)
        expect(
          geometry.frames.every((frame) => frame.readableTitle && frame.metadataBelow),
          `Narrow headers must reserve the title width and place metadata below: ${JSON.stringify(geometry)}`,
        ).toBe(true)
      expect(errors).toEqual([])
      await page.screenshot({
        path: `${evidence}/${scene}-${paneWidth ? `pane-${paneWidth}` : width}.png`,
        fullPage: true,
      })
      reports.push({ scene, width, paneWidth, geometry, errors })
      if (scene === 'codex' && width === 1100) {
        await page.evaluate(() => document.documentElement.classList.add('dark'))
        await page.screenshot({ path: `${evidence}/codex-dark.png`, fullPage: true })
      }
      if (scene === 'claude' && width === 390) {
        await page.evaluate(() => document.documentElement.classList.add('dark'))
        await page.screenshot({ path: `${evidence}/claude-phone-dark.png`, fullPage: true })
      }
      await context.close()
    }
  }
  await writeFile(`${evidence}/browser-proof.json`, `${JSON.stringify(reports, null, 2)}\n`)
  console.log(
    `Execution disclosure proof: ${reports.length} layouts passed; evidence in ${evidence}`,
  )
} finally {
  await browser.close()
}
