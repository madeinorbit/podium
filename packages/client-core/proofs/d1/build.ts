/** Run only under scripts/test-heavy.ts. Builds isolated entries, never app routes. */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const directory = fileURLToPath(new URL('./', import.meta.url))
const output = join(directory, 'results/builds')
mkdirSync(output, { recursive: true })
const webRequire = createRequire(join(root, 'apps/web/package.json'))
const { build } = await import(webRequire.resolve('vite'))
const measurements: unknown[] = []
for (const candidate of (process.env.PODIUM_D7_PROOF === '1' ? ['mobx', 'keyed'] : ['mobx', 'tanstack', 'keyed'])) {
  const entry = join(output, `${candidate}-entry.tsx`)
  writeFileSync(entry, `import * as proof from '../../${candidate}';\n(globalThis as any).__D1_PROOF__ = proof;\n`)
  const dist = join(output, candidate)
  await build({ configFile: false, root: join(root, 'apps/web'),
    resolve: { conditions: ['@podium/source'], dedupe: ['react', 'react-dom'] },
    build: { outDir: dist, emptyOutDir: true, minify: true,
      lib: { entry, formats: ['es'], fileName: 'proof' },
      rollupOptions: { external: ['react', 'react/jsx-runtime', 'react-dom'] } } })
  const bytes = readdirSync(dist).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dist, f)))
  measurements.push({ candidate, build: 'Vite isolated proof; React external', bytes: bytes.reduce((n,b) => n+b.length,0), gzipBytes: bytes.reduce((n,b) => n+gzipSync(b).length,0) })
  const libraryEntry = join(output, `${candidate}-library.ts`)
  writeFileSync(libraryEntry, candidate === 'keyed' ? 'export {};\n' : candidate === 'mobx'
    ? "export { observable, computed, runInAction } from 'mobx'; export { observer } from 'mobx-react-lite';\n"
    : "export { createCollection, createLiveQueryCollection, BasicIndex, eq, lte, count, max, sum, caseWhen, coalesce, gt } from '@tanstack/db'; export { useLiveQuery } from '@tanstack/react-db';\n")
  const libraryDist = join(output, `${candidate}-library`)
  await build({ configFile: false, root: join(root, 'apps/web'),
    build: { outDir: libraryDist, emptyOutDir: true, minify: true,
      lib: { entry: libraryEntry, formats: ['es'], fileName: 'library' },
      rollupOptions: { external: ['react', 'react/jsx-runtime', 'react-dom'] } } })
  const libraryBytes = readdirSync(libraryDist).filter(f => f.endsWith('.js')).map(f => readFileSync(join(libraryDist, f)))
  measurements.push({ candidate, build: 'Vite library-only; React external', bytes: libraryBytes.reduce((n,b) => n+b.length,0), gzipBytes: libraryBytes.reduce((n,b) => n+gzipSync(b).length,0) })
  for (const platform of ['web', 'ios', 'android']) {
    const bundle = join(output, `${candidate}-${platform}.js`)
    const child = Bun.spawn([join(root, 'apps/mobile/node_modules/.bin/expo'), 'export:embed', '--entry-file', entry,
      '--platform', platform, '--bundle-output', bundle, '--dev', 'false', '--minify', 'true'],
      { cwd: join(root, 'apps/mobile'), stdout: 'inherit', stderr: 'inherit', env: { ...process.env, CI: '1' } })
    const code = await child.exited
    if (code !== 0) throw new Error(`${candidate} Expo ${platform}: exit ${code}`)
    const content = readFileSync(bundle)
    measurements.push({ candidate, build: `Expo ${platform} isolated entry; includes React`, bytes: content.length, gzipBytes: gzipSync(content).length })
  }
}
writeFileSync(join(directory, 'results/bundles.json'), JSON.stringify(measurements, null, 2) + '\n')
