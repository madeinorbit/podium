// @vitest-environment node
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, type Rolldown } from 'vite'
import { expect, it } from 'vitest'
import type { TranscriptGraph } from '@podium/client-core/conversation'
import { standardDecorators } from '../../../scripts/vite-standard-decorators'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const graphFile = `${root}packages/client-core/src/conversation/transcript-graph.ts`
const fields = ['latestAnswerId', 'latestAssistantId', 'latestProseId', 'pendingQuestionId'] as const

type Compiler = 'desktop' | 'phone'

function phoneSource(source: string): string {
  // Resolve Babel through Metro, just as the production Expo exporter does
  // under the isolated linker, without adding a second Babel dependency.
  const mobileRequire = createRequire(`${root}apps/mobile/package.json`)
  const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'))
  const metroRequire = createRequire(expoRequire.resolve('@expo/metro-config/package.json'))
  const babel = metroRequire('@babel/core') as {
    transformSync: (source: string, options: object) => { code: string }
  }
  return babel.transformSync(source, {
    filename: graphFile,
    configFile: `${root}apps/mobile/babel.config.js`,
    babelrc: false,
    envName: 'production',
    caller: { name: 'metro', bundler: 'metro', platform: 'web', isDev: false,
      isServer: false, supportsStaticESM: true },
  }).code
}

async function productionModule(compiler: Compiler, witness = false) {
  const result = await build({
    root: `${root}apps/web`,
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { conditions: ['@podium/source'], dedupe: ['mobx'] },
    plugins: [standardDecorators(), {
      name: 'production-field-proof',
      enforce: 'pre',
      transform(source, id) {
        if (id !== graphFile) return
        const input = witness ? `export class Fields {
          missing: string | undefined
          present: string | undefined = undefined
        }` : source
        return (compiler === 'phone' ? phoneSource(input) : input) +
          "\nexport { autorun, isObservableProp } from 'mobx'"
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

it.each(['desktop', 'phone'] as const)('%s production class-field semantics', async compiler => {
  const { Fields } = await productionModule(compiler, true)
  const instance = new Fields()
  expect(Object.hasOwn(instance, 'missing')).toBe(compiler === 'desktop')
  expect(Object.hasOwn(instance, 'present')).toBe(true)
})

it.each(['desktop', 'phone'] as const)('%s constructs and observes all transcript facts in production', async compiler => {
  // Use Vite's actual production pipeline: its bundled TS transform differs
  // from the development transform that Vitest applies to direct TS imports.
  const compiled = await productionModule(compiler)
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
      { id: 'question', role: 'tool', text: '', toolName: 'AskUserQuestion', toolUseId: 'ask', toolInputJson: '{}' },
    ], insertions: [{ id: 'answer' }, { id: 'question' }] })
    graph.reset([])
    expect(seen).toEqual([
      [undefined, undefined, undefined, undefined],
      ['answer', 'answer', 'answer', 'question'],
      [undefined, undefined, undefined, undefined],
    ])
  } finally { stop() }
})
