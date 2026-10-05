/** Run on flatblock: bun packages/client-graph/diagnostics/debug-name-heap.ts.
 * One production Vite bundle and the real dev server, five fresh contexts;
 * no timing claim, operator data, running app or persistent heap dump. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { build, createServer } from 'vite'

if (hostname() !== 'flatblock') throw new Error('Synthetic heap check runs on flatblock')
const root = resolve('packages/client-graph/diagnostics')
const outDir = resolve('.artifacts/debug-name-heap')
const common = {
  configFile: false as const, root,
  resolve: { conditions: ['@podium/source'], dedupe: ['mobx'] },
  cacheDir: resolve('node_modules/.cache/debug-name-heap'),
}
process.env.NODE_ENV = 'production'
await build({ ...common, build: {
  outDir, emptyOutDir: true, minify: false, sourcemap: false,
  rollupOptions: { input: resolve(root, 'debug-name.browser.html') },
} })

const production = httpServer(async (request, response) => {
  try {
    const path = new URL(request.url!, 'http://localhost').pathname
    const file = resolve(outDir, `.${path}`)
    if (!file.startsWith(`${outDir}/`)) throw new Error('Invalid path')
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html')
    response.end(await readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise<void>(done => production.listen(0, '127.0.0.1', done))
const address = production.address()
assert(address && typeof address === 'object')
process.env.NODE_ENV = 'development'
const dev = await createServer({ ...common, server: {
  host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [process.cwd()] },
} })
await dev.listen()
const browserServer = await chromium.launchServer({ headless: true, args: ['--no-sandbox'] })
console.log(`Chromium PID ${browserServer.process().pid}`)
const browser = await chromium.connect(browserServer.wsEndpoint())

interface Heap {
  snapshot: { meta: { node_fields: string[]; edge_fields: string[]; node_types: [string[]]; edge_types: [string[]] } }
  nodes: number[]; edges: number[]; strings: string[]
}
function nameCounts(heap: Heap) {
  const meta = heap.snapshot.meta
  const width = meta.node_fields.length, edgeWidth = meta.edge_fields.length
  const nameAt = meta.node_fields.indexOf('name'), typeAt = meta.node_fields.indexOf('type')
  const countAt = meta.node_fields.indexOf('edge_count'), sizeAt = meta.node_fields.indexOf('self_size')
  const edgeNameAt = meta.edge_fields.indexOf('name_or_index'), toAt = meta.edge_fields.indexOf('to_node')
  const edgeTypeAt = meta.edge_fields.indexOf('type')
  const firstEdge = new Map<number, number>()
  for (let node = 0, edge = 0; node < heap.nodes.length; node += width) {
    firstEdge.set(node, edge)
    edge += heap.nodes[node + countAt]! * edgeWidth
  }
  const edgeTo = (node: number, name: string): number | undefined => {
    const start = firstEdge.get(node)!
    const end = start + heap.nodes[node + countAt]! * edgeWidth
    for (let edge = start; edge < end; edge += edgeWidth) {
      const type = meta.edge_types[0][heap.edges[edge + edgeTypeAt]!]
      if ((type === 'property' || type === 'internal') && heap.strings[heap.edges[edge + edgeNameAt]!] === name)
        return heap.edges[edge + toAt]!
    }
    return undefined
  }
  const flat = (node: number, depth = 0): string => {
    if (depth > 64) throw new Error('Unexpected deep debug name')
    if (meta.node_types[0][heap.nodes[node + typeAt]!] !== 'concatenated string')
      return heap.strings[heap.nodes[node + nameAt]!]!
    const a = edgeTo(node, 'first'), b = edgeTo(node, 'second')
    assert(a !== undefined && b !== undefined, 'Concatenated name has both parts')
    return flat(a, depth + 1) + flat(b, depth + 1)
  }
  const custom = /^(pool[.@]|residency\.ids\.|header\.|settings\.|write\.overlays|(?:Issue|Session|Worktree|Repo)Model@)/
  const strings = new Set<number>()
  let namedObjects = 0, models = 0, reactions = 0, bytes = 0
  for (let node = 0; node < heap.nodes.length; node += width) {
    const target = edgeTo(node, 'name_')
    if (target === undefined) continue
    const name = flat(target)
    if (!custom.test(name)) continue
    namedObjects++
    if (/^IssueModel@heap-issue-\d+\./.test(name)) models++
    if (/^pool\.file\.heap-issue-\d+$/.test(name)) reactions++
    if (!strings.has(target)) { strings.add(target); bytes += heap.nodes[target + sizeAt]! }
  }
  return { namedObjects, modelComputeds: models, filingReactions: reactions, nameStrings: strings.size, shallowNameBytes: bytes }
}

try {
  for (const [mode, origin, query, enabled] of [
    ['production', `http://127.0.0.1:${address.port}`, '', false],
    ['development', dev.resolvedUrls!.local[0]!.replace(/\/$/, ''), '', true],
    ['production sidebar check', `http://127.0.0.1:${address.port}`, '?mobxSidebarCheck=1', true],
    ['production memory tool', `http://127.0.0.1:${address.port}`, '?toolNames=1', true],
  ] as const) {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${origin}/debug-name.browser.html${query}`)
      await page.waitForFunction(() => window.__debugNameHeap?.rows === 256)
      assert.deepEqual(errors, [], 'Fixture errors')
      const cdp = await context.newCDPSession(page)
      await cdp.send('HeapProfiler.collectGarbage')
      const chunks: string[] = []
      cdp.on('HeapProfiler.addHeapSnapshotChunk', event => chunks.push(event.chunk))
      await cdp.send('HeapProfiler.takeHeapSnapshot')
      const counts = nameCounts(JSON.parse(chunks.join('')) as Heap)
      console.log(JSON.stringify({ mode, rows: 256, ...counts }))
      if (enabled) {
        assert.equal(counts.filingReactions, 256, 'Every filing reaction keeps its diagnostic name')
        assert(counts.modelComputeds >= 256, 'Per-row names survive in diagnostics')
      } else {
        assert.equal(counts.namedObjects, 0, 'Production heap has no pool debug names')
        assert.equal(counts.nameStrings, 0, 'Production heap has no pool name strings')
      }
    } finally { await context.close() }
  }
  console.log('Pool debug-name heap check green')
} finally {
  await browser.close()
  await browserServer.close()
  await dev.close()
  await new Promise<void>((done, reject) => production.close(error => error ? reject(error) : done()))
}
