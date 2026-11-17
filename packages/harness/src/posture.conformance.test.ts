/**
 * Posture conformance (POD-6858, docs/design/harness-session-posture.md §5):
 * every harness's section, in every launch mode and at both mode levels, keeps
 * the contract `applyTerms` checks — it only adds to the builder's launch,
 * writes generated files inside the runtime folder, edits only its own home
 * and gives a real reason for anything unmet.
 *
 * Per-harness expectations (the exact flags) live beside each adapter's
 * section; this file only proves that no section breaks the contract.
 */
import type { BuiltinHarnessKind, SessionPosture } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './adapters/fixture/index.js'
import { testHarnessContext } from './driver/testing/harness-context.js'
import type { AgentManifest } from './manifest.js'
import { applyTerms, launchTerms } from './posture.js'
import { LAUNCH_MODES, type PostureLaunch, type PostureRequest } from './posture-types.js'
import { HARNESS_KINDS, manifestFor } from './registry.js'

const HOME = '/home/podium-test'
const WORKDIR = '/work/repo/.worktrees/issue-1'
const RUNTIME_DIR = '/run/podium/sessions/s1'

const LEVELS: readonly SessionPosture[] = [{ mode: 'supervised' }, { mode: 'autonomous' }]

const subjects: readonly { kind: string; manifest: AgentManifest }[] = [
  ...HARNESS_KINDS.map((kind) => {
    const manifest = manifestFor(kind)
    if (!manifest) throw new Error(`no manifest for ${kind}`)
    return { kind, manifest }
  }),
  { kind: 'fixture', manifest: fixtureManifest },
]

function contextFor(kind: string, manifest: AgentManifest) {
  return testHarnessContext({
    kind: kind as BuiltinHarnessKind,
    home: HOME,
    roots: manifest.roots(HOME, { HOME }),
  })
}

/** A resume launch with a `--` prompt boundary, the shape the order check guards. */
const resumeLaunch: PostureLaunch = {
  args: ['--resume', 'native-id', '--', '-a prompt that looks like a flag'],
  env: { PODIUM_SESSION: 's1' },
  files: [],
}

describe('posture conformance', () => {
  it('covers every registered harness and the fixture', () => {
    expect(subjects.map((s) => s.kind)).toEqual([...HARNESS_KINDS, 'fixture'])
  })

  describe.each(subjects)('$kind', ({ kind, manifest }) => {
    const context = contextFor(kind, manifest)
    // The adapter's own fresh launch: real builder output, not a stand-in.
    const built = manifest.launch({
      cwd: WORKDIR,
      harnessContext: context,
      runtimeDir: RUNTIME_DIR,
    })
    const ownLaunch: PostureLaunch = {
      args: built.args,
      env: built.env ?? {},
      files: built.files ?? [],
    }

    for (const mode of LAUNCH_MODES) {
      for (const posture of LEVELS) {
        it(`${mode} / ${posture.mode as string}: the section keeps the contract`, () => {
          const request: PostureRequest = {
            mode,
            posture,
            grants: {
              podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
              uploadsDir: '/var/lib/podium/uploads/s1',
              mcpServers: ['podium'],
            },
            workdir: WORKDIR,
            repoRoot: '/work/repo',
            runtimeDir: RUNTIME_DIR,
            context,
          }
          for (const launch of [ownLaunch, resumeLaunch]) {
            const out = applyTerms(launch, launchTerms(manifest, request))
            expect(out.launch.args.length).toBeGreaterThanOrEqual(launch.args.length)
          }
        })
      }
    }
  })
})
