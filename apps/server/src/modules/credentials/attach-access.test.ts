/**
 * THE STEP THAT SENDS A SECRET TO A DAEMON (credential management §8, epic
 * plan Task 5, acceptance 1–4).
 *
 * `attachAccess` refuses before the vault is read: a daemon that did not offer
 * `CAP_SESSION_ACCESS`, a `plain` connection, a machine with no daemon. The
 * vault's `open` is spied on, so "not read" is observed, not assumed. Every
 * serialized result is searched for the planted secret after a canary proves
 * the search finds it where it is meant to be.
 */

import { asMachineId, asSessionId, asUserId, type CredentialId } from '@podium/model'
import { CAP_SESSION_ACCESS } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonLinkKind } from '../../gateway/daemon-link-kind'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { ACCESS_REFUSAL_MESSAGES, type SessionAccess } from './access'
import { type AttachAccessDeps, attachAccess } from './attach-access'
import { sealCredentialSecret } from './vault'

const OWNER = asUserId('user:attach-owner')
const MACHINE = asMachineId('machine-attach')
const SESSION = asSessionId('00000000-0000-4000-8000-0000000000a5')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-attach-secret-0005'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function withVaultCredential(): Promise<{ s: SessionStore; id: CredentialId }> {
  store = await openTestStore(':memory:')
  const record = await store.credentials.insert({
    ownerUserId: OWNER,
    label: 'key',
    type: 'anthropic.api-key',
  })
  expect(await sealCredentialSecret(store, record, PLANTED, 0)).toBe(1)
  return { s: store, id: record.id }
}

function daemon(
  s: SessionStore,
  live: { caps: string[]; link: DaemonLinkKind } | undefined,
): AttachAccessDeps {
  return {
    store: s,
    daemonSupports: (_machine, cap) => live?.caps.includes(cap) === true,
    daemonLinkKind: async () => live?.link,
  }
}

const envPlan = (id: CredentialId): SessionAccess => ({
  ok: true,
  credentialId: id,
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY' },
})

const to = { machineId: MACHINE, sessionId: SESSION, actingUserId: OWNER }

async function events(s: SessionStore, kind: 'refuse' | 'deliver'): Promise<string[]> {
  const rows = await s.settingsAudit.list(100)
  return rows
    .filter((row) => row.command === `credentials.${kind}`)
    .map((row) => JSON.stringify(row))
}

describe('attachAccess', () => {
  it('hands over the secret to a capable daemon on a safe link (canary for the search)', async () => {
    const { s, id } = await withVaultCredential()
    const result = await attachAccess(
      daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'encrypted' }),
      envPlan(id),
      to,
    )
    expect(result).toEqual({
      ok: true,
      access: {
        credentialId: id,
        delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
      },
    })
    expect(JSON.stringify(result)).toContain(PLANTED)
    // A delivery is on the trail, and the trail never holds the secret.
    const delivered = await events(s, 'deliver')
    expect(delivered).toHaveLength(1)
    expect(delivered.join('\n')).not.toContain(PLANTED)
  })

  it('older daemon: daemon-too-old, and the vault is never opened (acceptance 1)', async () => {
    const { s, id } = await withVaultCredential()
    const open = vi.spyOn(s.vault, 'open')
    const result = await attachAccess(daemon(s, { caps: [], link: 'encrypted' }), envPlan(id), to)
    expect(result).toEqual({
      ok: false,
      refusal: 'daemon-too-old',
      message: ACCESS_REFUSAL_MESSAGES['daemon-too-old'],
    })
    expect(open).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(PLANTED)
    expect(await events(s, 'refuse')).toHaveLength(1)
  })

  it('plain connection: connection-not-encrypted, vault not opened; trusted receives it (acceptance 2)', async () => {
    const { s, id } = await withVaultCredential()
    const open = vi.spyOn(s.vault, 'open')
    const plain = await attachAccess(
      daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'plain' }),
      envPlan(id),
      to,
    )
    expect(plain).toMatchObject({ ok: false, refusal: 'connection-not-encrypted' })
    expect(open).not.toHaveBeenCalled()
    expect(JSON.stringify(plain)).not.toContain(PLANTED)
    for (const link of ['trusted', 'local', 'encrypted'] as const) {
      const ok = await attachAccess(
        daemon(s, { caps: [CAP_SESSION_ACCESS], link }),
        envPlan(id),
        to,
      )
      expect(ok).toMatchObject({ ok: true, access: { delivery: { secret: PLANTED } } })
    }
  })

  it('no credential: no field, on an older daemon and on a plain link (acceptance 3)', async () => {
    store = await openTestStore(':memory:')
    const none: SessionAccess = {
      ok: true,
      credentialId: null,
      delivery: { kind: 'home', homeId: 'default' },
    }
    for (const live of [
      { caps: [], link: 'plain' as const },
      { caps: [CAP_SESSION_ACCESS], link: 'plain' as const },
      undefined,
    ]) {
      expect(await attachAccess(daemon(store, live), none, to)).toEqual({ ok: true })
    }
  })

  it('a home other than default needs the capability; no secret is read (acceptance 4)', async () => {
    const { s, id } = await withVaultCredential()
    const open = vi.spyOn(s.vault, 'open')
    const home: SessionAccess = {
      ok: true,
      credentialId: id,
      delivery: { kind: 'home', homeId: 'h1' },
    }
    expect(await attachAccess(daemon(s, { caps: [], link: 'encrypted' }), home, to)).toMatchObject({
      ok: false,
      refusal: 'daemon-too-old',
    })
    expect(
      await attachAccess(daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'plain' }), home, to),
    ).toEqual({ ok: true, access: { credentialId: id, delivery: { kind: 'home', homeId: 'h1' } } })
    expect(open).not.toHaveBeenCalled()
  })

  it('the default home with a credential: a field for a capable daemon, none for an older one', async () => {
    const { s, id } = await withVaultCredential()
    const home: SessionAccess = {
      ok: true,
      credentialId: id,
      delivery: { kind: 'home', homeId: 'default' },
    }
    expect(await attachAccess(daemon(s, { caps: [], link: 'plain' }), home, to)).toEqual({
      ok: true,
    })
    expect(
      await attachAccess(daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'plain' }), home, to),
    ).toEqual({
      ok: true,
      access: { credentialId: id, delivery: { kind: 'home', homeId: 'default' } },
    })
  })

  it('no daemon connected: machine-offline, vault not opened', async () => {
    const { s, id } = await withVaultCredential()
    const open = vi.spyOn(s.vault, 'open')
    expect(await attachAccess(daemon(s, undefined), envPlan(id), to)).toEqual({
      ok: false,
      refusal: 'machine-offline',
      message: ACCESS_REFUSAL_MESSAGES['machine-offline'],
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('a refused plan passes through unchanged', async () => {
    store = await openTestStore(':memory:')
    const refused: SessionAccess = {
      ok: false,
      refusal: 'not-yours',
      message: ACCESS_REFUSAL_MESSAGES['not-yours'],
    }
    expect(await attachAccess(daemon(store, undefined), refused, to)).toBe(refused)
  })

  it('a removed secret is refused, never sent empty', async () => {
    const { s, id } = await withVaultCredential()
    await s.credentials.remove(id)
    expect(
      await attachAccess(daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'local' }), envPlan(id), to),
    ).toMatchObject({ ok: false, refusal: 'revoked' })
  })
})

describe('attachAccess for a type Podium renews (the ChatGPT plan, epic Task 15)', () => {
  /** Obviously fake: the sealed token set, and the token the keeper issues. */
  const SEALED_SET = JSON.stringify({ accessToken: 'tok-FAKE-sealed-in-set', refreshToken: 'x' })
  const ISSUED = 'tok-FAKE-issued-access-0015'

  async function withPlan(): Promise<{ s: SessionStore; id: CredentialId }> {
    store = await openTestStore(':memory:')
    const record = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'ChatGPT',
      type: 'openai.chatgpt-plan',
    })
    expect(await sealCredentialSecret(store, record, SEALED_SET, 0)).toBe(1)
    return { s: store, id: record.id }
  }

  const planPlan = (id: CredentialId): SessionAccess => ({
    ok: true,
    credentialId: id,
    delivery: { kind: 'env', variable: 'ACCESS_TOKEN' },
  })

  it('delivers the token the keeper issues, never the sealed token set', async () => {
    const { s, id } = await withPlan()
    const asked: unknown[] = []
    const result = await attachAccess(
      {
        ...daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'encrypted' }),
        issueToken: async (credentialId, target) => {
          asked.push({ credentialId, target })
          return { secret: ISSUED, expiresAt: Date.now() + 3600_000 }
        },
      },
      planPlan(id),
      { ...to, refresh: true },
    )
    expect(result).toEqual({
      ok: true,
      access: {
        credentialId: id,
        delivery: { kind: 'env', variable: 'ACCESS_TOKEN', secret: ISSUED },
      },
    })
    expect(asked).toEqual([{ credentialId: id, target: { ...to, refresh: true } }])
    // Canary, then the search: the sealed set's token is not in the result.
    expect(JSON.stringify(result)).toContain(ISSUED)
    expect(JSON.stringify(result)).not.toContain('tok-FAKE-sealed-in-set')
    expect(await events(s, 'deliver')).toHaveLength(1)
  })

  it('a refusal from the keeper is the launch refusal, on the trail', async () => {
    const { s, id } = await withPlan()
    const refusing = Object.assign(new Error(ACCESS_REFUSAL_MESSAGES['needs-attention']), {
      refusal: 'needs-attention',
    })
    const result = await attachAccess(
      {
        ...daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'local' }),
        issueToken: async () => {
          throw refusing
        },
      },
      planPlan(id),
      to,
    )
    expect(result).toMatchObject({ ok: false, refusal: 'needs-attention' })
    expect(await events(s, 'refuse')).toHaveLength(1)
  })

  it('with no issuer bound, the plan is refused rather than sent as stored', async () => {
    const { s, id } = await withPlan()
    const result = await attachAccess(
      daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'local' }),
      planPlan(id),
      to,
    )
    expect(result).toMatchObject({ ok: false, refusal: 'needs-attention' })
  })

  it('the keeper is asked only after the link checks: a plain link never issues a token', async () => {
    const { s, id } = await withPlan()
    let issued = 0
    const result = await attachAccess(
      {
        ...daemon(s, { caps: [CAP_SESSION_ACCESS], link: 'plain' }),
        issueToken: async () => {
          issued += 1
          return { secret: ISSUED, expiresAt: 0 }
        },
      },
      planPlan(id),
      to,
    )
    expect(result).toMatchObject({ ok: false, refusal: 'connection-not-encrypted' })
    expect(issued).toBe(0)
  })
})
