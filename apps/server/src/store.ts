/**
 * Durable server-side store. Single writer (the server).
 *
 * SessionStore is a thin FACADE over the per-aggregate repositories in
 * `./store/` — it opens the database, runs the versioned migration chain
 * (src/migrations/), sequences the per-boot idempotent heals, and delegates
 * every call. The public API is stable by design: callers (relay, issues,
 * router, …) depend on this class, never on individual repositories.
 *
 * Aggregate map:
 *  - sessions (+ pins/snoozes/tab_order/session_drafts) → store/sessions.ts
 *  - issues (+ labels/deps/comments/mail)               → store/issues.ts
 *  - conversations (index/FTS/registry/mirror/transcript index)
 *                                                        → store/conversations.ts
 *  - sync (changes/applied_mutations/queued_messages/upstream_outbox)
 *                                                        → store/sync.ts
 *  - auth (client_sessions)                              → store/auth.ts
 *  - superagent (threads/messages)                       → store/superagent.ts
 *  - settings/meta                                       → store/settings.ts
 *  - repos                                               → store/repos.ts
 *  - machines                                            → store/machines.ts
 *  - events/steward (podium_events/steward_state/subscriptions)
 *                                                        → store/events.ts
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PodiumSettings } from '@podium/core'
import { openDatabase, type SqlDatabase } from '@podium/core/sqlite'
import { MIGRATIONS, runMigrations } from './migrations/index'
import { AuthRepository } from './store/auth'
import { ConversationsRepository } from './store/conversations'
import { EventsRepository } from './store/events'
import { IssuesRepository } from './store/issues'
import { MachinesRepository } from './store/machines'
import { normalizeRepoPath, ReposRepository } from './store/repos'
import { SessionsRepository } from './store/sessions'
import { SettingsRepository } from './store/settings'
import { SuperagentRepository } from './store/superagent'
import { SyncRepository } from './store/sync'
import type {
  ConversationIndexRow,
  IssueCommentRow,
  IssueMessageRow,
  IssueRow,
  PinKind,
  PinState,
  SessionRow,
  SnoozeMap,
  Subscription,
  SuperagentMessageRow,
  SuperagentThreadRow,
} from './store/types'

export * from './store/types'
export { normalizeRepoPath }

/** Default DB file: $PODIUM_STATE_DIR/podium.db, else ~/.podium/podium.db. */
export function defaultDbPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'podium.db')
}

export class SessionStore {
  private readonly db: SqlDatabase
  private readonly reposRepo: ReposRepository
  private readonly sessionsRepo: SessionsRepository
  private readonly issuesRepo: IssuesRepository
  private readonly conversationsRepo: ConversationsRepository
  private readonly syncRepo: SyncRepository
  private readonly authRepo: AuthRepository
  private readonly superagentRepo: SuperagentRepository
  private readonly settingsRepo: SettingsRepository
  private readonly machinesRepo: MachinesRepository
  private readonly eventsRepo: EventsRepository

  constructor(private readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // The versioned migration chain owns the schema (stamps schema_version and
    // refuses to open a DB newer than the code). Schema DDL lives ONLY in
    // src/migrations/.
    runMigrations(this.db, MIGRATIONS)
    // Foreign-key enforcement is PER-CONNECTION in SQLite and deliberately
    // enabled only AFTER the migration chain: table rebuilds (the standard
    // 12-step ALTER, e.g. migration 006) must run without FK enforcement, and
    // a PRAGMA inside the runner's transaction would be a no-op anyway.
    this.db.exec('PRAGMA foreign_keys = ON')

    // Compose the per-aggregate repositories. The two cross-aggregate edges are
    // injected as late-bound lambdas: issues resolve their stable repo_id via
    // the repos aggregate, and a repo-identity upgrade dual-writes onto issues.
    this.sessionsRepo = new SessionsRepository(this.db)
    this.issuesRepo = new IssuesRepository(this.db, (repoPath) =>
      this.reposRepo.resolveRepoIdForPath(repoPath),
    )
    this.reposRepo = new ReposRepository(this.db, (repoId, repoPath) =>
      this.issuesRepo.assignRepoIdToIssuesUnder(repoId, repoPath),
    )
    this.conversationsRepo = new ConversationsRepository(this.db)
    this.syncRepo = new SyncRepository(this.db)
    this.authRepo = new AuthRepository(this.db)
    this.superagentRepo = new SuperagentRepository(this.db)
    this.settingsRepo = new SettingsRepository(this.db)
    this.machinesRepo = new MachinesRepository(this.db)
    this.eventsRepo = new EventsRepository(this.db)

    // Per-boot, idempotent runtime steps (environment-conditional FTS objects
    // and data heals) — never schema DDL.
    this.conversationsRepo.ensureFts()
    this.conversationsRepo.repairSubagentSegmentPaths()
    this.superagentRepo.seedGlobalThread()
    this.reposRepo.importReposJson(this.path)
    this.backfillRepoIds()
    // #140 defense in depth (ported from main's boot migrate): renumber any
    // (repo_id, seq) collisions left by a pre-UNIQUE-index database. Idempotent --
    // no-ops once the DB is clean; runs AFTER the backfill so rows have repo_ids.
    this.renumberCollidingIssueSeqs()
  }

  /** Per-boot heal (idempotent): fill NULL repo_ids on repos and issues, then
   *  self-heal origins for locally readable repos (v8 backfill, #74). */
  private backfillRepoIds(): void {
    this.reposRepo.backfillRepoIds()
    this.issuesRepo.backfillNullRepoIds()
    this.reposRepo.healLocalOrigins()
  }

  close(): void {
    this.db.close()
  }

  // ---- repos ----

  listRepos(machineId?: string) {
    return this.reposRepo.listRepos(machineId)
  }

  /** Back-compat: flat list of paths across all machines. RepoRegistry.list() uses this. */
  listRepoPaths(machineId?: string): string[] {
    return this.listRepos(machineId).map((r) => r.path)
  }

  addRepo(path: string, machineId?: string, originUrl?: string): void {
    this.reposRepo.addRepo(path, machineId, originUrl)
  }

  updateRepoOrigin(machineId: string, path: string, originUrl: string): void {
    this.reposRepo.updateRepoOrigin(machineId, path, originUrl)
  }

  resolveRepoIdForPath(repoPath: string): string {
    return this.reposRepo.resolveRepoIdForPath(repoPath)
  }

  removeRepo(path: string, machineId?: string): void {
    this.reposRepo.removeRepo(path, machineId)
  }

  // ---- pins ----

  listPins(): PinState {
    return this.sessionsRepo.listPins()
  }

  setPin(kind: PinKind, id: string, pinned: boolean): void {
    this.sessionsRepo.setPin(kind, id, pinned)
  }

  // ---- snoozes ----

  listSnoozes(now?: number): SnoozeMap {
    return this.sessionsRepo.listSnoozes(now)
  }

  setSnooze(sessionId: string, until: string | null): void {
    this.sessionsRepo.setSnooze(sessionId, until)
  }

  clearSnooze(sessionId: string): void {
    this.sessionsRepo.clearSnooze(sessionId)
  }

  // ---- tab order ----

  listTabOrders(): Record<string, string[]> {
    return this.sessionsRepo.listTabOrders()
  }

  setTabOrder(worktree: string, sessionIds: string[]): void {
    this.sessionsRepo.setTabOrder(worktree, sessionIds)
  }

  // ---- sessions ----

  loadSessions(): SessionRow[] {
    return this.sessionsRepo.loadSessions()
  }

  upsertSession(row: SessionRow): void {
    this.sessionsRepo.upsertSession(row)
  }

  deleteSession(id: string): void {
    this.sessionsRepo.deleteSession(id)
  }

  // ---- composer drafts ----

  loadDrafts(): Record<string, string> {
    return this.sessionsRepo.loadDrafts()
  }

  loadDraftTimes(): Record<string, string> {
    return this.sessionsRepo.loadDraftTimes()
  }

  setDraft(sessionId: string, text: string): string | undefined {
    return this.sessionsRepo.setDraft(sessionId, text)
  }

  // ---- settings / meta ----

  getSettings(): PodiumSettings {
    return this.settingsRepo.getSettings()
  }

  setSettings(settings: PodiumSettings): void {
    this.settingsRepo.setSettings(settings)
  }

  getModelCatalog() {
    return this.settingsRepo.getModelCatalog()
  }

  setModelCatalog(snapshot: {
    byAgent: Record<string, unknown>
    fetchedAt: number
    version?: number
  }): void {
    this.settingsRepo.setModelCatalog(snapshot)
  }

  // ---- node⇄hub upstream sync (docs/spec/node-hub-sync.md) ----

  getUpstreamCursor(): number | null {
    return this.settingsRepo.getUpstreamCursor()
  }

  setUpstreamCursor(cursor: number): void {
    this.settingsRepo.setUpstreamCursor(cursor)
  }

  setUpstreamIssuesJson(json: string): void {
    this.settingsRepo.setUpstreamIssuesJson(json)
  }

  getUpstreamIssuesJson(): string | null {
    return this.settingsRepo.getUpstreamIssuesJson()
  }

  setUpstreamSessionsJson(json: string): void {
    this.settingsRepo.setUpstreamSessionsJson(json)
  }

  getUpstreamSessionsJson(): string | null {
    return this.settingsRepo.getUpstreamSessionsJson()
  }

  setUpstreamConversationsJson(json: string): void {
    this.settingsRepo.setUpstreamConversationsJson(json)
  }

  getUpstreamConversationsJson(): string | null {
    return this.settingsRepo.getUpstreamConversationsJson()
  }

  // ---- client (human UI) login sessions ----

  createClientSession(tokenHash: string, expiresAt: string): void {
    this.authRepo.createClientSession(tokenHash, expiresAt)
  }

  getClientSession(tokenHash: string): { expiresAt: string } | undefined {
    return this.authRepo.getClientSession(tokenHash)
  }

  extendClientSession(tokenHash: string, expiresAt: string): void {
    this.authRepo.extendClientSession(tokenHash, expiresAt)
  }

  isClientSessionValid(tokenHash: string, nowIso: string): boolean {
    return this.authRepo.isClientSessionValid(tokenHash, nowIso)
  }

  deleteClientSession(tokenHash: string): void {
    this.authRepo.deleteClientSession(tokenHash)
  }

  deleteAllClientSessions(): void {
    this.authRepo.deleteAllClientSessions()
  }

  deleteExpiredClientSessions(nowIso: string): void {
    this.authRepo.deleteExpiredClientSessions(nowIso)
  }

  // ---- conversation index ----

  upsertConversations(rows: (ConversationIndexRow & { machineId?: string })[]): void {
    this.conversationsRepo.upsertConversations(rows)
  }

  deleteConversations(ids: string[]): void {
    this.conversationsRepo.deleteConversations(ids)
  }

  setConversationMeta(id: string, meta: { name?: string; summary?: string }): void {
    this.conversationsRepo.setConversationMeta(id, meta)
  }

  searchConversations(opts: {
    query?: string
    projectPath?: string
    limit?: number
  }): ConversationIndexRow[] {
    return this.conversationsRepo.searchConversations(opts)
  }

  // ---- superagent threads ----

  loadSuperagentMessages(threadId?: string, limit?: number): SuperagentMessageRow[] {
    return this.superagentRepo.loadSuperagentMessages(threadId, limit)
  }

  appendSuperagentMessage(
    threadId: string,
    m: Omit<SuperagentMessageRow, 'id' | 'createdAt'>,
  ): SuperagentMessageRow {
    return this.superagentRepo.appendSuperagentMessage(threadId, m)
  }

  clearSuperagentMessages(threadId?: string): void {
    this.superagentRepo.clearSuperagentMessages(threadId)
  }

  listSuperagentThreads(): SuperagentThreadRow[] {
    return this.superagentRepo.listSuperagentThreads()
  }

  getSuperagentThread(id: string): SuperagentThreadRow | undefined {
    return this.superagentRepo.getSuperagentThread(id)
  }

  upsertSuperagentThread(t: {
    id: string
    kind: 'global' | 'btw' | 'concierge'
    originSessionId?: string
    repoPath?: string
    title?: string
  }): void {
    this.superagentRepo.upsertSuperagentThread(t)
  }

  setThreadWatermark(id: string, itemId: string, ts: string | undefined): void {
    this.superagentRepo.setThreadWatermark(id, itemId, ts)
  }

  updateSuperagentThreadBinding(
    id: string,
    patch: {
      agentKind?: string
      // null clears the binding — forces a fresh session on a harness switch (#199).
      podiumSessionId?: string | null
      harnessSessionId?: string | null
      terminalSessionId?: string | null
    },
  ): void {
    this.superagentRepo.updateSuperagentThreadBinding(id, patch)
  }

  archiveSuperagentThread(id: string): void {
    this.superagentRepo.archiveSuperagentThread(id)
  }

  // ---- machines ----

  upsertMachine(m: { id: string; name: string; hostname: string; tokenHash: string }): void {
    this.machinesRepo.upsertMachine(m)
  }

  listMachines() {
    return this.machinesRepo.listMachines()
  }

  getMachine(id: string) {
    return this.machinesRepo.getMachine(id)
  }

  getMachineByToken(id: string, token: string): boolean {
    return this.machinesRepo.getMachineByToken(id, token)
  }

  renameMachine(id: string, name: string): void {
    this.machinesRepo.renameMachine(id, name)
  }

  deleteMachine(id: string): void {
    this.machinesRepo.deleteMachine(id)
  }

  touchMachine(id: string, hostname: string): void {
    this.machinesRepo.touchMachine(id, hostname)
  }

  /**
   * Rewrite all rows carrying the placeholder `'__local__'` machine_id to the
   * real machineId. Idempotent: re-running after adoption is a no-op (no rows
   * will match `__local__` any more).
   */
  adoptLocalRows(machineId: string): void {
    this.sessionsRepo.adoptLocalRows(machineId)
    this.reposRepo.adoptLocalRows(machineId)
    this.conversationsRepo.adoptLocalRows(machineId)
  }

  // ---- issues ----

  upsertIssue(row: IssueRow): void {
    this.issuesRepo.upsertIssue(row)
  }

  getIssue(id: string): IssueRow | null {
    return this.issuesRepo.getIssue(id)
  }

  listIssueRows(repoPath?: string): IssueRow[] {
    return this.issuesRepo.listIssueRows(repoPath)
  }

  deleteIssue(id: string): void {
    this.issuesRepo.deleteIssue(id)
  }

  setIssueLabels(issueId: string, labels: string[]): void {
    this.issuesRepo.setIssueLabels(issueId, labels)
  }

  getIssueLabels(issueId: string): string[] {
    return this.issuesRepo.getIssueLabels(issueId)
  }

  listAllLabels(): string[] {
    return this.issuesRepo.listAllLabels()
  }

  addIssueDep(fromId: string, toId: string, type?: string): void {
    this.issuesRepo.addIssueDep(fromId, toId, type)
  }

  removeIssueDep(fromId: string, toId: string, type?: string): void {
    this.issuesRepo.removeIssueDep(fromId, toId, type)
  }

  listIssueDeps(fromId: string): { toId: string; type: string }[] {
    return this.issuesRepo.listIssueDeps(fromId)
  }

  listDependents(toId: string): { fromId: string; type: string }[] {
    return this.issuesRepo.listDependents(toId)
  }

  addIssueComment(c: IssueCommentRow): void {
    this.issuesRepo.addIssueComment(c)
  }

  listIssueComments(issueId: string): IssueCommentRow[] {
    return this.issuesRepo.listIssueComments(issueId)
  }

  countIssueComments(issueId: string): number {
    return this.issuesRepo.countIssueComments(issueId)
  }

  countIssueCommentsByIssue(): Map<string, number> {
    return this.issuesRepo.countIssueCommentsByIssue()
  }

  searchIssueComments(query: string, limit?: number) {
    return this.issuesRepo.searchIssueComments(query, limit)
  }

  // ---- issue mail (issue #103) ----

  addIssueMessage(m: IssueMessageRow): void {
    this.issuesRepo.addIssueMessage(m)
  }

  getIssueMessage(id: string): IssueMessageRow | null {
    return this.issuesRepo.getIssueMessage(id)
  }

  listIssueMessages(
    issueId: string,
    opts?: { status?: IssueMessageRow['status'] },
  ): IssueMessageRow[] {
    return this.issuesRepo.listIssueMessages(issueId, opts)
  }

  countUnreadIssueMessages(issueId: string): number {
    return this.issuesRepo.countUnreadIssueMessages(issueId)
  }

  markIssueMessagesRead(issueId: string, ids: string[], readAt: string): void {
    this.issuesRepo.markIssueMessagesRead(issueId, ids, readAt)
  }

  claimIssueMessage(id: string, claimedBy: string, claimedAt: string): boolean {
    return this.issuesRepo.claimIssueMessage(id, claimedBy, claimedAt)
  }

  deleteIssueMessagesForIssue(issueId: string): void {
    this.issuesRepo.deleteIssueMessagesForIssue(issueId)
  }

  deleteIssueChildRows(issueId: string): void {
    this.issuesRepo.deleteIssueChildRows(issueId)
  }

  /** Next `#N` for a repo, scoped by the stable `repo_id` (not `repo_path`) so every
   *  checkout of one origin shares a single seq sequence — two machines with different
   *  paths can no longer mint colliding numbers (#140). Callers resolve the path to a
   *  repo_id via {@link resolveRepoIdForPath} before allocating. */
  nextIssueSeq(repoId: string): number {
    return this.issuesRepo.nextIssueSeq(repoId)
  }

  /** #140 heal: renumber (repo_id, seq) collisions; returns rows renumbered. */
  renumberCollidingIssueSeqs(): number {
    return this.issuesRepo.renumberCollidingIssueSeqs()
  }

  // ---- event log / steward / subscriptions ----

  appendEvent(e: {
    ts: string
    kind: string
    subject: string
    repoPath?: string | null
    payload?: unknown
  }): number {
    return this.eventsRepo.appendEvent(e)
  }

  listEventsSince(sinceId: number, opts?: { kinds?: string[]; repoPath?: string; limit?: number }) {
    return this.eventsRepo.listEventsSince(sinceId, opts)
  }

  maxEventId(): number {
    return this.eventsRepo.maxEventId()
  }

  pruneEvents(opts: { maxAgeDays: number; maxRows: number }): number {
    return this.eventsRepo.pruneEvents(opts)
  }

  getStewardState(key: string): string | undefined {
    return this.eventsRepo.getStewardState(key)
  }

  setStewardState(key: string, value: string): void {
    this.eventsRepo.setStewardState(key, value)
  }

  addSubscription(sub: Subscription): void {
    this.eventsRepo.addSubscription(sub)
  }

  removeSubscription(id: string): void {
    this.eventsRepo.removeSubscription(id)
  }

  listSubscriptions(filter?: { subscriberId?: string }): Subscription[] {
    return this.eventsRepo.listSubscriptions(filter)
  }

  listEnabledSubscriptions(): Subscription[] {
    return this.eventsRepo.listEnabledSubscriptions()
  }

  /** Flip a subscription's enabled flag. Returns true when a row was updated. */
  setSubscriptionEnabled(id: string, enabled: boolean): boolean {
    return this.eventsRepo.setSubscriptionEnabled(id, enabled)
  }

  getSubscription(id: string): Subscription | undefined {
    return this.eventsRepo.getSubscription(id)
  }

  /** Record a (subscription, event) delivery. Returns true only when the pair was
   *  NEWLY inserted — a replay (or a same-poll double-match) returns false so the
   *  steward delivers exactly once. */
  markDelivered(subscriptionId: string, eventId: number): boolean {
    return this.eventsRepo.markDelivered(subscriptionId, eventId)
  }

  // ---- metadata oplog (docs/spec/oplog-read-path.md) ----

  appendChanges(
    rows: { entity: string; entityId: string; op: 'upsert' | 'remove'; payload: string | null }[],
    eventTime: number,
  ): number[] {
    return this.syncRepo.appendChanges(rows, eventTime)
  }

  maxChangeSeq(): number {
    return this.syncRepo.maxChangeSeq()
  }

  minChangeSeq(): number | null {
    return this.syncRepo.minChangeSeq()
  }

  changesSince(cursor: number, limit?: number) {
    return this.syncRepo.changesSince(cursor, limit)
  }

  pruneChanges(opts: { keepRows: number; maxAgeMs: number; now: number }): void {
    this.syncRepo.pruneChanges(opts)
  }

  latestChangeStates() {
    return this.syncRepo.latestChangeStates()
  }

  // ---- outbox write path (docs/spec/outbox-write-path.md) ----

  getAppliedMutation(mutationId: string): string | undefined {
    return this.syncRepo.getAppliedMutation(mutationId)
  }

  recordAppliedMutation(mutationId: string, proc: string, result: string, appliedAt: number): void {
    this.syncRepo.recordAppliedMutation(mutationId, proc, result, appliedAt)
  }

  pruneAppliedMutations(opts: { maxAgeMs: number; now: number }): void {
    this.syncRepo.pruneAppliedMutations(opts)
  }

  enqueueMessage(row: { id: string; sessionId: string; text: string; queuedAt: number }): boolean {
    return this.syncRepo.enqueueMessage(row)
  }

  listQueuedMessages(sessionId: string): { id: string; text: string; attempts: number }[] {
    return this.syncRepo.listQueuedMessages(sessionId)
  }

  queuedMessageCounts(): Map<string, number> {
    return this.syncRepo.queuedMessageCounts()
  }

  deleteQueuedMessage(id: string): void {
    this.syncRepo.deleteQueuedMessage(id)
  }

  bumpQueuedAttempts(id: string): void {
    this.syncRepo.bumpQueuedAttempts(id)
  }

  deleteQueuedMessagesForSession(sessionId: string): void {
    this.syncRepo.deleteQueuedMessagesForSession(sessionId)
  }

  // ---- upstream issue-write outbox (docs/spec/node-hub-issues.md §2.2) ----

  enqueueUpstreamMutation(row: {
    mutationId: string
    proc: string
    input: string
    queuedAt: number
  }): boolean {
    return this.syncRepo.enqueueUpstreamMutation(row)
  }

  listUpstreamOutbox() {
    return this.syncRepo.listUpstreamOutbox()
  }

  deleteUpstreamMutation(mutationId: string): void {
    this.syncRepo.deleteUpstreamMutation(mutationId)
  }

  bumpUpstreamMutationAttempts(mutationId: string): void {
    this.syncRepo.bumpUpstreamMutationAttempts(mutationId)
  }

  // ---- conversation registry (docs/spec/conversation-registry.md) ----

  conversationPodiumId(machineId: string, nativeId: string): string | undefined {
    return this.conversationsRepo.conversationPodiumId(machineId, nativeId)
  }

  conversationSegmentPath(machineId: string, nativeId: string): string | undefined {
    return this.conversationsRepo.conversationSegmentPath(machineId, nativeId)
  }

  ensureConversationIdentity(opts: {
    machineId: string
    nativeId: string
    providerId: string
    parentPodiumId?: string
    path?: string
    sizeBytes?: number
  }): string {
    return this.conversationsRepo.ensureConversationIdentity(opts)
  }

  linkConversationSegment(opts: {
    machineId: string
    newNativeId: string
    priorNativeId: string
    providerId: string
  }): string {
    return this.conversationsRepo.linkConversationSegment(opts)
  }

  /** Batch lookup for wire enrichment: native id → podium id (per machine). */
  conversationPodiumIds(machineId: string, nativeIds: string[]): Map<string, string> {
    return this.conversationsRepo.conversationPodiumIds(machineId, nativeIds)
  }

  // ---- transcript mirror (docs/spec/transcript-mirror.md) ----

  segmentsToMirror(machineId: string) {
    return this.conversationsRepo.segmentsToMirror(machineId)
  }

  segmentsToMirrorDirty(machineId: string) {
    return this.conversationsRepo.segmentsToMirrorDirty(machineId)
  }

  setReportedBytes(machineId: string, nativeId: string, bytes: number): void {
    this.conversationsRepo.setReportedBytes(machineId, nativeId, bytes)
  }

  reportedBytes(machineId: string, nativeId: string): number | undefined {
    return this.conversationsRepo.reportedBytes(machineId, nativeId)
  }

  mirrorCursor(machineId: string, nativeId: string): number {
    return this.conversationsRepo.mirrorCursor(machineId, nativeId)
  }

  setMirrorCursor(machineId: string, nativeId: string, bytes: number, at: string): void {
    this.conversationsRepo.setMirrorCursor(machineId, nativeId, bytes, at)
  }

  // ---- transcript FTS index (docs/spec/search-v1.md §2.3) ----

  get transcriptIndexAvailable(): boolean {
    return this.conversationsRepo.transcriptIndexAvailable
  }

  segmentsToIndex(machineId: string) {
    return this.conversationsRepo.segmentsToIndex(machineId)
  }

  indexedCursor(machineId: string, nativeId: string): number {
    return this.conversationsRepo.indexedCursor(machineId, nativeId)
  }

  appendTranscriptIndex(
    machineId: string,
    nativeId: string,
    rows: { content: string; itemUuid?: string; ts?: string }[],
    indexedBytes: number,
  ): void {
    this.conversationsRepo.appendTranscriptIndex(machineId, nativeId, rows, indexedBytes)
  }

  transcriptIndexRows(machineId: string, nativeId: string) {
    return this.conversationsRepo.transcriptIndexRows(machineId, nativeId)
  }

  searchTranscripts(query: string, limit?: number) {
    return this.conversationsRepo.searchTranscripts(query, limit)
  }

  dropTranscriptIndex(machineId: string, nativeId: string): void {
    this.conversationsRepo.dropTranscriptIndex(machineId, nativeId)
  }
}
