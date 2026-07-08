import {
  AgentStopReport,
  StopAttention,
  StopNeed,
  StopOutcome,
} from '@podium/protocol'

/**
 * `podium report` — the agent declares a structured stop report about the turn it
 * just ended. Rides the daemon's issue-relay loopback (PODIUM_ISSUE_RELAY, bound to
 * the session at spawn); the daemon validates and forwards it as a `sessionReport`
 * frame, the server stores it on the session and the sidebar orders + labels by it.
 *
 * Three orthogonal axes (see docs/spec/agent-self-report.md):
 *   --outcome    done | done_unverified | partial | blocked | failed
 *   --need       none | review | answer | decision | access | external
 *   --attention  blocking | soon | whenever
 *   --summary    one line, user-facing (required)
 *   --options    comma-separated choices (for --need decision; optional)
 *
 * Example:
 *   podium report --outcome partial --need decision --attention soon \
 *     --summary "Migrated 14 tables; billing needs a call before I can merge." \
 *     --options "drop columns now,keep both for a release,ask billing owner"
 */

const USAGE = [
  'usage: podium report --outcome <o> --need <n> --attention <a> --summary "<text>" [--options "a,b,c"]',
  '  --outcome    done | done_unverified | partial | blocked | failed',
  '  --need       none | review | answer | decision | access | external',
  '  --attention  blocking | soon | whenever',
  '  --summary    one line describing why you stopped and what you need (required)',
  '  --options    comma-separated choices, for --need decision (optional)',
].join('\n')

/** Minimal `--flag value` / `--flag=value` parser; last wins. Bare tokens ignored. */
export function parseReportFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t?.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq >= 0) {
      out[t.slice(2, eq)] = t.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next != null && !next.startsWith('--')) {
        out[t.slice(2)] = next
        i++
      } else {
        out[t.slice(2)] = ''
      }
    }
  }
  return out
}

/** Pure argv → a validated AgentStopReport (with a placeholder `at` the server
 *  overwrites), or an error string listing what's wrong. */
export function buildReport(argv: string[], nowIso: string): { report: AgentStopReport } | { error: string } {
  const f = parseReportFlags(argv)
  const errs: string[] = []
  const outcome = StopOutcome.safeParse(f.outcome)
  if (!outcome.success) errs.push(`--outcome must be one of ${StopOutcome.options.join(' | ')}`)
  const need = StopNeed.safeParse(f.need)
  if (!need.success) errs.push(`--need must be one of ${StopNeed.options.join(' | ')}`)
  const attention = StopAttention.safeParse(f.attention)
  if (!attention.success) errs.push(`--attention must be one of ${StopAttention.options.join(' | ')}`)
  const summary = (f.summary ?? '').trim()
  if (!summary) errs.push('--summary is required (one line)')
  if (errs.length > 0) return { error: `${errs.join('\n')}\n\n${USAGE}` }
  const options = (f.options ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const report = AgentStopReport.safeParse({
    outcome: outcome.success ? outcome.data : undefined,
    need: need.success ? need.data : undefined,
    attention: attention.success ? attention.data : undefined,
    summary,
    ...(options.length > 0 ? { options } : {}),
    at: nowIso, // placeholder; the server stamps its own clock on receipt
  })
  if (!report.success) return { error: report.error.issues[0]?.message ?? 'invalid report' }
  return { report: report.data }
}

export async function runReportCli(
  argv: string[],
  opts: { relayEndpoint?: string | undefined; nowIso: string; fetchImpl?: typeof fetch },
): Promise<{ text: string; exitCode: number }> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { text: USAGE, exitCode: argv.length === 0 ? 1 : 0 }
  }
  if (!opts.relayEndpoint) {
    return {
      text: 'podium report: PODIUM_ISSUE_RELAY is not set — this command only works inside a Podium-managed agent session.',
      exitCode: 1,
    }
  }
  const built = buildReport(argv, opts.nowIso)
  if ('error' in built) return { text: `podium report: ${built.error}`, exitCode: 1 }
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(opts.relayEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ router: 'session', proc: 'report', input: built.report }),
    })
    if (!res.ok) return { text: `podium report: relay HTTP ${res.status}`, exitCode: 1 }
    const body = (await res.json()) as { ok: boolean; error?: string }
    if (!body.ok) return { text: `podium report: ${body.error ?? 'relay failed'}`, exitCode: 1 }
    const r = built.report
    return {
      text: `reported: ${r.outcome} · need ${r.need} · ${r.attention} — ${r.summary}`,
      exitCode: 0,
    }
  } catch (err) {
    return { text: `podium report: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 }
  }
}

/** Entry used by scripts/cli.ts. `podium report <flags>` and `podium session report <flags>`
 *  both land here (the `report` sub-verb is stripped by the caller when present). */
export async function sessionReportCliMain(argv: string[]): Promise<void> {
  const out = await runReportCli(argv, {
    relayEndpoint: process.env.PODIUM_ISSUE_RELAY,
    nowIso: new Date().toISOString(),
  })
  ;(out.exitCode === 0 ? console.log : console.error)(out.text)
  if (out.exitCode !== 0) process.exitCode = out.exitCode
}
