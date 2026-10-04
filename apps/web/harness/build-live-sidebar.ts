/** Temporary counters in a production bundle; never instrument installed files. */
import { resolve } from 'node:path'
import { build } from 'vite'

const option = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const root = resolve(option('source', '.'))
const out = resolve(option('out', '.artifacts/live-sidebar/candidate-build'))
await build({
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  build: { outDir: out, emptyOutDir: true },
  plugins: [
    {
      name: 'live-sidebar-census',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/packages/client-graph/src/command-launch-views.ts')) return
        if (!code.includes('catalogBuilds: 0,') || !code.includes('launch: () => launch.get(),'))
          throw new Error('Launch census boundary changed')
        return code
          .replace('catalogBuilds: 0,', 'catalogBuilds: 0, launchReads: 0,')
          .replace(
            '  type Window =',
            '  ;(globalThis as any).__liveLaunchCensus = () => ({ ...counts })\n  type Window =',
          )
          .replace(
            'launch: () => launch.get(),',
            'launch: () => { counts.launchReads++; return launch.get() },',
          )
      },
    },
  ],
})
