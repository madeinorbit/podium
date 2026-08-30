import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPDATE_ARTIFACT_INTEGRITY_REFUSAL, UPDATE_ARTIFACT_REFUSAL_HEADER } from '@podium/protocol'
import { Hono } from 'hono'
import { afterAll, describe, expect, it } from 'vitest'
import { DEV_DESKTOP_CHANNEL_HEADER, registerDevFeedRoutes } from './artifact-route'
import {
  type BuiltDevBundle,
  DevArtifactIntegrityError,
  type DevBundleArtifact,
  DevBundleUnavailableError,
} from './dev-bundle'
import {
  developmentArtifactUrl,
  selectDevelopmentArtifactOrigin,
  wireDevBundlePublisher,
  isRemoteUpdateConsumer,
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
  buildId: '20260812T182015Z-abc1234',
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
function resolveBuiltArtifact(
  bundle: BuiltDevBundle | null,
  version: string,
  platform?: string,
): DevBundleArtifact | null {
  if (!bundle || bundle.version !== version) return null
  if (platform !== undefined) {
    return bundle.artifacts.find((artifact) => artifact.platform === platform) ?? null
  }
  const host = bundle.artifacts[0]
  if (!host) return null
  return {
    ...host,
    version: bundle.version,
    path: bundle.path,
  }
}

function appFor(authenticated = true) {
  const app = new Hono()
  registerDevFeedRoutes(app, {
    publishedArtifact: (version, platform) => resolveBuiltArtifact(built, version, platform),
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
      hasRemoteUpdateConsumers: () => false,
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
        hasRemoteUpdateConsumers: () => false,
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

      for (let i = 0; i < 8; i++) await wiring.proposal()
      expect(reads).toBe(1)

      // A commit lands: the stamp moves and the next reader goes back to git.
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`)
      await wiring.proposal()
      expect(reads).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts a registered remote consumer by reported feed capability, not pairing policy', () => {
    // Membership decides one thing: whether an externally reachable origin is
    // mandatory. It says nothing about whether the machine is up (POD-3040).
    const machines = [
      { id: 'source-host', deliveryCaps: ['update.delivery.feed'] },
      { id: 'careful-remote', deliveryCaps: ['update.delivery.feed'] },
      { id: 'managed-nonconsumer', deliveryCaps: ['shipping.train.v2'] },
    ]

    expect(
      machines.filter((machine) => isRemoteUpdateConsumer(machine, 'source-host')).map((m) => m.id),
    ).toEqual(['careful-remote'])
  })

  it('uses loopback only for a same-host update fleet', () => {
    const localOrigin = 'http://127.0.0.1:18787'
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: 'https://podium.example.test',
        localOrigin,
        hasRemoteUpdateConsumers: true,
      }),
    ).toBe('https://podium.example.test')
    expect(
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteUpdateConsumers: false,
      }),
    ).toBe(localOrigin)
    expect(() =>
      selectDevelopmentArtifactOrigin({
        externalOrigin: undefined,
        localOrigin,
        hasRemoteUpdateConsumers: true,
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
        hasRemoteUpdateConsumers: true,
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
    expect((thrown as Error).message).toMatch(/remote update consumers are registered/)
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
        hasRemoteUpdateConsumers: () => true,
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
        hasRemoteUpdateConsumers: () => false,
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
          hasRemoteUpdateConsumers: () => true,
        }).channelFeed(),
      ).toBeUndefined()
    })

    it('names no feed at all on an installed server', () => {
      expect(wiringFor({ sourceRoot: undefined }).channelFeed()).toBeUndefined()
    })
  })

  describe('the release publication boundary', () => {
    /**
     * The publisher this boundary composes over. Hoisted out of `wiringFor` so
     * a test can replace ONE of its answers — what the artifact route serves —
     * without restating the other ten.
     */
    let publications = 0
    const publisherFor = () => ({
      requestBuild: async () => built,
      current: () => built,
      publishedArtifact: async (version: string, platform?: string) =>
        resolveBuiltArtifact(built, version, platform),
      target: async () => undefined,
      feedManifest: async () => undefined,
      publishFeed: async () => {
        publications += 1
        return true
      },
      proposal: async () => undefined,
      feedManifestPath: () => manifestPath,
      desktopManifestPath: () => desktopManifestPath,
      desktopManifestSource: () => undefined,
      readiness: async () => ({
        state: 'ready' as const,
        headSha: 'abc1234',
        version: built.version,
      }),
      unavailable: () => undefined,
    })

    const wiringFor = (over: Partial<Parameters<typeof wireDevBundlePublisher>[0]> = {}) => {
      publications = 0
      const unavailable: string[] = []
      const wiring = wireDevBundlePublisher({
        sourceRoot: '/repo/podium',
        artifactOrigin: 'http://source:18787',
        localArtifactOrigin: () => 'http://127.0.0.1:18787',
        // A remote consumer IS registered throughout this describe, and none of
        // these tests says whether it is online: after POD-3040 that fact is
        // not an input to publication at all.
        hasRemoteUpdateConsumers: () => true,
        artifactToken: 'random-token',
        signingKey: 'test-key',
        setTarget: () => {},
        setTargetUnavailable: (reason) => unavailable.push(reason),
        locks: {
          acquire: () => ({ granted: true, alreadyHeld: false, lock: {} as never }),
          cancel: () => {},
          renew: () => {},
          release: () => {},
        },
        createPublisher: () => publisherFor() as never,
        ...over,
      })
      return { wiring, publications: () => publications, unavailable }
    }

    /**
     * ONE SLEEPING LAPTOP IS NOT A RELEASE DEFECT (POD-3040).
     *
     * Publication used to ask every registered remote consumer to fetch every
     * artifact URL first, and an OFFLINE consumer failed that proof closed — so
     * a machine being asleep withheld the release from the whole fleet, with
     * "wake it or remove it from the update fleet" as the only remedy. Nothing
     * about the release or the address was wrong. Publication now states only
     * what this server can serve; who can reach it is delivery, and delivery is
     * the updater's job, machine by machine.
     */
    it('publishes while every registered remote consumer is offline', async () => {
      const { wiring, publications, unavailable } = wiringFor()

      await expect(wiring.requestBuild()).resolves.toEqual(built)
      expect(publications()).toBe(1)
      expect(unavailable).toEqual([])
    })

    it('publishes for a mixed fleet without asking the online machines anything', async () => {
      // The mixed case is the one the old gate got most wrong: the online
      // machines were reachable, and the release was still withheld from them.
      const { wiring, publications, unavailable } = wiringFor()

      await expect(wiring.requestBuild()).resolves.toEqual(built)
      await expect(wiring.requestBuild()).resolves.toEqual(built)
      expect(publications()).toBe(2)
      expect(unavailable).toEqual([])
    })

    it('publishes on a server-only fleet from its loopback origin', async () => {
      // No remote consumer is registered, so no external address is required
      // and same-host testing publishes exactly as it always did.
      const { wiring, publications, unavailable } = wiringFor({
        artifactOrigin: undefined,
        hasRemoteUpdateConsumers: () => false,
      })

      await expect(wiring.requestBuild()).resolves.toEqual(built)
      expect(publications()).toBe(1)
      expect(unavailable).toEqual([])
    })

    /**
     * WHAT THE GATE STILL REFUSES: an address this server knows its fleet
     * cannot use. Registration alone makes the origin mandatory — being online
     * was never what made a loopback URL wrong for a remote machine.
     */
    it('still refuses a loopback origin while a remote consumer is registered and offline', async () => {
      const { wiring, publications, unavailable } = wiringFor({
        artifactOrigin: undefined,
      })

      await expect(wiring.requestBuild()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DevBundleUnavailableError && /Public URL/.test(error.publicReason),
      )
      expect(publications()).toBe(0)
      expect(unavailable).toEqual([])
    })

    /**
     * …AND A ROUTE THIS SERVER CANNOT SERVE ITSELF.
     *
     * A URL inside a signed manifest cannot be repaired, so the artifacts the
     * manifest is about to name are resolved through the same published-artifact
     * path the route serves from, before the manifest is written. This one is
     * local, needs no machine, and cannot time out.
     */
    it('refuses before publication when a built artifact is no longer on disk', async () => {
      const { wiring, publications, unavailable } = wiringFor({
        // Retention swept the Mac tarball out from under this publish.
        artifactSize: async (path: string) =>
          path === darwinArtifact ? undefined : bytes.length,
      })

      await expect(wiring.requestBuild()).rejects.toThrow(/is not on disk/)
      expect(publications()).toBe(0)
      expect(unavailable.at(-1)).toContain('darwin-aarch64')
    })

    it('refuses before publication when an artifact is not the size publication signed', async () => {
      const { wiring, publications, unavailable } = wiringFor({
        artifactSize: async () => 1,
      })

      await expect(wiring.requestBuild()).rejects.toThrow(/would be refused/)
      expect(publications()).toBe(0)
      expect(unavailable.at(-1)).toMatch(/no longer matches what was signed/)
    })

    /**
     * A REBUILD AT THE SAME HEAD MINTS THE SAME URLS, so the proof may not be
     * keyed on the address alone: the second bundle would inherit the first
     * one's verdict and publish unchecked.
     */
    it('re-proves a re-packed bundle rather than reusing the address it published under', async () => {
      const checked: string[] = []
      const { wiring, publications } = wiringFor({
        artifactSize: async (path: string) => {
          checked.push(path)
          return path === artifact ? bytes.length : darwinBytes.length
        },
      })

      await expect(wiring.requestBuild()).resolves.toEqual(built)
      const afterFirst = checked.length
      expect(afterFirst).toBe(2)

      // Same version, same URLs, same bytes: the proof is reused.
      await expect(wiring.requestBuild()).resolves.toEqual(built)
      expect(checked).toHaveLength(afterFirst)
      expect(publications()).toBe(2)
    })
  })

  describe('the manifest leg of the feed', () => {
    it('serves the shell manifest without machine credentials, naming its release', async () => {
      const response = await appFor(false).request('/updates/feed/dev/latest.json')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual(desktopManifest)
      // This fixture is an instance with no dev desktop release, serving the edge shell —
      // the state every install is in until one is promoted. It must say so.
      expect(response.headers.get(DEV_DESKTOP_CHANNEL_HEADER)).toBe('edge')
    })

    it('names the dev release once a dev shell is what it is actually serving', async () => {
      // The header tracks the BYTES, not a decision recorded elsewhere: swapping the file
      // under the route — which is exactly what a publish does — changes the answer.
      writeFileSync(
        desktopManifestPath,
        JSON.stringify({
          version: '0.4.3-dev.2',
          bridgeVersion: 1,
          platforms: {
            'linux-x86_64': {
              url: 'https://github.com/madeinorbit/podium/releases/download/dev/Podium.AppImage',
              signature: 'DEV-SIGNATURE',
            },
          },
        }) + '\n',
      )
      try {
        const response = await appFor(false).request('/updates/feed/dev/latest.json')
        expect(response.headers.get(DEV_DESKTOP_CHANNEL_HEADER)).toBe('dev')
      } finally {
        writeFileSync(desktopManifestPath, JSON.stringify(desktopManifest) + '\n')
      }
    })

    it('refuses to name a release for a manifest that names none', async () => {
      // Silence would read as "fine". A document this server cannot place is a state
      // someone has to look at, so it is reported rather than left blank.
      writeFileSync(desktopManifestPath, '{"nonsense":true}\n')
      try {
        const response = await appFor(false).request('/updates/feed/dev/latest.json')
        expect(response.headers.get(DEV_DESKTOP_CHANNEL_HEADER)).toBe('unknown')
      } finally {
        writeFileSync(desktopManifestPath, JSON.stringify(desktopManifest) + '\n')
      }
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
        publishedArtifact: (version, platform) => resolveBuiltArtifact(built, version, platform),
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

  it('answers an authenticated artifact HEAD without sending the bundle body', async () => {
    const response = await appFor().request(
      '/updates/feed/dev/artifact/dev%2Babc1234/linux-x86_64',
      {
        method: 'HEAD',
        headers: { authorization: 'Bearer machine-token' },
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(await response.text()).toBe('')
  })

  it('lets HEAD prove a built candidate without exposing it to GET before publication', async () => {
    const app = new Hono()
    registerDevFeedRoutes(app, {
      publishedArtifact: () => null,
      probeArtifact: (version, platform) => resolveBuiltArtifact(built, version, platform),
      manifestPath: () => undefined,
      authenticate: () => true,
    })
    const url = '/updates/feed/dev/artifact/dev%2Babc1234/linux-x86_64'
    const head = await app.request(url, { method: 'HEAD' })
    const get = await app.request(url)

    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(bytes.length))
    expect(await head.text()).toBe('')
    expect(get.status).toBe(404)
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
      publishedArtifact: (version, platform) =>
        resolveBuiltArtifact(
          { ...built, path: join(stage, 'never-written.tar.gz') },
          version,
          platform,
        ),
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })
    expect((await app.request('/updates/feed/dev/artifact/dev%2Babc1234')).status).toBe(404)
  })

  it('opens the artifact only after authentication and version agree', async () => {
    const opened: string[] = []
    const app = new Hono()
    registerDevFeedRoutes(app, {
      publishedArtifact: (version, platform) => resolveBuiltArtifact(built, version, platform),
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
      publishedArtifact: (version, platform) => resolveBuiltArtifact(current, version, platform),
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })

    current = { ...built, version: 'dev+new1234' }
    const stale = await app.request('/updates/feed/dev/artifact/dev%2Babc1234')
    const fresh = await app.request('/updates/feed/dev/artifact/dev%2Bnew1234')
    expect(stale.status).toBe(404)
    expect(fresh.status).toBe(200)
  })

  it('names the refusal when the stored bytes no longer match the publication', async () => {
    // THE TAMPER CASE. A byte appended to a published artifact leaves the
    // manifest, its digest and its signature untouched — the only local
    // evidence is that the file is no longer the size publication recorded.
    // Answering a bare `not found` there turns a security finding into
    // `artifact download returned 404`, which the downloader classifies as a
    // transport failure and an operator cannot tell from a flaky network.
    const mutated = join(stage, 'podium-headless-dev+abc1234-linux-x86_64-mutated.tar.gz')
    writeFileSync(mutated, new Uint8Array([...bytes, 0x78]))
    const published: DevBundleArtifact = {
      version: 'dev+abc1234',
      platform: 'linux-x86_64',
      path: mutated,
      size: bytes.length,
      digest: 'sha256-fixture',
      signature: signature.toString('base64'),
    }
    const app = new Hono()
    registerDevFeedRoutes(app, {
      publishedArtifact: (version) => (version === published.version ? published : null),
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })

    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234')
    expect(response.status).toBe(404)
    expect(response.headers.get(UPDATE_ARTIFACT_REFUSAL_HEADER)).toBe(
      UPDATE_ARTIFACT_INTEGRITY_REFUSAL,
    )
  })

  it('keeps a missing file an ordinary not found, with no security marker', async () => {
    // The other half of the same decision: retention removing the file is not
    // evidence of tampering, and promoting it would make the marker meaningless.
    const app = new Hono()
    registerDevFeedRoutes(app, {
      publishedArtifact: (version, platform) =>
        resolveBuiltArtifact(
          { ...built, path: join(stage, 'never-written.tar.gz') },
          version,
          platform,
        ),
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })

    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234')
    expect(response.status).toBe(404)
    expect(response.headers.get(UPDATE_ARTIFACT_REFUSAL_HEADER)).toBeNull()
  })

  it('names the refusal the publisher itself raises over recovered bytes', async () => {
    // The route's other integrity door — proved armed here rather than assumed,
    // because nothing else in this suite fires it.
    const app = new Hono()
    registerDevFeedRoutes(app, {
      publishedArtifact: () => {
        throw new DevArtifactIntegrityError('published artifact bytes failed digest verification')
      },
      manifestPath: () => manifestPath,
      authenticate: () => true,
    })

    const response = await app.request('/updates/feed/dev/artifact/dev%2Babc1234')
    expect(response.status).toBe(404)
    expect(response.headers.get(UPDATE_ARTIFACT_REFUSAL_HEADER)).toBe(
      UPDATE_ARTIFACT_INTEGRITY_REFUSAL,
    )
  })
})
