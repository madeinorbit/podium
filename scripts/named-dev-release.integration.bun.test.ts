import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import { CLIENT_BUILD_TASKS, buildClients, readRunSummary } from './build-clients'
import { beginFreshClientPackagingSession } from './build-bun'
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
  // SKIPPED ON A REAL BLOCKER, NOT ON A FLAKE — POD-3072.
  //
  // It fails on its FIRST line, in `beginFreshClientPackagingSession`, and the failure
  // is inherited rather than anything this milestone did:
  //
  //   verify-client-build: web was built from 34a75ea, not 2a9b643
  //
  // M1 refuses a dist whose stamped sourceCommit is not HEAD. M2 keys the client build
  // on its file inputs plus PODIUM_APP_VERSION — the commit SHA is baked into the
  // OUTPUT but is in no part of the KEY. So a commit that touches no client input
  // restores the previous commit's dist, and M1 correctly refuses it. Reproduced at
  // 34a75ea41 with none of this milestone's code in the tree; the repro is in POD-3072.
  //
  // Enable this the moment POD-3072 lands: it is the only test that measures the M3
  // claim end to end, and until then that claim rests on the manual run recorded on
  // POD-3054 (two platforms, one turbo run summary, both client tasks HIT).
  it.skip('builds the clients once for a two-platform release, and restores them', async () => {
    const summaries = (): string[] =>
      existsSync(join(ROOT, '.turbo', 'runs')) ? readdirSync(join(ROOT, '.turbo', 'runs')) : []

    // Warm this commit's clients THROUGH THE SAME ENTRY the coordinator uses. The
    // build is keyed on PODIUM_APP_VERSION among other things, so warming with a bare
    // `buildClients` would warm a different key and the run below would legitimately
    // MISS — a green that proved nothing about reuse.
    await beginFreshClientPackagingSession([])
    const before = new Set(summaries())

    await prepareHeadlessCross(
      ['linux-x86_64', 'darwin-aarch64'],
      join(scratch(), 'release'),
    )

    const written = summaries().filter((name) => !before.has(name))
    // ONE lane for two platforms. Two would be the regression this milestone removed.
    expect(written).toHaveLength(1)

    const tasks = readRunSummary(ROOT, join(ROOT, '.turbo', 'runs', written[0] as string))
    for (const task of CLIENT_BUILD_TASKS) {
      // Nothing was built: an approval whose clients did not change costs no client build.
      expect(tasks[task].cache, task).toBe('HIT')
    }
  }, 2_400_000)

})
