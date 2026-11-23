// Screenshot the "Add subscription" harness (epic Task 9). Start it first with
// `bun --bun x vite --config vite.add-subscription-harness.config.ts` from apps/web.
// Usage: bun harness/add-subscription-shots.ts <outDir>
import { readdirSync } from 'node:fs'
import { chromium, type Page } from '@playwright/test'

const out = process.argv[2] ?? '.'
const cache = `${process.env.HOME}/.cache/ms-playwright`
const shell = readdirSync(cache)
  .filter((name) => name.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1)
const browser = await chromium.launch({
  executablePath: `${cache}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const errors: string[] = []

const signIn = async (page: Page) => {
  await page.getByRole('button', { name: /^Sign in on/ }).click()
}
const shots: { name: string; query: string; act?: (page: Page) => Promise<void> }[] = [
  { name: '1-choose', query: 'scene=waiting' },
  {
    name: '2-waiting-claude',
    query: 'scene=waiting',
    act: async (page) => {
      await signIn(page)
      await page.getByText(/Waiting for you/).waitFor()
    },
  },
  {
    name: '3-waiting-chatgpt',
    query: 'scene=waiting&type=chatgpt',
    act: async (page) => {
      await signIn(page)
      await page.getByText(/Waiting for you/).waitFor()
    },
  },
  {
    name: '4-signed-in',
    query: 'scene=new',
    act: async (page) => {
      await signIn(page)
      await page.getByText(/^Signed in as/).waitFor()
    },
  },
  {
    name: '5-signed-in-other-account',
    query: 'scene=identity-changed',
    act: async (page) => {
      await signIn(page)
      await page.getByText(/^Signed in as/).waitFor()
    },
  },
  {
    name: '6-attached',
    query: 'scene=attached',
    act: async (page) => {
      await signIn(page)
      await page.getByText(/^Signed in as/).waitFor()
    },
  },
  {
    name: '7-failed',
    query: 'scene=failed',
    act: async (page) => {
      await signIn(page)
      await page.getByRole('alert').waitFor()
    },
  },
  { name: '8-choose-light', query: 'scene=waiting&theme=light' },
]

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 720, height: 560 } })
  page.on('pageerror', (error) => errors.push(`${shot.name}: ${error.message}`))
  await page.goto(`http://localhost:55654/harness/add-subscription.html?${shot.query}`)
  await page.getByRole('button', { name: /^Sign in on/ }).waitFor()
  await shot.act?.(page)
  // Let a freshly mounted button finish its fade-in.
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/${shot.name}.png` })
  await page.close()
}
await browser.close()
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`wrote ${shots.length} shots to ${out}`)
