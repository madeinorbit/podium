/**
 * The pinned versions of the non-node build toolchain, read from mise.toml [POD-3187].
 *
 * mise.toml is the ONE place zig and rcodesign versions are spelled: dev machines install
 * from it (`mise install`), CI installs from it (jdx/mise-action), and resolveZig/
 * resolveRcodesign (scripts/abduco-cross.ts) assert against it so a drifted local install
 * fails loudly instead of shipping different bytes. This module is that assertion's
 * source of truth — a deliberately narrow parser, not a TOML library: it reads exactly
 * the two pins and throws on anything unexpected, so an edit that breaks the shape is
 * caught by the first build rather than silently unpinning a tool.
 */
import { readFileSync } from 'node:fs'
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
