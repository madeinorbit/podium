import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { requestMachineUpdate } from '../packages/runtime/src/machine-update-control'
import { readMachineUpdateJournal } from '../packages/runtime/src/machine-update'
import { socketRequest } from './fixtures/machine-update-runtime'

const fixture = new URL('./fixtures/machine-update-runtime.ts', import.meta.url).pathname
const groups: Group[] = []
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(
  read: () => T | Promise<T>,
  check: (value: T) => boolean,
  label: string,
  budget = 20000,
): Promise<T> {
  const deadline = Date.now() + budget
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      last = value
      if (check(value)) return value
    } catch (error) {
      last = String(error)
    }
    await delay(50)
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}
class Group {
  root = mkdtempSync(join(tmpdir(), 'mu-'))
  artifacts = join(this.root, 'artifacts')
  socket = join(this.root, 'fleet.sock')
  key = generateKeyPairSync('ed25519')
  pubkey = this.key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  machines = new Map<string, string[]>()
  authority = Date.now()
  constructor() {
    mkdirSync(this.artifacts)
    groups.push(this)
  }
  state(id: string) {
    return join(this.root, id)
  }
  runtime(id: string) {
    return join(this.state(id), 'runtime')
  }
  install(id: string) {
    return join(this.state(id), 'payload')
  }
  journal(id: string) {
    return readMachineUpdateJournal(this.runtime(id))
  }
  events(id: string): any[] {
    try {
      return readFileSync(join(this.state(id), 'events.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  entry(dir: string, version: string, identity = version) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'VERSION'), version + '\n')
    writeFileSync(
      join(dir, 'podium'),
      `#!${process.execPath} --conditions=@podium/source\nprocess.env.PODIUM_APP_VERSION=${JSON.stringify(version)};\nconst {runMachine}=await import(${JSON.stringify(fixture)});await runMachine(${JSON.stringify(version)},${JSON.stringify(identity)});\n`,
    )
    chmodSync(join(dir, 'podium'), 0o755)
  }
  artifact(
    version: string,
    options: {
      actualVersion?: string
      badSignature?: boolean
      badDigest?: boolean
      identity?: string
      failSuccessor?: boolean
    } = {},
  ): UpdateTarget {
    const staging = join(this.artifacts, 'pack')
    rmSync(staging, { recursive: true, force: true })
    this.entry(
      join(staging, 'headless'),
      options.actualVersion ?? version,
      options.identity ?? version,
    )
    if (options.failSuccessor) {
      const path = join(staging, 'headless', 'podium')
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          'process.env.PODIUM_APP_VERSION=',
          "if (process.argv[2] === 'parent') process.exit(78);\nprocess.env.PODIUM_APP_VERSION=",
        ),
      )
    }
    const name = `release-${++this.authority}.tar.gz`
    const archive = join(this.artifacts, name)
    execFileSync('tar', ['-czf', archive, '-C', staging, 'headless'])
    const bytes = readFileSync(archive)
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
    return {
      version,
      critical: false,
      trust: 'instance',
      schema: { migrations: [] },
      artifacts: {
        headless: {
          delivery: 'feed',
          platforms: {
            'linux-x86_64': {
              url: `http://fixture/artifact/${name}`,
              digest: options.badDigest ? 'sha256-incorrect' : digest,
              signature: sign(
                null,
                options.badSignature ? Buffer.from('other') : bytes,
                this.key.privateKey,
              ).toString('base64'),
            },
          },
        },
      },
    }
  }
  start(id: string, roles: string[], entryRole = 'parent') {
    this.machines.set(id, roles)
    mkdirSync(this.state(id), { recursive: true })
    if (!existsSync(this.install(id))) this.entry(this.install(id), '1.0.0')
    writeFileSync(join(this.state(id), 'update-key'), this.pubkey)
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env))
      if (
        !key.startsWith('PODIUM_') &&
        !['NOTIFY_SOCKET', 'WATCHDOG_USEC', 'INVOCATION_ID', 'ABDUCO_SOCKET_DIR'].includes(key)
      )
        env[key] = value
    Object.assign(env, {
      PODIUM_INSTANCE: `fixture-${id}`,
      PODIUM_STATE_DIR: this.state(id),
      PODIUM_HOME: this.install(id),
      PODIUM_NO_RELAY: '1',
      PODIUM_NO_SCOPE: '1',
      FIXTURE_MACHINE: id,
      FIXTURE_ROLES: roles.join(','),
      FIXTURE_COORDINATOR_SOCKET: this.socket,
      FIXTURE_ARTIFACTS: this.artifacts,
    })
    const child = spawn(join(this.install(id), 'podium'), [entryRole], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const log = join(this.state(id), 'process.log')
    child.stdout!.on('data', (bytes) => writeFileSync(log, bytes, { flag: 'a' }))
    child.stderr!.on('data', (bytes) => writeFileSync(log, bytes, { flag: 'a' }))
    return child
  }
  async bootFour() {
    this.start('coordinator', ['server'])
    await until(
      () => socketRequest(this.socket, '/identity'),
      (value) => value.version === '1.0.0',
      'coordinator started',
    )
    this.start('daemon', ['daemon'])
    this.start('combined', ['server', 'daemon'])
    this.start('desktop', [])
    await until(
      () => socketRequest(this.socket, '/fleet'),
      (value) => Object.keys(value.identities).length === 4,
      'four independent supervisors online',
    )
  }
  async grant(id: string, target: UpdateTarget, grantId = crypto.randomUUID()) {
    const grant: UpdateGrantMessage = {
      type: 'updateGrant',
      grantId,
      issuedAt: ++this.authority,
      target,
    }
    await requestMachineUpdate(this.runtime(id), '/grant', grant)
    return grant
  }
  async phase(id: string, phase: string) {
    return until(
      () => this.journal(id),
      (value) => value?.phase === phase,
      `${id} reaches ${phase}`,
    )
  }
  stop(id: string, signal: NodeJS.Signals = 'SIGTERM') {
    const pids = [
      ...new Set(
        this.events(id)
          .filter((event) => event.type === 'boot' && event.role === 'parent')
          .map((event) => event.pid),
      ),
    ]
    for (const pid of pids) this.killOwned(pid, signal)
  }
  killOwned(pid: number, signal: NodeJS.Signals) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(this.root))
        process.kill(pid, signal)
    } catch {}
  }
  async close() {
    for (const id of this.machines.keys()) this.stop(id)
    await delay(200)
    for (const id of this.machines.keys())
      for (const event of this.events(id)) this.killOwned(event.pid, 'SIGKILL')
    await delay(100)
    for (const id of this.machines.keys()) {
      const key = createHash('sha256').update(this.runtime(id)).digest('hex').slice(0, 20)
      rmSync(join(tmpdir(), `podium-update-${process.getuid?.() ?? 'user'}-${key}`), {
        recursive: true,
        force: true,
      })
    }
    rmSync(this.root, { recursive: true, force: true })
  }
}
afterEach(async () => {
  for (const group of groups.splice(0)) await group.close()
})

describe('supervisor-owned machine updates over isolated Ubuntu sockets', () => {
  it('updates all four topologies through the same executor, including coordinator self-update', async () => {
    const group = new Group()
    await group.bootFour()
    const target = group.artifact('2.0.0')
    await socketRequest(group.socket, '/publish', target)
    await delay(400)
    for (const id of group.machines.keys()) expect(group.journal(id)).toBeUndefined()
    await socketRequest(group.socket, '/approve', {
      version: target.version,
      machines: ['daemon', 'combined', 'desktop'],
    })
    for (const id of ['daemon', 'combined', 'desktop']) {
      const journal = await group.phase(id, 'current')
      expect(journal?.prepared?.digest).toBe(
        target.artifacts.headless!.platforms['linux-x86_64']!.digest,
      )
      const boots = group.events(id).filter((event) => event.type === 'boot')
      expect(
        boots.some(
          (event) =>
            event.role === 'parent' &&
            event.version === '2.0.0' &&
            event.buildIdentity === '2.0.0' &&
            event.digest === journal?.prepared?.digest,
        ),
      ).toBe(true)
      for (const role of group.machines.get(id)!)
        expect(boots.some((event) => event.role === role && event.version === '2.0.0')).toBe(true)
      expect(group.events(id).filter((event) => event.type === 'activated')).toHaveLength(1)
    }
    expect(
      group
        .events('coordinator')
        .some((event) => event.type === 'boot' && event.version === '2.0.0'),
    ).toBe(false)
    await socketRequest(group.socket, '/approve', {
      version: target.version,
      machines: ['coordinator'],
    })
    await group.phase('coordinator', 'current')
    await until(
      () => socketRequest(group.socket, '/identity'),
      (identity) => identity.version === '2.0.0' && identity.buildIdentity === '2.0.0',
      'coordinator serves from replacement artifact',
    )
    const endpoints = [...group.machines.keys()].map(
      (id) =>
        JSON.parse(readFileSync(join(group.runtime(id), 'machine-update-control.json'), 'utf8'))
          .socketPath,
    )
    expect(new Set(endpoints).size).toBe(4)
    expect(
      group
        .events('desktop')
        .filter((event) => event.type === 'boot')
        .every((event) => event.role === 'parent'),
    ).toBe(true)
  }, 60000)

  it('reconnecting offline machines never inherit approval for a newer publication', async () => {
    const group = new Group()
    await group.bootFour()
    writeFileSync(join(group.state('desktop'), 'offline'), '1')
    await delay(1700)
    const approved = group.artifact('2.0.0')
    const published = group.artifact('3.0.0')
    await socketRequest(group.socket, '/publish', approved)
    await socketRequest(group.socket, '/approve', { version: approved.version, machines: [] })
    await socketRequest(group.socket, '/publish', published)
    rmSync(join(group.state('desktop'), 'offline'))
    await until(
      () => group.events('coordinator'),
      (events) =>
        events.some(
          (event) =>
            event.type === 'reconnect-decision' &&
            event.detail.machineId === 'desktop' &&
            event.detail.verdict.because === 'not-approved',
        ),
      'new publication lacks inherited consent',
    )
    expect(group.journal('desktop')).toBeUndefined()
    writeFileSync(join(group.state('desktop'), 'offline'), '1')
    await delay(1700)
    await socketRequest(group.socket, '/publish', approved)
    rmSync(join(group.state('desktop'), 'offline'))
    const journal = await group.phase('desktop', 'current')
    expect(journal?.grant.target).toEqual(approved)
    expect(group.events('desktop').some((event) => event.version === '3.0.0')).toBe(false)
  }, 45000)

  it('recovers interrupted preparation using only the persisted exact target', async () => {
    const group = new Group()
    await group.bootFour()
    const target = group.artifact('2.0.0')
    writeFileSync(join(group.state('daemon'), 'pause-prepared'), '1')
    const grant = await group.grant('daemon', target)
    await until(
      () => existsSync(join(group.state('daemon'), 'paused')),
      Boolean,
      'preparation reached',
    )
    group.stop('daemon', 'SIGKILL')
    await delay(300)
    rmSync(join(group.state('daemon'), 'pause-prepared'))
    await socketRequest(group.socket, '/publish', group.artifact('3.0.0'))
    group.start('daemon', ['daemon'])
    const journal = await group.phase('daemon', 'current')
    expect(journal?.grant).toEqual(grant)
    expect(group.events('daemon').some((event) => event.version === '3.0.0')).toBe(false)
  }, 45000)

  it('recovers an interrupted activation and proves the replacement process identity', async () => {
    const group = new Group()
    await group.bootFour()
    const target = group.artifact('2.0.0')
    writeFileSync(join(group.state('desktop'), 'pause-activation'), '1')
    await group.grant('desktop', target)
    await group.phase('desktop', 'activating')
    group.stop('desktop', 'SIGKILL')
    await delay(300)
    rmSync(join(group.state('desktop'), 'pause-activation'))
    group.start('desktop', [])
    const journal = await group.phase('desktop', 'current')
    expect(journal?.prepared?.digest).toBe(
      target.artifacts.headless!.platforms['linux-x86_64']!.digest,
    )
    expect(
      group.events('desktop').some((event) => event.type === 'boot' && event.version === '2.0.0'),
    ).toBe(true)
  }, 45000)

  it('rejects signature, digest, download and staged-version failures before changing running roles', async () => {
    const group = new Group()
    await group.bootFour()
    const targets = [
      group.artifact('2.0.0', { badSignature: true }),
      group.artifact('2.0.0', { badDigest: true }),
      group.artifact('2.0.0', { actualVersion: '9.0.0' }),
      group.artifact('2.0.0'),
    ]
    const failedAsset = targets[3]!.artifacts
      .headless!.platforms['linux-x86_64']!.url.split('/')
      .at(-1)!
    writeFileSync(
      join(group.artifacts, `${failedAsset}.behavior.json`),
      JSON.stringify({ fail: true }),
    )
    for (const target of targets) {
      await group.grant('combined', target)
      const journal = await group.phase('combined', 'rejected')
      expect(journal?.detail).toBeTruthy()
      expect(readFileSync(join(group.install('combined'), 'VERSION'), 'utf8').trim()).toBe('1.0.0')
    }
    expect(group.events('combined').filter((event) => event.type === 'activated')).toHaveLength(0)
    expect(
      (await socketRequest(join(group.state('combined'), 'server.sock'), '/identity')).version,
    ).toBe('1.0.0')
    expect(
      (await socketRequest(join(group.state('combined'), 'daemon.sock'), '/identity')).version,
    ).toBe('1.0.0')
  }, 45000)

  it('persists activation failure, rejects stale/conflicting/unauthenticated requests and replays duplicates', async () => {
    const group = new Group()
    await group.bootFour()
    const target = group.artifact('2.0.0')
    writeFileSync(join(group.state('desktop'), 'fail-activation'), '1')
    const grant = await group.grant('desktop', target)
    const failed = await group.phase('desktop', 'stuck')
    expect(failed?.detail).toContain('activation failure')
    await requestMachineUpdate(group.runtime('desktop'), '/grant', grant)
    expect(group.events('desktop').filter((event) => event.type === 'prepared')).toHaveLength(1)
    await expect(
      requestMachineUpdate(group.runtime('desktop'), '/grant', {
        ...grant,
        target: { ...target, version: '3.0.0' },
      }),
    ).rejects.toThrow('grant-id-conflict')
    await expect(
      requestMachineUpdate(group.runtime('desktop'), '/grant', {
        ...grant,
        grantId: 'stale',
        issuedAt: grant.issuedAt! - 1,
      }),
    ).rejects.toThrow('stale-authorization')
    await expect(
      requestMachineUpdate(group.runtime('desktop'), '/grant', {
        ...grant,
        grantId: 'undated',
        issuedAt: undefined,
      }),
    ).rejects.toThrow('unauthorized-target')
    const endpoint = JSON.parse(
      readFileSync(join(group.runtime('desktop'), 'machine-update-control.json'), 'utf8'),
    )
    await expect(
      socketRequest(endpoint.socketPath, '/grant', grant, 'wrong-token'),
    ).rejects.toThrow('401')
    rmSync(join(group.state('desktop'), 'fail-activation'))
    const retry = await group.grant('desktop', target)
    await group.phase('desktop', 'current')
    await requestMachineUpdate(group.runtime('desktop'), '/grant', retry)
    expect(group.events('desktop').filter((event) => event.type === 'activated')).toHaveLength(1)
  }, 45000)

  it('cancels preparation but refuses cancellation once activation owns the machine', async () => {
    const group = new Group()
    await group.bootFour()
    const target = group.artifact('2.0.0')
    writeFileSync(join(group.state('desktop'), 'pause-prepared'), '1')
    const canceled = await group.grant('desktop', target)
    await until(
      () => existsSync(join(group.state('desktop'), 'paused')),
      Boolean,
      'prepared before cancellation',
    )
    expect(
      await requestMachineUpdate(group.runtime('desktop'), '/cancel', {
        grantId: canceled.grantId,
      }),
    ).toEqual({ canceled: true })
    await group.phase('desktop', 'canceled')
    expect(existsSync(`${group.install('desktop')}.prepared`)).toBe(false)
    rmSync(join(group.state('desktop'), 'pause-prepared'))
    writeFileSync(join(group.state('desktop'), 'pause-activation'), '1')
    const committed = await group.grant('desktop', target)
    await group.phase('desktop', 'activating')
    expect(
      await requestMachineUpdate(group.runtime('desktop'), '/cancel', {
        grantId: committed.grantId,
      }),
    ).toEqual({ canceled: false })
    rmSync(join(group.state('desktop'), 'pause-activation'))
    await group.phase('desktop', 'current')
  }, 45000)
  it('holds coordinator preparation until its operation snapshot is durable', async () => {
    const group = new Group()
    await group.bootFour()
    const target = group.artifact('2.0.0')
    await socketRequest(group.socket, '/prepare-self', target)
    expect(group.journal('coordinator')?.phase).toBe('prepared')
    expect(group.journal('coordinator')?.activationHeld).toBe(true)
    expect((await socketRequest(group.socket, '/identity')).version).toBe('1.0.0')
    expect(
      JSON.parse(
        readFileSync(join(group.state('coordinator'), 'coordinator-prepared.json'), 'utf8'),
      ).savedBeforeActivation,
    ).toBe(true)
    await socketRequest(group.socket, '/activate-self', {}).catch(() => {})
    await group.phase('coordinator', 'current')
  }, 45000)

  it('updates a present machine whose old daemon refused to start', async () => {
    const group = new Group()
    await group.bootFour()
    writeFileSync(join(group.state('daemon'), 'refuse-daemon'), '1')
    const daemon = group
      .events('daemon')
      .find((event) => event.type === 'boot' && event.role === 'daemon')
    group.killOwned(daemon.pid, 'SIGTERM')
    await until(
      () => socketRequest(group.socket, '/fleet'),
      (value) => value.identities.daemon.services.daemon.status === 'refused',
      'online machine reports refused daemon',
    )
    await group.grant('daemon', group.artifact('2.0.0'))
    await group.phase('daemon', 'current')
    await until(
      () => socketRequest(group.socket, '/fleet'),
      (value) => value.identities.daemon.services.daemon.status === 'running',
      'replacement daemon available',
    )
    for (const phase of [
      'accepted',
      'downloading',
      'prepared',
      'activating',
      'restarting',
      'current',
    ])
      expect(group.events('daemon').some((event) => event.type === phase)).toBe(true)
  }, 45000)

  it('rolls back a failed successor only when migrations prove it safe', async () => {
    const group = new Group()
    await group.bootFour()
    await group.grant('combined', group.artifact('2.0.0', { failSuccessor: true }))
    await group.phase('combined', 'stuck')
    expect(readFileSync(join(group.install('combined'), 'VERSION'), 'utf8').trim()).toBe('1.0.0')
    await until(
      () => socketRequest(join(group.state('combined'), 'server.sock'), '/identity'),
      (value) => value.version === '1.0.0',
      'old server restored',
    )
    expect(
      JSON.parse(readFileSync(join(group.state('combined'), 'run/parent-outcome.json'), 'utf8'))
        .outcome,
    ).toBe('rolled-back')
    const unsafe = group.artifact('3.0.0', { failSuccessor: true })
    unsafe.schema = { migrations: ['new-schema'] }
    await group.grant('combined', unsafe)
    await group.phase('combined', 'stuck')
    expect(readFileSync(join(group.install('combined'), 'VERSION'), 'utf8').trim()).toBe('3.0.0')
    expect(
      JSON.parse(readFileSync(join(group.state('combined'), 'run/parent-outcome.json'), 'utf8'))
        .outcome,
    ).toBe('rollback-unavailable')
  }, 45000)

  it('executes native desktop primitives in a separate shell stand-in under the same supervisor journal', async () => {
    const group = new Group()
    await group.bootFour()
    group.start('native', [], 'native-helper')
    await until(
      () => existsSync(join(group.runtime('native'), 'machine-update-control.json')),
      Boolean,
      'native supervisor control ready',
    )
    const payload = group.artifact('2.0.0')
    const target = { ...payload, artifacts: { desktop: payload.artifacts.headless } }
    await group.grant('native', target)
    const journal = await group.phase('native', 'current')
    expect(journal?.prepared?.digest).toBe(
      payload.artifacts.headless!.platforms['linux-x86_64']!.digest,
    )
    expect(
      group
        .events('native')
        .some((event) => event.role === 'native-helper' && event.version === '2.0.0'),
    ).toBe(true)
    expect(
      group.events('native').some((event) => event.role === 'daemon' || event.role === 'server'),
    ).toBe(false)
    expect(
      group.events('native').filter((event) => event.type === 'native-activated'),
    ).toHaveLength(1)
  }, 45000)
})
