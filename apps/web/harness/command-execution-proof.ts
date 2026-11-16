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
    for (const width of [390, 1100]) {
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
        const frames = [...document.querySelectorAll('.command-execution[data-open="true"]')].map(
          (frame) => {
            const input = frame.querySelector('.execution-inputs')!.getBoundingClientRect()
            const output = frame.querySelector('.execution-output')!.getBoundingClientRect()
            return {
              aligned: Math.abs(input.x - output.x) < 1 && Math.abs(input.width - output.width) < 1,
              adjacent: Math.abs(input.bottom - output.top) < 1,
            }
          },
        )
        return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, frames }
      })
      expect(geometry.pageWidth).toBeLessThanOrEqual(width)
      expect(geometry.frames.every((frame) => frame.aligned && frame.adjacent)).toBe(true)
      expect(errors).toEqual([])
      await page.screenshot({ path: `${evidence}/${scene}-${width}.png`, fullPage: true })
      reports.push({ scene, width, geometry, errors })
      if (scene === 'codex' && width === 1100) {
        await page.evaluate(() => document.documentElement.classList.add('dark'))
        await page.screenshot({ path: `${evidence}/codex-dark.png`, fullPage: true })
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
