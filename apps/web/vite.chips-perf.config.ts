import { mergeConfig } from 'vite'
import base from './vite.sidebar-pool-perf.config'

export default mergeConfig(base, {
  cacheDir: 'node_modules/.cache/issue-chips-vite',
  optimizeDeps: { entries: ['test/issue-chips.browser.html'] },
})
