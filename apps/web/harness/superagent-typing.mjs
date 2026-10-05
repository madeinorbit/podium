/** Synthetic compact-composer capture. Run against webkit-typing-server.mjs. */
import { writeFileSync } from 'node:fs'
import { cpus, hostname, loadavg } from 'node:os'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'

const arg = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const origin = arg('origin', 'http://127.0.0.1:19555')
const out = arg('out', '.artifacts/POD-5554/before-1x')
const mode = arg('mode', 'timing')
const ablate = process.argv.includes('--ablate')
const fixture = await (await fetch(`${origin}/__fixture`)).json()
const browser = await chromium.launch({
  headless: true,
  executablePath: arg('chromium', undefined),
})
let page
const errors = []
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: 'block',
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`${origin}/?e2e=1`, { waitUntil: 'domcontentloaded' })
  const toggle = page.getByRole('button', { name: 'Superagent', exact: true })
  if ((await toggle.getAttribute('aria-pressed', { timeout: 90000 })) !== 'true')
    await toggle.click({ timeout: 90000 })
  const field = page.getByPlaceholder('Ask across all tasks…', { exact: true })
  await field.waitFor({ state: 'visible', timeout: 90000 })
  await field.fill('')
  await field.focus()
  await page.waitForTimeout(1500)
  const population = await page.evaluate(async () => {
    const counts = {}
    for (const info of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(info.name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (db.objectStoreNames.contains('entities')) {
        const rows = await new Promise((resolve, reject) => {
          const request = db.transaction('entities', 'readonly').objectStore('entities').getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        for (const row of rows) counts[row.entity] = (counts[row.entity] ?? 0) + 1
      }
      db.close()
    }
    return counts
  })
  if (population.issueProjection < fixture.issues || population.session < fixture.sessions)
    throw Error(`Incomplete corpus: ${JSON.stringify(population)}`)
  const cdp = await context.newCDPSession(page)
  await page.evaluate(
    ({ ablate, mode }) => {
      const ta = document.querySelector('textarea.prompt-input')
      if (!ta) throw Error('Compact composer missing')
      window.__typing = {
        inputs: [],
        work: { scrollHeight: 0, offsetHeight: 0, styles: 0, heightWrites: 0 },
        mutations: {},
      }
      if (ablate) {
        const height = ta.scrollHeight
        const previous = ta.style.height
        Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => height })
        Object.defineProperty(ta, 'offsetHeight', { configurable: true, get: () => height })
        Object.defineProperty(ta.style, 'height', {
          configurable: true,
          get: () => previous,
          set: () => {},
        })
      }
      if (mode === 'work') {
        for (const property of ['scrollHeight', 'offsetHeight']) {
          let proto = ta
          while (proto && !Object.getOwnPropertyDescriptor(proto, property))
            proto = Object.getPrototypeOf(proto)
          const descriptor = Object.getOwnPropertyDescriptor(proto, property)
          Object.defineProperty(ta, property, {
            configurable: true,
            get() {
              window.__typing.work[property]++
              return descriptor.get.call(this)
            },
          })
        }
        const original = window.getComputedStyle
        window.getComputedStyle = (element, ...args) => {
          if (element === ta) window.__typing.work.styles++
          return original(element, ...args)
        }
        Object.defineProperty(ta.style, 'height', {
          configurable: true,
          get() {
            return this.getPropertyValue('height')
          },
          set(value) {
            window.__typing.work.heightWrites++
            this.setProperty('height', value)
          },
        })
      }
      document.addEventListener(
        'beforeinput',
        (event) => {
          if (event.target !== ta || !event.isTrusted) return
          const index = window.__typing.inputs.length
          performance.mark(`typing:${index}:input`, { startTime: event.timeStamp })
          window.__typing.inputs.push({
            index,
            timestamp: event.timeStamp,
            dispatched: performance.now(),
          })
          requestAnimationFrame(() =>
            setTimeout(() => {
              window.__typing.inputs[index].postFrame = performance.now()
            }, 0),
          )
        },
        true,
      )
    },
    { ablate, mode },
  )
  const trace = []
  const receive = ({ value }) => trace.push(...value)
  cdp.on('Tracing.dataCollected', receive)
  await cdp.send('Tracing.start', {
    categories:
      'toplevel,devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack',
    transferMode: 'ReportEvents',
  })
  if (mode === 'profile') {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.start')
  }
  const loadStart = loadavg()
  const began = performance.now()
  for (let i = 0; i < 60; i++) {
    await page.keyboard.insertText('x')
    const remaining = began + (i + 1) * 100 - performance.now()
    if (remaining > 0) await page.waitForTimeout(remaining)
  }
  await page.waitForTimeout(200)
  const profile = mode === 'profile' ? (await cdp.send('Profiler.stop')).profile : null
  const completed = new Promise((done) => cdp.once('Tracing.tracingComplete', done))
  await cdp.send('Tracing.end')
  await completed
  const data = await page.evaluate(() => ({
    ...window.__typing,
    final: document.querySelector('textarea.prompt-input').value,
    elements: document.querySelectorAll('*').length,
    supportsNativeSizing: CSS.supports('field-sizing', 'content'),
  }))
  if (data.inputs.length !== 60 || data.final !== 'x'.repeat(60))
    throw Error('Incomplete trusted typing capture')
  delete data.final
  const marks = trace
    .filter((event) => /^typing:\d+:input$/.test(event.name))
    .sort((a, b) => a.ts - b.ts)
  const keys = marks.map((mark, index) => {
    const limit = marks[index + 1]?.ts ?? mark.ts + 100000
    const events = trace.filter(
      (event) =>
        event.pid === mark.pid &&
        event.tid === mark.tid &&
        event.ph === 'X' &&
        event.ts >= mark.ts &&
        event.ts < limit,
    )
    const paint = events.find((event) => event.name === 'Paint')
    const sum = (names) =>
      events
        .filter((event) => names.includes(event.name))
        .reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
    return {
      index,
      inputToPaint: paint ? (paint.ts + paint.dur - mark.ts) / 1000 : null,
      layout: sum(['Layout', 'UpdateLayoutTree']),
      paint: sum(['Paint', 'PrePaint']),
      script: sum(['FunctionCall']),
      layouts: events
        .filter((event) => event.name === 'Layout')
        .map((event) => ({ ms: event.dur / 1000, stack: event.args?.beginData?.stackTrace })),
    }
  })
  if (keys.length !== 60 || keys.some((key) => key.inputToPaint === null))
    throw Error('Every key must have an actual Chromium Paint')
  const stats = (values) => {
    const sorted = values.filter((value) => value !== null).sort((a, b) => a - b)
    return {
      n: sorted.length,
      median:
        (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted.at(-1),
    }
  }
  const summary = {
    inputToPaint: stats(keys.map((key) => key.inputToPaint)),
    postFrame: stats(data.inputs.map((input) => input.postFrame - input.timestamp)),
    layout: stats(keys.map((key) => key.layout)),
    paint: stats(keys.map((key) => key.paint)),
    script: stats(keys.map((key) => key.script)),
  }
  writeFileSync(
    `${out}.json`,
    JSON.stringify(
      {
        fixture,
        population,
        mode,
        ablate,
        host: hostname(),
        cpu: cpus()[0].model,
        browser: browser.version(),
        loadStart,
        loadEnd: loadavg(),
        errors,
        ...data,
        keys,
        summary,
      },
      null,
      2,
    ),
  )
  writeFileSync(`${out}.trace.json.gz`, gzipSync(JSON.stringify(trace)))
  if (profile) writeFileSync(`${out}.profile.json`, JSON.stringify(profile))
  console.log(JSON.stringify({ out, ...summary, work: data.work, errorCount: errors.length }))
} catch (error) {
  writeFileSync(
    `${out}.failure.json`,
    JSON.stringify(
      {
        error: String(error),
        errors,
        body: await page
          ?.locator('body')
          .innerText()
          .catch(() => ''),
        url: page?.url(),
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await browser.close()
}
