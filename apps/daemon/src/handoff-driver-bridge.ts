import { isDriverRefusal, type SessionArchive } from '@podium/agent-runtime'
import { harnessSupportsHandoff } from '@podium/harness'
import type { ResumeRef, SessionId } from '@podium/model'
import type { DaemonContext } from './control/context'

/**
 * THE LIVE CONVERSATION BRIDGE (POD-4306, F16).
 *
 * The handoff package (`handoff-package.ts`) is the larger authorized
 * workspace/binding service: worktree snapshot, branch/bases, owner/visibility,
 * chunk transport and binding receipts. The driver (`terminal-driver.ts`
 * `export()`) is the live conversation owner: capability declaration, resume
 * gate and harness-native bytes.
 *
 * This module is the bridge between them, and nothing else:
 *
 *   - a live handle exports the conversation via the driver boundary;
 *   - a parked session (no handle) falls back to the file locator, preserving
 *     no-handle parked export support;
 *   - the archive is validated for native identity, path safety and process
 *     containment before it ever reaches the workspace snapshot.
 *
 * It never snapshots a worktree, never touches git, never claims a binding.
 * Those stay in `handoff-package.ts` and `control/handoff.ts`.
 */

/** Split an archive-relative path into manifest filename + relativeDir. */
export function archivePathParts(archivePath: string): {
  filename: string
  relativeDir?: string
} {
  if (!archivePath) throw new Error('handoff refused: conversation archive path is empty')
  if (
    archivePath.startsWith('/') ||
    archivePath.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(archivePath)
  )
    throw new Error('handoff refused: conversation archive path escapes the archive root')
  const parts = archivePath.split(/[\\/]/)
  if (parts.includes('..') || parts.some((part) => part === ''))
    throw new Error('handoff refused: conversation archive path escapes the archive root')
  const filename = parts.at(-1)
  if (!filename) throw new Error('handoff refused: conversation archive path is empty')
  const dir = parts.slice(0, -1).join('/')
  return dir ? { filename, relativeDir: dir } : { filename }
}

/**
 * THE CONVERSATION IDENTITY CHECK — native identity, containment, no fork.
 *
 * Every condition below is a guard with its own negative test:
 *
 *   - harness/resume/sessionId mismatch: a package for another conversation
 *     must never be adopted as this one;
 *   - empty files: an archive with no bytes cannot resume anywhere;
 *   - unsafe path: an absolute path is a promise about the DESTINATION machine
 *     the source cannot make, and `..` writes outside the extraction dir;
 *   - process/bindingVersion: per-machine identity that must never cross
 *     machines — carrying it would name a process that never existed there,
 *     the fork this command exists to prevent.
 */
export function validateConversationArchive(
  archive: SessionArchive,
  expected: { sessionId: SessionId; agentKind: string; resume: ResumeRef },
): void {
  if (archive.harness !== expected.agentKind)
    throw new Error('handoff refused: conversation harness mismatch')
  if (archive.resume.kind !== expected.resume.kind || archive.resume.value !== expected.resume.value)
    throw new Error('handoff refused: conversation identity mismatch')
  if (archive.binding.sessionId !== expected.sessionId)
    throw new Error('handoff refused: conversation session mismatch')
  if (archive.binding.harness !== expected.agentKind)
    throw new Error('handoff refused: conversation harness mismatch')
  if (Object.hasOwn(archive.binding, 'process') || Object.hasOwn(archive.binding, 'bindingVersion'))
    throw new Error('handoff refused: conversation archive carries process identity')
  if (archive.files.length === 0)
    throw new Error('handoff refused: conversation archive is empty')
  const first = archive.files[0]
  if (!first || first.bytes.byteLength === 0)
    throw new Error('handoff refused: conversation archive is empty')
  // Path safety is checked here AND at split time: this is the gate, the split
  // is the use. Both must hold. Empty segments (`//`, leading/trailing `/`)
  // are the same escape class as `..`: they make the archive-relative promise
  // ambiguous about the destination layout.
  if (
    first.path.startsWith('/') ||
    first.path.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(first.path) ||
    first.path.split(/[\\/]/).includes('..') ||
    first.path.split(/[\\/]/).some((part) => part === '')
  )
    throw new Error('handoff refused: conversation archive path escapes the archive root')
}

/** Refuse an unsupported harness before package materialization. */
export function refuseUnsupportedHandoffHarness(agentKind: string): void {
  if (!harnessSupportsHandoff(agentKind))
    throw new Error(`harness ${agentKind} declares handoff unsupported`)
}

/**
 * Export the live conversation via the driver boundary, or `undefined` when
 * no live handle exists (parked — the file fallback owns it).
 *
 * Driver refusals are mapped to handoff errors the caller can branch on:
 * `unsupported` stays unsupported, `no_resume_ref` stays missing-resume.
 * Anything else (missing store, broken driver) aborts the export before the
 * workspace snapshot, so the source keeps its residue and its worktree.
 */
export async function exportConversationViaDriver(
  ctx: DaemonContext,
  sessionId: SessionId,
  expected: { agentKind: string; resume: ResumeRef },
): Promise<SessionArchive | undefined> {
  const liveHandle = ctx.agentRuntime?.handleFor(sessionId)
  if (!liveHandle) return undefined
  let archive: SessionArchive
  try {
    archive = await liveHandle.export()
  } catch (error) {
    if (isDriverRefusal(error)) {
      if (error.refusal.reason === 'unsupported')
        throw new Error(`harness ${expected.agentKind} declares handoff unsupported`)
      if (error.refusal.reason === 'no_resume_ref')
        throw new Error('session has no resume reference')
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
  validateConversationArchive(archive, {
    sessionId,
    agentKind: expected.agentKind,
    resume: expected.resume,
  })
  return archive
}
