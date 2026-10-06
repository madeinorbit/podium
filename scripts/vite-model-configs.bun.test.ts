/** Every frontend config must compile the shared decorated entity models,
 * including configs that inherit their plugins from another harness. */
import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from '../apps/web/node_modules/vite/dist/node/index.js'

const root = resolve(import.meta.dirname, '..')
const models = resolve(root, 'packages/client-graph/src/models.ts')
const source = readFileSync(models, 'utf8')
const configs = [
  ...['apps/web', 'apps/mobile'].flatMap(directory =>
    readdirSync(resolve(root, directory))
      .filter(file => file.startsWith('vite.') && file.endsWith('.config.ts'))
      .map(file => `${directory}/${file}`),
  ),
  'apps/web/vitest.frontend-perf.config.ts',
  'apps/web/harness/sidebar-acceptance.vite.ts',
  'apps/web/harness/pool-memory.vite.ts',
  'tests/worklist/harness/web/vite.config.ts',
  'tests/worklist/harness/browser/window-cost.config.ts',
  'tests/worklist/harness/browser/runtime-pool.vite.config.ts',
].sort()
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => unknown

for (const config of configs) {
  test(`${config} loads and lowers the entity model decorators`, async () => {
    expect(source).toMatch(/@lazy/)
    const server = await createServer({
      configFile: resolve(root, config),
      logLevel: 'error',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
    try {
      expect(server.config.plugins.filter(plugin => plugin.name === 'podium-standard-decorators')).toHaveLength(1)
      const transformed = await server.transformRequest(`/@fs${models}`, { ssr: true })
      expect(transformed).not.toBeNull()
      // The engine parses exactly Vite's output, without a second compiler
      // that could silently lower decorators missing from the first pass.
      expect(() => new AsyncFunction(transformed!.code)).not.toThrow()
    } finally {
      await server.close()
    }
  }, 60_000)
}
