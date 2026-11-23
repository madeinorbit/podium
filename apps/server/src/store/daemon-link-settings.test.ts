/**
 * THE TRUSTED NETWORKS ARE READ AT THE SEND (POD-7484; design 4.2).
 *
 * A daemon on another computer, connected over plain ws, may receive a secret
 * only when its network is in its workspace's `daemonLink.trustedNetworks`.
 * The server once held those networks in a copy taken at boot and refreshed by
 * its own settings event, so a change written by another process, or one the
 * event missed, never reached the fences. Now every judgement reads the bound
 * workspace's settings from the store.
 *
 * The settings are written straight to the store here, as another server
 * process would write them: no event reaches the registry. Two workspaces
 * share one database, so a change in one is also shown not to reach the
 * other. In the store shard, so it runs on both engines.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { CAP_CREDENTIAL_IDENTITY_GUARD, CAP_SESSION_ACCESS } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { daemonLinkFactsOf } from '../gateway/daemon-link-kind'
import { isRefusedSend } from '../modules/machines/refused-send'
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { memberFacts } from './fixtures/test-support'

type Tag = 'a' | 'b'
const TAGS = ['a', 'b'] as const
const USER = asUserId('member-link-7484')
const MACHINE = asMachineId('machine-link-7484')
const NOW = Date.parse('2026-11-23T12:00:00.000Z')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-trusted-network-secret-7484'
/** Another computer on the local network, dialing plain ws. */
const LINK = daemonLinkFactsOf(new Request('http://podium.example/daemon'), '192.168.7.20', 0)

let directory: string
let stores: Record<Tag, SessionStore>
let registries: Partial<Record<Tag, SessionRegistry>>
let received: Record<Tag, ControlMessage[]>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'daemon-link-settings-'))
  const [a, b] = await openWorkspaceStores(['ws_link_a', 'ws_link_b'], {
    path: join(directory, 'store.db'),
  })
  stores = { a, b }
  registries = {}
  received = { a: [], b: [] }
  for (const tag of TAGS) {
    await memberFacts(stores[tag]).create({
      id: USER,
      displayName: `Member ${tag}`,
      email: `member-${tag}@example.com`,
      role: 'admin',
      createdAt: new Date(NOW).toISOString(),
      disabledAt: null,
    })
    await stores[tag].machines.upsertMachine({
      id: MACHINE,
      name: `Machine ${tag}`,
      hostname: 'fixture-machine',
      tokenHash: 'fixture-token',
      ownerUserId: USER,
    })
  }
  for (const tag of TAGS) {
    const registry = await SessionRegistry.create(stores[tag], undefined, {
      instanceId: 'daemon-link-settings-test',
      now: () => NOW,
    })
    registries[tag] = registry
    const peer = (message: ControlMessage) => {
      received[tag].push(message)
    }
    // As the socket accept path does: the link's facts, then the attach.
    registry.daemonLinks.connected(MACHINE, LINK, peer)
    await registry.gateway.attachDaemon(MACHINE, peer, [
      CAP_SESSION_ACCESS,
      CAP_CREDENTIAL_IDENTITY_GUARD,
    ])
  }
})

afterEach(async () => {
  try {
    for (const tag of TAGS) await registries?.[tag]?.dispose()
  } finally {
    try {
      await stores?.a.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

function registry(tag: Tag): SessionRegistry {
  const found = registries[tag]
  if (!found) throw new Error(`no registry for workspace ${tag}`)
  return found
}

/** Write the workspace's trusted networks the way another process would: the store only. */
async function trustNetworks(tag: Tag, trustedNetworks: readonly string[]): Promise<void> {
  const settings = await stores[tag].settings.getSettings()
  await stores[tag].settings.setSettings({
    ...settings,
    daemonLink: { ...settings.daemonLink, trustedNetworks: [...trustedNetworks] },
  })
}

const spawnWithSecret = (): ControlMessage => ({
  type: 'spawn',
  sessionId: asSessionId('00000000-0000-4000-8000-000000007484'),
  agentKind: 'claude-code',
  cwd: '/p',
  geometry: { cols: 80, rows: 24 },
  access: {
    credentialId: 'cred_00000000-0000-4000-8000-000000007484',
    delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
  },
})

/** Send the secret; whether it went, and the refusal when it did not. */
async function sendSecret(tag: Tag): Promise<'sent' | string> {
  const before = received[tag].length
  try {
    await registry(tag).modules.machines.toMachine(MACHINE, spawnWithSecret())
  } catch (error) {
    if (!isRefusedSend(error)) throw error
    expect(received[tag].length).toBe(before)
    return error.message
  }
  expect(JSON.stringify(received[tag].slice(before))).toContain(PLANTED)
  return 'sent'
}

describe('a trusted-networks change written to the store', () => {
  it('reaches the secret fence of the running server at once, in its own workspace only', async () => {
    expect(await registry('a').daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
    expect(await sendSecret('a')).toContain('not encrypted')

    await trustNetworks('a', ['192.168.7.0/24'])

    expect(await registry('a').daemonLinks.daemonLinkKind(MACHINE)).toBe('trusted')
    expect(await sendSecret('a')).toBe('sent')
    expect(await registry('a').modules.machines.loginLinkUnsafe(MACHINE)).toBeUndefined()
    // The other workspace on the same database trusts nothing.
    expect(await registry('b').daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
    expect(await sendSecret('b')).toContain('not encrypted')
    expect(await registry('b').modules.machines.loginLinkUnsafe(MACHINE)).toBe(
      'its connection is not encrypted',
    )
  })

  it('taking the network out again closes the fence without a restart or a reconnect', async () => {
    await trustNetworks('a', ['192.168.7.0/24'])
    expect(await sendSecret('a')).toBe('sent')

    await trustNetworks('a', [])

    expect(await registry('a').daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
    expect(await sendSecret('a')).toContain('not encrypted')
    expect(await registry('a').modules.machines.loginLinkUnsafe(MACHINE)).toBe(
      'its connection is not encrypted',
    )
    // A login file is refused at the send itself, not only by the preflight.
    await expect(
      registry('a').modules.machines.toMachine(MACHINE, {
        type: 'credentialInstallRequest',
        requestId: 'install-7484',
        bundles: [{ kind: 'codex', contentBase64: 'RkFLRS1sb2dpbi03NDg0' }],
      }),
    ).rejects.toThrow('not encrypted')
  })
})
