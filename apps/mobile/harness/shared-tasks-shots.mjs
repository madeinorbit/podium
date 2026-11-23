/**
 * Checks and captures the phone shared-tasks harness (POD-6297). Serve it first:
 *   cd apps/mobile && ../web/node_modules/.bin/vite --config vite.shared-tasks-harness.config.ts
 * then `node harness/shared-tasks-shots.mjs <outDir>`.
 *
 * Each check prints PASS or FAIL; any FAIL or page error exits 1.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const OUT = process.argv[2] ?? 'shared-tasks-shots'
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1260, height: 900 }, deviceScaleFactor: 2 })
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
page.on('pageerror', (e) => problems.push(String(e)))
await page.goto('http://localhost:8093/shared-tasks-harness.html', {
  waitUntil: 'load',
  timeout: 120_000,
})
await page.getByTestId('panel-filters').waitFor({ timeout: 120_000 })

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const rowTexts = async (id) => page.getByTestId(id).allInnerTexts()

// 1. The default filter is Me: only Bob's own task, no assignee name on it.
check('Assigned to defaults to Me', await page.getByLabel('Assigned to, Me').isVisible())
let tasks = await rowTexts('task-row')
check(
  "Me lists only the reader's tasks",
  tasks.length === 1 && tasks[0].includes('Billing export'),
  JSON.stringify(tasks),
)
check("the reader's own task names no assignee", !tasks.join(' ').includes('Bob Keller'))
check(
  'Me counts as no active filter',
  !(await page.getByLabel('Clear all task filters').isVisible()),
)
await page.screenshot({ path: join(OUT, 'phone-1-default-me.png'), fullPage: true })

// 2. The Assigned to picker: Me, All users, then the other members by name.
await page.getByLabel('Assigned to, Me').click()
const options = (await page.getByTestId('panel-filters').innerText())
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
const want = ['Me', 'All users', 'Alice Martin', 'Carol Diaz']
check(
  'the picker offers Me, All users and the other members',
  want.every((o) => options.includes(o)),
  JSON.stringify(options),
)
check('the picker does not list the reader twice', !options.includes('Bob Keller'))
await page.screenshot({ path: join(OUT, 'phone-2-assigned-to-picker.png'), fullPage: true })

// 3. All users: other members' tasks appear, each naming its assignee.
await page.getByText('All users', { exact: true }).click()
await page.getByLabel('Assigned to, All users').waitFor()
tasks = await rowTexts('task-row')
check("All users shows other members' tasks", tasks.length === 3, JSON.stringify(tasks))
check(
  "another member's task names its assignee",
  tasks.some((t) => t.includes('Invite flow copy') && t.includes('Alice Martin')),
)
check(
  'All users counts as one active filter, with Clear all',
  await page.getByLabel('Clear all task filters').isVisible(),
)
await page.screenshot({ path: join(OUT, 'phone-3-all-users.png'), fullPage: true })
await page.getByLabel('Clear all task filters').click()
await page.getByLabel('Assigned to, Me').waitFor()
check('Clear all puts Assigned to back to Me', (await rowTexts('task-row')).length === 1)

// 4. The Work list stays personal; Alice's joined task wears her badge.
const work = await rowTexts('work-row')
check('Work holds the personal set only', work.length === 2, JSON.stringify(work))
check(
  'the joined task carries its owner badge',
  work.some((t) => t.includes('Invite flow copy') && t.includes('Alice Martin')),
)
check(
  "the reader's own Work row has no badge",
  work.some((t) => t.includes('Billing export') && !t.includes('·')),
)

// 5. Alice's task as Bob reads it: the assignee, and her sessions as D13 only.
const task = page.getByTestId('panel-task')
check(
  'the task page names its assignee',
  await task.getByLabel('Assignee Alice Martin — reassign').isVisible(),
)
const sessions = await page.getByTestId('other-member-session').allInnerTexts()
check(
  "the other member's sessions show as summaries",
  sessions.length === 2,
  JSON.stringify(sessions),
)
check("the reader's own session is not among them", !sessions.join(' ').includes('Bob’s own'))
const controls = await page.getByTestId('other-member-sessions').getByRole('button').count()
check('a summary offers no control', controls === 0, `${controls} buttons`)
await task.screenshot({ path: join(OUT, 'phone-4-task-page-d13.png') })

await browser.close()
if (problems.length) console.error(`page errors: ${problems.join(' | ')}`)
process.exit(failed || problems.length ? 1 : 0)
