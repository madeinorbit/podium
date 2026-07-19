/**
 * `podium agent` — cross-harness subagent spawn + bounded await (#237)
 * [spec:SP-34d7 cross-harness]:
 *   spawn --harness <claude-code|codex|...> (--issue <ref> | --new "title" [--repo <path>])
 *         --prompt "…" [--title "…"] [--worktree] [--model M] [--effort E]
 *         [--workflow-run-id X] [--workflow-step-id Y] [--execution-profile-id Z]
 *   await <sessionId> [--timeout <seconds>]
 *
 * The child is a FULL Podium session (real PTY, visible in the UI, human-
 * attachable) spawned on the target issue; the caller becomes its parent
 * (spawnedBy provenance → parent-grade clamps: interrupt + wake). Drive the
 * child with ordinary `podium mail send`; `await` is BOUNDED — it returns the
 * child's ack/settle result or "still working" + a status snapshot, never hangs.
 * The workflow flags are #285 pass-through metadata (uninterpreted).
 * `--title` is the spawner-prescribed child session name [spec:SP-4ef9][spec:SP-eb60]
 * (curated name slot); distinct from `--new "title"` which names the ISSUE.
 */

import { makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'
import { resolveAgentRelay, resolvePort } from '@podium/runtime/config'
import { MailCliError, parseMailArgs } from './mail-cli'

type Proc = { mutate(input?: unknown): Promise<unknown> }

export interface AgentClient {
  messages: {
    spawnAgent: Proc
    awaitAgent: Proc
  }
}

function helpText(): string {
  return [
    'podium agent <command> [arguments]',
    '',
    '  spawn --prompt "…" (--issue <ref> | --new "title" [--repo <path>])',
    '        [--title "…"] [--harness <claude-code|codex|grok|opencode|cursor>]',
    '        [--worktree] [--model M] [--effort E] [--force-unknown-model]',
    '        [--workflow-run-id X] [--workflow-step-id Y] [--execution-profile-id Z]',
    '      Spawn a full Podium agent session on an issue; the prompt is its first',
    '      turn and you become its parent (interrupt + wake rights). An issue is',
    '      never created implicitly — --new is the explicit create path.',
    '      --title names the child session (sidebar label) at spawn; omit to let',
    '      the child self-title. --new names the ISSUE, not the session.',
    '      --model/--effort are checked against the live model catalog; pass',
    '      --force-unknown-model to spawn a deliberately unlisted model slug.',
    '  await <sessionId> [--timeout <seconds, default 30, max 300>]',
    '      Bounded wait: returns the child\'s ack or settle state, or "still',
    '      working" plus a status snapshot at the deadline. Never hangs.',
    '',
    'Drive a running child with `podium mail send --to <sessionId> …`;',
    'cancel = `podium mail send --urgency interrupt` (parent-grade).',
  ].join('\n')
}

export async function runAgentCli(argv: string[], client: AgentClient): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return helpText()
  const { command, args, positionals } = parseMailArgs(argv)
  if (!command || command === 'help') return helpText()
  const asJson = args.json === true
  const done = (text: string, data: unknown): string =>
    asJson ? JSON.stringify({ command, ok: true, data }) : text

  switch (command) {
    case 'spawn': {
      const known = new Set([
        'harness',
        'issue',
        'new',
        'repo',
        'prompt',
        'title',
        'worktree',
        'model',
        'effort',
        'force-unknown-model',
        'workflow-run-id',
        'workflow-step-id',
        'execution-profile-id',
        'json',
        'outside-scope',
      ])
      const unknown = Object.keys(args).filter((k) => !known.has(k))
      if (unknown.length) {
        throw new MailCliError(
          `unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `--${k}`).join(', ')} (see \`podium agent --help\`)`,
        )
      }
      const prompt = args.prompt
      if (typeof prompt !== 'string' || !prompt) throw new MailCliError('spawn needs --prompt')
      if (typeof args.issue !== 'string' && typeof args.new !== 'string') {
        throw new MailCliError('spawn needs --issue <ref> or --new "title"')
      }
      const r = (await client.messages.spawnAgent.mutate({
        prompt,
        ...(typeof args.issue === 'string' ? { issue: args.issue } : {}),
        ...(typeof args.new === 'string' ? { newTitle: args.new } : {}),
        ...(typeof args.repo === 'string' ? { repo: args.repo } : {}),
        ...(typeof args.harness === 'string' ? { harness: args.harness } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(args.worktree === true ? { worktree: true } : {}),
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.effort === 'string' ? { effort: args.effort } : {}),
        ...(args['force-unknown-model'] === true ? { force: true } : {}),
        ...(typeof args['workflow-run-id'] === 'string'
          ? { workflowRunId: args['workflow-run-id'] }
          : {}),
        ...(typeof args['workflow-step-id'] === 'string'
          ? { workflowStepId: args['workflow-step-id'] }
          : {}),
        ...(typeof args['execution-profile-id'] === 'string'
          ? { executionProfileId: args['execution-profile-id'] }
          : {}),
      })) as {
        ok: boolean
        sessionId: string
        issueId: string
        issueSeq: number
        cwd: string
        agentId: string
        harness: string
        model: string | null
        effort: string | null
        machine: string | null
      }
      return done(
        `spawned ${r.agentId} on issue #${r.issueSeq} (${r.cwd})\n` +
          `  harness=${r.harness} model=${r.model ?? 'default'} effort=${r.effort ?? 'default'} machine=${r.machine ?? 'unknown'}\n` +
          `  drive:  podium mail send --to ${r.sessionId} --body "…"\n` +
          `  await:  podium agent await ${r.sessionId}`,
        r,
      )
    }
    case 'await': {
      const sessionId = positionals[0]
      if (!sessionId) throw new MailCliError('await needs a session id')
      const timeout = typeof args.timeout === 'string' ? Number(args.timeout) : undefined
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0 || timeout > 300)) {
        throw new MailCliError('--timeout must be 0-300 seconds')
      }
      const r = (await client.messages.awaitAgent.mutate({
        sessionId,
        ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
      })) as {
        done: boolean
        result: string
        ack?: { id: string; body: string }
        snapshot?: {
          status?: string
          phase?: string
          need?: { kind?: string; summary?: string }
          error?: { class?: string; retryable?: boolean }
        } | null
      }
      const state = r.snapshot
        ? `${r.snapshot.status}${r.snapshot.phase ? `/${r.snapshot.phase}` : ''}`
        : ''
      if (r.result === 'acked' && r.ack) {
        return done(`acked (${r.ack.id}): ${r.ack.body}`, r)
      }
      // Actionable terminal states — parent must see blocked vs done vs gone
      // at a glance (docs/agent-comms-target.html §09-D overnight-stall fix).
      if (r.result === 'blocked') {
        const phase = r.snapshot?.phase
        if (phase === 'errored') {
          const err = r.snapshot?.error
          const detail = err?.class
            ? `${err.class}${err.retryable ? ' (retryable)' : ''}`
            : 'errored'
          return done(`blocked: child errored — ${detail}${state ? ` [${state}]` : ''}`, r)
        }
        const need = r.snapshot?.need
        const detail = need?.summary
          ? need.summary
          : need?.kind === 'permission'
            ? 'needs permission'
            : 'needs a question answered'
        return done(`blocked: ${detail}${state ? ` [${state}]` : ''}`, r)
      }
      if (r.result === 'done') {
        return done(`done${state ? ` (${state})` : ''}`, r)
      }
      if (r.result === 'gone') {
        if (!r.snapshot) return done('gone: session no longer exists', r)
        return done(`gone (exited without reporting)${state ? ` [${state}]` : ''}`, r)
      }
      // working (or unknown) — only "still working" when truly still active
      return done(`still working (${state}) — re-run await or read status`, r)
    }
    default:
      throw new MailCliError(`unknown command: ${command}\n\n${helpText()}`)
  }
}

export async function agentCliMain(argv: string[]): Promise<void> {
  const relay = resolveAgentRelay()
  const outsideScope = argv.includes('--outside-scope')
  const client = (relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(`http://localhost:${resolvePort()}`)) as unknown as AgentClient
  try {
    console.log(await runAgentCli(argv, client))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`podium agent: ${message}`)
    process.exitCode = 1
  }
}
