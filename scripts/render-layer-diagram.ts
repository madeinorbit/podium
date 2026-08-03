/**
 * THE LAYER DIAGRAM, generated from the manifest the lint reads (POD-335).
 *
 * ARCHITECTURE.md's "Dependency direction" block used to be hand-maintained
 * prose beside a lint that enforced something else. That is the two-sources
 * problem in its purest form: the diagram cannot fail, so it drifts, and it
 * drifts in the direction of what someone believed rather than what is checked —
 * the copy on this branch still described `@podium/protocol` as a leaf, which
 * POD-300 stopped being true, and listed `@podium/model` as importing nothing
 * "no @podium/protocol dep either" in a line whose spacing had rotted too.
 *
 * So the block is RENDERED from {@link MANIFEST}, {@link SAME_LAYER_ALLOWED} and
 * {@link SAME_LAYER_TYPE_ONLY_ALLOWED} — the same three constants
 * `checkManifestEdge` decides with. One source, and the diagram is now a
 * projection of it rather than a second opinion about it.
 *
 *   bun scripts/render-layer-diagram.ts            rewrite the block in place
 *   bun scripts/render-layer-diagram.ts --check    fail if it is stale (CI)
 *
 * The `--check` mode is what makes this a single source rather than a helpful
 * script: without it, a hand edit to ARCHITECTURE.md is simply lost at the next
 * render and nobody is told.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Layer,
  MANIFEST,
  SAME_LAYER_ALLOWED,
  SAME_LAYER_TYPE_ONLY_ALLOWED,
  type WorkspaceTags,
} from './architecture-manifest'

export const BEGIN = '<!-- BEGIN GENERATED: layer diagram (scripts/render-layer-diagram.ts) -->'
export const END = '<!-- END GENERATED: layer diagram -->'

/** Wide enough for the longest workspace name plus a space — computed rather
 *  than guessed, because `@podium/terminal-client-react` overran a hardcoded 24
 *  and printed its platform tag flush against its own name. */
const NAME_COLUMN = 30

const LAYER_TITLE: Record<Layer, string> = {
  0: 'L0 — model',
  1: 'L1 — wire / commands / contracts',
  2: 'L2 — kernels / ports',
  3: 'L3 — features / adapters',
  4: 'L4 — app composition roots',
  5: 'L5 — build / compose tier',
}

/** `packages/foo` → `@podium/foo`, the name people actually type. */
const pkg = (workspace: string): string =>
  workspace === 'scripts' ? 'scripts/' : `@podium/${workspace.slice(workspace.indexOf('/') + 1)}`

function describeDeps(tags: WorkspaceTags): string {
  if (tags.deps === undefined) return 'anything below its layer'
  if (tags.deps.length === 0) return 'nothing — this is the leaf'
  return [...tags.deps].sort().map(pkg).join(', ')
}

export function renderLayerDiagram(
  manifest: Readonly<Record<string, WorkspaceTags>> = MANIFEST,
  sameLayer: ReadonlySet<string> = SAME_LAYER_ALLOWED,
  typeOnly: ReadonlySet<string> = SAME_LAYER_TYPE_ONLY_ALLOWED,
): string {
  const byLayer = new Map<Layer, string[]>()
  for (const [workspace, tags] of Object.entries(manifest)) {
    byLayer.set(tags.layer, [...(byLayer.get(tags.layer) ?? []), workspace])
  }

  const lines: string[] = [
    'Imports point DOWN the layer order. A same-layer edge is not implicit — it must be',
    'declared. An upward edge is a violation, and so is a dependency outside a workspace’s',
    'declared closed set.',
    '',
    '```',
  ]
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    lines.push(LAYER_TITLE[layer])
    for (const workspace of (byLayer.get(layer) ?? []).sort()) {
      const tags = manifest[workspace] as WorkspaceTags
      const name = pkg(workspace).padEnd(NAME_COLUMN)
      const marks: string[] = [tags.platform]
      if (tags.roleTiered === true) marks.push('role-tiered')
      if (tags.consumers !== undefined) {
        marks.push(
          `host capability — importable only by ${[...tags.consumers].sort().map(pkg).join(', ')}`,
        )
      }
      lines.push(`  ${name}${marks.join(', ')}`)
      lines.push(`  ${' '.repeat(NAME_COLUMN)}deps: ${describeDeps(tags)}`)
    }
    lines.push('')
  }
  lines.push('```')
  lines.push('')
  lines.push('**Declared same-layer edges** — the only legal sideways imports:')
  lines.push('')
  for (const edge of [...sameLayer].sort()) {
    const [from = '', to = ''] = edge.split(' -> ')
    lines.push(`- \`${pkg(from)} → ${pkg(to)}\``)
  }
  lines.push('')
  lines.push('**Declared type-only same-layer edges** — erased at build, so no runtime edge:')
  lines.push('')
  for (const edge of [...typeOnly].sort()) {
    const [from = '', to = ''] = edge.split(' -> ')
    lines.push(
      `- \`${pkg(from)} ⇢ ${pkg(to)}\` (\`import type\` only; a runtime import is refused)`,
    )
  }
  lines.push('')
  lines.push(
    '_Generated from `scripts/architecture-manifest.ts` — the same manifest `bun run lint:architecture` reads. Edit the manifest, then run `bun run docs:layers`._',
  )
  return lines.join('\n')
}

/** Splice the rendered block between the markers. Throws when they are absent —
 *  a silently-appended block would be a second diagram, which is the problem. */
export function spliceDiagram(doc: string, rendered: string): string {
  const a = doc.indexOf(BEGIN)
  const b = doc.indexOf(END)
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`ARCHITECTURE.md is missing the generated-block markers (${BEGIN} … ${END})`)
  }
  return `${doc.slice(0, a + BEGIN.length)}\n\n${rendered}\n\n${doc.slice(b)}`
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const path = join(repoRoot, 'ARCHITECTURE.md')
  const doc = readFileSync(path, 'utf8')
  const next = spliceDiagram(doc, renderLayerDiagram())
  if (process.argv.includes('--check')) {
    if (next !== doc) {
      console.error(
        'ARCHITECTURE.md layer diagram is STALE — it is generated from scripts/architecture-manifest.ts.\nRun: bun run docs:layers',
      )
      process.exit(1)
    }
    console.log('ARCHITECTURE.md layer diagram is up to date')
    return
  }
  writeFileSync(path, next)
  console.log('ARCHITECTURE.md layer diagram rendered')
}

if (import.meta.main) main()
