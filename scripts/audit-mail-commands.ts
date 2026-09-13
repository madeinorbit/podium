/**
 * THE AGENT-MAIL SURFACE AUDIT (POD-640, the 3.9 cutover gate; POD-424's
 * criterion for the messages router).
 *
 * Run:
 *   bun run audit:mail            # the gate — exit 1 on any finding
 *   bun run audit:mail --json
 *   bun run audit:mail --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE `modules/messages/cutover.test.ts`
 * ---------------------------------------------------------------------------
 *
 * `cutover.test.ts` reads the RUNNING system: real contract objects, a real
 * `MessageGate`, a real `appRouter` and a real daemon relay carrying a send
 * through to a PTY and a reply back. It is the only thing that can prove a gate
 * actually refuses, and it stays the primary evidence.
 *
 * This script resolves NO modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and
 * before anything is built — the three situations in which the suite above
 * cannot run at all. It catches the textual regressions a runtime check cannot
 * see: a hand-written `.mutation(` reappearing inside the `messages:` router
 * literal, `MessageGate`'s deleted switch growing back, a transport reaching
 * `dispatchMailCommand` around the one authz door, a new send path that wakes a
 * session without declaring that it executes code to do it.
 *
 * The pairing is deliberate and is the lesson POD-732 paid for: an empty router
 * satisfies every absence claim perfectly, so a source-text instrument and a
 * running-object instrument check each other. Neither is sufficient alone.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check below is an ABSENCE or an OBLIGATION claim, and an absence is
 * exactly what a broken instrument reports. `--probe` runs each check against a
 * planted fixture containing the thing it hunts and FAILS if the check does not
 * find it. Several checks also get the converse probe — a fixture that must NOT
 * fire — because a check that fires on everything is as useless as one that
 * fires on nothing. The probe runs FIRST, always, even without the flag.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** Where, as `file:line` when a line is known. */
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

// ---------------------------------------------------------------------------
// 0 — the audit must not lose its subject silently
// ---------------------------------------------------------------------------

/**
 * A FILE THAT IS NOT THERE IS A FINDING, NOT A CRASH (the lesson POD-311's own
 * gate paid for when its tables moved).
 *
 * `readFileSync` on a moved or renamed file throws ENOENT, and an audit that
 * dies reads as an ENVIRONMENT problem — a bad checkout, a missing install —
 * rather than as the audit having lost the thing it exists to check. The two are
 * opposite conclusions: one gets retried, the other gets investigated. So every
 * subject is checked for existence first and its absence is reported in the same
 * vocabulary as every other finding.
 *
 * Taken as a PORT (`exists`) rather than calling `existsSync` inline, so the
 * probe can plant a missing file without touching the working tree.
 */
export function missingSubjects(
  files: readonly string[],
  exists: (rel: string) => boolean,
): Finding[] {
  return files
    .filter((rel) => !exists(rel))
    .map((rel) => ({
      check: 'subject-present',
      where: rel,
      detail:
        'this audit’s subject does not exist — it was moved, renamed or deleted. Every check that ' +
        'reads it would otherwise crash with ENOENT and read as a broken checkout rather than as ' +
        'the audit having lost its subject. Re-point the audit, or explain the deletion',
    }))
}

/** Comments stripped, so a doc comment that NAMES a deleted seam is not counted
 *  as a call site. POD-729's files document what they removed by quoting it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

// ---------------------------------------------------------------------------
// 1 — no hand-written procedure in the messages router
// ---------------------------------------------------------------------------

/**
 * Extract the `messages: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: the literal carries comments between its entries, and a
 * line-based reader stops at the first `})` — which would report a serene zero
 * for a procedure written anywhere after it. `--probe` plants its mutation at
 * the END of the block for exactly that reason.
 *
 * Returns `undefined` when the router is absent, which the caller treats as a
 * FINDING and not as a pass: a router that vanished is not a router with no
 * hand-written procedures. That arm is what turns "I renamed the router" into a
 * red rather than into silence.
 */
export function routerBlock(source: string): { text: string; startLine: number } | undefined {
  const marker = /^\s{2}messages: t\.router\(\{/m
  const match = marker.exec(source)
  if (!match) return undefined
  const open = source.indexOf('{', match.index + match[0].length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        return { text: source.slice(open, i + 1), startLine: lineOf(source, match.index) }
      }
    }
  }
  return undefined
}

/**
 * The POD-424 criterion, plus the three things that come with it. A body
 * (`.mutation(`/`.query(`), a raw `t.procedure`, or a `z.unknown()` input are
 * all the same regression wearing different clothes: a second validation
 * surface beside the contract's own schema instance.
 */
export function handWrittenMailProcedures(source: string, where: string): Finding[] {
  const block = routerBlock(source)
  if (!block) {
    return [
      {
        check: 'derived-surface',
        where,
        detail: 'no `messages: t.router({` literal found — the scan has nothing to check',
      },
    ]
  }
  const findings: Finding[] = []
  const banned: Array<[RegExp, string]> = [
    [/\.mutation\(/g, 'hand-written `.mutation(` inside the messages router'],
    [/\.query\(/g, 'hand-written `.query(` inside the messages router'],
    [/t\.procedure/g, 'a raw `t.procedure` inside the messages router'],
    [
      /z\.unknown\(\)/g,
      'a `z.unknown()` input inside the messages router — the contract owns the schema, and ' +
        '`z.unknown()` is how the tRPC arm stopped typing anything and shipped the payload to a ' +
        'second, private parse',
    ],
  ]
  for (const [pattern, detail] of banned) {
    for (const match of block.text.matchAll(pattern)) {
      findings.push({
        check: 'derived-surface',
        where: `${where}:${block.startLine + lineOf(block.text, match.index) - 1}`,
        detail: `${detail} — every mail procedure is derived from its contract by mailMutation/mailQuery`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the deleted hand-written arm must not grow back
// ---------------------------------------------------------------------------

/**
 * `MessageGate.dispatch` used to fall through to a `switch (proc)` over
 * hand-written bodies, each with its own inline input schema. POD-729 deleted
 * both. They regrow because they are locally convenient: adding a case to a
 * switch is a smaller diff than adding a contract, and it is precisely the
 * second surface this programme exists to end.
 *
 * Keyed on the DECLARATION, not on any mention — gate.ts documents the deletion
 * by naming the switch, and a check that fired on that would be a check nobody
 * could keep green.
 */
export function resurrectedSecondSurface(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  const code = stripComments(source)
  const patterns: Array<[RegExp, string]> = [
    [
      /switch\s*\(\s*proc\s*\)/,
      '`switch (proc)` is back in the gate — a name-keyed second arm serves a proc because a case ' +
        'exists, not because a contract declares the transport (ADR 3 D3)',
    ],
    [
      /^(export )?const (message|mail)Inputs\b/m,
      'a `messageInputs`/`mailInputs` schema table is back — a second declaration of the input ' +
        'shapes the contracts already own (ADR 3 D1: ONE validation source per command)',
    ],
  ]
  for (const [pattern, detail] of patterns) {
    const match = pattern.exec(code)
    if (match) {
      findings.push({ check: 'no-second-surface', where: `${where}:${lineOf(code, match.index)}`, detail })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — one authz door
// ---------------------------------------------------------------------------

/**
 * `dispatchMailCommand` validates through the contract and runs the handler —
 * but it takes a `MailHandlerContext` the CALLER assembles, which includes the
 * `MailAccess` that decides every refusal. A transport that builds that context
 * itself can hand the handlers a permissive access object, and the one authz
 * path becomes two without a single line of authz being edited.
 *
 * So the rule is structural: the only callers are the module's own `registry.ts`
 * (which defines it) and `gate.ts` (which owns the one context). Every transport
 * enters through `MessageGate.dispatch`.
 */
export function extraDispatchCallers(files: Array<[string, string]>): Finding[] {
  const allowed = new Set([
    'apps/server/src/modules/messages/registry.ts',
    'apps/server/src/modules/messages/gate.ts',
  ])
  const findings: Finding[] = []
  for (const [where, source] of files) {
    if (allowed.has(where)) continue
    for (const match of stripComments(source).matchAll(/\bdispatchMailCommand\(/g)) {
      findings.push({
        check: 'one-authz-door',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          'calls `dispatchMailCommand` directly — it takes a caller-assembled MailHandlerContext, ' +
          'so this is how a second MailAccess (and a second answer to every refusal) enters. ' +
          'Enter through `MessageGate.dispatch`, which owns the one context',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — every contract declares its visibility class
// ---------------------------------------------------------------------------

/** One `export const <name>Contract: CommandContract<…> = { … }` literal. */
interface ContractBlock {
  name: string
  body: string
  startLine: number
}

export function contractBlocks(source: string): ContractBlock[] {
  const out: ContractBlock[] = []
  for (const match of source.matchAll(/^export const (\w+Contract): CommandContract<[^=]*=\s*\{$/gm)) {
    const start = match.index
    const end = source.indexOf('\n}\n', start)
    out.push({
      name: match[1] as string,
      body: source.slice(start, end === -1 ? source.length : end),
      startLine: lineOf(source, start),
    })
  }
  return out
}

/**
 * `visibility` is REQUIRED on `CommandContract` at the type level, so this looks
 * redundant — and it is not, for the reason POD-731 hit: a widening cast
 * (`as unknown as`) over the contract table compiles happily with the field
 * missing from every entry, silently defeating the compile-time half of the
 * default-closed rule. A textual check cannot be cast away.
 */
export function undeclaredVisibility(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const block of contractBlocks(source)) {
    if (!/^\s{2}visibility:/m.test(block.body)) {
      findings.push({
        check: 'visibility-totality',
        where: `${where}:${block.startLine}`,
        detail:
          `${block.name} declares no \`visibility\` class — ADR 9 D3/D4 is default-closed and a ` +
          'contract with no class is a write nobody classified',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 5 — a command that WAKES declares that it executes (POD-1179)
// ---------------------------------------------------------------------------

/**
 * THE TABLE-WIDE ASSERTION POD-1179 ASKED FOR.
 *
 * A message delivered at `lifecycle: 'wake'` reaches
 * `MessageDeliveryService.trySpawn`: it resumes a parked session, or spawns one,
 * which is arbitrary code execution on that session's machine with its ssh keys,
 * git identity and private checkouts (readiness §3.1.4 M2). A command that can
 * cause that must declare `machineVerb: 'use'`, and POD-1179 exists because
 * `mail.ask`'s declaration was lost in a merge and NOTHING noticed for a week.
 *
 * This is the something that notices. It is keyed on the HANDLER, because the
 * handler is where the wake actually originates, and each handler names its own
 * contract in its import — so the mapping is read out of the source rather than
 * maintained as a list here that could silently stop matching.
 *
 * Two ways a handler is wake-capable, and both are checked:
 *   · it hard-codes `lifecycle: 'wake'` (this is `mail.ask`);
 *   · it forwards a caller-supplied lifecycle, whose schema admits `'wake'`
 *     (this is `mail.send`).
 *
 * `mail.reply` is the negative control that makes the check meaningful: its
 * contract has no lifecycle field and `sendReply` defaults to `wait`, so it
 * cannot wake and must NOT be required to declare the verb. A check that
 * demanded the verb of every handler would be trivially satisfiable and would
 * prove nothing about the ones that matter.
 */
export function wakeWithoutMachineVerb(
  handlers: Array<[string, string]>,
  contractsSource: string,
  contractsWhere: string,
): Finding[] {
  const findings: Finding[] = []
  const blocks = new Map(contractBlocks(contractsSource).map((b) => [b.name, b]))
  for (const [where, source] of handlers) {
    const code = stripComments(source)
    const hardcodes = /lifecycle:\s*'wake'/.test(code)
    const forwards = /lifecycle:\s*(?:\w+\.)*input\.lifecycle/.test(code)
    if (!hardcodes && !forwards) continue
    const contractName = /import\b[^;]*?\b(\w+Contract)\b[^;]*?from '@podium\/commands'/s.exec(code)?.[1]
    if (contractName === undefined) {
      findings.push({
        check: 'wake-needs-use',
        where,
        detail:
          'this handler can deliver at `lifecycle: \'wake\'` but names no `*Contract` import, so the ' +
          'audit cannot tell which contract must declare `machineVerb: \'use\'` — the mapping is ' +
          'read from the import deliberately, so name it',
      })
      continue
    }
    const block = blocks.get(contractName)
    if (block === undefined) {
      findings.push({
        check: 'wake-needs-use',
        where,
        detail: `names \`${contractName}\`, which is not a contract literal in ${contractsWhere}`,
      })
      continue
    }
    if (!/^\s{4}machineVerb: 'use',$/m.test(block.body)) {
      findings.push({
        check: 'wake-needs-use',
        where: `${contractsWhere}:${block.startLine}`,
        detail:
          `${contractName} is reached by a handler that delivers at \`lifecycle: 'wake'\` ` +
          `(${where}) but declares no \`machineVerb: 'use'\`. A wake resumes or spawns a session — ` +
          'code execution on someone else’s machine (readiness §3.1.4 M2). This is the POD-1179 ' +
          'regression: the declaration was dropped in a merge and nothing caught it',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 6 — the legacy idempotency wrapper stays deleted
// ---------------------------------------------------------------------------

/**
 * `sessions.sendText` and `sessions.resumeAndSend` used to wrap
 * `mods(ctx).messages.send` in `SessionsService.withMutation`, a per-proc
 * idempotency wrapper Phase 3 deletes in favour of the one `MutationLedger` in
 * `@podium/sync`. A re-introduction is a SECOND dedup ledger, which is how two
 * answers to "have I already applied this" enter the product.
 *
 * A CALL SITE, not a mention: `session-cutover.audit.test.ts` bans the METHOD
 * coming back on the service; this bans the call coming back in the mail and
 * session-command-plane paths. Comments are stripped first, because both files
 * document the deletion by quoting the call they removed — counting those made
 * an earlier version of this instrument report a regression for a clean tree.
 */
export function legacyIdempotencyWrapper(files: Array<[string, string]>): Finding[] {
  const findings: Finding[] = []
  for (const [where, source] of files) {
    for (const match of stripComments(source).matchAll(/\.withMutation\(/g)) {
      findings.push({
        check: 'one-ledger',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          '`withMutation(` is back — Phase 3 replaced the per-proc wrapper with the one ' +
          '`MutationLedger` in `@podium/sync`, reached as `ctx.deps.mutations.once(`',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 7 — declared exposure equals actual reach, per transport (PDM-422)
// ---------------------------------------------------------------------------

/**
 * THE NINE `mcp` DECLARATIONS THIS INSTRUMENT CANNOT RESOLVE — a FINDING LIST,
 * not a waiver, and the reason it exists is the whole of PDM-422.
 *
 * Nine mail contracts declare `mcp` in their `exposure`. The one MCP surface
 * this server serves is `POST /mcp`, registered in `server.ts` against
 * `superagent.mcpToolSpecs` / `superagent.callMcpTool` — the superagent's TOOL
 * BELT (`modules/superagent/tools.ts`), with the issue tools bridged into it.
 * The belt's own tools do not dispatch a proc NAME: `send_to_agent` and
 * `ask_agent` call `modules.messages.send(…)`, the SERVICE method, directly.
 *
 * THE CLAIM, AT THE STRENGTH THE EVIDENCE SUPPORTS. **This instrument has no
 * tool → contract-name mapping to compare these declarations against**, so it
 * records them as UNRESOLVED. That is a fact about this instrument, not a proof
 * that no instrument could ever resolve them: a reader of the belt's source
 * could decide, tool by tool, what each one serves. An earlier draft of this
 * comment said "no instrument can confirm or refute", which is stronger than
 * anything measured here and is exactly the overclaim this file exists to refuse.
 *
 * WHAT WAS MEASURED, so the next reader does not re-derive it: at the pin this
 * list was written, no call site in either repo passes the literal `'mcp'` as
 * the `transport` argument to any exposure check. `isMailProcExposedOn(proc,
 * transport)` — the one runtime reader of this family's `exposure`, called from
 * `gate.ts` — is reached only with `'trpc'` (the router) and `'relay'` (the
 * relay dispatch and the default). Every other occurrence of the tag is a
 * declaration, a member of a `TransportTag`-style union, a BAN-list entry
 * (`AGENT_TRANSPORTS` in `modules/automations/trpc.ts`), or a doc comment
 * describing a plant.
 *
 * SO THE `mcp` ARM PINS AN UNRESOLVED DISPOSITION, AND NOTHING ELSE. It does not
 * establish that these nine are served, nor that they are unserved. The tRPC
 * comparison below is a real both-directions check and it says NOTHING about
 * MCP; do not let its green stand in for this list. PDM-435 carries the
 * separate, bounded finding about how the route census describes this door.
 *
 * THE LIST IS ASSERTED IN BOTH DIRECTIONS. A tenth contract growing an `mcp`
 * tag reddens this audit, and so does one of these nine losing it — the second
 * is the direction that matters, because a correct future repair should arrive
 * as a reviewed edit here rather than as a silently shrinking list.
 */
export const MCP_DECLARED_UNRESOLVED: readonly string[] = [
  'awaitAgent',
  'dismiss',
  'inbox',
  'ledger',
  'reply',
  'send',
  'show',
  'spawnAgent',
  'status',
]

/**
 * THE UNCENSUSED MCP SUB-TRANSPORT, NAMED RATHER THAN LEFT UNSTATED — the same
 * contract `served-route-census.ts` keeps with `UNCENSUSED_TRANSPORTS`.
 */
export const UNCENSUSED_MCP_SUB_TRANSPORT = {
  name: 'superagent tool belt (modules/superagent/tools.ts)',
  why:
    "The MCP surface's population is the belt's own hand-written tool specs plus the bridged issue " +
    'tools. A belt tool calls a SERVICE METHOD, not a named proc, so THIS instrument can derive no ' +
    'tool → contract-name mapping from it. A runtime recorder over the belt is branch-sensitive and ' +
    'under-reports, which is why this audit reads source text and records the hole instead of ' +
    'guessing at it. Deciding what each belt tool serves is a source-reading job, not a scan.',
} as const

/** What the registry parser made of `MAIL_COMMANDS`. */
export interface RegistryJoin {
  /** Registry key → contract const, for every entry this parser understood. */
  readonly join: Map<string, string>
  /**
   * Entry spellings present in the table that this parser did NOT resolve.
   *
   * WITHOUT THIS FIELD THE TOTALITY CHECK IS A FLOOR THAT CANNOT SEE ITS OWN
   * BLIND SPOT: it iterates the entries the parser recognised, so an entry
   * written in a shape the regex misses is absent from `join`, absent from the
   * declared set, and — if the router does not mount it either — absent from
   * both sides of every comparison, with nothing reported. A count cannot notice
   * a shape that never arrives, so the parser reports what it could not read.
   */
  readonly unparsed: readonly string[]
  /** False when no `MAIL_COMMANDS` literal was found at all. */
  readonly found: boolean
}

/**
 * Registry key → contract const, read out of `MAIL_COMMANDS`.
 *
 * The join is READ, not restated: the registry keys on the BARE wire name
 * (`inbox`) and the contract carries the dotted identity (`mail.inboxConsume`),
 * so string-munging one into the other would invent the seam this table already
 * is.
 *
 * Entries are enumerated PERMISSIVELY (anything at the table's indentation that
 * opens a brace) and then resolved STRUCTURALLY — a bare key, a single-quoted
 * key or a double-quoted key all resolve. Anything else is reported through
 * `unparsed` rather than silently skipped.
 */
export function mailRegistryJoin(registrySource: string): RegistryJoin {
  const join = new Map<string, string>()
  const unparsed: string[] = []
  const block = /export const MAIL_COMMANDS = \{([\s\S]*?)\n\} as const/.exec(registrySource)
  if (!block) return { join, unparsed, found: false }
  const body = block[1] as string
  // BRACE-MATCHED, not line-shaped. This table carries BOTH single-line entries
  // (`send: { contract: x, handler: y },`) and multi-line ones
  // (`pendingReminders: {\n  contract: …`). A regex anchored on a closing `},`
  // at the table's indentation reads only the second kind — which the first
  // draft of this parser did, and the discriminating probes caught it on the
  // first run by reporting an EMPTY join for a table with three valid entries.
  for (const entry of body.matchAll(/^\s{2}([^\s:]+):\s*\{/gm)) {
    const rawKey = entry[1] as string
    const open = body.indexOf('{', entry.index + entry[0].length - 1)
    let depth = 0
    let close = -1
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) {
      unparsed.push(rawKey)
      continue
    }
    const inner = body.slice(open + 1, close)
    const key = /^(?:'([\w$]+)'|"([\w$]+)"|([\w$]+))$/.exec(rawKey)
    const contract = /\bcontract:\s*(\w+)/.exec(inner)?.[1]
    if (!key || contract === undefined) {
      unparsed.push(rawKey)
      continue
    }
    join.set((key[1] ?? key[2] ?? key[3]) as string, contract)
  }
  return { join, unparsed, found: true }
}

/**
 * Contract const → its declared transport tags, or `null` when the declaration
 * is PRESENT BUT UNRESOLVABLE.
 *
 * Reads the INLINE ARRAY form (`exposure: ['trpc', 'cli', 'mcp', 'relay']`),
 * which is how this family declares and which the issues-family instrument
 * cannot parse at all: `audit-issue-commands.ts` reads `exposure: (\w+),` — a
 * named CELL such as `SERVED_EVERYWHERE`.
 *
 * THE `null` ARM IS LOAD-BEARING. An array element that is not a string literal
 * — a spread of a shared cell (`['trpc', ...AGENT_TAGS]`), an identifier, a
 * conditional — cannot be resolved by reading this file alone. Splitting on
 * commas and keeping the raw token would record a TAG NAMED `...AGENT_TAGS`:
 * the declaration would look successfully parsed, and if the spread carried
 * `trpc` or `mcp` the real tag would vanish from the comparison without a word.
 * So an unresolvable element poisons the whole declaration, deliberately.
 */
export function mailExposureByConst(contractsSource: string): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>()
  for (const m of contractsSource.matchAll(/export const (\w+)[^=]*=\s*\{([\s\S]*?)\n\}/g)) {
    const tags = /^\s*exposure: \[([^\]]*)\]/m.exec(m[2] as string)
    if (!tags) continue
    const parts = (tags[1] as string)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    const literal = /^'([^']*)'$|^"([^"]*)"$/
    if (parts.some((t) => !literal.test(t))) {
      out.set(m[1] as string, null)
      continue
    }
    out.set(
      m[1] as string,
      parts.map((t) => {
        const q = literal.exec(t)
        return (q?.[1] ?? q?.[2]) as string
      }),
    )
  }
  return out
}

/**
 * Every mail proc name that `router.ts` SYNTACTICALLY builds a tRPC procedure
 * for.
 *
 * THE REACH SOURCE IS EVERY `mailMutation(`/`mailQuery(` CALL IN `router.ts`,
 * AND NOT THE `messages:` ROUTER BLOCK — this is the control that makes the
 * check trustworthy rather than the obvious implementation. `mail.ask` is served
 * as `sessions.ask`, built by `mailMutation('ask')` inside the SESSIONS router.
 * A reach source scoped to the `messages:` block would report `mail.ask` as
 * "declares trpc but nothing reaches it" — a false finding about a proc that is
 * served, produced by an instrument that looked in one router because one router
 * was where it expected the family to live.
 *
 * WHAT THIS IS AND IS NOT — the bound matters, because "reach" overstates it.
 * This is a SYNTACTIC CALL-SITE INVENTORY. It does not evaluate `router.ts` and
 * cannot establish that a procedure is MOUNTED on the served router:
 *
 *   · a call inside a nested string literal is counted;
 *   · a call in a helper that is defined and never mounted is counted;
 *   · a procedure mounted by any means other than a literal
 *     `mailMutation('<name>')` / `mailQuery('<name>')` call is NOT counted.
 *
 * Comments are stripped, so prose quoting a call does not count — that much is
 * checked. The rest is a deliberate, recorded limitation: syntax alone does not
 * prove mounting, and this function does not claim it does. The runtime half of
 * that claim belongs to `modules/messages/cutover.test.ts`, which resolves real
 * objects; see this file's header on why the two instruments need each other.
 */
export function trpcCallSites(routerSource: string): Set<string> {
  return new Set(
    [...stripComments(routerSource).matchAll(/mail(?:Mutation|Query)\(\s*'(\w+)'/g)].map(
      (m) => m[1] as string,
    ),
  )
}

/**
 * ADR 3 D3 for this family: a transport is served because a contract NAMES it,
 * which is only true if the naming and the wiring agree. Compared in BOTH
 * directions, because the two failures are different bugs — a proc served
 * without a declaration defeats the default-closed rule, and a declaration
 * nothing reaches is the field decaying into decoration.
 *
 * ONE TRANSPORT IS COMPARED. The other three are accounted for SEPARATELY, and
 * they are NOT one case:
 *
 *   · `trpc` — compared, against the syntactic call-site inventory above, with
 *     that function's mounting bound inherited.
 *   · `relay` — `relay-dispatch.ts` passes a RUNTIME proc string straight to
 *     `MessageGate.dispatch`, so any name can arrive and `exposure` IS the door
 *     rather than a claim about one. There is no second set to compare against;
 *     the declaration is the enforcement.
 *   · `cli` — **UNVERIFIED, and NOT covered by the relay argument above.** The
 *     CLI is a separate surface with its own static verb tables (`apps/cli/src/
 *     mail-cli.ts` names six procs; `spawnAgent`/`awaitAgent` are `podium agent
 *     …` elsewhere, and `ask` elsewhere again). A sound `cli` reach source is
 *     multi-file and this instrument does not build one. That the CLI reaches
 *     the gate THROUGH the relay says nothing about which verbs the CLI offers,
 *     so relay admission does not establish CLI reach. Known gap, not cleared.
 *   · `mcp` — this instrument derives no tool → proc-name mapping. See
 *     {@link MCP_DECLARED_UNRESOLVED} and {@link UNCENSUSED_MCP_SUB_TRANSPORT}.
 */
export function exposureMatchesReach(
  registrySource: string,
  contractsSource: string,
  routerSource: string,
  where: { registry: string; contracts: string; router: string },
  /** Taken as a PORT so `--probe` can plant its own reviewed list. Defaulting it
   *  here rather than at the call site keeps the gate reading the real record. */
  recordedMcp: readonly string[] = MCP_DECLARED_UNRESOLVED,
): Finding[] {
  const findings: Finding[] = []
  const { join, unparsed, found } = mailRegistryJoin(registrySource)
  const exposure = mailExposureByConst(contractsSource)

  if (!found || join.size === 0) {
    return [
      {
        check: 'exposure-matches-reach',
        where: where.registry,
        detail:
          'no `MAIL_COMMANDS` table could be read — the join between registry keys and contracts is ' +
          'the subject of this check, and a comparison with nothing on one side is not evidence',
      },
    ]
  }

  // THE SHAPES THE PARSER COULD NOT READ, reported before anything is compared.
  for (const rawKey of unparsed) {
    findings.push({
      check: 'exposure-matches-reach',
      where: where.registry,
      detail:
        `the \`MAIL_COMMANDS\` entry spelled \`${rawKey}\` could not be resolved to a key and a ` +
        'contract. It is therefore in NEITHER compared set, and an entry missing from both sides is ' +
        'invisible rather than wrong — teach this parser the shape, or change the entry',
    })
  }

  // TOTALITY. A key whose exposure is absent or UNRESOLVABLE would drop silently
  // out of every set below and be reported as neither declared nor reached.
  //
  // A KEY WHOSE DECLARATION COULD NOT BE READ IS REPORTED ONCE AND THEN LEFT OUT
  // OF BOTH COMPARISONS. It is tempting to let it fall through: it simply would
  // not be in `declaredTrpc`, and the router mounting it would then read as
  // "served without a declaration". That finding would be FALSE. This instrument
  // did not establish that the contract lacks `trpc` — it established that it
  // could not read the contract, which is a fact about the parser and not about
  // the code. Emitting the second claim would send someone to add a tag that may
  // already be there. Unproved is not open, so it is excluded and said once.
  const unresolved = new Set<string>()
  const declaredOn = (tag: string): Set<string> => {
    const out = new Set<string>()
    for (const [key, constName] of join) {
      if (unresolved.has(key)) continue
      if (exposure.get(constName)?.includes(tag) === true) out.add(key)
    }
    return out
  }
  for (const [key, constName] of join) {
    const tags = exposure.get(constName)
    if (tags === undefined) {
      unresolved.add(key)
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `\`${key}\` joins \`${constName}\`, whose \`exposure\` cannot be found in ` +
          `${where.contracts} — an unreadable declaration silently leaves this comparison rather ` +
          'than failing it',
      })
    } else if (tags === null) {
      unresolved.add(key)
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `\`${key}\` joins \`${constName}\`, whose \`exposure\` array contains an element that is ` +
          'not a string literal (a spread, an identifier, a conditional). Reading this file alone ' +
          'cannot say which transports it names, and treating the raw token as a tag would hide a ' +
          '`trpc` or `mcp` the spread carries',
      })
    }
  }

  const declaredTrpc = declaredOn('trpc')
  const reached = trpcCallSites(routerSource)
  if (declaredTrpc.size === 0 || reached.size === 0) {
    findings.push({
      check: 'exposure-matches-reach',
      where: `${where.contracts} / ${where.router}`,
      detail:
        `one side of the trpc comparison is EMPTY (declared=${declaredTrpc.size}, ` +
        `reached=${reached.size}) — an equality between empty sets is not evidence`,
    })
    return findings
  }

  for (const proc of [...reached].sort()) {
    if (unresolved.has(proc)) continue
    if (!declaredTrpc.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.router,
        detail:
          `\`router.ts\` builds a tRPC procedure for mail \`${proc}\` but its contract does not ` +
          'declare the `trpc` transport — a surface served without a declaration defeats the ' +
          'default-closed rule (ADR 3 D3)',
      })
    }
  }
  for (const proc of [...declaredTrpc].sort()) {
    if (!reached.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `mail \`${proc}\` declares the \`trpc\` transport but no \`mailMutation\`/\`mailQuery\` in ` +
          'router.ts reaches it — a declaration that opens nothing is the field decaying into ' +
          'decoration',
      })
    }
  }

  // THE `mcp` ARM. Not a comparison against a served set — this instrument
  // derives none — but against the reviewed list, in both directions.
  const declaredMcp = declaredOn('mcp')
  const recorded = new Set(recordedMcp)
  for (const proc of [...declaredMcp].sort()) {
    if (!recorded.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `mail \`${proc}\` newly declares the \`mcp\` transport. This instrument cannot resolve ` +
          `that claim: the MCP surface is the ${UNCENSUSED_MCP_SUB_TRANSPORT.name}, whose tools ` +
          'call service methods rather than named procs. Read it, decide whether the tag is true, ' +
          'and record it in MCP_DECLARED_UNRESOLVED',
      })
    }
  }
  for (const proc of [...recorded].sort()) {
    if (!declaredMcp.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `MCP_DECLARED_UNRESOLVED records mail \`${proc}\` as declaring \`mcp\` and it no longer ` +
          'does. If that is the repair, drop it from the list in the same commit — a list that ' +
          'shrinks on its own stops being a record of what was reviewed',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const HANDLERS = [
  'apps/server/src/modules/messages/handlers/ask.ts',
  'apps/server/src/modules/messages/handlers/await-agent.ts',
  'apps/server/src/modules/messages/handlers/inbox-consume.ts',
  'apps/server/src/modules/messages/handlers/ledger.ts',
  'apps/server/src/modules/messages/handlers/pending-reminders.ts',
  'apps/server/src/modules/messages/handlers/projections.ts',
  'apps/server/src/modules/messages/handlers/reply.ts',
  'apps/server/src/modules/messages/handlers/send.ts',
  'apps/server/src/modules/messages/handlers/spawn-agent.ts',
] as const

const SCANNED = [
  'apps/server/src/router.ts',
  'apps/server/src/relay.ts',
  'apps/server/src/modules/messages/gate.ts',
  'apps/server/src/modules/messages/registry.ts',
  'apps/server/src/modules/messages/service.ts',
  'apps/server/src/modules/sessions/command-plane.ts',
  ...HANDLERS,
] as const

const CONTRACTS = 'packages/commands/src/mail/contracts.ts'

export function auditMailCommands(): Finding[] {
  // THE SUBJECT CHECK RUNS FIRST AND SHORT-CIRCUITS. Reporting "no hand-written
  // mutation found" about a router that is not there would be the purest form of
  // the failure this whole run is about: a green that means the scan lost its
  // subject. `CONTRACTS` is included because a missing contract TABLE is the
  // specific way POD-311's gate died.
  const absent = missingSubjects([...SCANNED, CONTRACTS], (rel) => existsSync(join(ROOT, rel)))
  if (absent.length > 0) return absent

  const router = read('apps/server/src/router.ts')
  const gate = read('apps/server/src/modules/messages/gate.ts')
  const contracts = read(CONTRACTS)
  return [
    ...handWrittenMailProcedures(router, 'apps/server/src/router.ts'),
    ...resurrectedSecondSurface(gate, 'apps/server/src/modules/messages/gate.ts'),
    ...extraDispatchCallers(SCANNED.map((rel) => [rel, read(rel)] as [string, string])),
    ...undeclaredVisibility(contracts, CONTRACTS),
    ...wakeWithoutMachineVerb(
      HANDLERS.map((rel) => [rel, read(rel)] as [string, string]),
      contracts,
      CONTRACTS,
    ),
    ...legacyIdempotencyWrapper(
      (
        [
          'apps/server/src/modules/sessions/command-plane.ts',
          'apps/server/src/modules/messages/gate.ts',
          'apps/server/src/modules/messages/service.ts',
          ...HANDLERS,
        ] as const
      ).map((rel) => [rel, read(rel)] as [string, string]),
    ),
    ...exposureMatchesReach(
      read('apps/server/src/modules/messages/registry.ts'),
      contracts,
      router,
      {
        registry: 'apps/server/src/modules/messages/registry.ts',
        contracts: CONTRACTS,
        router: 'apps/server/src/router.ts',
      },
    ),
  ]
}

/** Each check, run against a fixture containing exactly what it hunts. */
function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-mail-commands.ts',
        detail: `the ${name} check did NOT find its planted fixture — its zero is meaningless`,
      })
    }
  }
  /**
   * THE DISCRIMINATING ASSERTION, and the reason it exists.
   *
   * `expect` above asserts only that SOMETHING was found. That is not
   * attribution, and PDM-139's review caught it doing real damage: the
   * `reached-undeclared` fixture left two sibling contracts unresolvable, so it
   * produced two totality findings and an empty-side finding, the empty-side
   * guard RETURNED BEFORE the reached-undeclared loop ever ran, and the probe
   * was green while the comparison it names was never executed. Deleting that
   * comparison entirely would not have reddened it.
   *
   * So a witness must name what it expects: at least one finding MATCHING the
   * signature, and NO finding that does not. The second half is what makes it a
   * witness rather than a net — a fixture that fires three unrelated checks is
   * not evidence about the one in its name.
   */
  const expectOnly = (name: string, found: Finding[], signature: RegExp): void => {
    const hit = found.filter((f) => signature.test(f.detail))
    const stray = found.filter((f) => !signature.test(f.detail))
    if (hit.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-mail-commands.ts',
        detail:
          `the ${name} check found no finding matching ${signature} — it found ` +
          `${found.length} other(s), so its non-zero length was not evidence about this check: ` +
          `${found[0]?.detail ?? '<none>'}`,
      })
    }
    if (stray.length > 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-mail-commands.ts',
        detail:
          `the ${name} fixture ALSO fired ${stray.length} unrelated finding(s), so it does not ` +
          `isolate what it names: ${stray[0]?.detail}`,
      })
    }
  }
  const expectSilent = (name: string, found: Finding[]): void => {
    if (found.length > 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-mail-commands.ts',
        detail: `the ${name} check fired on a fixture it must ACCEPT — it cannot say NO: ${found[0]?.detail}`,
      })
    }
  }

  // A missing contract table must REPORT, not crash. Both arms: the absence is
  // found, and a table that IS there does not fire.
  expect(
    'subject-present',
    missingSubjects([CONTRACTS], () => false),
  )
  expectSilent(
    'subject-present/present',
    missingSubjects([CONTRACTS], () => true),
  )

  expect(
    'derived-surface',
    handWrittenMailProcedures(
      [
        '  messages: t.router({',
        "    send: mailMutation('send'),",
        "    show: mailQuery('show'),",
        // Planted at the END, past the entries, so a line-scan implementation fails here.
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
      ].join('\n'),
      '<probe>',
    ),
  )
  // The router-is-missing arm is itself a finding, and it is the arm that turns
  // "I renamed the router" into a red rather than a serene zero.
  expect('derived-surface/absent', handWrittenMailProcedures('const nothing = 1\n', '<probe>'))
  // …and the derived surface itself must PASS, or the check would be firing on
  // the router rather than on the hand-written procedure.
  expectSilent(
    'derived-surface/clean',
    handWrittenMailProcedures(
      ['  messages: t.router({', "    send: mailMutation('send'),", '  }),'].join('\n'),
      '<probe>',
    ),
  )

  expect(
    'no-second-surface',
    resurrectedSecondSurface(
      ['switch (proc) {', "  case 'send':", '    return this.send(input)', '}'].join('\n'),
      '<probe>',
    ),
  )
  expect(
    'no-second-surface/inputs',
    resurrectedSecondSurface(
      ['const messageInputs = {', '  send: z.object({}),', '}'].join('\n'),
      '<probe>',
    ),
  )
  // The deletion is DOCUMENTED by naming the switch, and a check that fired on
  // the doc comment is one nobody can keep green.
  expectSilent(
    'no-second-surface/comment',
    resurrectedSecondSurface(
      '/** The `switch (proc)` this used to fall through to is DELETED. */\nconst x = 1\n',
      '<probe>',
    ),
  )

  expect(
    'one-authz-door',
    extraDispatchCallers([
      ['apps/server/src/some-transport.ts', 'return dispatchMailCommand(proc, myOwnCtx, input)\n'],
    ]),
  )
  expectSilent(
    'one-authz-door/allowed',
    extraDispatchCallers([
      [
        'apps/server/src/modules/messages/gate.ts',
        'return Promise.resolve(dispatchMailCommand(proc, ctx, input))\n',
      ],
    ]),
  )

  expect(
    'visibility-totality',
    undeclaredVisibility(
      [
        'export const mailClassifiedContract: CommandContract<typeof i> = {',
        "  name: 'mail.classified',",
        "  visibility: 'personal',",
        '}',
        '',
        'export const mailForgottenContract: CommandContract<typeof i> = {',
        "  name: 'mail.forgotten',",
        '  version: 1,',
        '}',
      ].join('\n'),
      '<probe>',
    ),
  )

  // The POD-1179 regression itself, replayed: a handler that hard-codes a wake
  // against a contract with no verb. This is the exact fixture that would have
  // caught the merge.
  const contractsFixture = [
    'export const mailAskContract: CommandContract<typeof mailAskInput> = {',
    "  name: 'mail.ask',",
    '  policy: {',
    "    resource: 'session',",
    '  },',
    '}',
    '',
    'export const mailSendContract: CommandContract<typeof mailSendInput> = {',
    "  name: 'mail.send',",
    '  policy: {',
    "    resource: 'none',",
    "    machineVerb: 'use',",
    '  },',
    '}',
    '',
    'export const mailReplyContract: CommandContract<typeof mailReplyInput> = {',
    "  name: 'mail.reply',",
    '  policy: {',
    "    resource: 'none',",
    '  },',
    '}',
  ].join('\n')
  expect(
    'wake-needs-use',
    wakeWithoutMachineVerb(
      [
        [
          '<probe>/ask.ts',
          [
            "import type { ContractInput, mailAskContract } from '@podium/commands'",
            "  svc.send(from, { body: q, lifecycle: 'wake' })",
          ].join('\n'),
        ],
      ],
      contractsFixture,
      '<probe>',
    ),
  )
  // The forwarding form, which is `mail.send`'s shape and would be missed by a
  // check that only looked for the literal.
  expect(
    'wake-needs-use/forwarded',
    wakeWithoutMachineVerb(
      [
        [
          '<probe>/ask.ts',
          [
            "import type { ContractInput, mailAskContract } from '@podium/commands'",
            '  svc.send(from, { lifecycle: input.lifecycle })',
          ].join('\n'),
        ],
      ],
      contractsFixture,
      '<probe>',
    ),
  )
  // THE NEGATIVE CONTROL THAT MAKES THE CHECK MEAN SOMETHING. `mail.reply`
  // cannot wake, so it must not be required to declare the verb — and a
  // wake-capable handler whose contract DOES declare it must pass. Without these
  // two, a check that simply demanded the verb of everything would score green.
  expectSilent(
    'wake-needs-use/cannot-wake',
    wakeWithoutMachineVerb(
      [
        [
          '<probe>/reply.ts',
          [
            "import type { ContractInput, mailReplyContract } from '@podium/commands'",
            '  svc.sendReply(from, { inReplyTo: input.id, body: input.body })',
          ].join('\n'),
        ],
      ],
      contractsFixture,
      '<probe>',
    ),
  )
  expectSilent(
    'wake-needs-use/declared',
    wakeWithoutMachineVerb(
      [
        [
          '<probe>/send.ts',
          [
            "import { type ContractInput, type mailSendContract } from '@podium/commands'",
            '  svc.send(from, { lifecycle: input.lifecycle })',
          ].join('\n'),
        ],
      ],
      contractsFixture,
      '<probe>',
    ),
  )

  expect(
    'one-ledger',
    legacyIdempotencyWrapper([
      ['<probe>/command-plane.ts', 'return ctx.sessions.withMutation(id, () => run())\n'],
    ]),
  )
  expectSilent(
    'one-ledger/comment',
    legacyIdempotencyWrapper([
      ['<probe>/command-plane.ts', '// it used to be ctx.sessions.withMutation(id, fn)\nconst x = 1\n'],
    ]),
  )

  // -------------------------------------------------------------------------
  // 7 — exposure vs reach (PDM-422)
  // -------------------------------------------------------------------------
  //
  // EVERY WITNESS HERE USES `expectOnly`. A fixture that keeps the OTHER
  // declarations resolvable and BOTH compared sets non-empty is what forces the
  // named comparison to actually run — the first version of these probes did
  // neither, fired three unrelated findings, and was green with the comparison
  // it names unreachable behind an early return.
  const REG_OK = [
    'export const MAIL_COMMANDS = {',
    '  send: { contract: mailSendContract, handler: sendHandler },',
    '  inbox: { contract: mailInboxConsumeContract, handler: inboxConsumeHandler },',
    '  ask: { contract: mailAskContract, handler: askHandler },',
    '} as const satisfies Record<string, MailCommand>',
  ].join('\n')
  /** Build a resolvable contract table. Every fixture keeps ALL THREE consts
   *  present, so no totality finding can stand in for the one under test. */
  const contracts = (send: string, inbox: string, ask: string): string =>
    [
      'export const mailSendContract: CommandContract<typeof i> = {',
      "  name: 'mail.send',",
      `  exposure: [${send}],`,
      '}',
      '',
      'export const mailInboxConsumeContract: CommandContract<typeof i> = {',
      "  name: 'mail.inboxConsume',",
      `  exposure: [${inbox}],`,
      '}',
      '',
      'export const mailAskContract: CommandContract<typeof i> = {',
      "  name: 'mail.ask',",
      `  exposure: [${ask}],`,
      '}',
    ].join('\n')
  const CON_OK = contracts(
    "'trpc', 'cli', 'mcp', 'relay'",
    "'trpc', 'relay'",
    "'trpc', 'cli', 'relay'",
  )
  const WHERE = {
    registry: '<probe>/registry',
    contracts: '<probe>/contracts',
    router: '<probe>/router',
  }
  // `ask` is deliberately built in ANOTHER router block — the real shape of
  // `sessions.ask`, and the fixture that fails a `messages:`-scoped reach source.
  const ROUTER_OK = [
    '  sessions: t.router({',
    "    ask: mailMutation('ask'),",
    '  }),',
    '  messages: t.router({',
    "    send: mailMutation('send'),",
    "    inbox: mailMutation('inbox'),",
    '  }),',
  ].join('\n')

  // THE NEGATIVE CONTROL: declared and reached AGREE across two routers, every
  // contract resolves, so the check can say NO.
  expectSilent(
    'exposure-matches-reach/clean',
    exposureMatchesReach(REG_OK, CON_OK, ROUTER_OK, WHERE, ['send']),
  )
  // …and `ask` served ONLY from the sessions router must still be silent. This
  // is the false finding a messages-block-scoped reach source would produce.
  expectSilent(
    'exposure-matches-reach/other-router',
    exposureMatchesReach(
      REG_OK,
      CON_OK,
      [
        "  sessions: t.router({ ask: mailMutation('ask') }),",
        "  messages: t.router({ send: mailMutation('send'), inbox: mailQuery('inbox') }),",
      ].join('\n'),
      WHERE,
      ['send'],
    ),
  )

  // REACHED BUT NOT DECLARED. `send` loses `trpc` while the router still builds
  // it; inbox and ask keep theirs, so declaredTrpc is NON-EMPTY and the loop
  // runs. Exactly one finding, naming `send` and the router.
  expectOnly(
    'exposure-matches-reach/reached-undeclared',
    exposureMatchesReach(
      REG_OK,
      contracts("'cli', 'mcp', 'relay'", "'trpc', 'relay'", "'trpc', 'cli', 'relay'"),
      ROUTER_OK,
      WHERE,
      ['send'],
    ),
    /builds a tRPC procedure for mail `send` but its contract does not declare/,
  )
  // DECLARED BUT NOT REACHED — the router drops `inbox`, everything else agrees.
  expectOnly(
    'exposure-matches-reach/declared-unreached',
    exposureMatchesReach(
      REG_OK,
      CON_OK,
      [
        "  sessions: t.router({ ask: mailMutation('ask') }),",
        "  messages: t.router({ send: mailMutation('send') }),",
      ].join('\n'),
      WHERE,
      ['send'],
    ),
    /mail `inbox` declares the `trpc` transport but no/,
  )
  // A COMMENT quoting a call is not reach: same fixture, `inbox` mounted only in
  // prose, must still report `inbox` as unreached and nothing else.
  expectOnly(
    'exposure-matches-reach/comment-is-not-reach',
    exposureMatchesReach(
      REG_OK,
      CON_OK,
      [
        "// the messages family builds it through mailMutation('inbox')",
        "  sessions: t.router({ ask: mailMutation('ask') }),",
        "  messages: t.router({ send: mailMutation('send') }),",
      ].join('\n'),
      WHERE,
      ['send'],
    ),
    /mail `inbox` declares the `trpc` transport but no/,
  )

  // THE EMPTY-SIDE GUARD, which must fire ONLY as itself.
  expectOnly(
    'exposure-matches-reach/empty',
    exposureMatchesReach(REG_OK, CON_OK, 'nothing reaches anything\n', WHERE, ['send']),
    /one side of the trpc comparison is EMPTY/,
  )
  // A registry that lost its table reports rather than comparing against nothing.
  expectOnly(
    'exposure-matches-reach/no-registry',
    exposureMatchesReach('const nothing = 1\n', CON_OK, ROUTER_OK, WHERE, ['send']),
    /no `MAIL_COMMANDS` table could be read/,
  )

  // -- PARSER SHAPES (PDM-139 §2). Each keeps the other entries valid so the
  //    empty guards stay green and the shape under test is what fires. --------

  // A QUOTED REGISTRY KEY resolves structurally — it must NOT become an
  // `unparsed` finding, and `inbox` must still be compared normally.
  expectSilent(
    'exposure-matches-reach/quoted-key',
    exposureMatchesReach(
      [
        'export const MAIL_COMMANDS = {',
        '  send: { contract: mailSendContract, handler: sendHandler },',
        "  'inbox': { contract: mailInboxConsumeContract, handler: inboxConsumeHandler },",
        '  ask: { contract: mailAskContract, handler: askHandler },',
        '} as const satisfies Record<string, MailCommand>',
      ].join('\n'),
      CON_OK,
      ROUTER_OK,
      WHERE,
      ['send'],
    ),
  )
  // AN ENTRY SHAPE THE PARSER CANNOT RESOLVE must be REPORTED, not skipped. A
  // computed key with no resolvable name is the shape: without the `unparsed`
  // arm it would be absent from the join, absent from declared, absent from
  // reached (the router does not mount it), and therefore invisible.
  expectOnly(
    'exposure-matches-reach/unparsed-entry',
    exposureMatchesReach(
      [
        'export const MAIL_COMMANDS = {',
        '  send: { contract: mailSendContract, handler: sendHandler },',
        '  inbox: { contract: mailInboxConsumeContract, handler: inboxConsumeHandler },',
        '  ask: { contract: mailAskContract, handler: askHandler },',
        '  [COMPUTED]: { contract: mailSmuggledContract, handler: smuggledHandler },',
        '} as const satisfies Record<string, MailCommand>',
      ].join('\n'),
      CON_OK,
      ROUTER_OK,
      WHERE,
      ['send'],
    ),
    /could not be resolved to a key and a contract/,
  )
  // AN EXPOSURE ARRAY CARRYING A SPREAD is unresolvable, not "a tag called
  // ...AGENT_TAGS". If the spread carried `trpc` or `mcp`, the naive parse would
  // drop a real declaration out of the comparison in silence.
  expectOnly(
    'exposure-matches-reach/unresolved-spread',
    exposureMatchesReach(
      REG_OK,
      contracts("'trpc', 'cli', 'mcp', 'relay'", "'trpc', ...AGENT_TAGS", "'trpc', 'cli', 'relay'"),
      ROUTER_OK,
      WHERE,
      ['send'],
    ),
    /contains an element that is not a string literal/,
  )
  // A contract whose `exposure` is a NAMED CELL rather than an inline array is
  // also unresolvable here — this is the issues family's spelling, and reading
  // it as absent would silently drop the entry from both sets.
  expectOnly(
    'exposure-matches-reach/exposure-absent',
    exposureMatchesReach(
      REG_OK,
      [
        CON_OK.slice(0, CON_OK.indexOf('export const mailAskContract')),
        'export const mailAskContract: CommandContract<typeof i> = {',
        "  name: 'mail.ask',",
        '  exposure: SERVED_EVERYWHERE,',
        '}',
      ].join('\n'),
      ROUTER_OK,
      WHERE,
      ['send'],
    ),
    /whose `exposure` cannot be found in/,
  )

  // -- THE `mcp` RECORD, both directions, each isolated. ---------------------
  expectOnly(
    'exposure-matches-reach/mcp-new',
    exposureMatchesReach(REG_OK, CON_OK, ROUTER_OK, WHERE, []),
    /newly declares the `mcp` transport/,
  )
  expectOnly(
    'exposure-matches-reach/mcp-dropped',
    exposureMatchesReach(REG_OK, CON_OK, ROUTER_OK, WHERE, ['send', 'dismiss']),
    /records mail `dismiss` as declaring `mcp` and it no longer does/,
  )
  return failures
}

const PROBE_COUNT = 30

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Agent-mail surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log(`agent-mail surface audit: all ${PROBE_COUNT} probes agreed with their fixtures`)
    return
  }

  const findings = auditMailCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Agent-mail surface audit: ${findings.length} finding(s). The 3.9 cutover's claims are:\n` +
        '  · every mail procedure is DERIVED from its contract (no hand-written procedure)\n' +
        '  · `MessageGate`’s switch and its inline input schemas stay deleted\n' +
        '  · there is ONE authz door — every transport enters through MessageGate.dispatch\n' +
        '  · every mail contract DECLARES its visibility class\n' +
        '  · a command that can WAKE a session declares `machineVerb: use` (POD-1179)\n' +
        '  · the legacy `withMutation` wrapper stays deleted\n' +
        '  · declared `trpc` exposure equals the tRPC call sites in router.ts, both ways; the\n' +
        '    `mcp` declarations match MCP_DECLARED_UNRESOLVED; `cli` is UNVERIFIED and `relay`\n' +
        '    is enforced-by-declaration, neither compared (PDM-422)\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'agent-mail surface audit OK — the derived surface is total, the deleted switch stayed deleted, ' +
      'authz has one door, every contract is classified, every wake path declares that it executes, ' +
      'and declared `trpc` exposure matches the router call sites both ways (cli UNVERIFIED, mcp ' +
      'unresolved by this instrument — see MCP_DECLARED_UNRESOLVED)',
  )
}

if (import.meta.main) main()
