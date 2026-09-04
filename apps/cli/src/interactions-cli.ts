/**
 * `podium interactions list|answer` — THE HEADLESS ANSWERING PATH (POD-2020,
 * spec §4).
 *
 * This is the surface that makes the aggregate's central claim true. §4 says a
 * blocked session is one that is "enumerable, alertable, escalatable after
 * expiresAt, and answerable WITHOUT ATTACHING A TERMINAL" — and a terminal is
 * exactly what an operator on another machine, or a supervising agent, does not
 * have. Two verbs:
 *
 *   podium interactions list [--session <id>] [--json]
 *   podium interactions answer <id> <answer…> [--json]
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER IS FREE TEXT, AND THE SERVER RESOLVES IT
 * ---------------------------------------------------------------------------
 * `answer <id> yes` on a permission ask, `answer <id> 2` or `answer <id> "Use
 * Postgres"` on a question. The CLI does NOT map text to option indices — the
 * server does, against the ask's own recorded options
 * (`modules/interactions/answers.ts`), because that matcher is
 * `matchAnswerToOptions` and a second copy of it here would drift. A refusal
 * comes back naming what it could not match and what the options were, which is
 * the whole reason resolution is server-side rather than a guess made twice.
 *
 * ---------------------------------------------------------------------------
 * EXIT CODES, BECAUSE SCRIPTS BRANCH ON THEM
 * ---------------------------------------------------------------------------
 *   0  answered (or listed)
 *   3  the ask was already answered, or expired — a NO-OP, not a failure. A
 *      supervising loop that raced a human must not treat losing that race as
 *      an error, and this is the code that lets it tell the difference.
 *   1  anything else (unknown id, unresolvable answer, transport failure).
 */

import type { IssueTrpc } from '@podium/issue-client'
import type { PendingInteractionWire } from '@podium/protocol'
import { localServerUrl, resolvePort } from '@podium/runtime/config'
import { makeOperatorIssueClient } from './operator-client'

/** `already-answered` / `expired` — a no-op, distinct from a real failure. */
export const EXIT_SETTLED = 3

export class InteractionsCliError extends Error {}

export interface CliResult {
  text: string
  exitCode: number
  data?: unknown
}

const USAGE = `podium interactions <command>

  list [--session <id>] [--json]      every ask a session is blocked on
  answer <id> <answer…> [--json]      answer one; the server resolves the text
                                      against the ask's own options

Answers by kind:
  permission      allow | always | deny
  question        an option number ("2"), a label, or free text for "Other"
  plan-approval   approve | reject | anything else, taken as redirection
  login           done | cancel
  recovery        full-resume | summary-resume | fresh-session | abandon`

/** One line per ask. Fixed-ish columns so a `grep` over the output is usable. */
function renderRow(row: PendingInteractionWire): string {
  const age = describeAge(row.askedAt)
  // PROVENANCE IS SHOWN, ALWAYS. `screen-classifier` means the ask was scraped:
  // it may be a duplicate of one already answered, and answering it cannot prove
  // it acted on the menu it names. An operator deciding whether to trust a row
  // needs that on the row, not in the docs.
  const trust = row.source === 'screen-classifier' ? ' ~scraped' : ''
  return `${row.id}  ${row.kind.padEnd(13)} ${row.sessionId}  ${age}${trust}  ${summarize(row)}`
}

function describeAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/**
 * The one-line subject.
 *
 * Duplicated from the server's `describeAsk` on purpose rather than shared: the
 * server copy renders for the activity log and this one has to fit a terminal
 * column, and importing an apps/server module into the CLI is a dependency
 * neither package should grow for one string. If a THIRD renderer appears, the
 * vocabulary belongs in `@podium/protocol` beside the schemas.
 */
function summarize(row: PendingInteractionWire): string {
  switch (row.kind) {
    case 'permission':
      return `${row.payload.toolName}${row.payload.inputSummary ? `: ${row.payload.inputSummary}` : ''}`
    case 'question':
      return row.payload.questions
        .map((q) => `${q.question} [${q.options.map((o, i) => `${i + 1}) ${o.label}`).join(' ')}]`)
        .join(' / ')
    case 'plan-approval':
      return (row.payload.plan.split('\n')[0] ?? 'plan awaiting approval').slice(0, 120)
    case 'elicitation':
      return row.payload.message
    case 'login':
      return `${row.payload.provider} (${row.payload.reason})`
    case 'recovery':
      return `${row.payload.prompt} [${row.payload.offered.join(' ')}]`
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new InteractionsCliError(`${flag} needs a value`)
  }
  return value
}

export async function runInteractionsCommand(
  argv: string[],
  client: IssueTrpc,
): Promise<CliResult> {
  const json = argv.includes('--json')
  const command = argv[0]

  if (command === undefined || command === 'help' || command === '--help') {
    return { text: USAGE, exitCode: 0 }
  }

  if (command === 'list') {
    const sessionId = flagValue(argv, '--session')
    const rows = (await client.interactions.list.query(
      sessionId ? { sessionId } : {},
    )) as PendingInteractionWire[]
    if (json) return { text: JSON.stringify(rows, null, 2), exitCode: 0, data: rows }
    if (rows.length === 0) {
      return {
        text: sessionId
          ? `podium: no open interactions on ${sessionId}.`
          : 'podium: no open interactions — nothing is blocked.',
        exitCode: 0,
      }
    }
    return { text: rows.map(renderRow).join('\n'), exitCode: 0, data: rows }
  }

  if (command === 'answer') {
    const id = argv[1]
    if (id === undefined || id.startsWith('--')) {
      throw new InteractionsCliError(
        'answer needs an interaction id — see `podium interactions list`',
      )
    }
    // Everything after the id, minus flags, IS the answer: an operator types
    // `answer ixn_… Use Postgres` without quoting, and refusing that would make
    // the common case the awkward one.
    const text = argv
      .slice(2)
      .filter((a) => !a.startsWith('--'))
      .join(' ')
      .trim()
    if (text === '') {
      throw new InteractionsCliError(
        'answer needs an answer — `podium interactions help` lists the forms per kind',
      )
    }
    const result = (await client.interactions.answer.mutate({ id, text })) as {
      ok: boolean
      reason?: string
      detail?: string
    }
    if (json)
      return { text: JSON.stringify(result, null, 2), exitCode: result.ok ? 0 : 1, data: result }
    if (result.ok) {
      // `detail` on a successful answer means the row was CLAIMED but delivery
      // failed — the honest middle state, and the operator has to see it or they
      // will believe the agent was unblocked when it is still sitting there.
      return result.detail
        ? { text: `podium: recorded — but ${result.detail}`, exitCode: 1, data: result }
        : { text: `podium: answered ${id}.`, exitCode: 0, data: result }
    }
    const settled = result.reason === 'already-answered' || result.reason === 'expired'
    return {
      text: settled
        ? `podium: ${id} is already ${result.reason === 'expired' ? 'expired' : 'answered'} — nothing to do.`
        : `podium: could not answer ${id} — ${result.detail ?? result.reason ?? 'unknown interaction'}`,
      exitCode: settled ? EXIT_SETTLED : 1,
      data: result,
    }
  }

  throw new InteractionsCliError(`unknown command '${command}'\n\n${USAGE}`)
}

/**
 * THE OPERATOR CLIENT, ALWAYS — and the absent relay branch is a decision, not
 * an omission.
 *
 * Every other verb here picks a transport: a constrained agent's calls ride its
 * daemon relay (which applies issue scope), everything else talks to the local
 * server. `interactions` deliberately has no relay arm, because answering a
 * `permission` ask GRANTS A TOOL CALL on somebody else's session. Relaying it
 * would let any agent with a relay socket consent on behalf of any other — the
 * one thing this aggregate must never make easy — and the scope rule that would
 * make it safe ("may this agent answer for that session?") is policy-engine
 * work that spec §4 defers and this item explicitly excludes.
 *
 * So the verb is the operator's. Inside a managed agent session it fails on the
 * missing credential rather than quietly answering with one, which is the
 * correct refusal. Widening this needs `interactions` added to
 * `RELAY_ALLOWED` with a scope gate written for it.
 */
export function buildInteractionsClient(): IssueTrpc {
  return makeOperatorIssueClient(localServerUrl(resolvePort()))
}

export async function interactionsCliMain(argv: string[]): Promise<void> {
  try {
    const result = await runInteractionsCommand(argv, buildInteractionsClient())
    console.log(result.text)
    if (result.exitCode !== 0) process.exitCode = result.exitCode
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`podium interactions: ${message}`)
    process.exitCode = 1
  }
}
