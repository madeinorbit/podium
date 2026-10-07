import { writeFileSync } from 'node:fs'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { expandSidebarIfFolded, openHome } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop draft entry points')
test.setTimeout(120_000)

async function nativeMiddleEdit(page: Page, field: Locator) {
  await field.click()
  const text = 'abcdefghijklmnopqrst'
  if (process.env.PODIUM_CARET_CAUSE_CONTROL) {
    // The broken controlled field can lose sequential seed characters too.
    // Seed with one native text-input event, then test the physical click/key.
    await page.keyboard.insertText(text)
  } else {
    await page.keyboard.type(text, { delay: 20 })
  }
  await expect(field).toHaveValue(text)
  await page.waitForTimeout(150)
  const point = await field.evaluate(t => {
    const el = t as HTMLInputElement | HTMLTextAreaElement
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    const canvas = document.createElement('canvas').getContext('2d')!
    canvas.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    ;(window as any).__caretField = el
    ;(window as any).__caretWrites = []
    return { x: r.left + parseFloat(s.paddingLeft) + canvas.measureText('abcde').width,
      y: r.top + parseFloat(s.paddingTop) + (parseFloat(s.lineHeight) || 20) / 2 }
  })
  await page.mouse.click(point.x, point.y)
  const read = () => field.evaluate(t => {
    const el = t as HTMLInputElement | HTMLTextAreaElement
    return { value: el.value, defaultValue: el.defaultValue, start: el.selectionStart!, end: el.selectionEnd!,
      sameNode: el === (window as any).__caretField, focused: el === document.activeElement }
  })
  const before = await read()
  expect(before.focused).toBe(true)
  expect(before.start).toBe(5)
  expect(before.end).toBe(5)
  await page.keyboard.type('Z')
  // Includes asynchronous persistence/echo, not just the immediate input event.
  await page.waitForTimeout(1_000)
  const after = await read()
  const writes = await page.evaluate(() => (window as any).__caretWrites)
  const passed = after.focused && after.sameNode && after.start === before.start + 1 &&
    after.end === before.start + 1 &&
    after.value === before.value.slice(0, before.start) + 'Z' + before.value.slice(before.end)
  return { before, after, writes, passed }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 900 })
  await page.addInitScript(() => {
    ;(window as any).__caretWrites = []
    for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
      for (const property of ['value', 'defaultValue'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, property)!
        Object.defineProperty(proto, property, { ...descriptor, set(value) {
          const before = [this.selectionStart, this.selectionEnd]
          descriptor.set!.call(this, value)
          if (this !== (window as any).__caretField) return
          ;(window as any).__caretWrites.push({ label: this.getAttribute('aria-label'), property, value,
            before, after: [this.selectionStart, this.selectionEnd], stack: new Error().stack })
        } })
      }
    }
  })
  await openHome(page)
})

test('New task dialog title and description retain native middle edits', async ({ page }, info) => {
  await page.getByTestId('topbar-nav-issues').click()
  await page.getByRole('button', { name: 'New Task', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const results = []
  for (const label of ['Title', 'Description']) {
    const result = { label, ...await nativeMiddleEdit(page, dialog.getByRole('textbox', { name: label, exact: true })) }
    results.push(result)
  }
  await info.attach('native-field-writes', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  writeFileSync(info.outputPath('native-field-writes.json'), JSON.stringify(results, null, 2))
  const screenshot = await page.screenshot()
  writeFileSync(info.outputPath('dialog.png'), screenshot)
  await info.attach('dialog', { body: screenshot, contentType: 'image/png' })
  expect(results.filter(result => !result.passed)).toEqual([])
  for (const result of results) {
    expect(result.after.defaultValue).toBe(result.before.defaultValue)
    expect(result.writes.filter((write: { property: string }) => write.property === 'value')).toEqual([])
  }
})

test('persisted New task launch draft retains a native middle edit', async ({ page }, info) => {
  await expandSidebarIfFolded(page)
  await page.getByRole('button', { name: 'New task', exact: true }).first().click()
  const result = await nativeMiddleEdit(page, page.getByRole('textbox', { name: 'What do you want to work on?', exact: true }))
  await info.attach('native-field-writes', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  writeFileSync(info.outputPath('native-field-writes.json'), JSON.stringify(result, null, 2))
  const screenshot = await page.screenshot()
  writeFileSync(info.outputPath('launch-draft.png'), screenshot)
  await info.attach('launch-draft', { body: screenshot, contentType: 'image/png' })
  expect(result.passed).toBe(true)
  // The cause control deliberately restores the controlled field while keeping
  // the synchronous source publication, then plants its revert. Both variants
  // must meet the same native caret assertion above, independently of the guard.
  if (!process.env.PODIUM_CARET_CAUSE_CONTROL) {
    expect(result.after.defaultValue).toBe(result.before.defaultValue)
    expect(result.writes.filter((write: { property: string }) => write.property === 'value')).toEqual([])
  }
})
