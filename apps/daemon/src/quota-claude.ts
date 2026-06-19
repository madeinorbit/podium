import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export interface ClaudeUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
}

// utilization is a 0..1 fraction (see verification note in the plan). Surface 0..100.
const toPct = (u: number | undefined): number =>
  typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 1000) / 10 : 0

export function parseClaudeUsage(body: ClaudeUsageResponse): QuotaWindowWire[] {
  const windows: QuotaWindowWire[] = []
  if (body.five_hour) {
    windows.push({
      key: '5h', label: '5-hour',
      usedPercent: toPct(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? '',
      windowMinutes: 300,
    })
  }
  if (body.seven_day) {
    windows.push({
      key: 'weekly', label: 'Weekly',
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
  const base = { agent: 'claude-code' as const, windows: [] as QuotaWindowWire[], fetchedAt: new Date(now).toISOString() }
  const credPath = join(deps.homeDir ?? homedir(), '.claude', '.credentials.json')
  let token: string | undefined
  let expiresAt: number | undefined
  try {
    const raw = JSON.parse(await readFile(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number }
    }
    token = raw.claudeAiOauth?.accessToken
    expiresAt = raw.claudeAiOauth?.expiresAt
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  if (!token) return { ...base, status: 'unauthenticated' }
  if (typeof expiresAt === 'number' && expiresAt <= now) {
    return { ...base, status: 'expired', error: 'token expired (refreshes on next Claude use)' }
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
      return { ...base, status: 'expired', error: 'token expired (refreshes on next Claude use)' }
    }
    if (!res.ok) return { ...base, status: 'error', error: `usage endpoint ${res.status}` }
    const body = (await res.json()) as ClaudeUsageResponse
    return { ...base, status: 'ok', windows: parseClaudeUsage(body) }
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
