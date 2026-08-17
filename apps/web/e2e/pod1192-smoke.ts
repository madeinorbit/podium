import { chromium } from 'playwright'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1100, height: 800 } })
const errs: string[] = []
p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`))
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(`CONSOLE ${m.text()}`)
})
await p.goto('http://localhost:55599/shelf-harness.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(4000)
const has = await p.evaluate('typeof window.shelf')
const shelfCount = await p.evaluate(`document.querySelectorAll('.brief-shelf').length`)
const fontOk = await p.evaluate(`document.fonts.check('14px "Geist Variable"')`)
console.log(`window.shelf: ${has} | .brief-shelf count: ${shelfCount} | Geist loaded: ${fontOk}`)
console.log('errors:', errs.slice(0, 5))
await b.close()
