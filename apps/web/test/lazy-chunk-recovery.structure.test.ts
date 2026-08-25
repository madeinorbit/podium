// @vitest-environment node
/**
 * EVERY LAZY SURFACE, NOT THE ONE THAT CRASHED (POD-2762).
 *
 * The incident was Settings, and nothing about it was about Settings: any chunk
 * fetched after first paint can be asked for during the seconds a server is
 * handing over, and until `throughRestarts` existed every one of them took the
 * whole interface down when it was.
 *
 * A fix applied by hand to thirty-odd call sites is not a fix to a class — it is
 * a fix to thirty-odd call sites, and the thirty-first is written next week by
 * somebody who has never read this issue. So the rule is asserted rather than
 * remembered: a `lazy(() => import(...))` that does not go through the wrapper
 * fails here, by name, with the reason.
 *
 * WHY A TEST AND NOT A LINT RULE: the repo's biome pass is not a gate (it
 * reports hundreds of pre-existing findings tree-wide), so a rule added there
 * would be invisible. This runs in the ordinary web unit lane.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: `import()` calls that are not behind
 * `lazy()` — a prefetch, a one-off dynamic import for a side effect. Those do
 * not put a component on screen, so a failure has nowhere to be reported and
 * nothing to recover into; `prefetchAfterFirstPaint` already swallows them on
 * purpose.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(path, found)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    found.push(path)
  }
  return found
}

/**
 * `lazy(` followed, within the same call, by a bare `import(`.
 *
 * Deliberately blunt: it reads the text between `lazy(` and the matching depth-0
 * close, and asks whether `throughRestarts` appears before the `import(`. A
 * regex cannot parse TypeScript, but it does not have to — the shape it is
 * policing is one the codebase writes the same way every time, and anything it
 * cannot understand shows up as a failure to investigate rather than as silence.
 */
function unwrappedLazyImports(source: string): string[] {
  const offenders: string[] = []
  for (let i = source.indexOf('lazy('); i !== -1; i = source.indexOf('lazy(', i + 1)) {
    // Skip `useLazy(`, `RelazY(` and friends: the call must stand alone.
    const before = source[i - 1]
    if (before && /[A-Za-z0-9_$.]/.test(before)) continue
    let depth = 0
    let end = i
    for (let j = i + 'lazy'.length; j < source.length; j += 1) {
      if (source[j] === '(') depth += 1
      else if (source[j] === ')') {
        depth -= 1
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    const body = source.slice(i, end + 1)
    if (!/\bimport\s*\(/.test(body)) continue
    if (body.includes('throughRestarts')) continue
    const line = source.slice(0, i).split('\n').length
    const specifier = /import\s*\(\s*['"]([^'"]+)['"]/.exec(body)?.[1] ?? '?'
    offenders.push(`${line}: lazy(() => import('${specifier}'))`)
  }
  return offenders
}

describe('every lazy route survives a server restart', () => {
  it('routes each lazy import through throughRestarts', () => {
    const bad: string[] = []
    for (const file of sourceFiles(SRC)) {
      for (const offender of unwrappedLazyImports(readFileSync(file, 'utf8'))) {
        bad.push(`${file.slice(SRC.length + 1)}:${offender}`)
      }
    }
    expect(
      bad,
      'These lazy imports go straight to the network, so a server restart underneath one of them ' +
        'takes the interface down (POD-2762). Wrap each in `throughRestarts(() => import(...))` ' +
        'from @/lib/chunk-recovery.',
    ).toEqual([])
  })

  /**
   * PROVE THE GATE CAN FIRE. A structural test that only ever reports an empty
   * list is indistinguishable from one whose matcher stopped matching, and this
   * one is a regex over source text — exactly the kind that rots silently when
   * the shape it looks for is written a new way.
   */
  it('can actually see an unwrapped import', () => {
    expect(unwrappedLazyImports("const A = lazy(() => import('./A'))")).toEqual([
      "1: lazy(() => import('./A'))",
    ])
    expect(
      unwrappedLazyImports("const A = lazy(() =>\n  import('./A').then((m) => ({ default: m.A })),\n)"),
    ).toHaveLength(1)
  })

  it('accepts the wrapped form, and is not fooled by a lookalike identifier', () => {
    expect(
      unwrappedLazyImports("const A = lazy(() => throughRestarts(() => import('./A')))"),
    ).toEqual([])
    expect(unwrappedLazyImports("const A = notLazy(() => import('./A'))")).toEqual([])
    // A `lazy()` with no import inside is not this rule's business.
    expect(unwrappedLazyImports('const A = lazy(loader)')).toEqual([])
  })
})
