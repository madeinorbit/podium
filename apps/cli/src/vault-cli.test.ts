import { describe, expect, it, vi } from 'vitest'
import { renderVaultStatus, runVaultCli, VaultCliError, type VaultClient } from './vault-cli'

function client(): VaultClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    vault: {
      status: {
        query: vi.fn(async () => {
          calls.push('status')
          return {
            keyPath: '/home/someone/.config/podium/vault-default.key',
            keyId: null,
            state: 'locked' as const,
            problem:
              'The vault key file /home/someone/.config/podium/vault-default.key is missing.',
          }
        }),
      },
      reset: {
        mutate: vi.fn(async (input: { confirm: true }) => {
          calls.push(`reset:${JSON.stringify(input)}`)
          return { needsAttention: 3, state: 'empty' }
        }),
      },
    },
  }
}

describe('podium vault', () => {
  it('status renders the state, the key file and the problem', async () => {
    const c = client()
    const text = await runVaultCli(['status'], c)
    expect(text).toContain('LOCKED')
    expect(text).toContain('/home/someone/.config/podium/vault-default.key')
    expect(text).toContain('is missing')
    expect(JSON.parse(await runVaultCli(['status', '--json'], c))).toMatchObject({
      command: 'vault status',
      ok: true,
      data: { state: 'locked' },
    })
  })

  it('reset without --confirm is refused before the server is asked', async () => {
    const c = client()
    await expect(runVaultCli(['reset'], c)).rejects.toThrow(VaultCliError)
    await expect(runVaultCli(['reset'], c)).rejects.toThrow(/--confirm/)
    expect(c.calls).toEqual([])
  })

  it('reset --confirm asks the server with the confirmation', async () => {
    const c = client()
    expect(await runVaultCli(['reset', '--confirm'], c)).toBe(
      'Vault reset. 3 credential(s) need to be added again.',
    )
    expect(c.calls).toEqual(['reset:{"confirm":true}'])
  })

  it('refuses an unknown argument or command', async () => {
    const c = client()
    await expect(runVaultCli(['status', '--confirm'], c)).rejects.toThrow(/unknown argument/)
    await expect(runVaultCli(['rotate'], c)).rejects.toThrow(/unknown command/)
    expect(c.calls).toEqual([])
  })

  it('renders an empty vault without a key id', () => {
    expect(
      renderVaultStatus({ keyPath: '/k', keyId: null, state: 'empty', problem: null }),
    ).not.toContain('Key id')
  })
})
