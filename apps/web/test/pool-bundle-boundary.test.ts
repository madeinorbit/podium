// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { eagerClientGraphSources, eagerJsFiles } from './web-bundle-boundaries'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = `${root}pool-boundary-fixture.js`

/** Exercise actual emitted static imports. The pool is the startup store now;
 * optional screen implementations retain their own deferred chunks. */
async function eagerSources(marker: string): Promise<string[]> {
  const exported = marker === '@podium/client-graph' ? 'MobxPool' :
    marker === '@podium/client-graph/issue-board-projection' ? 'createBoardProjection' : 'LOADING'
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { conditions: ['@podium/source', 'browser', 'module', 'production'] },
    plugins: [
      {
        name: 'pool-boundary-fixture',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? `
        import { ${exported} } from '${marker}'
        window.pendingRow = ${exported}
        if (window.location.search === '?mobxSidebar=1') {
          import('@podium/client-graph/runtime-pool').then((pool) => {
            window.createPool = pool.createRuntimeWorklistPool
          })
        }
      `
            : undefined,
      },
    ],
    build: { write: false, sourcemap: true, minify: false, rolldownOptions: { input: entry } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => {
    if (!('output' in output)) throw new Error('fixture unexpectedly started a build watcher')
    return output.output
  })
  const chunks = outputs.filter((output) => output.type === 'chunk')
  const manifest = Object.fromEntries(
    chunks.map((chunk) => [
      chunk.fileName,
      {
        file: chunk.fileName,
        imports: chunk.imports,
      },
    ]),
  )
  const eager = eagerJsFiles(
    chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName),
    manifest,
  )
  return chunks
    .filter((chunk) => eager.includes(chunk.fileName))
    .flatMap((chunk) => chunk.map?.sources ?? [])
}

describe('client-graph in Vite startup chunks', () => {
  it('shares only the constants leaf with the switch-gated pool', async () => {
    const sources = await eagerSources('@podium/client-graph/loading')
    expect(sources.some((source) => source.endsWith('/client-graph/src/loading.ts'))).toBe(true)
    expect(eagerClientGraphSources(sources)).toEqual([])
  }, 30_000)

  it('allows the pool constructor required by the always-pool first screen', async () => {
    const sources = await eagerSources('@podium/client-graph')
    expect(sources.some(source => source.endsWith('/client-graph/src/pool.ts'))).toBe(true)
    expect(eagerClientGraphSources(sources)).toEqual([])
  }, 30_000)

  it('catches a planted eager board reader using the actual emitted sources', async () => {
    const sources = await eagerSources('@podium/client-graph/issue-board-projection')
    expect(eagerClientGraphSources(sources)).toContainEqual(
      expect.stringContaining('/client-graph/src/issue-board-projection.ts'),
    )
  }, 30_000)
})
