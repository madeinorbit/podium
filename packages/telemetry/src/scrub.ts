/**
 * Stack-trace scrubbing [spec:SP-f933].
 *
 * Two rules, both deliberately blunt:
 *
 *  1. **The message is dropped.** Not scrubbed — dropped. Error messages embed
 *     paths, repo names, URLs, SQL, prompts and whatever the throwing code
 *     interpolated; there is no allowlist that makes free text safe, so it
 *     never enters the payload at all. This module exposes no way to include it.
 *
 *  2. **Frames outside the Podium install are dropped, not rewritten.** A frame
 *     in node internals, in the user's own code, or in node_modules is discarded
 *     whole. Rewriting (e.g. `/home/alice/work/secret-repo/x.ts` → `x.ts`) is
 *     what leaks: the basename of a user's file is still their data, and a
 *     "sanitized" path invites the next person to relax the rule. Only paths
 *     that resolve INSIDE the install directory and land on a known Podium
 *     source root survive, and they survive as install-relative paths that
 *     describe our own open-source tree.
 *
 * Everything here is pure: paths in, frames out. The tests feed it hostile
 * input (usernames, repo names, Windows paths, symlinked worktrees, `..`
 * escapes) and assert nothing recognizable survives.
 */

import type { ErrorType } from './schema'
import {
  normalizeErrorType,
  PODIUM_SOURCE_ROOTS,
  type StackFrame,
  StackFrame as StackFrameSchema,
} from './schema'

/** V8 stack line shapes:
 *    "    at fnName (/abs/path/file.ts:12:3)"
 *    "    at /abs/path/file.ts:12:3"
 *    "    at fnName (file:///abs/path/file.ts:12:3)"
 *    "    at async Object.handler (/abs/file.ts:1:2)"
 */
const STACK_LINE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/

/**
 * Bun's `--compile` binaries report frames inside a virtual filesystem
 * (`/$bunfs/root/...`, or `B:\~BUN\root\...` on Windows). Strip the marker so
 * what follows is treated as install-relative — otherwise every frame from a
 * shipped binary fails the install-containment test below and every crash
 * report is empty.
 */
const BUNFS_MARKERS = [/^.*\/\$bunfs\/root\//, /^.*[Bb]:\\~BUN\\root\\/]

function stripBunfs(path: string): string {
  for (const marker of BUNFS_MARKERS) {
    if (marker.test(path)) return path.replace(marker, '')
  }
  return path
}

/** file:// URL → path; leaves plain paths alone. */
function fileUrlToPath(raw: string): string {
  if (!raw.startsWith('file://')) return raw
  try {
    return decodeURIComponent(new URL(raw).pathname)
  } catch {
    return raw
  }
}

/** Posix-ify separators so one regex handles Windows frames too. */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Make `filePath` relative to `installRoot`, or return undefined when it is not
 * inside it. Pure string containment — deliberately NOT realpath(): the
 * scrubber must stay pure and synchronous, and resolving symlinks would let a
 * worktree symlinked INTO the install dir smuggle a user path in. A symlinked
 * path that doesn't textually sit under the install root is simply dropped,
 * which is the safe direction to be wrong in.
 */
function installRelative(filePath: string, installRoot: string): string | undefined {
  const file = toPosix(filePath)
  const root = toPosix(installRoot).replace(/\/+$/, '')
  if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1)
  // Already relative (e.g. a stripped $bunfs frame, or a relative-path stack).
  if (!file.startsWith('/') && !/^[A-Za-z]:\//.test(file)) return file
  return undefined
}

/** True for a path that is inside the install but NOT ours to report (deps). */
function isVendored(relative: string): boolean {
  return relative.split('/').includes('node_modules')
}

const SOURCE_ROOTS: readonly string[] = PODIUM_SOURCE_ROOTS

/**
 * Scrub one already-parsed frame. Returns undefined when the frame must be
 * dropped — which is the common case and always the safe one.
 */
export function scrubFrame(
  input: { file: string; line: number; fn?: string },
  installRoot: string,
): StackFrame | undefined {
  const raw = stripBunfs(fileUrlToPath(input.file.trim()))
  const relative = installRelative(raw, installRoot)
  if (!relative) return undefined
  // `..` escaping the install root, or a vendored dependency: not ours, drop it.
  if (relative.split('/').includes('..') || isVendored(relative)) return undefined
  if (!SOURCE_ROOTS.includes(relative.split('/')[0] ?? '')) return undefined

  const candidate: StackFrame = {
    file: relative,
    line: input.line,
    ...(input.fn ? { fn: input.fn } : {}),
  }
  // The schema is the arbiter, not this function: if the scrubbed frame does not
  // satisfy the published shape, it does not go. Belt and braces on purpose —
  // this is the last gate before user data would leave the machine.
  const parsed = StackFrameSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  // A frame whose path is fine but whose fn isn't an identifier is still worth
  // keeping — retry without the name rather than losing the location.
  if (input.fn) {
    const withoutFn = StackFrameSchema.safeParse({ file: relative, line: input.line })
    if (withoutFn.success) return withoutFn.data
  }
  return undefined
}

/**
 * Parse + scrub a raw V8 `error.stack`. The first line (`TypeError: <message>`)
 * is never parsed as a frame, so the message cannot survive by accident.
 */
export function scrubStack(stack: string | undefined, installRoot: string, max = 20): StackFrame[] {
  if (!stack) return []
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const m = STACK_LINE.exec(line)
    if (!m) continue
    const [, fn, file, lineNo] = m
    if (!file || !lineNo) continue
    const scrubbed = scrubFrame(
      {
        file,
        line: Number(lineNo),
        ...(fn ? { fn: fn.replace(/^(?:async|new)\s+/, '') } : {}),
      },
      installRoot,
    )
    if (scrubbed) frames.push(scrubbed)
    if (frames.length >= max) break
  }
  return frames
}

export interface ScrubbedError {
  errorType: ErrorType
  frames: StackFrame[]
}

/**
 * Turn a thrown value into the only two things a crash report may carry: a
 * closed-enum error type and Podium-relative frames. The message is not a
 * parameter, not a return value, and not reachable from here.
 */
export function scrubError(err: unknown, installRoot: string): ScrubbedError {
  const errorType = normalizeErrorType(
    err instanceof Error ? err.constructor?.name : typeof err === 'object' ? undefined : undefined,
  )
  const frames = scrubStack(err instanceof Error ? err.stack : undefined, installRoot)
  return { errorType, frames }
}

/**
 * The rate-limit signature for a crash (design: "rate-limited per (errorType,
 * top-frame) signature so a crash loop can't beacon"). Built only from already-
 * scrubbed values, so the signature itself can never hold user data.
 */
export function crashSignature(scrubbed: ScrubbedError): string {
  const top = scrubbed.frames[0]
  return `${scrubbed.errorType}@${top ? `${top.file}:${top.line}` : 'no-frames'}`
}
