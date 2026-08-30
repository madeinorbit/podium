import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { UpdateChannel } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { Hono } from 'hono'
import { registerDevFeedRoutes } from '../apps/server/src/modules/updates/artifact-route'
import { withDevBuildSnapshot } from '../apps/server/src/modules/updates/dev-build-snapshot'
import {
  assertSourceMatchesHead,
  createDevBundlePublisher,
} from '../apps/server/src/modules/updates/dev-bundle'
import {
  desktopManifestFeedChannel,
  resolveReleaseTarget,
} from '../apps/server/src/modules/updates/release-target'
import { UpdatesService } from '../apps/server/src/modules/updates/service'
import { readOrCreateDevArtifactToken } from '../apps/server/src/modules/updates/signing-key'
import { refreshTargetsOnBoot } from '../apps/server/src/modules/updates/target-refresh'
import { beginFreshClientPackagingSession } from './build-bun'
import { buildClients, CLIENT_BUILD_TASKS, readRunSummary } from './build-clients'
import { prepareHeadlessCross } from './release'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INSTANCE_ID = 'update-e2e'
const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-named-dev-release-'))
  scratchRoots.push(root)
  return root
}

afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Exercise the source-writing part of the real package recipe without paying for two client
 * compilers.
 *
 * The question this answers has not changed: does packaging write anything into the CHECKOUT
 * that a named instance would then trip over? A step that renders systemd units would — for a
 * named instance it writes new, untracked unit names. The client builds do not: they write
 * ignored dist trees.
 *
 * What changed is where the answer is written down. Packaging used to run a `package:clients`
 * shell chain, so the guard read that string and refused a step it did not recognise. The
 * clients are Turbo tasks now (POD-3053) and there is no chain to read; the equivalent
 * statement is each task's declared `outputs`. A task that started writing somewhere else
 * would have to say so there, and this refuses anything but `dist/**`.
 */
function assertClientPackagingWritesOnlyDist(): void {
  const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
    tasks?: Record<string, { outputs?: string[] } | undefined>
  }
  for (const task of ['@podium/web#build', '@podium/mobile#build']) {
    const outputs = turbo.tasks?.[task]?.outputs
    if (outputs === undefined) throw new Error(`${task} is not a turbo task any more`)
    if (outputs.length !== 1 || outputs[0] !== 'dist/**') {
      throw new Error(
        `named release regression does not recognize ${task} outputs: ${JSON.stringify(outputs)}`,
      )
    }
  }
}

describe('named-instance development releases', () => {
  it('resolves a persisted development release immediately after restart', async () => {
    const parent = scratch()
    const root = join(parent, 'repo')
    const state = join(parent, 'state')
    mkdirSync(root)
    mkdirSync(state)
    writeFileSync(join(root, 'package.json'), '{"version":"0.1.0-edge.20"}\n')
    writeFileSync(join(root, 'approved-source.ts'), 'export const approved = true\n')
    git(root, 'init', '--quiet')
    git(root, 'config', 'user.email', 'named-release@test.invalid')
    git(root, 'config', 'user.name', 'Named Release Test')
    git(root, 'add', '.')
    git(root, 'commit', '--quiet', '-m', 'approved')
    const sha = git(root, 'rev-parse', '--short=7', 'HEAD')

    const createPublisher = (artifactToken = readOrCreateDevArtifactToken(state)) =>
      createDevBundlePublisher({
        root,
        publisherStateDir: state,
        checkoutReleaseBase: '0.1.0-edge.20',
        sourceCheckoutAvailable: true,
        instanceId: INSTANCE_ID,
        headSha: () => sha,
        migrationsAt: async () => ['20260715135845_baseline'],
        proposalFacts: async () => ({
          branch: 'main',
          commits: [{ sha, summary: 'Approved release' }],
          addedMigrations: [],
        }),
        snapshotBuild: (approvedSha, build) =>
          withDevBuildSnapshot(
            { sourceRoot: root, approvedSha, install: async () => {} },
            async (snapshotRoot) => {
              const result = await build(snapshotRoot)
              await assertSourceMatchesHead(snapshotRoot, approvedSha)
              return result
            },
          ),
        lock: {
          acquire: async () => true,
          renew: async () => {},
          release: async () => {},
        },
        platform: 'linux-x86_64',
        artifactUrl: (version, platform) =>
          `https://named.test/updates/feed/dev/artifact/${version}/${platform}?token=${encodeURIComponent(artifactToken)}`,
        // An instance with no dev desktop release — the state every existing install is in
        // until one is promoted. It must keep publishing exactly as it did before the dev
        // channel existed, which is what this fixture pins by answering only for edge.
        desktopShellManifest: async (channel) =>
          channel === 'edge'
            ? {
                raw: {
                  version: '0.1.0-edge.20',
                  bridgeVersion: 1,
                  platforms: {
                    'linux-x86_64': {
                      url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium.AppImage',
                      signature: 'edge-signature',
                    },
                  },
                },
              }
            : { missing: 'dev desktop manifest returned HTTP 404' },
        spawnBuild: async ({ artifacts }) =>
          artifacts.map(({ platform, artifactPath }) => {
            mkdirSync(dirname(artifactPath), { recursive: true })
            writeFileSync(artifactPath, 'named release bytes')
            writeFileSync(artifactPath + '.sig', 'development-signature\n')
            return { platform, path: artifactPath, signature: 'development-signature' }
          }),
      })
    const publisher = createPublisher()
    const proposal = await publisher.proposal()
    expect(proposal?.headSha).toBe(sha)

    const built = await publisher.requestBuild(true, proposal)
    expect(built?.version).toMatch(new RegExp(`\\+${sha}$`))
    expect(await publisher.publishFeed()).toBe(true)
    expect(readFileSync(publisher.feedManifestPath(), 'utf8')).toContain(
      `"version": "${built?.version}"`,
    )
    // With no dev desktop release published, this server serves the edge shell — and says
    // so, in both directions a reader can check: the source it recorded, and the release
    // named by the URLs in the document it is actually handing out.
    expect(publisher.desktopManifestSource()).toEqual({
      channel: 'edge',
      fellBackBecause: 'dev desktop manifest returned HTTP 404',
    })
    expect(
      desktopManifestFeedChannel(JSON.parse(readFileSync(publisher.desktopManifestPath(), 'utf8'))),
    ).toBe('edge')

    /**
     * RESTART BOUNDARY. The publisher above is the old source process; the
     * services below have no in-memory target and can learn only from the
     * manifest, metadata, and artifacts that process left on disk. The new
     * publisher is wired to the authenticated feed route before either the
     * resolver or an artifact client asks it for the persisted release.
     */
    const manifestUrl = 'https://named.test/updates/feed/dev/podium-update.json'
    const artifactBase = 'https://named.test/updates/feed/dev/'
    const persistedManifest = readFileSync(publisher.feedManifestPath(), 'utf8')
    if (!built) throw new Error('development release did not build')
    const expectedArtifact = built.artifacts.find(
      (artifact) => artifact.platform === 'linux-x86_64',
    )
    if (!expectedArtifact) throw new Error('development release did not mint linux-x86_64')

    const persistedTarget = JSON.parse(persistedManifest) as UpdateTarget
    const persistedArtifactUrl = persistedTarget.artifacts.headless?.platforms['linux-x86_64']?.url
    if (!persistedArtifactUrl) throw new Error('published manifest omitted linux-x86_64')
    const publishedUrl = new URL(persistedArtifactUrl)
    const artifactPath = publishedUrl.pathname + publishedUrl.search
    const publishedToken = publishedUrl.searchParams.get('token')
    // Fail loudly rather than compare against null: a manifest URL carrying no
    // token at all would otherwise slip through as a vacuous equality check.
    if (!publishedToken) throw new Error('published artifact URL carried no token')
    const restartedToken = readOrCreateDevArtifactToken(state)
    expect(restartedToken).toBe(publishedToken)

    const restartedPublisher = createPublisher(restartedToken)
    expect(restartedPublisher.current()).toBeNull()

    // ARMED NEGATIVE CONTROL: this is the pre-fix route lookup, restored
    // literally against the new process's empty in-memory build record.
    const inMemoryOnly = new Hono()
    registerDevFeedRoutes(inMemoryOnly, {
      publishedArtifact: (version, platform) => {
        const held = restartedPublisher.current()
        if (!held || held.version !== version) return null
        return held.artifacts.find((artifact) => artifact.platform === platform) ?? null
      },
      manifestPath: () => restartedPublisher.feedManifestPath(),
      authenticate: (request) => new URL(request.url).searchParams.get('token') === restartedToken,
    })
    expect((await inMemoryOnly.request(artifactPath)).status).toBe(404)

    const routesFor = (candidate: ReturnType<typeof createPublisher>, acceptedToken: string) => {
      const app = new Hono()
      registerDevFeedRoutes(app, {
        publishedArtifact: (version, platform) => candidate.publishedArtifact(version, platform),
        manifestPath: () => candidate.feedManifestPath(),
        authenticate: (request) => new URL(request.url).searchParams.get('token') === acceptedToken,
      })
      return app
    }

    // ARMED CREDENTIAL CONTROL: restoring the per-boot random token rejects the
    // exact URL that the previous process persisted in its manifest.
    const rotatedToken = randomUUID()
    expect(rotatedToken).not.toBe(publishedToken)
    expect(
      (await routesFor(createPublisher(rotatedToken), rotatedToken).request(artifactPath)).status,
    ).toBe(401)

    const unknownPath = `/updates/feed/dev/artifact/${encodeURIComponent(
      built.version + '-unknown',
    )}/linux-x86_64${publishedUrl.search}`
    expect((await routesFor(createPublisher(), restartedToken).request(unknownPath)).status).toBe(
      404,
    )

    const publishedBytes = readFileSync(expectedArtifact.path)
    writeFileSync(expectedArtifact.path, 'tampered after publication')
    expect((await routesFor(createPublisher(), restartedToken).request(artifactPath)).status).toBe(
      404,
    )
    writeFileSync(expectedArtifact.path, publishedBytes)

    const artifactResponse = await routesFor(createPublisher(), restartedToken).request(
      artifactPath,
    )
    const fetched = new Uint8Array(await artifactResponse.arrayBuffer())
    expect(artifactResponse.status).toBe(200)
    expect(Array.from(fetched)).toEqual(Array.from(publishedBytes))
    expect('sha256-' + createHash('sha256').update(fetched).digest('base64')).toBe(
      expectedArtifact.digest,
    )

    const feedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (init?.method === 'HEAD' && url.startsWith(artifactBase)) {
        return new Response(null, { status: 200 })
      }
      if (url === manifestUrl) {
        return new Response(persistedManifest, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    const releaseTarget = (channel: Exclude<UpdateChannel, 'dev'>): UpdateTarget =>
      ({
        version: channel === 'edge' ? '0.1.0-edge.20' : '0.1.0',
        critical: false,
        artifacts: {},
      }) as UpdateTarget
    const restartedUpdates = () =>
      new UpdatesService({
        machines: () => [],
        send: () => {},
        now: () => 1_000,
        nextGrantId: () => 'boot-grant',
        concurrency: 3,
        fleetChannel: () => 'dev',
        locallyPublished: (channel) => channel === 'dev',
        resolveTarget: (channel) =>
          channel === 'dev'
            ? resolveReleaseTarget('dev', {
                feed: {
                  manifestUrl,
                  artifactBase,
                  trust: 'instance',
                },
                fetch: feedFetch,
              })
            : Promise.resolve(releaseTarget(channel)),
      })

    // ARMED NEGATIVE CONTROL: restoring the old hand-written boot omission
    // leaves exactly the observed state — no target and no dev channel check.
    const omitted = restartedUpdates()
    await refreshTargetsOnBoot({
      channels: ['edge', 'stable'],
      refresh: (channel) => omitted.refreshTarget(channel),
    })
    expect(omitted.target('dev')).toBeUndefined()
    expect(omitted.channelChecks().some((check) => check.channel === 'dev')).toBe(false)

    // Production uses the default all-channel list. This is settled directly;
    // no scheduler is created or fired anywhere in this regression.
    const restarted = restartedUpdates()
    await refreshTargetsOnBoot({
      refresh: (channel) => restarted.refreshTarget(channel),
    })
    expect(restarted.target('dev')?.version).toBe(built?.version)
    expect(restarted.channelChecks()).toContainEqual({
      channel: 'dev',
      checkedAt: 1_000,
      outcome: { status: 'ok' },
    })
  })

  /**
   * A SECOND APPROVAL OF AN UNCHANGED CLIENT COSTS NOTHING (POD-3053).
   *
   * This is the whole point of making the client builds Turbo tasks, and it is the one
   * claim the unit tests cannot make: they check the shape of the command and the shape
   * of a summary, not that this repository, at this commit, actually restores.
   *
   * So it runs the real lane twice, against the real checkout, exactly as
   * beginFreshClientPackagingSession does when a development release is approved. The
   * second run must report HIT for both clients, under the SAME hashes as the first —
   * a HIT under a different hash would mean something restored, but not this build.
   *
   * It does not assert a duration. A wall-clock floor is a flake on a loaded box, and
   * the cache status is the direct evidence anyway: a restored task did not run vite or
   * expo, whatever the clock says.
   */
  it('restores both clients on a second approval of the same commit', async () => {
    // The reuse this depends on is Turbo's `dist/**` outputs. If a client's build task
    // grew a second output the restore would be partial, and a HIT would stop meaning
    // "the whole client came back".
    assertClientPackagingWritesOnlyDist()

    const version = '0.0.0-second-approval'
    const first = await buildClients(ROOT, [], { ...process.env, PODIUM_APP_VERSION: version })
    const second = await buildClients(ROOT, [], { ...process.env, PODIUM_APP_VERSION: version })

    for (const task of CLIENT_BUILD_TASKS) {
      expect(second.tasks[task].cache, task).toBe('HIT')
      expect(second.tasks[task].hash, task).toBe(first.tasks[task].hash)
    }
    expect(second.summaryPath).not.toBe(first.summaryPath)
  }, 900_000)

  /**
   * A NEW RELEASE VERSION IS NOT A NEW PHONE APP (POD-3082).
   *
   * `apps/mobile` reads PODIUM_APP_VERSION nowhere. The version reaches its dist only
   * through the stamp, and the lane re-runs that stamp over both client dists after
   * Turbo returns, on HIT and MISS alike (POD-3072). So the mobile build task must not
   * declare the variable in its `env`: doing so makes every release a MISS for a value
   * the cached output does not depend on.
   *
   * Nothing else in the repository tests a version across a cache RESTORE —
   * write-web-build-stamp.test.ts, served-build.test.ts and dist-patched.test.ts all
   * look at a dist that was just built. This does the thing that can actually go wrong:
   * build the phone at version A, build it again at version B, and require BOTH that the
   * second run restored (same hash, HIT) and that the restored dist nevertheless names
   * version B everywhere a reader looks — the meta the page reads, the manifest the
   * update panel reads, and the precompressed siblings the server serves in preference
   * to the original.
   *
   * The web half is the test below; it has more to check, because the desktop shell
   * ships a service worker and the phone export does not.
   */
  it('restores the phone app across a version change, stamped with the new version', async () => {
    assertClientPackagingWritesOnlyDist()

    const first = await buildClients(ROOT, [], {
      ...process.env,
      PODIUM_APP_VERSION: '0.0.0-version-a',
    })
    const version = '0.0.0-version-b'
    const second = await buildClients(ROOT, [], { ...process.env, PODIUM_APP_VERSION: version })

    const mobile = '@podium/mobile#build'
    expect(second.tasks[mobile].cache, 'phone rebuilt for a version it does not read').toBe('HIT')
    expect(second.tasks[mobile].hash, 'phone restored under a different hash').toBe(
      first.tasks[mobile].hash,
    )

    // The restored dist still has to NAME the release. A HIT that handed back version A
    // would be a faster wrong answer, not a fix.
    const dist = join(ROOT, 'apps', 'mobile', 'dist')
    const indexPath = join(dist, 'index.html')
    const html = readFileSync(indexPath, 'utf8')
    expect(html).toContain(`<meta name="podium-version" content="${version}">`)
    expect(html.match(/<meta\s+name=["']podium-version["']/gi) ?? []).toHaveLength(1)
    const manifest = JSON.parse(readFileSync(join(dist, 'podium-build.json'), 'utf8')) as {
      appVersion: string
    }
    expect(manifest.appVersion).toBe(version)

    // The server prefers these off disk (apps/server/src/static-web.ts), so a stale
    // sibling is the version the page actually reports being one release old.
    const raw = readFileSync(indexPath)
    expect(brotliDecompressSync(readFileSync(`${indexPath}.br`)).equals(raw)).toBe(true)
    expect(gunzipSync(readFileSync(`${indexPath}.gz`)).equals(raw)).toBe(true)
  }, 1_800_000)

  /**
   * A NEW RELEASE VERSION IS NOT A NEW WEB APP EITHER (POD-3083).
   *
   * The same claim as the phone's, for the client that was actually costing the release:
   * `@podium/web#build` was keyed on PODIUM_APP_VERSION, so every release MISSed and
   * rebuilt the whole site — 41.7s cold against 0.2s warm, of a ~73s release, which is
   * most of the speed-up POD-3051 did not deliver.
   *
   * IT ASSERTS ONE THING THE PHONE'S DOES NOT: THE SERVICE WORKER. The desktop shell
   * precaches index.html and serves navigations from that precache. Workbox generates
   * the precache manifest at `closeBundle`, before the stamp injects the version — so
   * with the version out of the JS, a version-only release would leave `sw.js`
   * byte-identical, an installed PWA would never see an update (the update check is a
   * byte diff of the worker script), and it would keep serving the previous release's
   * page while the update panel offered a Reload that could not clear itself. The stamp
   * rewrites that revision; this requires the rewrite to have taken, on a RESTORED dist,
   * which is the only path a release actually uses.
   *
   * The revision is asserted EQUAL to the md5 of the shipped page rather than merely
   * changed: that is the property the browser depends on, and an ordering mistake in the
   * stamp — worker rewritten before the metas go in — leaves it changed but wrong.
   */
  it('restores the web app across a version change, stamped into the page and its service worker', async () => {
    assertClientPackagingWritesOnlyDist()

    const first = await buildClients(ROOT, [], {
      ...process.env,
      PODIUM_APP_VERSION: '0.0.0-web-version-a',
    })
    const dist = join(ROOT, 'apps', 'web', 'dist')
    const swBefore = readFileSync(join(dist, 'sw.js'))

    const version = '0.0.0-web-version-b'
    const second = await buildClients(ROOT, [], { ...process.env, PODIUM_APP_VERSION: version })

    const web = '@podium/web#build'
    expect(second.tasks[web].cache, 'web rebuilt for a version it does not read').toBe('HIT')
    expect(second.tasks[web].hash, 'web restored under a different hash').toBe(
      first.tasks[web].hash,
    )

    const indexPath = join(dist, 'index.html')
    const html = readFileSync(indexPath, 'utf8')
    expect(html).toContain(`<meta name="podium-version" content="${version}">`)
    expect(html.match(/<meta\s+name=["']podium-version["']/gi) ?? []).toHaveLength(1)
    const stamp = JSON.parse(readFileSync(join(dist, 'podium-build.json'), 'utf8')) as {
      appVersion: string
    }
    expect(stamp.appVersion).toBe(version)

    const raw = readFileSync(indexPath)
    expect(brotliDecompressSync(readFileSync(`${indexPath}.br`)).equals(raw)).toBe(true)
    expect(gunzipSync(readFileSync(`${indexPath}.gz`)).equals(raw)).toBe(true)

    // The worker moved, and it names the page on disk. Both halves matter: unchanged
    // bytes mean no update ever installs, and a changed-but-wrong revision means the
    // installed worker precaches a page that was never served.
    const swPath = join(dist, 'sw.js')
    const sw = readFileSync(swPath)
    expect(sw.equals(swBefore), 'sw.js unchanged, so an installed app never updates').toBe(false)
    expect(sw.toString('utf8')).toContain(
      `{url:"index.html",revision:"${createHash('md5').update(raw).digest('hex')}"}`,
    )
    // static-web.ts prefers these; a stale sibling hands out the old worker and the
    // whole mechanism is inert.
    expect(brotliDecompressSync(readFileSync(`${swPath}.br`)).equals(sw)).toBe(true)
    expect(gunzipSync(readFileSync(`${swPath}.gz`)).equals(sw)).toBe(true)
  }, 1_800_000)

  /**
   * THE COORDINATOR BUILDS THE CLIENTS ONCE, NOT ONCE PER PLATFORM (POD-3054).
   *
   * This is the M3 claim, and the one the unit tests cannot make: they assert the
   * command line the publisher hands its single child, not what the child then does
   * with a two-platform list.
   *
   * It is measured by COUNTING TURBO RUN SUMMARIES around a real two-platform
   * `prepareHeadlessCross`. One summary is one `turbo run build`, which is one client
   * build lane; the per-platform packaging this replaced would leave two. Counting the
   * summaries rather than reading the source means a refactor that reintroduced the
   * per-platform session fails here even if it kept every name.
   *
   * The clients are warmed first, deliberately. The subject is how many times the
   * coordinator reaches for the lane, not how long a cold client build takes — and
   * warm is also the state that makes the second half of the claim checkable: with the
   * cache populated for this commit, an approval of unchanged clients builds NOTHING,
   * which shows up as HIT on both tasks inside that single run.
   */
  // The blocker this was skipped on is fixed (POD-3072). It failed on its first line,
  // in `beginFreshClientPackagingSession`, with
  //
  //   verify-client-build: web was built from 34a75ea, not 2a9b643
  //
  // M1 refuses a dist whose stamped sourceCommit is not HEAD; M2 keys the client build
  // on its file inputs plus PODIUM_APP_VERSION, so the commit is baked into the OUTPUT
  // but is in no part of the KEY, and a commit touching no client input restored the
  // previous commit's dist. The lane now re-stamps after Turbo returns, on a restore as
  // well as a build, so the restored dist names the commit being released.
  it('builds the clients once for a two-platform release, and restores them', async () => {
    const summaries = (): string[] =>
      existsSync(join(ROOT, '.turbo', 'runs')) ? readdirSync(join(ROOT, '.turbo', 'runs')) : []

    // A THROWAWAY RELEASE SIGNING KEY, because staging refuses an unsigned tarball.
    // `prepareHeadlessCross` signs with PODIUM_UPDATE_SIGNING_KEY or the gitignored
    // scripts/.podium-update-dev.key, and neither is present on a checkout that has not
    // been set up to publish. That is a prerequisite of the RELEASE, not of the claim
    // this test makes — it counts Turbo run summaries and reads cache status — so the
    // test mints its own rather than being green only where someone happened to have a
    // key on disk.
    const previousSigningKey = process.env.PODIUM_UPDATE_SIGNING_KEY
    process.env.PODIUM_UPDATE_SIGNING_KEY = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'der' })
      .toString('base64')

    try {
      // Warm this commit's clients THROUGH THE SAME ENTRY the coordinator uses. The
      // build is keyed on PODIUM_APP_VERSION among other things, so warming with a bare
      // `buildClients` would warm a different key and the run below would legitimately
      // MISS — a green that proved nothing about reuse.
      await beginFreshClientPackagingSession([])
      const before = new Set(summaries())

      // The ledger's client half, written by this very run (POD-3055). Passing it here
      // is what makes the record end-to-end evidence rather than a shape a unit test
      // asserted: the HIT below and the HIT in the file are the same fact, and the file
      // is the only place it survives this process.
      const recordDir = join(scratch(), 'record')
      await prepareHeadlessCross(
        ['linux-x86_64', 'darwin-aarch64'],
        join(scratch(), 'release'),
        new Map(),
        recordDir,
      )

      const written = summaries().filter((name) => !before.has(name))
      // ONE lane for two platforms. Two would be the regression this milestone removed.
      expect(written).toHaveLength(1)

      const tasks = readRunSummary(ROOT, join(ROOT, '.turbo', 'runs', written[0] as string))
      for (const task of CLIENT_BUILD_TASKS) {
        // Nothing was built: an approval whose clients did not change costs no client build.
        expect(tasks[task].cache, task).toBe('HIT')
      }

      const client = JSON.parse(readFileSync(join(recordDir, 'client.json'), 'utf8')) as {
        rootDigest: string
        sourceCommit: string
        version: string
        tasks: Record<string, { hash: string; cache: string }>
      }
      expect(client.rootDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(client.sourceCommit).toBe(git(ROOT, 'rev-parse', '--short=7', 'HEAD'))
      for (const task of CLIENT_BUILD_TASKS) {
        // The record says what the run said: same hash, same restore. This is the fact
        // the next optimisation round reads, months after the run's summary is gone.
        expect(client.tasks[task], task).toEqual({ hash: tasks[task].hash, cache: 'HIT' })
      }
    } finally {
      if (previousSigningKey === undefined) delete process.env.PODIUM_UPDATE_SIGNING_KEY
      else process.env.PODIUM_UPDATE_SIGNING_KEY = previousSigningKey
    }
  }, 2_400_000)
})
