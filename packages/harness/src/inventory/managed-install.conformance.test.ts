/**
 * MANAGED-INSTALL CONFORMANCE (POD-7269, docs/design/harness-managed-installs.md
 * §10 check 1): every adapter that declares a managed install installs into the
 * folder it was given and writes nowhere else.
 *
 * The adapters come from the registry, never a hand-written list, so a newly
 * ported adapter is covered the moment it declares the section; it then needs
 * a fake vendor in `MANAGED_INSTALL_VENDOR_FIXTURES`, and this file fails,
 * naming it, until it has one. The fake test adapter runs through the same
 * check, so the check itself is proven while no real adapter is ported.
 *
 * Each install runs with a decoy HOME (in the command environment AND in this
 * process, so `os.homedir()` finds it too) holding a decoy `~/.local/bin`,
 * every harness's folders and the usual shell profiles. Afterwards the decoy is
 * byte-identical, the harness folder holds only the published release, and no
 * request left the machine.
 */
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_MANIFESTS } from '../registry.js'
import { InstallLedger } from './install-ledger.js'
import { readInstallReceipt } from './install-receipt.js'
import {
  installRelease,
  type ManagedInstallTarget,
  managedInstallTargets,
} from './managed-install.js'
import {
  fakeTarget,
  fakeVendorFixture,
  MANAGED_INSTALL_VENDOR_FIXTURES,
  type VendorFixture,
} from './managed-install.test-support.js'

const REGISTERED = managedInstallTargets()

interface Case {
  name: string
  target: ManagedInstallTarget
  vendor: VendorFixture | undefined
}

const CASES: Case[] = [
  ...REGISTERED.map((target) => ({
    name: target.kind,
    target,
    vendor: MANAGED_INSTALL_VENDOR_FIXTURES[target.kind],
  })),
  { name: 'fake harness (test adapter)', target: fakeTarget(), vendor: fakeVendorFixture },
]

const PROFILES = [
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.config/fish/config.fish',
]

/** A decoy home with something in every place an installer likes to write. */
function buildDecoyHome(home: string, env: Record<string, string>): void {
  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  for (const profile of PROFILES) write(join(home, profile), `# decoy ${profile}\n`)
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    for (const name of manifest.inventory.executable.names)
      write(join(home, '.local', 'bin', name), `#!/bin/sh\necho decoy ${name}\n`)
    const roots = manifest.roots(home, env)
    for (const folder of new Set(Object.values(roots).filter((v): v is string => !!v)))
      write(join(folder, 'decoy-sentinel'), `decoy ${manifest.kind}\n`)
  }
}

/** Every entry under `dir`: names, modes, link targets, bytes. */
function snapshot(dir: string): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (path: string, rel: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) entries.set(rel, `link ${stat.mode} ${readlinkSync(path)}`)
    else if (stat.isDirectory()) {
      entries.set(rel, `dir ${stat.mode}`)
      for (const name of readdirSync(path)) walk(join(path, name), `${rel}/${name}`)
    } else
      entries.set(
        rel,
        `file ${stat.mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      )
  }
  walk(dir, '.')
  return entries
}

let root: string
let decoy: string
let harnessesDir: string
let savedHome: string | undefined
let savedFetch: typeof fetch
let escaped: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-install-conformance-'))
  decoy = join(root, 'decoy-home')
  harnessesDir = join(root, 'state', 'harnesses')
  savedHome = process.env.HOME
  savedFetch = globalThis.fetch
  escaped = []
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  globalThis.fetch = savedFetch
  rmSync(root, { recursive: true, force: true })
})

describe('managed-install conformance', () => {
  it('has a fake vendor for every registry adapter that declares a managed install', () => {
    const missing = REGISTERED.filter((t) => !MANAGED_INSTALL_VENDOR_FIXTURES[t.kind]).map(
      (t) => t.kind,
    )
    expect(missing, 'add a fake vendor to MANAGED_INSTALL_VENDOR_FIXTURES').toEqual([])
  })

  it.each(CASES)('$name installs into the folder it was given and nowhere else', async (c) => {
    if (!c.vendor)
      throw new Error(`${c.name} has no fake vendor in MANAGED_INSTALL_VENDOR_FIXTURES`)
    const run = await installWithDecoy(c.target, c.vendor)
    expect(run.result, JSON.stringify(run.result)).toMatchObject({ outcome: 'installed' })
    if (run.result.outcome !== 'installed') return

    expect(escaped).toEqual([])
    expect(run.after).toEqual(run.before)

    // The harness folder holds exactly the published release, with its receipt.
    const kindDir = join(harnessesDir, c.target.kind)
    expect(readdirSync(kindDir)).toEqual([`1-${run.result.version}`])
    expect(readInstallReceipt(run.result.dir)).toMatchObject({ ok: true })
    // Beside the harness folders, the state folder holds only the ledger.
    expect(readdirSync(harnessesDir).filter((n) => !n.startsWith('ledger.db'))).toEqual([
      c.target.kind,
    ])
  })

  it('catches an adapter that runs its vendor installer in the machine home', async () => {
    const honest = fakeTarget()
    const leaky: ManagedInstallTarget = {
      ...honest,
      install: {
        latest: honest.install.latest,
        install: (release, dir, ports) =>
          honest.install.install(release, dir, { ...ports, installerEnv: ports.env }),
      },
    }
    const run = await installWithDecoy(leaky, fakeVendorFixture)
    expect(run.result.outcome).toBe('installed')
    const changed = [...run.after].filter(([path, entry]) => run.before.get(path) !== entry)
    expect(changed.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./.bashrc', './.profile', './.local/bin/fake-harness']),
    )
  })
})

/** One install with the decoy home in place and only the fake vendor reachable. */
async function installWithDecoy(target: ManagedInstallTarget, vendor: VendorFixture) {
  const commandEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: decoy,
    SHELL: '/bin/sh',
  }
  buildDecoyHome(decoy, commandEnv)
  const before = snapshot(decoy)

  // Only the loopback fake vendor is reachable, through the port and around it.
  const realFetch = savedFetch
  const loopbackOnly = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      escaped.push(url)
      throw new Error(`conformance: ${url} is not the fake vendor`)
    }
    return realFetch(input, init)
  }) as typeof fetch
  globalThis.fetch = loopbackOnly
  process.env.HOME = decoy

  const host = await vendor.start()
  const ledger = InstallLedger.open({ harnessesDir })
  try {
    const result = await installRelease(target.kind, {
      ledger,
      commandEnv,
      vendorOrigins: host.origins,
      fetchImpl: loopbackOnly,
      target,
      probeTimeoutMs: 30_000,
    })
    return { result, before, after: snapshot(decoy) }
  } finally {
    ledger.close()
    await host.stop()
  }
}
