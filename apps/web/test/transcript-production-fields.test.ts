// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build, type Rolldown } from 'vite'
import { expect, it } from 'vitest'
import type { TranscriptGraph } from '@podium/client-core/conversation'
import { standardDecorators } from '../../../scripts/vite-standard-decorators'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const graphFile = `${root}packages/client-core/src/conversation/transcript-graph.ts`
const fields = ['latestAnswerId', 'latestAssistantId', 'latestProseId', 'pendingQuestionId'] as const

async function productionModule(witness = false) {
  const result = await build({
    root: `${root}apps/web`,
    configFile: false,
    logLevel: 'silent',
    resolve: { conditions: ['@podium/source'], dedupe: ['mobx'] },
    plugins: [standardDecorators(), {
      name: 'production-field-proof',
      enforce: 'pre',
      transform(source, id) {
        if (id !== graphFile) return
        return (witness ? `export class Fields {
          missing: string | undefined
          present: string | undefined = undefined
        }` : source) + "\nexport { autorun, isObservableProp } from 'mobx'"
      },
    }],
    build: {
      lib: { entry: graphFile, formats: ['iife'], name: 'productionGraph' },
      write: false,
      minify: true,
    },
  }) as Rolldown.RolldownOutput[]
  const chunk = result[0]!.output.find(output => output.type === 'chunk')!
  return new Function(`${chunk.code}; return productionGraph`)() as {
    Fields: new () => object
    TranscriptGraph: new () => TranscriptGraph
    autorun: (read: () => void) => () => void
    isObservableProp: (object: object, property: string) => boolean
  }
}

it('reproduces production erasure of an uninitialized TypeScript class field', async () => {
  const { Fields } = await productionModule(true)
  const instance = new Fields()
  expect(Object.hasOwn(instance, 'missing')).toBe(false)
  expect(Object.hasOwn(instance, 'present')).toBe(true)
})

it('constructs and observes all transcript facts in the minified production graph', async () => {
  // Use Vite's actual production pipeline: its bundled TS transform differs
  // from the development transform that Vitest applies to direct TS imports.
  const compiled = await productionModule()
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
