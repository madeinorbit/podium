/**
 * Guard: no TypeScript source under apps/, packages/, or scripts/ may contain
 * a raw NUL byte (0x00). [POD-758]
 *
 * Why: one literal NUL makes tools classify the module as BINARY. Real
 * `/usr/bin/grep` is loud (`-c` still counts; `-n` prints "binary file
 * matches"), but two hazards remain: (1) line-extracting greps (`-n` / `rg -n`)
 * suppress matching LINES, so any tool that parses `file:line:` output gets
 * zero hits even though the match exists; (2) some agent shell wrappers
 * (Claude Code's ugrep with `-I`) return exit 1 with no output entirely —
 * "no match" for code that is sitting right there. Runtime NULs (e.g.
 * composite map-key separators) are fine; write them as an escape (`\u0000`),
 * never as a literal source byte.
 *
 * Run: `bun run lint:no-nul` (own blocking CI job in .github/workflows/ci.yml —
 * never folded into the continue-on-error lint bundle).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOTS = ['apps', 'packages', 'scripts'] as const
const EXT = new Set(['.ts', '.tsx'])
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', 'coverage', 'out'])

export function isSourcePath(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return EXT.has(name.slice(dot))
}

/** Walk roots; return relative paths of .ts/.tsx files that contain a 0x00 byte. */
export function findNulSources(repoRoot: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIR.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile() || !isSourcePath(name)) continue
      let buf: Buffer
      try {
        buf = readFileSync(full)
      } catch {
        continue
      }
      if (buf.includes(0)) {
        hits.push(relative(repoRoot, full).split(sep).join('/'))
      }
    }
  }
  for (const root of ROOTS) {
    const abs = join(repoRoot, root)
    if (existsSync(abs)) walk(abs)
  }
  return hits.sort()
}

export function formatNulReport(hits: readonly string[]): string {
  if (hits.length === 0) return 'ok: no raw NUL bytes in TypeScript sources'
  const lines = [
    `ERROR: ${hits.length} TypeScript source file(s) contain a raw NUL byte (0x00).`,
    'A literal NUL makes the file binary: grep -n / rg -n suppress line hits,',
    'and agent wrappers (ugrep -I) can answer "no match" for code that is there.',
    'Write runtime NUL separators as an escape: \\u0000 — never a literal byte.',
    '',
    ...hits.map((h) => `  BINARY: ${h}`),
  ]
  return lines.join('\n')
}

function main(): number {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const hits = findNulSources(repoRoot)
  const report = formatNulReport(hits)
  if (hits.length > 0) {
    console.error(report)
    return 1
  }
  console.log(report)
  return 0
}

if (import.meta.main) {
  process.exit(main())
}
