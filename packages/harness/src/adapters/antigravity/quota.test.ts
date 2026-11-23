import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessAccount } from '../../harness-context.js'
import type { LoginCommandResult } from '../../manifest.js'
import { antigravityCredentialIdentity } from './credentials.js'
import { ANTIGRAVITY_HOME } from './paths.js'
import {
  fetchAntigravityQuota,
  parseAntigravityCreditReport,
  parseAntigravityQuotaReport,
} from './quota.js'

const usage = readFileSync(new URL('./__fixtures__/quota-usage.json', import.meta.url), 'utf8')
const credits = readFileSync(new URL('./__fixtures__/quota-credits.json', import.meta.url), 'utf8')
const result = (
  stdout = usage,
  overrides: Partial<LoginCommandResult> = {},
): LoginCommandResult => ({ stdout, stderr: '', exitCode: 0, timedOut: false, ...overrides })
const report = (groups: unknown[]) =>
  result(
    JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: { name: 'usage', data: { groups } },
    }),
  )
const bucket = (overrides = {}) => ({
  id: 'fixture-5h',
  name: 'Five Hour Limit Remaining',
  window: '5h',
  remaining_fraction: 0.8,
  reset_time: '2026-11-23T17:00:00Z',
  ...overrides,
})
const now = Date.parse('2026-11-23T12:00:00Z')
const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scope(signedIn = true, token = {}) {
  const root = await mkdtemp(join(tmpdir(), 'podium-google-quota-test-'))
  temporary.push(root)
  const gemini = join(root, 'account')
  const account = harnessAccount('antigravity', root, {
    HOME: root,
    PATH: '/account/bin',
    [ANTIGRAVITY_HOME]: gemini,
  })
  const file = join(gemini, 'antigravity-cli', 'antigravity-oauth-token')
  if (signedIn) {
    await mkdir(join(gemini, 'antigravity-cli'), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        auth_method: 'consumer',
        email: 'person@example.com',
        token: {
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          expiry: '2000-01-01T00:00:00Z',
          ...token,
        },
      }),
    )
  }
  return account
}

describe('native Antigravity quota reports', () => {
  it('normalizes the real zero-turn CLI report into independent model pools and exact reset times', () => {
    const windows = parseAntigravityQuotaReport(result())
    expect(
      windows.map((window) => [window.key, window.usedPercent, window.pool, window.windowMinutes]),
    ).toEqual([
      ['gemini-weekly', 40, 'Gemini Models', 10080],
      ['gemini-5h', 25, 'Gemini Models', 300],
      ['3p-weekly', 60, 'Claude and GPT models', 10080],
      ['3p-5h', 50, 'Claude and GPT models', 300],
    ])
    expect(windows[0]?.resetsAt).toBe('2026-11-30T12:00:00.000Z')
    expect(parseAntigravityCreditReport(result(credits))).toEqual({ remaining: 1250 })
  })

  it('preserves unfamiliar native groups without inventing a window duration or reset', () => {
    expect(
      parseAntigravityQuotaReport(
        report([
          {
            name: 'Future model family',
            buckets: [
              bucket({ id: 'future', window: 'future', name: 'Burst', reset_time: 'unknown' }),
            ],
          },
        ]),
      ),
    ).toEqual([
      {
        key: 'future',
        label: 'Future model family · Burst',
        pool: 'Future model family',
        usedPercent: 20,
        resetsAt: '',
        windowMinutes: 0,
      },
    ])
  })

  it('keeps genuinely full and untouched buckets while omitting disabled and unmeasured ones', () => {
    const windows = parseAntigravityQuotaReport(
      report([
        {
          name: 'Models',
          buckets: [
            bucket({ id: 'empty', remaining_fraction: 0 }),
            bucket({ id: 'full', remaining_fraction: 1 }),
            bucket({ id: 'disabled', disabled: true }),
            bucket({ id: 'missing', remaining_fraction: undefined }),
            bucket({ id: 'string', remaining_fraction: '0.5' }),
            bucket({ id: 'overflow', remaining_fraction: 2 }),
          ],
        },
        { name: 'Disabled group', disabled: true, buckets: [bucket()] },
      ]),
    )
    expect(windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ['empty', 100],
      ['full', 0],
    ])
  })

  it.each([
    result('not-json'),
    result(usage, { exitCode: 1 }),
    result(usage, { timedOut: true }),
    result(usage, { errorCode: 'ERR_QUOTA_OUTPUT_LIMIT' }),
    result(usage.replace('"SUCCESS"', '"ERROR"')),
    result(usage.replace('"usage",', '"models",')),
    result(usage.replace('"num_turns": 0', '"num_turns": 1')),
  ])('rejects incomplete or unrelated reports instead of accepting their percentages', (value) => {
    expect(parseAntigravityQuotaReport(value)).toEqual([])
  })

  it('deduplicates a shared native bucket using the more constrained observation', () => {
    const windows = parseAntigravityQuotaReport(
      report([{ name: 'Shared', buckets: [bucket(), bucket({ remaining_fraction: 0.1 })] }]),
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]?.usedPercent).toBe(90)
  })

  it('accepts zero AI credits, and never parses a balance from human response text', () => {
    const zero = JSON.parse(credits)
    zero.command.data.remaining_credits = 0
    expect(parseAntigravityCreditReport(result(JSON.stringify(zero)))).toEqual({ remaining: 0 })
    zero.command.data = {}
    zero.response = '1250 AI credits'
    expect(parseAntigravityCreditReport(result(JSON.stringify(zero)))).toBeUndefined()
  })
})

describe('account-scoped Antigravity quota fetch', () => {
  it('reads a refreshable Google account through only the two fixed native report commands', async () => {
    const account = await scope()
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(credits))
    expect(await fetchAntigravityQuota({ account, now, runCommand })).toMatchObject({
      status: 'ok',
      account: { email: 'person@example.com' },
      credits: { remaining: 1250 },
      fetchedAt: '2026-11-23T12:00:00.000Z',
    })
    const args = runCommand.mock.calls.map(([request]) => request.args('/private-quota'))
    expect(args.map((argv) => argv.slice(-4))).toEqual([
      ['--print', '/usage', '--output-format', 'json'],
      ['--print', '/credits', '--output-format', 'json'],
    ])
    expect(args[0]?.slice(0, 4)).toEqual([
      '--gemini_dir',
      '/private-quota',
      '--app_data_dir',
      'account-state',
    ])
    expect(runCommand.mock.calls[0]?.[0].linkedDirectories).toEqual({
      'account-state': account.roots.state,
    })
    expect(JSON.stringify(args)).not.toContain('synthetic-')
  })

  it('does not start the CLI for a signed-out or expired unrefreshable account', async () => {
    const runCommand = vi.fn()
    expect(
      (await fetchAntigravityQuota({ account: await scope(false), now, runCommand })).status,
    ).toBe('unauthenticated')
    expect(
      (
        await fetchAntigravityQuota({
          account: await scope(true, { refresh_token: '' }),
          now,
          runCommand,
        })
      ).status,
    ).toBe('expired')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('requires the selected installation instead of resolving an ambient agy', async () => {
    expect(await fetchAntigravityQuota({ account: await scope(), now })).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Install Antigravity CLI'),
    })
  })

  it('keeps plan windows when native credits are unavailable', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error('credits unavailable'))
    const wire = await fetchAntigravityQuota({ account: await scope(), now, runCommand })
    expect(wire.status).toBe('ok')
    expect(wire.windows).toHaveLength(4)
    expect(wire.credits).toBeUndefined()
  })

  it('reports an authentication failure without publishing native OAuth links or secrets', async () => {
    const runCommand = vi.fn().mockResolvedValue(
      result(
        JSON.stringify({
          error: 'invalid_grant https://accounts.google.com/?code=private-native-code',
        }),
        { exitCode: 1 },
      ),
    )
    const wire = await fetchAntigravityQuota({ account: await scope(), now, runCommand })
    expect(wire.status).toBe('expired')
    expect(wire.windows).toEqual([])
    expect(JSON.stringify(wire)).not.toContain('private-native-code')
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('does not present missing native quotas as unused capacity', async () => {
    const wire = await fetchAntigravityQuota({
      account: await scope(),
      now,
      runCommand: vi.fn().mockResolvedValue(report([])),
    })
    expect(wire.status).toBe('error')
    expect(wire.windows).toEqual([])
  })

  it('recognizes native go-keyring base64 envelopes without changing identity', () => {
    const raw = JSON.stringify({
      email: 'person@example.com',
      token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
    })
    expect(
      antigravityCredentialIdentity(`go-keyring-base64:${Buffer.from(raw).toString('base64')}`),
    ).toEqual(antigravityCredentialIdentity(raw))
  })

  it('reads Google identity claims from the native top-level ID token', () => {
    const claims = Buffer.from(
      JSON.stringify({ email: 'person@example.com', sub: 'fixture-user' }),
    ).toString('base64url')
    expect(
      antigravityCredentialIdentity(
        JSON.stringify({
          auth_method: 'consumer',
          id_token: `header.${claims}.signature`,
          token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' },
        }),
      ),
    ).toMatchObject({ email: 'person@example.com', providerAccountId: 'fixture-user' })
  })
})
