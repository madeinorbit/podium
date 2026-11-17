import { asCredentialId, asMachineId, asUserId } from '@podium/model'
import { CAP_HARNESS_HOMES } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { CredentialRecord, PlacementRecord } from '../../store/credentials'
import { HOME_SIGN_OUT_ON_REMOVE, homeHarnessFor, placementRemovers } from './home-removers'

const MACHINE = asMachineId('machine-1')

function record(type: string, fingerprint?: string): CredentialRecord {
  return {
    id: asCredentialId('cred_ffffffff-0000-4000-8000-000000000006'),
    ownerUserId: asUserId('user-1'),
    label: 'login',
    type,
    identity: fingerprint ? { fingerprint } : {},
    status: 'ok',
    statusReason: null,
    expiresAt: null,
    verifiedAt: null,
    limitReachedUntil: null,
    legacyId: null,
    legacyKey: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
  }
}

const REF = (credential: CredentialRecord, homeId?: string): PlacementRecord => ({
  credentialId: credential.id,
  machineId: MACHINE,
  kind: 'home',
  ...(homeId ? { homeId } : {}),
})

function fakes(
  over: { supports?: boolean; outcome?: string; homeOk?: boolean; signOut?: boolean } = {},
) {
  const calls: string[] = []
  const removers = placementRemovers({
    ...(over.signOut !== undefined ? { signOut: over.signOut } : {}),
    daemonSupports: (_machineId, cap) => cap === CAP_HARNESS_HOMES && (over.supports ?? true),
    rpc: {
      credentialRemove: async (harness, fingerprint) => {
        calls.push(`credentialRemove:${harness}:${fingerprint}`)
        return { outcome: (over.outcome ?? 'removed') as 'removed' }
      },
      homeRemove: async (homeId, _machineId, options) => {
        calls.push(`homeRemove:${homeId}${options?.signOut ? ':signOut' : ''}`)
        return over.homeOk === false ? { ok: false, error: 'no' } : { ok: true, removed: true }
      },
    },
  })
  return { removers, calls }
}

describe('homeHarnessFor', () => {
  it('maps a subscription login to the harness whose home holds it', () => {
    expect(homeHarnessFor('anthropic.claude-login')).toBe('claude-code')
    expect(homeHarnessFor('openai.chatgpt-login')).toBe('codex')
    expect(homeHarnessFor('anthropic.api-key')).toBeUndefined()
  })
})

describe('placementRemovers', () => {
  it('asks the daemon to remove a propagated login file by its fingerprint, and confirms on removed, absent or changed', async () => {
    for (const outcome of ['removed', 'absent', 'changed']) {
      const { removers, calls } = fakes({ outcome })
      expect(
        await removers['propagated-file']?.(MACHINE, record('openai.chatgpt-login', 'fp-1'), { ...REF(record('openai.chatgpt-login', 'fp-1')), kind: 'propagated-file' }),
      ).toBe(true)
      expect(calls).toEqual(['credentialRemove:codex:fp-1'])
    }
  })

  it('keeps the placement pending when the daemon failed, is too old, or there is no fingerprint', async () => {
    expect(
      await fakes({ outcome: 'failed' }).removers['propagated-file']?.(MACHINE, record('anthropic.claude-login', 'fp'), { ...REF(record('anthropic.claude-login', 'fp')), kind: 'propagated-file' }),
    ).toBe(false)
    const old = fakes({ supports: false })
    expect(
      await old.removers['propagated-file']?.(MACHINE, record('anthropic.claude-login', 'fp'), { ...REF(record('anthropic.claude-login', 'fp')), kind: 'propagated-file' }),
    ).toBe(false)
    expect(old.calls).toEqual([])
    const blind = fakes()
    expect(
      await blind.removers['propagated-file']?.(MACHINE, record('anthropic.claude-login'), { ...REF(record('anthropic.claude-login')), kind: 'propagated-file' }),
    ).toBe(false)
    expect(blind.calls).toEqual([])
  })

  it('removes the credential’s home on the machine', async () => {
    const { removers, calls } = fakes()
    expect(await removers.home?.(MACHINE, record('anthropic.claude-login', 'fp'), REF(record('anthropic.claude-login', 'fp')))).toBe(true)
    expect(calls).toEqual(['homeRemove:cred_ffffffff-0000-4000-8000-000000000006:claude-code'])
    expect(
      await fakes({ homeOk: false }).removers.home?.(MACHINE, record('anthropic.claude-login'), REF(record('anthropic.claude-login'))),
    ).toBe(false)
    expect(
      await fakes({ supports: false }).removers.home?.(MACHINE, record('anthropic.claude-login'), REF(record('anthropic.claude-login'))),
    ).toBe(false)
  })

  it('removes the home its placement recorded, which a sign-in for another credential made (Task 9)', async () => {
    const { removers, calls } = fakes()
    const credential = record('anthropic.claude-login', 'fp')
    expect(await removers.home?.(MACHINE, credential, REF(credential, 'cred_other:claude-code'))).toBe(
      true,
    )
    expect(calls).toEqual(['homeRemove:cred_other:claude-code'])
  })

  it('runs no vendor sign-out unless switched on, and asks for it when it is (Task 9 item 6)', async () => {
    expect(HOME_SIGN_OUT_ON_REMOVE).toBe(false)
    const credential = record('openai.chatgpt-login', 'fp')
    const off = fakes()
    await off.removers.home?.(MACHINE, credential, REF(credential))
    expect(off.calls).toEqual([`homeRemove:${credential.id}:codex`])
    const on = fakes({ signOut: true })
    await on.removers.home?.(MACHINE, credential, REF(credential))
    expect(on.calls).toEqual([`homeRemove:${credential.id}:codex:signOut`])
  })

  it('has nothing to remove for a credential no home holds', async () => {
    const { removers, calls } = fakes()
    expect(await removers.home?.(MACHINE, record('anthropic.api-key', 'fp'), REF(record('anthropic.api-key', 'fp')))).toBe(false)
    expect(await removers['propagated-file']?.(MACHINE, record('anthropic.api-key', 'fp'), { ...REF(record('anthropic.api-key', 'fp')), kind: 'propagated-file' })).toBe(
      false,
    )
    expect(calls).toEqual([])
  })
})
