/** Build-only instrumentation for the generic disk loader; no product behavior changes. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { build } from 'vite'

const changed = []
const helper = `
function diskProfileEvent(name, start, detail = {}) {
  const p = globalThis.__diskProfile
  if (!p?.active) return
  const end = performance.now()
  p.events.push({name, start, end, ...detail})
}
function diskProfileCount(name) {
  const p = globalThis.__diskProfile
  if (p?.active) p.counts[name] = (p.counts[name] ?? 0) + 1
}
`
function wrap(code, names) {
  const source = ts.createSourceFile('profile.ts', code, ts.ScriptTarget.Latest, true)
  const edits = []
  function visit(node) {
    const name = node.name?.getText(source)
    if (node.body && names[name]) {
      const [before, after] = names[name]
      edits.push([node.body.getStart(source) + 1, before], [node.body.end - 1, after])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const [at, text] of edits.sort((a, b) => b[0] - a[0]))
    code = code.slice(0, at) + text + code.slice(at)
  return code
}
const timed = (name, detail = '{}') => [
  `const diskProfileStart = performance.now(); try {`,
  `} finally { diskProfileEvent('${name}', diskProfileStart, ${detail}) }`,
]
await build({
  configFile: resolve('apps/web/vite.config.ts'),
  root: resolve('apps/web'),
  plugins: [
    {
      name: 'deck-disk-profile',
      enforce: 'pre',
      transform(original, id) {
        let code = original
        if (id.endsWith('/sync/src/adapters/indexeddb/store.ts')) {
          code = code.replace(
            'readDiskRows(keys: readonly string[]): Promise<readonly EntityRecord[]> {\n    return this.store.readStoredRows(this.principal, keys)\n  }',
            `async readDiskRows(keys: readonly string[]): Promise<readonly EntityRecord[]> {
          const start = performance.now()
          diskProfileEvent('disk.read.begin', start, {keys: keys.length})
          const rows = await this.store.readStoredRows(this.principal, keys)
          diskProfileEvent('disk.read.end', start, {keys: keys.length, rows: rows.length})
          return rows
        }`,
          )
        }
        if (id.endsWith('/sync/src/replica/replica.ts')) {
          code = wrap(code, {
            diskLoad: timed('replica.diskLoad', '{instances: requests.length}'),
            installFromDisk: timed('replica.installFromDisk', '{rows: rows.length}'),
            takeInstallTurn: timed('replica.installTurn'),
            arrivedWarm: timed('replica.arrivedWarm'),
            heldIndex: timed('replica.heldIndex'),
          })
          code = code.replace(
            '      const installed = this.store.installResident(rows.slice(at, at + DISK_INSTALL_ROWS))',
            `      const diskInstallStart = performance.now()
          const installed = this.store.installResident(rows.slice(at, at + DISK_INSTALL_ROWS))
          diskProfileEvent('disk.install', diskInstallStart, {rows: installed.length})`,
          )
        }
        if (id.endsWith('/sync/src/replica/loader.ts')) {
          code = wrap(code, {
            flush: timed(
              'loader.flush',
              '{queue: this.queue.size, diskRecords: this.diskRecords.size}',
            ),
          })
        }
        if (id.endsWith('/sync/src/replica/disk-index.ts')) {
          code = wrap(
            code,
            Object.fromEntries(
              ['record', 'membersOf', 'instance', 'inMemory'].map((name) => [
                name,
                [`diskProfileCount('index.${name}');`, ''],
              ]),
            ),
          )
        }
        if (id.endsWith('/client-graph/src/shared/row-source.ts')) {
          code = code.replace(
            '    return runInAction(flushPending)',
            `    const diskFlushStart = performance.now()
          const result = runInAction(flushPending)
          if (result) diskProfileEvent('rows.flush', diskFlushStart, {rows: result.rows.length, type: result.type})
          return result`,
          )
        }
        if (id.endsWith('/client-graph/src/shared/device-index.ts')) {
          code = wrap(code, { apply: timed('pool.index.apply', '{rows: event.rows.length}') })
        }
        if (
          id.endsWith('/client-graph/src/mission-screen.ts') ||
          id.endsWith('/client-graph/src/mission-full-deck.ts')
        ) {
          const name = id.includes('mission-screen') ? 'screen.ready' : 'full.ready'
          code = wrap(code, {
            ready: [
              'const diskProfileStart = performance.now(); const diskReady = (() => {',
              `})(); diskProfileEvent('${name}', diskProfileStart, {ready: diskReady}); return diskReady;`,
            ],
          })
        }
        if (code === original) return null
        changed.push(id.replace(process.cwd() + '/', ''))
        return { code: helper + code, map: null }
      },
    },
  ],
  build: { sourcemap: true },
  logLevel: 'warn',
})
writeFileSync('apps/web/dist/disk-profile-transforms.json', JSON.stringify(changed, null, 2))
console.log('Disk profile build:', changed)
