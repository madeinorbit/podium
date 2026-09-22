/**
 * THE COMPOSER NARROWING GUARD (POD-4477, epic POD-4414 §5 rules 2+4).
 *
 * Per-harness composer extraction/injection rules live in
 * `adapters/<harness>/composer.ts` — pure functions over screen content and
 * text. The terminal family's composer-sync mechanism is harness-free: it
 * takes the rules as a handed typed subset
 * ({@link TerminalComposerSections}) and can neither look a harness up by
 * name nor reach into an adapter. The daemon resolves the manifest once (its
 * composition root) and the browser entry bundles the same rules for the
 * harnesses the client build knows (CODE, never served).
 *
 * What each arm pins:
 * - no `adapters/` import in the mechanism (spec §5 rule 4, 3.R D6 — the
 *   terminal family may not import any specific adapter; the value must be
 *   handed through the manifest);
 * - no quoted harness literal in the mechanism (no hand-written
 *   kind→rules table; adding a harness is adding an adapter, never editing
 *   the mechanism);
 * - every adapter composer module is pure (no `node:`/`bun:` import in any
 *   form, and value imports only from inside `adapters/` — the browser
 *   entry bundles these files, and the `manifest-browser-reach` closure
 *   refuses node-shaped code there).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AgentManifest } from '../../manifest.js'
import type { TerminalComposerSections } from './composer-sync.js'

const FAMILY_DIR = dirname(fileURLToPath(import.meta.url))
const HARNESS_SRC = dirname(dirname(dirname(FAMILY_DIR)))
const MECHANISM = join(FAMILY_DIR, 'composer-sync.ts')

/** Adapter composer modules: the only homes for per-harness composer rules. */
const ADAPTER_COMPOSERS = [
  'adapters/claude-code/composer.ts',
  'adapters/codex/composer.ts',
  'adapters/shared/composer.ts',
]

function readSource(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Value (non-type-only) import/export-from specifiers in one source file. */
function valueSpecifiers(source: string): string[] {
  const out: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('import type ') || trimmed.startsWith('export type ')) continue
    const match = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/.exec(trimmed)
    if (match?.[1]) out.push(match[1])
  }
  return out
}

describe('composer-sync mechanism is harness-free (POD-4477)', () => {
  it('imports no specific adapter — rules arrive as a handed typed subset', () => {
    const source = readSource(MECHANISM)
    const adapterImports = valueSpecifiers(source).filter((specifier) =>
      specifier.includes('adapters/'),
    )
    expect(adapterImports, 'mechanism must take sections, not import adapters').toEqual([])
  })

  it('names no harness — no kind→rules table in the mechanism', () => {
    const source = readSource(MECHANISM)
    const hits = BUILTIN_HARNESS_KINDS.filter(
      (kind) => source.includes(`'${kind}'`) || source.includes(`"${kind}"`),
    )
    expect(hits, 'quoted harness literals are a hand-written harness list').toEqual([])
  })

  it('rejects the whole Adapter where the typed subset is expected', () => {
    // Compile-time proof (spec §5 rule 2): a consumer takes
    // TerminalComposerSections, never the manifest. If the subset ever widens
    // to accept the whole Adapter, the directive below goes unused and
    // `tsc` fails the build (TS2578) — "tests still pass" is not the evidence
    // for this claim, the typecheck gate is.
    const takesSections = (sections: TerminalComposerSections): unknown => sections.composer
    const manifest = {} as AgentManifest
    expect(
      takesSections(
        // @ts-expect-error — the whole Adapter is not a valid subset
        manifest,
      ),
    ).toBeUndefined()
  })
})

describe('adapter composer modules are pure (POD-4477)', () => {
  it.each(ADAPTER_COMPOSERS)('%s exists', (rel) => {
    expect(existsSync(join(HARNESS_SRC, ...rel.split('/'))), rel).toBe(true)
  })

  it.each(ADAPTER_COMPOSERS)('%s imports nothing from node:* or bun:*', (rel) => {
    const source = readSource(join(HARNESS_SRC, ...rel.split('/')))
    const hostImports = [...source.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1] ?? '')
      .filter((specifier) => specifier.startsWith('node:') || specifier.startsWith('bun:'))
    expect(hostImports, `${rel} is bundled into the browser entry`).toEqual([])
  })

  it.each(ADAPTER_COMPOSERS)('%s takes values only from inside adapters/', (rel) => {
    const source = readSource(join(HARNESS_SRC, ...rel.split('/')))
    const outside = valueSpecifiers(source).filter((specifier) => {
      if (specifier.startsWith('.')) {
        // Relative value imports must stay inside adapters/ (shared helpers).
        const resolved = join(HARNESS_SRC, ...rel.split('/').slice(0, -1), specifier)
        return !resolved.split(sep).includes('adapters')
      }
      // Bare workspace value imports (a host entry, a driver, the registry)
      // would drag node-shaped code into the browser bundle.
      return specifier.startsWith('@podium/')
    })
    expect(outside, `${rel} values must come from inside adapters/`).toEqual([])
  })
})
