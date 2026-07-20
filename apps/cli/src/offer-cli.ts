/**
 * `podium offer` — the agent action offer CLI [spec:SP-c7f1].
 *
 *   offer --message "…" [--action "Label::Prompt" ...]   set (replace) the offer
 *   offer clear                                            remove the offer
 *
 * An offer is a session-scoped suggestion an agent leaves for the user: one
 * freeform message plus zero..N action buttons. Each button carries an
 * agent-authored prompt; clicking it in the web app sends that prompt into the
 * session as a normal user turn. A subsequent `offer` replaces the previous one;
 * the offer also clears automatically on the next user-submitted turn.
 *
 * The offer ALWAYS attaches to the CALLING session — it is identified by the
 * daemon agent relay (PODIUM_AGENT_RELAY), never by a flag — so this command is
 * only meaningful from inside a Podium-managed agent session.
 *
 * Speaks to the `offer` relay router (composed in apps/server/src/relay.ts).
 */

import { makeRelayIssueClient } from '@podium/issue-client'
import { resolveAgentRelay } from '@podium/runtime/config'

type OfferProc = {
  mutate(input?: unknown): Promise<unknown>
  query(input?: unknown): Promise<unknown>
}

export interface OfferClient {
  offer: {
    set: OfferProc
    clear: OfferProc
  }
}

export class OfferCliError extends Error {}

/** One action button parsed from a `--action`/`--action-input` token. */
export interface ParsedAction {
  label: string
  prompt: string
  /** True for `--action-input`: the UI collects freeform user feedback before
   *  sending, appended to the prompt. */
  input?: boolean
}

const BOOL_FLAGS = new Set(['json', 'outside-scope', 'help'])

/**
 * Parse `podium offer` argv. Unlike the mail parser, `--action` (and its
 * feedback-collecting twin `--action-input`) REPEATS — each occurrence appends
 * a button, in argv order — while every other flag keeps last-wins semantics.
 */
export function parseOfferArgs(argv: string[]): {
  command?: string
  args: Record<string, string | boolean>
  actions: { token: string; input: boolean }[]
  positionals: string[]
} {
  const args: Record<string, string | boolean> = {}
  const actions: { token: string; input: boolean }[] = []
  const positionals: string[] = []
  // A bare first token that isn't a flag is the sub-command (e.g. `clear`).
  let command: string | undefined
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('--')) command = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token?.startsWith('--')) {
      if (token !== undefined) positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    let value: string | boolean
    if (eq >= 0) {
      value = token.slice(eq + 1)
    } else {
      const next = rest[i + 1]
      if (BOOL_FLAGS.has(key) || next === undefined || next.startsWith('--')) value = true
      else {
        value = next
        i++
      }
    }
    if (key === 'action' || key === 'action-input') {
      if (typeof value === 'string') actions.push({ token: value, input: key === 'action-input' })
      continue
    }
    args[key] = value
  }
  return { ...(command ? { command } : {}), args, actions, positionals }
}

/** Split a `Label::Prompt` token. The FIRST `::` separates them, so a prompt may
 *  itself contain `::`. Both halves must be non-empty. */
export function parseAction(token: string, input = false): ParsedAction {
  const sep = token.indexOf('::')
  if (sep < 0) {
    throw new OfferCliError(
      `--action "${token}" must be "Label::Prompt" (a label, then ::, then the prompt to send)`,
    )
  }
  const label = token.slice(0, sep).trim()
  const prompt = token.slice(sep + 2).trim()
  if (!label) throw new OfferCliError(`--action "${token}" has an empty label`)
  if (!prompt) throw new OfferCliError(`--action "${token}" has an empty prompt`)
  return input ? { label, prompt, input: true } : { label, prompt }
}

function helpText(): string {
  return [
    'podium offer <command> [arguments]',
    '',
    'Leave the user a suggested-next-action bar on THIS session: a short message',
    'plus zero or more buttons. Each button sends its predefined prompt into the',
    'session as a normal turn when clicked. Use it at the END of a turn when there',
    'are natural next actions the user might pick. A new offer replaces the old one,',
    'and any user turn (including a button click) clears it.',
    '',
    '  --message "…"            The freeform message shown above the buttons (required to set).',
    '  --action "Label::Prompt" A button: its label, then ::, then the prompt sent on click.',
    '                           Repeat --action for more buttons (up to 6).',
    '  --action-input "Label::Prompt"',
    '                           Like --action, but clicking first asks the user for freeform',
    '                           feedback, appended to the prompt. Use it for actions that only',
    '                           make sense with an explanation (e.g. "Send back").',
    '  clear                    Remove the current offer.',
    '',
    'Examples:',
    '  podium offer --message "Tests are red on main" \\',
    '    --action "Fix them::Please fix the failing tests" \\',
    '    --action "Show failures::Show me the failing test output"',
    '  podium offer --message "POD-12 is ready for review" \\',
    '    --action "Merge it::Merge POD-12 to main" \\',
    '    --action-input "Send back::Revise POD-12 per this feedback:"',
    '  podium offer clear',
  ].join('\n')
}

export async function runOfferCli(argv: string[], client: OfferClient): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return helpText()
  const { command, args, actions } = parseOfferArgs(argv)
  const known = new Set(['message', 'json', 'outside-scope'])
  const unknown = Object.keys(args).filter((k) => !known.has(k))
  if (unknown.length) {
    throw new OfferCliError(
      `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown
        .map((k) => `--${k}`)
        .join(', ')} (see \`podium offer --help\`)`,
    )
  }
  const asJson = args.json === true
  const done = (text: string, data: unknown): string =>
    asJson ? JSON.stringify({ command: command ?? 'set', ok: true, data }) : text

  if (command === 'help') return helpText()

  if (command === 'clear') {
    const r = await client.offer.clear.mutate({})
    return done('offer cleared', r)
  }

  // No sub-command (or an unknown one) → set. A stray positional command that
  // isn't `clear`/`help` is a mistake worth flagging rather than silently setting.
  if (command && command !== 'set') {
    throw new OfferCliError(`unknown command: ${command}\n\n${helpText()}`)
  }

  const message = args.message
  if (typeof message !== 'string' || !message.trim()) {
    throw new OfferCliError('offer needs --message "…" (or use `podium offer clear`)')
  }
  if (actions.length > 6) throw new OfferCliError('at most 6 --action buttons are allowed')
  const parsed = actions.map((a) => parseAction(a.token, a.input))
  const r = (await client.offer.set.mutate({ message: message.trim(), actions: parsed })) as {
    ok: boolean
    reason?: string
  }
  if (!r.ok) throw new OfferCliError(r.reason ?? 'offer was not accepted')
  const note = parsed.length
    ? `${parsed.length} action${parsed.length > 1 ? 's' : ''}`
    : 'no actions'
  return done(`offer set (${note})`, r)
}

export async function offerCliMain(argv: string[]): Promise<void> {
  // Help renders without a relay/server (and without a calling session).
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(helpText())
    return
  }
  const relay = resolveAgentRelay()
  if (!relay) {
    const message =
      'podium offer is only available inside a Podium-managed agent session ' +
      '(PODIUM_AGENT_RELAY is unset).'
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium offer: ${message}`)
    process.exitCode = 1
    return
  }
  const outsideScope = argv.includes('--outside-scope')
  const client = makeRelayIssueClient(relay, { outsideScope }) as unknown as OfferClient
  try {
    console.log(await runOfferCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium offer: ${message}`)
    process.exitCode = 1
  }
}
