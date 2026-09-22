/**
 * Install a harness CLI on this machine — the harness-free half of the
 * Inventory install axis (POD-4414 §4.4, issue 4.4).
 *
 * WHAT IS GENERIC LIVES HERE: the temp-dir lifecycle, the installer fetch,
 * the `--version` verification that proves the install actually runs, and the
 * host-operation defaults (curl/wget fetch, execFileSync run, the musl probe).
 * WHAT IS VENDOR-SPECIFIC LIVES IN `adapters/<harness>/install.ts`: the
 * installer URL, the shell and env it needs, and the binary it produces.
 * This module iterates supported sections and never names a harness — kinds
 * flow as values from the manifests.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredValue, type HarnessInstallPorts } from '../manifest.js'
import { AGENT_MANIFESTS, manifestFor } from '../registry.js'

export interface InstallRequestPorts {
  /** Download a URL to a path. Never forwards a GitHub auth token — these are vendor hosts. */
  fetch?: (url: string, out: string) => void
  /** Run a command, returning its combined output; throws with that output on failure. */
  run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => string
  env?: NodeJS.ProcessEnv
  arch?: string
  /** Whether this box's libc is musl — Claude ships a separate build for it. */
  isMusl?: () => boolean
  /**
   * Operator-visible progress note. The CLI maps it onto its spinner; the
   * mechanism never prints. Absent in tests that assert silence.
   */
  note?: (message: string) => void
}

/**
 * Everything the CLI needs to present one install: the validated kind, the
 * adapter descriptor's short label, and the binary the install produces.
 * Pure data — the section itself never leaves the mechanism.
 */
export interface InstallTarget {
  readonly kind: string
  readonly displayName: string
  readonly binary: string
}

function defaultRun(cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function defaultFetch(url: string, out: string): void {
  // curl or wget, whichever this box has — the same fallback install.sh made.
  try {
    execFileSync('curl', ['-fsSL', url, '-o', out], { stdio: 'ignore' })
  } catch {
    execFileSync('wget', ['-qO', out, url], { stdio: 'ignore' })
  }
}

function defaultIsMusl(): boolean {
  try {
    return execFileSync('ldd', ['/bin/ls'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).includes('musl')
  } catch {
    return false
  }
}

function resolvePorts(request: InstallRequestPorts = {}): HarnessInstallPorts {
  return {
    fetch: request.fetch ?? defaultFetch,
    run: request.run ?? defaultRun,
    env: request.env ?? process.env,
    arch: request.arch ?? process.arch,
    isMusl: request.isMusl ?? defaultIsMusl,
    ...(request.note ? { note: request.note } : {}),
  }
}

/**
 * The narrow typed reader (spec §5): one install section, never the whole
 * adapter. Unknown ids degrade to an "unsupported agent" refusal naming the
 * id the caller passed; a known harness with no declared installer refuses
 * with the manifest's display name and the section's reason.
 */
export function installTargetFor(kind: string): InstallTarget {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`podium install: unsupported agent '${kind}'`)
  const declared = manifest.install
  if (!declared.supported) {
    throw new Error(
      `podium install: ${manifest.descriptor.shortLabel} cannot be installed automatically (${declared.reason})`,
    )
  }
  const section = declaredValue(declared)
  if (!section) throw new Error(`podium install: unsupported agent '${kind}'`)
  return { kind: manifest.kind, displayName: manifest.descriptor.shortLabel, binary: section.binary }
}

/** Every harness with a supported install section — kinds flow as values. */
export function installableTargets(): InstallTarget[] {
  const targets: InstallTarget[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const section = declaredValue(manifest.install)
    if (section)
      targets.push({
        kind: manifest.kind,
        displayName: manifest.descriptor.shortLabel,
        binary: section.binary,
      })
  }
  return targets
}

/**
 * Run one install: fetch the section's installer into a temp dir, run it,
 * then verify the produced binary actually runs. The vendor's own output is
 * what the thrown error carries — the CLI surfaces it only on failure.
 */
export function runInstallTarget(
  target: InstallTarget,
  binDir: string,
  request: InstallRequestPorts = {},
): void {
  const manifest = manifestFor(target.kind)
  const section = manifest ? declaredValue(manifest.install) : undefined
  if (!section) throw new Error(`podium install: unsupported agent '${target.kind}'`)
  const ports = resolvePorts(request)
  const tmp = mkdtempSync(join(tmpdir(), `podium-${target.kind}-`))
  const script = join(tmp, 'install.sh')
  try {
    ports.fetch(section.url(ports.env), script)
    section.runInstaller(script, binDir, ports)
    // The verify: each agent must actually run before it counts as installed.
    ports.run(join(binDir, section.binary), ['--version'], ports.env)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
