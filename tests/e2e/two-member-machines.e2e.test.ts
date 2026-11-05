/** Two independent daemon processes, states, HOME directories and machine
 * identities. This proves real file transport and ownership, not provider login
 * execution or the native desktop/phone storage boundary. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, type MachineId } from '@podium/model'
import { CAP_CREDENTIAL_IDENTITY_GUARD } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { loadIdentity } from '../../apps/daemon/src/identity'
import {
  startTwoMemberInstance,
  type TwoMemberInstance,
} from '../../apps/server/src/test-support/two-member-instance'
import { type DaemonProcessHandle, startDaemonProcess } from './daemon-restart-harness'

describe('two members on independent machine processes', () => {
  let f: TwoMemberInstance | undefined
  const children: DaemonProcessHandle[] = []
  const dirs: string[] = []
  afterAll(async () => {
    for (const child of children.reverse()) await child.stop()
    await f?.close()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('pairs each member’s own machine, routes its bytes and grants no session access', async () => {
    f = await startTwoMemberInstance()
    const machines = new Map<'alice' | 'bob', { id: MachineId; root: string; pid: number }>()
    for (const who of ['alice', 'bob'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `mu-6303-${who}-`))
      dirs.push(dir)
      const root = join(dir, 'checkout')
      const home = join(dir, 'home')
      const state = join(dir, 'state')
      for (const path of [root, home, state]) mkdirSync(path, { recursive: true })
      writeFileSync(join(root, 'member.txt'), `${who}'s independent machine`)
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', root])
      execFileSync('git', ['-C', root, 'add', 'member.txt'])
      execFileSync('git', [
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'Machine fixture',
      ])
      const { code } = await (await f.as(who)).trpc.machines.pairingCode.mutate({})
      const child = await startDaemonProcess({
        dir,
        inheritEnv: false,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          NODE_ENV: 'test',
          LANG: 'C.UTF-8',
          HOME: home,
          PODIUM_STATE_DIR: state,
          PODIUM_AGENT_HOME: join(dir, 'agent-home'),
          PODIUM_INSTANCE: `mu6303-${who}`,
          PODIUM_NO_RELAY: '1',
          XDG_CONFIG_HOME: join(dir, 'xdg-config'),
          XDG_CACHE_HOME: join(dir, 'xdg-cache'),
          XDG_DATA_HOME: join(dir, 'xdg-data'),
        },
        options: {
          serverUrl: `ws://127.0.0.1:${f.handle.port}`,
          pairCode: code,
          identityDir: state,
          backend: 'none',
          discovery: { background: false, homeDir: home, cachePath: join(dir, 'discovery.db') },
          metrics: { background: false },
          hooks: { port: 0, settingsDir: join(dir, 'hooks') },
          agentRelay: { port: 0 },
        },
      })
      children.push(child)
      const { machineId } = loadIdentity({ dir: state })
      machines.set(who, { id: machineId, root, pid: child.pid })
      await f.handle.registry.sessionStore.repos.addRepo(root, asMachineId(machineId))
      expect(await f.handle.registry.sessionStore.machines.custodian(asMachineId(machineId))).toBe(
        f.members[who].id,
      )
      expect(
        f.handle.registry.modules.machines.daemonSupports(
          asMachineId(machineId),
          CAP_CREDENTIAL_IDENTITY_GUARD,
        ),
      ).toBe(true)
    }
    const aliceMachine = machines.get('alice')!
    const bobMachine = machines.get('bob')!
    expect(aliceMachine.pid).not.toBe(bobMachine.pid)
    expect(aliceMachine.id).not.toBe(bobMachine.id)
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const file = (machine: typeof aliceMachine) => ({
      machineId: machine.id,
      root: machine.root,
      path: 'member.txt',
    })
    await expect(alice.files.read.query(file(aliceMachine))).resolves.toMatchObject({
      ok: true,
      content: "alice's independent machine",
    })
    await expect(bob.files.read.query(file(bobMachine))).resolves.toMatchObject({
      ok: true,
      content: "bob's independent machine",
    })
    await expect(
      alice.git.status.query({ machineId: aliceMachine.id, root: aliceMachine.root }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      bob.git.status.query({ machineId: bobMachine.id, root: bobMachine.root }),
    ).resolves.toMatchObject({ ok: true })
    // Admin role grants no file access; Bob's task access grants no machine use.
    await expect(alice.files.read.query(file(bobMachine))).rejects.toThrow(/not found/i)
    await expect(bob.files.read.query(file(aliceMachine))).rejects.toThrow(/not found/i)
    await expect(
      alice.git.status.query({ machineId: bobMachine.id, root: bobMachine.root }),
    ).rejects.toThrow(/not found/i)
    await expect(
      bob.git.status.query({ machineId: aliceMachine.id, root: aliceMachine.root }),
    ).rejects.toThrow(/not found/i)
    await alice.machines.share.mutate({
      id: aliceMachine.id,
      grantee: f.members.bob.id,
      verb: 'use',
      acknowledgeSharedMachine: true,
    })
    await expect(bob.files.read.query(file(aliceMachine))).resolves.toMatchObject({
      ok: true,
      content: "alice's independent machine",
    })
    await expect(
      bob.git.status.query({ machineId: aliceMachine.id, root: aliceMachine.root }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      bob.files.write.mutate({
        ...file(aliceMachine),
        content: 'Bob wrote on the shared checkout',
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(readFileSync(join(aliceMachine.root, 'member.txt'), 'utf8')).toBe(
      'Bob wrote on the shared checkout',
    )
    expect(readFileSync(join(bobMachine.root, 'member.txt'), 'utf8')).toBe(
      "bob's independent machine",
    )
    // An allowed root on Alice's machine is not a root on Bob's own machine.
    await expect(
      bob.files.read.query({ ...file(aliceMachine), machineId: bobMachine.id }),
    ).rejects.toThrow(/known repository/i)
    await expect(bob.sessions.read.query({ sessionId: f.sessions.alice })).rejects.toThrow(
      /not found/i,
    )
  }, 180_000)
})
