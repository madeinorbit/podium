// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { transformWithOxc } from 'vite'
import { expect, it } from 'vitest'
import type { TranscriptGraph } from '@podium/client-core/conversation'
import { lowerDecorators, usesDecorators } from '../../../scripts/vite-standard-decorators'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const graphFile = `${root}packages/client-core/src/conversation/transcript-graph.ts`
const fields = ['latestAnswerId', 'latestAssistantId', 'latestProseId', 'pendingQuestionId'] as const

it('reproduces production erasure of an uninitialized TypeScript class field', async () => {
  const { code } = await transformWithOxc(`class Fields {
    missing: string | undefined
    present: string | undefined = undefined
  }`, graphFile)
  const Fields = new Function(`${code}; return Fields`)() as new () => object
  const instance = new Fields()
  expect(Object.hasOwn(instance, 'missing')).toBe(false)
  expect(Object.hasOwn(instance, 'present')).toBe(true)
})

it('constructs and observes all transcript facts in the minified production graph', async () => {
  // Compile the real sources through Vite's production TS transform before
  // bundling. Importing the TS class in Vitest alone can preserve absent fields.
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { TranscriptGraph } from './packages/client-core/src/conversation/transcript-graph';
        export { autorun, isObservableProp } from 'mobx';`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'productionGraph',
    target: 'es2022',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'production-typescript',
      setup(builder) {
        builder.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
          let source = readFileSync(path, 'utf8')
          if (usesDecorators(source, path)) source = (await lowerDecorators(source, path)).code
          const { code } = await transformWithOxc(source, path)
          return { contents: code, loader: 'js' }
        })
      },
    }],
  })
  const compiled = new Function(`${result.outputFiles[0]!.text}; return productionGraph`)() as {
    TranscriptGraph: new () => TranscriptGraph
    autorun: (read: () => void) => () => void
    isObservableProp: (object: object, property: string) => boolean
  }
  // On the unfixed source this throws MobX minified error nr: 1,
  // observable, ObservableObject.latestAnswerId (field not found).
  const graph = new compiled.TranscriptGraph()
  for (const field of fields) {
    expect(Object.hasOwn(graph, field), field).toBe(true)
    expect(compiled.isObservableProp(graph, field), field).toBe(true)
  }
  const seen: (string | undefined)[][] = []
  const stop = compiled.autorun(() => { seen.push(fields.map(field => graph[field])) })
  try {
    graph.apply({ changed: [
      { id: 'answer', role: 'assistant', text: 'Ready', answer: true },
      { id: 'question', role: 'tool', text: '', toolName: 'AskUserQuestion', toolUseId: 'ask' },
    ], insertions: [{ id: 'answer' }, { id: 'question' }] })
    graph.reset([])
    expect(seen).toEqual([
      [undefined, undefined, undefined, undefined],
      ['answer', 'answer', 'answer', 'question'],
      [undefined, undefined, undefined, undefined],
    ])
  } finally { stop() }
})
