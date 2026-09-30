/**
 * POD-4577 (Mc5) — pin a harness entry to its pool arm BY MODULE, not by
 * spelling. Grepping source text for the literal `arms/hand/arm` misses a
 * relative import of the same file (`../../../hand/arm` from
 * `arms/hand/pool/native/list.tsx` resolves to it, and the text pin stays
 * green). This helper walks the static import graph from an entry file,
 * resolving every relative specifier against its importer, and returns the
 * reachable files — so the pin fails on the module no matter how it is
 * spelled. Comments are stripped before parsing, so documentation that names
 * the round-two arm can never trip (or satisfy) the pin.
 *
 * Renderer-free (fs only): pin tests that use this never execute arm code.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** A relative specifier resolved against its importer, or null when it cannot be one. */
export function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Resolve the pool's source exports in this checkout, including its public React entry. */
export function resolvePoolImport(fromFile: string, specifier: string): string | null {
  if (specifier !== '@podium/client-graph' && !specifier.startsWith('@podium/client-graph/'))
    return null
  let directory = dirname(fromFile)
  while (directory !== dirname(directory)) {
    const pool = resolve(directory, 'packages/client-graph')
    const manifestPath = join(pool, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      const key =
        specifier === '@podium/client-graph'
          ? '.'
          : `.${specifier.slice('@podium/client-graph'.length)}`
      for (const [pattern, entry] of Object.entries(manifest.exports) as [
        string,
        { '@podium/source': string },
      ][]) {
        const [prefix, suffix] = pattern.split('*')
        if (pattern === key) return resolve(pool, entry['@podium/source'])
        if (suffix !== undefined && key.startsWith(prefix as string) && key.endsWith(suffix)) {
          const middle = key.slice(
            (prefix as string).length,
            suffix.length === 0 ? undefined : -suffix.length,
          )
          return resolve(pool, entry['@podium/source'].replace('*', middle))
        }
      }
      return null
    }
    directory = dirname(directory)
  }
  return null
}

/** Every statically importable specifier in one file's source. */
export function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  const found = new Set<string>()
  for (const pattern of [
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
      const specifier = match[1]
      if (specifier !== undefined) found.add(specifier)
    }
  }
  return [...found]
}

/**
 * The module graph reachable from `entry` (absolute file path) through
 * relative imports, including `entry` itself. Pool workspace exports are resolved locally. Other bare specifiers and
 * unresolvable paths are leaves, never failures: only files on disk are
 * walked, each once.
 */
export function moduleGraphOf(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try {
      source = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const specifier of specifiersOf(source)) {
      const resolved = resolveRelativeImport(file, specifier) ?? resolvePoolImport(file, specifier)
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return [...seen].sort()
}
