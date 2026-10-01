/** Measurement-only build: production components, source maps, ordinary React. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '../node_modules/@tailwindcss/vite/dist/index.mjs'
import { defineConfig } from '../node_modules/vite/dist/node/index.js'

const repo = process.cwd()
const functions: Record<string, string[]> = {
  '/engine/state.ts': ['workspaceKeyForState'],
  '/viewmodels/mission.ts': ['missionRootFor', 'selectedMissionRoot', 'missionIssueIds', 'missionProgress', 'missionDepartures', 'buildFlightDeckRows'],
  '/viewmodels/session-ownership.ts': ['archivedSessionsForIssue', 'sessionsForIssueNav'],
  '/viewmodels/slices/machines/facts.ts': ['reposToViews'],
  '/replica/issue-view-cache.ts': ['modelsFor'],
}
export default defineConfig({
  root: resolve(repo, 'apps/web'),
  cacheDir: resolve(repo, 'node_modules/.cache/sidebar-acceptance'),
  plugins: [tailwindcss(), {
    name: 'acceptance-state-boundaries',
    enforce: 'pre',
    transform(code, id) {
      const names = Object.entries(functions).find(([suffix]) => id.endsWith(suffix))?.[1]
      if (!names) return
      for (const name of names) {
        const pattern = new RegExp(`(export\\s+)?function\\s+${name}(\\s*(?:<[^\\n]*>)?)\\s*\\(`)
        const match = code.match(pattern)
        if (!match) throw new Error(`Missing state measurement boundary ${id}:${name}`)
        code = code.replace(pattern, `${match[1] ?? ''}function __acceptance_${name}${match[2]}(`)
        code += `\n${match[1] ?? ''}function ${name}(...args:any[]) { const sink=(globalThis as any).__acceptanceTiming; if(!sink?.active()) return __acceptance_${name}(...args); const start=performance.now(); try{return __acceptance_${name}(...args)}finally{sink.record({start,end:performance.now(),kind:'main/shared derivation',name:${JSON.stringify(name)}})} }\n`
      }
      return { code, map: null }
    },
  }],
  resolve: {
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
    alias: { '@': resolve(repo, 'apps/web/src') },
  },
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    hmr: false,
    fs: {
      allow: [repo, ...['geist', 'geist-mono'].map(font =>
        realpathSync(resolve(repo, 'apps/web/node_modules/@fontsource-variable', font)))],
    },
  },
  build: {
    outDir: resolve(repo, '.artifacts/sidebar-acceptance/build'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: 'es2022',
    rollupOptions: { input: resolve(repo, 'apps/web/test/sidebar-acceptance.browser.html') },
  },
})
