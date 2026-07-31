/**
 * SHADOWING SWEEP — the merge defect neither git nor the typechecker reports.
 *
 * Three ways a merge can go wrong, and only two of them tell you [POD-1246]:
 *
 *   CONFLICT   both sides edited the same lines        → git reports it
 *   BREAKAGE   one side edited lines the other depends on → git silent,
 *                                                          typechecker reports it
 *   SHADOWING  both sides ADDED the same declaration   → git silent,
 *                                                        TYPECHECKER SILENT,
 *                                                        and it runs
 *
 * Shadowing is the only one where a GREEN TREE IS ACTIVELY WRONG. It is also the
 * most likely outcome whenever two branches independently implement the same
 * function against different storage — which is the definition of a catch-up
 * merge between branches that both rebuilt the same subsystem.
 *
 * The case that produced this script: `SyncRepository` ended up with
 * `readFeedIdentity()` declared TWICE — main's reading `sync_feed WHERE id = 1`,
 * integration's reading `feed_identity WHERE singleton = 1`. Neither side edited
 * the other's lines, so git auto-merged them as adjacent additions; tsgo reported
 * nothing; the second definition silently won. A per-package typecheck came back
 * clean on a class that queried the wrong table.
 *
 * WHAT THIS CHECKS, deliberately narrow so it can be believed:
 *   1. duplicate class MEMBER names within one class body
 *   2. duplicate top-level exported declaration names within one module
 *
 * Both are textual and both are cheap. TypeScript legitimately permits neither
 * in the shapes matched here (overload signatures are excluded — see below), so a
 * hit is a defect rather than a style opinion.
 *
 * NOT a general linter: it will not catch a shadow spread across two files, or a
 * duplicate re-export through a barrel. It catches the one shape that actually
 * happened, which is worth more than a broader check nobody runs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['apps', 'packages', 'scripts'] as const
const SKIP = new Set(['node_modules', 'dist', 'build', '.expo', 'coverage', 'target', '__fixtures__'])

export interface ShadowFinding {
  file: string
  kind: 'class-member' | 'module-export'
  name: string
  lines: number[]
}

/** Strip line comments, block comments and string bodies so a name inside prose
 *  or SQL never counts as a declaration. Newlines are preserved so line numbers
 *  stay true — the POD-1246 lesson that a detector must report WHERE. */
export function blankNoise(src: string): string {
  let out = ''
  let i = 0
  const keepNewlines = (s: string) => s.replace(/[^\n]/g, ' ')
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      out += keepNewlines(src.slice(i, stop))
      i = stop
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += keepNewlines(src.slice(i, stop))
      i = stop
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const quote = src[i]
      let j = i + 1
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1
      out += quote + keepNewlines(src.slice(i + 1, j)) + (src[j] ?? '')
      i = j + 1
    } else {
      out += src[i]
      i += 1
    }
  }
  return out
}

/** Duplicate members inside a single class body, tracked by brace depth. */
function classMemberDupes(file: string, clean: string): ShadowFinding[] {
  const lines = clean.split('\n')
  const findings: ShadowFinding[] = []
  let depth = 0
  let classDepth: number | null = null
  let seen = new Map<string, number[]>()

  const flush = () => {
    for (const [name, at] of seen) {
      if (at.length > 1) findings.push({ file, kind: 'class-member', name, lines: at })
    }
    seen = new Map()
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? ''
    if (classDepth === null && /^\s*(export\s+)?(abstract\s+)?class\s+\w+/.test(line)) {
      classDepth = depth
    }
    if (classDepth !== null && depth === classDepth + 1) {
      // A member declaration: `name(` or `name:` / `name =` at one indent inside
      // the class. `readonly`/`private`/`static`/`async`/`get`/`set` may prefix it.
      const m = /^ {2}(?:(?:public|private|protected|readonly|static|abstract|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/.exec(
        line,
      )
      // Overload signatures end in `;` with no body — legal duplicates, skip them.
      if (m && !/\)\s*:?[^{]*;\s*$/.test(line)) {
        const name = m[1] as string
        if (!['constructor', 'if', 'for', 'while', 'switch', 'return', 'catch'].includes(name)) {
          const at = seen.get(name) ?? []
          at.push(n + 1)
          seen.set(name, at)
        }
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (classDepth !== null && depth === classDepth) {
          flush()
          classDepth = null
        }
      }
    }
  }
  flush()
  return findings
}

/** Duplicate top-level exported declarations in one module. */
function moduleExportDupes(file: string, clean: string): ShadowFinding[] {
  const lines = clean.split('\n')
  const seen = new Map<string, number[]>()
  for (let n = 0; n < lines.length; n++) {
    const m = /^export\s+(?:declare\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
      lines[n] ?? '',
    )
    if (!m) continue
    const name = m[1] as string
    const at = seen.get(name) ?? []
    at.push(n + 1)
    seen.set(name, at)
  }
  const findings: ShadowFinding[] = []
  for (const [name, at] of seen) {
    // `export const X` + `export type X` is the idiomatic zod schema+type pair.
    if (at.length > 1) {
      const kinds = new Set(
        at.map((l) => /export\s+(?:declare\s+)?(\w+)/.exec(lines[l - 1] ?? '')?.[1]),
      )
      const zodPair = kinds.size === at.length && kinds.has('type')
      if (!zodPair) findings.push({ file, kind: 'module-export', name, lines: at })
    }
  }
  return findings
}

export function scanSource(file: string, src: string): ShadowFinding[] {
  // A file still carrying conflict markers is not merged yet: both sides' text is
  // present by construction, so every duplicate is expected and reporting them
  // would bury the real hits. Resolve first, then sweep.
  if (/^<<<<<<< |^>>>>>>> /m.test(src)) return []
  const clean = blankNoise(src)
  return [...classMemberDupes(file, clean), ...moduleExportDupes(file, clean)]
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
}

export function main(argv: readonly string[] = []): number {
  const only = argv.filter((a) => !a.startsWith('-'))
  const files: string[] = []
  if (only.length > 0) files.push(...only)
  else for (const root of ROOTS) walk(root, files)

  const findings = files.flatMap((f) => scanSource(f, readFileSync(f, 'utf8')))
  if (findings.length === 0) {
    console.log(`ok: no shadowed declarations in ${files.length} file(s)`)
    return 0
  }
  console.error(`ERROR: ${findings.length} shadowed declaration(s) — a merge kept BOTH definitions.`)
  console.error('The later one wins at runtime. git did not flag it and neither did tsc.\n')
  for (const f of findings) {
    console.error(`  ${f.file}: ${f.kind} '${f.name}' declared at lines ${f.lines.join(', ')}`)
  }
  return 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
