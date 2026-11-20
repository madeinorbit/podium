/**
 * Test support for managed installs (POD-7269): a local fake vendor host and
 * one fake adapter that installs from it, plus the per-harness vendor fixtures
 * the conformance test serves each registry adapter from.
 *
 * Not collected as a test file (no `.test.` in the name); imported by the
 * mechanism tests, the conformance test and the crash child process.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { BuiltinHarnessKind } from '@podium/model'
import { grokVendorFixture } from '../adapters/grok/install.test-support.js'
import type { HarnessInstall, HarnessInstallPorts } from '../manifest.js'
import type { HarnessVersionPolicy } from '../version-policy.js'
import type { ManagedInstallTarget, VendorOrigins } from './managed-install.js'

/** The fake vendor's real-looking host. Never resolvable: only the vendor-origin map reaches it. */
export const FAKE_VENDOR_BASE = 'https://downloads.fake-harness.invalid/releases'

/** One release the fake vendor publishes, and how its binary misbehaves. */
export interface FakeRelease {
  version: string
  /**
   * What the binary does on `--version`: print this version (`ok`), print
   * another (`wrong-version`), exit 3 (`exit`), hang (`hang`), or not be an
   * executable at all (`not-executable`). `identity-exit` prints the version
   * on `--version` and exits 3 for anything else (an identity probe that errors).
   */
  behaviour?: 'ok' | 'wrong-version' | 'exit' | 'hang' | 'not-executable' | 'identity-exit'
  /** Serve a checksum that does not match the binary. */
  badChecksum?: boolean
  /** The vendor's installer script exits non-zero. */
  installerFails?: boolean
}

function binaryFor(release: FakeRelease): string {
  switch (release.behaviour ?? 'ok') {
    case 'ok':
      return `#!/bin/sh\necho "fake-harness ${release.version} (Fake Harness)"\n`
    case 'wrong-version':
      return '#!/bin/sh\necho "fake-harness 0.0.1 (Fake Harness)"\n'
    case 'exit':
      return '#!/bin/sh\necho "fake-harness: broken build" >&2\nexit 3\n'
    case 'hang':
      return '#!/bin/sh\nexec sleep 30\n'
    case 'not-executable':
      return 'this is not a program\n'
    case 'identity-exit':
      return `#!/bin/sh\nif [ "$1" = --version ]; then echo "fake-harness ${release.version}"; exit 0; fi\nexit 3\n`
  }
}

/**
 * The vendor's installer: it does what real installers do with the person's
 * home (edits shell profiles, links into `~/.local/bin`, writes a config
 * folder). Run with the release's own `HOME`, all of it must land there.
 */
function installerFor(release: FakeRelease): string {
  if (release.installerFails)
    return '#!/bin/sh\necho "installer: unsupported platform" >&2\nexit 1\n'
  return [
    '#!/bin/sh',
    'set -e',
    'mkdir -p "$HOME/.local/bin" "$HOME/.fake-harness"',
    'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> "$HOME/.bashrc"',
    'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> "$HOME/.profile"',
    'echo "channel=stable" > "$HOME/.fake-harness/config"',
    'ln -sf "$1" "$HOME/.local/bin/fake-harness"',
    '',
  ].join('\n')
}

/** A local HTTP server playing the fake harness's vendor. */
export class FakeVendorHost {
  readonly requests: string[] = []
  latest: string
  private readonly releases = new Map<string, FakeRelease>()
  private server: Server | undefined
  origin = ''

  constructor(releases: FakeRelease[] = [{ version: '1.0.0' }]) {
    for (const release of releases) this.publish(release)
    this.latest = releases.at(-1)?.version ?? '1.0.0'
  }

  /** Publish a release and make it the latest. */
  publish(release: FakeRelease): void {
    this.releases.set(release.version, release)
    this.latest = release.version
  }

  /** Map the fake vendor's real-looking base to this server. */
  get origins(): VendorOrigins {
    return { [FAKE_VENDOR_BASE]: `${this.origin}/releases` }
  }

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const path = request.url ?? '/'
      this.requests.push(path)
      const send = (status: number, body: string | Buffer) => {
        response.writeHead(status, { 'content-type': 'application/octet-stream' })
        response.end(body)
      }
      if (path === '/releases/stable') return send(200, `${this.latest}\n`)
      const match = /^\/releases\/([^/]+)\/(manifest\.json|fake-harness|install\.sh)$/.exec(path)
      const release = match ? this.releases.get(match[1] as string) : undefined
      if (!match || !release) return send(404, 'not found')
      const binary = Buffer.from(binaryFor(release))
      if (match[2] === 'fake-harness') return send(200, binary)
      if (match[2] === 'install.sh') return send(200, installerFor(release))
      const digest = release.badChecksum
        ? '0'.repeat(64)
        : createHash('sha256').update(binary).digest('hex')
      return send(200, JSON.stringify({ sha256: digest, publishedAt: '2026-11-20T00:00:00.000Z' }))
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** What the fake adapter was handed, for the environment assertions. */
export interface FakeAdapterObservation {
  checkEnv?: Readonly<Record<string, string>>
  installEnv?: Readonly<Record<string, string>>
  installerEnv?: Readonly<Record<string, string>>
  home?: string
  dir?: string
}

/**
 * The fake harness's managed-install section, written the way a real adapter
 * should be: vendor URLs named as the vendor names them and fetched through the
 * ports, the checksum checked, the vendor installer run with `installerEnv`.
 */
export function fakeHarnessInstall(observed: FakeAdapterObservation = {}): HarnessInstall {
  return {
    async latest(ports) {
      observed.checkEnv = ports.env
      return { version: (await ports.fetchText(`${FAKE_VENDOR_BASE}/stable`)).trim() }
    },
    async install(release, dir, ports: HarnessInstallPorts) {
      observed.installEnv = ports.env
      observed.installerEnv = ports.installerEnv
      observed.home = ports.home
      observed.dir = dir
      const base = `${FAKE_VENDOR_BASE}/${release.version}`
      const manifest = JSON.parse(await ports.fetchText(`${base}/manifest.json`)) as {
        sha256: string
        publishedAt: string
      }
      mkdirSync(join(dir, 'bin'))
      const binary = join(dir, 'bin', 'fake-harness')
      await ports.fetch(`${base}/fake-harness`, binary)
      const actual = createHash('sha256').update(readFileSync(binary)).digest('hex')
      if (actual !== manifest.sha256) throw new Error('fake-harness checksum verification FAILED')
      chmodSync(binary, 0o755)
      const installer = join(dir, 'install.sh')
      await ports.fetch(`${base}/install.sh`, installer)
      try {
        await ports.runTool('sh', [installer, binary], ports.installerEnv)
      } finally {
        rmSync(installer, { force: true })
      }
      return {
        executable: 'bin/fake-harness',
        integrity: { kind: 'sha256', digest: actual, publishedAt: manifest.publishedAt },
        source: `${base}/fake-harness`,
      }
    },
  }
}

/** The fake adapter as a mechanism target. It borrows a real kind because ledger rows are keyed by one. */
export function fakeTarget(
  options: {
    kind?: BuiltinHarnessKind
    versionPolicy?: HarnessVersionPolicy
    observed?: FakeAdapterObservation
  } = {},
): ManagedInstallTarget {
  return {
    kind: options.kind ?? 'claude-code',
    install: fakeHarnessInstall(options.observed),
    versionArgs: ['--version'],
    ...(options.versionPolicy ? { versionPolicy: options.versionPolicy } : {}),
  }
}

/**
 * How the conformance test serves one adapter's vendor: start a local host
 * that answers what that adapter asks for, and the origin map that sends the
 * adapter's real vendor URLs to it.
 */
export interface VendorFixture {
  start(): Promise<{ origins: VendorOrigins; stop(): Promise<void> }>
}

/** The fake harness's vendor, as a fixture. */
export const fakeVendorFixture: VendorFixture = {
  async start() {
    const host = await new FakeVendorHost().start()
    return { origins: host.origins, stop: () => host.stop() }
  },
}

/**
 * One fake vendor per registry adapter that declares a managed install. A
 * harness task that ports an adapter adds its vendor here; the conformance test
 * fails, naming the harness, until it does.
 */
export const MANAGED_INSTALL_VENDOR_FIXTURES: Partial<Record<BuiltinHarnessKind, VendorFixture>> = {
  grok: grokVendorFixture,
}
