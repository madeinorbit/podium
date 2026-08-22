import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UpdateChannel } from '@podium/model'
import type { UpdateTarget } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'bun:test'
import { writeSystemdFiles } from '../apps/cli/src/cli-systemd'
import {
  assertSourceMatchesHead,
  createDevBundlePublisher,
} from '../apps/server/src/modules/updates/dev-bundle'
import { withDevBuildSnapshot } from '../apps/server/src/modules/updates/dev-build-snapshot'
import { resolveReleaseTarget } from '../apps/server/src/modules/updates/release-target'
import { UpdatesService } from '../apps/server/src/modules/updates/service'
import { refreshTargetsOnBoot } from '../apps/server/src/modules/updates/target-refresh'

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
 * compilers. The client commands only write ignored dist trees; the systemd command is different:
 * for a named instance it writes new, untracked unit names into the checkout under test.
 */
function replayClientPackagingRecipe(snapshotRoot: string): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const recipe = pkg.scripts?.['package:clients']
  if (!recipe) throw new Error('package:clients is missing')
  for (const command of recipe.split(' && ')) {
    if (
      command === 'bun run --filter @podium/web build' ||
      command === 'bun run --filter @podium/mobile build:web'
    ) {
      continue
    }
    if (command === 'bun run systemd:render') {
      writeSystemdFiles(join(snapshotRoot, 'scripts/systemd'), {
        profile: 'dev',
        instanceId: INSTANCE_ID,
      })
      continue
    }
    throw new Error(`named release regression does not recognize package:clients step: ${command}`)
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

    const publisher = createDevBundlePublisher({
      root,
      publisherStateDir: state,
      checkoutReleaseBase: '0.1.0-edge.20',
      isSourceRun: true,
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
      prepareWebDist: async (_headSha, _explicit, snapshotRoot) => {
        replayClientPackagingRecipe(snapshotRoot)
      },
      lock: {
        acquire: async () => true,
        renew: async () => {},
        release: async () => {},
      },
      platform: 'linux-x86_64',
      artifactUrl: (version, platform) =>
        `https://named.test/updates/feed/dev/artifact/${version}/${platform}`,
      edgeDesktopManifest: async () => ({
        version: '0.1.0-edge.20',
        bridgeVersion: 1,
        platforms: {
          'linux-x86_64': {
            url: 'https://github.com/madeinorbit/podium/releases/download/edge/Podium.AppImage',
            signature: 'edge-signature',
          },
        },
      }),
      spawnBuild: async ({ artifactPath }) => {
        mkdirSync(dirname(artifactPath), { recursive: true })
        writeFileSync(artifactPath, 'named release bytes')
        return { path: artifactPath, signature: 'development-signature' }
      },
    })
    const proposal = await publisher.proposal()
    expect(proposal?.headSha).toBe(sha)

    const built = await publisher.requestBuild(true, proposal)
    expect(built?.version).toMatch(new RegExp(`\\+${sha}$`))
    expect(await publisher.publishFeed()).toBe(true)
    expect(readFileSync(publisher.feedManifestPath(), 'utf8')).toContain(
      `"version": "${built?.version}"`,
    )

    /**
     * RESTART BOUNDARY. The publisher above is the old source process; the
     * services below have no in-memory target and can learn only from the
     * manifest that process left on disk. The fetch adapter is the packaged
     * source's authenticated feed route reduced to its two observable effects:
     * GET the persisted manifest and HEAD its named artifact.
     */
    const manifestUrl = 'https://named.test/updates/feed/dev/podium-update.json'
    const artifactBase = 'https://named.test/updates/feed/dev/'
    const persistedManifest = readFileSync(publisher.feedManifestPath(), 'utf8')
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
})
