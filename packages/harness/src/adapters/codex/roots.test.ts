import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCodexQuota, scanCodexQuotaHistory, scanCodexUsage } from './usage.js'

/**
 * Usage and quota follow the ONE Codex folder rule (POD-6532): a CODEX_HOME
 * in the account env the caller passes relocates them, exactly as it relocates
 * the session child; the daemon's own CODEX_HOME never does.
 */
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function idToken(email: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ email })}.sig`
}

async function codexFolder(folder: string, label: string): Promise<void> {
  const day = join(folder, 'sessions', '2026', '01', '01')
  await mkdir(day, { recursive: true })
  await writeFile(
    join(folder, 'auth.json'),
    JSON.stringify({
      tokens: { access_token: `token-${label}`, id_token: idToken(`${label}@example.test`) },
    }),
  )
  const at = new Date().toISOString()
  await writeFile(
    join(day, `rollout-${label}.jsonl`),
    [
      { type: 'turn_context', payload: { model: 'gpt-fixture' } },
      {
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
          rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 2e9 } },
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  )
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'codex-roots-'))
  roots.push(root)
  const home = join(root, 'home')
  const selected = join(root, 'selected-codex')
  const decoy = join(root, 'decoy-codex')
  await codexFolder(join(home, '.codex'), 'default')
  await codexFolder(selected, 'selected')
  await codexFolder(decoy, 'decoy')
  return { home, selected, decoy }
}

async function quotaBearer(opts: Parameters<typeof fetchCodexQuota>[0]): Promise<string> {
  let bearer = ''
  await fetchCodexQuota({
    ...opts,
    fetchImpl: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      bearer = init?.headers?.Authorization ?? ''
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch,
  })
  return bearer
}

describe('Codex usage and quota roots', () => {
  it('honour CODEX_HOME in the env they are given', async () => {
    const { home, selected } = await world()
    const env = { CODEX_HOME: selected }
    expect(await quotaBearer({ homeDir: home, env })).toBe('Bearer token-selected')
    const scans = await scanCodexUsage({ sinceMs: 0, homeDir: home, env })
    expect(scans.map((scan) => scan.path)).toEqual([
      join(selected, 'sessions', '2026', '01', '01', 'rollout-selected.jsonl'),
    ])
    const samples = await scanCodexQuotaHistory({ sinceMs: 0, machineId: 'm', homeDir: home, env })
    expect(samples.map((sample) => sample.email)).toEqual(['selected@example.test'])
  })

  it("never follow the daemon's own CODEX_HOME (guard)", async () => {
    const { home, decoy } = await world()
    vi.stubEnv('CODEX_HOME', decoy)
    expect(await quotaBearer({ homeDir: home })).toBe('Bearer token-default')
    const scans = await scanCodexUsage({ sinceMs: 0, homeDir: home })
    expect(scans.map((scan) => scan.path)).toEqual([
      join(home, '.codex', 'sessions', '2026', '01', '01', 'rollout-default.jsonl'),
    ])
    const samples = await scanCodexQuotaHistory({ sinceMs: 0, machineId: 'm', homeDir: home })
    expect(samples.map((sample) => sample.email)).toEqual(['default@example.test'])
  })
})
