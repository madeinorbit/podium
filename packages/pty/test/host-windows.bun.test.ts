/** Real Windows ConPTY/named-pipe acceptance. Run with the guest's test:file lane. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectHost,
  HOST_TAIL,
  type HostConnection,
  HostErr,
  hostHasSession,
  hostSocketDir,
  hostSocketPath,
  killHostSession,
  listLiveHostLabels,
  probeHostSocket,
  spawnHostAgent,
} from '../src/host'
import { hostBinFeatures, resolveHostBin } from '../src/host-bin'
import { createDurableProcess, sweepStaleDurableBindTemps } from '../src/durable-process'

const windows = process.platform === 'win32'
const connections: HostConnection[] = []
const labels: string[] = []
const saved: Record<string, string | undefined> = {}
let root = ''
let bin = ''
let fixture = ''
let serial = 0
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(
  pred: () => boolean | Promise<boolean>,
  what: string,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() >= end) throw new Error(`timed out: ${what}`)
    await wait(20)
  }
}
function label(): string {
  const name = `win-${process.pid}-${serial++}`
  labels.push(name)
  return name
}
function connection(name: string, mode: 'writer' | 'reader' = 'reader', fromSeq = 0n) {
  const c = connectHost(hostSocketPath(name), { mode, fromSeq })
  connections.push(c)
  let text = ''
  c.onData((_seq, data) => {
    text += data.toString()
  })
  return { c, text: () => text }
}
async function create(
  name: string,
  noPty: boolean,
  command?: string,
  args?: string[],
  ringBytes?: number,
) {
  const s = await spawnHostAgent({
    label: name,
    cmd: command ?? process.execPath,
    args: args ?? [fixture],
    ...(noPty ? { noPty: true as const } : { cols: 80, rows: 24 }),
    ...(ringBytes ? { ringBytes } : {}),
    lingerSecs: 2,
    requireLease: true,
  })
  connections.push(s.connection)
  return s
}

describe.skipIf(!windows)('Windows durable host', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'podium-win-host-'))
    for (const key of [
      'PODIUM_HOST_SOCKET_DIR',
      'PODIUM_STATE_DIR',
      'PODIUM_HOST_BIN',
      'PODIUM_NO_SCOPE',
      'PODIUM_INSTANCE',
    ])
      saved[key] = process.env[key]
    process.env.PODIUM_HOST_SOCKET_DIR = join(root, 'sockets')
    process.env.PODIUM_STATE_DIR = join(root, 'state')
    process.env.PODIUM_INSTANCE = 'winhosttest'
    process.env.PODIUM_NO_SCOPE = '1'
    bin = resolveHostBin({ fresh: true }) ?? ''
    expect(bin.endsWith('.exe')).toBe(true)
    expect(hostBinFeatures(bin)).toBe(2)
    process.env.PODIUM_HOST_BIN = bin
    fixture = join(root, 'echo.js')
    writeFileSync(
      fixture,
      `process.stdout.write(Buffer.from('READY\\n')); process.stdin.on('data', b => { const s=b.toString(); if(s.includes('EXIT')) { process.stdout.write(Buffer.from('FINAL\\n')); process.exit(23) } else if(s.includes('FLOOD')) { process.stdout.write(Buffer.from('x'.repeat(10000)+'END\\n')) } else { process.stdout.write('ECHO:'+s) } });`,
    )
  }, 180_000)
  afterEach(async () => {
    for (const c of connections.splice(0)) c.destroy()
    for (const name of labels.splice(0)) await killHostSession(name)
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resolveHostBin({ fresh: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('Windows recovery never mistakes legacy POSIX inventory files for sessions', async () => {
    const name = label()
    const dir = join(root, 'legacy')
    mkdirSync(dir)
    const marker = join(dir, `${name}@old-host`)
    const bind = join(dir, '.abduco-2147483647')
    writeFileSync(marker, 'ordinary Windows file')
    writeFileSync(bind, 'ordinary Windows file')
    const prior = process.env.ABDUCO_SOCKET_DIR
    process.env.ABDUCO_SOCKET_DIR = dir
    try {
      const durable = createDurableProcess()
      expect(await durable.has(name)).toBe(false)
      expect(await durable.locate(name)).toBeUndefined()
      expect(await durable.list()).not.toContain(name)
      expect(sweepStaleDurableBindTemps()).toEqual([])
      expect(existsSync(bind)).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.ABDUCO_SOCKET_DIR
      else process.env.ABDUCO_SOCKET_DIR = prior
    }
  })

  it('PowerShell streams, accepts input, and applies one changed resize', async () => {
    const name = label()
    const s = await create(name, false, 'powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NoExit',
      '-Command',
      "Write-Output 'WINDOWS_BOOT'",
    ])
    const view = connection(name)
    const w = await view.c.welcome
    expect(w.hasPty).toBe(true)
    await until(() => view.text().includes('WINDOWS_BOOT'), `shell startup: ${view.text()}`)
    expect(
      await s.connection.write(Buffer.from("Write-Output ('INPUT_' + 'ACCEPTED')\r")),
    ).toBeGreaterThan(0)
    await until(() => view.text().includes('INPUT_ACCEPTED'), 'interactive input')
    expect(await s.connection.resize(113, 37)).toEqual({ cols: 113, rows: 37, changed: true })
    expect(await s.connection.size()).toEqual({ cols: 113, rows: 37 })
    expect(await s.connection.resize(113, 37)).toEqual({ cols: 113, rows: 37, changed: false })
    await s.connection.write(
      Buffer.from(
        "Write-Output ('SIZE_' + $Host.UI.RawUI.WindowSize.Width + '_' + $Host.UI.RawUI.WindowSize.Height)\r",
      ),
    )
    await until(() => view.text().includes('SIZE_113_37'), 'child observes ConPTY size')
    // dev/mw uses pictures, not the old resize nudge. A resize immediately
    // followed by a picture cannot restore stale geometry.
    const pictures: Array<{
      cols: number
      rows: number
      bytes: Uint8Array
      reason: 'reset' | 'cut'
    }> = []
    s.onPicture((p) => pictures.push(p))
    const pending = s.resize(101, 31)
    expect(s.requestPicture()).toBe(true)
    await pending
    await until(
      () => pictures.some((p) => p.cols === 101 && p.rows === 31),
      'picture at acknowledged grid',
    )
    expect(await s.connection.size()).toEqual({ cols: 101, rows: 31 })
    await s.connection.write(Buffer.from("Write-Output ('RETAINED_' + 'SCROLLBACK')\r"))
    await until(() => view.text().includes('RETAINED_SCROLLBACK'), 'retained console output')
    pictures.length = 0
    s.requestPicture()
    await until(
      () => pictures.some((p) => Buffer.from(p.bytes).toString().includes('RETAINED_SCROLLBACK')),
      'picture retains scrollback',
    )
    // Sustained VT output drives the shared cut clock on Windows too.
    pictures.length = 0
    await s.connection.write(
      Buffer.from("1..3000 | ForEach-Object { Write-Output ('CUT_' + $_ + 'x' * 60) }\r"),
    )
    await until(
      () => pictures.some((p) => p.reason === 'cut'),
      'automatic Windows screen cut',
      30_000,
    )
  }, 30_000)

  it('pipes merge output and preserve the real exit code and final bytes', async () => {
    const name = label()
    const s = await create(name, true)
    const view = connection(name)
    expect((await view.c.welcome).hasPty).toBe(false)
    await expect(s.connection.resize(80, 24)).rejects.toMatchObject({ code: HostErr.NO_PTY })
    await s.connection.write(Buffer.from('hello\n'))
    await until(() => view.text().includes('ECHO:hello'), 'pipe input')
    await s.connection.write(Buffer.from('EXIT\n'))
    await until(() => view.c.exited !== undefined, 'exit frame')
    expect(view.c.exited).toEqual({ code: 23, signal: 0 })
    expect(view.text()).toContain('FINAL')
    await until(
      async () => (await probeHostSocket(hostSocketPath(name))) === 'missing',
      'linger closes pipe',
    )
    expect(existsSync(join(hostSocketDir(), `${name}.sock`))).toBe(false)
  })

  it('one writer lease, explicit takeover and owner kill clean up the child job', async () => {
    const name = label()
    const s = await create(name, true)
    const challenger = connection(name, 'writer', HOST_TAIL)
    expect((await challenger.c.welcome).lease).toBe(false)
    const refusedWrite = challenger.c.write(Buffer.from('bad\n'))
    const refusedSize = challenger.c.size()
    const replies = await Promise.allSettled([refusedWrite, refusedSize])
    expect(replies[0]).toMatchObject({ status: 'rejected', reason: { code: HostErr.NOT_WRITER } })
    expect(replies[1]).toMatchObject({ status: 'rejected', reason: { code: HostErr.NO_PTY } })
    await challenger.c.steal()
    await expect(s.connection.write(Buffer.from('old\n'))).rejects.toMatchObject({
      code: HostErr.NOT_WRITER,
    })
    expect((await challenger.c.status()).writers).toBe(1)
    // killHostSession must take an occupied lease on Windows, rather than
    // TerminateProcess(host), which cannot clean up the marker.
    await killHostSession(name)
    await until(async () => !(await hostHasSession(name)), 'child killed')
    await until(() => !existsSync(join(hostSocketDir(), `${name}.sock`)), 'pidfile removed')
  }, 20_000)

  it('ring gaps, monotonic sequences and explicit replay use SPEC-6 framing', async () => {
    const name = label()
    const s = await create(name, true, undefined, undefined, 4096)
    await s.connection.write(Buffer.from('FLOOD\n'))
    await until(async () => (await s.connection.status()).seqHigh > 10_000n, 'ring fills')
    const view = connection(name)
    let gap = 0n
    view.c.onGap((low) => {
      gap = low
    })
    const w = await view.c.welcome
    await until(() => view.text().includes('END'), 'ring replay')
    expect(gap).toBe(w.seqLow)
    expect(gap).toBeGreaterThan(0n)
    expect(view.c.lastSeq).toBe(w.seqHigh)
    const prior = view.text().length
    expect((await view.c.replay(100)).bytes).toBe(100)
    expect(view.text().length - prior).toBe(100)
  })

  it('survives its spawning process exit, reattaches and replays scrollback', async () => {
    const name = label()
    const result = join(root, 'started.json')
    const starter = join(root, 'starter.ts')
    const hostModule = fileURLToPath(new URL('../src/host.ts', import.meta.url))
    writeFileSync(
      starter,
      `import {spawnHostAgent} from ${JSON.stringify(hostModule)}; import {writeFileSync} from 'node:fs'; const s=await spawnHostAgent({label:${JSON.stringify(name)},cmd:process.execPath,args:[${JSON.stringify(fixture)}],noPty:true,lingerSecs:2}); await s.connection.write(Buffer.from('BEFORE_RESTART\\n')); await new Promise(r=>setTimeout(r,100)); writeFileSync(${JSON.stringify(result)},JSON.stringify(await s.ready)); process.exit(0);`.replace(
        'JSON.stringify(await s.ready)',
        'JSON.stringify({hostPid:(await s.ready).hostPid,childPid:s.pid})',
      ),
    )
    execFileSync(process.execPath, [starter], { env: process.env, timeout: 20_000 })
    const original = JSON.parse(readFileSync(result, 'utf8')) as {
      hostPid: number
      childPid: number
    }
    const view = connection(name, 'writer')
    const w = await view.c.welcome
    expect({ hostPid: w.hostPid, childPid: w.childPid }).toEqual(original)
    expect(w.lease).toBe(true)
    expect((await view.c.status()).alive).toBe(true)
    await until(() => view.text().includes('BEFORE_RESTART'), 'retained scrollback')
    await view.c.write(Buffer.from('AFTER_RESTART\n'))
    await until(() => view.text().includes('AFTER_RESTART'), 'reattached input')
    expect(await listLiveHostLabels()).toContain(name)
  }, 30_000)

  it('an already-owned pipe refuses a second create without replacing the live host', async () => {
    const name = label()
    const s = await create(name, true)
    const result = spawnSync(
      bin,
      ['create', '--socket', hostSocketPath(name), '--no-pty', '--', process.execPath, fixture],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(3)
    expect((await s.connection.status()).alive).toBe(true)
  })

  it('launches a batch CLI shim without expanding or executing its arguments', async () => {
    const name = label()
    const script = join(root, 'args.js')
    const shim = join(root, 'cli shim.cmd')
    const args = ['hello world', 'a&b', '%PATH%', 'quote"inside', 'path with space\\', '日本語', '']
    writeFileSync(
      script,
      `console.log(JSON.stringify(process.argv.slice(2))); setTimeout(()=>{},60000)`,
    )
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    await create(name, true, shim, args)
    const view = connection(name)
    await view.c.welcome
    await until(() => view.text().includes(JSON.stringify(args)), 'literal batch argv')
  })

  it('reports missing executables synchronously and publishes no discovery marker', async () => {
    const name = label()
    await expect(create(name, true, 'podium-definitely-missing.exe')).rejects.toThrow()
    expect(await probeHostSocket(hostSocketPath(name))).toBe('missing')
    expect(existsSync(join(hostSocketDir(), `${name}.sock`))).toBe(false)
  })
})
