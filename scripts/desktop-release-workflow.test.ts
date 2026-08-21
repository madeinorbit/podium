import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..')
const desktopWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/desktop-release.yml'),
  'utf8',
)
const headlessWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
const releaseSource = readFileSync(join(repoRoot, 'scripts/release.ts'), 'utf8')
const macSigningVerifier = readFileSync(
  join(repoRoot, 'apps/desktop/scripts/verify-macos-signing.sh'),
  'utf8',
)
const publishedHeadlessSmoke = readFileSync(
  join(repoRoot, 'scripts/verify-published-headless-update.sh'),
  'utf8',
)

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

  it('prunes stale desktop assets from the rolling edge release after uploading', () => {
    // All desktop asset names embed the version, so --clobber never replaces them: without
    // pruning, every past edge build — including pre-notarization installers and updater
    // archives — stays downloadable from the release page.
    expect(desktopWorkflow).toContain('--list-stale')
    expect(desktopWorkflow).toContain('gh release delete-asset edge "$asset" --yes')
    // Only the rolling edge release accumulates; stable releases are immutable per-tag cuts.
    expect(desktopWorkflow).toMatch(/if \[ "\$CHANNEL" = edge ]; then\n\s+gh release view edge/)
    // Prune after the upload so a failed publish leaves the previous build downloadable.
    const upload = desktopWorkflow.indexOf('gh release upload "$target_tag"')
    const prune = desktopWorkflow.indexOf('gh release delete-asset')
    expect(prune).toBeGreaterThan(upload)
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

  it('executes both copied seed and exact fleet-grant bytes in the macOS verifier', () => {
    expect(macSigningVerifier).toContain('cp -R "$APP/Contents/Resources/resources/payload" "$seeded"')
    expect(macSigningVerifier).toContain('xattr -dr com.apple.quarantine "$seeded"')
    expect(macSigningVerifier).toContain('codesign --verify --strict --verbose=2 "$seeded/podium-cli"')
    expect(macSigningVerifier).toContain('"$seeded/podium-cli" --version')
    expect(macSigningVerifier).toContain("find dist-bun -maxdepth 1 -name 'podium-headless-*.tar.gz'")
    expect(macSigningVerifier).toContain('tar -xzf "$grant_tarball" -C "$grant_work"')
    expect(macSigningVerifier).toContain('codesign --verify --strict --verbose=2 "$granted/podium-cli"')
    expect(macSigningVerifier).toContain("grep -q 'allow-jit'")
    expect(macSigningVerifier).toContain('"$granted/podium" --version')
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

  it('builds headless x64 and arm64 natively before one atomic publish', () => {
    const parsed = Bun.YAML.parse(headlessWorkflow) as {
      jobs?: { build?: unknown; publish?: { needs?: string } }
    }
    expect(parsed.jobs?.publish?.needs).toBe('build')
    expect(headlessWorkflow).toContain('arch: x64')
    expect(headlessWorkflow).toContain('arch: arm64')
    expect(headlessWorkflow).toContain('runner: ubuntu-24.04-arm')
    expect(headlessWorkflow).toContain('--prepare-arch ${{ matrix.arch }}')
    expect(headlessWorkflow).toContain('--publish-dir dist-bun/release')
    expect(headlessWorkflow).toContain('merge-multiple: true')
  })
})
