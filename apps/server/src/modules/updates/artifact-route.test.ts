import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, describe, expect, it } from 'vitest'
import { registerDevFeedRoutes } from './artifact-route'
import { type BuiltDevBundle, DevBundleUnavailableError } from './dev-bundle'
import {
  developmentArtifactUrl,
  selectDevelopmentArtifactOrigin,
  wireDevBundlePublisher,
} from './dev-publisher-wiring'

const bytes = new Uint8Array([9, 8, 7, 6])
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const signature = sign(null, bytes, privateKey)

// A real file, because the route's job is now to stream one off disk.
const stage = mkdtempSync(join(tmpdir(), 'podium-dev-bundle-'))
const artifact = join(stage, 'podium-headless-dev+abc1234-linux-x86_64-20260812T182015Z.tar.gz')
writeFileSync(artifact, bytes)
// A second platform, so the route has something to tell apart from the host's.
const darwinBytes = new Uint8Array([1, 2, 3, 4, 5])
const darwinArtifact = join(
  stage,
  'podium-headless-dev+abc1234-darwin-aarch64-20260812T182015Z.tar.gz',
)
writeFileSync(darwinArtifact, darwinBytes)
afterAll(() => rmSync(stage, { recursive: true, force: true }))

// The manifest leg of the same feed, written where the publisher writes it.
const manifestPath = join(stage, 'podium-update.json')
const manifest = { version: 'dev+abc1234', critical: false, artifacts: {} }
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)

const desktopManifestPath = join(stage, 'latest.json')
const desktopManifest = {
  version: '0.4.2-edge.7',
  bridgeVersion: 1,
  platforms: {
    'linux-x86_64': {
      url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium.AppImage',
      signature: 'EDGE-SIGNATURE',
    },
  },
}
writeFileSync(desktopManifestPath, JSON.stringify(desktopManifest) + '\n')

const built: BuiltDevBundle = {
  version: 'dev+abc1234',
  path: artifact,
  size: bytes.length,
  digest: 'sha256-fixture',
  signature: signature.toString('base64'),
  artifacts: [
    {
      platform: 'linux-x86_64',
      path: artifact,
      size: bytes.length,
      digest: 'sha256-fixture',
      signature: signature.toString('base64'),
      version: 'dev+abc1234',
    },
    {
      platform: 'darwin-aarch64',
      path: darwinArtifact,
      size: darwinBytes.length,
      digest: 'sha256-darwin-fixture',
      signature: signature.toString('base64'),
      version: 'dev+abc1234',
    },
  ],
}

function appFor(authenticated = true) {
  const app = new Hono()
  registerDevFeedRoutes(app, {
    current: () => built,
    manifestPath: () => manifestPath,
    desktopManifestPath: () => desktopManifestPath,
    authenticate: (request: Request) =>
      authenticated && request.headers.get('authorization') === 'Bearer machine-token',
  })
  return app
}

describe('development artifact route', () => {
  it('builds an origin-relative route with encoded version and authentication token', () => {
    const url = new URL(
      developmentArtifactUrl(
        'https://podium.example.test:55555',
        'dev+abc/123',
        'random token/?',
        'darwin-aarch64',
      ),
    )
    expect(url.origin).toBe('https://podium.example.test:55555')
    // The platform is in the PATH: the URL names which bytes come back.
    expect(url.pathname).toBe('/updates/feed/dev/artifact/dev%2Babc%2F123/darwin-aarch64')
    expect(url.searchParams.get('token')).toBe('random token/?')
  })
  it('keeps a source publisher enabled for same-host fallback', () => {
    const base: Parameters<typeof wireDevBundlePublisher>[0] = {
      sourceRoot: '/repo/podium',
      artifactOrigin: 'https://podium.example.test',
      localArtifactOrigin: () => 'http://127.0.0.1:18787',
      hasRemoteManagedMachines: () => false,
      artifactToken: 'random-token',
      signingKey: 'unused-until-build',
      setTarget: () => {},
      locks: {
        acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
        cancel: () => {},
        renew: () => {},
        release: () => {},
      },
    }
    expect(wireDevBundlePublisher(base).enabled).toBe(true)
    expect(
      wireDevBundlePublisher({
        ...base,
        artifactOrigin: undefined,
      }).enabled,
    ).toBe(true)
    expect(wireDevBundlePublisher({ ...base, sourceRoot: undefined }).enabled).toBe(false)
  })

  it('shares ONE cached HEAD reader across everything it wires', async () => {
    // The composition is the only place that can share it, and a shared reader
    // is exactly the kind of wiring that goes missing without anyone noticing:
    // drop it and every caller still works, just with a `git rev-parse` each
    // (POD-2052). A poll reads HEAD twice — to decide, and to name the target.
    const root = mkdtempSync(join(tmpdir(), 'wiring-head-'))
    try {
      mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)

      let reads = 0
      const wiring = wireDevBundlePublisher({
        sourceRoot: root,
        artifactOrigin: 'https://podium.example.test',
        localArtifactOrigin: () => 'http://127.0.0.1:18787',
        hasRemoteManagedMachines: () => false,
        artifactToken: 'random-token',
        signingKey: 'unused-until-build',
        setTarget: () => {},
        locks: {
          acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
          cancel: () => {},
          renew: () => {},
          release: () => {},
        },
        readHeadSha: async () => {
          reads++
          return 'aaaaaaa'
        },
      })

      for (let i = 0; i < 8; i++) await wiring.publishTarget()
      expect(reads).toBe(1)

      // A commit lands: the stamp moves and the next reader goes back to git.
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`)
      await wiring.publishTarget()
      expect(reads).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses loopback only for a same-host managed fleet', () => {
    const localOrigin = 'http://127.0.0.1:18787'
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: 'https://podium.example.test',
        localOrigin,
        hasRemoteManagedMachines: true,
      }),
    ).toBe('https://podium.example.test')
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteManagedMachines: false,
      }),
    ).toBe(localOrigin)
    expect(() =>
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteManagedMachines: true,
      }),
    ).toThrow(/requires PODIUM_DEV_ARTIFACT_BASE_URL/)
  })

  /**
   * A DEAD END IS THE ONE OUTCOME §6.2 AND §7 FORBID (POD-2227).
   *
   * This refusal was measured live: an installed machine paired to a source
   * coordinator sat on "Waiting for the update package." for over ten minutes
   * with nothing to click and no explanation, while the only statement of the
   * cause was a single server-log line. The guard itself is right — a loopback
   * URL handed to a remote daemon sends it back to itself — so what has to
   * change is that it says so, in a sentence naming the one next action.
   */
  it('refuses with the configuration remedy, not just a log line', () => {
    let thrown: unknown
    try {
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin: 'http://127.0.0.1:18787',
        hasRemoteManagedMachines: true,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DevBundleUnavailableError)
    const reason = (thrown as DevBundleUnavailableError).publicReason
    // The remedy is IN the sentence a client is shown, not in the console half.
    expect(reason).toMatch(/Public URL/)
    expect(reason).toMatch(/PODIUM_DEV_ARTIFACT_BASE_URL/)
    // …and the console half keeps naming the condition for whoever reads a log.
    expect((thrown as Error).message).toMatch(/remote managed machines are registered/)
  })

  it('gives up before the build rather than packing what it cannot hand out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiring-origin-'))
    try {
      mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)
      const wiring = wireDevBundlePublisher({
        sourceRoot: root,
        artifactOrigin: undefined,
        localArtifactOrigin: () => 'http://127.0.0.1:18787',
        hasRemoteManagedMachines: () => true,
        artifactToken: 'random-token',
        signingKey: 'unused-until-build',
        setTarget: () => {},
        locks: {
          acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
          cancel: () => {},
          renew: () => {},
          release: () => {},
        },
        readHeadSha: async () => 'aaaaaaa',
      })

      // Thirty-five seconds of compile to arrive at the same dead end is the
      // wrong shape of honest: the answer is knowable before the first byte.
      await expect(wiring.requestBuild()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DevBundleUnavailableError && /Public URL/.test(error.publicReason),
      )
      // And the read model stops claiming the package is on its way. `fleet`
      // reported `bundleReady: true` throughout the live drive, which reads as
      // the package being ready while the target could not carry it at all.
      const preparation = wiring.preparation()
      expect(preparation.bundleReady).toBe(false)
      expect(preparation.failureDetail).toMatch(/Public URL/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * WHERE THE LOOPBACK GUARANTEE LIVES NOW.
   *
   * Two tests here used to prove that `targetForSharedReadModel` STRIPPED a
   * loopback artifact URL before a target reached the read model, so a remote
   * daemon could never be handed `127.0.0.1`. That function is gone, and not
   * because the guarantee stopped mattering: deliverable targets are PULLED
   * from the feed now, so a loopback URL never gets as far as a target at all.
   * The question is settled one step earlier and harder — this server refuses
   * to name a feed address it knows its fleet cannot reach.
   *
   * These are the arms that hold the same line at its new home.
   */
  describe('the dev feed descriptor this server hands its own resolver', () => {
    const wiringFor = (over: Partial<Parameters<typeof wireDevBundlePublisher>[0]> = {}) =>
      wireDevBundlePublisher({
        sourceRoot: '/repo/podium',
        artifactOrigin: 'https://podium.example.test',
        localArtifactOrigin: () => 'http://127.0.0.1:18787',
        hasRemoteManagedMachines: () => false,
        artifactToken: 'random-token',
        signingKey: 'unused-until-build',
        setTarget: () => {},
        locks: {
          acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
          cancel: () => {},
          renew: () => {},
          release: () => {},
        },
        readHeadSha: async () => 'aaaaaaa',
        ...over,
      })

    it('names its own feed, fenced to it, on the instance trust root', () => {
      expect(wiringFor().channelFeed()).toEqual({
        manifestUrl: 'https://podium.example.test/updates/feed/dev/podium-update.json',
        artifactBase: 'https://podium.example.test/updates/feed/dev/',
        trust: 'instance',
        headers: { authorization: 'Bearer random-token' },
      })
    })

    it('fences artifacts to the feed it just named', () => {
      const feed = wiringFor().channelFeed()
      expect(
        developmentArtifactUrl('https://podium.example.test', 'v1', 'random-token', 'linux-x86_64'),
      ).toMatch(new RegExp(`^${feed?.artifactBase}`))
    })

    it('falls back to loopback only for a same-host fleet', () => {
      expect(wiringFor({ artifactOrigin: undefined }).channelFeed()?.manifestUrl).toBe(
        'http://127.0.0.1:18787/updates/feed/dev/podium-update.json',
      )
    })

    it('names NO feed rather than a loopback one once a remote machine is registered', () => {
      expect(
        wiringFor({
          artifactOrigin: undefined,
          hasRemoteManagedMachines: () => true,
        }).channelFeed(),
      ).toBeUndefined()
    })

    it('names no feed at all on an installed server', () => {
      expect(wiringFor({ sourceRoot: undefined }).channelFeed()).toBeUndefined()
    })
  })

  describe('the manifest leg of the feed', () => {
    it('serves the edge-referencing shell manifest without machine credentials', async () => {
      const response = await appFor(false).request('/updates/feed/dev/latest.json')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual(desktopManifest)
    })

    it('serves the published manifest to an authenticated machine', async () => {
      const response = await appFor().request('/updates/feed/dev/podium-update.json', {
        headers: { authorization: 'Bearer machine-token' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual(manifest)
    })

    it('refuses an unauthenticated manifest request', async () => {
      // The manifest names artifact URLs carrying this server's token, so
      // handing it over unauthenticated would hand over the credential too.
      expect((await appFor().request('/updates/feed/dev/podium-update.json')).status).toBe(401)
    })

    it('says not found when nothing has been published into the feed', async () => {
      const app = new Hono()
      registerDevFeedRoutes(app, {
        current: () => built,
        manifestPath: () => undefined,
        authenticate: () => true,
      })
      expect((await app.request('/updates/feed/dev/podium-update.json')).status).toBe(404)
    })
  })

  it('streams the exact signed bytes to an authenticated machine', async () => {
    const app = appFor()
    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234', {
      headers: { authorization: 'Bearer machine-token' },
    })
    const served = new Uint8Array(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(Array.from(served)).toEqual(Array.from(bytes))
    expect(verify(null, served, publicKey, Buffer.from(built.signature, 'base64'))).toBe(true)
  })

  it('serves each platform its OWN bundle', async () => {
    const app = appFor()
    const linux = await app.request('/updates/feed/dev/artifact/dev%2Babc1234/linux-x86_64', {
      headers: { authorization: 'Bearer machine-token' },
    })
    const darwin = await app.request('/updates/feed/dev/artifact/dev%2Babc1234/darwin-aarch64', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(Array.from(new Uint8Array(await linux.arrayBuffer()))).toEqual(Array.from(bytes))
    expect(Array.from(new Uint8Array(await darwin.arrayBuffer()))).toEqual(Array.from(darwinBytes))
  })

  it('says not found for a platform this build did not mint', async () => {
    // NOT a fallback to the host's bundle: handing a Mac a Linux tarball fails its
    // signature check after a 200 MB download, which is a far worse answer than a 404
    // it can act on.
    const app = appFor()
    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234/darwin-x86_64', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(response.status).toBe(404)
  })

  it('still serves the host bundle at the URL minted before platforms were in it', async () => {
    // A daemon may be holding a pre-multi-platform URL. It only ever meant this host's
    // bundle, and that is still what it returns.
    const app = appFor()
    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(response.status).toBe(200)
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(bytes))
  })

  it('authenticates before it looks at the platform', async () => {
    const app = appFor(false)
    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234/darwin-aarch64')
    expect(response.status).toBe(401)
  })

  it('says not found when the published artifact is no longer on disk', async () => {
    // Retention, a clean checkout, an operator with a shell: the file can go
    // between publication and a request, and the honest answer is "not here".
    const app = new Hono()
    registerDevFeedRoutes(app, {
      current: () => ({ ...built, path: join(stage, 'never-written.tar.gz') }),
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })
    expect((await app.request('/updates/feed/dev/artifact/dev%2Babc1234')).status).toBe(404)
  })

  it('opens the artifact only after authentication and version agree', async () => {
    const opened: string[] = []
    const app = new Hono()
    registerDevFeedRoutes(app, {
      current: () => built,
      manifestPath: () => manifestPath,
      authenticate: (request: Request) =>
        request.headers.get('authorization') === 'Bearer machine-token',
      open: async (path: string) => {
        opened.push(path)
        return { stream: new Blob([bytes]).stream(), size: bytes.length }
      },
    })

    await app.request('/updates/feed/dev/artifact/dev%2Babc1234')
    await app.request('/updates/feed/dev/artifact/dev%2Bold', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(opened).toEqual([])

    await app.request('/updates/feed/dev/artifact/dev%2Babc1234', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(opened).toEqual([built.path])
  })

  it('refuses an unauthenticated request', async () => {
    const response = await appFor().request('/updates/feed/dev/artifact/dev%2Babc1234')
    expect(response.status).toBe(401)
  })

  it('refuses a version that is not the current build', async () => {
    const response = await appFor().request('/updates/feed/dev/artifact/dev%2Bold', {
      headers: { authorization: 'Bearer machine-token' },
    })
    expect(response.status).toBe(404)
  })

  it('does not expose a stale path after the current build changes', async () => {
    let current: BuiltDevBundle | null = built
    const app = new Hono()
    registerDevFeedRoutes(app, {
      current: () => current,
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })

    current = { ...built, version: 'dev+new1234' }
    const stale = await app.request('/updates/feed/dev/artifact/dev%2Babc1234')
    const fresh = await app.request('/updates/feed/dev/artifact/dev%2Bnew1234')
    expect(stale.status).toBe(404)
    expect(fresh.status).toBe(200)
  })
})
