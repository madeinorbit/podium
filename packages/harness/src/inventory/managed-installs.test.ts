/**
 * The inventory with two installs (POD-7270, managed installs §6.1 and §7):
 * the install ledger is read on every wave, its current release (or the
 * previous one when the current fails the probe) is probed beside the
 * person's install, and the person's is found exactly as before.
 */
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { AgentInventory } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildResolvedInventory, type ProbeExec } from './build-inventory.js'
import { InstallLedger, LEDGER_FILE } from './install-ledger.js'
import { type InstallReceipt, releaseFolderName, writeInstallReceipt } from './install-receipt.js'
import { managedInstallsReader, readManagedInstalls } from './managed-installs.js'

let root: string
let home: string
let harnessesDir: string
const ledgers: InstallLedger[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'managed-inv-'))
  home = join(root, 'home')
  harnessesDir = join(root, 'state', 'harnesses')
  mkdirSync(home, { recursive: true })
})
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  rmSync(root, { recursive: true, force: true })
})

function openLedger(): InstallLedger {
  const ledger = InstallLedger.open({ harnessesDir, isProcessAlive: () => true })
  ledgers.push(ledger)
  return ledger
}

function receipt(kind: InstallReceipt['harness'], version: string): InstallReceipt {
  return {
    format: 1,
    harness: kind,
    version,
    executable: `bin/${kind === 'claude-code' ? 'claude' : kind}`,
    integrity: { kind: 'sha256', digest: 'b'.repeat(64), publishedAt: '2026-11-19T00:00:00.000Z' },
    source: `https://downloads.example.com/${kind}/${version}`,
    installedAt: '2026-11-20T00:00:00.000Z',
  }
}

/** Install one release the way the install mechanism does: allocate, fill, publish. */
function publish(
  ledger: InstallLedger,
  kind: InstallReceipt['harness'],
  version: string,
  script = '#!/bin/sh\n',
): string {
  ledger.requestInstall(kind, 'person')
  const result = ledger.acquireInstallLock({ label: 'test', autoRenew: false })
  if (!result.acquired) throw new Error('lock not acquired')
  try {
    const number = ledger.allocateReleaseNumber(kind, result.lock)
    const dir = join(harnessesDir, kind, releaseFolderName(number, version))
    const written = receipt(kind, version)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, written.executable), script, { mode: 0o755 })
    writeInstallReceipt(dir, written)
    ledger.publishRelease(kind, number, result.lock)
    return join(dir, written.executable)
  } finally {
    result.lock.release()
  }
}

/**
 * Answers `--version` by the exact argv[0]: the person's install is probed by
 * name (the injected-exec seam), a managed release by its absolute path.
 */
function execBy(versions: Record<string, string>): ProbeExec & { calls: string[][] } {
  const calls: string[][] = []
  const exec: ProbeExec = async (argv) => {
    calls.push([...argv])
    const version = versions[argv[0] as string]
    if (version === undefined) throw new Error(`ENOENT: ${argv[0]}`)
    return version
  }
  return Object.assign(exec, { calls })
}

function build(exec: ProbeExec) {
  return buildResolvedInventory({
    homeDir: home,
    env: { PATH: '/usr/bin:/bin', HOME: home },
    exec,
    managedInstalls: managedInstallsReader(harnessesDir),
  })
}

/** Every path under `dir` with its size, so a write anywhere below shows. */
function treeListing(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const stat = statSync(path)
      out.push(`${relative(dir, path)}:${stat.isDirectory() ? 'dir' : stat.size}`)
      if (stat.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}

const claudeOf = (inventory: { agents: AgentInventory[] }) =>
  inventory.agents.find((agent) => agent.kind === 'claude-code')

describe('the inventory reads the install ledger (managed installs §6.1)', () => {
  it('reports the current release as managed, beside the person’s install found as today', async () => {
    const managedPath = publish(openLedger(), 'claude-code', '2.1.311')
    const snapshot = await build(execBy({ claude: '2.1.300', [managedPath]: '2.1.311' }))

    expect(snapshot.executables.get('claude-code')).toMatchObject({
      path: 'claude',
      version: '2.1.300',
    })
    expect(snapshot.managed?.get('claude-code')).toMatchObject({
      path: managedPath,
      version: '2.1.311',
      release: 1,
    })
    const agent = claudeOf(snapshot.inventory)
    // The top level keeps naming the person's install.
    expect(agent).toMatchObject({ installed: true, version: '2.1.300', path: 'claude' })
    expect(agent?.install).toEqual({
      external: { path: 'claude', version: '2.1.300' },
      managed: { active: { path: managedPath, version: '2.1.311', release: 1 }, paused: false },
    })
    expect(AgentInventory.parse(agent)).toEqual(agent)
  })

  it('falls back to the previous release when the current one fails its probe', async () => {
    const ledger = openLedger()
    const older = publish(ledger, 'claude-code', '2.1.305')
    const broken = publish(ledger, 'claude-code', '2.1.311')
    const exec = execBy({ [older]: '2.1.305' })
    const snapshot = await build(exec)

    expect(exec.calls.map((argv) => argv[0])).toContain(broken)
    expect(snapshot.managed?.get('claude-code')).toMatchObject({ path: older, release: 1 })
    expect(claudeOf(snapshot.inventory)?.install?.managed).toEqual({
      active: { path: older, version: '2.1.305', release: 1 },
      currentFailed: { release: 2, version: '2.1.311' },
      paused: false,
    })
  })

  it('reports no managed install when neither the current nor the previous passes', async () => {
    const ledger = openLedger()
    publish(ledger, 'claude-code', '2.1.305')
    publish(ledger, 'claude-code', '2.1.311')
    const snapshot = await build(execBy({ claude: '2.1.300' }))

    expect(snapshot.managed?.has('claude-code')).toBe(false)
    expect(snapshot.executables.get('claude-code')?.path).toBe('claude')
    expect(claudeOf(snapshot.inventory)?.install?.managed).toEqual({
      currentFailed: { release: 2, version: '2.1.311' },
      previousVersion: '2.1.305',
      paused: false,
    })
  })

  it('never reaches past the previous release', async () => {
    const ledger = openLedger()
    const oldest = publish(ledger, 'claude-code', '2.1.300')
    publish(ledger, 'claude-code', '2.1.305')
    publish(ledger, 'claude-code', '2.1.311')
    const exec = execBy({ [oldest]: '2.1.300' })
    const snapshot = await build(exec)

    expect(exec.calls.map((argv) => argv[0])).not.toContain(oldest)
    expect(snapshot.managed?.has('claude-code')).toBe(false)
  })

  it('names Podium’s install at the top level when the person has none', async () => {
    const managedPath = publish(openLedger(), 'codex', '0.167.2')
    const snapshot = await build(execBy({ [managedPath]: 'codex-cli 0.167.2' }))

    // The person's side still has nothing: a context in their folder cannot start.
    expect(snapshot.executables.has('codex')).toBe(false)
    expect(snapshot.managed?.get('codex')?.path).toBe(managedPath)
    const codex = snapshot.inventory.agents.find((agent) => agent.kind === 'codex')
    expect(codex).toMatchObject({
      installed: true,
      path: managedPath,
      version: 'codex-cli 0.167.2',
    })
    expect(codex?.install?.external).toBeUndefined()
  })

  it('runs the managed binary’s identity probe on its own', async () => {
    const managedPath = publish(openLedger(), 'pi', '0.9.0')
    const answers: ProbeExec = async (argv) => {
      if (argv[0] !== managedPath) throw new Error('ENOENT')
      if (argv[1] === '--help') return 'something else entirely'
      return '0.9.0'
    }
    const snapshot = await build(answers)
    expect(snapshot.managed?.has('pi')).toBe(false)
  })

  it('probes a managed binary in a temporary home it removes, never the person’s folders (POD-7382)', async () => {
    // Codex 0.171.0 creates `.codex/tmp/arg0-linux` helper links even for
    // `--version`. This binary writes the same way into wherever its home is.
    const observed = join(root, 'observed')
    const script = [
      '#!/bin/sh',
      'state="$HOME/.codex"; [ -n "$CODEX_HOME" ] && state="$CODEX_HOME"',
      'mkdir -p "$state/tmp/arg0-linux"',
      'echo link > "$state/tmp/arg0-linux/codex-linux-sandbox"',
      `printf "HOME=%s\\nCODEX_HOME=%s\\nOPENAI_API_KEY=%s\\nPATH=%s\\nKEPT=%s\\n" "$HOME" "$CODEX_HOME" "$OPENAI_API_KEY" "$PATH" "$KEPT" > "${observed}"`,
      'echo "codex-cli 0.171.0"',
      '',
    ].join('\n')
    const managedPath = publish(openLedger(), 'codex', '0.171.0', script)
    const personCodex = join(root, 'person-codex')
    for (const dir of [home, personCodex]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'sentinel'), 'personal state\n')
    }
    const releaseDir = join(managedPath, '..', '..')
    const before = [home, personCodex, releaseDir].map(treeListing)
    const run = promisify(execFile)
    // Only the managed binary really runs; the person's installs are absent.
    const exec: ProbeExec = async (argv, timeoutMs, env) => {
      if (argv[0] !== managedPath) throw new Error(`ENOENT: ${argv[0]}`)
      const { stdout } = await run(managedPath, argv.slice(1), {
        timeout: timeoutMs,
        ...(env ? { env } : {}),
      })
      return stdout
    }
    const snapshot = await buildResolvedInventory({
      homeDir: home,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        CODEX_HOME: personCodex,
        OPENAI_API_KEY: 'foreign-key',
        KEPT: 'kept',
      },
      exec,
      managedInstalls: managedInstallsReader(harnessesDir),
    })

    expect(snapshot.managed?.get('codex')).toMatchObject({
      path: managedPath,
      version: 'codex-cli 0.171.0',
    })
    // Neither the person's folders nor the immutable release folder changed.
    expect([home, personCodex, releaseDir].map(treeListing)).toEqual(before)
    const seen = Object.fromEntries(
      readFileSync(observed, 'utf8')
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    expect(seen).toMatchObject({ CODEX_HOME: '', OPENAI_API_KEY: '', KEPT: 'kept' })
    expect(seen.PATH?.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/bin']))
    expect(seen.HOME?.startsWith(join(tmpdir(), 'podium-probe-codex-'))).toBe(true)
    // The probe home, and what the binary wrote there, is gone.
    expect(existsSync(seen.HOME as string)).toBe(false)
  })

  it('leaves the inventory exactly as before when nothing is managed', async () => {
    const exec = execBy({ claude: '2.1.300' })
    const withReader = await build(exec)
    const without = await buildResolvedInventory({
      homeDir: home,
      env: { PATH: '/usr/bin:/bin', HOME: home },
      exec,
    })
    expect(withReader.inventory).toEqual(without.inventory)
    expect(withReader.managed?.size).toBe(0)
    // Reading an empty state folder created nothing in it.
    expect(existsSync(join(harnessesDir, LEDGER_FILE))).toBe(false)
  })

  it('shows a release published by another program in the next wave', async () => {
    const exec = execBy({ claude: '2.1.300' })
    const reader = managedInstallsReader(harnessesDir)
    const options = {
      homeDir: home,
      env: { PATH: '/usr/bin:/bin', HOME: home },
      exec,
      managedInstalls: reader,
    }
    expect((await buildResolvedInventory(options)).managed?.size).toBe(0)

    // The CLI publishes through its own connection while the reader stays.
    const managedPath = publish(openLedger(), 'claude-code', '2.1.311')
    exec.calls.length = 0
    const versions = { claude: '2.1.300', [managedPath]: '2.1.311' }
    const next = await buildResolvedInventory({ ...options, exec: execBy(versions) })
    expect(next.managed?.get('claude-code')?.path).toBe(managedPath)
  })

  it('reports the ledger’s rebuild and its update state', async () => {
    const ledger = openLedger()
    publish(ledger, 'codex', '0.167.0')
    const current = publish(ledger, 'codex', '0.167.2')
    ledger.setPaused('codex', true)
    ledger.recordCheck('codex', { ok: false, error: 'vendor unreachable' })
    ledger.close()
    ledgers.splice(0)
    rmSync(join(harnessesDir, LEDGER_FILE))

    const snapshot = await build(execBy({ [current]: '0.167.2' }))
    const install = snapshot.inventory.agents.find((agent) => agent.kind === 'codex')?.install
    // Rebuilt from the folders: the highest becomes current, the next previous.
    expect(install?.managed).toMatchObject({
      active: { path: current, release: 2 },
      previousVersion: '0.167.0',
      paused: false,
    })
    expect(install?.ledgerRebuilt).toMatchObject({ reason: 'missing' })
  })

  it('carries the update state the updater records', () => {
    const ledger = openLedger()
    publish(ledger, 'codex', '0.167.2')
    ledger.setPaused('codex', true)
    ledger.recordCheck('codex', { ok: false, error: 'vendor unreachable' })
    const read = readManagedInstalls(harnessesDir).harnesses.get('codex')
    expect(read).toMatchObject({
      paused: true,
      lastCheck: { ok: false, error: 'vendor unreachable' },
    })
    expect(read?.failingSince).toBeDefined()
  })
})

describe('the install wire object (managed installs §8)', () => {
  const base = {
    kind: 'codex',
    installed: true,
    version: '0.167.2',
    path: '/usr/local/bin/codex',
    login: { state: 'in' },
  }

  it('is optional: a payload without it parses', () => {
    expect(AgentInventory.parse(base)).toEqual(base)
  })

  it('parses every field the updater fills later', () => {
    const agent = {
      ...base,
      install: {
        external: { path: '/usr/local/bin/codex', version: '0.160.0' },
        managed: {
          active: {
            path: '/state/harnesses/codex/3-0.167.2/codex',
            version: '0.167.2',
            release: 3,
          },
          currentFailed: { release: 4, version: '0.168.0' },
          previousVersion: '0.166.1',
          latest: '0.168.0',
          lastCheckAt: '2026-11-20T10:00:00.000Z',
          paused: true,
          lastError: {
            at: '2026-11-20T10:00:00.000Z',
            message: 'checksum mismatch',
            version: '0.168.0',
          },
          failingSince: '2026-11-18T10:00:00.000Z',
        },
        ledgerRebuilt: { at: '2026-11-20T09:00:00.000Z', reason: 'damaged' },
      },
    }
    expect(AgentInventory.parse(agent)).toEqual(agent)
  })
})
