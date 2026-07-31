/**
 * THE NO-SIDE-DOOR GATE (POD-314) — the SOURCE-TEXT half.
 *
 * Run:
 *   bun run audit:derived-families           # the gate — exit 1 on any finding
 *   bun run audit:derived-families --json
 *   bun run audit:derived-families --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM
 * ---------------------------------------------------------------------------
 *
 * POD-314's third acceptance criterion is that "tRPC remains a pure derived
 * transport: no command handler is reachable except through the framework (no
 * side-door imports)". Two things have to be true for that, and they fail in
 * different ways:
 *
 *  1. A family's JOINED TABLE is imported only by that family's own derived arm.
 *     A second importer is a second door — code that can call a handler without
 *     the contract's exposure check, and without the transport that applies it.
 *  2. A family's HANDLERS are not exported for anyone else to call directly. A
 *     handler reachable by name is a handler whose authorization is optional.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE RESOLVES NO MODULES, AND WHY THAT IS NOT THE WEAKER CHOICE
 * ---------------------------------------------------------------------------
 *
 * It reads TEXT. It cannot import `router.ts` — doing so would drag the whole
 * server graph in, which is why the per-family audits are text scanners too — and
 * a text scanner is the only kind that notices an import someone adds next year
 * in a file that is never loaded in a test.
 *
 * It is ALSO not sufficient on its own, and the pairing is the point. An empty
 * router satisfies every absence claim this file makes perfectly (POD-732). So
 * `apps/server/src/modules/derived-family.runtime.test.ts` makes the
 * complementary claim against the RUNNING appRouter object: every declared
 * command is actually SERVED, with the right procedure type. Neither instrument
 * substitutes for the other — one can say "nothing extra is reachable", the other
 * can say "the thing that should be reachable is".
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check below is an ABSENCE claim, which is exactly what a broken parser
 * reports. `probe()` runs each check against a planted fixture CONTAINING the
 * violation it hunts and fails if the check does not find it, and against a clean
 * fixture where it must find nothing. It runs FIRST, always, with or without the
 * flag — so a parser that has stopped matching cannot report a green.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  check: string
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = 'apps/server/src/modules'

/**
 * The joined tables this gate governs — POD-314's eleven families. Each is the
 * `(table symbol, owning module)` pair, and the OWNING MODULE is what makes the
 * check meaningful: the table may be imported inside its own family and nowhere
 * else.
 *
 * WRITTEN OUT rather than discovered by globbing `*_COMMANDS_TRPC`, deliberately.
 * A discovered list cannot tell "this family has no table" from "the glob stopped
 * matching", and a gate that silently governs nothing is the failure this whole
 * run is about. `tablesExist` below checks every entry resolves to a real
 * declaration, so the list cannot rot into names that no longer exist either.
 */
export const GOVERNED: readonly { table: string; module: string }[] = [
  { table: 'APPROVAL_COMMANDS_TRPC', module: 'approvals' },
  { table: 'CONVERSATION_COMMANDS_TRPC', module: 'conversations' },
  { table: 'PERF_COMMANDS_TRPC', module: 'perf' },
  { table: 'MODEL_COMMANDS_TRPC', module: 'models' },
  { table: 'FILE_COMMANDS_TRPC', module: 'files' },
  { table: 'HOST_COMMANDS_TRPC', module: 'hosts' },
  { table: 'ACCOUNT_COMMANDS_TRPC', module: 'accounts' },
  { table: 'CLOUD_COMMANDS_TRPC', module: 'cloud' },
  { table: 'SETUP_COMMANDS_TRPC', module: 'instance' },
  { table: 'AUTH_COMMANDS_TRPC', module: 'instance' },
  { table: 'TELEMETRY_COMMANDS_TRPC', module: 'instance' },
]

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/** Every `.ts` under a root, excluding tests — a test importing a table to
 *  assert something ABOUT it is not a side door, and forbidding that would make
 *  the tables untestable. */
export function sourceFiles(rootRel: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== '__fixtures__') walk(full)
      } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
        out.push(relative(ROOT, full))
      }
    }
  }
  walk(join(ROOT, rootRel))
  return out
}

/** Import specifiers a file names, with the symbols it pulls from each. Regex
 *  rather than a parser because this file may not resolve modules; the shapes
 *  biome produces in this repo are `import { a, b } from '…'` and `import type
 *  { … } from '…'`, multi-line included. */
export function importedSymbols(source: string): { symbols: string[]; from: string }[] {
  const out: { symbols: string[]; from: string }[] = []
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const symbols = (m[1] as string)
      .split(',')
      .map(
        (s) =>
          s
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]
            ?.trim() ?? '',
      )
      .filter(Boolean)
    out.push({ symbols, from: m[2] as string })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1 — a joined table is imported only inside its own family
// ---------------------------------------------------------------------------

export function foreignTableImports(
  files: { file: string; source: string }[],
  governed: readonly { table: string; module: string }[],
): Finding[] {
  const findings: Finding[] = []
  const byTable = new Map(governed.map((g) => [g.table, g.module]))
  for (const { file, source } of files) {
    for (const imp of importedSymbols(source)) {
      for (const symbol of imp.symbols) {
        const owner = byTable.get(symbol)
        if (owner === undefined) continue
        const ownDir = `${MODULES}/${owner}/`
        if (file.startsWith(ownDir)) continue
        findings.push({
          check: 'foreign-table-import',
          where: file,
          detail:
            `imports \`${symbol}\`, which belongs to the \`${owner}\` family. A joined table ` +
            'reached from outside its own derived arm is a SECOND DOOR: it can call a handler ' +
            'without the contract exposure check the transport applies, and without the ' +
            'authorization the contract classifies. Reach the command through its transport.',
        })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the framework builder is the only thing that builds a derived procedure
// ---------------------------------------------------------------------------

/**
 * A family's derived arm must go through `derivedFamilyProcedures` (or the
 * `queryProcedures` wrapper over it). A `trpc.ts` that calls `t.procedure`
 * directly has stepped around the state bundle, the exposure check and the
 * both-directions membership assertion — every property the builder exists to
 * provide — while still looking like a derived family from the router.
 *
 * The eight families that landed BEFORE this builder are exempt by name, because
 * they are not POD-314's to rewrite and three of them carry per-family rules the
 * builder does not model. Named individually rather than by a path pattern: a
 * path-scoped exemption would silently cover a twelfth family added later, which
 * is the blindness POD-1180 is about.
 */
const PRE_EXISTING_ARMS = new Set([
  'sessions',
  'workflows',
  'issues',
  'messages',
  'superagent',
  'fleet',
  'specs',
  'settings',
  'automations',
  'lock',
])

export function handRolledProcedures(files: { file: string; source: string }[]): Finding[] {
  const findings: Finding[] = []
  for (const { file, source } of files) {
    const m = file.match(new RegExp(`^${MODULES}/([^/]+)/trpc\\.ts$`))
    const family = m?.[1]
    if (!family || PRE_EXISTING_ARMS.has(family)) continue
    if (!/\bt\.procedure\b/.test(source)) continue
    findings.push({
      check: 'hand-rolled-procedure',
      where: file,
      detail:
        `the \`${family}\` derived arm calls \`t.procedure\` directly instead of going through ` +
        '`derivedFamilyProcedures`. That steps around the state bundle, the default-closed ' +
        'exposure check and the both-directions membership assertion, while still reading as a ' +
        'derived family at the router.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — the gate cannot lose its subject
// ---------------------------------------------------------------------------

/**
 * Every governed table must actually be DECLARED in its module. Without this the
 * two checks above are vacuous the moment a table is renamed: nothing imports a
 * symbol that no longer exists, so `foreignTableImports` returns [] and the gate
 * reports green about a surface it can no longer see.
 */
export function tablesExist(
  governed: readonly { table: string; module: string }[],
  declared: (module: string) => string,
): Finding[] {
  const findings: Finding[] = []
  for (const { table, module } of governed) {
    if (!new RegExp(`\\bexport const ${table}\\b`).test(declared(module))) {
      findings.push({
        check: 'subject-present',
        where: `${MODULES}/${module}`,
        detail:
          `\`${table}\` is not declared in the \`${module}\` module — this gate has lost its ` +
          'subject. Every check here is an ABSENCE claim, and an absence claim about a table ' +
          'that does not exist is satisfied by anything. Re-point the list or explain the removal.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditDerivedFamilies(
  files: { file: string; source: string }[],
  governed: readonly { table: string; module: string }[],
  declared: (module: string) => string,
): Finding[] {
  const subject = tablesExist(governed, declared)
  // SHORT-CIRCUITS, like the mail audit's: reporting "no side door found" about a
  // table that is not there is the purest form of the failure this run is about.
  if (subject.length > 0) return subject
  return [...foreignTableImports(files, governed), ...handRolledProcedures(files)]
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

const CLEAN_FILES = [
  {
    file: `${MODULES}/approvals/trpc.ts`,
    source:
      "import { derivedFamilyProcedures } from '../derived-family'\n" +
      "import { APPROVAL_COMMANDS_TRPC } from './registry'\n",
  },
  {
    file: `${MODULES}/approvals/registry.ts`,
    source: 'export const APPROVAL_COMMANDS_TRPC = {}\n',
  },
  // A test importing the table is NOT a side door and must not be scanned; this
  // entry is here to prove `sourceFiles` excludes it rather than to be checked.
  { file: 'apps/server/src/other.ts', source: "import { something } from './elsewhere'\n" },
]

const PROBE_GOVERNED = [{ table: 'APPROVAL_COMMANDS_TRPC', module: 'approvals' }]
const PROBE_DECLARED = (): string => 'export const APPROVAL_COMMANDS_TRPC = {}'

function probe(): Finding[] {
  const failures: Finding[] = []
  const at = 'scripts/audit-derived-families.ts'
  const yes = (check: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: at,
        detail: `the ${check} check found nothing in a fixture that contains one — it cannot say YES`,
      })
    }
  }
  const no = (check: string, found: Finding[], why: string): void => {
    if (found.length > 0) {
      failures.push({
        check: 'instrument',
        where: at,
        detail: `the ${check} check fires on ${why} — it cannot say NO: ${found[0]?.detail}`,
      })
    }
  }

  // ---- the import parser, on the shapes biome actually produces -------------
  const parsed = importedSymbols(
    "import { a, b as c } from './x'\nimport type { D } from './y'\nimport {\n  E,\n  F,\n} from './z'\n",
  )
  if (parsed.length !== 3) {
    failures.push({
      check: 'instrument',
      where: at,
      detail: `the import parser found ${parsed.length} import statements in a fixture with 3`,
    })
  }
  if (parsed[0]?.symbols.join(',') !== 'a,b') {
    failures.push({
      check: 'instrument',
      where: at,
      detail: `the parser did not read \`b as c\` as \`b\` — got [${parsed[0]?.symbols.join(', ')}]`,
    })
  }
  if (parsed[2]?.symbols.join(',') !== 'E,F') {
    failures.push({
      check: 'instrument',
      where: at,
      detail: 'the parser did not read a MULTI-LINE import, which is the shape biome produces',
    })
  }

  // ---- each check against a fixture containing what it hunts ---------------
  no('foreign-table-import', foreignTableImports(CLEAN_FILES, PROBE_GOVERNED), 'a clean fixture')
  yes(
    'foreign-table-import',
    foreignTableImports(
      [
        ...CLEAN_FILES,
        {
          file: 'apps/server/src/sneaky.ts',
          source: "import { APPROVAL_COMMANDS_TRPC } from './modules/approvals/registry'\n",
        },
      ],
      PROBE_GOVERNED,
    ),
  )
  // …and the family's OWN arm importing its own table must stay legal, or the
  // check forbids the very thing it is meant to permit.
  no(
    'foreign-table-import',
    foreignTableImports(
      [
        {
          file: `${MODULES}/approvals/trpc.ts`,
          source: "import { APPROVAL_COMMANDS_TRPC } from './registry'\n",
        },
      ],
      PROBE_GOVERNED,
    ),
    'a family importing its OWN table',
  )

  no('hand-rolled-procedure', handRolledProcedures(CLEAN_FILES), 'a clean fixture')
  yes(
    'hand-rolled-procedure',
    handRolledProcedures([
      {
        file: `${MODULES}/approvals/trpc.ts`,
        source: 'export const x = t.procedure.mutation(() => 1)\n',
      },
    ]),
  )
  // …and a PRE-EXISTING arm doing the same is exempt, or the gate fails eight
  // other issues' shipped code.
  no(
    'hand-rolled-procedure',
    handRolledProcedures([
      {
        file: `${MODULES}/sessions/trpc.ts`,
        source: 'export const x = t.procedure.mutation(() => 1)\n',
      },
    ]),
    'a pre-existing family arm',
  )

  no('subject-present', tablesExist(PROBE_GOVERNED, PROBE_DECLARED), 'a declared table')
  yes(
    'subject-present',
    tablesExist(PROBE_GOVERNED, () => 'export const SOMETHING_ELSE = {}'),
  )

  // …and the short-circuit: a missing subject must SUPPRESS the other checks,
  // rather than being reported beside a green they cannot justify.
  const shorted = auditDerivedFamilies(
    [
      ...CLEAN_FILES,
      {
        file: 'apps/server/src/sneaky.ts',
        source: "import { APPROVAL_COMMANDS_TRPC } from './modules/approvals/registry'\n",
      },
    ],
    PROBE_GOVERNED,
    () => 'export const SOMETHING_ELSE = {}',
  )
  if (shorted.some((f) => f.check !== 'subject-present')) {
    failures.push({
      check: 'instrument',
      where: at,
      detail:
        'a missing subject did not short-circuit — the gate reported a side-door finding beside ' +
        'a subject it could not read, which is a green it cannot justify',
    })
  }
  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Derived-family gate: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('derived-family gate: the parser and all 3 checks found their planted fixtures')
    return
  }

  const files = sourceFiles('apps/server/src').map((file) => ({ file, source: read(file) }))
  const findings = auditDerivedFamilies(files, GOVERNED, (module) => {
    const dir = join(ROOT, MODULES, module)
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
  })

  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Derived-family gate: ${findings.length} finding(s). POD-314's claims are:\n` +
        '  · a joined table is imported ONLY inside its own family — no second door\n' +
        '  · a derived arm is built by the framework, never by a hand-rolled t.procedure\n' +
        '  · every governed table still EXISTS, so the absence claims have a subject\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    `derived-family gate OK — ${GOVERNED.length} joined tables, each reachable only through its ` +
      'own derived arm, every arm built by the framework',
  )
}

if (import.meta.main) main()
