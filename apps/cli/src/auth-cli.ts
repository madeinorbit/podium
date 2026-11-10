/**
 * `podium auth` uses the running server's user-only socket to issue and
 * redeem host recovery codes. The signed credential alone goes to stdout.
 */
import { DeviceSignInKind, DeviceSignInsResponse } from '@podium/protocol'
import { saveCachedSessionToken, sessionTokenPath } from '@podium/runtime/session-mint'
import { declareFlags, flagTable, parseFlags, withUnknownFlagAs } from './argv'
import { controlRequest } from './cli-doctor'

export class AuthCliError extends Error {}

export const AUTH_USAGE = [
  'usage: podium auth <command>',
  '',
  'Commands:',
  '  mint-session [--ttl <duration>] [--print-only]',
  '      Ask the running server for a revocable host sign-in and print it.',
  '      Cached to the state dir so `podium issue` and friends carry it automatically;',
  '      --print-only skips the cache. --ttl takes 30s, 10m, 2h, 30d or bare seconds',
  '      (default 30d, matching a browser login).',
  '  sessions',
  '      List live device sign-ins: kind, public id and expiry.',
  '  revoke-sessions [--kind <browser|desktop|phone|host>]',
  '      Revoke one kind of sign-in. Defaults to host.',
  '  recovery-link <email>',
  '      Print a single-use link that sets a new password for that member. The way back',
  '      in on this host when nobody can sign in and no mail reset is set up. Asks the',
  '      running server over its local socket; the link is audited and expires in a day.',
  '',
  'Host sign-ins are available only on a one-member server. PODIUM_STATE_DIR',
  'selects a non-default instance.',
].join('\n')

export interface AuthCliIo {
  print(line: string): void
  printErr(line: string): void
}

/** The control-socket call `recovery-link` makes; injected by tests. */
export type RecoveryLinkRequest = (email: string) => Promise<Record<string, unknown>>

async function recoveryLink(
  argv: string[],
  io: AuthCliIo,
  request: RecoveryLinkRequest,
): Promise<void> {
  const email = argv.find((arg) => !arg.startsWith('--'))
  if (!email) throw new AuthCliError('usage: podium auth recovery-link <email>')
  let answer: Record<string, unknown>
  try {
    answer = await request(email)
  } catch (error) {
    throw new AuthCliError(
      error instanceof Error && error.message
        ? `Podium refused the recovery link: ${error.message}`
        : 'Podium is not running on this host, so it cannot issue a recovery link.',
    )
  }
  io.print(String(answer.url))
  io.printErr(
    `Single use, expires ${String(answer.expiresAt)}. Opening it sets a new password and signs ` +
      'that member out everywhere.',
  )
}

/** Parse a human duration (`30s`, `10m`, `2h`, `30d`, bare seconds) to milliseconds. */
export function parseTtl(raw: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(raw.trim())
  if (!m) throw new AuthCliError(`invalid --ttl '${raw}' (use e.g. 10m, 2h, 30d, or seconds)`)
  const mult = m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1_000
  const ms = Number(m[1]) * mult
  if (!Number.isSafeInteger(ms) || ms <= 0)
    throw new AuthCliError(`invalid --ttl '${raw}': must be a positive duration`)
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

type HostRequest = typeof controlRequest

async function askHost(request: HostRequest, path: string, body?: object) {
  try {
    return await request(path, body)
  } catch (error) {
    if (error instanceof Error && /ENOENT|ECONNREFUSED/.test(error.message)) {
      throw new AuthCliError('Podium is not running on this host. Start it and try again.')
    }
    throw new AuthCliError(
      error instanceof Error ? error.message : 'The server refused this request.',
    )
  }
}

async function mintSession(argv: string[], io: AuthCliIo, request: HostRequest): Promise<void> {
  const ttl = flagValue(argv, 'ttl')
  const issued = await askHost(request, '/v1/host-sign-in', ttl ? { ttlMs: parseTtl(ttl) } : {})
  if (typeof issued.code !== 'string')
    throw new AuthCliError('Podium returned no host recovery code.')
  const { token, expiresAt } = await askHost(request, '/v1/host-sign-in/redeem', {
    code: issued.code,
  })
  if (
    typeof token !== 'string' ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new AuthCliError('Podium returned no valid device sign-in.')
  }
  io.print(token)
  if (argv.includes('--print-only')) {
    io.printErr(`Not cached (--print-only). Expires ${expiresAt}.`)
  } else {
    saveCachedSessionToken({ token, expiresAt })
    io.printErr(
      `Cached to ${sessionTokenPath()} — podium commands on this host now carry it.\n` +
        `Expires ${expiresAt}. Revoke with \`podium auth revoke-sessions\`.`,
    )
  }
}

async function showSessions(io: AuthCliIo, request: HostRequest): Promise<void> {
  const answer = await askHost(request, '/v1/sign-ins')
  const parsed = DeviceSignInsResponse.safeParse(answer)
  if (!parsed.success) throw new AuthCliError('Podium returned an invalid sign-in list.')
  const rows = parsed.data.signIns
  if (rows.length === 0) {
    io.print('no device sign-ins')
    return
  }
  const total = typeof answer.total === 'number' ? answer.total : rows.length
  io.print(
    total > rows.length
      ? `showing ${rows.length} of ${total} sign-ins`
      : `${rows.length} sign-in(s)`,
  )
  for (const row of rows) io.print(`  ${row.kind.padEnd(8)}  ${row.id}  expires ${row.expiresAt}`)
}

async function revokeSessions(argv: string[], io: AuthCliIo, request: HostRequest): Promise<void> {
  const kind = DeviceSignInKind.safeParse(flagValue(argv, 'kind') ?? 'host')
  if (!kind.success) throw new AuthCliError('--kind takes browser, desktop, phone or host')
  const answer = await askHost(request, '/v1/sign-ins/revoke', { kind: kind.data })
  if (typeof answer.revoked !== 'number')
    throw new AuthCliError('Podium returned no revoke result.')
  io.print(`revoked ${answer.revoked} '${kind.data}' sign-in(s)`)
}

/** What each `podium auth` command accepts (POD-3836). */
const AUTH_FLAGS = flagTable(declareFlags({ known: [] }), {
  'mint-session': { known: ['ttl'], booleans: ['print-only'] },
  sessions: {},
  'revoke-sessions': { known: ['kind'] },
  'recovery-link': {},
})

export async function authCliMain(
  argv: string[],
  io: AuthCliIo,
  requestRecovery: RecoveryLinkRequest = async (email) =>
    await controlRequest('/v1/member-recovery', { email }),
  requestHost: HostRequest = controlRequest,
): Promise<void> {
  const sub = argv[0]
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    io.print(AUTH_USAGE)
    return
  }
  // Parsed only to REFUSE an undeclared flag (POD-3836); the handlers below read
  // argv directly through `flagValue`.
  withUnknownFlagAs(
    (m) => new AuthCliError(m),
    () =>
      parseFlags(argv.slice(1), AUTH_FLAGS(sub), {
        usage: `podium auth ${sub}`,
        keys: 'raw',
      }),
  )
  if (sub === 'mint-session') return await mintSession(argv.slice(1), io, requestHost)
  if (sub === 'sessions') return await showSessions(io, requestHost)
  if (sub === 'revoke-sessions') return await revokeSessions(argv.slice(1), io, requestHost)
  if (sub === 'recovery-link') return await recoveryLink(argv.slice(1), io, requestRecovery)
  throw new AuthCliError(`unknown command '${sub}'\n\n${AUTH_USAGE}`)
}
