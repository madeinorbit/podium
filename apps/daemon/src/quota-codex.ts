import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

export interface CodexRateLimitWindow {
  usedPercent?: number
  resetsAt?: number // unix seconds
}
export interface CodexRateLimits {
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
}
export type CodexRateLimitReader = (deps: { homeDir?: string }) => Promise<CodexRateLimits>

const isoFromUnix = (s: number | undefined): string =>
  typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : ''
const pct = (p: number | undefined): number => (typeof p === 'number' && Number.isFinite(p) ? p : 0)

export function parseCodexRateLimits(rl: CodexRateLimits): QuotaWindowWire[] {
  const windows: QuotaWindowWire[] = []
  if (rl.primary) {
    windows.push({ key: '5h', label: '5-hour', usedPercent: pct(rl.primary.usedPercent), resetsAt: isoFromUnix(rl.primary.resetsAt), windowMinutes: 300 })
  }
  if (rl.secondary) {
    windows.push({ key: 'weekly', label: 'Weekly', usedPercent: pct(rl.secondary.usedPercent), resetsAt: isoFromUnix(rl.secondary.resetsAt), windowMinutes: 10_080 })
  }
  return windows
}

export function decodeJwtEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined
  const parts = idToken.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { email?: string }
    return typeof payload.email === 'string' ? payload.email : undefined
  } catch {
    return undefined
  }
}

// Real reader: drive `codex app-server` over newline-delimited JSON-RPC. SHAPE
// VERIFIED live 2026-06-19: response is result.rateLimits.{primary,secondary}, each
// { usedPercent (0..100 number), windowDurationMins, resetsAt (unix SECONDS) }.
export const readCodexRateLimitsViaAppServer: CodexRateLimitReader = ({ homeDir } = {}) =>
  new Promise<CodexRateLimits>((resolve, reject) => {
    const env = { ...process.env, ...(homeDir ? { CODEX_HOME: join(homeDir, '.codex') } : {}) }
    const child = spawn('codex', ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'], env,
    })
    let buf = ''
    let settled = false
    const finish = (err: Error | null, val?: CodexRateLimits) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      if (err) reject(err)
      else resolve(val ?? {})
    }
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), 25_000)
    timer.unref?.()
    const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`)
    child.once('spawn', () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'podium', version: '0.0.0' } } })
    })
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (!line) continue
        let msg: { id?: number; result?: { rateLimits?: CodexRateLimits } }
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })
        } else if (msg.id === 2) {
          finish(null, msg.result?.rateLimits ?? {})
        }
      }
    })
    child.on('error', (e) => finish(e))
    child.on('exit', () => finish(new Error('codex app-server exited early')))
  })

export async function fetchCodexQuota(
  deps: { homeDir?: string; now?: number; readImpl?: CodexRateLimitReader } = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const base = { agent: 'codex' as const, windows: [] as QuotaWindowWire[], fetchedAt: new Date(now).toISOString() }
  const authPath = join(deps.homeDir ?? homedir(), '.codex', 'auth.json')
  let email: string | undefined
  try {
    const auth = JSON.parse(await readFile(authPath, 'utf8')) as { tokens?: { id_token?: string } }
    email = decodeJwtEmail(auth.tokens?.id_token)
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  const read = deps.readImpl ?? readCodexRateLimitsViaAppServer
  try {
    const rl = await read({ ...(deps.homeDir ? { homeDir: deps.homeDir } : {}) })
    return { ...base, status: 'ok', windows: parseCodexRateLimits(rl), ...(email ? { account: { email } } : {}) }
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
