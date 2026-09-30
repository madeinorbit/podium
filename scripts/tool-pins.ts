/**
 * The pinned versions of the non-node build toolchain, read from mise.toml [POD-3187].
 *
 * mise.toml is the ONE place zig and rcodesign versions are spelled: dev machines install
 * from it (`mise install`), CI installs from it (jdx/mise-action), and resolveZig/
 * resolveRcodesign (below) assert against it so a drifted local install fails loudly
 * instead of shipping different bytes. Both native cross builds, rust-host-cross.ts and
 * tunnel-cross.ts, resolve their tools here: a cross build once carried its own copy of the
 * lookup, from before the POD-3771 fix, and so could not find a zig its sibling could. This module is that assertion's
 * source of truth — a deliberately narrow parser, not a TOML library: it reads exactly
 * the two pins and throws on anything unexpected, so an edit that breaks the shape is
 * caught by the first build rather than silently unpinning a tool.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

export type ToolPins = {
  /** e.g. "0.16.0" — what `zig version` must print. */
  zig: string
  /** e.g. "0.29.0" — the version in `rcodesign --version`'s "apple-codesign X.Y.Z". */
  rcodesign: string
}

export function readToolPins(root: string = REPO_ROOT): ToolPins {
  const source = readFileSync(join(root, 'mise.toml'), 'utf8')
  const zig = source.match(/^zig\s*=\s*"([^"]+)"\s*$/m)?.[1]
  // The rcodesign pin rides mise's github backend; the release tag is `apple-codesign/<version>`.
  const rcodesign = source.match(
    /^"github:indygreg\/apple-platform-rs"\s*=\s*\{[^}]*version\s*=\s*"apple-codesign\/([^"]+)"/m,
  )?.[1]
  if (!zig || !rcodesign) {
    throw new Error(
      'tool-pins: mise.toml no longer carries the expected zig and rcodesign pins — ' +
        'update scripts/tool-pins.ts alongside any reshaping of mise.toml.',
    )
  }
  return { zig, rcodesign }
}

/**
 * THE PROBE ARGS ARE THE CALLER'S TO SUPPLY [POD-3771], because `--version` is not universal.
 * `zig --version` is not a zig command at all — it exits 1 with "unknown command: --version",
 * so probing with it declared a zig sitting on PATH to be missing, and every headless release
 * since has failed on a runner that had just installed zig successfully. The version this
 * asks for is the one the pin check then reads, so the two cannot drift apart again.
 */
function findTool(
  envName: string,
  binary: string,
  versionArgs: string[],
  fallbacks: string[],
): string {
  const configured = process.env[envName]?.trim()
  if (configured) return configured
  if (spawnSync(binary, versionArgs, { stdio: 'ignore' }).status === 0) return binary
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `${binary} is required to cross-compile the native binaries (podium-host-rs, podium-tunnel) but was not found. ` +
      `Install it, put it on PATH, or set ${envName} to its path.`,
  )
}

/**
 * The found tool must MATCH the mise.toml pin [POD-3187]. Both tools change the bytes a
 * release ships (zig links the native binaries, rcodesign writes the Darwin signature),
 * so a drifted local install must fail here, loudly, rather than produce a bundle that
 * differs from what CI would have built. `PODIUM_SKIP_TOOL_PIN_CHECK=1` waives it for
 * deliberate experiments. Memoized per (tool, path): one probe per process, not per call.
 */
const pinChecked = new Set<string>()
function assertPinnedVersion(tool: string, path: string, args: string[], pinned: string): string {
  if (process.env.PODIUM_SKIP_TOOL_PIN_CHECK === '1') return path
  const key = `${tool}\0${path}`
  if (pinChecked.has(key)) return path
  const printed = spawnSync(path, args, { encoding: 'utf8' }).stdout?.trim() ?? ''
  if (!printed.split(/\s+/).includes(pinned)) {
    throw new Error(
      `${tool} at ${path} reports "${printed}" but mise.toml pins ${pinned}. ` +
        `Run \`mise install\` (or install ${tool} ${pinned}), or set PODIUM_SKIP_TOOL_PIN_CHECK=1 ` +
        `to build with an off-pin toolchain deliberately.`,
    )
  }
  pinChecked.add(key)
  return path
}

const ZIG_VERSION_ARGS = ['version']
const RCODESIGN_VERSION_ARGS = ['--version']

export function resolveZig(): string {
  const zig = findTool('PODIUM_ZIG', 'zig', ZIG_VERSION_ARGS, [
    join(homedir(), '.local/bin/zig'),
    // Where mise puts its shims. CI adds this to PATH, but a `mise install` on a shell that
    // has not been hooked does not, and the failure it produced was indistinguishable.
    join(homedir(), '.local/share/mise/shims/zig'),
  ])
  return assertPinnedVersion('zig', zig, ZIG_VERSION_ARGS, readToolPins().zig)
}

export function resolveRcodesign(): string {
  const rcodesign = findTool('PODIUM_RCODESIGN', 'rcodesign', RCODESIGN_VERSION_ARGS, [
    join(homedir(), '.cargo/bin/rcodesign'),
    join(homedir(), '.local/share/mise/shims/rcodesign'),
  ])
  return assertPinnedVersion(
    'rcodesign',
    rcodesign,
    RCODESIGN_VERSION_ARGS,
    readToolPins().rcodesign,
  )
}
