/**
 * THE DESKTOP APP BUILDS EACH CHANNEL RUNS — the `build` matrix of desktop-release.yml.
 *
 * The workflow reads this through `fromJSON` (its `validate` job prints `desktopBuildMatrix`),
 * so which platforms a release builds is decided in one place that tests can read.
 *
 * The keys are the matrix keys the build job uses: `target` and `runner` name the leg,
 * `build_args` go to `tauri build`, `bundle_dir` is where a macOS leg's bundle lands for
 * notarization, `artifact_paths` (newline-separated) is what the leg uploads.
 */

export type DesktopChannel = 'stable' | 'edge' | 'dev'

export interface DesktopBuildLeg {
  target: string
  runner: string
  build_args: string
  bundle_dir?: string
  artifact_paths: string
  /**
   * Built and published when it succeeds, and never holds the release back: the build job's
   * continue-on-error is keyed to it, so a red or timed-out leg leaves `build` successful and
   * `publish` ships the legs that passed. Without it, one failed leg fails `build` and
   * `publish` (which needs it) is skipped for every platform.
   */
  experimental?: true
  /** Caps how long an experimental leg can lengthen a release. */
  timeout_minutes?: number
  /**
   * Built only for stable. The macOS Intel leg is the slowest by far (26-33 min against about
   * 17 for Apple Silicon), and every edge release waited for it: the server half waits for
   * the app half (scripts/wait-for-desktop-half.ts), which waits for every leg. Edge is for
   * trying a build quickly, so it ships without an Intel app; Intel Macs on edge keep the app
   * they have, and stable still builds and requires it (POD-5969).
   */
  stable_only?: true
}

/**
 * Whether ANY channel builds the macOS Intel app. Off for the 0.2.0 stable cut (POD-5969): the
 * Intel leg takes 26-33 min and nobody could wait for it. With it off, stable publishes without
 * an Intel app — Intel Macs still get the server update (the headless half builds darwin-x64
 * itself) but keep their current app — and the Intel app can be added to that release later
 * with a desktop-release dispatch once this is back on.
 */
export const INTEL_MAC_APP_BUILT = false

export const DESKTOP_BUILD_LEGS: readonly DesktopBuildLeg[] = [
  {
    target: 'linux-x86_64',
    runner: 'ubuntu-latest',
    build_args: '',
    artifact_paths: [
      'apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage',
      'apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage.sig',
    ].join('\n'),
  },
  // Windows is experimental (see `experimental`). It runs beside the macOS legs, so it only
  // lengthens a release when it outlasts the slowest of them; `timeout_minutes` caps that.
  //
  // Bun's global store is `links/` inside its install cache, which defaults to the C: profile
  // while the checkout is on D:; every store symlink would cross a volume and Bun falls back to
  // a copyfile that fails ENOENT. The workflow's pin step puts the cache beside the workspace,
  // the same pin windows-smoke.yml uses.
  {
    target: 'windows-x86_64',
    runner: 'windows-latest',
    experimental: true,
    timeout_minutes: 30,
    build_args: '-- --bundles nsis',
    artifact_paths: [
      'apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe',
      'apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe.sig',
    ].join('\n'),
  },
  {
    target: 'darwin-aarch64',
    runner: 'macos-15',
    build_args: '-- --target aarch64-apple-darwin',
    bundle_dir: 'apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle',
    artifact_paths: [
      'apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg',
      'apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz',
      'apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz.sig',
    ].join('\n'),
  },
  // Intel macs build natively on GitHub's Intel runner. Cross-compiling from arm64 would also
  // need an x64 Bun sidecar and an x64 Rust process host, neither of which build-bun plumbs
  // through on a Mac.
  {
    target: 'darwin-x86_64',
    runner: 'macos-15-intel',
    build_args: '-- --target x86_64-apple-darwin',
    bundle_dir: 'apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle',
    artifact_paths: [
      'apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/*.dmg',
      'apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/*.app.tar.gz',
      'apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/*.app.tar.gz.sig',
    ].join('\n'),
    stable_only: true,
  },
]

/** The legs a release on `channel` builds. */
export function desktopBuildMatrix(channel: DesktopChannel): DesktopBuildLeg[] {
  return DESKTOP_BUILD_LEGS.filter(
    (leg) =>
      (channel === 'stable' || leg.stable_only !== true) &&
      (INTEL_MAC_APP_BUILT || leg.target !== 'darwin-x86_64'),
  )
}

/** Targets a release on `channel` may publish without (experimental or not built there). */
export function optionalDesktopTargets(channel: DesktopChannel): string[] {
  return DESKTOP_BUILD_LEGS.filter(
    (leg) =>
      leg.experimental === true ||
      (channel !== 'stable' && leg.stable_only === true) ||
      (!INTEL_MAC_APP_BUILT && leg.target === 'darwin-x86_64'),
  ).map((leg) => leg.target)
}

if (import.meta.main) {
  const index = process.argv.indexOf('--channel')
  const channel = process.argv[index + 1]
  if (index < 0 || (channel !== 'stable' && channel !== 'edge' && channel !== 'dev')) {
    console.error('usage: bun scripts/desktop-build-legs.ts --channel stable|edge|dev')
    process.exit(1)
  }
  console.log(JSON.stringify(desktopBuildMatrix(channel)))
}
