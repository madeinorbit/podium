// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { eagerClientGraphSources, eagerJsFiles } from './web-bundle-boundaries'

it('keeps shared notice companions in their declared first-screen reader', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const entry = `${root}message-notice-boundary-fixture.js`
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { conditions: ['@podium/source', 'browser', 'module', 'production'] },
    plugins: [{
      name: 'message-notice-boundary-fixture',
      resolveId: id => id === entry ? entry : undefined,
      load: id => id === entry
        ? "import { noticeNewestMessage } from '@podium/client-graph/notice-views'; window.readNotice = noticeNewestMessage"
        : undefined,
    }],
    build: { write: false, sourcemap: true, minify: false, rolldownOptions: { input: entry } },
  })
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => {
    if (!('output' in output)) throw new Error('fixture unexpectedly started a build watcher')
    return output.output.filter(chunk => chunk.type === 'chunk')
  })
  const manifest = Object.fromEntries(chunks.map(chunk => [chunk.fileName, {
    file: chunk.fileName, imports: chunk.imports,
  }]))
  const eager = new Set(eagerJsFiles(chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName), manifest))
  const sources = chunks.filter(chunk => eager.has(chunk.fileName)).flatMap(chunk => chunk.map?.sources ?? [])
  expect(sources.some(source => source.endsWith('/client-graph/src/notice-views.ts'))).toBe(true)
  expect(eagerClientGraphSources(sources)).toEqual([])
  // The same boundary rejects the module that the returned web build named.
  expect(eagerClientGraphSources([...sources, 'packages/client-graph/src/notice-companions.ts']))
    .toContain('packages/client-graph/src/notice-companions.ts')
}, 30_000)
