import {
  type ConversationId,
  firstAdminMemberId,
  type IssueId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import { isIssueMember, isMemberCwd } from '../../issue-util'
import type { SessionRow, SessionStore } from '../../store'
import { subjectFacts } from './facts'
import { compareWithSessionMap, LIVE_PLANE_META_FIELDS, sessionMapParityMode } from './map-parity'
import { Session } from './session'
import {
  applyObservationCheckpointTo,
  isRunningStatus,
  markConversationBound,
  projectSessionMeta,
  recordFromInit,
  type SessionRecord,
  storedSessionInit,
} from './session-record'

/**
 * THE DURABLE SESSION RECORD, READ FROM THE DATABASE (POD-6160, design §6).
 *
 * The session map used to hold every session ever created as a live `Session`.
 * It is shrinking to the sessions that RUN (the live plane: terminal, clients,
 * controller, epoch); everything else about a session is its durable record:
 * the `sessions` row plus the satellites a restart restores it with — its
 * observation checkpoint, its offer, its draft time, its Podium conversation id
 * and whether its runtime transcript has items.
 *
 * A record is a plain value (`SessionRecord`): identity, durable state and the
 * live plane at rest. It is restored through the same mapping the boot load
 * uses (`storedSessionInit` → `recordFromInit`, then the satellites in the boot
 * order), so a projection of a record and of a session restored at boot agree
 * by construction. Reading one never builds a `Session`: no terminal, no
 * driver, no daemon closures, nothing registered.
 *
 * A set of records costs a constant number of statements (the rows, then one
 * read per satellite table, each one per 500 ids), never one per session.
 *
 * RESIDENT WINS. A session in the map is its own freshest answer: the volatile
 * fields (`status`, `machineId`) reach the row by a later sweep and the activity
 * counters by a periodic flush, so a row can lag the object for a moment. Until
 * the map shrinks (D2g) every resident session that does not run is ALSO read
 * as a record and compared with the map (`map-parity.ts`) once its writes have
 * settled; after the shrink a stopped session leaves the map only once they
 * have, and the comparison has nothing left to compare.
 */

export interface SessionRecordPorts {
  store: SessionStore
  /** The resident sessions: the map. */
  sessions: ReadonlyMap<SessionId, Session>
  /** True when nothing about this resident session still waits to reach its
   *  row: no write in flight, no volatile capture or activity flush pending. */
  settled(sessionId: SessionId): boolean
  /**
   * UNTIL THE MAP SHRINKS (D2g): the map holds every live session, so the map
   * alone is the exact answer to every read. With the comparison off (a
   * packaged build) the reads answer from it and run no query, which keeps
   * their cost what it was; with it on (development builds, tests) they read
   * the database as well and compare.
   */
  mapHoldsEverySession?: boolean
}

/** A session's current answer: its resident object, or its durable record. */
export type SessionSubject = Session | SessionRecord

export function isResident(subject: SessionSubject): subject is Session {
  return subject instanceof Session
}

export { isRunningStatus, subjectFacts }

/** The wire projection of either, without the per-reader joins (see `wireRecord`). */
export function subjectMeta(subject: SessionSubject): SessionMeta {
  return isResident(subject) ? subject.toMeta() : projectSessionMeta(subject, subject, subject.live)
}

/** The reads a reader needs of `SessionRecords` (a test can supply them over a map). */
export type SessionRecordReads = Pick<
  SessionRecords,
  | 'all'
  | 'issueMembers'
  | 'underPath'
  | 'onMachine'
  | 'resolve'
  | 'withIdPrefix'
  | 'birthRefCandidates'
  | 'childrenOf'
  | 'withStatuses'
>

export class SessionRecords {
  constructor(private readonly ports: SessionRecordPorts) {}

  /**
   * The durable records of these sessions, from the database only. Deleted
   * (tombstoned) sessions have none, exactly as the map never held them; an
   * unknown id is absent.
   */
  async read(sessionIds: Iterable<SessionId>): Promise<Map<SessionId, SessionRecord>> {
    const ids = [...new Set(sessionIds)]
    if (ids.length === 0) return new Map()
    const rows = await this.ports.store.sessions.getSessions(ids)
    const live = ids.flatMap((id) => {
      const row = rows.get(id)
      return row && !row.deletedAt ? [row] : []
    })
    return new Map((await this.fromRows(live)).map((record) => [record.sessionId, record]))
  }

  /**
   * Each session's current answer: the resident object when the session is in
   * the map, otherwise its durable record, in `all()`'s order. Until the map
   * shrinks, a resident session that does not run is also read as a record and
   * compared.
   */
  async resolve(sessionIds: Iterable<SessionId>, reader = 'resolve'): Promise<Map<SessionId, SessionSubject>> {
    const ids = [...new Set(sessionIds)]
    // The resident answers are taken NOW, before any await: a session that
    // leaves the map while its neighbours' records are read (its removal's own
    // handlers ask about it) is answered as it was when asked, as the map
    // answered.
    const resident = this.residentOf(ids)
    const records = this.mapOnly() ? new Map() : await this.read(ids.filter((id) => !resident.has(id)))
    await this.compareResident(ids, reader)
    const found: SessionSubject[] = []
    for (const id of ids) {
      const subject = resident.get(id) ?? records.get(id)
      if (subject) found.push(subject)
    }
    return new Map(this.listOrder(found).map((subject) => [subject.sessionId, subject]))
  }

  /**
   * Answers for rows the caller already read (a listing query), in row order:
   * the resident object where there is one, else the row's record, restored
   * with the satellites of all of them read together.
   */
  async resolveRows(rows: readonly SessionRow[], reader = 'resolveRows'): Promise<SessionSubject[]> {
    const resident = this.residentOf(rows.map((row) => row.id))
    const restored = new Map(
      (await this.fromRows(rows.filter((row) => !resident.has(row.id)))).map((record) => [
        record.sessionId,
        record,
      ]),
    )
    await this.compareResident(
      rows.map((row) => row.id),
      reader,
    )
    return rows.flatMap((row) => {
      const subject = resident.get(row.id) ?? restored.get(row.id)
      return subject ? [subject] : []
    })
  }

  // ---- SELECTIONS (POD-6160 D2b) ----
  //
  // Each answers with the resident sessions that match, as they stand, plus the
  // durable records of the matching rows that are not resident, in the boot
  // load's order (created first). The selection rule has one definition per
  // question, applied to resident objects and rows alike. Until the map shrinks,
  // the ids the database selects are compared with the ids the map selects,
  // over sessions whose writes have settled.

  /** Every live (not deleted) session. A whole-table read: the full listings
   *  (`SessionView.list`) and nothing else. */
  async all(reader: string): Promise<SessionSubject[]> {
    return await this.select(reader, null, async () => await this.ports.store.sessions.loadSessions(), () => true)
  }

  /** The member sessions of ONE issue: an explicit `issueId` wins, else cwd
   *  containment in the issue's worktree ({@link isIssueMember}). */
  async issueMembers(
    worktreePath: string | null,
    issueId: IssueId | undefined,
    reader: string,
  ): Promise<SessionSubject[]> {
    const store = this.ports.store.sessions
    const rows = async () => [
      ...(issueId ? await store.findSessionsByIssueIds([issueId]) : []),
      ...(worktreePath ? await store.sessionsUnderPath(worktreePath) : []),
    ]
    return await this.select(reader, { worktreePath, issueId }, rows, (s) =>
      isIssueMember(worktreePath, issueId, s),
    )
  }

  /** Every session whose cwd sits inside `worktreePath`, whatever issue it is
   *  attached to ({@link isMemberCwd}). */
  async underPath(worktreePath: string | null, reader: string): Promise<SessionSubject[]> {
    if (!worktreePath) return []
    return await this.select(
      reader,
      { worktreePath },
      async () => await this.ports.store.sessions.sessionsUnderPath(worktreePath),
      (s) => isMemberCwd(worktreePath, s.cwd),
    )
  }

  /** A machine's sessions. */
  async onMachine(machineId: MachineId, reader: string): Promise<SessionSubject[]> {
    return await this.select(
      reader,
      { machineId },
      async () => await this.ports.store.sessions.sessionsOnMachine(machineId),
      (s) => s.machineId === machineId,
    )
  }

  /** Sessions in one of these statuses. */
  async withStatuses(statuses: readonly Session['status'][], reader: string): Promise<SessionSubject[]> {
    const wanted = new Set(statuses)
    return await this.select(
      reader,
      { statuses: [...wanted].sort() },
      async () => await this.ports.store.sessions.sessionsWithStatuses([...wanted]),
      (s) => wanted.has(s.status),
    )
  }

  /** Sessions whose id starts with `prefix` (a short id, POD-4536). */
  async withIdPrefix(prefix: string, reader: string): Promise<SessionSubject[]> {
    if (!prefix) return []
    return await this.select(
      reader,
      { prefix },
      async () => await this.ports.store.sessions.sessionsWithIdPrefix(prefix),
      (s) => s.sessionId.startsWith(prefix),
    )
  }

  /**
   * The CANDIDATES for a birth ref: `POD-13-A` names the sessions born with
   * letter A on an issue numbered 13, `POD-DRAFT-3` the sessions with draft
   * ordinal 3. The prefix is not checked here (the caller compares the
   * formatted ref, which reads the repository's prefix).
   */
  async birthRefCandidates(
    ref: { seq: number; letter: string } | { draft: number },
    reader: string,
  ): Promise<SessionSubject[]> {
    const store = this.ports.store.sessions
    if ('draft' in ref) {
      return await this.select(reader, ref, async () => await store.sessionsOfDraft(ref.draft), (s) => s.refDraft === ref.draft)
    }
    // The map-only answer keeps the old candidate rule (the letter alone); the
    // caller's formatted-ref comparison decides either way.
    if (this.mapOnly()) {
      return [...this.ports.sessions.values()].filter((s) => s.refLetter === ref.letter)
    }
    const issueIds = new Set(await store.issueIdsWithSeq(ref.seq))
    return await this.select(
      reader,
      ref,
      async () => (issueIds.size ? await store.sessionsOfBirthLetter([...issueIds], ref.letter) : []),
      (s) => s.refLetter === ref.letter && s.refIssueId !== null && issueIds.has(s.refIssueId),
    )
  }

  /** The sessions spawned by any of these sessions (`spawnedBy` = `session:<id>`). */
  async childrenOf(parentIds: readonly SessionId[], reader: string): Promise<SessionSubject[]> {
    if (parentIds.length === 0) return []
    const values = new Set(parentIds.map((id) => `session:${id}`))
    return await this.select(
      reader,
      { parents: [...parentIds].sort() },
      async () => await this.ports.store.sessions.sessionsSpawnedBy([...values]),
      (s) => s.spawnedBy !== undefined && values.has(s.spawnedBy),
    )
  }

  private async select(
    reader: string,
    key: unknown,
    candidates: () => Promise<readonly SessionRow[]>,
    matches: (s: SelectionFields) => boolean,
  ): Promise<SessionSubject[]> {
    // Resident sessions as they stand when asked, before any await (see resolve).
    const resident = [...this.ports.sessions.values()].filter((session) => matches(session))
    if (this.mapOnly()) return resident
    const residentIds = new Set(resident.map((session) => session.sessionId))
    const rows = new Map<SessionId, SessionRow>()
    for (const row of await candidates()) if (matches(rowFields(row))) rows.set(row.id, row)
    const records = await this.fromRows([...rows.values()].filter((row) => !residentIds.has(row.id)))
    // The two id sets are comparable only while the map holds every session.
    if (this.ports.mapHoldsEverySession === true && sessionMapParityMode() !== 'off') {
      const settled = (id: SessionId) => this.ports.settled(id)
      compareWithSessionMap(
        `sessionSelection.${reader}`,
        key,
        () => resident.map((s) => s.sessionId).filter(settled).sort(),
        [...rows.keys()].filter((id) => this.ports.sessions.get(id) === undefined || settled(id)).sort(),
      )
      await this.compareResident(
        resident.map((s) => s.sessionId),
        reader,
      )
    }
    return this.listOrder([...resident, ...records])
  }

  /**
   * THE LISTING ORDER: created first, and among sessions created at the same
   * moment the resident ones in the map's order (the order the full list had
   * when it was the map), then the records.
   */
  private listOrder(subjects: SessionSubject[]): SessionSubject[] {
    const rank = new Map<SessionId, number>()
    let next = 0
    for (const id of this.ports.sessions.keys()) rank.set(id, next++)
    const rankOf = (subject: SessionSubject) => rank.get(subject.sessionId) ?? Number.MAX_SAFE_INTEGER
    return subjects.sort((a, b) => byCreation(a, b) || rankOf(a) - rankOf(b))
  }

  /** The map alone answers: it holds every session and nothing compares. */
  private mapOnly(): boolean {
    return this.ports.mapHoldsEverySession === true && sessionMapParityMode() === 'off'
  }

  /** The resident sessions among these ids, as they stand now. */
  private residentOf(ids: readonly SessionId[]): Map<SessionId, Session> {
    const out = new Map<SessionId, Session>()
    for (const id of ids) {
      const session = this.ports.sessions.get(id)
      if (session) out.set(id, session)
    }
    return out
  }

  /** Restore rows as boot does, with their satellites read in one pass. */
  async fromRows(rows: readonly SessionRow[]): Promise<SessionRecord[]> {
    if (rows.length === 0) return []
    // The boot restore's owner fallback, read once and only when a legacy row
    // has no owner.
    let fallback: UserId | undefined
    if (rows.some((row) => !row.ownerUserId)) fallback = await firstAdminMemberId(this.ports.store)
    const records: SessionRecord[] = []
    for (const row of rows) {
      const init = storedSessionInit(row, 'boot', (row.ownerUserId ?? fallback) as UserId)
      if (init) records.push(recordFromInit(init))
    }
    if (records.length === 0) return records
    const ids = records.map((record) => record.sessionId)
    const store = this.ports.store
    const [offers, draftTimes, checkpoints, transcripts, conversations] = await Promise.all([
      store.sessions.offersOf(ids),
      store.sessions.draftTimesOf(ids),
      store.observationCheckpoints.checkpointsOf(ids),
      store.events.runtimeTranscriptAvailableOf(ids),
      this.conversationIds(records),
    ])
    for (const record of records) {
      // The order of the boot load (`SessionRepository.loadFromStore`): the row
      // and its runtime transcript, then the install (offer, conversation id,
      // draft time), then the checkpoint.
      if (transcripts.has(record.sessionId)) {
        record.transcriptAvailable = true
        markConversationBound(record)
      }
      // A stale offer is cleared by the boot install; a record only reads, so
      // it reads it as absent.
      const offer = offers[record.sessionId]
      record.offer =
        offer && !(record.live.lastInputAtMs > Date.parse(offer.createdAt)) ? offer : undefined
      const resume = record.resume?.value
      record.conversationPodiumId = resume
        ? conversations.get(record.machineId)?.get(resume)
        : undefined
      const draftUpdatedAt = draftTimes.get(record.sessionId)
      if (draftUpdatedAt !== undefined) record.draftUpdatedAt = draftUpdatedAt
      const checkpoint = checkpoints.get(record.sessionId)
      if (checkpoint) applyObservationCheckpointTo(record, checkpoint)
    }
    return records
  }

  /** Podium conversation ids by machine and native id, one read per machine. */
  private async conversationIds(
    records: readonly SessionRecord[],
  ): Promise<Map<MachineId, Map<string, ConversationId>>> {
    const byMachine = new Map<MachineId, string[]>()
    for (const record of records) {
      const resume = record.resume?.value
      if (!resume) continue
      const list = byMachine.get(record.machineId) ?? []
      list.push(resume)
      byMachine.set(record.machineId, list)
    }
    const out = new Map<MachineId, Map<string, ConversationId>>()
    for (const [machineId, nativeIds] of byMachine) {
      out.set(machineId, await this.ports.store.conversations.registry.podiumIds(machineId, nativeIds))
    }
    return out
  }

  /**
   * Until the map shrinks: read the resident sessions among these that do not
   * run and whose writes have settled as records too, and compare.
   */
  private async compareResident(ids: readonly SessionId[], reader: string): Promise<void> {
    if (sessionMapParityMode() === 'off') return
    const parked = ids.filter((id) => {
      const resident = this.ports.sessions.get(id)
      return resident && !isRunningStatus(resident.status) && this.ports.settled(id)
    })
    if (parked.length === 0) return
    const records = await this.read(parked)
    for (const id of parked) {
      const resident = this.ports.sessions.get(id)
      // Moved or removed while the records were read: nothing to compare.
      if (!resident || isRunningStatus(resident.status) || !this.ports.settled(id)) continue
      const record = records.get(id)
      compareWithSessionMap(
        `sessionRecord.${reader}`,
        id,
        () => durableView(resident),
        record ? durableView(record) : undefined,
      )
    }
  }
}

/** The boot load's order: created first. */
function byCreation(a: SessionSubject, b: SessionSubject): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}

/** The fields a selection rule reads, off a resident session or a row. */
interface SelectionFields {
  sessionId: SessionId
  status: Session['status']
  issueId?: IssueId | undefined
  cwd: string
  machineId: MachineId
  spawnedBy: string | undefined
  refIssueId: IssueId | null
  refLetter: string | null
  refDraft: number | null
}

function rowFields(row: SessionRow): SelectionFields {
  return {
    sessionId: row.id,
    status: row.status,
    ...(row.issueId ? { issueId: row.issueId } : {}),
    cwd: row.cwd,
    machineId: row.machineId,
    spawnedBy: row.spawnedBy ?? undefined,
    refIssueId: row.refIssueId ?? null,
    refLetter: row.refLetter ?? null,
    refDraft: row.refDraft ?? null,
  }
}

/** What a stopped session's record must agree with the map on: its facts and
 *  its wire projection without the live plane (see `LIVE_PLANE_META_FIELDS`). */
export function durableView(subject: SessionSubject): unknown {
  const meta: Record<string, unknown> = { ...subjectMeta(subject) }
  for (const field of LIVE_PLANE_META_FIELDS) delete meta[field]
  const { busy: _busy, observedModel: _model, observedEffort: _effort, contextUsagePercent: _context, ...facts } =
    subjectFacts(subject)
  return { meta, facts }
}
