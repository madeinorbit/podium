/**
 * `podium auth` tests (POD-1376).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCliMain } from './auth-cli'

let dir: string
const out: string[] = []
const err: string[] = []
const io = { print: (s: string) => out.push(s), printErr: (s: string) => err.push(s) }
const stdout = () => out.join('\n')
const stderr = () => err.join('\n')

const TOKEN = 'signed-host-token.signature='
const EXPIRES = '2999-01-01T00:00:00.000Z'
const CODE = 'c'.repeat(43)
const device = (kind: 'browser' | 'host') => ({
  id: kind + '-id',
  kind,
  deviceName: kind,
  platform: 'unknown',
  createdAt: EXPIRES,
  expiresAt: EXPIRES,
  lastSeenAt: null,
  current: false,
})
const requestHost = vi.fn(async (path: string, body?: object): Promise<Record<string, unknown>> => {
  if (path === '/v1/host-sign-in') return { ok: true, code: CODE, expiresAt: EXPIRES }
  if (path === '/v1/host-sign-in/redeem') {
    expect(body).toEqual({ code: CODE })
    return { ok: true, token: TOKEN, expiresAt: EXPIRES }
  }
  if (path === '/v1/sign-ins')
    return { ok: true, signIns: [device('browser'), device('host')], total: 2 }
  if (path === '/v1/sign-ins/revoke') return { ok: true, revoked: 1 }
  throw new Error('Unexpected control request')
})
const auth = (args: string[]) => authCliMain(args, io, undefined, requestHost)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-auth-cli-'))
  process.env.PODIUM_STATE_DIR = dir
  out.length = 0
  err.length = 0
  requestHost.mockClear()
})
afterEach(() => {
  // Do NOT delete PODIUM_STATE_DIR: the hermetic guard runs as a GLOBAL
  // afterEach (test-hermetic-vitest-hooks.ts) and requires it set on the way out
  // too, so clearing it here trips the very protection it exists to give. The
  // temp dir is removed instead, and the next file sets its own.
  rmSync(dir, { recursive: true, force: true })
})

// The token is the only thing on stdout so `TOKEN=$(podium auth mint-session)` works;
// everything a human needs to read goes to stderr.
it('prints the minted token alone on stdout', async () => {
  await auth(['mint-session'])
  expect(stdout()).toBe(TOKEN)
  expect(stderr()).not.toContain(CODE)
  expect(stderr()).toContain('cli-session.json')
})

it('caches the token so later podium calls carry it', async () => {
  await auth(['mint-session'])
  const { resolveSessionToken } = await import('@podium/runtime/session-mint')
  expect(resolveSessionToken({}, dir)).toBe(stdout())
})

it('--print-only leaves no cached credential behind', async () => {
  await auth(['mint-session', '--print-only'])
  const { resolveSessionToken } = await import('@podium/runtime/session-mint')
  expect(stdout()).not.toBe('')
  expect(resolveSessionToken({}, dir)).toBeUndefined()
})

it('honours --ttl', async () => {
  await auth(['mint-session', '--ttl', '10m'])
  expect(requestHost.mock.calls).toEqual([
    ['/v1/host-sign-in', { ttlMs: 600_000 }],
    ['/v1/host-sign-in/redeem', { code: CODE }],
  ])
})

it('rejects an unparseable --ttl instead of silently defaulting', async () => {
  await expect(auth(['mint-session', '--ttl', 'soon'])).rejects.toThrow(/--ttl/)
})

it('explains itself when there is no instance to mint against', async () => {
  requestHost.mockRejectedValueOnce(new Error('connect ENOENT'))
  await expect(auth(['mint-session'])).rejects.toThrow(/not running on this host/)
})

it('lists sign-ins by kind without printing a usable credential', async () => {
  await auth(['mint-session', '--print-only'])
  const token = stdout()
  out.length = 0
  await auth(['sessions'])
  expect(stdout()).toContain('host-id')
  expect(stdout()).toContain('browser-id')
  expect(stdout()).not.toContain(token)
})

it('revokes only host sign-ins by default', async () => {
  await auth(['revoke-sessions'])
  expect(requestHost.mock.calls).toEqual([['/v1/sign-ins/revoke', { kind: 'host' }]])
  expect(stdout()).toContain("revoked 1 'host' sign-in")
})

it('refuses an unknown subcommand rather than doing something else', async () => {
  await expect(authCliMain(['mint'], io)).rejects.toThrow(/unknown/)
})

describe('unknown flags on podium auth (POD-3836)', () => {
  const io = { print: () => {}, printErr: () => {} }

  it('refuses a flag no auth command declares', async () => {
    await expect(authCliMain(['mint-session', '--forever'], io)).rejects.toThrow(
      /unknown flag --forever/,
    )
  })

  it('refuses a flag that belongs to another auth command', async () => {
    // --label is revoke-sessions'; on mint-session it did nothing.
    await expect(authCliMain(['mint-session', '--label', 'x'], io)).rejects.toThrow(
      /unknown flag --label/,
    )
  })
})

describe('recovery-link (POD-6298)', () => {
  it('asks the running server for a link and prints it alone on stdout', async () => {
    const asked: string[] = []
    await authCliMain(['recovery-link', 'bob@example.com'], io, async (email) => {
      asked.push(email)
      return {
        ok: true,
        url: 'https://podium.example/#invite=tok',
        expiresAt: '2026-11-05T00:00:00Z',
      }
    })
    expect(asked).toEqual(['bob@example.com'])
    expect(stdout()).toBe('https://podium.example/#invite=tok')
    expect(stderr()).toContain('Single use')
  })

  it('needs an email and reports a refusal', async () => {
    await expect(authCliMain(['recovery-link'], io, async () => ({}))).rejects.toThrow(/usage/)
    await expect(
      authCliMain(['recovery-link', 'nobody@example.com'], io, async () => {
        throw new Error('No enabled member has that email')
      }),
    ).rejects.toThrow(/No enabled member/)
  })
})
