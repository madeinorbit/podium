import { inspectConfig, loadConfig, type PodiumConfig, saveConfig } from './config'
import { decodeJoin } from './join'

export type NetworkOption = 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual'

export const NETWORK_OPTIONS: { id: NetworkOption; label: string; note: string }[] = [
  {
    id: 'tailscale-funnel',
    label: 'Tailscale Funnel (public, recommended)',
    note: 'Real cert, reachable from anywhere, no domain. Funnel uses ports 443/8443/10000 and must be enabled in your tailnet ACL.',
  },
  {
    id: 'tailscale-serve',
    label: 'Tailscale Serve (private)',
    note: 'Reachable only from devices on your tailnet.',
  },
  {
    id: 'cloudflare-tunnel',
    label: 'Cloudflare quick tunnel (no Tailscale)',
    note: 'Instant public URL, no account. The URL changes on every restart — demo-grade.',
  },
  { id: 'manual', label: 'Manual reverse proxy', note: 'Caddy/nginx/etc. — paste the https URL.' },
]

export function networkOptionCommand(
  opt: NetworkOption,
  port: number,
): { command: string; hint: string } {
  switch (opt) {
    case 'tailscale-funnel':
      return {
        command: `tailscale funnel ${port}`,
        hint: 'Then paste the https://<host>.<tailnet>.ts.net URL it prints.',
      }
    case 'tailscale-serve':
      return {
        command: `tailscale serve ${port}`,
        hint: 'Then paste the https://<host>.<tailnet>.ts.net URL it prints.',
      }
    case 'cloudflare-tunnel':
      return {
        command: `cloudflared tunnel --url http://127.0.0.1:${port}`,
        hint: 'Then paste the https://<random>.trycloudflare.com URL it prints.',
      }
    case 'manual':
      return { command: '', hint: 'Paste the https:// URL your reverse proxy serves.' }
  }
}

export function validatePublicUrl(
  url: string,
): { ok: true; normalized: string } | { ok: false; error: string } {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return { ok: false, error: 'Not a valid URL.' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'URL must start with http:// or https://.' }
  }
  return { ok: true, normalized: u.toString().replace(/\/$/, '') }
}

export function wssFrom(publicUrl: string): string {
  return publicUrl.replace(/^http(s?):\/\//, (_m, s) => (s ? 'wss://' : 'ws://')).replace(/\/$/, '')
}

/**
 * Warn when a server URL is a Cloudflare QUICK tunnel (*.trycloudflare.com): those URLs
 * rotate on every cloudflared restart, so every joined daemon goes dark until it is pointed
 * at the new URL (issue #19). Returned (not thrown) — quick tunnels are legitimate for demos.
 */
export function ephemeralTunnelWarning(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url.trim()).hostname
  } catch {
    return undefined
  }
  if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) {
    return (
      'This is a Cloudflare QUICK tunnel URL — it changes every time cloudflared restarts, ' +
      'and every joined machine will lose contact until you run `podium set-server <new-url>` ' +
      'on it. Fine for a demo; use Tailscale or a named tunnel for anything durable.'
    )
  }
  return undefined
}

/**
 * `podium set-server <url-or-join-code>` — rotate ONLY the server URL a daemon/client box
 * dials (issue #19: a rotated tunnel URL must not force a re-setup that wholesale-replaces
 * config). Patches `serverUrl` (and `pairCode` when a join code was pasted) and preserves
 * everything else — updateChannel, persistence, port, upstream — and never touches
 * daemon.json (identity/token), so a re-pair is NOT required after a URL rotation.
 * Accepts ws(s):// or http(s):// (http(s) is ws-ified) or a full join code.
 */
export function applyServerUrl(input: string): {
  serverUrl: string
  pairCode?: string
  warning?: string
} {
  assertConfigWritable()
  const prev = loadConfig()
  if (prev.mode !== 'daemon' && prev.mode !== 'client') {
    throw new Error(
      `set-server only applies to a joined (daemon) or client box; this box is ${
        prev.mode ? `mode=${prev.mode}` : 'not configured'
      }. Run \`podium setup\` instead.`,
    )
  }
  const trimmed = input.trim()
  // A pasted join code also works — it carries the new URL (and a fresh pair code, which is
  // harmless for an already-paired daemon: the stored token wins at handshake time).
  let serverUrl: string
  let pairCode: string | undefined
  try {
    const p = decodeJoin(trimmed)
    serverUrl = p.serverUrl
    pairCode = p.pairCode
  } catch {
    const v = validatePublicUrl(trimmed.replace(/^ws(s?):\/\//, (_m, s) => `http${s}://`))
    if (!v.ok) throw new Error(`not a server URL or join code: ${v.error}`)
    serverUrl = wssFrom(v.normalized)
  }
  saveConfig({ ...prev, serverUrl, ...(pairCode ? { pairCode } : {}) })
  const warning = ephemeralTunnelWarning(serverUrl)
  return { serverUrl, ...(pairCode ? { pairCode } : {}), ...(warning ? { warning } : {}) }
}

/**
 * Drop a consumed one-shot pair code from config.json after a successful pair (issue #19).
 * Guarded on the exact code so a NEWER code written by a concurrent re-join is never lost.
 * A stale code was previously harmless-but-confusing: it made the config look "unpaired".
 */
export function consumePairCode(code: string): void {
  const prev = loadConfig()
  if (prev.pairCode !== code) return
  const { pairCode: _consumed, ...rest } = prev
  saveConfig(rest)
}

/**
 * Refuse a destructive write over an EXISTING-but-invalid config.json (issue #21): what
 * looks like a fresh box to loadConfig may be an operator's broken-but-recoverable config;
 * every setup mutation goes through here so it can't be silently clobbered.
 */
function assertConfigWritable(): void {
  const res = inspectConfig()
  if (res.state === 'corrupt') {
    throw new Error(
      `config.json exists but is invalid (${res.error}). Refusing to overwrite it — ` +
        'fix the file, or run `podium setup --repair` to back it up and start fresh.',
    )
  }
}

export function applySetup(input: {
  publicUrl: string
  mode?: 'all-in-one' | 'server'
}): PodiumConfig {
  assertConfigWritable()
  const prev = loadConfig()
  // Explicit mode wins (the web reachability step now runs for BOTH all-in-one and server-only).
  // Else preserve an already-chosen host mode — a relay-only `server` box setting its URL later
  // (e.g. from Settings → Machines) must stay `server`. First run (mode unset) defaults to
  // all-in-one, the main-instance path.
  const mode = input.mode ?? (prev.mode === 'server' ? 'server' : 'all-in-one')
  const cfg: PodiumConfig = {
    ...prev,
    mode,
    publicUrl: input.publicUrl,
    // Web setup can't start/persist the backend from inside the serving process — record
    // the intent; the next `podium` invocation reconciles it (issue #20). A box that
    // already chose a persistence keeps it.
    ...(prev.persistence ? {} : { pendingPersistence: 'systemd' as const }),
  }
  saveConfig(cfg)
  return cfg
}

/**
 * Apply a one-paste join code (carries the server URL + pairing code) → a daemon config.
 * The single source of truth for "join a server", shared by the CLI (`podium join-config`
 * / `podium setup`) and the web setup's `setup.join` tRPC. Throws on a malformed token.
 * PATCHES the existing config (issue #20 — a wholesale replace made `install.sh --channel
 * edge --join …` silently revert to stable): preserves updateChannel, port, persistence,
 * updateFeed, upstream; drops only the host-mode fields a daemon must not keep (publicUrl)
 * and any stale pairCode.
 */
export function applyJoin(token: string): { name: string; warning?: string } {
  assertConfigWritable()
  const p = decodeJoin(token)
  const { publicUrl: _hostOnly, pairCode: _stale, ...prev } = loadConfig()
  saveConfig({
    ...prev,
    mode: 'daemon',
    serverUrl: p.serverUrl,
    pairCode: p.pairCode,
    // See applySetup: web/join-config surfaces can't start the backend themselves; record
    // the intent for the next `podium` invocation. CLI setup overwrites it right after.
    ...(prev.persistence ? {} : { pendingPersistence: 'systemd' as const }),
  })
  const warning = ephemeralTunnelWarning(p.serverUrl)
  return { name: p.name ?? 'this machine', ...(warning ? { warning } : {}) }
}

/**
 * Set a deployment mode that needs no reachability flow: all-in-one without a public URL
 * ("skip"), client (connect to a remote server), or server-only. Shared by the web setup's
 * `setup.connect` tRPC (daemon uses applyJoin; all-in-one with reachability uses applySetup).
 * Client mode requires a server URL.
 */
export function applyMode(input: {
  mode: 'all-in-one' | 'client' | 'server'
  serverUrl?: string
}): PodiumConfig {
  assertConfigWritable()
  const serverUrl = input.serverUrl?.trim()
  if (input.mode === 'client' && !serverUrl) {
    throw new Error('client mode needs a server URL')
  }
  const cfg: PodiumConfig = {
    ...loadConfig(),
    mode: input.mode,
    ...(serverUrl ? { serverUrl } : {}),
  }
  saveConfig(cfg)
  return cfg
}

/** Current self-update channel for the headless build; defaults to 'stable' when unset. */
export function getUpdateChannel(): 'stable' | 'edge' {
  return loadConfig().updateChannel ?? 'stable'
}

/** Persist the self-update channel and return the resulting value. */
export function setUpdateChannel(channel: 'stable' | 'edge'): 'stable' | 'edge' {
  saveConfig({ ...loadConfig(), updateChannel: channel })
  return channel
}
