/**
 * THE PLATFORM VOCABULARY, in one place.
 *
 * A machine asking for an update names its platform; a manifest keys its
 * artifacts by that name; a release asset is built for it; the abduco helper
 * embedded in that release is cross-compiled for it. Four separate places have
 * to agree, and the failure when they do not is silent and total: a machine is
 * told, forever, that its platform was never published.
 *
 * The name is the Tauri updater target-triple prefix (`linux-x86_64`,
 * `darwin-aarch64`), which is what the desktop manifests already use — so the
 * headless and desktop halves of a release speak one language.
 *
 * This lives in the protocol package because it IS protocol: it is the key
 * space of `UpdateTarget.artifacts.headless.platforms`. Both sides of every wire
 * that carries it — the server, the CLI's self-update, and the build scripts —
 * import it from here rather than each deriving `os + '-' + arch` themselves,
 * which is how the three copies that preceded this could have drifted.
 */

/** Every platform a headless release publishes a bundle for [spec:SP-6144 section 8b]. */
export const HEADLESS_PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'darwin-aarch64',
  'darwin-x86_64',
] as const

export type HeadlessPlatform = (typeof HEADLESS_PLATFORMS)[number]

export function isHeadlessPlatform(value: string): value is HeadlessPlatform {
  return (HEADLESS_PLATFORMS as readonly string[]).includes(value)
}

/**
 * The platform name for an (os, arch) pair.
 *
 * BOTH ARGUMENTS ARE REQUIRED, and that is the point. This package is the wire
 * contract and carries no Node types on purpose — it is imported by the phone
 * client and the browser as well as by the server. Defaulting to
 * `process.platform` would make the vocabulary depend on the environment
 * reading it, which is exactly the coupling that had three copies of this rule
 * drifting apart in the first place. The callers that HAVE a process supply its
 * values (`platformTarget` in the CLI, `developmentPlatformTarget` in the
 * server); a caller reading a machine's reported inventory supplies that.
 *
 * Returns a plain string, not a {@link HeadlessPlatform}: a machine may honestly
 * report an os/arch we publish nothing for (Windows today), and the truthful
 * answer is its name, followed by "no artifact for you" — not a crash and not a
 * wrong platform. Callers that need a PUBLISHED platform narrow with
 * {@link isHeadlessPlatform}.
 */
export function platformTargetFor(platform: string, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch
  return `${os}-${cpu}`
}
