/**
 * THE TELEGRAM IDENTITY-BINDING AUDIT (POD-1080, 3.12; ADR 3 Amendment 1 D22).
 *
 * Run:
 *   bun run audit:telegram-binding           # the gate — exit 1 on any finding
 *   bun run audit:telegram-binding --json
 *   bun run audit:telegram-binding --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS, AND WHY A TEST SUITE IS NOT ENOUGH ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * The binding's whole value is a REFUSAL: an inbound chat with no binding gets
 * no principal (D22.2). A refusal is invisible when it stops happening — the
 * bridge keeps working, better than before, for everyone including whoever
 * should not be there. There is no failing feature to notice.
 *
 * The three ways it could stop happening are the three source checks:
 *
 *  1. `no-fallback-identity` — the messaging module names a user constant.
 *     "Fall back to the first admin so nothing breaks" is the exact fail-open
 *     D22.2 forbids by name, and it is the most natural bug-fix in the world for
 *     someone whose bot went quiet after an upgrade.
 *  2. `inbound-gated` — the gate leaves the one entry point every inbound path
 *     passes through, or stops refusing. A gate moved onto ONE arm silently
 *     reopens the other two (slash commands, callback presses).
 *  3. `single-resolution-path` — a second chat-to-user lookup appears. The
 *     danger is not that it would be wrong; it is that it would be CONVENIENT,
 *     could not express the `ambiguous` refusal, and would become the real gate.
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS, AND NEITHER IS SUFFICIENT ALONE
 * ---------------------------------------------------------------------------
 *
 * The three checks above resolve no modules and read source TEXT, so they run in
 * a fresh checkout with nothing built. But POD-732's line stands — "an empty
 * router satisfies every absence claim perfectly" — and a source scan is
 * satisfied by a file nobody imports. So the RUNNING-object half lives in
 * `scripts/audit-telegram-binding.test.ts`, where the workspace resolves —
 * `audit-scoped-feed.ts` splits the same way and for the same mechanical reason
 * (these worktrees have no `@podium` scope in `node_modules`, so a script that
 * imported one would read another checkout or fail outright). It checks:
 *
 *  4. `served` — both ceremony contracts are in the joined table and exposed,
 *     because a contract no dispatcher reads is mechanism without coverage
 *     (POD-385, which shipped three such contracts and closed).
 *  5. `resolver-decides` — the SHIPPED `resolveTelegramPrincipal` is exercised
 *     on a bound chat, an unbound chat and an ambiguous one. A resolver that
 *     was quietly made permissive passes every source check in this file.
 *
 * `--probe` runs each check against a planted fixture containing the thing it
 * hunts and FAILS if the check does not find it. It runs FIRST, always, even
 * without the flag: a green gate whose zero could only mean "the scan broke" is
 * this audit's own worst failure mode.
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
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

const MESSAGING_DIR = 'apps/server/src/modules/messaging'
const SERVICE = `${MESSAGING_DIR}/service.ts`
const MODEL = 'packages/model/src/identity/telegram-binding.ts'
const INSTRUMENT = 'scripts/audit-telegram-binding.ts'

/** Files under a directory, excluding tests — a test may legitimately name a
 *  fallback constant in order to prove it is NOT used. */
function sourceFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.')) continue
      out.set(relative(ROOT, full), readFileSync(full, 'utf8'))
    }
  }
  walk(join(ROOT, dir))
  return out
}

// ---------------------------------------------------------------------------
// 1 — no fallback identity anywhere in the messaging module
// ---------------------------------------------------------------------------

/**
 * The names that would spell "resolve this chat to somebody rather than
 * nobody". `deviceGradeSoleOwner` is on the list even though it is the honest
 * placeholder elsewhere: at the MINT it is a true statement about a transport
 * that cannot name a person, and on the INBOUND path it would be a guess about a
 * message that named no person at all. Same function, opposite meanings, which
 * is why the site matters and not the name.
 */
const FALLBACK_IDENTITIES = ['FIRST_ADMIN_USER_ID', 'SOLE_USER_ID', 'deviceGradeSoleOwner']

export function fallbackIdentities(files: ReadonlyMap<string, string>): Finding[] {
  const findings: Finding[] = []
  for (const [file, source] of files) {
    for (const name of FALLBACK_IDENTITIES) {
      for (const match of source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
        findings.push({
          check: 'no-fallback-identity',
          where: `${file}:${lineOf(source, match.index)}`,
          detail:
            `\`${name}\` appears in the messaging module. ADR 3 Amendment 1 D22.2: an unbound chat ` +
            'yields NO principal and "must NEVER fall back to an operator identity". A default here ' +
            'turns knowledge of the bot handle into an unauthenticated write path against the whole ' +
            'instance — and it fails OPEN, so nothing would look broken.',
        })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the gate is on the shared inbound entry point, and it refuses
// ---------------------------------------------------------------------------

/** Extract a method body by BRACE MATCHING from its signature. A line scan
 *  stops at the first `}` — which for a method full of nested blocks is not the
 *  end, so an absent gate would read as present or vice versa. */
export function methodBody(source: string, signature: string): string | undefined {
  const start = source.indexOf(signature)
  if (start === -1) return undefined
  const open = source.indexOf('{', start)
  if (open === -1) return undefined
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return undefined
}

export function inboundUngated(source: string, file = SERVICE): Finding[] {
  const body = methodBody(source, 'private onInbound(')
  if (body === undefined) {
    // NOT a pass. A vanished entry point is not an entry point with a gate — the
    // check would otherwise report a serene zero for a renamed method.
    return [
      {
        check: 'inbound-gated',
        where: file,
        detail:
          'no `onInbound(` method found. The gate is asserted ON that method because it is the one ' +
          'place plain turns, slash commands and callback presses all pass through; if it was ' +
          'renamed, this check no longer knows where the gate belongs.',
      },
    ]
  }
  const resolves = body.includes('resolveInboundUser(')
  const refuses = /if \(!\w+\) return/.test(body)
  if (resolves && refuses) return []
  return [
    {
      check: 'inbound-gated',
      where: file,
      detail:
        `\`onInbound\` ${resolves ? 'resolves a user but does not REFUSE when there is none' : 'does not resolve a user at all'}. ` +
        'Every inbound path — plain turn, slash command, callback — passes through it, so a gate ' +
        'that moved onto one arm silently reopens the other two (ADR 3 Amendment 1 D22.2).',
    },
  ]
}

// ---------------------------------------------------------------------------
// 3 — one chat-to-user resolution path
// ---------------------------------------------------------------------------

/**
 * Anything outside the model that maps a chat id to a user is a SECOND answer to
 * the question the model answers once — and the second answer cannot express
 * `ambiguous`, because a `find()` returns a row rather than a refusal.
 *
 * Keyed on the two shapes such a lookup takes rather than on a name, since the
 * hazard is somebody writing a convenience helper, and they will not call it
 * `resolveTelegramPrincipalButWorse`.
 */
const SECOND_LOOKUP = [
  // `bindings.find(b => b.chatId === …)` and friends — a row-picking read.
  /\.find\(\s*\(?\w+\)?\s*=>\s*\w+\.chatId\s*===/,
  // A SQL read that selects a user by chat id.
  /SELECT[^;'"`]*user_id[^;'"`]*FROM\s+telegram_chat_bindings[^;'"`]*WHERE[^;'"`]*chat_id/i,
]

export function secondResolutionPath(files: ReadonlyMap<string, string>): Finding[] {
  const findings: Finding[] = []
  for (const [file, source] of files) {
    if (file === MODEL || file === INSTRUMENT || file.includes('.test.')) continue
    for (const pattern of SECOND_LOOKUP) {
      const match = pattern.exec(source)
      if (!match) continue
      findings.push({
        check: 'single-resolution-path',
        where: `${file}:${lineOf(source, match.index)}`,
        detail:
          'a second chat-to-user lookup. `resolveTelegramPrincipal` is the ONE answer to "who is ' +
          'this chat", and it is the only one that can refuse — a `find()` returns a row, so two ' +
          'bindings for one chat elect a winner instead of failing closed. The danger is not that ' +
          'this lookup is wrong; it is that it is convenient, and convenient is what becomes the ' +
          'real gate.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The source arm: resolves no modules, runs in a fresh checkout. */
export function auditSources(): Finding[] {
  const messaging = sourceFiles(MESSAGING_DIR)
  const wholeTree = new Map<string, string>()
  for (const dir of ['apps', 'packages'] as const) {
    for (const [file, source] of sourceFiles(dir)) wholeTree.set(file, source)
  }
  return [
    ...fallbackIdentities(messaging),
    ...inboundUngated(read(SERVICE)),
    ...secondResolutionPath(wholeTree),
  ]
}

// ---------------------------------------------------------------------------
// --probe
// ---------------------------------------------------------------------------

const PROBE_FALLBACK = new Map([
  ['<probe>/service.ts', 'const who = boundUser ?? FIRST_ADMIN_USER_ID\n'],
])
/** The clean fixture must NOT fire: the check must be able to say NO. */
const PROBE_NO_FALLBACK = new Map([['<probe>/service.ts', 'const who = boundUser\n']])

const PROBE_GATED = `
  private onInbound(msg: InboundChatMessage): void {
    const boundUser = this.resolveInboundUser(msg.source)
    if (!boundUser) return
    if (msg.callback) { void this.handleCallback(msg); return }
    void this.handleChatMessage(msg)
  }
`
/** Resolves, and then does nothing with the answer — the shape a refactor
 *  produces, and the one a "does it mention the resolver" check would pass. */
const PROBE_UNREFUSING = PROBE_GATED.replace('    if (!boundUser) return\n', '')
/** The gate deleted outright. */
const PROBE_UNGATED = PROBE_UNREFUSING.replace(
  '    const boundUser = this.resolveInboundUser(msg.source)\n',
  '',
)
/** The method renamed away — an absence the check must not read as a pass. */
const PROBE_RENAMED = PROBE_GATED.replace('private onInbound(', 'private onIncoming(')

const PROBE_SECOND_LOOKUP = new Map([
  ['<probe>/helper.ts', 'const row = bindings.find((b) => b.chatId === chatId)\n'],
])
const PROBE_SECOND_SQL = new Map([
  [
    '<probe>/repo.ts',
    "db.prepare('SELECT user_id FROM telegram_chat_bindings WHERE chat_id = ?')\n",
  ],
])
/** The model's own resolver body, which must NOT fire — it is the one answer. */
const PROBE_ONE_LOOKUP = new Map([
  ['<probe>/other.ts', 'const matches = bindings.filter((b) => b.chatId === chatId)\n'],
])

export function probe(): Finding[] {
  const failures: Finding[] = []
  const yes = (check: string, findings: Finding[], what: string): void => {
    if (findings.some((f) => f.check === check)) return
    failures.push({
      check: 'instrument',
      where: INSTRUMENT,
      detail: `check \`${check}\` did not find its planted fixture (${what}) — it cannot say YES, so its silence on the real tree means nothing`,
    })
  }
  const no = (findings: Finding[], what: string): void => {
    if (findings.length === 0) return
    failures.push({
      check: 'instrument',
      where: INSTRUMENT,
      detail: `a check fired on a CLEAN fixture (${what}): ${findings.map((f) => f.detail).join(' | ')}`,
    })
  }

  yes('no-fallback-identity', fallbackIdentities(PROBE_FALLBACK), 'a fallback user constant')
  no(fallbackIdentities(PROBE_NO_FALLBACK), 'messaging code naming no user constant')

  no(inboundUngated(PROBE_GATED, '<probe>'), 'a properly gated onInbound')
  yes('inbound-gated', inboundUngated(PROBE_UNREFUSING, '<probe>'), 'resolves but never refuses')
  yes('inbound-gated', inboundUngated(PROBE_UNGATED, '<probe>'), 'no gate at all')
  yes('inbound-gated', inboundUngated(PROBE_RENAMED, '<probe>'), 'the entry point renamed away')

  yes('single-resolution-path', secondResolutionPath(PROBE_SECOND_LOOKUP), 'a find() by chatId')
  yes('single-resolution-path', secondResolutionPath(PROBE_SECOND_SQL), 'a SQL user-by-chat read')
  no(secondResolutionPath(PROBE_ONE_LOOKUP), 'a filter that collects rather than elects')

  return failures
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('telegram-binding audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('telegram-binding audit: all 3 source checks found their planted fixtures')
    return
  }

  const findings = auditSources()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Telegram identity-binding audit: ${findings.length} finding(s). The D22 claims are:\n` +
        '  · an unbound chat resolves to NOBODY, and never to a fallback identity\n' +
        '  · the gate sits on the one entry point every inbound path passes through\n' +
        '  · exactly one chat-to-user resolution exists, and it can refuse\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'telegram-binding audit OK — unbound chats fail closed, the gate is on the shared entry ' +
      'point, resolution has one home that can refuse (the running-object half is ' +
      'audit-telegram-binding.test.ts)',
  )
}

if (import.meta.main) main()
