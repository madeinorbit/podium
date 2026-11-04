/**
 * THE D11 CHECKBOX WITH TWO MEMBERS (POD-6301; design §2.5, §4.6, D11;
 * September addendum §4-5). Row MU-27 of the acceptance matrix, and unticking:
 *
 * - MU-27: Alice's ticked login reaches every machine Alice holds custody of,
 *   now and in future, and none of Bob's machines or the one Bob shares with
 *   her. A machine of hers already signed in to a different account keeps it,
 *   and her Accounts hub says so.
 * - Pairing no longer copies by itself: a machine paired with the old "copy
 *   agent credentials" flag while nothing is ticked receives nothing.
 * - Unticking stops future copies and recalls nothing already installed.
 *
 * Alice's and Bob's extra machines are fake daemons that answer credential
 * export and install like a real one (a login slot per machine); machines paired
 * "later" connect over the real `/daemon` socket with a pairing code minted by
 * their owner, so the enrollment path is the production one.
 */

import { asMachineId, type MachineId, SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model'
import { createHandshakeDialer } from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { mintSigningKeyPair, publicKeyWire } from '@podium/runtime/signing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { attachDaemonWithInventory, fixtureInventory } from './test-support/daemon-inventory'
import {
  MEMBERS,
  type MemberName,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
// biome-ignore lint/suspicious/noExplicitAny: tRPC procedures addressed by one loose shape
const trpc = async (who: MemberName): Promise<any> => (await f.as(who)).trpc

const ALICE = 'fp-alice-codex'
const SOMEONE_ELSE = 'fp-someone-else'
const BUNDLE = {
  kind: 'codex' as const,
  contentBase64: Buffer.from('{"alice":1}').toString('base64'),
}

/** A fake daemon with one Codex login slot: who is signed in there, if anyone. */
interface FakeMachine {
  id: MachineId
  login: string | undefined
  frames: ControlMessage[]
}
const fakes = new Map<string, FakeMachine>()

const codexInventory = (fingerprint: string | undefined) =>
  fixtureInventory({
    agents: [
      {
        kind: 'codex',
        installed: true,
        login: fingerprint ? { state: 'in', identity: { fingerprint } } : { state: 'out' },
      },
    ],
  })

/** Answer export and install as a real daemon's guards would. */
function credentialAnswer(machine: FakeMachine, msg: ControlMessage): DaemonMessage | undefined {
  if (msg.type === 'credentialExportRequest') {
    const ok =
      msg.propagation && machine.login !== undefined && msg.expectedFingerprint === machine.login
    return {
      type: 'credentialExportResult',
      requestId: msg.requestId,
      bundles: ok ? [BUNDLE] : [],
      unavailable: ok ? [] : msg.kinds,
    }
  }
  if (msg.type === 'credentialInstallRequest') {
    const occupiedByOther = machine.login !== undefined && machine.login !== msg.expectedFingerprint
    if (!occupiedByOther) machine.login = msg.expectedFingerprint
    return {
      type: 'credentialInstallResult',
      requestId: msg.requestId,
      installed: occupiedByOther ? [] : ['codex'],
      failed: occupiedByOther ? ['codex'] : [],
      ...(occupiedByOther ? { preserved: ['codex' as const] } : {}),
    }
  }
  return undefined
}

async function addMachine(name: string, owner: MemberName, login: string | undefined) {
  const id = asMachineId(name)
  const machine: FakeMachine = { id, login, frames: [] }
  fakes.set(name, machine)
  const registry = f.handle.registry
  await registry.sessionStore.machines.upsertMachine({
    id,
    name,
    hostname: name,
    tokenHash: `${name}-token`,
    ownerUserId: MEMBERS[owner].id,
    assignment: { server: false, agentExecution: true },
  })
  await attachDaemonWithInventory(
    registry,
    id,
    (msg) => {
      machine.frames.push(msg)
      const answer = credentialAnswer(machine, msg)
      if (answer) queueMicrotask(() => void registry.gateway.routeDaemonFrame(id, answer))
    },
    codexInventory(login),
  )
}

/** A machine its owner pairs now, over the real `/daemon` socket. */
async function pairMachine(
  owner: MemberName,
  name: string,
): Promise<FakeMachine & { ws: WebSocket }> {
  const { code } = (await (
    await trpc(owner)
  ).machines.pairingCode.mutate({
    // The old blanket flag the web app always sent: it no longer copies by itself.
    copyAgentCredentials: true,
  })) as { code: string }
  const ws = new WebSocket(`ws://127.0.0.1:${f.handle.port}/daemon`)
  const machine = { id: asMachineId(name), login: undefined, frames: [] as ControlMessage[], ws }
  const dialer = createHandshakeDialer({
    peerRole: 'machine',
    credential: { kind: 'pairCode', code, publicKey: publicKeyWire(mintSigningKeyPair()) },
    claims: { machineId: name, hostname: name },
    caps: [],
  })
  await new Promise<void>((resolve, reject) => {
    let established = false
    ws.on('open', () => ws.send(JSON.stringify(dialer.hello())))
    ws.on('error', reject)
    ws.on('message', (raw) => {
      if (!established) {
        const step = dialer.receive(raw.toString())
        if (step.action === 'established') {
          established = true
          resolve()
        } else if (step.action !== 'deliver') reject(new Error(`handshake ${step.action}`))
        return
      }
      const msg = JSON.parse(raw.toString()) as ControlMessage
      machine.frames.push(msg)
      const answer = credentialAnswer(machine, msg)
      if (answer) ws.send(JSON.stringify(answer))
    })
  })
  fakes.set(name, machine)
  return machine
}

const credentialFrames = (name: string) =>
  (fakes.get(name)?.frames ?? []).filter(
    (frame) =>
      frame.type === 'credentialExportRequest' || frame.type === 'credentialInstallRequest',
  )
const installs = (name: string) =>
  (fakes.get(name)?.frames ?? []).filter((frame) => frame.type === 'credentialInstallRequest')

const until = async (pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type View = {
  id: string
  harness?: string
  identityFingerprint?: string
  useOnMyMachines?: boolean
  keptOn?: Array<{ id: string; name: string }>
}
const list = async (who: MemberName): Promise<View[]> =>
  (await (await trpc(who)).accounts.list.query()) as View[]
const codexRow = async (who: MemberName, fingerprint: string) =>
  (await list(who)).find(
    (row) => row.harness === 'codex' && row.identityFingerprint === fingerprint,
  )
const choose = async (who: MemberName, fingerprint: string, enabled: boolean) =>
  await (await trpc(who)).accounts.useOnMyMachines.mutate({
    harness: 'codex',
    fingerprint,
    enabled,
  })

beforeAll(async () => {
  f = await startTwoMemberInstance()
  // Alice: the laptop she is signed in on, an empty VPS, and a desk machine
  // signed in to a different account.
  await addMachine('alice-laptop', 'alice', ALICE)
  await addMachine('alice-vps', 'alice', undefined)
  await addMachine('alice-desk', 'alice', SOMEONE_ELSE)
  // Bob: his own empty box, and one he shares with Alice (she may use it).
  await addMachine('bob-box', 'bob', undefined)
  await addMachine('bob-shared', 'bob', undefined)
  await (await trpc('bob')).machines.share.mutate({
    id: 'bob-shared',
    grantee: MEMBERS.alice.id,
    verb: 'use',
    acknowledgeSharedMachine: true,
  })
}, 60_000)
afterAll(async () => {
  for (const machine of fakes.values()) if ('ws' in machine) (machine.ws as WebSocket).close()
  await f?.close()
})

describe('the D11 box on each detected account', () => {
  it('starts unticked, and only the account’s owner sees it', async () => {
    expect(await codexRow('alice', ALICE)).toMatchObject({ useOnMyMachines: false, keptOn: [] })
    expect(await codexRow('bob', ALICE)).toBeUndefined()
    // Nothing was copied anywhere before Alice decided.
    for (const name of ['alice-vps', 'alice-desk', 'bob-box', 'bob-shared']) {
      expect(credentialFrames(name)).toEqual([])
    }
  })

  it('Bob cannot tick Alice’s login: it is on none of his machines', async () => {
    await expect(choose('bob', ALICE, true)).rejects.toThrow(
      /none of your machines is signed in to that codex account/,
    )
  })
})

describe('MU-27: Alice’s ticked login reaches every machine she holds custody of, and no one else’s', () => {
  it('ticking copies it to her empty machine, as that account', async () => {
    expect(await choose('alice', ALICE, true)).toEqual({ ok: true, enabled: true })
    await until(() => installs('alice-vps').length === 1)
    expect(installs('alice-vps')[0]).toMatchObject({
      propagation: true,
      expectedFingerprint: ALICE,
    })
    expect(fakes.get('alice-vps')?.login).toBe(ALICE)
    expect((await codexRow('alice', ALICE))?.useOnMyMachines).toBe(true)
  })

  it('her machine signed in to a different account keeps it, and her hub says so', async () => {
    await until(async () =>
      ((await codexRow('alice', ALICE))?.keptOn ?? []).some(
        (machine) => machine.id === 'alice-desk',
      ),
    )
    expect(credentialFrames('alice-desk')).toEqual([])
    expect(fakes.get('alice-desk')?.login).toBe(SOMEONE_ELSE)
  })

  it('a machine she pairs later receives it too', async () => {
    const later = await pairMachine('alice', 'alice-later')
    await until(() => installs('alice-later').length === 1)
    expect(installs('alice-later')[0]).toMatchObject({ expectedFingerprint: ALICE })
    expect(later.login).toBe(ALICE)
  })

  it('none of Bob’s machines, nor the one he shares with her, ever received anything', async () => {
    // Every copy of Alice's tick has settled: her machines above got theirs.
    for (const name of ['bob-box', 'bob-shared']) {
      expect(credentialFrames(name)).toEqual([])
      expect(fakes.get(name)?.login).toBeUndefined()
    }
    // And Bob's hub knows nothing of Alice's login.
    expect(JSON.stringify(await list('bob'))).not.toContain(ALICE)
  })

  it('the share Bob gave her still carries the shared-machine warning, not her login', async () => {
    // A `use` grant is not custody: sharing needs the warning acknowledged,
    // and the D11 box never reaches the machine.
    await expect(
      (await trpc('bob')).machines.share.mutate({
        id: 'bob-box',
        grantee: MEMBERS.alice.id,
        verb: 'use',
      }),
    ).rejects.toThrow(SHARED_MACHINE_ACCOUNT_WARNING)
  })
})

describe('unticking stops future copies and recalls nothing', () => {
  it('a machine paired with the old copy flag after unticking receives nothing, and the installed copies stay', async () => {
    const before = credentialFrames('alice-vps').length
    expect(await choose('alice', ALICE, false)).toEqual({ ok: true, enabled: false })
    expect((await codexRow('alice', ALICE))?.useOnMyMachines).toBe(false)

    await pairMachine('alice', 'alice-after-untick')
    // A ticked login would be copied within this window, as the pairings above show.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(credentialFrames('alice-after-untick')).toEqual([])
    // Nothing went to the machines that already have it, and they keep it.
    expect(credentialFrames('alice-vps')).toHaveLength(before)
    expect(fakes.get('alice-vps')?.login).toBe(ALICE)
    expect(fakes.get('alice-later')?.login).toBe(ALICE)
  })

  it('ticking again copies again', async () => {
    await choose('alice', ALICE, true)
    await until(() => installs('alice-after-untick').length === 1)
  })
})
