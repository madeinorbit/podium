import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexHookTrustFlag, codexSessionFlagHookHashes } from '@podium/harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexHookTrust } from './codex-hook-trust'

const INSTALL_A = {
  kind: 'codex' as const,
  executable: '/usr/bin/codex',
  version: 'codex-cli 0.169.0',
  generation: 1,
}
const INSTALL_B = { ...INSTALL_A, version: 'codex-cli 0.170.0' }
const FLAGS = ['-c', 'hooks.SessionStart=[{hooks=[{type="command",command="x"}]}]']
const KEY = '/<session-flags>/config.toml:session_start:0:0'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-hook-trust-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function trust(probe: (probeHome: string) => Promise<Record<string, string>>) {
  const calls: string[] = []
  const cleaned: string[] = []
  const cache = new CodexHookTrust({
    root,
    probe: async ({ probeHome, installation }) => {
      calls.push(installation.version)
      expect(existsSync(probeHome)).toBe(true)
      return await probe(probeHome)
    },
    cleanProbeHome: async (probeHome) => {
      cleaned.push(probeHome)
      rmSync(probeHome, { recursive: true, force: true })
    },
  })
  return { cache, calls, cleaned }
}

describe('CodexHookTrust', () => {
  it('reads Codex’s hash once per version and flag text, and keeps it across restarts', async () => {
    const first = trust(async () => ({ [KEY]: 'sha256:aaa' }))
    expect(await first.cache.trustFor(INSTALL_A, FLAGS)).toEqual({ [KEY]: 'sha256:aaa' })
    expect(await first.cache.trustFor(INSTALL_A, FLAGS)).toEqual({ [KEY]: 'sha256:aaa' })
    expect(first.calls).toEqual(['codex-cli 0.169.0'])
    // The throwaway home (and Codex's 400 MB copy in it) never stays.
    expect(first.cleaned).toHaveLength(1)
    expect(existsSync(first.cleaned[0] as string)).toBe(false)

    const restarted = trust(async () => ({ [KEY]: 'sha256:other' }))
    expect(await restarted.cache.trustFor(INSTALL_A, FLAGS)).toEqual({ [KEY]: 'sha256:aaa' })
    expect(restarted.calls).toEqual([])
    expect(await restarted.cache.trustFor(INSTALL_B, FLAGS)).toEqual({ [KEY]: 'sha256:other' })
    expect(restarted.calls).toEqual(['codex-cli 0.170.0'])
  })

  it('two launches at once share one probe', async () => {
    const { cache, calls } = trust(async () => ({ [KEY]: 'sha256:aaa' }))
    await Promise.all([cache.trustFor(INSTALL_A, FLAGS), cache.trustFor(INSTALL_A, FLAGS)])
    expect(calls).toHaveLength(1)
  })

  it('a failed or empty probe gives no trust and is asked again next time', async () => {
    let attempt = 0
    const { cache, calls, cleaned } = trust(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('codex app-server exited')
      if (attempt === 2) return {}
      return { [KEY]: 'sha256:aaa' }
    })
    expect(await cache.trustFor(INSTALL_A, FLAGS)).toBeUndefined()
    expect(await cache.trustFor(INSTALL_A, FLAGS)).toBeUndefined()
    expect(await cache.trustFor(INSTALL_A, FLAGS)).toEqual({ [KEY]: 'sha256:aaa' })
    expect(calls).toHaveLength(3)
    expect(cleaned).toHaveLength(3)
  })
})

describe('Codex launch-hook helpers', () => {
  it('reads only flag-supplied hooks out of hooks/list', () => {
    const hashes = codexSessionFlagHookHashes({
      data: [
        {
          cwd: '/x',
          hooks: [
            { key: KEY, source: 'sessionFlags', currentHash: 'sha256:aaa' },
            { key: '/home/x/hooks.json:stop:0:0', source: 'user', currentHash: 'sha256:user' },
          ],
        },
      ],
    })
    expect(hashes).toEqual({ [KEY]: 'sha256:aaa' })
  })

  it('writes trust as one inline table, the form Codex addresses', () => {
    expect(codexHookTrustFlag({ [KEY]: 'sha256:aaa' })).toEqual([
      '-c',
      `hooks.state={"${KEY}"={trusted_hash="sha256:aaa"}}`,
    ])
    expect(codexHookTrustFlag({})).toEqual([])
  })
})
