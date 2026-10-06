/**
 * Drive the Podium desktop app's UI inside the Windows guest over the Chrome DevTools
 * Protocol, by visible text instead of screen pixels. The app must have been started with
 * PODIUM_WEBVIEW_DEBUG_PORT=9222 (boat-win.sh app does that). Runs in the guest:
 *
 *   boat-win.sh ui ID text                       print the page's visible text
 *   boat-win.sh ui ID buttons                    list visible buttons/menu items by accessible name
 *   boat-win.sh ui ID click 'Pick a project'     click the first visible element with this text
 *   boat-win.sh ui ID button 'Continue'          click the visible button with this accessible name
 *   boat-win.sh ui ID fill 'placeholder' 'C:\x'  fill the input with this placeholder or label
 *   boat-win.sh ui ID press Enter                press a key
 *   boat-win.sh ui ID eval 'location.href'       evaluate an expression
 *   boat-win.sh ui ID shot                       full-page screenshot to C:\ui.png
 *
 * Several steps chain in one call: `click 'Pick a project' then fill 'repository path' 'C:\x'`.
 */
import { chromium } from '@playwright/test'

const endpoint = process.env.PODIUM_UI_CDP ?? 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(endpoint)
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => !candidate.url().startsWith('devtools://'))
if (!page) throw new Error(`no page behind ${endpoint}`)

const steps: string[][] = [[]]
for (const arg of process.argv.slice(2)) {
  if (arg === 'then') steps.push([])
  else steps.at(-1)?.push(arg)
}

for (const [action, ...args] of steps) {
  switch (action) {
    case 'text':
      console.log(await page.locator('body').innerText())
      break
    case 'buttons': {
      const names = await page
        .locator('button, [role=button], [role=menuitem], [role=tab], a[href]')
        .filter({ visible: true })
        .evaluateAll((els) =>
          els.map((el) =>
            (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').trim(),
          ),
        )
      console.log(names.filter(Boolean).join('\n'))
      break
    }
    case 'click':
      await page
        .getByText(args[0] ?? '', { exact: false })
        .filter({ visible: true })
        .first()
        .click()
      await page.waitForTimeout(1_000)
      break
    case 'button': {
      // An exact accessible name first ("Shell" must not hit "Share …"), then a partial one.
      const exact = page.getByRole('button', { name: args[0] ?? '', exact: true }).filter({ visible: true })
      const target = (await exact.count())
        ? exact
        : page.getByRole('button', { name: args[0] ?? '', exact: false }).filter({ visible: true })
      await target.first().click()
      await page.waitForTimeout(1_000)
      break
    }
    case 'fill': {
      const target = args[0] ?? ''
      const byPlaceholder = page.getByPlaceholder(target, { exact: false })
      const field = (await byPlaceholder.count()) ? byPlaceholder : page.getByLabel(target)
      await field.first().fill(args[1] ?? '')
      break
    }
    case 'press':
      await page.keyboard.press(args[0] ?? 'Enter')
      break
    case 'eval':
      console.log(JSON.stringify(await page.evaluate(args[0] ?? 'null'), null, 2))
      break
    case 'shot':
      await page.screenshot({ path: args[0] ?? 'C:\\ui.png' })
      break
    case 'wait':
      await page.waitForTimeout(Number(args[0] ?? 1000))
      break
    default:
      throw new Error(`unknown step: ${action}`)
  }
}
await browser.close()
