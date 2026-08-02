/**
 * `podium auth` (POD-1376, absorbing POD-801/POD-800) — the operator's credential surface.
 *
 *   podium auth mint-session [--ttl <duration>] [--print-only]
 *   podium auth sessions
 *   podium auth revoke-sessions [--label <label>]
 *
 * WHY: Podium's `/trpc` surface is gated by the browser login's `podium_session` cookie, and
 * before this there was no way for a host-local caller to obtain one — auth.json stores only
 * a scrypt hash and PODIUM_PASSWORD is a one-shot seed. On a password-protected instance
 * that left the direct CLI with no working path at all, and a browser-driving agent with no
 * way to authenticate either. The trust argument for minting from local filesystem access,
 * and the point at which it stops holding, are written down in @podium/runtime/session-mint.
 *
 * `mint-session` prints the token ALONE on stdout so `TOKEN=$(podium auth mint-session
 * --print-only)` is the obvious thing; the human-facing guidance goes to stderr.
 */
import {
  BREAK_GLASS_LABEL,
  listSessions,
  mintBreakGlassSession,
  revokeSessionsByLabel,
  saveCachedSessionToken,
  sessionTokenPath,
} from '@podium/runtime/session-mint'

export class AuthCliError extends Error {}

export const AUTH_USAGE = [
  'usage: podium auth <command>',
  '',
  'Commands:',
  '  mint-session [--ttl <duration>] [--print-only]',
  '      Mint a revocable operator session from local state-dir access and print it.',
  '      Cached to the state dir so `podium issue` and friends carry it automatically;',
  '      --print-only skips the cache. --ttl takes 30s, 10m, 2h, 30d or bare seconds',
  '      (default 30d, matching a browser login).',
  '  sessions',
  '      Every session row: label, token hash (never the token) and expiry.',
  '  revoke-sessions [--label <label>]',
  `      Revoke one class of session. Default '${BREAK_GLASS_LABEL}' — browser logins`,
  "      ('login') and node⇄hub tokens ('upstream') are left alone.",
  '',
  'Trust (single-operator host — ADR 3 D14 / POD-1402):',
  '  Minting requires write access to this instance’s podium.db, which already',
  '  implies ownership of everything in it. Any process that can write the state',
  '  dir — including a constrained agent session on the same OS user — can mint',
  '  and then call /trpc as the operator. Agent/operator relay scope is accident',
  '  prevention on the default path, not containment of a co-resident adversarial',
  '  agent. Do not build features that assume otherwise until multi-user isolation',
  '  (POD-1067+) reopens the mint trust root.',
  '  PODIUM_STATE_DIR selects a non-default instance.',
].join('\n')

export interface AuthCliIo {
  print(line: string): void
  printErr(line: string): void
}

/** Parse a human duration (`30s`, `10m`, `2h`, `30d`, bare seconds) to milliseconds. */
export function parseTtl(raw: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(raw.trim())
  if (!m) throw new AuthCliError(`invalid --ttl '${raw}' (use e.g. 10m, 2h, 30d, or seconds)`)
  const mult = m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1_000
  const ms = Number(m[1]) * mult
  if (ms <= 0) throw new AuthCliError(`invalid --ttl '${raw}': must be positive`)
  return ms
}

/** The value following `--name`, or undefined. Throws when the flag is present but bare —
 *  a silent default there would mint under the wrong TTL or revoke the wrong class. */
function flagValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--'))
    throw new AuthCliError(`--${name} needs a value`)
  return value
}

function mintSession(argv: string[], io: AuthCliIo): void {
  const ttl = flagValue(argv, 'ttl')
  const minted = mintBreakGlassSession(ttl ? { ttlMs: parseTtl(ttl) } : {})
  io.print(minted.token)
  if (argv.includes('--print-only')) {
    io.printErr(`Not cached (--print-only). Expires ${minted.expiresAt}.`)
  } else {
    saveCachedSessionToken(minted)
    io.printErr(
      `Cached to ${sessionTokenPath()} — podium commands on this host now carry it.\n` +
        `Expires ${minted.expiresAt}. Revoke with \`podium auth revoke-sessions\`.`,
    )
  }
}

function showSessions(io: AuthCliIo): void {
  const rows = listSessions()
  if (rows.length === 0) {
    io.print('no client sessions')
    return
  }
  const width = Math.max(...rows.map((r) => r.label.length))
  io.print(`${rows.length} session(s)`)
  for (const row of rows)
    io.print(
      `  ${row.label.padEnd(width)}  ${row.tokenHash.slice(0, 12)}…  expires ${row.expiresAt}`,
    )
}

function revokeSessions(argv: string[], io: AuthCliIo): void {
  const label = flagValue(argv, 'label') ?? BREAK_GLASS_LABEL
  io.print(`revoked ${revokeSessionsByLabel(label)} '${label}' session(s)`)
}

export async function authCliMain(argv: string[], io: AuthCliIo): Promise<void> {
  const sub = argv[0]
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    io.print(AUTH_USAGE)
    return
  }
  if (sub === 'mint-session') return mintSession(argv.slice(1), io)
  if (sub === 'sessions') return showSessions(io)
  if (sub === 'revoke-sessions') return revokeSessions(argv.slice(1), io)
  throw new AuthCliError(`unknown command '${sub}'\n\n${AUTH_USAGE}`)
}
