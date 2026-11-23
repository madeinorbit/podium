import type { AgentQuotaWire, QuotaWindowWire } from '@podium/model'
import type { LoginCommandResult, QuotaProbeOptions } from '../../manifest.js'
import { isRecord, stringField } from '../shared/json-util.js'
import {
  antigravityCredentialIdentity,
  hasValidAntigravityCredential,
  parseAntigravityCredential,
  readAntigravityCredential,
} from './credentials.js'

const TIMEOUT_MS = 20_000

/** agy starts global MCP servers even for /usage. Give its customization
 * loader an empty root, while its account state stays at the native location
 * through a directory link (a junction on Windows). Refreshes update the real
 * token store; no copied token can go stale or overwrite a concurrent login. */
function quotaCommand(account: QuotaProbeOptions['account'], command: '/usage' | '/credits') {
  return {
    args: (directory: string) => [
      // Last selectors override the ordinary session's customization root.
      '--gemini_dir',
      directory,
      '--app_data_dir',
      'account-state',
      '--settings',
      JSON.stringify({
        modelProvider: '',
        disableSlashCommands: false,
        statusLine: { enabled: false },
        title: { enabled: false },
      }),
      '--print',
      command,
      '--output-format',
      'json',
    ],
    linkedDirectories: { 'account-state': account.roots.state },
    timeoutMs: TIMEOUT_MS,
  }
}

function commandReport(
  result: LoginCommandResult,
  name: string,
): Record<string, unknown> | undefined {
  if (result.timedOut || result.errorCode || result.exitCode !== 0) return undefined
  try {
    const raw: unknown = JSON.parse(result.stdout)
    // Read-only command reports must not be confused with an agent response.
    if (
      !isRecord(raw) ||
      raw.status !== 'SUCCESS' ||
      raw.num_turns !== 0 ||
      raw.finished_reason ||
      !isRecord(raw.command) ||
      raw.command.name !== name ||
      !isRecord(raw.command.data)
    )
      return undefined
    return raw.command.data
  } catch {
    return undefined
  }
}

export function parseAntigravityQuotaReport(result: LoginCommandResult): QuotaWindowWire[] {
  const data = commandReport(result, 'usage')
  if (!data || !Array.isArray(data.groups)) return []
  const windows = new Map<string, QuotaWindowWire>()
  for (const group of data.groups) {
    if (!isRecord(group) || group.disabled === true || !Array.isArray(group.buckets)) continue
    const pool = stringField(group, 'name')?.trim()
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || bucket.disabled === true) continue
      const key = stringField(bucket, 'id')?.trim()
      const remaining = bucket.remaining_fraction
      if (
        !key ||
        typeof remaining !== 'number' ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      )
        continue
      const period = stringField(bucket, 'window')
      const label =
        period === '5h'
          ? '5-hour'
          : period === 'weekly'
            ? 'Weekly'
            : stringField(bucket, 'name') || key
      const reset = stringField(bucket, 'reset_time')
      const window: QuotaWindowWire = {
        key,
        label: pool ? `${pool} · ${label}` : label,
        usedPercent: Math.round((1 - remaining) * 1000) / 10,
        resetsAt: reset && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : '',
        windowMinutes: period === '5h' ? 300 : period === 'weekly' ? 10_080 : 0,
        ...(pool ? { pool } : {}),
      }
      // Shared native IDs name the same bucket. Duplicate descriptions must
      // never replace a measured constraint with a less constrained reading.
      const previous = windows.get(key)
      if (!previous || previous.usedPercent < window.usedPercent) windows.set(key, window)
    }
  }
  return [...windows.values()]
}

export function parseAntigravityCreditReport(
  result: LoginCommandResult,
): AgentQuotaWire['credits'] {
  const data = commandReport(result, 'credits')
  const remaining = data?.remaining_credits
  return typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0
    ? { remaining }
    : undefined
}

function failedStatus(result: LoginCommandResult): Pick<AgentQuotaWire, 'status' | 'error'> {
  // Native diagnostics can contain OAuth links. Publish only fixed messages.
  let message = ''
  try {
    const raw: unknown = JSON.parse(result.stdout)
    if (isRecord(raw)) message = stringField(raw, 'error') ?? ''
  } catch {
    /* An invalid report is unavailable, not zero quota. */
  }
  if (
    /invalid_grant|expired|reauthenticat|sign.?in|not logged in|no authentication/iu.test(message)
  )
    return { status: 'expired', error: 'Sign in to Antigravity again to read Google plan quota.' }
  if (result.timedOut)
    return { status: 'error', error: 'Antigravity quota timed out. Retry the refresh.' }
  return {
    status: 'error',
    error:
      'Antigravity did not return a usable quota report. Retry or open /usage in its terminal.',
  }
}

/** Google owns the quota requests and OAuth refresh. No public OAuth client
 * secret, private remote endpoint, UI scrape, or model request is needed. */
export async function fetchAntigravityQuota(opts: QuotaProbeOptions): Promise<AgentQuotaWire> {
  const base = {
    agent: 'antigravity' as const,
    windows: [] as QuotaWindowWire[],
    fetchedAt: new Date(opts.now ?? Date.now()).toISOString(),
  }
  const raw = readAntigravityCredential(opts.account.home, opts.account.env)
  if (!raw) return { ...base, status: 'unauthenticated' }
  if (!hasValidAntigravityCredential(raw))
    return { ...base, status: parseAntigravityCredential(raw) ? 'expired' : 'unauthenticated' }
  const identity = antigravityCredentialIdentity(raw)
  const account = identity?.email ? { email: identity.email } : undefined
  if (!opts.runCommand)
    return {
      ...base,
      ...(account ? { account } : {}),
      status: 'error',
      error: 'Install Antigravity CLI to read Google plan quota.',
    }
  try {
    const usage = await opts.runCommand(quotaCommand(opts.account, '/usage'))
    const windows = parseAntigravityQuotaReport(usage)
    if (!windows.length) return { ...base, ...(account ? { account } : {}), ...failedStatus(usage) }
    // Credits are optional (enterprise and some free accounts have none).
    // A credit failure must not hide successfully measured plan windows.
    let credits: AgentQuotaWire['credits']
    try {
      credits = parseAntigravityCreditReport(
        await opts.runCommand(quotaCommand(opts.account, '/credits')),
      )
    } catch {
      /* Keep the measured plan quota. */
    }
    return {
      ...base,
      status: 'ok',
      windows,
      ...(account ? { account } : {}),
      ...(credits ? { credits } : {}),
    }
  } catch {
    return {
      ...base,
      ...(account ? { account } : {}),
      status: 'error',
      error: 'Could not run the installed Antigravity CLI quota report.',
    }
  }
}
