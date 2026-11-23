// Screenshot the shared task detail harness (POD-6295). Start it first with
// `bunx vite --config vite.shared-task-harness.config.ts --port <port>` from apps/web.
// Usage: bun harness/shared-task-shots.ts <port> <outDir>
import { chromium } from '@playwright/test'

const port = process.argv[2] ?? '55599'
const out = process.argv[3] ?? '.'
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(8000)
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e.stack ?? e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.goto(`http://localhost:${port}/harness/shared-task.html`)
await page.getByTestId('assignee-trigger').waitFor()

// 1. Bob's view: assignee, Alice's sessions as summaries, Origin with names.
await page.screenshot({ path: `${out}/shared-task-page.png`, fullPage: true })

// 2. The reassign menu lists the members by name.
await page.getByTestId('assignee-trigger').click()
await page.getByRole('menuitem', { name: 'Carol Diaz' }).waitFor()
await page.screenshot({ path: `${out}/shared-task-reassign.png` })
await page.getByRole('menuitem', { name: 'Carol Diaz' }).click()

// 3. The description history, named by member, with Restore on the earlier one.
await page.getByTestId('description-history-toggle').click()
await page.getByTestId('text-revision').first().waitFor()
await page.getByTestId('text-revision-restore').click()
await page.getByTestId('harness-description').screenshot({ path: `${out}/shared-task-history.png` })

// 4. Bob's own comment opens for editing; Alice's has no Edit.
const bob = page.getByTestId('activity-comment').filter({ hasText: 'I will review' })
await bob.hover()
await bob.getByTestId('comment-edit').click()
await page.getByTestId('activity-feed').screenshot({ path: `${out}/shared-task-comments.png` })
await bob.getByLabel('Edit comment').fill('I will review the variants this afternoon, after lunch.')
await bob.getByTestId('comment-save').click()

const facts = await page.evaluate(() => {
  const q = (s: string) => [...document.querySelectorAll(s)]
  return {
    probe: window.probe,
    assignee: document.querySelector('[data-testid="assignee-trigger"]')?.textContent,
    legacy: document.querySelector('[data-testid="assignee-legacy"]')?.textContent,
    createdBy: document.querySelector('[data-testid="about-created-by"]')?.textContent,
    collaborators: document.querySelector('[data-testid="about-collaborators"]')?.textContent,
    visibility: document.querySelector('[data-testid="about-visibility"]')?.textContent,
    summaryControls: q(
      '[data-testid="other-member-sessions"] button, [data-testid="other-member-sessions"] a',
    ).length,
    editButtons: q('[data-testid="comment-edit"]').length,
    conflict: document.querySelector('[data-testid="description-conflict"]')?.textContent,
    events: q('[data-testid="activity-event"]').map((e) => e.textContent),
    rawIds: document.body.textContent?.includes('mem_'),
    share: /\bshare\b/i.test(document.body.textContent ?? ''),
  }
})
console.log(JSON.stringify(facts, null, 1))
console.log('errors', JSON.stringify(errors.slice(0, 8)))
await browser.close()
