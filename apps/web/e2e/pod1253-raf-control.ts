/**
 * POD-1253 positive control for the fold-motion sampler: a plain CSS height
 * transition in the same headless browser. If THIS reports a handful of frames
 * then the rig is blind and the sidebar's numbers mean nothing.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
await page.goto(
  'data:text/html,<body style="margin:0"><div id=x style="height:10px;background:red"></div></body>',
)
const out = await page.evaluate(async () => {
  const n: number[] = []
  let stop = false
  const tick = (t: number): void => {
    n.push(t)
    if (!stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const el = document.getElementById('x') as HTMLElement
  el.style.transition = 'height 600ms linear'
  requestAnimationFrame(() => {
    el.style.height = '400px'
  })
  await new Promise((r) => setTimeout(r, 900))
  stop = true
  return { frames: n.length, span: Math.round(n[n.length - 1] - n[0]) }
})
console.log('rAF control:', JSON.stringify(out))
await browser.close()
