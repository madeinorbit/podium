/**
 * Applying launch terms (POD-6858, docs/design/harness-session-posture.md
 * §4.5–4.6).
 *
 * A posture section may only ADD to what the adapter's builders produced.
 * {@link applyTerms} is where that is checked, once, for every harness:
 *
 * - the builder's args survive in order (they are a subsequence of the
 *   result's), so a `--` prompt boundary or a resume id cannot be dropped or
 *   moved;
 * - the builder's env keys and files survive (a section may merge into a
 *   value, such as an inline config variable, but not remove one);
 * - every file the section adds is inside the session's runtime folder;
 * - every home edit is inside the context's home or one of its roots;
 * - every unmet entry names a known requirement and a real reason.
 *
 * The section never sees the executable or the working folder, so it cannot
 * change either.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { type AgentManifest, declinedReasonIsValid } from './manifest.js'
import {
  type AppliedTerms,
  type HomeEdit,
  type LaunchTerms,
  POSTURE_REQUIREMENTS,
  type PostureLaunch,
  type PostureRequest,
  type PostureResult,
  type UnmetRequirement,
} from './posture-types.js'

/** The terms a harness process runs on: its adapter's section, for this request. */
export function launchTerms(
  manifest: Pick<AgentManifest, 'posture'>,
  request: PostureRequest,
): LaunchTerms {
  return { posture: manifest.posture, request }
}

/**
 * The terms of a process that runs no agent: a native login pane, a chat-id
 * allocation, a tool-less turn. It must not gain any flag, so no section runs.
 */
export function noAgentTerms(reason: string): LaunchTerms {
  if (!declinedReasonIsValid(reason)) {
    throw new Error(`noAgentTerms needs a reason, in words; got ${JSON.stringify(reason)}`)
  }
  return { noAgent: reason }
}

/** Insert option tokens before a `--` boundary, or at the end when there is none. */
export function optionArgs(args: readonly string[], extra: readonly string[]): string[] {
  const boundary = args.indexOf('--')
  if (boundary < 0) return [...args, ...extra]
  return [...args.slice(0, boundary), ...extra, ...args.slice(boundary)]
}

/** The identity section: launch unchanged, nothing unmet, no mode. */
export function unchangedPosture(launch: PostureLaunch): PostureResult {
  return { launch, homeEdits: [], requestedMode: null, unmet: [] }
}

const NOTHING_APPLIED: AppliedTerms = Object.freeze({
  homeEdits: Object.freeze([]) as readonly HomeEdit[],
  requestedMode: null,
  unmet: Object.freeze([]) as readonly UnmetRequirement[],
})

/**
 * Run the terms over a builder's launch and check that the section only added.
 * Throws on a section that broke the contract: that is an adapter bug, found
 * at the first launch (and by the conformance test), never a runtime condition.
 */
export function applyTerms(
  launch: PostureLaunch,
  terms: LaunchTerms,
): { launch: PostureLaunch; applied: AppliedTerms } {
  if ('noAgent' in terms) {
    if (!declinedReasonIsValid(terms.noAgent)) {
      throw new Error(
        `no-agent terms need a reason, in words; got ${JSON.stringify(terms.noAgent)}`,
      )
    }
    return { launch, applied: NOTHING_APPLIED }
  }

  // The section gets a frozen copy, and the checks run against a snapshot, so
  // a section that mutates its input cannot hide what it removed.
  const builder = snapshot(launch)
  const { request } = terms
  const result = terms.posture(builder, request)
  const out = result.launch

  if (!isSubsequence(builder.args, out.args)) {
    throw new Error(
      `posture section removed or reordered a builder argument: ${JSON.stringify(builder.args)} -> ${JSON.stringify(out.args)}`,
    )
  }
  for (const key of Object.keys(builder.env)) {
    if (!Object.hasOwn(out.env, key)) {
      throw new Error(`posture section removed the builder's env ${key}`)
    }
  }
  const builderFiles = new Set(builder.files.map((file) => file.path))
  const outFiles = new Set(out.files.map((file) => file.path))
  for (const path of builderFiles) {
    if (!outFiles.has(path)) throw new Error(`posture section removed the builder's file ${path}`)
  }
  for (const file of out.files) {
    if (builderFiles.has(file.path)) continue
    if (!isInside(file.path, [request.runtimeDir])) {
      throw new Error(
        `posture section wrote ${file.path} outside the session runtime folder ${request.runtimeDir}`,
      )
    }
  }

  const homeBases = [request.context.home, ...Object.values(request.context.roots)].filter(
    (base): base is string => typeof base === 'string' && base.length > 0,
  )
  for (const edit of result.homeEdits) {
    if (!isInside(edit.file, homeBases)) {
      throw new Error(
        `posture section edits ${edit.file}, outside the harness home ${request.context.home} and its folders`,
      )
    }
    if (!isRequirement(edit.serves)) {
      throw new Error(`home edit of ${edit.file} serves an unknown requirement ${edit.serves}`)
    }
    if (edit.kind === 'json-key' && edit.path.length === 0) {
      throw new Error(`json-key home edit of ${edit.file} names no key`)
    }
  }

  for (const entry of result.unmet) {
    if (!isRequirement(entry.requirement)) {
      throw new Error(`unmet entry names an unknown requirement ${entry.requirement}`)
    }
    if (!declinedReasonIsValid(entry.reason)) {
      throw new Error(
        `unmet ${entry.requirement} needs a reason, in words; got ${JSON.stringify(entry.reason)}`,
      )
    }
  }

  if (result.requestedMode !== null && result.requestedMode.trim() === '') {
    throw new Error('posture section requested a blank mode; use null for none')
  }

  return {
    launch: snapshot(out),
    applied: Object.freeze({
      homeEdits: Object.freeze([...result.homeEdits]),
      requestedMode: result.requestedMode,
      unmet: Object.freeze([...result.unmet]),
    }),
  }
}

function snapshot(launch: PostureLaunch): PostureLaunch {
  return Object.freeze({
    args: Object.freeze([...launch.args]),
    env: Object.freeze({ ...launch.env }),
    files: Object.freeze(launch.files.map((file) => Object.freeze({ ...file }))),
  })
}

/** Every token of `inner` appears in `outer`, in the same order. */
function isSubsequence(inner: readonly string[], outer: readonly string[]): boolean {
  let at = 0
  for (const token of outer) {
    if (at < inner.length && token === inner[at]) at += 1
  }
  return at === inner.length
}

/** `path` is absolute and strictly below one of `bases` (never a base itself). */
function isInside(path: string, bases: readonly string[]): boolean {
  if (!isAbsolute(path)) return false
  const target = resolve(path)
  return bases.some((base) => {
    if (!isAbsolute(base)) return false
    const rel = relative(resolve(base), target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  })
}

function isRequirement(value: string): boolean {
  return (POSTURE_REQUIREMENTS as readonly string[]).includes(value)
}
