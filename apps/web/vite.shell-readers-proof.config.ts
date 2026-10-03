/** Direct call census in the synthetic fixture only. Product bytes and the
 * shared session-index module remain unchanged in the candidate. */
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.sidebar-pool-perf.config'

export default defineConfig(mergeConfig(base, { plugins: [{
  name: 'shell-session-index-census', enforce: 'pre',
  transform(code: string, id: string) {
    if (!id.endsWith('/packages/client-core/src/session-index.ts')) return
    const point = '): ReadonlyMap<string, T> {'
    if (code.split(point).length !== 2) throw new Error('Session index census insertion point moved')
    return { code: code.replace(point, `${point}
      const census = globalThis.__shellSessionIndex
      if (census) { census.calls++; census.first ??= new Error().stack?.split('\\n').slice(1, 5).join('\\n') }
    `), map: null }
  },
}] }))
