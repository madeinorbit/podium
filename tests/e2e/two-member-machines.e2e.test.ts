/** Two independent daemon processes, states, HOME directories and machine
 * identities. This proves real file transport and ownership, not provider login
 * execution or the native desktop/phone storage boundary. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, type MachineId } from '@podium/model'
import { CAP_CREDENTIAL_IDENTITY_GUARD, wireSchemaDigest } from '@podium/protocol'
import { ensureInstanceStateIdentity } from '@podium/runtime/instance'
import {
  createMachineSupervisorConnection,
  loadSupervisorState,
  type MachineSupervisorConnection,
  saveSupervisorState,
} from '@podium/runtime/machine-supervisor'
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
  const supervisors: MachineSupervisorConnection[] = []
  const dirs: string[] = []
  afterAll(async () => {
    for (const child of children.reverse()) await child.stop()
    for (const supervisor of supervisors) supervisor.close()
    await f?.close()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('enrolls independent machines and enforces file and git access', async () => {
    f = await startTwoMemberInstance()
    await expect((await f.as('bob')).trpc.machines.pairingCode.mutate({})).rejects.toThrow(
      /admin account/i,
    )
    const machines = new Map<'alice' | 'bob', { id: MachineId; root: string; pid: number }>()
    for (const who of ['alice', 'bob'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `mu-6303-${who}-`))
      dirs.push(dir)
      const root = join(dir, 'checkout')
      const home = join(dir, 'home')
      const state = join(dir, 'state')
      for (const path of [root, home, state]) mkdirSync(path, { recursive: true })
      ensureInstanceStateIdentity({ instanceId: `mu6303-${who}`, dir: state })
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
      const { code } = await (await f.as('alice')).trpc.machines.pairingCode.mutate({})
      // Current enrollment belongs to the machine supervisor. A bare daemon's
      // legacy pairCode option does not enroll it or prove connectivity.
      const supervisorState = loadSupervisorState(state)
      supervisorState.assignment = { server: false, agentExecution: true }
      supervisorState.generation = 1
      saveSupervisorState(state, supervisorState)
      const supervisor = createMachineSupervisorConnection({
        serverUrl: `ws://127.0.0.1:${f.handle.port}`,
        stateDir: state,
        state: supervisorState,
        pairCode: code,
        name: `release-${who}`,
        build: {
          appVersion: 'fixture',
          wireSchemaDigest: wireSchemaDigest(),
          supervisorGeneration: 1,
        },
        deliveryCaps: [],
        report: () => ({
          server: { policy: 'disabled', state: 'stopped', observedAt: new Date().toISOString() },
          agentExecution: {
            policy: 'enabled',
            state: 'starting',
            observedAt: new Date().toISOString(),
          },
        }),
        onGrant: () => {},
      })
      supervisors.push(supervisor)
      supervisor.start()
      expect(await supervisor.waitUntilConnected(15_000)).toBe(true)
      expect(loadSupervisorState(state).enrolledPublicKey).toBeTruthy()
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
      await expect
        .poll(() => f!.handle.registry.modules.machines.hasDaemon(machineId), { timeout: 25_000 })
        .toBe(true)
      // Fresh enrollment is admin-only. Move the second machine's custody
      // explicitly, through the same audited member command the UI uses.
      if (who === 'bob')
        await (await f.as('alice')).trpc.machines.transferOwnership.mutate({
          id: machineId,
          newOwnerUserId: f.members.bob.id,
        })
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
      path: join(machine.root, 'member.txt'),
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
    // The fixture's existing private session remains a separate server control;
    // same-machine session-use controls are in two-member-release-safety.test.ts.
    await expect(bob.sessions.read.query({ sessionId: f.sessions.alice })).rejects.toThrow(
      'NOT_FOUND',
    )
  }, 180_000)
})
