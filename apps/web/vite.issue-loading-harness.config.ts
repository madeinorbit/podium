import { fileURLToPath } from 'node:url'
import { type ConfigEnv, defineConfig, type PluginOption, type UserConfig } from 'vite'
import deck from './vite.deck-harness.config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/** Shipping dock, stylesheet and empty-device reads; no installed instance. */
export default defineConfig(async (env) => {
  const config = await (deck as (env: ConfigEnv) => Promise<UserConfig>)(env)
  return {
    ...config,
    optimizeDeps: { entries: ['harness/issue-loading.html'] },
    plugins: [
      {
        name: 'issue-loading-fixture',
        enforce: 'pre',
        resolveId(source) {
          if (source === './deck-store-stub') return here('./harness/issue-loading-store.ts')
          if (source.endsWith('/store-worklist-pool') || source === './store-worklist-pool')
            return here('./harness/issue-loading-pool.ts')
          if (source === 'vitest') return here('./harness/issue-loading-vitest.ts')
          // Before evidence uses exactly the pre-change presentation: BodyPending
          // draws its own row and the surrounding column supplies the section gap.
          if (process.env.ISSUE_LOADING_BEFORE === '1' && source === './IssueLoadingBlock')
            return '\0issue-loading-before'
        },
        load(id) {
          if (id === '\0issue-loading-before')
            return 'export const IssueLoadingBlock = ({children}) => children; export const useGroupedIssuePending = () => false;'
        },
      } as PluginOption,
      ...((config.plugins as PluginOption[]) ?? []),
    ],
    server: { ...config.server, host: '127.0.0.1', port: 0, strictPort: false, proxy: {} },
  }
})
