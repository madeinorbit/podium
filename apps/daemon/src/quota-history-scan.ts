/**
 * RECOVERING QUOTA HISTORY FROM HARNESS FILES ON THIS MACHINE.
 *
 * Podium keeps no record of past quota windows, so the ledger would ordinarily
 * start empty on the day the sampler first runs. For two of the three harnesses
 * it does not have to: they write their own rate-limit state to disk as a side
 * effect of doing other things, and those files go back weeks.
 *
 *  - CODEX writes a `token_count` event into every session rollout, carrying the
 *    full `rate_limits` object. Measured on one machine: 89,843 samples across
 *    1,062 files, back to 2026-07-14. This is the rich one.
 *  - GROK logs each billing fetch verbatim into `~/.grok/logs/unified.jsonl`.
 *    Measured: 66 samples over 11 days — sparse, but it includes a clean reset
 *    (93% → 12%). That file is UNROTATED, so its history is lost when it rolls;
 *    capturing it is worth more today than later.
 *  - CLAUDE writes nothing. Its usage endpoint is read live and cached nowhere,
 *    by Podium or by Claude Code. Its history genuinely starts empty.
 *
 * THIS RUNS ON THE DAEMON because the files are on the machine the harness runs
 * on, exactly like `usage-scan.ts`. Samples go up the wire and are folded by the
 * server through the SAME identity rule live sampling uses — the fold is shared
 * code in `@podium/model` precisely so a recovered window and an observed one
 * cannot disagree about where a window's boundaries are.
 */

import type { Dirent } from 'node:fs'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { QuotaHistorySampleWire } from '@podium/protocol'

/**
 * Drop readings that repeat the one before them, keeping every transition.
 *
 * A harness reports the same `used_percent` on every turn of a quiet stretch, so
 * the raw stream is overwhelmingly duplicates — measured on Codex, 89,843 events
 * carry roughly 7,400 actual changes. Only movements need to cross the wire; the
 * fold reconstructs the flat stretches between them.
 *
 * Comparison is against the PREVIOUS EMITTED sample, per window key. The streams
 * are interleaved by time, so a per-key predecessor would be the right unit if a
 * harness ever reported two windows at once; today each scanned harness emits a
 * single key, and the guard below keeps the two cases from merging.
 */
function dedupeConsecutive(samples: QuotaHistorySampleWire[]): QuotaHistorySampleWire[] {
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs)
  const out: QuotaHistorySampleWire[] = []
  for (const sample of sorted) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.windowKey === sample.windowKey &&
      prev.usedPercent === sample.usedPercent &&
      prev.plan === sample.plan &&
      // Keep a sample that crosses a reset even when the percentage matches, or
      // two adjacent windows that both sat at 0% would merge into one.
      Math.abs(prev.resetsAtMs - sample.resetsAtMs) < 60_000
    ) {
      continue
    }
    out.push(sample)
  }
  return out
}

interface CodexRateLimitWindow {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * One `token_count` event's `rate_limits` block.
 *
 * The rollout's key names differ from the app-server shape `quota-codex.ts`
 * consumes (`primary` vs `primary_window`, `window_minutes` vs
 * `limit_window_seconds`) while carrying the identical upstream numbers, so this
 * is a rename and a unit change, not a second source of truth.
 *
 * `resets_at` is EPOCH SECONDS here.
 */
export function codexSamplesFromEvent(
  payload: unknown,
  accountKeyEmail: string | undefined,
  machineId: string,
  atMs: number,
): QuotaHistorySampleWire[] {
  if (!payload || typeof payload !== 'object') return []
  // `rate_limits` sits beside `info` on the payload, not inside it — verified
  // against real rollouts. Both are read anyway: the sibling `info` block has
  // moved between Codex versions before, and reading either costs nothing.
  const p = payload as { rate_limits?: unknown; info?: { rate_limits?: unknown } }
  const limits = p.rate_limits ?? p.info?.rate_limits
  if (!limits || typeof limits !== 'object') return []
  const l = limits as {
    primary?: CodexRateLimitWindow
    secondary?: CodexRateLimitWindow
    plan_type?: unknown
  }
  const plan = typeof l.plan_type === 'string' ? l.plan_type : undefined
  const out: QuotaHistorySampleWire[] = []
  // `secondary` was null in every one of the 89,843 measured rows — this account
  // gets no Codex 5-hour window — but the shape allows one, so both are read.
  for (const [slot, window] of [
    ['primary', l.primary],
    ['secondary', l.secondary],
  ] as const) {
    if (!window || typeof window !== 'object') continue
    const usedPercent = num(window.used_percent)
    const resetsAtSec = num(window.resets_at)
    const windowMinutes = num(window.window_minutes) ?? 0
    if (usedPercent === undefined || resetsAtSec === undefined) continue
    // Classify by the provider's own duration, matching quota-codex.ts, rather
    // than by slot: Codex sometimes reports only the weekly limit, as primary.
    const key = windowMinutes >= 1440 ? 'weekly' : windowMinutes > 0 ? '5h' : slot
    out.push({
      agent: 'codex',
      ...(accountKeyEmail ? { email: accountKeyEmail } : {}),
      machineId,
      windowKey: key,
      label: key === 'weekly' ? 'Weekly' : '5-hour',
      ...(plan ? { plan } : {}),
      usedPercent,
      resetsAtMs: resetsAtSec * 1000,
      windowMinutes,
      atMs,
    })
  }
  return out
}

async function readCodexRollout(
  path: string,
  email: string | undefined,
  machineId: string,
): Promise<QuotaHistorySampleWire[]> {
  const out: QuotaHistorySampleWire[] = []
  // Rollouts run to hundreds of megabytes across a fleet of sessions; streaming
  // keeps peak memory flat where readFile would not.
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes('rate_limits')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const rec = parsed as { timestamp?: unknown; type?: unknown; payload?: unknown }
      if (rec.type !== 'event_msg') continue
      const atMs = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
      if (!Number.isFinite(atMs)) continue
      out.push(...codexSamplesFromEvent(rec.payload, email, machineId, atMs))
    }
  } finally {
    rl.close()
  }
  return out
}

async function collectRollouts(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // no Codex installation on this box, or an unreadable subtree
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectRollouts(path, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
}

async function codexAccountEmail(homeDir: string): Promise<string | undefined> {
  try {
    const auth: unknown = JSON.parse(await readFile(join(homeDir, '.codex', 'auth.json'), 'utf8'))
    const tokens = (auth as { tokens?: { id_token?: unknown } }).tokens
    const idToken = tokens?.id_token
    if (typeof idToken !== 'string') return undefined
    const body = idToken.split('.')[1]
    if (!body) return undefined
    const claims: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    const email = (claims as { email?: unknown }).email
    return typeof email === 'string' ? email : undefined
  } catch {
    // No readable auth, or a token shape we don't recognise. The sample still
    // lands, keyed by machine instead of account — see quotaAccountKey.
    return undefined
  }
}

export async function scanCodexQuotaHistory(opts: {
  sinceMs: number
  machineId: string
  homeDir?: string
}): Promise<QuotaHistorySampleWire[]> {
  const home = opts.homeDir ?? homedir()
  const email = await codexAccountEmail(home)
  const files: string[] = []
  await collectRollouts(join(home, '.codex', 'sessions'), files)
  const samples: QuotaHistorySampleWire[] = []
  for (const path of files) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < opts.sinceMs) continue
      samples.push(...(await readCodexRollout(path, email, opts.machineId)))
    } catch {
      // unreadable rollout — skip
    }
  }
  return dedupeConsecutive(samples.filter((s) => s.atMs >= opts.sinceMs))
}

/**
 * One `billing: fetched credits config` line from Grok's unified log.
 *
 * Maps 1:1 onto the `format=credits` branch of `quota-grok.ts`:
 * `creditUsagePercent → usedPercent`, `currentPeriod.end → resetsAt`, and the
 * period's own start/end pair → `windowMinutes`. Grok is the one harness that
 * actually reports a window START; everywhere else it has to be derived.
 */
export function grokSampleFromLogLine(
  line: string,
  machineId: string,
  email?: string,
): QuotaHistorySampleWire | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const rec = parsed as { ts?: unknown; msg?: unknown; ctx?: unknown }
  if (typeof rec.msg !== 'string' || !rec.msg.includes('fetched credits config')) return undefined
  const atMs = typeof rec.ts === 'string' ? Date.parse(rec.ts) : Number.NaN
  if (!Number.isFinite(atMs)) return undefined
  const config = (rec.ctx as { config?: unknown } | undefined)?.config
  if (!config || typeof config !== 'object') return undefined
  const c = config as {
    creditUsagePercent?: unknown
    currentPeriod?: { type?: unknown; start?: unknown; end?: unknown }
  }
  const usedPercent = num(c.creditUsagePercent)
  const period = c.currentPeriod
  if (usedPercent === undefined || !period) return undefined
  const start = typeof period.start === 'string' ? Date.parse(period.start) : Number.NaN
  const end = typeof period.end === 'string' ? Date.parse(period.end) : Number.NaN
  if (!Number.isFinite(end)) return undefined
  const windowMinutes = Number.isFinite(start) ? Math.round((end - start) / 60_000) : 0
  // `USAGE_PERIOD_TYPE_WEEKLY` etc. — the live fetcher only accepts a weekly
  // period on this branch, and the ledger must agree with it or the recovered
  // rows would sit in a series the live sampler never writes to.
  const type = typeof period.type === 'string' ? period.type : ''
  if (!type.includes('WEEKLY')) return undefined
  return {
    agent: 'grok',
    // WITHOUT THE EMAIL, RECOVERED WINDOWS LAND IN A DIFFERENT SERIES. The live
    // fetcher reports `account.email`, so `quotaAccountKey` keys the live pool
    // `grok::<email>`; a sample that omits it is keyed `grok::machine:<id>`. The
    // two never converge, and the ledger draws two indistinguishable Grok strips
    // instead of one continuous history.
    ...(email ? { email } : {}),
    machineId,
    windowKey: 'weekly',
    label: 'Weekly',
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAtMs: end,
    windowMinutes,
    atMs,
  }
}

/**
 * Grok's home, matching `quota-grok.ts` — including the `GROK_HOME` override,
 * which is only consulted when no explicit `homeDir` was passed (tests pin a fake
 * home; production may isolate accounts).
 */
function grokHome(homeDir?: string): string {
  if (homeDir) return join(homeDir, '.grok')
  const env = process.env.GROK_HOME?.trim()
  if (env) return env
  return join(homedir(), '.grok')
}

/**
 * The account email from `~/.grok/auth.json` — the first entry carrying a token,
 * the same one `pickAuthEntry` selects in the live fetcher. It has to be the same
 * choice, or backfill and live sampling key the same pool differently.
 */
async function grokAccountEmail(home: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as { key?: unknown; email?: unknown }
      if (typeof entry.key !== 'string' || !entry.key.trim()) continue
      return typeof entry.email === 'string' && entry.email.trim() ? entry.email.trim() : undefined
    }
  } catch {
    // No readable auth. The sample still lands, keyed by machine — which is what
    // the live path does in the same situation, so the two still agree.
  }
  return undefined
}

export async function scanGrokQuotaHistory(opts: {
  sinceMs: number
  machineId: string
  homeDir?: string
}): Promise<QuotaHistorySampleWire[]> {
  const home = grokHome(opts.homeDir)
  const email = await grokAccountEmail(home)
  const path = join(home, 'logs', 'unified.jsonl')
  const samples: QuotaHistorySampleWire[] = []
  try {
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.includes('fetched credits config')) continue
        const sample = grokSampleFromLogLine(line, opts.machineId, email)
        if (sample && sample.atMs >= opts.sinceMs) samples.push(sample)
      }
    } finally {
      rl.close()
    }
  } catch {
    // No Grok installation, or no log yet.
  }
  return dedupeConsecutive(samples)
}

/**
 * Everything this machine can recover.
 *
 * GROK ONLY, DELIBERATELY — and this is a reversal of what the design proposed,
 * so here is the evidence.
 *
 * The Codex rollouts do carry `rate_limits`, and `scanCodexQuotaHistory` reads
 * them correctly: 7,370 weekly readings back to 2026-07-14 on the machine this
 * was built on. But the series does not mean what the ledger would claim it
 * means. A window instance is supposed to be one run of a pool between resets;
 * in that corpus `used_percent` climbs to 94, 97, then 100 and returns to 0
 * three times inside a single afternoon, while `resets_at` creeps forward and
 * moves BACKWARDS by as much as 15 hours between readings. Whatever that series
 * is, it is not "the weekly pool filling up once a week": folding it produced 400
 * boundaries in six weeks, and drawing those as weekly columns would be a chart
 * that looks authoritative and states something false.
 *
 * Grok's is verified clean by contrast — two windows exactly seven days apart,
 * including a textbook reset from 93% to 12%, matching the fixed billing periods
 * its API reports with a real `currentPeriod.start`.
 *
 * Codex history is therefore left to LIVE sampling, which reads the same
 * `wham/usage` endpoint the meter itself uses and returns a stable
 * `reset_at` + `limit_window_seconds` pair. The scanner stays exported and
 * tested so that re-enabling it is one line once its semantics are pinned down —
 * see the plan artifact on POD-1571.
 */
export async function scanQuotaHistory(opts: {
  sinceMs: number
  machineId: string
  homeDir?: string
}): Promise<QuotaHistorySampleWire[]> {
  return scanGrokQuotaHistory(opts)
}
