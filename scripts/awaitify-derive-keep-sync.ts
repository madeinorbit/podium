/**
 * POD-3371 — derive the await pass's refusal set, and write it down with reasons.
 *
 * `awaitify.ts --pass=awaits` makes a function `async` wherever it inserted an
 * `await`. Some of those functions CANNOT become async: something reads what
 * they return synchronously, and a promise arriving there either fails to
 * typecheck or, worse, sails through a slot typed `unknown` and lands in front
 * of an assertion. Syntax can only guess which ones. The compiler knows.
 *
 * So: apply the pass, typecheck, map each error back to the function whose
 * `async` caused it, add that function to the keep-sync set, revert, and go
 * again. It converges when tsgo is clean, and the set is then a DERIVED FACT
 * rather than a hand-built list.
 *
 * POD-3262 ran exactly this loop and threw the answer away — the commit recorded
 * "305 sites in 45 files" and not one of the 305. Two reviewers have since re-run
 * the pass without the set, seen the refusals as missing work, and filed it as a
 * defect. This script exists so the set is re-derivable, and it writes
 * `scripts/awaitify-keep-sync.txt`, which is the set itself.
 *
 * It MUTATES the working tree while it runs (apply, typecheck, revert) and
 * refuses to start unless `apps/` is clean. Run it deliberately:
 *
 *   bun scripts/awaitify-derive-keep-sync.ts
 *   bun scripts/awaitify-derive-keep-sync.ts --out /tmp/candidate.txt
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readKeepSync, run } from './awaitify'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP_SYNC = join(ROOT, 'scripts/awaitify-keep-sync.txt')
const SPANS = join(ROOT, 'node_modules/.cache/awaitify-spans.json')
const MAX_ROUNDS = 12

/** The tree the pass edits. Reverted between rounds; must be clean to begin. */
const DIRTIED = ['apps']

interface Span {
  file: string
  key: string
  start: number
  end: number
}

interface TsError {
  file: string
  line: number
  col: number
  code: string
  message: string
}

/**
 * What a keep-sync entry MEANS, so the flip has something to act on.
 *
 * Every entry is a function the compiler refused to let go async, but they do not
 * all refuse for the same reason, and "why was this skipped" is the question each
 * one becomes when someone has to decide what to do with it. The category comes
 * from the error tsgo actually reported — derived alongside the coordinate, not
 * asserted about it afterwards.
 */
function categorize(e: TsError): string {
  // A TS1xxx is a PARSE error: the pass emitted text that is not TypeScript.
  // Nothing about the caller refused anything — the codemod is wrong here, and
  // the entry is masking it. See POD-3382.
  if (/^TS1\d{3}$/.test(e.code)) return 'pass-emits-invalid-syntax'
  // The caller declared the resolved shape and got a Promise of it, so every
  // member it reads is suddenly missing.
  if (/is missing the following propert/.test(e.message)) return 'promise-reaches-a-member-read'
  if (/Property '.*' does not exist on type 'Promise/.test(e.message)) {
    return 'promise-reaches-a-member-read'
  }
  // The value flows into a slot whose declared type is the resolved one.
  if (/not assignable to (parameter of )?type/.test(e.message)) {
    return 'caller-type-cannot-absorb-a-promise'
  }
  return 'compiler-refused'
}

function sh(cmd: string, args: string[], cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

/** Byte offset of a 1-based line/column in an edited file. */
const lineStarts = new Map<string, number[]>()
function offsetOf(file: string, line: number, col: number): number | undefined {
  let starts = lineStarts.get(file)
  if (starts === undefined) {
    let text: string
    try {
      text = readFileSync(join(ROOT, file), 'utf8')
    } catch {
      return undefined
    }
    starts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
    lineStarts.set(file, starts)
  }
  const base = starts[line - 1]
  return base === undefined ? undefined : base + (col - 1)
}

/**
 * Map an error in the EDITED tree back to the function whose `async` caused it,
 * keyed in the ORIGINAL tree. An error inside no span at all is not this pass's
 * doing and is returned unexplained rather than blamed on the nearest thing.
 */
function blame(
  errors: TsError[],
  spans: Span[],
): { blamed: Map<string, TsError>; unexplained: TsError[] } {
  const byFile = new Map<string, Span[]>()
  for (const s of spans) {
    const list = byFile.get(s.file)
    if (list === undefined) byFile.set(s.file, [s])
    else list.push(s)
  }
  const blamed = new Map<string, TsError>()
  const unexplained: TsError[] = []
  for (const e of errors) {
    const offset = offsetOf(e.file, e.line, e.col)
    const inFile = byFile.get(e.file) ?? []
    if (offset === undefined) {
      unexplained.push(e)
      continue
    }
    let containing = inFile.filter((s) => s.start <= offset && offset <= s.end)
    if (containing.length === 0) {
      // `deps.isEnrolled = async (id) => …` reports at `deps`, just BEFORE the
      // arrow whose `async` caused it. Nearest span ahead on the same statement.
      const ahead = inFile
        .filter((s) => s.start >= offset && s.start - offset < 400)
        .sort((a, b) => a.start - b.start)
      const first = ahead[0]
      if (first !== undefined) containing = [first]
    }
    if (containing.length === 0) {
      // `const f = async () => …` passed later as a shorthand property: the
      // error is at the USE and the cause is the declaration above it. A wrong
      // guess only keeps some function synchronous, which is the safe direction
      // — tsgo still has to come out clean before the loop stops.
      const behind = inFile.filter((s) => s.end <= offset).sort((a, b) => b.end - a.end)
      const nearest = behind[0]
      if (nearest !== undefined) containing = [nearest]
    }
    const innermost = containing.sort((a, b) => a.end - a.start - (b.end - b.start))[0]
    if (innermost === undefined) unexplained.push(e)
    else if (!blamed.has(innermost.key)) blamed.set(innermost.key, e)
  }
  return { blamed, unexplained }
}

function parseErrors(text: string): TsError[] {
  const out: TsError[] = []
  for (const raw of text.split('\n')) {
    const m = raw.match(/^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)
    if (m === null) continue
    const [, where, line, col, code, message] = m
    if (where === undefined || line === undefined || col === undefined || code === undefined)
      continue
    out.push({
      file: where.startsWith('src/') ? `apps/server/${where}` : where,
      line: Number(line),
      col: Number(col),
      code,
      message: message ?? '',
    })
  }
  return out
}

function revert(): void {
  const r = sh('git', ['checkout', '--', ...DIRTIED], ROOT)
  if (r.code !== 0) throw new Error(`revert failed: ${r.out}`)
  lineStarts.clear()
}

function main(): void {
  const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? KEEP_SYNC

  const dirty = sh('git', ['status', '--porcelain', '--', ...DIRTIED], ROOT)
  if (dirty.out.trim().length > 0) {
    console.error('refusing to run: this script reverts the tree between rounds and would')
    console.error(`discard uncommitted work under ${DIRTIED.join(', ')}:\n${dirty.out}`)
    process.exit(2)
  }

  mkdirSync(dirname(SPANS), { recursive: true })

  const head = sh('git', ['rev-parse', 'HEAD'], ROOT).out.trim()
  /** key -> the error that first proved this function cannot be async. */
  const reasons = new Map<string, TsError>()

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    revert()
    const keepSync = new Set(reasons.keys())
    const r = run({
      pass: 'awaits',
      apply: true,
      configPath: join(ROOT, 'apps/server/tsconfig.json'),
      keepSync,
      spansPath: SPANS,
    })
    const tsgo = sh(join(ROOT, 'node_modules/.bin/tsgo'), ['--noEmit'], join(ROOT, 'apps/server'))
    const errors = parseErrors(tsgo.out)
    console.log(
      `round ${round}: awaited=${r.sites} files=${r.edited.length} ` +
        `keep-sync=${keepSync.size} errors=${errors.length}`,
    )
    if (errors.length === 0) {
      revert()
      write(outPath, reasons, head)
      console.log(
        `CONVERGED after ${round} round(s): ${reasons.size} entries -> ${relative(ROOT, outPath)}`,
      )
      return
    }
    const spans: Span[] = JSON.parse(readFileSync(SPANS, 'utf8'))
    const { blamed, unexplained } = blame(errors, spans)
    let added = 0
    for (const [key, err] of blamed) {
      if (reasons.has(key)) continue
      reasons.set(key, err)
      added++
    }
    for (const e of unexplained) {
      console.error(`  UNEXPLAINED ${e.file}(${e.line},${e.col}): ${e.code} ${e.message}`)
    }
    if (added === 0) {
      revert()
      console.error(`STUCK: ${errors.length} errors and nothing new to blame`)
      for (const e of errors.slice(0, 20)) {
        console.error(`  ${e.file}(${e.line},${e.col}): ${e.code} ${e.message}`)
      }
      process.exit(1)
    }
  }
  revert()
  console.error(`did not converge in ${MAX_ROUNDS} rounds`)
  process.exit(1)
}

function write(path: string, reasons: Map<string, TsError>, head: string): void {
  const byFile = new Map<string, { key: string; err: TsError }[]>()
  for (const [key, err] of reasons) {
    const file = key.split('|')[0] ?? key
    const list = byFile.get(file)
    if (list === undefined) byFile.set(file, [{ key, err }])
    else list.push({ key, err })
  }
  const counts = new Map<string, number>()
  for (const err of reasons.values()) {
    const c = categorize(err)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const lines: string[] = [
    '# The await pass refusal set — functions that CANNOT become async.',
    '#',
    '# GENERATED by `bun scripts/awaitify-derive-keep-sync.ts`. Do not hand-edit and',
    '# never resolve a merge conflict here textually: re-derive it. Each entry is a',
    '# function addressed by BYTE OFFSET, so any edit that moves a function makes its',
    '# entry a silent no-op — the pass stops refusing there and proposes the edit',
    '# again. `awaitify.ts` reports such entries as UNUSED and the idempotence check',
    '# fails on them, which is the signal to re-run this script.',
    '#',
    '# Format: <repo-relative file>|<byte offset of the function>  # <category>: <the',
    '# compiler error that proved it>. The category is what the flip has to decide',
    '# about; the error is the evidence. Everything from `#` is commentary.',
    '#',
    `# Derived at ${head}`,
    `# ${reasons.size} functions in ${byFile.size} files`,
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([c, n]) => `#   ${n}  ${c}`),
    '',
  ]
  for (const [file, entries] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`# ${file} (${entries.length})`)
    for (const { key, err } of entries.sort(
      (a, b) => Number(a.key.split('|')[1]) - Number(b.key.split('|')[1]),
    )) {
      const message = err.message.replace(/\s+/g, ' ').slice(0, 160)
      lines.push(`${key}  # ${categorize(err)}: ${err.code} ${message}`)
    }
    lines.push('')
  }
  writeFileSync(path, lines.join('\n'))
  // Read it straight back through the consumer: a file the pass cannot parse is
  // worse than no file, because --keep-sync of an empty set looks like a clean run.
  const parsed = readKeepSync(path)
  if (parsed.size !== reasons.size) {
    throw new Error(`wrote ${reasons.size} entries but the pass reads back ${parsed.size}`)
  }
}

if (import.meta.main) main()
