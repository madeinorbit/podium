import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export interface ClaudeUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
}

// utilization is already a 0..100 percent (verified live 2026-06-19). Round to one decimal.
const toPct = (u: number | undefined): number =>
  typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 10) / 10 : 0

export function parseClaudeUsage(body: ClaudeUsageResponse): QuotaWindowWire[] {
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
  deps: { homeDir?: string; now?: number; fetchImpl?: typeof fetch } = {},
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
