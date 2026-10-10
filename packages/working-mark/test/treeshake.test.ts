// @vitest-environment node
// What an app ships: build a tiny app that imports one design with Vite (the web app's bundler) and look at the output.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { allDesigns } from '../src/all'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'working-mark-shake-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The minifier may write non-ASCII letters as \\xF6 escapes (Möbius). */
const has = (code: string, text: string): boolean =>
  code.includes(text) ||
  code.includes(
    text.replace(
      /[^ -~]/g,
      (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    ),
  )

async function bundle(name: string, source: string): Promise<string> {
  const entry = join(dir, `${name}.ts`)
  writeFileSync(entry, source.replaceAll('@src', SRC))
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    build: { minify: true, write: false, rollupOptions: { input: entry } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    'output' in r ? r.output : [],
  )
  return outputs.map((o) => (o.type === 'chunk' ? o.code : '')).join('\n')
}

describe('tree shaking', () => {
  it('an app that imports one design ships only that design', async () => {
    const code = await bundle(
      'one',
      `import { tetra } from '@src/designs'
       import { createWorkingMark } from '@src/mark'
       document.body.append(createWorkingMark(tetra, { size: 12 }).element)`,
    )
    expect(has(code, 'Tumbling tetrahedron')).toBe(true)
    const others = allDesigns.filter((d) => d.id !== 'tetra').filter((d) => has(code, d.name))
    expect(others.map((d) => d.name)).toEqual([])
  }, 60_000)

  it('the full list ships every design', async () => {
    const code = await bundle(
      'all',
      `import { allDesigns } from '@src/all'\nconsole.log(allDesigns)`,
    )
    expect(allDesigns.filter((d) => !has(code, d.name)).map((d) => d.name)).toEqual([])
  }, 60_000)
})
