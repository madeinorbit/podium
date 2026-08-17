import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(import.meta.dirname, '../..')

function productionTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionTsxFiles(path)
    if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) return []
    if (entry.name === 'MotionDemo.tsx') return []
    return [path]
  })
}

/**
 * Comments blanked, line numbers kept.
 *
 * The scan below is textual, so prose about the contract used to be read as the
 * contract: a JSDoc sentence naming a `<button>` was reported as an unattributed
 * one, and a comment explaining why its neighbour is exempt made the scan pass
 * for the wrong reason. Only `/*` blocks and whole-line `//` are removed — a
 * trailing `//` is left alone so a `https://` inside an attribute cannot swallow
 * the rest of a real line.
 */
function withoutComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ')
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/[^\n]*/gm, blank)
}

describe('production interaction contract', () => {
  it('requires every native user-visible button to opt into pressable states', () => {
    const missing: string[] = []
    for (const path of productionTsxFiles(sourceRoot)) {
      const source = withoutComments(readFileSync(path, 'utf8'))
      for (const tag of source.matchAll(/<button\b[^>]*>/g)) {
        if (!tag[0].includes('data-pressable') && !tag[0].includes('data-pressable-exempt')) {
          const line = source.slice(0, tag.index).split('\n').length
          missing.push(`${relative(sourceRoot, path)}:${line}`)
        }
      }
    }
    expect(
      missing,
      `native buttons missing a pressable contract or explicit exemption:\n${missing.join('\n')}`,
    ).toEqual([])
  })
})
