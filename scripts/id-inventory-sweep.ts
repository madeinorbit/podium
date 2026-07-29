#!/usr/bin/env bun
/**
 * Entity-id and composite-key sweep (POD-360) — the machine half of
 * docs/rearch-id-inventory.md.
 *
 *     bun run inventory:ids            # summary
 *     bun run inventory:ids --full     # every site, file:line
 *     bun run inventory:ids --json     # machine-readable
 *
 * WHY AN AST WALK AND NOT A GREP
 * ------------------------------
 * A grep over this repository is necessary and provably insufficient. A file
 * containing a literal NUL byte reads as BINARY: `grep -n` suppresses its line
 * hits and the agent-facing wrappers (`ugrep -I`) answer "no match" for code
 * that is plainly there — which is how a file hid from an audit earlier in this
 * epic (POD-758, and `bun run lint:no-nul` exists because of it). The TypeScript
 * parser has no such blind spot: it reads bytes, not lines, so a NUL-bearing
 * file is swept like any other. Every file this walk parses is reported in the
 * summary's file count, so coverage is a number a reviewer can check rather
 * than a claim.
 *
 * The walk finds three things, and DELIBERATELY over-reports: a correlation id
 * (`requestId`) and an entity id (`sessionId`) are indistinguishable by name, so
 * classification is a human judgement recorded in the doc, not something this
 * script pretends to decide.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dirname, '..')

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.worktrees',
  '.claude',
  '.claire',
  'coverage',
  '.next',
  '.turbo',
  'target',
  'src-tauri',
])

/** Name shapes that could denote an entity identity. Over-broad on purpose. */
const ID_NAME = /^(id|.*_id|.*_ids|.*Id|.*Ids|.*IdSet|.*IdList)$/

/** Names that look like ids but are correlation/transport handles, not entity
 *  identities. Reported separately so the doc's category (c) — deliberately
 *  stringly-typed — is derived rather than asserted. */
const CORRELATION = new Set([
  'requestId',
  'request_id',
  'clientId',
  'client_id',
  'transitionId',
  'rebindId',
  'segmentId',
  'predecessorSegmentId',
  'correlationId',
  'traceId',
  'spanId',
])

export type SiteKind =
  /** A zod schema field — the mechanical flip target (`z.string()` → a brand). */
  | 'zod-field'
  /** A TS interface/type member naming an identity. */
  | 'ts-property'
  /** A drizzle column definition. */
  | 'sql-column'
  /** `===`/`!==` on an identity: a branded flip turns a mismatch into a type error. */
  | 'comparison'
  /** A template literal that is USED AS A KEY (map key, index, `*Key` binding). */
  | 'composite-key'
  /** An object-literal field carrying an identity value — a usage site, counted
   *  for volume because it is what POD-362/POD-363 walk through. */
  | 'object-literal-field'

export interface Site {
  file: string
  line: number
  kind: SiteKind
  name: string
  /** The source text of the site, trimmed — enough to classify without opening the file. */
  text: string
  correlation: boolean
}

const walkFiles = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walkFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full)
  }
}

/** C0 controls, DEL, and the Unicode line separators JSON leaves bare. Built from
 *  char codes rather than written as a literal class: a source file that spells
 *  its own NUL out is the bug this guard exists to prevent. */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  'g',
)

const snippet = (source: ts.SourceFile, node: ts.Node): string => {
  // Escape control characters — INCLUDING NUL — before the text leaves this
  // script. A raw NUL in the output would make the report itself binary to the
  // next line-oriented tool that reads it, which is the exact failure this
  // sweep exists to route around (POD-758, POD-296, and engine.ts on this
  // branch). It also renders invisibly, so a NUL-separated key misreads as a
  // space-separated one. Escape first, report second.
  const text = node
    .getText(source)
    .replace(CONTROL_CHARS, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

/** Is this initializer a zod schema expression (`z.string()`, `z.string().min(1)`, …)? */
const isZodExpression = (node: ts.Node): boolean => {
  let current: ts.Node = node
  for (let depth = 0; depth < 40; depth++) {
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
      current = ts.isCallExpression(current) ? current.expression : current.expression
      continue
    }
    return ts.isIdentifier(current) && current.text === 'z'
  }
  return false
}

/** Map/Set methods whose first argument IS a key. */
const KEYED_CALLS = new Set(['get', 'set', 'has', 'delete', 'add'])

/**
 * Is this expression consumed as a lookup key rather than as text? True for a
 * computed member access (`byId[key]`), a Map/Set call, a binding or return
 * whose name ends in `Key`/`key`, and a `*Key(...)` helper argument.
 */
const usedAsKey = (node: ts.Node): boolean => {
  // Unwrap the expression wrappers a key site is routinely written behind:
  // `const key = cond ? `${a}:${b}` : undefined` (session-identity.ts:74) is a
  // key site, and stopping at the direct parent would miss it.
  let current: ts.Node = node
  while (
    current.parent !== undefined &&
    (ts.isConditionalExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      (ts.isBinaryExpression(current.parent) &&
        current.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
  ) {
    current = current.parent
  }
  const parent = current.parent
  if (parent === undefined) return false
  node = current
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true
  if (ts.isComputedPropertyName(parent)) return true
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression
    if (ts.isPropertyAccessExpression(callee) && KEYED_CALLS.has(callee.name.text)) return true
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : ''
    if (/key$/i.test(name)) return true
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    if (/key$/i.test(parent.name.text)) return true
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    if (/key$/i.test(parent.name.text)) return true
  }
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
    // `const fooKey = (…) => `${a}:${b}`` — the function's name carries the intent.
    let current: ts.Node | undefined = parent
    for (let depth = 0; depth < 4 && current !== undefined; depth++) {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
        return /key$/i.test(current.name.text)
      }
      if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
        return /key$/i.test(current.name.text)
      }
      current = current.parent
    }
  }
  return false
}

const sweepFile = (file: string, sites: Site[]): void => {
  // Read as a buffer and decode: a NUL byte survives this path intact, where a
  // line-oriented tool would drop the whole file.
  const text = readFileSync(file).toString('utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = relative(ROOT, file).split(sep).join('/')
  const isSchemaFile = /migrations\/schema\.ts$/.test(rel) || /\/schema\.ts$/.test(rel)

  const record = (node: ts.Node, kind: SiteKind, name: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    sites.push({
      file: rel,
      line: line + 1,
      kind,
      name,
      text: snippet(source, node),
      correlation: CORRELATION.has(name),
    })
  }

  const visit = (node: ts.Node): void => {
    // (1) Declared id fields — zod object properties, interface/type members,
    //     and drizzle column definitions.
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteral(node.name)
          ? node.name.text
          : undefined
      if (name && ID_NAME.test(name)) {
        const kind: SiteKind = isSchemaFile
          ? 'sql-column'
          : isZodExpression(node.initializer)
            ? 'zod-field'
            : 'object-literal-field'
        record(node, kind, name)
      }
    }
    if (ts.isPropertySignature(node) && node.name && ts.isIdentifier(node.name)) {
      if (ID_NAME.test(node.name.text)) record(node, 'ts-property', node.name.text)
    }

    // (2) Identity COMPARISONS. A branded flip turns a mismatched comparison
    //     into a type error, so every one of these is a site the flip visits.
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      for (const side of [node.left, node.right]) {
        const name = ts.isPropertyAccessExpression(side)
          ? side.name.text
          : ts.isIdentifier(side)
            ? side.text
            : undefined
        if (name && ID_NAME.test(name)) {
          record(node, 'comparison', name)
          break
        }
      }
    }

    // (3) AD-HOC COMPOSITE KEYS — a template literal joining two or more values
    //     AND USED AS A KEY. This is the class the epic cares about:
    //     `${machineId}\n${nativeId}` is injective only while neither part
    //     contains the separator, and nothing in the type system says so.
    //
    //     The "used as a key" test is what separates a real key site from a log
    //     line. Without it the walk reports every `console.log` that interpolates
    //     an id — 187 hits, almost all noise — and a noisy inventory is one
    //     nobody reads, which is the same as not having one.
    if (ts.isTemplateExpression(node) && node.templateSpans.length >= 2) {
      const parts = node.templateSpans.map((span) =>
        ts.isIdentifier(span.expression)
          ? span.expression.text
          : ts.isPropertyAccessExpression(span.expression)
            ? span.expression.name.text
            : '',
      )
      // Deliberately NOT gated on an id-ish part name. The brief's canonical
      // example — session-identity.ts's `${resume.kind}:${resume.value}` — names
      // neither part `*Id`, and an inventory that missed the site it was told
      // about would be worthless. "Two values joined by a separator, consumed as
      // a key" is the whole definition; naming is not part of it.
      const separated =
        node.head.text !== '' || node.templateSpans.some((span) => span.literal.text !== '')
      if (separated && usedAsKey(node)) {
        record(node, 'composite-key', parts.filter(Boolean).join('+') || '<expressions>')
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
}

// ---------------------------------------------------------------------------

const files: string[] = []
for (const top of ['apps', 'packages', 'services', 'scripts', 'tooling', 'tests']) {
  try {
    walkFiles(join(ROOT, top), files)
  } catch {
    // A workspace root that does not exist in this checkout is not an error.
  }
}
files.sort()

const sites: Site[] = []
for (const file of files) sweepFile(file, sites)

const args = new Set(process.argv.slice(2))

if (args.has('--json')) {
  console.log(JSON.stringify({ filesParsed: files.length, sites }, null, 2))
} else if (args.has('--full')) {
  for (const site of sites) {
    console.log(
      `${site.file}:${site.line}\t${site.kind}\t${site.name}${site.correlation ? '\t(correlation)' : ''}\t${site.text}`,
    )
  }
} else {
  const byKind = new Map<SiteKind, number>()
  for (const site of sites) byKind.set(site.kind, (byKind.get(site.kind) ?? 0) + 1)
  const byPackage = new Map<string, number>()
  for (const site of sites) {
    const key = site.file.split('/').slice(0, 2).join('/')
    byPackage.set(key, (byPackage.get(key) ?? 0) + 1)
  }
  console.log(`files parsed: ${files.length}`)
  console.log(`sites: ${sites.length}`)
  console.log('\nby kind:')
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(14)} ${count}`)
  }
  console.log('\nby package (top 20):')
  for (const [pkg, count] of [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${pkg.padEnd(34)} ${count}`)
  }
  const composite = sites.filter((s) => s.kind === 'composite-key')
  console.log(`\ncomposite-key sites (${composite.length}):`)
  for (const site of composite) console.log(`  ${site.file}:${site.line}  ${site.text}`)
}
