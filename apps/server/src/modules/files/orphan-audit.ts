import {
  type BlobKey,
  type BlobStorage,
  type BlobStore,
  blobKey,
  decodeKeySegment,
  parsePadded,
} from '@podium/blob-store'
import { createLogger } from '@podium/logger'
import {
  asIssueId,
  type IssueId,
  type IssuePanelArtifactWire,
  type MachineId,
  type WorkspaceId,
} from '@podium/model'
import { LAKE_PART_BYTES } from '@podium/sync'
import type { ArtifactUploadRef, ArtifactUploadsRepository } from '../../store/artifact-uploads'
import type { TranscriptMirrorRepository } from '../../store/conversations/mirror'
import type { PendingUploadRow, PendingUploadsRepository } from '../../store/pending-uploads'
import { isPendingUploadId, pendingUploadKey } from '../issues/pending-uploads'

/**
 * THE ORPHAN AUDIT OF ONE WORKSPACE'S FILES (POD-6963 design 2.9, POD-7057).
 *
 * The hourly sweeps are queries over `pending_uploads` and `artifact_uploads`:
 * they find what a row still names. What no row names is invisible to them: an
 * object written by a crash between its write and its row, an artifact whose
 * replacement or removal failed to delete it, staging whose row is gone, and
 * lake parts past a shrink that a crash left behind. The audit finds those by
 * the other direction: it lists the workspace's prefix in key order, compares
 * each key with the database, and deletes what nothing references and was
 * last written more than a day ago. It also serves POD-6966's deletion
 * obligations: after it, every stored byte is one a row accounts for.
 *
 * What references what:
 *
 * | Key | Kept while |
 * |---|---|
 * | `artifacts/<issue>/<artifact>/…` | a panel entry of the issue names the artifact, or a composer upload's claim does |
 * | `artifacts/.uploads/<issue>/<upload>/<member>/<offset>` | its `artifact_uploads` row exists |
 * | `pending-uploads/<id>/file/<entry>` | its `pending_uploads` row exists and names this key |
 * | `transcripts/<machine>/<native>/<incarnation>/<part>` | the incarnation's cursor reaches into the part: the active one's `mirrored_bytes` on the segment, an archived one's on its row |
 *
 * Any other key under `artifacts/` or `pending-uploads/` is one nothing can
 * reference and goes once it is a day old. Under `transcripts/` only keys of
 * the lake's own shape are judged: on a self-hosted disk that root is the
 * directory a co-located daemon also writes, so anything else there is left
 * alone.
 *
 * SAFE TO RUN TWICE, AND BESIDE ITSELF. Every delete is idempotent, and the age
 * rule keeps everything a writer may be about to reference: every owner writes
 * its bytes first and its row (or cursor) right after, so a key younger than a
 * day is never judged. The one race left is a lake part rewritten between the
 * listing and the delete; the mirror's shorter-than-cursor guard repairs that
 * by re-pulling the bytes, which is what it does for a crash.
 *
 * A DELETION CEILING PER ROOT. A reference read that comes back empty or short
 * (a bug, a scoping mistake, a database restored from a backup older than the
 * files) would make every listed key look unreferenced. So the audit first
 * plans a whole root, then deletes nothing under it when the plan would remove
 * more than {@link ORPHAN_DELETE_CEILING_SHARE} of the keys it listed there,
 * unless the plan is at most {@link ORPHAN_DELETE_FLOOR} keys (so one stray file
 * in a nearly empty root is not blocked). A refused root is logged once with its
 * counts and a few sample keys and reported as `refused`; `overrideCeiling`
 * lets a later operator command delete it anyway, per root. `dryRun` plans
 * every root and deletes nothing. A plan holds its keys in memory: the orphans
 * of one root, which the ceiling keeps to a share of the listing.
 *
 * The handle is the workspace's own (`BlobStorage.forWorkspace`), so the audit
 * cannot list or delete outside the workspace's prefix; the records are that
 * workspace's repositories.
 */

const log = createLogger('server:orphan-audit')

/** Keys written less than this long ago are never judged. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000
/** How often a server audits its workspace: rarely, the design says; daily. */
export const ORPHAN_AUDIT_EVERY_MS = 24 * 60 * 60 * 1000
/** A root whose plan removes more than this share of its listed keys is refused. */
export const ORPHAN_DELETE_CEILING_SHARE = 0.2
/** A plan of at most this many keys is never refused, whatever its share. */
export const ORPHAN_DELETE_FLOOR = 10
/** Keys a refusal names in its log line and report. */
const REFUSAL_SAMPLES = 5

/** Rows read per page of a reference table. */
const PAGE = 500
/** Distinct issues per panel read; the panel's IN list. */
const ISSUE_BATCH = 500
/** Old artifact keys held before their issues are read. */
const KEY_BATCH = 5000

const ARTIFACTS = 'artifacts'
const UPLOADS = '.uploads'
const PENDING_UPLOADS = 'pending-uploads'
const TRANSCRIPTS = 'transcripts'
/** The roots the audit lists, in the order it lists them. */
export const AUDITED_ROOTS = [ARTIFACTS, PENDING_UPLOADS, TRANSCRIPTS] as const
export type AuditedRoot = (typeof AUDITED_ROOTS)[number]

/** The artifact store's id rule: dot-prefixed names are staging, never refs. */
const ID_RE = /^(?!\.)[A-Za-z0-9._-]+$/
/** The lake's padded incarnation and part numbers. */
const LAKE_DIGITS = 8

/** The rows the audit compares the listing with: one workspace's repositories. */
export interface OrphanAuditRecords {
  pendingUploads: Pick<PendingUploadsRepository, 'page'>
  artifactUploads: Pick<ArtifactUploadsRepository, 'page'>
  /** The artifact entries of these issues' panels (`IssuePanelRepository.forIssues`). */
  panelArtifacts(
    issueIds: readonly IssueId[],
  ): Promise<ReadonlyArray<Pick<IssuePanelArtifactWire, 'issueId' | 'artifactId'>>>
  /** The lake's cursors; absent when the lake is off, and `transcripts/` is not audited. */
  lake?: Pick<TranscriptMirrorRepository, 'lakeConversionSegments' | 'lakeConversionArchived'>
}

export interface OrphanAuditOptions {
  now?: () => number
  minAgeMs?: number
  /** The lake's part size (P); the parted lake's own by default. */
  partBytes?: number
  /** Plan every root and delete nothing. */
  dryRun?: boolean
  /** Roots whose plan is deleted even past the ceiling: an operator's override. */
  overrideCeiling?: readonly AuditedRoot[]
}

/** What one pass saw, per root. */
export interface OrphanAuditRootReport {
  listed: number
  /** Younger than the age rule: not judged. */
  young: number
  referenced: number
  /** Under `transcripts/` only: keys not in the lake's shape, left alone. */
  foreign: number
  /** Old keys nothing references: the plan's deletions. */
  orphans: number
  /** Deleted by this pass: `orphans`, or none when refused or a dry run. */
  deleted: number
  /** The ceiling refused the plan; nothing under this root was deleted. */
  refused: boolean
  /** A few of a refused plan's keys, for the operator. */
  samples: readonly BlobKey[]
}

export interface OrphanAuditReport {
  workspaceId: WorkspaceId
  dryRun: boolean
  roots: Record<AuditedRoot, OrphanAuditRootReport>
  /** Each root's planned deletions, in key order. */
  plan: Record<AuditedRoot, readonly BlobKey[]>
}

function emptyRoot(): OrphanAuditRootReport {
  return {
    listed: 0,
    young: 0,
    referenced: 0,
    foreign: 0,
    orphans: 0,
    deleted: 0,
    refused: false,
    samples: [],
  }
}

/** Whether the ceiling refuses a plan of `orphans` keys out of `listed`. */
export function ceilingRefuses(orphans: number, listed: number): boolean {
  return orphans > ORPHAN_DELETE_FLOOR && orphans > ORPHAN_DELETE_CEILING_SHARE * listed
}

const pair = (a: string, b: string) => `${a}\0${b}`
const triple = (a: string, b: string, n: number) => `${a}\0${b}\0${n}`

/**
 * Audit one workspace: the entry point for a caller that holds the storage of
 * many (the hosted composition, POD-6962's job). Builds the workspace's own
 * handle, so nothing outside `<workspaceId>/` is listed.
 */
export async function auditWorkspaceFiles(
  storage: BlobStorage,
  workspaceId: WorkspaceId,
  records: OrphanAuditRecords,
  options: OrphanAuditOptions = {},
): Promise<OrphanAuditReport> {
  return await new OrphanAudit(
    storage.forWorkspace(workspaceId),
    workspaceId,
    records,
    options,
  ).run()
}

export class OrphanAudit {
  private readonly now: () => number
  private readonly minAgeMs: number
  private readonly partBytes: number
  private readonly dryRun: boolean
  private readonly overrideCeiling: ReadonlySet<AuditedRoot>
  /** The root being planned: its orphan keys, in listing order. */
  private planned: BlobKey[] = []

  constructor(
    /** This workspace's handle (`forWorkspace(workspaceId)`). */
    private readonly files: BlobStore,
    private readonly workspaceId: WorkspaceId,
    private readonly records: OrphanAuditRecords,
    options: OrphanAuditOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS
    this.partBytes = options.partBytes ?? LAKE_PART_BYTES
    this.dryRun = options.dryRun ?? false
    this.overrideCeiling = new Set(options.overrideCeiling ?? [])
  }

  async run(): Promise<OrphanAuditReport> {
    const cutoff = this.now() - this.minAgeMs
    const report: OrphanAuditReport = {
      workspaceId: this.workspaceId,
      dryRun: this.dryRun,
      roots: { artifacts: emptyRoot(), 'pending-uploads': emptyRoot(), transcripts: emptyRoot() },
      plan: { artifacts: [], 'pending-uploads': [], transcripts: [] },
    }
    const pending = await this.pendingRows()
    // Each root is planned whole, then settled: deleted, or refused by the ceiling.
    const plan = async (
      root: AuditedRoot,
      audit: (into: OrphanAuditRootReport) => Promise<void>,
    ) => {
      this.planned = []
      await audit(report.roots[root])
      // Members are judged a batch of issues at a time; the plan reads in key order.
      report.plan[root] = this.planned.sort()
      await this.settle(root, report.roots[root], this.planned)
    }
    await plan(ARTIFACTS, (into) => this.auditArtifacts(cutoff, pending, into))
    await plan(PENDING_UPLOADS, (into) => this.auditPendingUploads(cutoff, pending, into))
    const lake = this.records.lake
    if (lake) await plan(TRANSCRIPTS, (into) => this.auditLake(cutoff, lake, into))
    return report
  }

  /** Delete a root's plan unless this is a dry run or the ceiling refuses it. */
  private async settle(
    root: AuditedRoot,
    report: OrphanAuditRootReport,
    keys: readonly BlobKey[],
  ): Promise<void> {
    if (ceilingRefuses(keys.length, report.listed) && !this.overrideCeiling.has(root)) {
      report.refused = true
      report.samples = keys.slice(0, REFUSAL_SAMPLES)
      log.warn('orphan audit refused a root: its plan deletes too much of what it listed', {
        workspaceId: this.workspaceId,
        root,
        listed: report.listed,
        orphans: keys.length,
        ceilingShare: ORPHAN_DELETE_CEILING_SHARE,
        floor: ORPHAN_DELETE_FLOOR,
        samples: report.samples,
      })
      return
    }
    if (this.dryRun) return
    for (const key of keys) {
      await this.files.delete(key)
      report.deleted += 1
    }
  }

  /** Every composer upload's row: about a day of uploads, read in pages. */
  private async pendingRows(): Promise<Map<string, PendingUploadRow>> {
    const rows = new Map<string, PendingUploadRow>()
    let after = ''
    for (;;) {
      const page = await this.records.pendingUploads.page(after, PAGE)
      for (const row of page) rows.set(row.id, row)
      const last = page.at(-1)
      if (page.length < PAGE || last === undefined) return rows
      after = last.id
    }
  }

  /** Every staged CLI upload's `(issue, upload)`: about a day of uploads. */
  private async stagedUploads(): Promise<Set<string>> {
    const staged = new Set<string>()
    let after: ArtifactUploadRef | undefined
    for (;;) {
      const page = await this.records.artifactUploads.page(after, PAGE)
      for (const ref of page) staged.add(pair(ref.issueId, ref.uploadId))
      after = page.at(-1)
      if (page.length < PAGE || after === undefined) return staged
    }
  }

  /**
   * `artifacts/`: staging against `artifact_uploads`, members against the
   * panels of their issues, read for a batch of issues at a time in the order
   * the listing meets them.
   */
  private async auditArtifacts(
    cutoff: number,
    pending: ReadonlyMap<string, PendingUploadRow>,
    root: OrphanAuditRootReport,
  ): Promise<void> {
    const staged = await this.stagedUploads()
    const claimed = new Set<string>()
    for (const row of pending.values()) {
      if (row.claimed) claimed.add(pair(row.claimed.issueId, row.claimed.artifactId))
    }
    let held: Array<{ key: BlobKey; issueId: IssueId; artifactId: string }> = []
    let heldIssues = new Set<IssueId>()
    const flush = async () => {
      if (held.length === 0) return
      const named = new Set(claimed)
      for (const entry of await this.records.panelArtifacts([...heldIssues])) {
        if (entry.artifactId) named.add(pair(entry.issueId, entry.artifactId))
      }
      for (const member of held) {
        if (named.has(pair(member.issueId, member.artifactId))) root.referenced += 1
        else this.orphan(member.key, root)
      }
      held = []
      heldIssues = new Set()
    }
    for await (const entry of this.files.list(blobKey(ARTIFACTS))) {
      root.listed += 1
      if (entry.modifiedAt >= cutoff) {
        root.young += 1
        continue
      }
      const parts = entry.key.split('/')
      if (parts[1] === UPLOADS) {
        const [, , issueId, uploadId] = parts
        const isChunk =
          parts.length === 6 &&
          issueId !== undefined &&
          uploadId !== undefined &&
          ID_RE.test(issueId) &&
          ID_RE.test(uploadId)
        if (isChunk && staged.has(pair(issueId, uploadId))) root.referenced += 1
        else this.orphan(entry.key, root)
        continue
      }
      const [, issueId, artifactId] = parts
      if (
        parts.length < 4 ||
        issueId === undefined ||
        artifactId === undefined ||
        !ID_RE.test(issueId) ||
        !ID_RE.test(artifactId)
      ) {
        this.orphan(entry.key, root)
        continue
      }
      const issue = asIssueId(issueId)
      if (!heldIssues.has(issue) && heldIssues.size >= ISSUE_BATCH) await flush()
      heldIssues.add(issue)
      held.push({ key: entry.key, issueId: issue, artifactId })
      if (held.length >= KEY_BATCH) await flush()
    }
    await flush()
  }

  /** `pending-uploads/`: each key against its row. */
  private async auditPendingUploads(
    cutoff: number,
    pending: ReadonlyMap<string, PendingUploadRow>,
    root: OrphanAuditRootReport,
  ): Promise<void> {
    for await (const entry of this.files.list(blobKey(PENDING_UPLOADS))) {
      root.listed += 1
      if (entry.modifiedAt >= cutoff) {
        root.young += 1
        continue
      }
      const parts = entry.key.split('/')
      const id = parts[1]
      const row = parts.length === 4 && id !== undefined ? pending.get(id) : undefined
      if (row !== undefined && isPendingUploadId(row.id) && namesKey(row, entry.key)) {
        root.referenced += 1
      } else {
        this.orphan(entry.key, root)
      }
    }
  }

  /**
   * `transcripts/`: each part against its incarnation's cursor. A part is
   * referenced while the cursor reaches into it (`part · P < cursor`); a part
   * at or past it is what a shrink should have deleted, or a write whose
   * cursor never advanced.
   */
  private async auditLake(
    cutoff: number,
    lake: NonNullable<OrphanAuditRecords['lake']>,
    root: OrphanAuditRootReport,
  ): Promise<void> {
    const cursors = await this.lakeCursors(lake)
    for await (const entry of this.files.list(blobKey(TRANSCRIPTS))) {
      root.listed += 1
      const part = lakePart(entry.key)
      if (part === undefined) {
        root.foreign += 1
        continue
      }
      if (entry.modifiedAt >= cutoff) {
        root.young += 1
        continue
      }
      const cursor = cursors.get(triple(part.machineId, part.nativeId, part.incarnation)) ?? 0
      if (part.part * this.partBytes < cursor) root.referenced += 1
      else this.orphan(entry.key, root)
    }
  }

  /** Every incarnation with bytes: `(machine, native, sequence)` to its cursor. */
  private async lakeCursors(
    lake: NonNullable<OrphanAuditRecords['lake']>,
  ): Promise<Map<string, number>> {
    const cursors = new Map<string, number>()
    let afterSegment: { machineId: MachineId; nativeId: string } | undefined
    for (;;) {
      const page = await lake.lakeConversionSegments(afterSegment, PAGE)
      for (const segment of page) {
        // A segment mirrored before file identities has no row: its bytes are sequence 1.
        const sequence = segment.activeSequence ?? 1
        cursors.set(triple(segment.machineId, segment.nativeId, sequence), segment.mirroredBytes)
      }
      afterSegment = page.at(-1)
      if (page.length < PAGE || afterSegment === undefined) break
    }
    let afterArchived: { machineId: MachineId; nativeId: string; sequence: number } | undefined
    for (;;) {
      const page = await lake.lakeConversionArchived(afterArchived, PAGE)
      for (const row of page) {
        const key = triple(row.machineId, row.nativeId, row.sequence)
        cursors.set(key, Math.max(cursors.get(key) ?? 0, row.mirroredBytes))
      }
      afterArchived = page.at(-1)
      if (page.length < PAGE || afterArchived === undefined) break
    }
    return cursors
  }

  /** Plan `key` for deletion: old, and nothing references it. */
  private orphan(key: BlobKey, root: OrphanAuditRootReport): void {
    this.planned.push(key)
    root.orphans += 1
  }
}

/** Whether `key` is the one blob this upload row names. */
function namesKey(row: PendingUploadRow, key: BlobKey): boolean {
  try {
    return pendingUploadKey(row) === key
  } catch {
    return false
  }
}

/** A lake part key's ids and numbers; undefined for any other key. */
export function lakePart(
  key: BlobKey,
): { machineId: MachineId; nativeId: string; incarnation: number; part: number } | undefined {
  const parts = key.split('/')
  if (parts.length !== 5 || parts[0] !== TRANSCRIPTS) return undefined
  const [, machine, native, incarnation, part] = parts as [string, string, string, string, string]
  try {
    return {
      machineId: decodeKeySegment(machine) as MachineId,
      nativeId: decodeKeySegment(native),
      incarnation: parsePadded(incarnation, LAKE_DIGITS),
      part: parsePadded(part, LAKE_DIGITS),
    }
  } catch {
    return undefined
  }
}
