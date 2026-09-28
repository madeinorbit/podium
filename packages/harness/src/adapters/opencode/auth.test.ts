import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectOpencodeLogin } from './auth.js'

async function authHome(auth: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'podium-opencode-auth-'))
  const root = join(home, '.local', 'share', 'opencode')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'auth.json'), JSON.stringify(auth))
  return home
}

describe('OpenCode login detection', () => {
  it('reports configured provider names without exposing credential values', async () => {
    const home = await authHome({
      'opencode-go': { type: 'api', key: 'test-secret' },
      openrouter: { type: 'oauth', access: 'test-access' },
    })
    expect(detectOpencodeLogin(home)).toEqual({
      state: 'in',
      account: 'OpenCode · opencode-go, openrouter',
    })
  })

  it('reports out when the auth file is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-opencode-auth-empty-'))
    expect(detectOpencodeLogin(home)).toEqual({ state: 'out' })
  })

  it('does not treat a provider type without a credential as logged in', async () => {
    const home = await authHome({ 'opencode-go': { type: 'api' } })
    expect(detectOpencodeLogin(home)).toEqual({ state: 'out' })
  })
})
