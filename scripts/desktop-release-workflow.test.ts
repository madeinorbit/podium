import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..')
const desktopWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/desktop-release.yml'),
  'utf8',
)
const headlessWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
const releaseSource = readFileSync(join(repoRoot, 'scripts/release.ts'), 'utf8')
const carryForwardSource = readFileSync(
  join(repoRoot, 'scripts/carry-forward-desktop-manifest.ts'),
  'utf8',
)
const macSigningVerifier = readFileSync(
  join(repoRoot, 'apps/desktop/scripts/verify-macos-signing.sh'),
  'utf8',
)
const publishedHeadlessSmoke = readFileSync(
  join(repoRoot, 'scripts/verify-published-headless-update.sh'),
  'utf8',
)

/**
 * Runs the `Resolve channel and ref` step's own shell, lifted out of the workflow file, so
 * these assertions are about what CI will actually decide rather than about the text of a
 * script nobody executed. Pattern-matching a workflow proves a string is present; only
 * running it proves a dev dispatch does not resolve to the edge tag.
 */
const scratch: string[] = []
afterAll(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function resolveStep(): string {
  const parsed = Bun.YAML.parse(desktopWorkflow) as {
    jobs: { validate: { steps: Array<{ id?: string; run?: string }> } }
  }
  const step = parsed.jobs.validate.steps.find((candidate) => candidate.id === 'resolve')
  if (!step?.run) throw new Error('the validate job has no `resolve` step to run')
  return step.run
}

function runResolve(env: {
  GITHUB_EVENT_NAME: string
  INPUT_CHANNEL?: string
  INPUT_RELEASE_TAG?: string
  GITHUB_REF?: string
  GITHUB_REF_NAME?: string
}): { outputs: Record<string, string>; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-resolve-'))
  scratch.push(dir)
  const script = join(dir, 'resolve.sh')
  const output = join(dir, 'github_output')
  writeFileSync(script, resolveStep())
  writeFileSync(output, '')
  const stdout = execFileSync('bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_OUTPUT: output,
      INPUT_CHANNEL: '',
      INPUT_RELEASE_TAG: '',
      GITHUB_REF: '',
      GITHUB_REF_NAME: '',
      ...env,
    },
  })
  const outputs: Record<string, string> = {}
  for (const line of readFileSync(output, 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf('=')
    outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return { outputs, stdout }
}

describe('desktop release channel resolution', () => {
  it('sends a dev dispatch to its own tag, built from the selected ref', () => {
    const { outputs } = runResolve({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      INPUT_CHANNEL: 'dev',
      GITHUB_REF: 'refs/heads/some-branch',
    })
    expect(outputs.channel).toBe('dev')
    // Dev builds the ref chosen in the UI, exactly as edge does. Requiring a version tag
    // would defeat the point: a dev shell exists to try a commit that has no release.
    expect(outputs.checkout_ref).toBe('refs/heads/some-branch')
    expect(outputs.stable_tag).toBe('')
  })

  it('leaves the edge and stable resolutions exactly as they were', () => {
    const edge = runResolve({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      INPUT_CHANNEL: 'edge',
      GITHUB_REF: 'refs/heads/main',
    })
    expect(edge.outputs).toMatchObject({
      channel: 'edge',
      stable_tag: '',
      checkout_ref: 'refs/heads/main',
    })

    const stable = runResolve({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      INPUT_CHANNEL: 'stable',
      INPUT_RELEASE_TAG: 'v0.2.0',
      GITHUB_REF: 'refs/heads/main',
    })
    expect(stable.outputs).toMatchObject({
      channel: 'stable',
      stable_tag: 'v0.2.0',
      checkout_ref: 'v0.2.0',
    })

    const tagged = runResolve({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/tags/v0.2.0-edge.3',
      GITHUB_REF_NAME: 'v0.2.0-edge.3',
    })
    expect(tagged.outputs).toMatchObject({ channel: 'edge', stable_tag: '' })
  })

  it('never promotes to dev from a pushed tag', () => {
    // Dev is dispatch-only on purpose: a tag push is how a release reaches real installs,
    // and no tag shape should be able to divert one into a throwaway shell — or, worse,
    // silently mint a dev build where a stable cut was intended.
    const stable = runResolve({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/tags/v0.2.0',
      GITHUB_REF_NAME: 'v0.2.0',
    })
    expect(stable.outputs.channel).toBe('stable')
    const edge = runResolve({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/tags/v0.2.0-edge.1',
      GITHUB_REF_NAME: 'v0.2.0-edge.1',
    })
    expect(edge.outputs.channel).toBe('edge')
  })

  it('still refuses a stable promotion with no version tag, and an unknown channel', () => {
    expect(() =>
      runResolve({ GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_CHANNEL: 'stable' }),
    ).toThrow()
    expect(() =>
      runResolve({ GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_CHANNEL: 'nightly' }),
    ).toThrow()
  })
})

/**
 * Runs the `Upload promoted desktop assets` step against stubbed `gh`/`git`/`bun`, and reads
 * back every command it issued.
 *
 * WHICH RELEASE A PROMOTION WRITES TO cannot be checked by reading the file: the tag is a
 * variable, threaded from another job, used by five different `gh` calls. The question that
 * matters — can a dev promotion touch the tag real installs follow? — is answerable only by
 * running the thing and looking at what it actually did.
 */
function runPublish(input: {
  channel: string
  targetTag: string
  releaseAlreadyExists?: boolean
}): string[] {
  const parsed = Bun.YAML.parse(desktopWorkflow) as {
    jobs: { publish: { steps: Array<{ name?: string; run?: string }> } }
  }
  const step = parsed.jobs.publish.steps.find(
    (candidate) => candidate.name === 'Upload promoted desktop assets',
  )
  if (!step?.run) throw new Error('the publish job has no upload step to run')

  const dir = mkdtempSync(join(tmpdir(), 'desktop-publish-'))
  scratch.push(dir)
  const bin = join(dir, 'bin')
  const state = join(dir, 'state')
  const log = join(dir, 'log')
  const work = join(dir, 'work')
  for (const path of [bin, state, work]) mkdirSync(path, { recursive: true })
  writeFileSync(log, '')
  if (input.releaseAlreadyExists) writeFileSync(join(state, `exists.${input.targetTag}`), '')

  // `gh release view <tag>` is the only stub with state: it decides whether the step takes the
  // create path or the edit path, and `release create` has to make the next view succeed or
  // the step's wait loop would spin.
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/bash
echo "gh $*" >> "${log}"
if [ "$1 $2" = "release view" ]; then
  [ -f "${state}/exists.$3" ] || exit 1
  exit 0
fi
if [ "$1 $2" = "release create" ]; then touch "${state}/exists.$3"; fi
exit 0
`,
  )
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/bash
echo "git $*" >> "${log}"
[ "$1 $2" = "rev-parse HEAD" ] && echo "abcdef1234567890abcdef1234567890abcdef12"
exit 0
`,
  )
  writeFileSync(join(bin, 'bun'), `#!/bin/bash\necho "bun $*" >> "${log}"\nexit 0\n`)
  for (const name of ['gh', 'git', 'bun']) chmodSync(join(bin, name), 0o755)

  const script = join(dir, 'publish.sh')
  writeFileSync(script, step.run)
  const result = spawnSync('bash', [script], {
    cwd: work,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CHANNEL: input.channel,
      TARGET_TAG: input.targetTag,
      GITHUB_REPOSITORY: 'madeinorbit/podium',
    },
  })
  if (result.status !== 0) {
    throw new Error(`publish step failed (${result.status}): ${result.stderr}`)
  }
  return readFileSync(log, 'utf8').split('\n').filter(Boolean)
}

describe('desktop release publication', () => {
  it('creates the standing dev release as a PRERELEASE on first promotion', () => {
    const commands = runPublish({ channel: 'dev', targetTag: 'dev' })
    const create = commands.find((line) => line.startsWith('gh release create'))
    expect(create).toBeDefined()
    // A release marked latest becomes what `releases/latest/download/...` resolves to — the
    // URL every STABLE install reads its manifest from. Losing this flag would point the
    // stable channel at a throwaway test build.
    expect(create).toContain('--prerelease')
    expect(create).not.toContain('--latest')
    expect(commands.some((line) => line.startsWith('gh release upload dev'))).toBe(true)
  })

  it('republishes onto the same dev release, moving its tag to the built commit', () => {
    const commands = runPublish({ channel: 'dev', targetTag: 'dev', releaseAlreadyExists: true })
    expect(commands.some((line) => line.startsWith('gh release create'))).toBe(false)
    expect(
      commands.some((line) =>
        line.startsWith('gh api --method PATCH repos/madeinorbit/podium/git/refs/tags/dev'),
      ),
    ).toBe(true)
    // Still a prerelease after the edit; `gh release edit` would otherwise leave whatever
    // the release currently is.
    expect(commands.find((line) => line.startsWith('gh release edit'))).toContain('--prerelease')
  })

  it('never names the edge or a stable tag while promoting to dev', () => {
    // THE ONE THAT MATTERS. Real installs follow edge and stable; a dev promotion exists so a
    // build can be tried without reaching them. Any `gh` call naming another release here
    // would be a test build landing where real users look.
    for (const releaseAlreadyExists of [false, true]) {
      const commands = runPublish({ channel: 'dev', targetTag: 'dev', releaseAlreadyExists })
      for (const line of commands) {
        if (!line.startsWith('gh ')) continue
        expect(line, line).not.toMatch(/\bedge\b/)
        expect(line, line).not.toMatch(/\bv\d+\.\d+\.\d+/)
        expect(line, line).not.toContain('--latest')
      }
    }
  })

  it('leaves the edge and stable publications doing exactly what they did', () => {
    const edge = runPublish({ channel: 'edge', targetTag: 'edge', releaseAlreadyExists: true })
    // Edge never creates or moves its release — the headless workflow owns that — and it
    // prunes, because it rolls.
    expect(edge.some((line) => line.startsWith('gh release create'))).toBe(false)
    expect(edge.some((line) => line.startsWith('gh api'))).toBe(false)
    expect(edge.some((line) => line.startsWith('gh release upload edge'))).toBe(true)
    expect(edge.some((line) => line.includes('--list-stale'))).toBe(true)

    const stable = runPublish({
      channel: 'stable',
      targetTag: 'v0.2.0',
      releaseAlreadyExists: true,
    })
    expect(stable.some((line) => line.startsWith('gh release create'))).toBe(false)
    expect(stable.some((line) => line.startsWith('gh api'))).toBe(false)
    expect(stable.some((line) => line.startsWith('gh release upload v0.2.0'))).toBe(true)
    // A stable cut is an immutable per-version tag; nothing accumulates, so nothing is pruned.
    expect(stable.some((line) => line.includes('--list-stale'))).toBe(false)
  })
})

describe('desktop release workflow', () => {
  it('parses as a GitHub workflow triggered by version tags and dispatch', () => {
    const parsed = Bun.YAML.parse(desktopWorkflow) as {
      on?: { workflow_dispatch?: unknown; push?: { tags?: string[]; branches?: string[] } }
      jobs?: { publish?: { needs?: string[] } }
    }
    expect(parsed.on?.workflow_dispatch).toBeDefined()
    expect(parsed.on?.push?.tags).toEqual(['v*'])
    // The publish job reads the resolved channel from validate, so it must depend on both.
    expect(parsed.jobs?.publish?.needs).toEqual(['validate', 'build'])
  })

  it('releases only from a deliberate act, never from pushing a branch', () => {
    // [spec:SP-7f2c] desktop artifacts are never built for every push to main. A version tag is a
    // deliberate cut and does release; a branch push must never reach this workflow.
    const parsed = Bun.YAML.parse(desktopWorkflow) as {
      on?: { push?: { branches?: string[] } }
    }
    expect(parsed.on?.push?.branches).toBeUndefined()
    expect(headlessWorkflow).not.toContain('branches:')
    expect(desktopWorkflow).toContain('workflow_dispatch:')
    expect(desktopWorkflow).toContain('- edge')
    expect(desktopWorkflow).toContain('- stable')
  })

  it('derives the channel from the tag on both halves of a release', () => {
    // One tag drives headless and desktop. If the two disagreed about which channel an
    // -edge. tag means, a release would half-land: edge desktop assets uploaded into a
    // freshly minted stable release, or worse.
    expect(desktopWorkflow).toMatch(/\*-edge\.\*\)\s+channel=edge/)
    expect(desktopWorkflow).toMatch(/^\s+\*\)\s+channel=stable/m)
    expect(headlessWorkflow).toContain("contains(github.ref_name, '-edge.')")
    // Edge assets live under the fixed `edge` tag because shipped updaters have that URL baked in.
    expect(headlessWorkflow).toContain(
      "PODIUM_RELEASE_TAG: ${{ (github.event_name == 'workflow_dispatch' || contains(github.ref_name, '-edge.')) && 'edge' || github.ref_name }}",
    )
    // A prerelease tag naming no channel is a typo, not a stable release.
    expect(desktopWorkflow).toContain('is a prerelease but names no channel')
    // The tag and the version the updater advertises must agree.
    expect(desktopWorkflow).toContain('does not match package.json version')
  })

  it('waits for the release the headless workflow creates from the same tag', () => {
    // Both workflows start on one tag push. Desktop must not throw away a notarized build
    // because it reached the upload before the release existed.
    expect(desktopWorkflow).toContain('waiting for release $target_tag to exist')
    expect(desktopWorkflow).toContain('gh release upload "$target_tag"')
  })

  it('prunes stale desktop assets from a rolling release after uploading', () => {
    // All desktop asset names embed the version, so --clobber never replaces them: without
    // pruning, every past build — including pre-notarization installers and updater
    // archives — stays downloadable from the release page.
    expect(desktopWorkflow).toContain('--list-stale --manifest dist-desktop/latest.json')
    expect(desktopWorkflow).toContain('gh release delete-asset "$target_tag" "$asset" --yes')
    // Only the rolling releases accumulate; stable releases are immutable per-tag cuts, so
    // the prune must stay behind a channel test that names edge and dev and nothing else.
    expect(desktopWorkflow).toMatch(
      /if \[ "\$CHANNEL" = edge ] \|\| \[ "\$CHANNEL" = dev ]; then\n\s+gh release view "\$target_tag"/,
    )
    // Prune after the upload so a failed publish leaves the previous build downloadable.
    const upload = desktopWorkflow.indexOf('gh release upload "$target_tag"')
    const prune = desktopWorkflow.indexOf('gh release delete-asset')
    expect(prune).toBeGreaterThan(upload)
  })

  it('mints only when shell inputs change and carries the standing shell otherwise', () => {
    expect(desktopWorkflow).toContain(
      'git ls-files -s apps/desktop/src-tauri apps/desktop/scripts/stage-sidecar.ts',
    )
    expect(desktopWorkflow).toContain('desktop-shell-input.sha256')
    expect(desktopWorkflow).toContain("if: needs.validate.outputs.build_shell == 'true'")
    expect(headlessWorkflow).toContain('Carry forward the standing desktop shell reference')
    // POD-2796 moved the carry out of inline `gh … || true` and into a step that can say
    // no. The two asset names now live in exactly one place — the script — so this asserts
    // the workflow reaches it and that the script still names both.
    expect(headlessWorkflow).toContain('scripts/carry-forward-desktop-manifest.ts')
    expect(carryForwardSource).toContain("'latest.json', 'desktop-shell-input.sha256'")
    expect(releaseSource).toContain('validateReferencedDesktopManifest')
  })

  it('builds both macOS architectures with the same signing pipeline', () => {
    // Every darwin leg — not just Apple Silicon — must sign, notarize, and verify; a target
    // check that names one architecture silently ships the other unsigned.
    expect(desktopWorkflow).toContain('target: darwin-x86_64')
    expect(desktopWorkflow).toContain('runner: macos-15-intel')
    expect(desktopWorkflow).toContain('--target x86_64-apple-darwin')
    expect(desktopWorkflow).not.toContain("matrix.target == 'darwin-aarch64'")
    expect(desktopWorkflow).toContain("startsWith(matrix.target, 'darwin-')")
    // notarize-dmg.sh and verify-macos-signing.sh default to the aarch64 bundle dir; each darwin
    // leg must pass its own.
    expect(desktopWorkflow).toContain('notarize-dmg.sh "${{ matrix.bundle_dir }}"')
    expect(desktopWorkflow).toContain('verify-macos-signing.sh "${{ matrix.bundle_dir }}"')
    expect(desktopWorkflow).toContain(
      'bundle_dir: apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle',
    )
  })

  it('executes the copied seed payload in the macOS verifier, and no local headless tarball', () => {
    // The seed is the real first-run boundary this runner can prove: main.rs execs
    // `podium-cli` out of the copy in Application Support, so the copy — quarantine-stripped
    // exactly as the shell does it — is what must verify and run.
    expect(macSigningVerifier).toContain('cp -R "$APP/Contents/Resources/resources/payload" "$seeded"')
    expect(macSigningVerifier).toContain('xattr -dr com.apple.quarantine "$seeded"')
    expect(macSigningVerifier).toContain('codesign --verify --strict --verbose=2 "$seeded/podium-cli"')
    expect(macSigningVerifier).toContain('"$seeded/podium-cli" --version')
    // The in-bundle sidecar still has to carry the JIT entitlement — the seed is a copy of it.
    expect(macSigningVerifier).toContain("grep -q 'allow-jit'")
    // But dist-bun/podium-headless-*.tar.gz on a macOS release runner is NOT a fleet grant
    // payload: `bun run package:headless` here passes no --target, so build-bun never runs the
    // rcodesign pass, and the tarball is never uploaded by any job in this workflow. Verifying
    // it blocks every darwin release on a byproduct no user receives. The bytes a grant really
    // installs are cross-built in release.yml and gated by assert-headless-bundle.sh there.
    expect(macSigningVerifier).not.toContain("find dist-bun -maxdepth 1 -name 'podium-headless-*.tar.gz'")
    expect(macSigningVerifier).not.toContain('$granted/podium-cli')
  })

  it('builds and publishes the updater-signed Windows NSIS installer', () => {
    expect(desktopWorkflow).toContain('target: windows-x86_64')
    expect(desktopWorkflow).toContain('runner: windows-latest')
    expect(desktopWorkflow).toContain('--bundles nsis')
    expect(desktopWorkflow).toContain('bundle/nsis/*-setup.exe')
    expect(desktopWorkflow).toContain('bundle/nsis/*-setup.exe.sig')
  })

  it('builds Linux and Apple Silicon macOS with signing before an atomic upload', () => {
    expect(desktopWorkflow).toContain('release_notes:')
    expect(desktopWorkflow).toContain('TAURI_SIGNING_PRIVATE_KEY:')
    expect(desktopWorkflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD:')
    expect(desktopWorkflow).toContain(
      'PODIUM_DESKTOP_RELEASE_CHANNEL: ${{ needs.validate.outputs.channel }}',
    )
    expect(desktopWorkflow).toContain('libwebkit2gtk-4.1-dev')
    expect(desktopWorkflow).toContain('blacksmith-6vcpu-macos-15')
    expect(desktopWorkflow).toContain('target: darwin-aarch64')
    expect(desktopWorkflow).toContain('--target aarch64-apple-darwin')
    expect(desktopWorkflow).toContain('APPLE_SIGNING_IDENTITY:')
    // Ad-hoc signing shipped Gatekeeper warnings to every macOS user. The release identity is a
    // real Developer ID, and the credentials below are what make Tauri notarize rather than only
    // sign — a missing one degrades silently to a signed-but-unnotarized bundle.
    expect(desktopWorkflow).not.toContain('apple_signing_identity: "-"')
    expect(desktopWorkflow).toContain('secrets.APPLE_SIGNING_IDENTITY')
    expect(desktopWorkflow).toContain('secrets.APPLE_CERTIFICATE')
    expect(desktopWorkflow).toContain('secrets.APPLE_CERTIFICATE_PASSWORD')
    expect(desktopWorkflow).toContain('secrets.APPLE_TEAM_ID')
    expect(desktopWorkflow).toContain('secrets.APPLE_API_KEY')
    expect(desktopWorkflow).toContain('secrets.APPLE_API_ISSUER')
    expect(desktopWorkflow).toContain('secrets.APPLE_API_KEY_CONTENT')
    expect(desktopWorkflow).toContain('APPLE_API_KEY_PATH=')
    expect(desktopWorkflow).toContain('*.dmg')
    expect(desktopWorkflow).toContain('*.app.tar.gz')
    expect(desktopWorkflow).toContain('actions/upload-artifact@v4')
    expect(desktopWorkflow).toContain('actions/download-artifact@v4')
    const validation = desktopWorkflow.indexOf('--validate-only')
    const build = desktopWorkflow.indexOf('bun run --cwd apps/desktop build')
    const collect = desktopWorkflow.indexOf('actions/download-artifact@v4')
    // The prepare step is the one reading the collected bundles; the script is also invoked
    // for --validate-only earlier and --list-stale pruning later.
    const prepare = desktopWorkflow.indexOf('--bundle-dir dist-desktop-input')
    const upload = desktopWorkflow.indexOf('gh release upload')
    // Proof of notarization gates the staged artifact: an un-notarized bundle must never become a
    // published one, and `tauri build` exits 0 in every failure mode this script catches.
    // Tauri staples the .app but not the DMG around it, and the DMG is what users download.
    const notarizeDmg = desktopWorkflow.indexOf('notarize-dmg.sh')
    const verify = desktopWorkflow.indexOf('verify-macos-signing.sh')
    expect(notarizeDmg).toBeGreaterThan(build)
    expect(verify).toBeGreaterThan(notarizeDmg)
    const stage = desktopWorkflow.indexOf('name: Stage desktop bundle')
    expect(verify).toBeGreaterThan(build)
    expect(stage).toBeGreaterThan(verify)
    expect(validation).toBeGreaterThan(0)
    expect(build).toBeGreaterThan(validation)
    expect(collect).toBeGreaterThan(build)
    expect(prepare).toBeGreaterThan(collect)
    expect(prepare).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(prepare)
  })

  it('publishes both channels from version tags, and edge from dispatch', () => {
    expect(headlessWorkflow).toContain("tags: ['v*']")
    expect(headlessWorkflow).toContain('workflow_dispatch:')
    expect(headlessWorkflow).not.toContain('branches: [main]')
    expect(headlessWorkflow).toContain(
      "PODIUM_RELEASE_CHANNEL: ${{ (github.event_name == 'workflow_dispatch' || contains(github.ref_name, '-edge.')) && 'edge' || 'stable' }}",
    )
    expect(headlessWorkflow).toContain('--channel "$PODIUM_RELEASE_CHANNEL"')
    expect(headlessWorkflow).toContain('published-smoke')
    expect(headlessWorkflow).not.toContain('TAURI_SIGNING_PRIVATE_KEY')
    expect(headlessWorkflow).not.toContain('apps/desktop')
    expect(releaseSource).not.toContain('release delete edge')
    expect(releaseSource).toContain("['release', 'upload', 'edge', ...assets, '--clobber']")
    expect(publishedHeadlessSmoke).toContain('edge) CHANNEL="edge"')
    expect(publishedHeadlessSmoke).toContain('PODIUM_UPDATE_CHANNEL="$CHANNEL"')
  })

  /**
   * THIS USED TO PIN A PER-ARCHITECTURE MATRIX, and it must not any more.
   *
   * The old shape built x64 on an Ubuntu runner and arm64 on a native ARM one,
   * because the compiled daemon embeds an abduco helper that had to be built on
   * the architecture that would run it. `zig cc` builds that helper for every
   * target from one Linux runner, so the runner's own architecture no longer
   * decides anything and the matrix is gone (spec §8b). Asserting `arch: x64`
   * here would now pin a design the release deliberately replaced — the failure
   * mode POD-2556 caught.
   *
   * What is worth pinning is the part a mistake could silently undo: that one
   * job really does produce ALL FOUR platforms, and that both gates still stand
   * in front of publish.
   */
  it('cross-builds every headless platform, gated, before one atomic publish', () => {
    const parsed = Bun.YAML.parse(headlessWorkflow) as {
      jobs?: { headless?: { strategy?: unknown }; publish?: { needs?: string[] } }
    }
    // Publish waits on BOTH, and the second one is the point: `headless` proves the
    // cross-built arm64 bundle is SHAPED right without running it, and only `ab-check`
    // on real arm hardware proves it RUNS. Asserting the pair keeps the behavioural
    // gate in front of publish, so a cross-built bundle that misbehaves on its own
    // architecture cannot ship.
    expect(parsed.jobs?.publish?.needs).toEqual(['headless', 'ab-check'])
    // No matrix: reintroducing one would mean an architecture decided where a bundle
    // was built again, which is exactly what cross-compilation removed.
    expect(parsed.jobs?.headless?.strategy).toBeUndefined()
    // The ONE release entry, shared with the development publisher (POD-3054): it
    // builds or restores the clients once and packages every platform from that
    // single output. A job that reached past it for a per-platform packaging entry
    // would be paying for the client build once per platform again.
    expect(headlessWorkflow).toContain('bun run release:prepare')
    expect(headlessWorkflow).not.toContain('package-headless.ts')
    // All four platforms, named. A build that quietly stopped minting one would
    // otherwise publish a release the missing platform's machines cannot resolve.
    for (const asset of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']) {
      expect(headlessWorkflow).toContain(asset)
    }
    expect(headlessWorkflow).toContain('--publish-dir dist-bun/release')
  })
})
