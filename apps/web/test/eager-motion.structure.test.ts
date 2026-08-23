// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import worklistMotionFeatures from '../src/features/worklist/worklist-motion-features'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = fileURLToPath(new URL('../src', import.meta.url))
const APP_SHELL = resolve(SRC, 'app/AppShell.tsx')
const WORKLIST_MOTION_ENTRY = resolve(SRC, 'features/worklist/worklist-motion-features.ts')
const STATIC_IMPORT_RE = /(?<![-'"])\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s+['"]([^'"\n]+)['"]/g
const FORBIDDEN_MOTION_IMPLEMENTATION =
  /\/(?:framer-motion|motion-dom)\/dist\/es\/(?:gestures\/(?:drag|pan|hover|focus|press)|motion\/features\/(?:drag|gestures|viewport))(?:\/|\.mjs)/

function sourcePath(importer: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(importer), specifier)
      : null
  if (!base) return null
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function eagerShellGraph(): { files: Set<string>; packageImports: Map<string, Set<string>> } {
  const files = new Set<string>()
  const packageImports = new Map<string, Set<string>>()
  const pending = [APP_SHELL]

  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || files.has(file)) continue
    files.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(STATIC_IMPORT_RE)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      const local = sourcePath(file, specifier)
      if (local) {
        pending.push(local)
        continue
      }
      if (specifier.startsWith('.') || specifier.startsWith('@/')) continue
      const importers = packageImports.get(specifier) ?? new Set<string>()
      importers.add(relative(SRC, file).replaceAll('\\', '/'))
      packageImports.set(specifier, importers)
    }
  }

  return { files, packageImports }
}

async function emittedWorklistMotionGraph(): Promise<{
  bytes: number
  modules: string[]
  forbidden: string[]
}> {
  const result = await build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: 'silent',
    build: {
      minify: true,
      write: false,
      rollupOptions: {
        input: WORKLIST_MOTION_ENTRY,
        // Vite's app build discards an entry's unused exports. Preserve the
        // bundle so the module list describes what LazyMotion will consume.
        preserveEntrySignatures: 'strict',
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
    if (!('output' in item)) throw new Error('Worklist Motion build unexpectedly started a watcher')
    return item.output
  })
  const entryChunk = outputs.find(
    (item) => item.type === 'chunk' && WORKLIST_MOTION_ENTRY in item.modules,
  )
  if (!entryChunk || entryChunk.type !== 'chunk')
    throw new Error('Worklist Motion chunk was not emitted')

  const modules = Object.keys(entryChunk.modules)
  return {
    bytes: Buffer.byteLength(entryChunk.code),
    modules,
    forbidden: modules.filter((moduleId) => FORBIDDEN_MOTION_IMPLEMENTATION.test(moduleId)),
  }
}

describe('eager shell Motion boundary', () => {
  const graph = eagerShellGraph()

  it('keeps the full React entry behind the one LazyMotion boundary', () => {
    expect([...(graph.packageImports.get('motion/react') ?? [])].sort()).toEqual([
      'features/worklist/worklist-motion.tsx',
    ])
    expect([...(graph.packageImports.get('motion/react-m') ?? [])].sort()).toEqual([
      'features/worklist/SidebarUnified.tsx',
      'features/worklist/WorkRowShell.tsx',
      'features/worklist/work-folds.tsx',
    ])
    expect([...graph.files].map((file) => relative(SRC, file))).not.toContain(
      'features/worklist/worklist-motion-features.ts',
    )

    const boundary = readFileSync(resolve(SRC, 'features/worklist/worklist-motion.tsx'), 'utf8')
    expect(boundary).toContain("import('./worklist-motion-features')")
    expect(boundary).toMatch(/<LazyMotion\s+features=\{loadWorklistMotionFeatures\}\s+strict>/)
  })

  it('emits animation and layout without drag or gesture implementations', async () => {
    expect(Object.keys(worklistMotionFeatures).sort()).toEqual(['animation', 'layout', 'renderer'])
    const emitted = await emittedWorklistMotionGraph()
    console.info(
      `worklist Motion boundary: ${emitted.bytes} bytes, ${emitted.modules.length} modules, ${emitted.forbidden.length} forbidden`,
    )
    expect(emitted.forbidden.map((moduleId) => relative(WEB_ROOT, moduleId))).toEqual([])
  })
})
