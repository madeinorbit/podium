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
  /** A tag joined to an id in one string (`automation:${id}`) — a composite key
   *  with one part hidden in the prefix, and a closed vocabulary living unparsed. */
  | 'tagged-identity'

/**
 * The PER-SITE disposition. This is the column POD-361/362/363 execute from: a
 * reviewer correctly observed that classifying by syntax class in prose is not
 * per-site ownership, because two `id` properties in the same syntax class can
 * have opposite dispositions. Every row carries one of these.
 */
export type Owner =
  /** A — mechanical schema flip: this declaration becomes a branded schema. */
  | 'A-schema-flip'
  /** A-consequence — a usage or comparison the flip's type errors will surface.
   *  No decision needed per site; listed so the volume is honest. */
  | 'A-consequence'
  /** B — adopts a typed composite-key helper. */
  | 'B-helper-adoption'
  /** C — stays a string on purpose: correlation handle, wire/SQL boundary, or a
   *  key over values that are not entity identities. */
  | 'C-stringly-on-purpose'
  /** D — a placeholder identity or hand-restated definition POD-279 DELETES.
   *  Must not be branded: branding freezes it into the type system. */
  | 'D-delete-not-brand'
  /** E — an attribution site that gains an on-behalf-of UserId in POD-1075. */
  | 'E-attribution'

export interface Site {
  file: string
  line: number
  kind: SiteKind
  name: string
  owner: Owner
  /** Why this owner, when the rule is not obvious from kind+name alone. */
  ownerReason: string
  /** The source text of the site, trimmed — enough to classify without opening the file. */
  text: string
  correlation: boolean
}

// ---------------------------------------------------------------------------
// Per-site owner derivation
// ---------------------------------------------------------------------------

/**
 * A React render key (`key={...}`, and the `id`/`ref` of a list item in a .tsx).
 *
 * Entity-bearing, and a key — but NOT owner B. Owner B means "adopts a
 * collision-safe helper", and a render key is scoped to one sibling list, so it
 * has no injectivity requirement to protect: `issue:${issue.id}` keeps working
 * verbatim after the flip, because a brand IS a string. Putting these on
 * POD-361's helper worklist would send it to edit JSX for no behavioural reason.
 */
const isRenderKey = (file: string, field: string): boolean =>
  file.endsWith('.tsx') && (field === 'key' || field === 'id' || field === 'ref')

/** Attribution fields (owner E). Each names WHO acted and gains an on-behalf-of
 *  UserId in POD-1075. Enumerated, not pattern-matched: "is this attribution?"
 *  is a semantic question, and a regex guessing at it would be the kind of
 *  plausible-looking answer that makes an inventory untrustworthy. */
const ATTRIBUTION_FIELDS = new Set([
  'humanQuestionAskedBy',
  'human_question_asked_by',
  'causedBySessionId',
  'actorSessionId',
  'startedBySession',
  'started_by_session',
  'coordinatorSessionId',
  'coordinator_session_id',
  'spawnedBy',
  'spawned_by',
  'claimedBy',
  'claimed_by',
  'ackedBy',
  'acked_by',
  'deliveredTo',
  'delivered_to',
  'nameSource',
  'name_source',
])

/** Placeholder identities and hand-restated definitions POD-279 deletes (owner D).
 *  Matched on the SITE TEXT, because the tell is the literal value, not the field
 *  name — `machineId: '__local__'` is D while `machineId: msg.machineId` is A. */
const DELETE_MARKERS = [
  {
    pattern: '__local__',
    reason:
      "'__local__' placeholder — POD-318 deletes it; branding would freeze it into the type system",
  },
  { pattern: 'LOCAL_PLACEHOLDER', reason: "'__local__' placeholder constant — POD-318" },
  {
    pattern: 'OPERATOR',
    reason: 'single-operator capability — POD-1075 replaces it with a real principal',
  },
] as const

/** Fields whose value is a typed enum-like label rather than an identity at all.
 *  deletion_source is the case a reviewer caught me on: it is `'issue' |
 *  'standalone'`, a deletion-PATH label, so it is neither an entity id nor an
 *  actor. Recorded so the mistake cannot recur silently. */
const NOT_AN_IDENTITY = new Set(['deletionSource', 'deletion_source'])

const ownerFor = (
  file: string,
  kind: SiteKind,
  name: string,
  text: string,
  correlation: boolean,
  isSchemaFile: boolean,
  entityBearing: boolean,
): { owner: Owner; reason: string } => {
  for (const marker of DELETE_MARKERS) {
    // Word-ish match so `OPERATOR` does not catch `OPERATOR_LIKE_THING`.
    if (new RegExp(`\\b${marker.pattern}\\b`).test(text)) {
      return { owner: 'D-delete-not-brand', reason: marker.reason }
    }
  }
  if (NOT_AN_IDENTITY.has(name)) {
    return {
      owner: 'C-stringly-on-purpose',
      reason: 'typed enum-like label, not an identity (deletion PATH, not an actor)',
    }
  }
  if (ATTRIBUTION_FIELDS.has(name)) {
    return {
      owner: 'E-attribution',
      reason: 'names who acted; gains an on-behalf-of UserId in POD-1075',
    }
  }
  if (correlation) {
    return {
      owner: 'C-stringly-on-purpose',
      reason: 'correlation/transport handle, not a durable entity identity',
    }
  }
  switch (kind) {
    case 'composite-key':
      // A key over non-identity values (paths, display strings, cursors) is a real
      // composite key and NOT branded-id work. Owner C, so POD-361's worklist is
      // only the rows it should actually migrate.
      if (!entityBearing) {
        return {
          owner: 'C-stringly-on-purpose',
          reason: 'composite key over non-entity values (paths/display/cursors) — not a branded id',
        }
      }
      return {
        owner: 'B-helper-adoption',
        reason: 'ad-hoc composite key; adopts a typed key helper',
      }
    case 'tagged-identity':
      if (isRenderKey(file, name.split('=')[0] ?? '')) {
        return {
          owner: 'A-consequence',
          reason:
            'React render key — sibling-scoped, no injectivity requirement; a brand is still a string',
        }
      }
      return {
        owner: 'B-helper-adoption',
        reason: 'tag+id in one string; the tag is a closed vocabulary living unparsed',
      }
    case 'zod-field':
      return { owner: 'A-schema-flip', reason: 'zod declaration; becomes a branded schema' }
    case 'ts-property':
      return { owner: 'A-schema-flip', reason: 'type member; gains the brand with its schema' }
    case 'sql-column':
      return {
        owner: 'C-stringly-on-purpose',
        reason:
          'storage boundary — a brand is a TS construct; the column stays TEXT unless POD-361 adopts drizzle $type<>()',
      }
    case 'comparison':
      return { owner: 'A-consequence', reason: 'the flip turns a mismatch here into a type error' }
    case 'object-literal-field':
      return {
        owner: isSchemaFile ? 'C-stringly-on-purpose' : 'A-consequence',
        reason: isSchemaFile
          ? 'storage boundary'
          : 'usage site the flip surfaces via its type errors',
      }
  }
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

/** C0 controls plus DEL. Built from char codes rather than written as a literal
 *  class: a source file that spells its own NUL out is the bug this guard exists
 *  to prevent (it happened once in this very script). */
const CONTROL_CLASS = `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`

/** For `replace` only, hence the `g`. Nothing `.test()`s this instance on purpose:
 *  a `g`-flagged regex carries `lastIndex` across `.test()` calls, so sharing one
 *  would make a detector report control characters present, then absent, then
 *  present as the sweep walked — worse than one that is simply wrong.
 *  {@link KEY_SEPARATOR_CONTROLS} below is the un-flagged one used for testing. */
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CLASS, 'g')

/**
 * Control characters that signal "this is a KEY separator" — the C0 set MINUS
 * the display whitespace (`\n`, `\r`, `\t`).
 *
 * The distinction is load-bearing and I got it wrong first: treating every
 * control char as key-shaped pulled in 176 false positives, almost all of them
 * CLI help text built with `lines.join('\n')`. Newline and tab are how this
 * codebase joins text for HUMANS; NUL and  are how it joins values into a
 * key, because they cannot occur in an id or a path. So a NUL separator is
 * self-evidently a key, while a `\n` separator is only a key when something else
 * (the `usedAsKey` test) says so — which is what catches mirror.ts's
 * `${machineId}\n${nativeId}` without catching a help screen.
 */
const KEY_SEPARATOR_CONTROLS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
)

/** Render control characters visibly, so no output of this script can go binary. */
const escapeControls = (text: string): string =>
  text.replace(CONTROL_CHARS_GLOBAL, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)

const snippet = (source: ts.SourceFile, node: ts.Node): string => {
  // Escape control characters — INCLUDING NUL — before the text leaves this
  // script. A raw NUL in the output would make the report itself binary to the
  // next line-oriented tool that reads it, which is the exact failure this
  // sweep exists to route around (POD-758, POD-296, and engine.ts on this
  // branch). It also renders invisibly, so a NUL-separated key misreads as a
  // space-separated one. Escape first, report second.
  const text = escapeControls(node.getText(source)).replace(/\s+/g, ' ').trim()
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

/**
 * Identity-bearing names that the `*Id` shape does not catch. Small and
 * enumerated on purpose.
 *
 * `resume` covers `ResumeRef` — the `(kind, value)` pair that IS the native
 * conversation identity, keyed as `${resume.kind}:${resume.value}` in
 * session-identity.ts, and the exact site `ids.ts`'s shipped `resumeKey()` helper
 * exists to replace. Neither part is named `*Id`, so a name-shape test alone
 * demotes the canonical owner-B site in the brief to owner C. That is the same
 * trap as gating the detector itself on id-ish names, one level up.
 */
const IDENTITY_PARTS = new Set(['resume', 'nativeId'])

/**
 * Does any identifier or property name inside this expression name an identity?
 *
 * This is the B-vs-C discriminator for keys, and it is the fix for a review
 * finding: a composite key over filesystem paths or display values is a genuine
 * key but is NOT branded-id migration work, so it must land on owner C. Being a
 * key and being entity-bearing are two separate questions and the first
 * revision of this sweep conflated them, putting URLs and paths on POD-361's
 * worklist.
 */
const mentionsIdentity = (node: ts.Node): boolean => {
  let found = false
  const walk = (current: ts.Node): void => {
    if (found) return
    if (
      ts.isIdentifier(current) &&
      (ID_NAME.test(current.text) || IDENTITY_PARTS.has(current.text))
    ) {
      found = true
      return
    }
    if (
      ts.isPropertyAccessExpression(current) &&
      (ID_NAME.test(current.name.text) || IDENTITY_PARTS.has(current.name.text))
    ) {
      found = true
      return
    }
    ts.forEachChild(current, walk)
  }
  walk(node)
  return found
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

/** This script and the fixture sampler report sites inside THEMSELVES (both build
 *  keys and paths from parts), which makes the committed ledger churn every time
 *  either file is edited — a diff that says nothing about the codebase being
 *  inventoried. Excluded for that reason, not because tooling is out of scope:
 *  every other file under scripts/ is swept. */
const SELF_EXCLUDED = new Set([
  'scripts/id-inventory-sweep.ts',
  'packages/protocol/src/__fixtures__/sampler.ts',
])

const sweepFile = (file: string, sites: Site[]): void => {
  // Read as a buffer and decode: a NUL byte survives this path intact, where a
  // line-oriented tool would drop the whole file.
  const text = readFileSync(file).toString('utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = relative(ROOT, file).split(sep).join('/')
  if (SELF_EXCLUDED.has(rel)) return
  const isSchemaFile = /migrations\/schema\.ts$/.test(rel) || /\/schema\.ts$/.test(rel)

  const record = (
    node: ts.Node,
    kind: SiteKind,
    name: string,
    /** For key kinds: does the key carry an entity identity? Decides B vs C. */
    entityBearing = true,
  ): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    const text = snippet(source, node)
    const correlation = CORRELATION.has(name)
    const { owner, reason } = ownerFor(
      rel,
      kind,
      name,
      text,
      correlation,
      isSchemaFile,
      entityBearing,
    )
    sites.push({
      file: rel,
      line: line + 1,
      kind,
      name,
      owner,
      ownerReason: reason,
      text,
      correlation,
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
        // Whether the key is ENTITY-BEARING decides B vs C, not whether it is a
        // key. `${sessionsRoot}${NUL}${procRoot}` is a genuine composite key over
        // filesystem paths — real, but not branded-id migration work.
        // Deep walk, not a top-level part-name check: `${e.artifact?.artifactId ?? ''}`
        // has a BinaryExpression as its span, so a top-level name test sees ''
        // and demotes a real artifact key to owner C.
        record(
          node,
          'composite-key',
          parts.filter(Boolean).join('+') || '<expressions>',
          mentionsIdentity(node),
        )
      }
    }

    // (3b) TAGGED IDENTITY — a single-substitution template with a literal PREFIX
    //      (`automation:${id}`, `session:${id}`). A tag joined to an id is a
    //      composite key with one part hidden in the prefix, and the tag is a
    //      closed vocabulary living unparsed in a string. SessionMeta.spawnedBy is
    //      the load-bearing instance. Gated on being used as a key OR assigned to
    //      a field, so log lines with a prefix do not qualify.
    if (ts.isTemplateExpression(node) && node.templateSpans.length === 1) {
      const tag = node.head.text
      const span = node.templateSpans[0]
      const suffix = span?.literal.text ?? ''
      // A BARE TAG, not any string ending in punctuation. My first version tested
      // only `/[:/|@#]$/`, which made every URL and path a "tagged identity":
      // `http://localhost:${port}` ends in ':', `scripts/systemd/${n}` ends in '/',
      // `updated #${i.seq}` ends in '#'. A tag is one lowercase word — no dots, no
      // slashes, no spaces — so a scheme, a path and a sentence are all excluded
      // by construction rather than by a blocklist.
      const looksTagged = /^[a-z][a-z0-9_-]*[:@#|]$/i.test(tag) && suffix === ''
      // AND the substituted value must be an IDENTITY. This is the discriminator
      // that separates `automation:${automation.id}` from `http://localhost:${port}`
      // — the tag shape alone cannot, and `port`/`seq` are not entity ids.
      const substituted =
        span === undefined
          ? ''
          : ts.isIdentifier(span.expression)
            ? span.expression.text
            : ts.isPropertyAccessExpression(span.expression)
              ? span.expression.name.text
              : ''
      const assignedToField =
        node.parent !== undefined &&
        ts.isPropertyAssignment(node.parent) &&
        ts.isIdentifier(node.parent.name)
      if (looksTagged && ID_NAME.test(substituted) && (usedAsKey(node) || assignedToField)) {
        const field =
          node.parent !== undefined &&
          ts.isPropertyAssignment(node.parent) &&
          ts.isIdentifier(node.parent.name)
            ? node.parent.name.text
            : 'key'
        record(node, 'tagged-identity', `${field}=${tag}`, true)
      }
    }

    // (3c) JOIN-CONSTRUCTED KEYS — `[a, b].join(sep)` and `xs.map(…).join(sep)`.
    //      The gap a reviewer correctly called out: the template-literal detector
    //      cannot see these, and the misses were real entity keys, including two
    //      `*RunKey` helpers inside packages/protocol itself.
    //
    //      Counted when consumed as a key OR when the SEPARATOR ITSELF is
    //      key-shaped. Nobody joins prose with a NUL: a control-character or
    //      double-punctuation delimiter is an unambiguous declaration of intent,
    //      and it catches the sites whose enclosing name gives no hint
    //      (`conversationTieBreaker`).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0]
      const separator = arg !== undefined && ts.isStringLiteral(arg) ? arg.text : undefined
      if (separator !== undefined && separator !== '') {
        const keyShapedSeparator =
          KEY_SEPARATOR_CONTROLS.test(separator) || /^(\\|\\||::|\\|)$/.test(separator)
        if (keyShapedSeparator || usedAsKey(node)) {
          record(
            node,
            'composite-key',
            `join(${escapeControls(separator)})`,
            mentionsIdentity(node),
          )
        }
      }
    }

    // (3d) CONCATENATED KEYS — `a + SEP + b` consumed as a key.
    //
    //      NUMERIC ARITHMETIC IS EXCLUDED. My first version required only "used as
    //      a key plus a quote somewhere in the text", which reported
    //      `argv[argv.indexOf('--join') + 1]` — an array INDEX, not a key. The
    //      quote came from the flag name. So: no numeric literal operand, no
    //      `indexOf`/`lastIndexOf`/`length` arithmetic, and at least one operand
    //      must name an identity.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      usedAsKey(node) &&
      /['"`]/.test(node.getText(source)) &&
      !ts.isNumericLiteral(node.right) &&
      !ts.isNumericLiteral(node.left) &&
      !/\b(indexOf|lastIndexOf|length|charCodeAt|\.size)\b/.test(node.getText(source)) &&
      mentionsIdentity(node)
    ) {
      record(node, 'composite-key', 'concat(+)', true)
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
} else if (args.has('--tsv')) {
  // The committed ledger (docs/rearch-id-inventory.sites.tsv). Declaration-class,
  // composite-key and tagged-identity rows: the ones needing a per-site decision.
  const KEEP = new Set<SiteKind>([
    'zod-field',
    'sql-column',
    'composite-key',
    'tagged-identity',
    'ts-property',
  ])
  console.log(
    '# Generated by `bun run inventory:ids --tsv` (POD-360). One row per site, each with its',
  )
  console.log(
    '# PER-SITE OWNER. Consequence classes (object-literal-field, comparison) are reproducible',
  )
  console.log('# from the script and not snapshotted — the flip enumerates them via type errors.')
  console.log('# Control characters are ESCAPED, so this file never goes binary.')
  console.log('file\tline\tkind\towner\tname\townerReason\ttext')
  for (const site of sites) {
    // D and E rows are decision-bearing BY DEFINITION, whatever their syntax
    // class: a `'__local__'` default in an object literal is a POD-318 to-do and
    // an attribution field is a POD-1075 to-do, and both would be dropped by the
    // declaration-class filter. Filtering them out is how the committed ledger
    // ends up claiming 3 placeholder sites where the prose says 13.
    if (
      !KEEP.has(site.kind) &&
      site.owner !== 'D-delete-not-brand' &&
      site.owner !== 'E-attribution'
    ) {
      continue
    }
    console.log(
      [
        site.file,
        site.line,
        site.kind,
        site.owner,
        site.name,
        site.ownerReason,
        site.text.replace(/\t/g, ' '),
      ].join('\t'),
    )
  }
} else if (args.has('--full')) {
  for (const site of sites) {
    console.log(
      `${site.file}:${site.line}\t${site.kind}\t${site.owner}\t${site.name}\t${site.text}`,
    )
  }
} else {
  const byKind = new Map<SiteKind, number>()
  for (const site of sites) byKind.set(site.kind, (byKind.get(site.kind) ?? 0) + 1)
  const byOwner = new Map<Owner, number>()
  for (const site of sites) byOwner.set(site.owner, (byOwner.get(site.owner) ?? 0) + 1)
  const byPackage = new Map<string, number>()
  for (const site of sites) {
    const key = site.file.split('/').slice(0, 2).join('/')
    byPackage.set(key, (byPackage.get(key) ?? 0) + 1)
  }
  console.log(`files parsed: ${files.length}`)
  console.log(`sites: ${sites.length}`)
  console.log('\nby kind:')
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(22)} ${count}`)
  }
  console.log('\nby PER-SITE owner:')
  for (const [owner, count] of [...byOwner].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${owner.padEnd(22)} ${count}`)
  }
  console.log('\nby package (top 20):')
  for (const [pkg, count] of [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${pkg.padEnd(34)} ${count}`)
  }
  const composite = sites.filter((s) => s.kind === 'composite-key')
  console.log(`\ncomposite-key sites (${composite.length}):`)
  for (const site of composite) console.log(`  ${site.file}:${site.line}  ${site.text}`)
}
