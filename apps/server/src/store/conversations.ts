/**
 * Conversations aggregate — owns the discovered-conversation index
 * (`conversations` + `conversations_fts`), the conversation registry
 * (`conversation_identities` / `conversation_segments`,
 * docs/spec/conversation-registry.md), the transcript-mirror cursors
 * (docs/spec/transcript-mirror.md) and the transcript FTS index
 * (`transcript_fts`, docs/spec/search-v1.md §2.3).
 */

import { randomUUID } from 'node:crypto'
import type { SqlDatabase } from '@podium/core/sqlite'
import type { ConversationIndexRow } from './types'

export class ConversationsRepository {
  /** FTS5 is compiled into the bundled SQLite normally; LIKE fallback if not. */
  private ftsAvailable = false
  /** transcript_fts created (docs/spec/search-v1.md §2.3). When FTS5 is missing the
   *  transcript index is skipped entirely — transcripts are too big for a LIKE
   *  fallback, and search simply omits the source. */
  private transcriptFtsAvailable = false

  constructor(private readonly db: SqlDatabase) {}

  // ---- per-boot runtime DDL (environment-conditional — NOT a schema migration) ----

  /**
   * (Re)ensure the FTS5 objects. Probed per boot because their existence
   * depends on the runtime SQLite build having FTS5 — a binary upgrade that
   * gains FTS5 picks them up without any schema-version bump.
   */
  ensureFts(): void {
    // External-content FTS over the searchable text columns. Hybrid search note:
    // keyword now; a vector column joins when an embeddings provider is configured.
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
           title, name, summary, project_path,
           content='conversations', content_rowid='rowid'
         )`,
      )
      // Triggers keep the external-content index in sync incrementally — every
      // INSERT/UPDATE/DELETE touches only the affected rowid. This replaces a
      // full 'rebuild' that previously ran on every ~15s discovery push and on
      // every metadata edit (O(all rows) each time, on the main thread).
      this.db.exec(
        `CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
           INSERT INTO conversations_fts(rowid, title, name, summary, project_path)
           VALUES (new.rowid, new.title, new.name, new.summary, new.project_path);
         END;
         CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
           INSERT INTO conversations_fts(conversations_fts, rowid, title, name, summary, project_path)
           VALUES ('delete', old.rowid, old.title, old.name, old.summary, old.project_path);
         END;
         CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
           INSERT INTO conversations_fts(conversations_fts, rowid, title, name, summary, project_path)
           VALUES ('delete', old.rowid, old.title, old.name, old.summary, old.project_path);
           INSERT INTO conversations_fts(rowid, title, name, summary, project_path)
           VALUES (new.rowid, new.title, new.name, new.summary, new.project_path);
         END;`,
      )
      // One-time heal at boot: re-tokenize so rows written before the triggers
      // existed (or any drift) are indexed. O(rows) once per process, not per write.
      this.db.exec("INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')")
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false // LIKE fallback handles search
    }
    // Transcript FTS (docs/spec/search-v1.md §2.3): one row per user/assistant
    // message, fed incrementally by the mirror-driven indexer. Contentful (not
    // external-content) — the source of truth is the lake file, and snippet()
    // needs the text stored. No LIKE fallback: without FTS5 the transcript source
    // is simply absent from search (transcripts are far too big to LIKE-scan).
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
           content, machine_id UNINDEXED, native_id UNINDEXED,
           item_uuid UNINDEXED, ts UNINDEXED
         )`,
      )
      this.transcriptFtsAvailable = true
    } catch {
      this.transcriptFtsAvailable = false
    }
  }

  /** Per-boot heal — repair rows poisoned by the pre-#94 discovery bug: a
   *  subagent transcript summarized under its PARENT's native id clobbered the
   *  parent's segment path, so reattach boot-seeded from the wrong file. A main
   *  transcript is always named <native_id>.jsonl; a subagents/ path under any
   *  OTHER name is never legitimate evidence. NULL just falls back to derivation
   *  — the next discovery scan re-fills it correctly. Idempotent. */
  repairSubagentSegmentPaths(): void {
    this.db.exec(
      "UPDATE conversation_segments SET path = NULL WHERE path LIKE '%/subagents/%' AND path NOT LIKE '%/' || native_id || '.jsonl'",
    )
  }

  // ---- conversation index ----

  /**
   * Upsert discovered conversations (daemon pushes summaries). User-set name and
   * work-LLM summary survive re-discovery — discovery never overwrites curation.
   */
  upsertConversations(rows: (ConversationIndexRow & { machineId?: string })[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO conversations
         (id, agent_kind, title, project_path, provider_id, resume_kind, resume_value,
          created_at, updated_at, message_count, machine_id, parent_conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_kind = excluded.agent_kind,
         provider_id = excluded.provider_id,
         machine_id = excluded.machine_id,
         -- COALESCE the optional columns: a later discovery push that omits a
         -- field (ConversationSummaryWire marks title/resume optional) must not
         -- null out what an earlier richer push recorded, or search stops
         -- matching and the hibernate→resume ref is lost.
         title = COALESCE(excluded.title, conversations.title),
         project_path = COALESCE(excluded.project_path, conversations.project_path),
         resume_kind = COALESCE(excluded.resume_kind, conversations.resume_kind),
         resume_value = COALESCE(excluded.resume_value, conversations.resume_value),
         created_at = COALESCE(excluded.created_at, conversations.created_at),
         updated_at = COALESCE(excluded.updated_at, conversations.updated_at),
         message_count = COALESCE(excluded.message_count, conversations.message_count),
         parent_conversation_id =
           COALESCE(excluded.parent_conversation_id, conversations.parent_conversation_id)`,
    )
    // One transaction, not N autocommits: the daemon pushes its full conversation
    // list (potentially thousands) every ~15s, and a commit-per-row turned that
    // into thousands of WAL syncs on the synchronous main thread. The FTS index
    // stays current via triggers (see ensureFts), so no rebuild here.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        stmt.run(
          r.id,
          r.agentKind,
          r.title ?? null,
          r.projectPath ?? null,
          r.providerId,
          r.resumeKind ?? null,
          r.resumeValue ?? null,
          r.createdAt ?? null,
          r.updatedAt ?? null,
          r.messageCount ?? null,
          r.machineId ?? '__local__',
          r.parentConversationId ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Drop conversations the daemon no longer sees (an incremental-discovery delta's
   * `removed` set). Transactional like {@link upsertConversations}: one BEGIN
   * IMMEDIATE / COMMIT, ROLLBACK + rethrow on error, so a mid-batch failure never
   * leaves the index half-pruned. The external-content FTS index stays consistent
   * automatically — the `conversations_ad` AFTER DELETE trigger (see ensureFts)
   * issues the FTS5 'delete' command per affected rowid, so a plain DELETE here is
   * enough; no manual FTS bookkeeping.
   */
  deleteConversations(ids: string[]): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('DELETE FROM conversations WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) stmt.run(id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Persist command-center-generated curation: a good name and/or a state summary. */
  setConversationMeta(id: string, meta: { name?: string; summary?: string }): void {
    const exists = this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)
    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO conversations (id, agent_kind, provider_id) VALUES (?, 'claude-code', 'unknown')`,
        )
        .run(id)
    }
    if (meta.name !== undefined) {
      this.db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(meta.name, id)
    }
    if (meta.summary !== undefined) {
      this.db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(meta.summary, id)
    }
    // FTS stays current via the UPDATE trigger (see ensureFts) — no rebuild.
  }

  /**
   * Keyword search over title/name/summary/path. FTS5 (bm25 + recency) where the
   * runtime has it; LIKE fallback elsewhere. `projectPath` filters to one
   * worktree/repo subtree. Empty query = recency-ordered browse.
   */
  searchConversations(opts: {
    query?: string
    projectPath?: string
    limit?: number
  }): ConversationIndexRow[] {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
    const pathFilter = opts.projectPath ? ' AND (c.project_path = ? OR c.project_path LIKE ?)' : ''
    const pathArgs = opts.projectPath ? [opts.projectPath, `${opts.projectPath}/%`] : []
    // The resume picker offers top-level sessions only — never a subagent
    // (sidechain) conversation, mirroring `claude --resume`, which lists the
    // parent conversation, not the Task subagents it spawned.
    const topLevel = ' AND c.parent_conversation_id IS NULL'
    const q = opts.query?.trim() ?? ''
    let rows: Record<string, unknown>[]
    if (!q) {
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations c WHERE 1=1${pathFilter}${topLevel}
           ORDER BY c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(...pathArgs, limit) as Record<string, unknown>[]
    } else if (this.ftsAvailable) {
      const ftsQuery = q
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"*`)
        .join(' ')
      rows = this.db
        .prepare(
          // Recency-ordered even while searching — the resume picker mirrors
          // `claude --resume`, which lists newest-active first regardless of the
          // query. FTS only narrows the set (the MATCH); it does not reorder it,
          // so a relevant-but-ancient conversation never jumps above a recent one.
          `SELECT c.* FROM conversations_fts f
           JOIN conversations c ON c.rowid = f.rowid
           WHERE conversations_fts MATCH ?${pathFilter}${topLevel}
           ORDER BY c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(ftsQuery, ...pathArgs, limit) as Record<string, unknown>[]
    } else {
      const like = `%${q}%`
      rows = this.db
        .prepare(
          `SELECT c.* FROM conversations c
           WHERE (c.title LIKE ? OR c.name LIKE ? OR c.summary LIKE ? OR c.project_path LIKE ?)${pathFilter}${topLevel}
           ORDER BY c.updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(like, like, like, like, ...pathArgs, limit) as Record<string, unknown>[]
    }
    return rows.map((r) => ({
      id: r.id as string,
      agentKind: r.agent_kind as string,
      providerId: r.provider_id as string,
      title: (r.title as string | null) ?? undefined,
      name: (r.name as string | null) ?? undefined,
      summary: (r.summary as string | null) ?? undefined,
      projectPath: (r.project_path as string | null) ?? undefined,
      resumeKind: (r.resume_kind as string | null) ?? undefined,
      resumeValue: (r.resume_value as string | null) ?? undefined,
      createdAt: (r.created_at as string | null) ?? undefined,
      updatedAt: (r.updated_at as string | null) ?? undefined,
      messageCount: (r.message_count as number | null) ?? undefined,
      machineId: (r.machine_id as string | null) ?? undefined,
    }))
  }

  /** Multi-machine adoption: rewrite placeholder '__local__' rows to the real id. */
  adoptLocalRows(machineId: string): void {
    this.db
      .prepare("UPDATE conversations SET machine_id = ? WHERE machine_id = '__local__'")
      .run(machineId)
  }

  // ---- conversation registry (docs/spec/conversation-registry.md) ----

  /** The Podium identity a native conversation maps to, or undefined if unseen. */
  conversationPodiumId(machineId: string, nativeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT podium_id FROM conversation_segments WHERE machine_id = ? AND native_id = ?')
      .get(machineId, nativeId) as { podium_id: string } | undefined
    return row?.podium_id
  }

  /** Recorded transcript-path evidence for a native conversation (absolute path on
   *  its machine), or undefined when never observed. Consumed as the read-path
   *  hint so lookups skip cwd derivation AND the bucket sweep. */
  conversationSegmentPath(machineId: string, nativeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT path FROM conversation_segments WHERE machine_id = ? AND native_id = ?')
      .get(machineId, nativeId) as { path: string | null } | undefined
    return row?.path ?? undefined
  }

  /**
   * Ensure a native conversation has an identity, minting one when it was never
   * seen (`linked_by: 'discovery'`). Idempotent: an existing segment never re-mints
   * (spec: same native id maps to the same identity forever). A parent provided
   * later fills a NULL parent_podium_id but never overwrites a non-null one —
   * mis-parenting is the failure mode to avoid.
   */
  ensureConversationIdentity(opts: {
    machineId: string
    nativeId: string
    providerId: string
    parentPodiumId?: string
    path?: string
    /** Transcript file size at scan time (discovery evidence). Persisted as
     *  `reported_bytes` so attach-time dirty reconciliation can use the LAST
     *  KNOWN size without waiting for a fresh scan (or sweeping everything). */
    sizeBytes?: number
  }): string {
    const existing = this.conversationPodiumId(opts.machineId, opts.nativeId)
    if (existing !== undefined) {
      if (opts.parentPodiumId) {
        this.db
          .prepare(
            'UPDATE conversation_identities SET parent_podium_id = ? WHERE podium_id = ? AND parent_podium_id IS NULL',
          )
          .run(opts.parentPodiumId, existing)
      }
      if (opts.path || opts.sizeBytes !== undefined) {
        // COALESCE keeps whichever evidence this call did NOT bring (a size-less
        // re-observation must not blank a previously reported size, or vice versa).
        this.db
          .prepare(
            'UPDATE conversation_segments SET path = COALESCE(?, path), reported_bytes = COALESCE(?, reported_bytes) WHERE machine_id = ? AND native_id = ?',
          )
          .run(opts.path ?? null, opts.sizeBytes ?? null, opts.machineId, opts.nativeId)
      }
      return existing
    }
    const podiumId = `conv_${randomUUID()}`
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO conversation_identities (podium_id, parent_podium_id, created_at) VALUES (?, ?, ?)',
      )
      .run(podiumId, opts.parentPodiumId ?? null, now)
    this.db
      .prepare(
        `INSERT INTO conversation_segments
           (machine_id, native_id, provider_id, podium_id, path, reported_bytes, seq_in_conv, linked_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'discovery', ?)`,
      )
      .run(
        opts.machineId,
        opts.nativeId,
        opts.providerId,
        podiumId,
        opts.path ?? null,
        opts.sizeBytes ?? null,
        now,
      )
    return podiumId
  }

  /**
   * Live-roll lineage (spec §3.1): the server observed a session's resume ref roll
   * from `priorNativeId` to `newNativeId` — attach the new native file as the NEXT
   * SEGMENT of the prior identity (minting the prior's identity if this is the
   * first time we see it). Returns the shared podium id. If the new id was already
   * linked (e.g. re-observed after a restart) this is a no-op returning its id.
   */
  linkConversationSegment(opts: {
    machineId: string
    newNativeId: string
    priorNativeId: string
    providerId: string
  }): string {
    const already = this.conversationPodiumId(opts.machineId, opts.newNativeId)
    if (already !== undefined) return already
    const podiumId = this.ensureConversationIdentity({
      machineId: opts.machineId,
      nativeId: opts.priorNativeId,
      providerId: opts.providerId,
    })
    const nextSeq =
      ((
        this.db
          .prepare('SELECT MAX(seq_in_conv) AS m FROM conversation_segments WHERE podium_id = ?')
          .get(podiumId) as { m: number | null }
      ).m ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO conversation_segments
           (machine_id, native_id, provider_id, podium_id, path, seq_in_conv, linked_by, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'live-roll', ?)`,
      )
      .run(
        opts.machineId,
        opts.newNativeId,
        opts.providerId,
        podiumId,
        nextSeq,
        new Date().toISOString(),
      )
    return podiumId
  }

  /** Batch lookup for wire enrichment: native id → podium id (per machine). */
  conversationPodiumIds(machineId: string, nativeIds: string[]): Map<string, string> {
    const out = new Map<string, string>()
    const q = this.db.prepare(
      'SELECT podium_id FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
    )
    for (const id of nativeIds) {
      const row = q.get(machineId, id) as { podium_id: string } | undefined
      if (row) out.set(id, row.podium_id)
    }
    return out
  }

  // ---- transcript mirror (docs/spec/transcript-mirror.md) ----

  /** Segments with known path evidence for one machine — the mirror work list.
   *  Cheap to call per scan: the caller diffs against in-flight state. */
  segmentsToMirror(machineId: string): { nativeId: string; path: string; mirroredBytes: number }[] {
    const rows = this.db
      .prepare(
        'SELECT native_id, path, mirrored_bytes FROM conversation_segments WHERE machine_id = ? AND path IS NOT NULL',
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nativeId: r.native_id as string,
      path: r.path as string,
      mirroredBytes: r.mirrored_bytes as number,
    }))
  }

  /** DIRTY subset of {@link segmentsToMirror} (spec §2.3 "Dirty-driven"): segments
   *  whose last daemon-reported size disagrees with the mirrored cursor, plus
   *  NULL-reported rows (pre-upgrade / providers that never report a size) which
   *  count as dirty so one mirror pass can observe their size and quiet them.
   *  This is the per-scan/attach work list — a fully-mirrored fleet returns []. */
  segmentsToMirrorDirty(
    machineId: string,
  ): { nativeId: string; path: string; mirroredBytes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT native_id, path, mirrored_bytes FROM conversation_segments
         WHERE machine_id = ? AND path IS NOT NULL
           AND (reported_bytes IS NULL OR reported_bytes != mirrored_bytes)`,
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nativeId: r.native_id as string,
      path: r.path as string,
      mirroredBytes: r.mirrored_bytes as number,
    }))
  }

  /** Record the file size the mirror OBSERVED at eof. Fresher than any scan report
   *  (the read just happened), and the convergence step for NULL-reported rows:
   *  after one successful pull, reported == mirrored and the segment goes quiet
   *  until a scan reports growth. */
  setReportedBytes(machineId: string, nativeId: string, bytes: number): void {
    this.db
      .prepare(
        'UPDATE conversation_segments SET reported_bytes = ? WHERE machine_id = ? AND native_id = ?',
      )
      .run(bytes, machineId, nativeId)
  }

  /** Last daemon-reported transcript size, or undefined when never reported. */
  reportedBytes(machineId: string, nativeId: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT reported_bytes FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
      )
      .get(machineId, nativeId) as { reported_bytes: number | null } | undefined
    return row?.reported_bytes ?? undefined
  }

  mirrorCursor(machineId: string, nativeId: string): number {
    const row = this.db
      .prepare(
        'SELECT mirrored_bytes FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
      )
      .get(machineId, nativeId) as { mirrored_bytes: number } | undefined
    return row?.mirrored_bytes ?? 0
  }

  /** Advance (or, on rewrite, reset) the mirror cursor AFTER the lake write landed
   *  (spec invariant 2 — the cursor may lag the lake, never lead it). */
  setMirrorCursor(machineId: string, nativeId: string, bytes: number, at: string): void {
    this.db
      .prepare(
        'UPDATE conversation_segments SET mirrored_bytes = ?, mirrored_at = ? WHERE machine_id = ? AND native_id = ?',
      )
      .run(bytes, at, machineId, nativeId)
  }

  // ---- transcript FTS index (docs/spec/search-v1.md §2.3) ----

  /** False when the runtime SQLite lacks FTS5 — the indexer then no-ops and search
   *  omits the transcript source (no LIKE degradation for transcript bodies). */
  get transcriptIndexAvailable(): boolean {
    return this.transcriptFtsAvailable
  }

  /** Segments whose lake copy holds bytes the FTS index hasn't consumed — the
   *  backfill work list (segmentsToMirror's shape; covers lakes mirrored before
   *  the indexer existed AND passes a budget stopped early). Cheap per trigger. */
  segmentsToIndex(
    machineId: string,
  ): { nativeId: string; mirroredBytes: number; indexedBytes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT native_id, mirrored_bytes, indexed_bytes FROM conversation_segments
         WHERE machine_id = ? AND mirrored_bytes > indexed_bytes`,
      )
      .all(machineId) as Record<string, unknown>[]
    return rows.map((r) => ({
      nativeId: r.native_id as string,
      mirroredBytes: r.mirrored_bytes as number,
      indexedBytes: r.indexed_bytes as number,
    }))
  }

  /** Bytes of the lake file already parsed into transcript_fts (≤ mirrored_bytes;
   *  the gap is the indexer's work list). */
  indexedCursor(machineId: string, nativeId: string): number {
    const row = this.db
      .prepare(
        'SELECT indexed_bytes FROM conversation_segments WHERE machine_id = ? AND native_id = ?',
      )
      .get(machineId, nativeId) as { indexed_bytes: number } | undefined
    return row?.indexed_bytes ?? 0
  }

  /** Insert extracted message rows and advance the index cursor in ONE transaction —
   *  a crash can never leave rows indexed without the cursor (double-index on retry)
   *  or the cursor advanced without the rows (a silent gap). */
  appendTranscriptIndex(
    machineId: string,
    nativeId: string,
    rows: { content: string; itemUuid?: string; ts?: string }[],
    indexedBytes: number,
  ): void {
    if (!this.transcriptFtsAvailable) return
    const insert = this.db.prepare(
      'INSERT INTO transcript_fts (content, machine_id, native_id, item_uuid, ts) VALUES (?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        insert.run(r.content, machineId, nativeId, r.itemUuid ?? null, r.ts ?? null)
      }
      this.db
        .prepare(
          'UPDATE conversation_segments SET indexed_bytes = ? WHERE machine_id = ? AND native_id = ?',
        )
        .run(indexedBytes, machineId, nativeId)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** One segment's indexed rows in insertion (= transcript) order — a diagnostic /
   *  test seam; search goes through the MATCH path, never this scan. */
  transcriptIndexRows(
    machineId: string,
    nativeId: string,
  ): { content: string; itemUuid?: string; ts?: string }[] {
    if (!this.transcriptFtsAvailable) return []
    const rows = this.db
      .prepare(
        'SELECT content, item_uuid, ts FROM transcript_fts WHERE machine_id = ? AND native_id = ? ORDER BY rowid ASC',
      )
      .all(machineId, nativeId) as Record<string, unknown>[]
    return rows.map((r) => ({
      content: r.content as string,
      itemUuid: (r.item_uuid as string | null) ?? undefined,
      ts: (r.ts as string | null) ?? undefined,
    }))
  }

  /** BM25-ranked matches over the transcript index, one row per matched message,
   *  with a snippet() (matches wrapped in `**`) and the joins the search service
   *  needs: segments → podium id, conversations → display title + recency. `rank`
   *  is raw SQLite bm25 — smaller (more negative) = better; the caller normalizes.
   *  Empty when FTS5 is unavailable (the transcript source just goes dark). */
  searchTranscripts(
    query: string,
    limit = 30,
  ): {
    machineId: string
    nativeId: string
    itemUuid?: string
    ts?: string
    snippet: string
    rank: number
    podiumId?: string
    title?: string
    updatedAt?: string
  }[] {
    const q = query.trim()
    if (!q || !this.transcriptFtsAvailable) return []
    const ftsQuery = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ')
    const rows = this.db
      .prepare(
        `SELECT f.machine_id, f.native_id, f.item_uuid, f.ts,
                snippet(transcript_fts, 0, '**', '**', '…', 12) AS snip,
                bm25(transcript_fts) AS rank,
                s.podium_id, c.title, c.name, c.updated_at
         FROM transcript_fts f
         LEFT JOIN conversation_segments s
           ON s.machine_id = f.machine_id AND s.native_id = f.native_id
         LEFT JOIN conversations c ON c.id = f.native_id
         WHERE transcript_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, Math.min(200, Math.max(1, limit))) as Record<string, unknown>[]
    return rows.map((r) => ({
      machineId: r.machine_id as string,
      nativeId: r.native_id as string,
      itemUuid: (r.item_uuid as string | null) ?? undefined,
      ts: (r.ts as string | null) ?? undefined,
      snippet: r.snip as string,
      rank: r.rank as number,
      podiumId: (r.podium_id as string | null) ?? undefined,
      // User-set name wins over the harness title, matching every other surface.
      title: (r.name as string | null) ?? (r.title as string | null) ?? undefined,
      updatedAt: (r.updated_at as string | null) ?? undefined,
    }))
  }

  /** Re-mirror (truncate) invalidates the segment's indexed content: drop its FTS
   *  rows and reset the cursor so the reindex starts from byte 0 as chunks arrive. */
  dropTranscriptIndex(machineId: string, nativeId: string): void {
    if (this.transcriptFtsAvailable) {
      this.db
        .prepare('DELETE FROM transcript_fts WHERE machine_id = ? AND native_id = ?')
        .run(machineId, nativeId)
    }
    this.db
      .prepare(
        'UPDATE conversation_segments SET indexed_bytes = 0 WHERE machine_id = ? AND native_id = ?',
      )
      .run(machineId, nativeId)
  }
}
