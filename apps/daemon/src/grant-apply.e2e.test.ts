import { execFileSync } from 'node:child_process'
import { createHash, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateGrantMessage } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerDevFeedRoutes } from '../../server/src/modules/updates/artifact-route'
import { developmentArtifactUrl } from '../../server/src/modules/updates/dev-publisher-wiring'
import { readOrCreateUpdateSigningKey } from '../../server/src/modules/updates/signing-key'
import { startServer } from '../../server/src/server'
import { startDaemon } from './daemon'
import { readPendingGrant } from './pending-grant'

/**
 * ONE MACHINE, UPDATED FROM THE PULLED DEV FEED, END TO END (spec §1; this
 * issue's first acceptance line).
 *
 * WHAT THIS FILE COVERED BEFORE, AND WHY IT CHANGED. It used to drive the git
 * delivery path: a daemon converging a checkout to a granted sha. That delivery
 * kind is retired — exactly one machine runs from source, the publisher, and it
 * is not a fleet consumer — so the round trip it proved no longer exists. This
 * is the round trip that replaced it, and it is a stricter one: bytes off a
 * wire, verified against a key this daemon really pinned when it really paired,
 * before anything touches disk.
 *
 * REAL AT EVERY LAYER THAT COULD BE WRONG. The daemon is a live daemon on a live
 * socket to a live server; the signing key is the server's own persisted
 * instance key; the daemon's copy of it arrives through the pairing handshake
 * rather than being handed over in the test; the artifact is served by the REAL
 * feed route, streamed, with its real 401-first authentication; the signature
 * and digest are checked by the real delivery code; and the swap really unpacks
 * a real tarball over a real install directory.
 *
 * The one seam left standing is the composition: `server.ts` mounts that same
 * feed route on the server's own app, and this test mounts it on a second port.
 * The resolver's side of the loop — pulling the manifest and stamping the trust
 * root — is proved in `release-target.test.ts`.
 */

/** `podium-headless-<version>.tar.gz`, with the `headless/` dir the swap expects. */
function packHeadless(stage: string, version: string): Uint8Array {
  const payload = join(stage, 'payload')
  mkdirSync(join(payload, 'headless'), { recursive: true })
  writeFileSync(join(payload, 'headless', 'VERSION'), `${version}\n`)
  const tarball = join(stage, 'bundle.tar.gz')
  execFileSync('tar', ['-czf', tarball, '-C', payload, 'headless'], { stdio: 'ignore' })
  return new Uint8Array(readFileSync(tarball))
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for daemon grant convergence'))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

/** Serve the real dev feed routes on their own port, standing in for the origin. */
async function serveFeed(
  bundlePath: string,
  version: string,
  token: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = new Hono()
  registerDevFeedRoutes(app, {
    // This test asks for `linux-x86_64` by name, so the resolver must return
    // that exact platform and version rather than falling back to the host.
    publishedArtifact: (requestedVersion, requestedPlatform) => {
      if (requestedVersion !== version || requestedPlatform !== 'linux-x86_64') {
        return null
      }
      return {
        platform: 'linux-x86_64',
        path: bundlePath,
        size: readFileSync(bundlePath).byteLength,
        digest: '',
        signature: '',
        version,
      }
    },
    manifestPath: () => undefined,
    authenticate: (request) => new URL(request.url).searchParams.get('token') === token,
  })
  const server: Server = createServer((req, res) => {
    void (async () => {
      const response = await app.fetch(
        new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method ?? 'GET' }),
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    })()
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('daemon update grant over the live server socket', () => {
  it('downloads, verifies against its PINNED key, and swaps a dev-feed artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-grant-e2e-'))
    const stateDir = join(root, 'state')
    const runtimeDir = join(root, 'runtime')
    const identityDir = join(root, 'identity')
    const installDir = join(root, 'install', 'headless')
    const stage = join(root, 'stage')
    const priorStateDir = process.env.PODIUM_STATE_DIR
    const priorAppVersion = process.env.PODIUM_APP_VERSION
    const priorPodiumHome = process.env.PODIUM_HOME
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    let feed: Awaited<ReturnType<typeof serveFeed>> | undefined
    let markerAtRestart: ReturnType<typeof readPendingGrant> = null

    const fromVersion = '0.1.2-dev.3+aaaaaaa'
    const toVersion = '0.1.2-dev.4+bbbbbbb'
    const token = 'e2e-artifact-token'

    try {
      process.env.PODIUM_STATE_DIR = stateDir
      // An INSTALLED daemon: it has a directory of its own to swap, which is
      // what makes it a fleet consumer rather than a source checkout.
      mkdirSync(installDir, { recursive: true })
      mkdirSync(stage, { recursive: true })
      writeFileSync(join(installDir, 'VERSION'), `${fromVersion}\n`)
      process.env.PODIUM_HOME = installDir
      process.env.PODIUM_APP_VERSION = fromVersion

      const bytes = packHeadless(stage, toVersion)
      const bundlePath = join(stage, 'bundle.tar.gz')

      server = await startServer({ port: 0 })
      // The server's OWN persisted instance key — the same one its handshake
      // hands the daemon to pin. Reading it here signs the artifact as the
      // publisher would; nothing about the trust root is faked.
      const signingKey = readOrCreateUpdateSigningKey(stateDir)
      feed = await serveFeed(bundlePath, toVersion, token)

      const machineId = server.registry.sessionStore.hostMachineId
      daemon = await startDaemon({
        serverUrl: `ws://127.0.0.1:${server.port}`,
        bootstrapToken: server.bootstrapToken,
        machineId,
        identityDir,
        hooks: { port: 0, settingsDir: runtimeDir },
        agentRelay: { port: 0 },
        tmux: false,
        discovery: { background: false, cachePath: ':memory:' },
        metrics: { background: false },
        restartAfterUpdate: () => {
          markerAtRestart = readPendingGrant(runtimeDir)
        },
      })

      await waitFor(() =>
        Boolean(
          server?.registry.modules.machines
            .listMachines()
            .some(
              (machine) =>
                machine.id === machineId && machine.online && machine.appVersion === fromVersion,
            ),
        ),
      )

      const target: UpdateGrantMessage['target'] = {
        version: toVersion,
        critical: false,
        // Stamped by the resolver from the channel; the daemon reads it and
        // never decides for itself which key may have signed these bytes.
        trust: 'instance',
        artifacts: {
          headless: {
            delivery: 'feed',
            platforms: {
              'linux-x86_64': {
                url: developmentArtifactUrl(feed.origin, toVersion, token, 'linux-x86_64'),
                digest: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
                signature: sign(null, bytes, {
                  key: Buffer.from(signingKey.privateKey, 'base64'),
                  format: 'der',
                  type: 'pkcs8',
                }).toString('base64'),
              },
            },
          },
        },
      }
      const updates = server.registry.modules.updates
      server.registry.modules.machines.setUpdateChannel(machineId, 'dev')
      updates.setTarget(target)
      expect(updates.tick()).toEqual([machineId])

      await waitFor(() => readFileSync(join(installDir, 'VERSION'), 'utf8').trim() === toVersion)
      await waitFor(() => typeof markerAtRestart?.grantId === 'string')
      await waitFor(
        () => updates.fleet().find((machine) => machine.id === machineId)?.state === 'restarting',
      )

      expect(markerAtRestart).toMatchObject({
        targetVersion: toVersion,
        previousVersion: fromVersion,
        attempts: 1,
      })
      expect(updates.fleet().find((machine) => machine.id === machineId)).toMatchObject({
        state: 'restarting',
        version: fromVersion,
      })
    } finally {
      await daemon?.close()
      await feed?.close()
      await server?.close()
      if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = priorStateDir
      if (priorAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
      else process.env.PODIUM_APP_VERSION = priorAppVersion
      if (priorPodiumHome === undefined) delete process.env.PODIUM_HOME
      else process.env.PODIUM_HOME = priorPodiumHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})
