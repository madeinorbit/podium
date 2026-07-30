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

describe('production interaction contract', () => {
  it('requires every native user-visible button to opt into pressable states', () => {
    const missing: string[] = []
    for (const path of productionTsxFiles(sourceRoot)) {
      const source = readFileSync(path, 'utf8')
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
