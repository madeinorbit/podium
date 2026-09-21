/**
 * Claude Code quota + usage layouts — the Inventory usage section (POD-4414
 * §4.4, issue 3.3).
 *
 * KNOWLEDGE, not mechanism: the OAuth usage endpoint, its response grammar,
 * and the transcript harvest walk over `~/.claude/projects` (including
 * delegate transcripts). The inventory mechanism fans these out and merges
 * the folds without naming the harness. Claude writes no recoverable quota
 * history, so `history` is declined with the reason — that absence is itself
 * the answer.
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/model'
import {
  supported,
  unsupported,
  type HarnessUsage,
  type QuotaProbeOptions,
} from '../../manifest.js'
import {
  collectJsonlFiles,
  parseLine,
  scanJsonlTranscripts,
  type UsageFileScan,
  type UsageRecord,
  type UsageScanCache,
} from '../../usage-records.js'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export interface ClaudeUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
  limits?: unknown
}

// utilization is already a 0..100 percent (verified live 2026-06-19). Round to one decimal.
const toPct = (u: number | undefined): number =>
  typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 10) / 10 : 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function keyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function scopeMetadata(scope: unknown): { labels: string[]; keys: string[]; model?: string } {
  const labels: string[] = []
  const keys: string[] = []
  let model: string | undefined
  if (!isRecord(scope)) return { labels, keys }
  for (const [scopeKind, rawValue] of Object.entries(scope).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!isRecord(rawValue)) continue
    const displayName = stringField(rawValue.display_name)
    const id = stringField(rawValue.id)
    if (displayName) labels.push(displayName)
    const identity = id ?? displayName
    if (identity) keys.push(`${keyPart(scopeKind)}:${keyPart(identity)}`)
    // A model scope is what makes a window fall-back-able rather than gating —
    // the UI needs it named, not just folded into the label. [spec:SP-0610]
    if (scopeKind === 'model' && (displayName ?? id)) model = displayName ?? id
  }
  return { labels, keys, ...(model ? { model } : {}) }
}

function inferredWindowMinutes(kind: string | undefined, group: string | undefined): number {
  if (group === 'session' || kind === 'session') return 300
  if (group === 'weekly' || kind?.startsWith('weekly_')) return 10_080
  // Future kinds still render, but without a pace marker until the endpoint
  // tells us their duration or we can infer it safely.
  return 0
}

function fallbackLimitLabel(kind: string | undefined, group: string | undefined): string {
  if (group === 'session' || kind === 'session') return '5-hour'
  if (kind === 'weekly_all' || (group === 'weekly' && !kind)) return 'Weekly'
  const raw = kind ?? group ?? 'Limit'
  return raw
    .split('_')
    .filter(Boolean)
    .map((part, index) => (index === 0 ? (part[0]?.toUpperCase() ?? '') + part.slice(1) : part))
    .join(' ')
}

/** Parse Claude's current generic limits array. Labels and identities come from
 * upstream scope metadata, so model limits can appear/disappear without a
 * model-specific Podium mapping. [spec:SP-0610] */
function parseGenericLimits(rawLimits: unknown): QuotaWindowWire[] {
  if (!Array.isArray(rawLimits)) return []
  const windows: QuotaWindowWire[] = []
  const keys = new Map<string, number>()
  for (const rawLimit of rawLimits) {
    if (!isRecord(rawLimit)) continue
    const percent = rawLimit.percent
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
    const kind = stringField(rawLimit.kind)
    const group = stringField(rawLimit.group)
    const scope = scopeMetadata(rawLimit.scope)
    const baseKey = [keyPart(kind ?? group ?? 'limit'), ...scope.keys].filter(Boolean).join(':')
    const occurrence = (keys.get(baseKey) ?? 0) + 1
    keys.set(baseKey, occurrence)
    windows.push({
      key: occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`,
      label: scope.labels.join(' · ') || fallbackLimitLabel(kind, group),
      usedPercent: toPct(percent),
      resetsAt: stringField(rawLimit.resets_at) ?? '',
      windowMinutes: inferredWindowMinutes(kind, group),
      ...(scope.model ? { scopeModel: scope.model } : {}),
    })
  }
  return windows
}

export function parseClaudeUsage(body: ClaudeUsageResponse): QuotaWindowWire[] {
  const generic = parseGenericLimits(body.limits)
  if (generic.length > 0) return generic

  // Compatibility with older Claude usage responses that predate the limits array.
  const windows: QuotaWindowWire[] = []
  if (body.five_hour) {
    windows.push({
      key: '5h',
      label: '5-hour',
      usedPercent: toPct(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? '',
      windowMinutes: 300,
    })
  }
  if (body.seven_day) {
    windows.push({
      key: 'weekly',
      label: 'Weekly',
      usedPercent: toPct(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? '',
      windowMinutes: 10_080,
    })
  }
  return windows
}

export async function fetchClaudeQuota(
  deps: QuotaProbeOptions = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = {
    agent: 'claude-code' as const,
    windows: [] as QuotaWindowWire[],
    fetchedAt: new Date(now).toISOString(),
  }
  const homeDir = deps.homeDir ?? homedir()
  const credPath = join(homeDir, '.claude', '.credentials.json')
  let token: string | undefined
  let expiresAt: number | undefined
  let subscriptionType: string | undefined
  try {
    const raw = JSON.parse(await readFile(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string }
    }
    token = raw.claudeAiOauth?.accessToken
    expiresAt = raw.claudeAiOauth?.expiresAt
    subscriptionType = raw.claudeAiOauth?.subscriptionType
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  if (!token) return { ...base, status: 'unauthenticated' }
  // The account identity (email) lives in ~/.claude.json, separate from the
  // credential token, so the overlay can label the account and dedupe machines
  // signed into the same one. Best-effort — absence just omits the account.
  const account = await readClaudeAccount(homeDir, subscriptionType)
  const withAcct = account ? { ...base, account } : base
  if (typeof expiresAt === 'number' && expiresAt <= now) {
    return { ...withAcct, status: 'expired', error: 'token expired (refreshes on next Claude use)' }
  }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-code/2.1.0',
      },
    })
    if (res.status === 401) {
      return {
        ...withAcct,
        status: 'expired',
        error: 'token expired (refreshes on next Claude use)',
      }
    }
    if (!res.ok) return { ...withAcct, status: 'error', error: `usage endpoint ${res.status}` }
    const body = (await res.json()) as ClaudeUsageResponse
    return { ...withAcct, status: 'ok', windows: parseClaudeUsage(body) }
  } catch (e) {
    return { ...withAcct, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/** The Claude account for the overlay: email from ~/.claude.json (oauthAccount),
 *  plan from the credential's subscriptionType. Best-effort — returns undefined
 *  when neither is available so the wire simply omits `account`. */
async function readClaudeAccount(
  homeDir: string,
  plan: string | undefined,
): Promise<{ email?: string; plan?: string } | undefined> {
  let email: string | undefined
  try {
    const raw = JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string }
    }
    email = raw.oauthAccount?.emailAddress
  } catch {
    // No ~/.claude.json (or unreadable) — fall back to just the plan, if any.
  }
  const account: { email?: string; plan?: string } = {}
  if (email) account.email = email
  if (plan) account.plan = plan
  return account.email || account.plan ? account : undefined
}

/**
 * Parse one JSONL record; null when it carries no usage.
 *
 * A record whose model is a `<…>` sentinel is NOT usage. Claude Code writes its
 * API-error and session-limit placeholders as assistant turns stamped
 * `"model": "<synthetic>"` with an all-zero usage block — no model ran, and no
 * tokens were billed. Counted, they added a permanent 0-token `<synthetic>` row
 * to the usage sheet's model table and inflated every reply count by however
 * many times an agent hit a limit. `claudeRecordModel` already filters the same
 * sentinel for the transcript reader; this is the usage path's copy of that rule.
 */
export function usageFromRecord(record: unknown): UsageRecord | null {
  if (typeof record !== 'object' || record === null) return null
  const r = record as Record<string, unknown>
  if (r.type !== 'assistant') return null
  const message = r.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  if (typeof message?.model === 'string' && message.model.startsWith('<')) return null
  const tsMs = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
  if (Number.isNaN(tsMs)) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined
  const cacheCreation1hTokens = n(cacheCreation?.ephemeral_1h_input_tokens)
  const reportedCacheCreationTokens = n(usage.cache_creation_input_tokens)
  // The aggregate predates the TTL breakdown and remains the fallback for old
  // Claude Code records. When a partial/future breakdown does not add up to the
  // aggregate, conservatively assign the unexplained remainder to the default
  // 5-minute tier instead of losing tokens.
  const cacheCreation5mTokens = cacheCreation
    ? Math.max(
        n(cacheCreation.ephemeral_5m_input_tokens),
        reportedCacheCreationTokens - cacheCreation1hTokens,
      )
    : reportedCacheCreationTokens
  const requestId = typeof r.requestId === 'string' && r.requestId ? r.requestId : undefined
  const messageId = typeof message?.id === 'string' && message.id ? message.id : undefined
  return {
    tsMs,
    model: typeof message?.model === 'string' ? (message.model as string) : 'unknown',
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheCreationTokens: cacheCreation1hTokens + cacheCreation5mTokens,
    cacheCreation1hTokens,
    ...(requestId
      ? { responseId: `request:${requestId}` }
      : messageId
        ? { responseId: `message:${messageId}` }
        : {}),
  }
}

/**
 * `~/.claude/projects/<project>/<nativeId>.jsonl`, AND the delegate transcripts
 * at `<nativeId>/subagents/<agentId>.jsonl`.
 *
 * The subagent files were missed by the one-level read this replaces, and they
 * are not a rounding error: on this machine they carried $85 of Claude spend in
 * a single 7-day window, all of it attributable — every one of them has a
 * conversation-segment row whose parent identity names the session that spawned
 * it. Codex has said the same thing about its own subagent rollouts since
 * POD-570 ("the sheet answers what the account spent, and a subagent's tokens
 * are billed like any other"); this makes the Claude half agree. They do not
 * double-count: a delegate's records appear in its own file and nowhere else.
 */
export async function scanClaudeUsage(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<UsageFileScan[]> {
  const projectsDir = join(opts.homeDir ?? homedir(), '.claude', 'projects')
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return [] // no Claude installation on this box
  }
  const paths: string[] = []
  for (const project of projectDirs) await collectJsonlFiles(join(projectsDir, project), paths)
  return scanJsonlTranscripts(paths, 'claude-code', opts, {
    usageFromLine: (line) => {
      // Cheap reject before JSON.parse: most transcript lines carry no usage.
      if (!line.includes('"usage"')) return null
      return parseLine(line, (record) => usageFromRecord(record))
    },
  })
}

export const claudeUsage: HarnessUsage = {
  quota: supported({ fetchQuota: fetchClaudeQuota }),
  history: unsupported(
    'Claude Code writes no recoverable quota history — its usage endpoint is read live and cached nowhere, by Podium or by Claude Code',
  ),
  transcripts: supported({ scan: scanClaudeUsage }),
}
