/**
 * THE BUILD LEDGER — one durable record per release attempt.
 *
 * A release attempt used to leave nothing behind but tarballs in the source checkout's
 * `dist-bun/`, named well enough to sort but unable to say what was checked, which
 * client build they were packaged from, whether Turbo rebuilt or restored it, or
 * whether the thing was ever published. That evidence lived in the log of whichever
 * process happened to run the build, which is to say it did not live anywhere.
 *
 * A record is a directory under the INSTANCE STATE DIRECTORY, not the checkout:
 *
 *   <stateDir>/builds/<buildId>/
 *     manifest.json   the record below
 *     client.json     the coordinator child's own client evidence, written before the
 *                     record exists (see `scripts/release.ts --record`)
 *     bundles/        podium-headless-<version>-<platform>.tar.gz + .sig + .meta.json
 *     timing.jsonl    release-build timings for this attempt
 *
 * WHY THE SIDECARS SIT BESIDE THE TARBALL rather than in a `signatures/` directory of
 * their own, which §6 of the design sketched: every writer and reader in this tree
 * addresses them as `<tarball path> + '.sig'` / `+ '.meta.json'` — the release child
 * included, which is handed one artifact path and writes its signature next to it.
 * Splitting them would be a change to the child's contract bought with nothing.
 *
 * WHY `manifest.json` IS THE RECORD AND THE DIRECTORY IS NOT: the directory is created
 * before the build runs, because the build has to write its tarballs somewhere. The
 * manifest is written only once the attempt has produced signed bytes (or failed in a
 * named step). So a directory without a manifest is a build in flight or one that died
 * before it could say anything, and {@link listBuildRecords} — which is what retention
 * and recovery read — sees only attempts that got far enough to state an outcome.
 *
 * Spec: docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md §6.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * How far an attempt got.
 *
 * `validated` — the clients verified, nothing signed yet. `signed` — every requested
 * platform produced a signed tarball this host has hashed. `published` — its manifest
 * is the one the served feed names. `failed:<step>` names the step that refused and is
 * TERMINAL: a failed attempt is forensics, never something a later step resumes.
 */
export type BuildOutcome = 'validated' | 'signed' | 'published' | `failed:${string}`

/** What the client half of an attempt proved. Mirrors `ClientBuildEvidence` (M1/M2). */
export interface BuildRecordClient {
  rootDigest: string
  sourceCommit: string
  version: string
  /** Per Turbo task: its cache key and whether the output was restored or produced. */
  tasks: Record<string, { hash: string; cache: 'HIT' | 'MISS' }>
}

/** One platform's signed tarball, addressed relative to the record's `bundles/`. */
export interface BuildRecordArtifact {
  platform: string
  /** Basename inside `<record>/bundles/`. Never a path — the record owns the directory. */
  file: string
  size: number
  digest: string
  signature: string
}

export interface BuildRecord {
  recordVersion: 1
  buildId: string
  /** Commit the attempt was approved for, short. */
  approvedSha: string
  version: string
  platforms: string[]
  client: BuildRecordClient | null
  artifacts: BuildRecordArtifact[]
  signingKeyFingerprint: string
  startedAt: string
  outcome: BuildOutcome
  outcomeAt: string
}

const RECORDS_DIR = 'builds'
const MANIFEST = 'manifest.json'

/** Order among the outcomes an attempt can advance THROUGH. `failed:` is outside it. */
const ORDER: Record<'validated' | 'signed' | 'published', number> = {
  validated: 0,
  signed: 1,
  published: 2,
}

export function buildRecordsRoot(stateDir: string): string {
  return join(stateDir, RECORDS_DIR)
}

export function buildRecordDir(stateDir: string, buildId: string): string {
  return join(buildRecordsRoot(stateDir), buildId)
}

export function buildRecordPath(stateDir: string, buildId: string): string {
  return join(buildRecordDir(stateDir, buildId), MANIFEST)
}

/** Where this attempt's tarballs and their sidecars go. */
export function buildBundlesDir(stateDir: string, buildId: string): string {
  return join(buildRecordDir(stateDir, buildId), 'bundles')
}

export function buildTimingPath(stateDir: string, buildId: string): string {
  return join(buildRecordDir(stateDir, buildId), 'timing.jsonl')
}

/**
 * Where a release's timing lines land WHILE it is building.
 *
 * The sink is opened before the attempt has a record to write into — it times the very
 * steps that produce one — so it stages here, keyed by version, and the file is moved
 * into `builds/<buildId>/timing.jsonl` when the record is written. The leading dot
 * keeps it out of the record listing.
 */
export function releaseTimingStagingDir(stateDir: string): string {
  return join(buildRecordsRoot(stateDir), '.timing')
}

export function buildClientEvidencePath(stateDir: string, buildId: string): string {
  return join(buildRecordDir(stateDir, buildId), 'client.json')
}

/**
 * `<stamp>-<sha>` — sortable, and it names the two facts a human reading a directory
 * listing wants: when, and of what.
 */
export function mintBuildId(stamp: string, sha: string): string {
  if (!stamp || !sha) throw new Error('a build id needs both a stamp and a commit')
  return `${stamp}-${sha}`
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function serialise(record: BuildRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * Refuse a move that would make the ledger say less than it already does.
 *
 * The record is the only durable claim that something was published; letting a late
 * writer walk it back to `signed` would erase that claim with no evidence that anything
 * was withdrawn.
 */
function assertForward(buildId: string, from: BuildOutcome, to: BuildOutcome): void {
  if (from === to) return
  if (from.startsWith('failed:')) {
    throw new Error(`build ${buildId} outcome ${from} is terminal`)
  }
  // Failing is always allowed from a live outcome: a publish that could not be proved
  // reachable has to be able to say so.
  if (to.startsWith('failed:')) return
  const before = ORDER[from as keyof typeof ORDER]
  const after = ORDER[to as keyof typeof ORDER]
  if (after === undefined || before === undefined) {
    throw new Error(`build ${buildId} cannot take outcome ${to}`)
  }
  if (after < before) {
    throw new Error(`cannot move build ${buildId} from ${from} back to ${to}`)
  }
}

/** Create the directories an attempt writes into, before it has anything to record. */
export function prepareBuildRecordDir(stateDir: string, buildId: string): string {
  const dir = buildRecordDir(stateDir, buildId)
  mkdirSync(join(dir, 'bundles'), { recursive: true })
  return dir
}

export function writeBuildRecord(stateDir: string, record: BuildRecord): void {
  mkdirSync(buildRecordDir(stateDir, record.buildId), { recursive: true })
  const existing = readBuildRecord(stateDir, record.buildId)
  if (existing) assertForward(existing.buildId, existing.outcome, record.outcome)
  writeAtomic(buildRecordPath(stateDir, record.buildId), serialise(record))
}

export function readBuildRecord(stateDir: string, buildId: string): BuildRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(buildRecordPath(stateDir, buildId), 'utf8'))
  } catch {
    return null
  }
  const candidate = raw as Partial<BuildRecord>
  if (candidate.recordVersion !== 1) return null
  // A record that does not name its own directory is not this record: it was copied,
  // half-written, or hand-edited, and reading it would attribute one attempt's
  // artifacts to another's id.
  if (candidate.buildId !== buildId) return null
  if (typeof candidate.outcome !== 'string' || !Array.isArray(candidate.artifacts)) return null
  return candidate as BuildRecord
}

/** Every readable record, NEWEST FIRST. `<stamp>-<sha>` sorts chronologically as text. */
export function listBuildRecords(stateDir: string): BuildRecord[] {
  let names: string[]
  try {
    names = readdirSync(buildRecordsRoot(stateDir))
  } catch {
    return []
  }
  const records: BuildRecord[] = []
  for (const id of names.sort().reverse()) {
    const record = readBuildRecord(stateDir, id)
    if (record) records.push(record)
  }
  return records
}

/** Build directories with no readable record — a build in flight, or one that died. */
export function listUnrecordedBuildDirs(stateDir: string): string[] {
  try {
    return readdirSync(buildRecordsRoot(stateDir))
      .filter((id) => readBuildRecord(stateDir, id) === null)
      .sort()
  } catch {
    return []
  }
}

export function advanceOutcome(
  stateDir: string,
  buildId: string,
  outcome: BuildOutcome,
  at = new Date(),
): BuildRecord {
  const current = readBuildRecord(stateDir, buildId)
  if (!current) throw new Error(`no build record ${buildId}`)
  assertForward(buildId, current.outcome, outcome)
  const next: BuildRecord = { ...current, outcome, outcomeAt: at.toISOString() }
  writeAtomic(buildRecordPath(stateDir, buildId), serialise(next))
  return next
}

/**
 * WHICH RECORDS A SWEEP MAY REMOVE — decided from the records alone.
 *
 * `retain` counts RECORDS, which is what makes this different from the file-name sweep
 * it replaces: a release is one record however many platforms it minted, so a
 * four-platform publish can no longer age three quarters of itself out.
 *
 * `referenced` is the rule that matters and the one worth testing hardest: a build id a
 * retained publish still names is never returned, wherever it falls in the window. The
 * served feed names exactly one, but a fleet mid-rollout can be converging on the
 * previous one, and deleting the bytes under a machine that is downloading them is the
 * failure this ledger exists to make impossible.
 */
export function selectBuildRecordSweep(
  records: readonly BuildRecord[],
  options: {
    retain: number
    /** Build ids a live publish or an in-flight build still names. Never removed. */
    referenced?: readonly string[]
  },
): string[] {
  const referenced = new Set(options.referenced ?? [])
  const doomed: string[] = []
  // Two windows, not one. A failed attempt is forensics, not a release: counting the
  // two in one window means a run of four failures ages out the last release that
  // worked, and giving failures no window at all means they accumulate forever. Each
  // class keeps its own newest `retain`.
  const kept = { release: 0, failed: 0 }
  for (const record of records) {
    const bucket = record.outcome.startsWith('failed:') ? 'failed' : 'release'
    // A referenced record inside the window still FILLS its slot: protecting it is
    // about not deleting it, not about widening the window by one every time the
    // release being served is also the newest one.
    if (kept[bucket] < options.retain) {
      kept[bucket] += 1
      continue
    }
    if (referenced.has(record.buildId)) continue
    doomed.push(record.buildId)
  }
  return doomed
}

/**
 * Remove the records the selection doomed, and any build directory that never wrote a
 * record and is older than `unrecordedGraceMs`.
 *
 * Never fatal: a directory that could not be removed is disk to reclaim next time, not
 * a reason to fail a publish.
 */
export function sweepBuildRecords(
  stateDir: string,
  options: {
    retain: number
    referenced?: readonly string[]
    /** Build ids whose directories are being written right now. */
    protect?: readonly string[]
    now?: number
    /** How long a record-less directory is left alone. Default one hour. */
    unrecordedGraceMs?: number
  },
): string[] {
  const protectedIds = new Set(options.protect ?? [])
  const removed: string[] = []
  const remove = (id: string): void => {
    if (protectedIds.has(id)) return
    try {
      rmSync(buildRecordDir(stateDir, id), { recursive: true, force: true })
      removed.push(id)
    } catch {
      // Next sweep sees it again.
    }
  }
  for (const id of selectBuildRecordSweep(listBuildRecords(stateDir), options)) remove(id)

  const grace = options.unrecordedGraceMs ?? 60 * 60 * 1000
  const now = options.now ?? Date.now()
  for (const id of listUnrecordedBuildDirs(stateDir)) {
    if (protectedIds.has(id)) continue
    let mtime: number
    try {
      mtime = statSync(buildRecordDir(stateDir, id)).mtimeMs
    } catch {
      continue
    }
    if (now - mtime < grace) continue
    remove(id)
  }
  return removed
}

/** True when the record still has every byte it names. */
export function buildRecordArtifactsPresent(stateDir: string, record: BuildRecord): boolean {
  return record.artifacts.every((artifact) =>
    existsSync(join(buildBundlesDir(stateDir, record.buildId), artifact.file)),
  )
}
