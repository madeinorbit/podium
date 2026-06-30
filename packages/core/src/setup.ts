import { loadConfig, type PodiumConfig, saveConfig } from './config'

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
        command: `cloudflared tunnel --url http://localhost:${port}`,
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

export function applySetup(input: { publicUrl: string }): PodiumConfig {
  const cfg: PodiumConfig = { ...loadConfig(), mode: 'all-in-one', publicUrl: input.publicUrl }
  saveConfig(cfg)
  return cfg
}
