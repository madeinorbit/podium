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
 * THE NINE `mcp` DECLARATIONS NO INSTRUMENT CAN CONFIRM OR REFUTE — a FINDING
 * LIST, not a waiver, and the reason it exists is the whole of PDM-422.
 *
 * Nine mail contracts declare `mcp` in their `exposure`. The one MCP surface
 * this server serves is `POST /mcp`, registered in `server.ts` against
 * `superagent.mcpToolSpecs` / `superagent.callMcpTool` — the superagent's TOOL
 * BELT (`modules/superagent/tools.ts`), with the issue tools bridged into it.
 * The belt's own tools do not dispatch a proc NAME: `send_to_agent` and
 * `ask_agent` call `modules.messages.send(…)`, the SERVICE method, directly. So
 * there is no mechanical tool → contract-name mapping to compare a declaration
 * against, and this audit cannot say either "served" or "unserved" about these
 * nine without inventing one.
 *
 * WHAT IS MEASURED, so the next reader does not re-derive it: at this pin, no
 * call site in either repo passes the literal `'mcp'` as the `transport`
 * argument to any exposure check. `isMailProcExposedOn(proc, transport)` — the
 * one runtime reader of this family's `exposure`, called from `gate.ts` — is
 * reached only with `'trpc'` (the router) and `'relay'` (the relay dispatch and
 * the default). Every other occurrence of the tag is a declaration, a member of
 * a `TransportTag`-style union, a BAN-list entry (`AGENT_TRANSPORTS` in
 * `modules/automations/trpc.ts`), or a doc comment describing a plant.
 *
 * So the honest statement about these nine is neither "decoration" nor "an open
 * door": the tag is UNCONSULTED on the transport it names, and the transport it
 * names reaches this family by a path that does not ask. Both halves are worth
 * a human deciding about, and neither is something this script may decide.
 *
 * THE LIST IS ASSERTED IN BOTH DIRECTIONS below. A tenth contract growing an
 * `mcp` tag reddens this audit, and so does one of these nine losing it — the
 * second is the direction that matters, because a correct future repair should
 * arrive as a reviewed edit here rather than as a silently shrinking list.
 */
export const MCP_DECLARED_UNVERIFIED: readonly string[] = [
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
 *
 * `served-route-census.ts` classifies `POST /mcp` as a `bridge` that "dispatches
 * into the superagent's tool belt, which bridges the ISSUE COMMAND REGISTRY".
 * That is true of the bridged half and says nothing about the belt's ~24 OWN
 * tools, which are hand-written in `modules/superagent/tools.ts`, reach services
 * directly, and belong to no command registry. Two of them reach this family.
 */
export const UNCENSUSED_MCP_SUB_TRANSPORT = {
  name: 'superagent tool belt (modules/superagent/tools.ts)',
  why:
    "The MCP surface's population is the belt's own hand-written tool specs plus the bridged issue " +
    'tools. A belt tool calls a SERVICE METHOD, not a named proc, so no tool → contract-name mapping ' +
    'exists and no population of mail procs can be derived from it. A runtime recorder over the belt ' +
    'is branch-sensitive and under-reports, which is why this audit reads source text and records the ' +
    'hole instead of guessing at it.',
} as const

/**
 * Registry key → contract const, read out of `MAIL_COMMANDS`.
 *
 * The join is read rather than restated because the two sides spell a command
 * differently: the registry keys on the BARE wire name (`inbox`) and the
 * contract carries the dotted identity (`mail.inboxConsume`). A check that
 * mapped one to the other by string munging would be inventing the seam that
 * this table already is.
 */
export function mailRegistryJoin(registrySource: string): Map<string, string> {
  const out = new Map<string, string>()
  const block = /export const MAIL_COMMANDS = \{([\s\S]*?)\n\} as const/.exec(registrySource)
  if (!block) return out
  for (const m of (block[1] as string).matchAll(/^\s*(\w+):\s*\{[^}]*?contract:\s*(\w+)/gm)) {
    out.set(m[1] as string, m[2] as string)
  }
  return out
}

/**
 * Contract const → its declared transport tags.
 *
 * Reads the INLINE ARRAY form (`exposure: ['trpc', 'cli', 'mcp', 'relay']`),
 * which is how this family declares and which the issues-family instrument
 * cannot parse at all: `audit-issue-commands.ts` reads `exposure: (\w+),` — a
 * named CELL such as `SERVED_EVERYWHERE`. Pointing that regex at this file would
 * have resolved an exposure for nothing and compared two empty sets. One
 * declaration at a time, for the POD-1314 reason the issues instrument records.
 */
export function mailExposureByConst(contractsSource: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of contractsSource.matchAll(/export const (\w+)[^=]*=\s*\{([\s\S]*?)\n\}/g)) {
    const tags = /^\s*exposure: \[([^\]]*)\]/m.exec(m[2] as string)
    if (!tags) continue
    out.set(
      m[1] as string,
      (tags[1] as string)
        .split(',')
        .map((t) => t.trim().replace(/^'|'$/g, ''))
        .filter((t) => t.length > 0),
    )
  }
  return out
}

/**
 * Every mail proc the tRPC surface actually serves.
 *
 * THE REACH SOURCE IS EVERY `mailMutation(`/`mailQuery(` CALL IN `router.ts`,
 * AND NOT THE `messages:` ROUTER BLOCK — this is the negative control that makes
 * the check trustworthy rather than the obvious implementation. `mail.ask` is
 * served as `sessions.ask`, built by `mailMutation('ask')` inside the SESSIONS
 * router, because the question a session asks its operator is a session-surface
 * verb wearing a mail contract. A reach source scoped to the `messages:` block
 * would report `mail.ask` as "declares trpc but nothing reaches it" — a false
 * finding about a proc that is served, produced by an instrument that looked in
 * one router because one router was where it expected the family to live.
 */
export function trpcReach(routerSource: string): Set<string> {
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
 * ONLY `trpc` IS COMPARED, and the other three tags are accounted for rather
 * than quietly skipped, which is the distinction this whole audit turns on:
 *
 *   · `trpc` — the reach is a static set of `mailMutation`/`mailQuery` calls in
 *     `router.ts`. Derivable from source text, so it is compared.
 *   · `relay` and `cli` — `relay-dispatch.ts` passes a RUNTIME proc string
 *     straight to `MessageGate.dispatch`, so any name can arrive and `exposure`
 *     IS the door rather than a claim about one. There is no second set to
 *     compare against; the declaration is the enforcement.
 *   · `mcp` — no tool → proc-name mapping exists at all. See
 *     {@link MCP_DECLARED_UNVERIFIED} and {@link UNCENSUSED_MCP_SUB_TRANSPORT}.
 */
export function exposureMatchesReach(
  registrySource: string,
  contractsSource: string,
  routerSource: string,
  where: { registry: string; contracts: string; router: string },
  /** Taken as a PORT so `--probe` can plant its own reviewed list. Defaulting it
   *  here rather than at the call site keeps the gate reading the real record. */
  recordedMcp: readonly string[] = MCP_DECLARED_UNVERIFIED,
): Finding[] {
  const findings: Finding[] = []
  const join = mailRegistryJoin(registrySource)
  const exposure = mailExposureByConst(contractsSource)

  if (join.size === 0) {
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

  // TOTALITY FIRST. A key whose exposure cannot be resolved would drop silently
  // out of every set below and be reported as neither declared nor reached —
  // the shape that let POD-1314 swallow a real declaration.
  const declaredOn = (tag: string): Set<string> => {
    const out = new Set<string>()
    for (const [key, constName] of join) {
      if (exposure.get(constName)?.includes(tag)) out.add(key)
    }
    return out
  }
  for (const [key, constName] of join) {
    if (exposure.get(constName) === undefined) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `\`${key}\` joins \`${constName}\`, whose \`exposure\` cannot be read from ${where.contracts} ` +
          '— an unreadable declaration silently leaves this comparison rather than failing it',
      })
    }
  }

  const declaredTrpc = declaredOn('trpc')
  const reached = trpcReach(routerSource)
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

  // THE `mcp` ARM. Not a comparison against a served set — there is none to
  // derive — but against the reviewed list, in both directions.
  const declaredMcp = declaredOn('mcp')
  const recorded = new Set(recordedMcp)
  for (const proc of [...declaredMcp].sort()) {
    if (!recorded.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `mail \`${proc}\` newly declares the \`mcp\` transport. No instrument can confirm that ` +
          `claim: the MCP surface is the ${UNCENSUSED_MCP_SUB_TRANSPORT.name}, whose tools call ` +
          'service methods rather than named procs. Read it, decide whether the tag is true, and ' +
          'record it in MCP_DECLARED_UNVERIFIED',
      })
    }
  }
  for (const proc of [...recorded].sort()) {
    if (!declaredMcp.has(proc)) {
      findings.push({
        check: 'exposure-matches-reach',
        where: where.contracts,
        detail:
          `MCP_DECLARED_UNVERIFIED records mail \`${proc}\` as declaring \`mcp\` and it no longer ` +
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
  // The fixtures below carry their OWN reviewed `mcp` list, so an `mcp` arm that
  // fired on every fixture (the real list naming nine procs no fixture contains)
  // could not hide a trpc regression behind nine spurious findings.
  const REG_OK = [
    'export const MAIL_COMMANDS = {',
    '  send: { contract: mailSendContract, handler: sendHandler },',
    '  inbox: { contract: mailInboxConsumeContract, handler: inboxConsumeHandler },',
    '  ask: { contract: mailAskContract, handler: askHandler },',
    '} as const satisfies Record<string, MailCommand>',
  ].join('\n')
  const CON_OK = [
    'export const mailSendContract: CommandContract<typeof i> = {',
    "  name: 'mail.send',",
    "  exposure: ['trpc', 'cli', 'mcp', 'relay'],",
    '}',
    '',
    'export const mailInboxConsumeContract: CommandContract<typeof i> = {',
    "  name: 'mail.inboxConsume',",
    "  exposure: ['trpc', 'relay'],",
    '}',
    '',
    'export const mailAskContract: CommandContract<typeof i> = {',
    "  name: 'mail.ask',",
    "  exposure: ['trpc', 'cli', 'relay'],",
    '}',
  ].join('\n')
  const WHERE = {
    registry: '<probe>/registry',
    contracts: '<probe>/contracts',
    router: '<probe>/router',
  }
  // `ask` is deliberately built in ANOTHER router block here — this is the real
  // shape of `sessions.ask`, and it is the fixture that fails a reach source
  // scoped to the `messages:` literal.
  const ROUTER_OK = [
    '  sessions: t.router({',
    "    ask: mailMutation('ask'),",
    '  }),',
    '  messages: t.router({',
    "    send: mailMutation('send'),",
    "    inbox: mailMutation('inbox'),",
    '  }),',
  ].join('\n')

  // THE NEGATIVE CONTROL, and the reason this check is trustworthy: declared and
  // reached AGREE here, across two routers, so the check can say NO.
  expectSilent(
    'exposure-matches-reach/clean',
    exposureMatchesReach(REG_OK, CON_OK, ROUTER_OK, WHERE, ['send']),
  )
  // …and the same fixture with `ask` served only from the sessions router must
  // still be silent, which is the false finding a messages-block-scoped reach
  // source would produce (`mail.ask` declares trpc and IS served).
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
  // A comment MENTIONING a call must not count as reach — the router documents
  // its own derivation by quoting `mailMutation('ask')` in prose.
  expect(
    'exposure-matches-reach/declared-unreached',
    exposureMatchesReach(
      REG_OK,
      CON_OK,
      [
        "// the sessions family builds `ask` through mailMutation('ask')",
        "  messages: t.router({ send: mailMutation('send'), inbox: mailQuery('inbox') }),",
      ].join('\n'),
      WHERE,
      ['send'],
    ),
  )
  expect(
    'exposure-matches-reach/reached-undeclared',
    exposureMatchesReach(
      REG_OK,
      [
        'export const mailSendContract: CommandContract<typeof i> = {',
        "  name: 'mail.send',",
        "  exposure: ['relay'],",
        '}',
      ].join('\n'),
      "  messages: t.router({ send: mailMutation('send') }),",
      WHERE,
      [],
    ),
  )
  // A registry that lost its table reports, rather than comparing against nothing.
  expect(
    'exposure-matches-reach/no-registry',
    exposureMatchesReach('const nothing = 1\n', CON_OK, ROUTER_OK, WHERE, ['send']),
  )
  // A key whose contract exposure cannot be READ leaves the comparison silently
  // unless this fires — the POD-1314 shape, in this family's spelling.
  expect(
    'exposure-matches-reach/unreadable-exposure',
    exposureMatchesReach(
      REG_OK,
      [
        'export const mailSendContract: CommandContract<typeof i> = {',
        "  name: 'mail.send',",
        "  exposure: ['trpc'],",
        '}',
      ].join('\n'),
      "  messages: t.router({ send: mailMutation('send') }),",
      WHERE,
      ['send'],
    ),
  )
  // The empty-side guard: an equality between empty sets is not evidence.
  expect(
    'exposure-matches-reach/empty',
    exposureMatchesReach(REG_OK, CON_OK, 'nothing reaches anything\n', WHERE, ['send']),
  )
  // BOTH DIRECTIONS OF THE `mcp` RECORD. A tenth contract growing the tag…
  expect(
    'exposure-matches-reach/mcp-new',
    exposureMatchesReach(REG_OK, CON_OK, ROUTER_OK, WHERE, []),
  )
  // …and a recorded one losing it, which is the direction a silent repair takes.
  expect(
    'exposure-matches-reach/mcp-dropped',
    exposureMatchesReach(REG_OK, CON_OK, ROUTER_OK, WHERE, ['send', 'dismiss']),
  )
  return failures
}

const PROBE_COUNT = 26

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
        '  · declared `trpc` exposure equals what router.ts reaches, both ways; and the `mcp`\n' +
        '    declarations match MCP_DECLARED_UNVERIFIED, the reviewed record of the tags no\n' +
        '    instrument can confirm (PDM-422)\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'agent-mail surface audit OK — the derived surface is total, the deleted switch stayed deleted, ' +
      'authz has one door, every contract is classified, every wake path declares that it executes, ' +
      'and declared exposure matches reach on every transport a reach can be derived for',
  )
}

if (import.meta.main) main()
