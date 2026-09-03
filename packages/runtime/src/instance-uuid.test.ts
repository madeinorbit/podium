import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureInstanceStateIdentity,
  INSTANCE_MARKER_VERSION,
  instanceIdentityPath,
  instanceUuidShort,
  mintUuidIntoMarker,
  readInstanceStateIdentity,
  rekeyInstanceStateIdentity,
  validateInstanceUuid,
} from './instance'
import {
  acquireInstanceSingleton,
  acquireStateRootLock,
  defaultInstanceGuardIo,
  holderIsLive,
  type InstanceGuardHolder,
  type InstanceGuardIo,
  instanceGuardDir,
  parseProcStatStartTime,
} from './instance-guard'

const roots: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-uuid-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const writeMarker = (dir: string, body: unknown): void => {
  writeFileSync(instanceIdentityPath(dir), `${JSON.stringify(body, null, 2)}\n`)
}
const readMarkerRaw = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(instanceIdentityPath(dir), 'utf8')) as Record<string, unknown>

describe('instance uuid marker', () => {
  it('mints a uuid for a brand new root and reads it back', () => {
    const dir = temp()
    const marker = ensureInstanceStateIdentity({ instanceId: 'default', dir })
    expect(marker.version).toBe(INSTANCE_MARKER_VERSION)
    expect(validateInstanceUuid(marker.instanceUuid)).toBe(marker.instanceUuid)
    expect(readInstanceStateIdentity(dir)).toEqual(marker)
  })

  it('is stable across repeated claims — the uuid is minted once, not per boot', () => {
    const dir = temp()
    const first = ensureInstanceStateIdentity({ instanceId: 'default', dir })
    const second = ensureInstanceStateIdentity({ instanceId: 'default', dir })
    expect(second.instanceUuid).toBe(first.instanceUuid)
  })

  it('upgrades a version-1 marker IN PLACE, keeping the instance id', () => {
    const dir = temp()
    writeMarker(dir, { version: 1, instanceId: 'blue' })
    // The pure read still reports what is on disk — it must never upgrade.
    expect(readInstanceStateIdentity(dir)).toEqual({ version: 1, instanceId: 'blue' })

    const upgraded = ensureInstanceStateIdentity({ instanceId: 'blue', dir })
    expect(upgraded.instanceId).toBe('blue')
    expect(upgraded.version).toBe(2)
    const onDisk = readMarkerRaw(dir)
    expect(onDisk.version).toBe(2)
    expect(onDisk.instanceId).toBe('blue')
    expect(onDisk.instanceUuid).toBe(upgraded.instanceUuid)
  })

  it('leaves no mint sidecar behind on the happy path', () => {
    const dir = temp()
    writeMarker(dir, { version: 1, instanceId: 'default' })
    ensureInstanceStateIdentity({ instanceId: 'default', dir })
    expect(() => readFileSync(`${instanceIdentityPath(dir)}.mint`, 'utf8')).toThrow()
  })

  it('recovers when a minter died mid-mint, and still mints exactly ONE uuid', () => {
    // A winner took the election and was killed before its rename. Nothing else
    // will ever finish that mint, so the sidecar must be broken rather than
    // waited on forever — otherwise a single hard kill wedges the root's
    // upgrade permanently.
    const dir = temp()
    writeMarker(dir, { version: 1, instanceId: 'default' })
    writeFileSync(`${instanceIdentityPath(dir)}.mint`, 'a minter that died here')
    const recovered = ensureInstanceStateIdentity({ instanceId: 'default', dir })
    expect(validateInstanceUuid(recovered.instanceUuid)).toBe(recovered.instanceUuid)
    expect(readMarkerRaw(dir).instanceUuid).toBe(recovered.instanceUuid)
    expect(readMarkerRaw(dir).version).toBe(2)
  }, 20_000)

  it('CONCURRENT minters on one root all agree on one uuid', async () => {
    // The race the mint election exists for: the CLI, the server and the
    // detached daemon all claim the same root at once on an ordinary boot. If
    // each minted its own uuid, the last writer would win the file and the
    // others would carry an owner id that is on no disk anywhere — so every
    // process they spawned would read as foreign to the census and leak.
    //
    // Run as real processes, because that is the only way the interleaving is
    // genuine rather than staged by the test.
    // Resolve bun explicitly. Under vitest's fork pool `process.execPath` is
    // node, not bun, so a bare 'bun' would fail to spawn and the assertions
    // below would pass over an empty list — a green that measured nothing.
    const bun = [
      process.execPath,
      join(process.env.HOME ?? '', '.bun', 'bin', 'bun'),
      '/usr/local/bin/bun',
    ].find((candidate) => candidate.endsWith('/bun') && existsSync(candidate))
    expect(bun, 'no bun binary found to run the concurrent minters with').toBeDefined()

    const dir = temp()
    writeMarker(dir, { version: 1, instanceId: 'default' })
    // A BARRIER, because without one the first child completes the whole mint
    // before the second has finished starting, and nothing ever contends —
    // measured: this test passed unchanged with the exclusive election removed
    // until the barrier went in. Each child parks on a spin until the go file
    // appears, so they enter the mint window together.
    const goFile = join(dir, 'go')
    const script = join(dir, 'mint.ts')
    writeFileSync(
      script,
      `import { existsSync } from 'node:fs'\n` +
        `import { ensureInstanceStateIdentity } from ${JSON.stringify(join(import.meta.dirname, 'instance.ts'))}\n` +
        `while (!existsSync(${JSON.stringify(goFile)})) {}\n` +
        `process.stdout.write(ensureInstanceStateIdentity({ instanceId: 'default', dir: ${JSON.stringify(dir)} }).instanceUuid)\n`,
    )
    // spawnSync in a loop would run these one after another and race nothing.
    // They have to be in flight at the same time to contend for the mint.
    const runOne = (): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(bun as string, ['run', script], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.on('error', (error) => resolve({ stdout, stderr: `${stderr}${String(error)}` }))
        child.on('close', () => resolve({ stdout, stderr }))
      })
    const pending = Array.from({ length: 6 }, runOne)
    // Let every child reach its spin before releasing them all at once.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    writeFileSync(goFile, 'go')
    const children = await Promise.all(pending)
    const reported = children.map((c) => c.stdout.trim()).filter((v) => v.length > 0)
    // Every child must have produced a uuid. A short list means the spawn
    // failed, and the agreement assertion below would then be vacuous.
    expect(reported, children.map((c) => c.stderr).join('\n')).toHaveLength(6)
    const onDisk = readMarkerRaw(dir).instanceUuid
    expect(validateInstanceUuid(String(onDisk))).toBe(onDisk)
    // EVERY process must report the uuid that is actually on disk.
    expect([...new Set(reported)]).toEqual([onDisk])
  }, 60_000)

  it('a mint LOSER adopts the winner’s uuid instead of minting its own', () => {
    // The invariant the election exists to protect, staged deterministically
    // rather than left to whether six processes happen to overlap.
    //
    // We are the loser: a winner has already taken the election (the sidecar is
    // present) and its rename lands while we are waiting. We must come back
    // with ITS uuid. A loser that mints its own would stamp every process it
    // spawns with an owner id that is on no disk anywhere — invisible to the
    // census, and therefore never reaped.
    const dir = temp()
    writeMarker(dir, { version: 1, instanceId: 'default' })
    const marker = instanceIdentityPath(dir)
    writeFileSync(`${marker}.mint`, 'the winner holds the election')
    const winnerUuid = '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04'
    // Stage the winner's marker from here, so the shell only has to perform the
    // atomic rename. Building the JSON inside the shell command mangles it.
    const staged = `${marker}.staged`
    writeFileSync(
      staged,
      `${JSON.stringify({ version: 2, instanceId: 'default', instanceUuid: winnerUuid }, null, 2)}\n`,
    )
    // The winner's rename, landing 300ms into our 2s wait. Detached from this
    // thread on purpose: `ensure` blocks synchronously, so a timer in this
    // process could never fire while we are inside it.
    const winner = spawn(
      'sh',
      ['-c', `sleep 0.3; mv '${staged}' '${marker}'; rm -f '${marker}.mint'`],
      { stdio: 'ignore' },
    )
    try {
      const loser = ensureInstanceStateIdentity({ instanceId: 'default', dir })
      expect(loser.instanceUuid).toBe(winnerUuid)
      expect(readMarkerRaw(dir).instanceUuid).toBe(winnerUuid)
    } finally {
      winner.kill()
    }
  }, 20_000)

  it('an election winner that raced a COMPLETED mint adopts it, never clobbers it', () => {
    // The other half of the race, staged exactly rather than probabilistically.
    //
    // We read the marker as version 1; between that read and our winning the
    // election, another process ran the whole mint and its rename consumed the
    // sidecar — so our exclusive create succeeds on a fresh file and nothing
    // about the election tells us we are too late. Minting here would rename a
    // second uuid over an already-version-2 marker, and the process that minted
    // first would be left holding a uuid that is no longer on disk.
    const dir = temp()
    const firstMinter = ensureInstanceStateIdentity({ instanceId: 'default', dir })
    // `existing` is the stale read a late arriver still holds.
    const late = mintUuidIntoMarker(dir, { version: 1, instanceId: 'default' })
    expect(late).toBe(firstMinter.instanceUuid)
    expect(readMarkerRaw(dir).instanceUuid).toBe(firstMinter.instanceUuid)
  })

  it('refuses a marker from a NEWER Podium instead of silently downgrading it', () => {
    const dir = temp()
    writeMarker(dir, { version: 3, instanceId: 'default', instanceUuid: 'x', future: true })
    expect(() => readInstanceStateIdentity(dir)).toThrow(/invalid Podium instance marker/)
  })

  it('refuses a version-2 marker with a missing or malformed uuid', () => {
    const missing = temp()
    writeMarker(missing, { version: 2, instanceId: 'default' })
    expect(() => readInstanceStateIdentity(missing)).toThrow(/requires instanceUuid/)

    const malformed = temp()
    writeMarker(malformed, { version: 2, instanceId: 'default', instanceUuid: 'not-a-uuid' })
    expect(() => readInstanceStateIdentity(malformed)).toThrow(/invalid Podium instance uuid/)
  })

  it('shortens to 8 hex characters for a unit name, and refuses a non-uuid', () => {
    expect(instanceUuidShort('0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04')).toBe('0b8e2f41')
    expect(instanceUuidShort('0B8E2F41-3C9A-4D6E-9F21-7A5C8D3E1B04')).toBe('0b8e2f41')
    expect(() => instanceUuidShort('podium-default')).toThrow(/invalid Podium instance uuid/)
  })

  it('rekeys a copied root to a fresh uuid without moving its instance id', () => {
    const dir = temp()
    const before = ensureInstanceStateIdentity({ instanceId: 'blue', dir })
    const after = rekeyInstanceStateIdentity(dir)
    expect(after.instanceId).toBe('blue')
    expect(after.instanceUuid).not.toBe(before.instanceUuid)
    expect(readInstanceStateIdentity(dir)).toEqual(after)
  })

  it('refuses to rekey a root that was never claimed', () => {
    expect(() => rekeyInstanceStateIdentity(temp())).toThrow(/nothing to rekey/)
  })
})

// A holder that this process can stage without staging a process: `pidAlive`
// and the two /proc facts are all injected, so every liveness verdict below is
// a decision about the RULE rather than about whatever pid the box reused.
const stubIo = (over: Partial<InstanceGuardIo> = {}): InstanceGuardIo => ({
  pidAlive: () => true,
  bootId: () => 'boot-a',
  startTime: () => '1000',
  now: () => 1_700_000_000_000,
  selfPid: () => 4242,
  ...over,
})

const holder = (over: Partial<InstanceGuardHolder> = {}): InstanceGuardHolder => ({
  pid: 999,
  bootId: 'boot-a',
  startTime: '1000',
  instanceUuid: '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04',
  stateDir: '/somewhere/else',
  acquiredAtMs: 1,
  ...over,
})

describe('holder liveness — the identity triple', () => {
  it('is live when pid, boot id and start time all still agree', () => {
    expect(holderIsLive(holder(), stubIo())).toBe(true)
  })

  it('is dead when the pid is gone', () => {
    expect(holderIsLive(holder(), stubIo({ pidAlive: () => false }))).toBe(false)
  })

  it('is dead across a REBOOT even though the pid is in use again', () => {
    // The pid exists, and on a bare pid-file guard this reads as held forever:
    // the daemon would never start again after a reboot.
    expect(holderIsLive(holder({ bootId: 'boot-before' }), stubIo())).toBe(false)
  })

  it('is dead when the pid was RECYCLED by an unrelated process', () => {
    // Same boot, pid alive, but it started at a different moment — so it is not
    // the process that wrote the record, and displacing it is correct.
    expect(holderIsLive(holder({ startTime: '77' }), stubIo())).toBe(false)
  })

  it('treats a pid held by ANOTHER UID as live, not as free', () => {
    // pid 1 is root's. A non-root daemon gets EPERM probing it, which means the
    // process EXISTS — reading that as "free" would let us displace a holder we
    // are not even allowed to inspect.
    if (process.platform !== 'linux' || process.getuid?.() === 0) return
    expect(defaultInstanceGuardIo.pidAlive(1)).toBe(true)
  })

  it('does not count a MISSING /proc fact as a mismatch', () => {
    // A host without /proc (darwin) reports neither fact. Reading absence as
    // disagreement would displace live daemons there on every start.
    const noProc = stubIo({ bootId: () => undefined, startTime: () => undefined })
    expect(holderIsLive(holder(), noProc)).toBe(true)
    expect(holderIsLive(holder({ bootId: undefined, startTime: undefined }), stubIo())).toBe(true)
  })
})

describe('parseProcStatStartTime', () => {
  it('reads field 22 past a comm containing spaces and parentheses', () => {
    // Each field literally names its own 1-based position, so an off-by-one in
    // the parser shows up as the wrong NAME rather than a plausible number.
    const fields = Array.from({ length: 50 }, (_, i) => `f${i + 3}`)
    const stat = `1234 (my (weird) prog) ${fields.join(' ')}`
    expect(parseProcStatStartTime(stat.replace('f22', '9876543'))).toBe('9876543')
  })

  it('agrees with the REAL /proc for this very process', () => {
    // The synthetic fixture above and the parser could share the same
    // off-by-one belief and agree with each other while both being wrong —
    // field 21 is `itrealvalue`, which is always 0, so an index one short reads
    // as a plausible number rather than as an error. Anchor it to the kernel:
    // starttime is measured in clock ticks since boot, so it must be a number
    // that has already happened.
    if (process.platform !== 'linux') return
    const startTime = defaultInstanceGuardIo.startTime(process.pid)
    expect(startTime).toMatch(/^\d+$/)
    const uptimeTicks = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 100
    expect(Number(startTime)).toBeGreaterThan(0)
    expect(Number(startTime)).toBeLessThanOrEqual(uptimeTicks)
  })

  it('is undefined for a body that is not a stat line', () => {
    expect(parseProcStatStartTime('nonsense')).toBeUndefined()
  })
})

describe('state root lock', () => {
  it('refuses a second daemon on the same root and names the holder pid', () => {
    const dir = temp()
    const io = stubIo({ selfPid: () => 111 })
    const first = acquireStateRootLock({
      stateDir: dir,
      instanceUuid: '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04',
      io,
    })
    expect(first.identityVerified).toBe(true)
    expect(() =>
      acquireStateRootLock({
        stateDir: dir,
        instanceUuid: '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04',
        io: stubIo({ selfPid: () => 222 }),
      }),
    ).toThrow(/pid 111\) already holds the state root/)
  })

  it('lets a NEW daemon take over after the old one died', () => {
    const dir = temp()
    const uuid = '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04'
    acquireStateRootLock({ stateDir: dir, instanceUuid: uuid, io: stubIo({ selfPid: () => 111 }) })
    const afterReboot = stubIo({ selfPid: () => 222, bootId: () => 'boot-b' })
    expect(() =>
      acquireStateRootLock({ stateDir: dir, instanceUuid: uuid, io: afterReboot }),
    ).not.toThrow()
  })

  it('release removes our record but never someone else’s', () => {
    const dir = temp()
    const uuid = '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04'
    const mine = acquireStateRootLock({
      stateDir: dir,
      instanceUuid: uuid,
      io: stubIo({ selfPid: () => 111 }),
    })
    // A successor took the lock after we were declared dead.
    acquireStateRootLock({
      stateDir: dir,
      instanceUuid: uuid,
      io: stubIo({ selfPid: () => 222, bootId: () => 'boot-b' }),
    })
    mine.release()
    expect(readFileSync(join(dir, 'daemon.lock'), 'utf8')).toContain('222')
  })

  it('marks identity unverified where the host cannot supply the triple', () => {
    const dir = temp()
    const handle = acquireStateRootLock({
      stateDir: dir,
      instanceUuid: '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04',
      io: stubIo({ bootId: () => undefined, startTime: () => undefined }),
    })
    expect(handle.identityVerified).toBe(false)
  })
})

describe('per-machine singleton guard', () => {
  const uuid = '0b8e2f41-3c9a-4d6e-9f21-7a5c8d3e1b04'

  it('refuses a COPIED state root on the same uuid, and names the rekey remedy', () => {
    const guardDir = temp()
    acquireInstanceSingleton({
      instanceUuid: uuid,
      stateDir: '/srv/original',
      guardDir,
      io: stubIo({ selfPid: () => 111 }),
    })
    expect(() =>
      acquireInstanceSingleton({
        instanceUuid: uuid,
        stateDir: '/srv/the-copy',
        guardDir,
        io: stubIo({ selfPid: () => 222 }),
      }),
    ).toThrow(/state root was copied.*podium instance rekey/s)
  })

  it('names the plain second-daemon case differently from the copied-root case', () => {
    const guardDir = temp()
    acquireInstanceSingleton({
      instanceUuid: uuid,
      stateDir: '/srv/original',
      guardDir,
      io: stubIo({ selfPid: () => 111 }),
    })
    expect(() =>
      acquireInstanceSingleton({
        instanceUuid: uuid,
        stateDir: '/srv/original',
        guardDir,
        io: stubIo({ selfPid: () => 222 }),
      }),
    ).toThrow(/already live on instance uuid/)
  })

  it('lets two DIFFERENT uuids coexist on one machine', () => {
    const guardDir = temp()
    const other = '11112222-3333-4444-5555-666677778888'
    acquireInstanceSingleton({
      instanceUuid: uuid,
      stateDir: '/srv/a',
      guardDir,
      io: stubIo({ selfPid: () => 111 }),
    })
    expect(() =>
      acquireInstanceSingleton({
        instanceUuid: other,
        stateDir: '/srv/b',
        guardDir,
        io: stubIo({ selfPid: () => 222 }),
      }),
    ).not.toThrow()
  })

  it('does not strand the instance after a reboot left a stale guard', () => {
    const guardDir = temp()
    acquireInstanceSingleton({
      instanceUuid: uuid,
      stateDir: '/srv/original',
      guardDir,
      io: stubIo({ selfPid: () => 111 }),
    })
    expect(() =>
      acquireInstanceSingleton({
        instanceUuid: uuid,
        stateDir: '/srv/original',
        guardDir,
        io: stubIo({ selfPid: () => 222, bootId: () => 'boot-b' }),
      }),
    ).not.toThrow()
  })

  it('re-acquiring in the SAME process is idempotent, not a self-conflict', () => {
    const guardDir = temp()
    const io = stubIo({ selfPid: () => 111 })
    acquireInstanceSingleton({ instanceUuid: uuid, stateDir: '/srv/a', guardDir, io })
    expect(() =>
      acquireInstanceSingleton({ instanceUuid: uuid, stateDir: '/srv/a', guardDir, io }),
    ).not.toThrow()
  })

  it('refuses a uuid that is not a uuid rather than creating a junk guard path', () => {
    expect(() =>
      acquireInstanceSingleton({
        instanceUuid: '../../etc',
        stateDir: '/srv/a',
        guardDir: temp(),
        io: stubIo(),
      }),
    ).toThrow(/invalid Podium instance uuid/)
  })

  it('reports machineWide=false when no machine-wide runtime tree is reachable', () => {
    const home = temp()
    const discovered = instanceGuardDir({ HOME: home, XDG_RUNTIME_DIR: undefined }, home)
    if (discovered.machineWide) {
      // This host has /run/user/<uid>; the reachable case is the one under test
      // elsewhere, so assert the path is under it rather than asserting a flag
      // the host contradicts.
      expect(discovered.dir).toContain('podium/instances')
    } else {
      expect(discovered.dir).toContain(home)
    }
  })

  it('puts the guard under XDG_RUNTIME_DIR when there is one', () => {
    const runtime = temp()
    const discovered = instanceGuardDir({ XDG_RUNTIME_DIR: runtime, HOME: '/home/nobody' })
    if (process.platform !== 'darwin') {
      expect(discovered).toEqual({ dir: join(runtime, 'podium', 'instances'), machineWide: true })
    }
  })
})
