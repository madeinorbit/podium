import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

export interface WhamUsageResponse {
  email?: string
  plan_type?: string
  rate_limit?: {
    primary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
    secondary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
  }
}

const isoFromUnix = (s: number | undefined): string =>
  typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : ''

const pct = (p: number | undefined): number => (typeof p === 'number' && Number.isFinite(p) ? p : 0)

export function parseWhamUsage(body: WhamUsageResponse): QuotaWindowWire[] {
  const windows: QuotaWindowWire[] = []
  const rl = body.rate_limit
  if (!rl) return windows
  if (rl.primary_window) {
    windows.push({
      key: '5h',
      label: '5-hour',
      usedPercent: pct(rl.primary_window.used_percent),
      resetsAt: isoFromUnix(rl.primary_window.reset_at),
      windowMinutes: 300,
    })
  }
  if (rl.secondary_window) {
    windows.push({
      key: 'weekly',
      label: 'Weekly',
      usedPercent: pct(rl.secondary_window.used_percent),
      resetsAt: isoFromUnix(rl.secondary_window.reset_at),
      windowMinutes: 10_080,
    })
  }
  return windows
}

export async function fetchCodexQuota(
  deps: { homeDir?: string; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = {
    agent: 'codex' as const,
    windows: [] as QuotaWindowWire[],
    fetchedAt: new Date(now).toISOString(),
  }
  const authPath = join(deps.homeDir ?? homedir(), '.codex', 'auth.json')
  let accessToken: string | undefined
  let accountId: string | undefined
  try {
    const raw = JSON.parse(await readFile(authPath, 'utf8')) as {
      tokens?: { access_token?: string; account_id?: string }
    }
    accessToken = raw.tokens?.access_token
    accountId = raw.tokens?.account_id
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  if (!accessToken) return { ...base, status: 'unauthenticated' }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
    })
    if (res.status === 401) return { ...base, status: 'expired' }
    if (!res.ok) return { ...base, status: 'error', error: `usage endpoint ${res.status}` }
    const body = (await res.json()) as WhamUsageResponse
    const account =
      body.email || body.plan_type
        ? {
            ...(body.email ? { email: body.email } : {}),
            ...(body.plan_type ? { plan: body.plan_type } : {}),
          }
        : undefined
    return {
      ...base,
      status: 'ok',
      windows: parseWhamUsage(body),
      ...(account ? { account } : {}),
    }
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
