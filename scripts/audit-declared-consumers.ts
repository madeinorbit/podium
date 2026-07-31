#!/usr/bin/env bun
/**
 * THE RATCHET FOR DECLARATIONS WITH NO CONSUMER (POD-1224).
 *
 * `declared-consumers.ts` answers "does any code read this field?". This turns
 * that answer into a gate: a baseline count of unread declarations that may go
 * DOWN and never up. A new policy field that nothing reads fails CI on the
 * commit that adds it, which is the only moment the argument is cheap — after
 * that it is a field in every handoff report that looks like a control.
 *
 * WHY A RATCHET AND NOT A ZERO. Some unread declarations are legitimate for a
 * window: a column declared for a consumer that a named, scheduled issue will
 * ship. Demanding zero today would force those to be deleted and re-added, and
 * the ledger's whole complaint about this class is that nobody ever has the
 * conversation. So the baseline is the conversation: every entry is listed by
 * name in `declared-consumers-baseline.json`, and the count can only fall.
 *
 * WHY IT IS NOT FOLDED INTO `audit:rearch`. That ratchet counts SITES of things
 * being deleted, from a text grep, in about a second. This one builds a
 * TypeScript program over ~5,300 files and takes about a minute. Bolting a
 * minute onto the fastest blocking job to reuse a JSON file would be a poor
 * trade; it is its own CI step for the same reason `lint:architecture` is.
 *
 * Usage:
 *   bun scripts/audit-declared-consumers.ts            # gate (CI)
 *   bun scripts/audit-declared-consumers.ts --report   # full table, for a sweep
 *   bun scripts/audit-declared-consumers.ts --update-baseline
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyse,
  assertInstrumentHealthy,
  createRepoProgram,
  type DeclaredField,
  findRepoRoot,
} from './declared-consumers'

/**
 * The declaring modules this rewrite added, in the ledger's own terms:
 * "matrix columns, contract policy fields, exclusion lists, deferrals".
 *
 * `contract.ts` is ADR 3 D1's command contract; `framework.ts` is the earlier
 * `CommandDef` facet set POD-380 added and POD-311 is chartered to fold in;
 * `ownership.ts` declares `MatrixRow`, ADR 1 D4's ownership matrix columns.
 */
const DECLARING_FILES = [
  'packages/commands/src/contract.ts',
  'packages/commands/src/framework.ts',
  'packages/model/src/annotations/ownership.ts',
] as const

const BASELINE = 'scripts/declared-consumers-baseline.json'

interface Baseline {
  readonly $note: string
  /** Field key → why it is still unread. The value is the ARGUMENT, not a count. */
  readonly unread: Record<string, string>
}

/**
 * Structural plumbing rather than a policy declaration.
 *
 * `input`, `__out` and the reducer's own parameter bag are not annotations
 * anybody could enforce or forget to enforce — they are the contract's
 * machinery, consumed by inference rather than by a reader. Counting them would
 * put 20-odd permanent entries in the baseline and bury the fields that matter.
 */
const NOT_AN_ANNOTATION =
  /\(anonymous\)|\.__out$|\.__brand$|\.input$|\bOptimisticEffect\.|\bOptimisticReducer\.|\bCommandName\.|\bContractInput\./

const isAnnotation = (f: DeclaredField): boolean => !NOT_AN_ANNOTATION.test(f.key)

export const unreadFields = (fields: readonly DeclaredField[]): DeclaredField[] =>
  fields.filter((f) => isAnnotation(f) && f.productReads.length === 0)

function main(): void {
  const argv = process.argv.slice(2)
  const root = findRepoRoot()
  const program = createRepoProgram(root)
  const fields = analyse(program, root, DECLARING_FILES)

  // The instrument proves itself before it is allowed to report a zero.
  assertInstrumentHealthy(program, root, fields)

  const unread = unreadFields(fields)

  if (argv.includes('--report')) {
    for (const f of fields.filter(isAnnotation)) {
      const verdict = f.productReads.length > 0 ? 'CONSUMED' : '  UNREAD'
      const where = f.productReads
        .slice(0, 3)
        .map((s) => `${s.file}:${s.line}`)
        .join(' ')
      console.log(
        `${verdict}  ${f.key.padEnd(52)} prod=${String(f.productReads.length).padStart(2)} ` +
          `self=${String(f.lintSelfReads.length).padStart(2)} test=${String(f.testReads.length).padStart(2)} ` +
          `shadow=${String(f.shadowedReads.length).padStart(3)}  ${where}`,
      )
    }
    return
  }

  if (argv.includes('--update-baseline')) {
    const previous: Baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'))
    const next: Baseline = {
      $note: previous.$note,
      unread: Object.fromEntries(
        unread.map((f) => [
          f.key,
          previous.unread[f.key] ??
            'UNARGUED — state ship-the-consumer, delete, or the named retirement issue.',
        ]),
      ),
    }
    writeFileSync(join(root, BASELINE), `${JSON.stringify(next, null, 2)}\n`)
    console.log(`declared-consumers: baseline updated — ${unread.length} unread declaration(s).`)
    return
  }

  const baseline: Baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'))
  const known = new Set(Object.keys(baseline.unread))
  const added = unread.filter((f) => !known.has(f.key))
  const fixed = [...known].filter((k) => !unread.some((f) => f.key === k))

  if (added.length > 0) {
    console.error(
      `Declared-consumer audit: ${added.length} NEW declaration(s) that no product code reads.\n\n` +
        'A declaration with no consumer is indistinguishable from an enforced one: it appears in\n' +
        'every report as a control, and no test can tell it apart from a field that is enforced,\n' +
        'because the only difference is in code that does not exist.\n\n' +
        'For each, do ONE of:\n' +
        '  (a) ship the consumer — the field claims a behaviour, so make something read it;\n' +
        '  (b) delete the declaration — the behaviour is not wanted, so stop advertising it;\n' +
        '  (c) record it in ' +
        BASELINE +
        ' with a NAMED issue and a deletion condition.\n',
    )
    for (const f of added) {
      const hint =
        f.shadowedReads.length > 0
          ? ` (${f.shadowedReads.length} same-named read(s) elsewhere — check for a cast, e.g. ${f.shadowedReads[0]?.file}:${f.shadowedReads[0]?.line})`
          : ''
      console.error(`  · ${f.key}  declared in ${f.declaredIn}${hint}`)
    }
    process.exit(1)
  }

  if (fixed.length > 0) {
    console.error(
      `Declared-consumer audit: ${fixed.length} baseline entr(y/ies) now HAVE a consumer.\n` +
        'The ratchet only tightens — remove them from ' +
        BASELINE +
        ':\n',
    )
    for (const k of fixed) console.error(`  · ${k}`)
    process.exit(1)
  }

  console.log(
    `declared-consumers: ${unread.length} unread declaration(s), all argued in ${BASELINE}; no new ones.`,
  )
}

main()
