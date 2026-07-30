/**
 * Podium's server schema as drizzle-kit schema-as-code [spec:SP-4428] — the
 * source of truth for `drizzle-kit generate`/`check`. Edit this, then
 * `bun run migration:new <name>` to author a migration.
 *
 * NOT declared here, by design:
 *  - `schema_version` — the legacy runner's ledger, which only lingers on a
 *    pre-drizzle database until the boot bridge stamps it (index.ts); and
 *    `__drizzle_migrations` — drizzle's own ledger. Both are excluded via
 *    `tablesFilter` in drizzle.config.ts.
 *  - the FTS5 virtual tables + their shadow tables + the conversations_a*
 *    triggers — created per-boot by the conversations repository, because their
 *    existence is conditional on the runtime SQLite build (never `push`).
 *
 * This is a drizzle-orm import used ONLY for authoring (a devDependency);
 * runtime code never imports drizzle-orm — the applier is drizzle-runner.ts.
 */
import { sqliteTable, foreignKey, type AnySQLiteColumn, primaryKey, index, uniqueIndex, unique, check, text, integer } from "drizzle-orm/sqlite-core"
import { sql, desc } from "drizzle-orm"

export const sessions = sqliteTable("sessions", {
	id: text().primaryKey(),
	agentKind: text("agent_kind").notNull(),
	// Resolved launch placement, captured once at spawn [spec:SP-dae6].
	model: text(),
	effort: text(),
	accountId: text("account_id"),
	cwd: text().notNull(),
	title: text().notNull(),
	originKind: text("origin_kind").notNull(),
	conversationId: text("conversation_id"),
	resumeKind: text("resume_kind"),
	resumeValue: text("resume_value"),
	status: text().notNull(),
	exitCode: integer("exit_code"),
	spawnFailure: text("spawn_failure"),
	durableLabel: text("durable_label").notNull(),
	createdAt: text("created_at").notNull(),
	lastActiveAt: text("last_active_at").notNull(),
	name: text(),
	archived: integer().default(0).notNull(),
	workState: text("work_state"),
	machineId: text("machine_id").default("__local__").notNull(),
	lastOutputAt: text("last_output_at"),
	lastInputAt: text("last_input_at"),
	lastResumedAt: text("last_resumed_at"),
	spawnedBy: text("spawned_by"),
	headless: integer().default(0).notNull(),
	issueId: text("issue_id"),
	stoppedAt: text("stopped_at"),
	stopReason: text("stop_reason"),
	deletedAt: text("deleted_at"),
	deletedByIssueId: text("deleted_by_issue_id"),
	deletionSource: text("deletion_source"),
	workflowRunId: text("workflow_run_id"),
	workflowStepId: text("workflow_step_id"),
	executionProfileId: text("execution_profile_id"),
	nameSource: text("name_source"),
	refIssueId: text("ref_issue_id"),
	refLetter: text("ref_letter"),
	refDraft: integer("ref_draft"),
	terminalCols: integer("terminal_cols").notNull().default(80),
	terminalRows: integer("terminal_rows").notNull().default(24),
	workingMsTotal: integer("working_ms_total"),
	inputCount: integer("input_count").notNull().default(0),
	outputCount: integer("output_count").notNull().default(0),
	activityCount: integer("activity_count").notNull().default(0),
},
(table) => [index("idx_sessions_deleted_by_issue").on(table.deletedByIssueId),
index("idx_sessions_deleted_at").on(table.deletedAt),
check("sessions_stop_reason_check", sql`stop_reason IS NULL OR stop_reason IN ('self', 'parent', 'forced', 'exited')`),
]);

export const sessionObservationCheckpoints = sqliteTable("session_observation_checkpoints", {
	sessionId: text("session_id").primaryKey(),
	schemaVersion: integer("schema_version").default(1).notNull(),
	provider: text().notNull(),
	providerSessionId: text("provider_session_id"),
	bindingVersion: integer("binding_version").default(0).notNull(),
	observationGeneration: integer("observation_generation").default(0).notNull(),
	checkpointJson: text("checkpoint_json", {"mode":"json"}),
	updatedAt: text("updated_at").notNull(),
});

export const sessionObservationRebinds = sqliteTable("session_observation_rebinds", {
	sessionId: text("session_id").primaryKey().references(() => sessionObservationCheckpoints.sessionId, { onDelete: "cascade" }),
	provider: text().notNull(),
	fromProviderSessionId: text("from_provider_session_id"),
	fromBindingVersion: integer("from_binding_version").notNull(),
	fromObservationGeneration: integer("from_observation_generation").notNull(),
	toProviderSessionId: text("to_provider_session_id").notNull(),
	resultingBindingVersion: integer("resulting_binding_version").notNull(),
	resultingObservationGeneration: integer("resulting_observation_generation").notNull(),
	updatedAt: text("updated_at").notNull(),
});

export const sessionTerminalCandidates = sqliteTable("session_terminal_candidates", {
	sessionId: text("session_id").primaryKey().references(() => sessionObservationCheckpoints.sessionId, { onDelete: "cascade" }),
	proofJson: text("proof_json", { mode: "json" }).notNull(),
	confirmedAt: text("confirmed_at"),
	consumedAt: text("consumed_at"),
	updatedAt: text("updated_at").notNull(),
});

export const meta = sqliteTable("meta", {
	key: text().primaryKey(),
	value: text().notNull(),
});

// Human-facing ids (#474): stable presentable refs on top of internal ids.
export const repoPrefixes = sqliteTable("repo_prefixes", {
	repoId: text("repo_id").primaryKey(),
	prefix: text().notNull().unique(),
});

export const issueRefLetters = sqliteTable("issue_ref_letters", {
	issueId: text("issue_id").primaryKey(),
	nextIndex: integer("next_index").notNull(),
});

export const repoDraftSeq = sqliteTable("repo_draft_seq", {
	repoId: text("repo_id").primaryKey(),
	nextSeq: integer("next_seq").notNull(),
});

// PER-USER STATE (POD-380, docs/multi-user-readiness.md §3.3): keyed
// (user_id, kind, id). A pin is mine; it was never instance-wide state that
// happened to have one writer.
export const pins = sqliteTable("pins", {
	userId: text("user_id").notNull(),
	kind: text().notNull(),
	id: text().notNull(),
	pinnedAt: text("pinned_at").notNull(),
},
(table) => [primaryKey({ columns: [table.userId, table.kind, table.id], name: "pins_pk"}),
]);

// PER-USER STATE (POD-380): keyed (user_id, worktree).
export const tabOrder = sqliteTable("tab_order", {
	userId: text("user_id").notNull(),
	worktree: text().notNull(),
	ids: text().notNull(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [primaryKey({ columns: [table.userId, table.worktree], name: "tab_order_pk"}),
]);

// PER-USER STATE (POD-1076): the three markers that were singleton columns on the
// shared entity rows until this migration — ADR 9 D3 rule 4's class, keyed
// (userId, entityId) over packages/model's one PerUserKey fragment.
//
// NO foreign key to `sessions` / `issues` / `issue_messages`, deliberately. A per-user
// row is not the entity's row (ADR 1 matrix, per-user-state `tombstoneNote`): it follows
// the USER and cascades on user deletion, and the entity's own deletion path already
// scrubs these keys explicitly. An ON DELETE CASCADE here would make the entity's
// lifecycle silently own rows it does not own, which is the confusion the class exists
// to prevent.
export const sessionUserState = sqliteTable("session_user_state", {
	userId: text("user_id").notNull(),
	sessionId: text("session_id").notNull(),
	/** When this person last opened it. Row absent = never opened; there is no
	 *  second spelling, because `markUnread` DELETES the row. */
	readAt: text("read_at"),
},
(table) => [primaryKey({ columns: [table.userId, table.sessionId], name: "session_user_state_pk"}),
]);

// One row, three markers: they share a key, a writer and a reader (the issue
// projection), so three tables would be three joins per issue list for no invariant
// gained. `pinned_at` is a TIMESTAMP where `issues.pinned` was a 0/1 flag — see
// packages/model/src/user-state/issue-state.ts for why; the wire keeps its boolean.
export const issueUserState = sqliteTable("issue_user_state", {
	userId: text("user_id").notNull(),
	issueId: text("issue_id").notNull(),
	readAt: text("read_at"),
	tuckedAt: text("tucked_at"),
	pinnedAt: text("pinned_at"),
},
(table) => [primaryKey({ columns: [table.userId, table.issueId], name: "issue_user_state_pk"}),
]);

export const issueMessageUserState = sqliteTable("issue_message_user_state", {
	userId: text("user_id").notNull(),
	issueMessageId: text("issue_message_id").notNull(),
	readAt: text("read_at"),
},
(table) => [primaryKey({ columns: [table.userId, table.issueMessageId], name: "issue_message_user_state_pk"}),
]);

export const conversations = sqliteTable("conversations", {
	id: text().primaryKey(),
	agentKind: text("agent_kind").notNull(),
	providerId: text("provider_id").notNull(),
	title: text(),
	name: text(),
	summary: text(),
	projectPath: text("project_path"),
	resumeKind: text("resume_kind"),
	resumeValue: text("resume_value"),
	createdAt: text("created_at"),
	updatedAt: text("updated_at"),
	messageCount: integer("message_count"),
	machineId: text("machine_id").default("__local__").notNull(),
	parentConversationId: text("parent_conversation_id"),
},
(table) => [index("idx_conversations_project_path").on(table.projectPath),
index("idx_conversations_updated_at").on(table.updatedAt),
]);

export const superagentMessages = sqliteTable("superagent_messages", {
	id: integer().primaryKey({ autoIncrement: true }),
	role: text().notNull(),
	content: text().notNull(),
	toolCalls: text("tool_calls"),
	toolCallId: text("tool_call_id"),
	toolName: text("tool_name"),
	createdAt: text("created_at").notNull(),
	threadId: text("thread_id").default("global").notNull(),
});

export const superagentThreads = sqliteTable("superagent_threads", {
	id: text().primaryKey(),
	kind: text().notNull(),
	originSessionId: text("origin_session_id"),
	title: text(),
	watermarkItemId: text("watermark_item_id"),
	watermarkTs: text("watermark_ts"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
	archived: integer().default(0).notNull(),
	repoPath: text("repo_path"),
	agentKind: text("agent_kind"),
	podiumSessionId: text("podium_session_id"),
	harnessSessionId: text("harness_session_id"),
	terminalSessionId: text("terminal_session_id"),
});

export const machines = sqliteTable("machines", {
	id: text().primaryKey(),
	name: text().notNull(),
	hostname: text().notNull(),
	tokenHash: text("token_hash").notNull(),
	createdAt: text("created_at").notNull(),
	lastSeenAt: text("last_seen_at").notNull(),
	inventoryJson: text("inventory_json"),
	// MACHINE OWNERSHIP (POD-1079, ADR 9 D6 M1/M3). The person a paired machine
	// belongs to. NULLABLE and null is MEANINGFUL: `machineUseAllowed` refuses
	// `use` on an owner-less machine to EVERYONE, which is the default-closed
	// answer for a row written by a code path that never named an owner. The
	// upgrade backfills every existing row to the first admin (M3 evaluated in a
	// world with exactly one pairer), so no install loses access.
	//
	// Grants live in the `grants` edge table keyed `('machine', id, grantee,
	// verb)` — NOT in a column here. ADR 4 D7.1: a grant is its own aggregate and
	// a granted row never embeds its grants.
	ownerUserId: text("owner_user_id"),
});

export const repos = sqliteTable("repos", {
	machineId: text("machine_id").default("__local__").notNull(),
	path: text().notNull(),
	originUrl: text("origin_url"),
	repoName: text("repo_name"),
	addedAt: text("added_at").notNull(),
	repoId: text("repo_id"),
},
(table) => [primaryKey({ columns: [table.machineId, table.path], name: "repos_pk"}),
]);

export const sessionDrafts = sqliteTable("session_drafts", {
	sessionId: text("session_id").primaryKey(),
	text: text().notNull(),
	updatedAt: text("updated_at").notNull(),
	// Draft Sync v2 (POD-859): versioned-draft columns — server-assigned rev, the
	// last-writer origin, and a JSON history ring. Additive; legacy rows default
	// (rev 0, origin/history NULL). The store reads/writes are ALSO column-guarded
	// as defense-in-depth, but drizzle applies by NAME so this migration always runs.
	rev: integer("rev").default(0).notNull(),
	origin: text("origin"),
	history: text("history"),
});

// PER-USER STATE (POD-380): keyed (user_id, session_id). Note snoozed_until
// stays NULLABLE and null is MEANINGFUL — "until next message", a snooze that
// never lapses by time. Absence of the row is "not snoozed".
export const snoozes = sqliteTable("snoozes", {
	userId: text("user_id").notNull(),
	sessionId: text("session_id").notNull(),
	snoozedUntil: text("snoozed_until"),
	createdAt: text("created_at").notNull(),
},
(table) => [primaryKey({ columns: [table.userId, table.sessionId], name: "snoozes_pk"}),
]);

// Agent action offers [spec:SP-c7f1] — one live offer per session (a freeform
// message + JSON-encoded action buttons). Ephemeral overlay like `snoozes`;
// replaced on re-offer, deleted on clear/next-turn.
export const offers = sqliteTable("offers", {
	sessionId: text("session_id").primaryKey(),
	message: text().notNull(),
	actions: text().notNull(), // JSON array of { label, prompt }
	artifacts: text(), // JSON array of issue-artifact paths [POD-120]; NULL = none
	createdAt: text("created_at").notNull(),
});

// USER ACCOUNTS (POD-1075, ADR 9 D1.2). The identity `client_sessions`,
// ownership and attribution all resolve to. `role` is the instance-level
// account role (`admin` | `member`, ADR 9 D1.4) — distinct from the per-command
// capability role, and the thing that makes secrets management, substrate
// `manage` and fleet administration admin-grade once there is more than one
// human. `disabled_at` is disable-before-remove: per-user rows cascade on
// deletion, but OWNED entities need a transfer story, which is ADR 9 lifecycle
// territory and not this migration's.
export const users = sqliteTable("users", {
	id: text().primaryKey(),
	displayName: text("display_name").notNull(),
	role: text().notNull(),
	createdAt: text("created_at").notNull(),
	disabledAt: text("disabled_at"),
});

// ACCOUNT CREDENTIAL MATERIAL (ADR 1 matrix row `account-credential`):
// `secret-value`, never replicated, never enqueued (ADR 1 D6 unchanged).
// A SEPARATE table from `users` on purpose — the account is `personal` and
// reaches the wire; its credential is `secret` and has no wire projection to
// be omitted from, because it is not on the aggregate at all.
//
// `source = 'instance-password'` with a NULL hash means "this account
// authenticates with the shared instance password already in auth.json". That
// is what the upgrade writes, because a SQL migration cannot read a file — see
// the migration's own header. `per-user-scrypt` with a hash is Phase 3's
// (POD-315) per-account credential.
export const userCredentials = sqliteTable("user_credentials", {
	userId: text("user_id").primaryKey(),
	source: text().notNull(),
	passwordHash: text("password_hash"),
	updatedAt: text("updated_at").notNull(),
});

// GRANT EDGE (ADR 9 D2): `(entityRef, granteeUserId, verb)`. `owner` is the
// GRANTER — the accountable party, since a grant may never exceed its granter's
// own rights (D2 rule 4) — stored in the one place every owned class stores it
// rather than in a second column. There is deliberately no `expires_at` and no
// resolved permission set: a grant is evaluated LIVE against the granter's
// current rights at every apply (ADR 3 D8), and revocation is removing the row.
//
// The table exists and nothing writes it yet: share / unshare are Phase 3
// commands (POD-290). Landing the shape here is the point of Phase 1 — the
// alternative is a table migration after the POD-308 wire cutover.
export const grants = sqliteTable("grants", {
	resourceKind: text("resource_kind").notNull(),
	resourceId: text("resource_id").notNull(),
	grantee: text().notNull(),
	verb: text().notNull(),
	owner: text().notNull(),
	visibility: text().notNull(),
	createdAt: text("created_at").notNull(),
	actorKind: text("actor_kind").notNull(),
	actorId: text("actor_id"),
	onBehalfOf: text("on_behalf_of"),
},
(table) => [primaryKey({ columns: [table.resourceKind, table.resourceId, table.grantee, table.verb], name: "grants_pk"}),
]);

// A client session is a DEVICE — and, from POD-1075, one that RESOLVES TO A
// USER (ADR 9 D1.3). `user_id` is what makes "which device" and "who" two
// answers instead of one.
//
// It does NOT yet make the transport able to tell two people apart: there is
// still one shared password, so every row an upgraded instance has names the
// first admin, and `CLIENT_PRINCIPAL_GRADE` stays `'device'`. Per-user login is
// Phase 3 (POD-315).
export const clientSessions = sqliteTable("client_sessions", {
	tokenHash: text("token_hash").primaryKey(),
	userId: text("user_id").notNull(),
	createdAt: text("created_at").notNull(),
	expiresAt: text("expires_at").notNull(),
});

// `changes` and `applied_mutations` moved to
// packages/sync/src/adapters/sqlite/schema.ts at POD-305. They are GENERIC SYNC
// INFRASTRUCTURE (ADR 1 §10), not product entities, so the sync adapter owns
// them; drizzle.config.ts unions both schema files into the ONE journal, so
// global migration ordering is unchanged. `queued_messages` and
// `upstream_outbox` below stay HERE: the sync adapter reads them, and reading a
// table is not owning it — they are the session inbox and the node->hub
// forwarder's queue, which are feature-owned.

export const queuedMessages = sqliteTable("queued_messages", {
	id: text().primaryKey(),
	sessionId: text("session_id").notNull(),
	text: text().notNull(),
	queuedAt: integer("queued_at").notNull(),
	inputOrigin: text("input_origin").default("unknown").notNull(),
	attempts: integer().default(0).notNull(),
},
(table) => [index("queued_messages_session").on(table.sessionId, table.queuedAt),
]);

export const conversationIdentities = sqliteTable("conversation_identities", {
	podiumId: text("podium_id").primaryKey(),
	parentPodiumId: text("parent_podium_id"),
	createdAt: text("created_at").notNull(),
});

export const conversationSegments = sqliteTable("conversation_segments", {
	machineId: text("machine_id").notNull(),
	nativeId: text("native_id").notNull(),
	providerId: text("provider_id").notNull(),
	podiumId: text("podium_id").notNull(),
	path: text(),
	seqInConv: integer("seq_in_conv").notNull(),
	linkedBy: text("linked_by").notNull(),
	createdAt: text("created_at").notNull(),
	mirroredBytes: integer("mirrored_bytes").default(0).notNull(),
	mirroredAt: text("mirrored_at"),
	indexedBytes: integer("indexed_bytes").default(0).notNull(),
	reportedBytes: integer("reported_bytes"),
},
(table) => [index("conversation_segments_podium").on(table.podiumId, table.seqInConv),
primaryKey({ columns: [table.machineId, table.nativeId], name: "conversation_segments_pk"}),
]);

export const podiumEvents = sqliteTable("podium_events", {
	id: integer().primaryKey({ autoIncrement: true }),
	ts: text().notNull(),
	kind: text().notNull(),
	subject: text().notNull(),
	repoPath: text("repo_path"),
	payload: text({"mode":"json"}).default({}).notNull(),
},
(table) => [index("idx_podium_events_repo").on(table.repoPath),
index("idx_podium_events_kind").on(table.kind),
]);

export const stewardState = sqliteTable("steward_state", {
	key: text().primaryKey(),
	value: text().notNull(),
});

export const upstreamOutbox = sqliteTable("upstream_outbox", {
	mutationId: text("mutation_id").primaryKey(),
	proc: text().notNull(),
	input: text().notNull(),
	queuedAt: integer("queued_at").notNull(),
	attempts: integer().default(0).notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
	id: text().primaryKey(),
	subscriberKind: text("subscriber_kind").notNull(),
	subscriberId: text("subscriber_id").notNull(),
	event: text().notNull(),
	sourceKind: text("source_kind").notNull(),
	sourceRef: text("source_ref").notNull(),
	deliverNudge: integer("deliver_nudge").default(1).notNull(),
	deliverNotify: integer("deliver_notify").default(0).notNull(),
	origin: text().default("custom").notNull(),
	enabled: integer().default(1).notNull(),
	createdAt: text("created_at").notNull(),
},
(table) => [index("idx_subscriptions_subscriber").on(table.subscriberId),
]);

export const subscriptionDeliveries = sqliteTable("subscription_deliveries", {
	subscriptionId: text("subscription_id").notNull(),
	eventId: integer("event_id").notNull(),
},
(table) => [primaryKey({ columns: [table.subscriptionId, table.eventId], name: "subscription_deliveries_pk"}),
]);

export const notificationFacts = sqliteTable("notification_facts", {
	factKey: text("fact_key").notNull(),
	target: text().notNull(),
	source: text(),
	issueId: text("issue_id"),
	createdAt: text("created_at").notNull(),
	expiresAt: text("expires_at"),
	consumedAt: text("consumed_at"),
},
(table) => [index("idx_notification_facts_issue").on(table.issueId),
index("idx_notification_facts_expires").on(table.expiresAt),
primaryKey({ columns: [table.factKey, table.target], name: "notification_facts_pk"}),
]);

export const issueLabels = sqliteTable("issue_labels", {
	issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" } ),
	label: text().notNull(),
},
(table) => [index("idx_issue_labels_label").on(table.label),
primaryKey({ columns: [table.issueId, table.label], name: "issue_labels_pk"}),
]);

export const issueDeps = sqliteTable("issue_deps", {
	fromId: text("from_id").notNull().references(() => issues.id, { onDelete: "cascade" } ),
	toId: text("to_id").notNull().references(() => issues.id, { onDelete: "cascade" } ),
	type: text().default("blocks").notNull(),
},
(table) => [index("idx_issue_deps_to").on(table.toId),
index("idx_issue_deps_from").on(table.fromId),
primaryKey({ columns: [table.fromId, table.toId, table.type], name: "issue_deps_pk"}),
]);

export const issueComments = sqliteTable("issue_comments", {
	id: text().primaryKey(),
	issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" } ),
	author: text().notNull(),
	body: text().notNull(),
	createdAt: text("created_at").notNull(),
},
(table) => [index("idx_issue_comments_issue").on(table.issueId),
]);

export const issueMessages = sqliteTable("issue_messages", {
	id: text().primaryKey(),
	issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" } ),
	fromAuthor: text("from_author").notNull(),
	body: text().notNull(),
	createdAt: text("created_at").notNull(),
	status: text().default("unread").notNull(),
	claimedBy: text("claimed_by"),
	claimedAt: text("claimed_at"),
},
(table) => [index("idx_issue_messages_issue").on(table.issueId),
]);

export const issues = sqliteTable("issues", {
	id: text().primaryKey(),
	repoPath: text("repo_path").notNull(),
	repoId: text("repo_id"),
	seq: integer().notNull(),
	title: text().notNull(),
	description: text().default("").notNull(),
	brief: text(),
	stage: text().notNull(),
	worktreePath: text("worktree_path"),
	branch: text(),
	parentBranch: text("parent_branch").default("main").notNull(),
	defaultAgent: text("default_agent").notNull(),
	defaultModel: text("default_model").default("auto").notNull(),
	defaultEffort: text("default_effort").default("auto").notNull(),
	machineId: text("machine_id"),
	linearId: text("linear_id"),
	linearIdentifier: text("linear_identifier"),
	linearUrl: text("linear_url"),
	activityNotes: text("activity_notes"),
	notesUpdatedAt: text("notes_updated_at"),
	suggestedStage: text("suggested_stage"),
	suggestedReason: text("suggested_reason"),
	blockedBy: text("blocked_by", {"mode":"json"}).default([]).notNull(),
	dependencyNote: text("dependency_note"),
	prUrl: text("pr_url"),
	priority: integer().default(2).notNull(),
	type: text().default("task").notNull(),
	assignee: text(),
	parentId: text("parent_id").references((): AnySQLiteColumn => issues.id, { onDelete: "set null" } ),
	design: text(),
	acceptance: text(),
	notes: text(),
	dueAt: text("due_at"),
	deferUntil: text("defer_until"),
	closedReason: text("closed_reason"),
	// When the closed-predicate last flipped true; null while open. The stable
	// completion-decay anchor (updatedAt churns on any touch). [spec:SP-6144]
	closedAt: text("closed_at"),
	supersededBy: text("superseded_by").references((): AnySQLiteColumn => issues.id, { onDelete: "set null" } ),
	duplicateOf: text("duplicate_of").references((): AnySQLiteColumn => issues.id, { onDelete: "set null" } ),
	/** Manual order (POD-168): fractional/lexo-rank string, ascending = top.
	 *  One key space per sibling scope (project-group top level, a parent's
	 *  children, PINNED); null = legacy row, sorts after keyed rows. */
	sortKey: text("sort_key"),
	color: text(),
	estimateMin: integer("estimate_min"),
	needsHuman: integer("needs_human").default(0).notNull(),
	humanQuestion: text("human_question"),
	humanQuestionOptions: text("human_question_options", {"mode":"json"}),
	humanQuestionAskedBy: text("human_question_asked_by"),
	humanQuestionAskedAt: text("human_question_asked_at"),
	panel: text(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
	archived: integer().default(0).notNull(),
	origin: text().default("human").notNull(),
	draft: integer().default(0).notNull(),
	audience: text().default("human").notNull(),
	deletedAt: text("deleted_at"),
	/** Designated coordinator session for this issue (bare session id). Claimable/
	 *  changeable; dangling-tolerant — no FK so a later-deleted session leaves the
	 *  id in place and routing falls back [docs/agent-comms-target.html §05 q1]. */
	coordinatorSessionId: text("coordinator_session_id"),
	/** Bare session id of the agent session that created this issue (started-by
	 *  provenance). Null for operator/human creates. Dangling-tolerant TEXT. */
	startedBySession: text("started_by_session"),
},
(table) => [index("idx_issues_deleted_at").on(table.deletedAt),
uniqueIndex("idx_issues_repo_id_seq").on(table.repoId, table.seq),
index("idx_issues_parent").on(table.parentId),
index("idx_issues_repo").on(table.repoPath),
check("issues_check_1", sql`stage IN ('proposed', 'backlog', 'planning', 'in_progress', 'review', 'verifying', 'done')`),
check("issues_check_2", sql`priority BETWEEN 0 AND 4`),
check("issues_check_3", sql`type IN ('task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone', 'automation')`),
]);

export const approvalRequests = sqliteTable("approval_requests", {
	id: text().primaryKey(),
	machineId: text("machine_id").notNull(),
	sessionId: text("session_id").notNull(),
	issueId: text("issue_id"),
	opJson: text("op_json").notNull(),
	status: text().default("pending").notNull(),
	createdAt: text("created_at").notNull(),
	decidedAt: text("decided_at"),
	resultText: text("result_text"),
},
(table) => [index("idx_approval_requests_status").on(table.status, table.createdAt),
check("approval_requests_check_4", sql`status IN ('pending','denied','executing','succeeded','failed')`),
]);

export const locks = sqliteTable("locks", {
	repoId: text("repo_id").notNull(),
	name: text().notNull(),
	holderSessionId: text("holder_session_id"),
	holderIssueId: text("holder_issue_id"),
	holderLabel: text("holder_label").notNull(),
	note: text(),
	acquiredAt: text("acquired_at").notNull(),
	expiresAt: text("expires_at").notNull(),
},
(table) => [index("idx_locks_expires").on(table.expiresAt),
index("idx_locks_holder_session").on(table.holderSessionId),
primaryKey({ columns: [table.repoId, table.name], name: "locks_pk"}),
]);

export const lockWaiters = sqliteTable("lock_waiters", {
	id: integer().primaryKey({ autoIncrement: true }),
	repoId: text("repo_id").notNull(),
	name: text().notNull(),
	sessionId: text("session_id").notNull(),
	issueId: text("issue_id"),
	label: text().notNull(),
	enqueuedAt: text("enqueued_at").notNull(),
},
(table) => [index("idx_lock_waiters_session").on(table.sessionId),
index("idx_lock_waiters_lock").on(table.repoId, table.name, table.id),
unique().on(table.repoId, table.name, table.sessionId),
]);

export const superagentQueuedInputs = sqliteTable("superagent_queued_inputs", {
	inputId: text("input_id").primaryKey(),
	threadId: text("thread_id").notNull(),
	text: text().notNull(),
	focusJson: text("focus_json"),
	createdAt: text("created_at").notNull(),
},
(table) => [unique("superagent_queued_inputs_thread_id_unique").on(table.threadId),
]);

export const superagentPendingTurns = sqliteTable("superagent_pending_turns", {
	turnId: text("turn_id").primaryKey(),
	threadId: text("thread_id").notNull(),
	podiumSessionId: text("podium_session_id").notNull(),
	payloadJson: text("payload_json").notNull(),
	firstTurn: integer("first_turn").default(0).notNull(),
	createdAt: text("created_at").notNull(),
},
(table) => [unique("superagent_pending_turns_thread_id_unique").on(table.threadId),
]);

export const messages = sqliteTable("messages", {
	id: text().primaryKey(),
	threadId: text("thread_id").notNull(),
	inReplyTo: text("in_reply_to"),
	fromKind: text("from_kind").notNull(),
	fromSession: text("from_session"),
	fromIssue: text("from_issue"),
	toKind: text("to_kind").notNull(),
	toId: text("to_id"),
	kind: text().default("message").notNull(),
	urgency: text().default("fyi").notNull(),
	lifecycle: text().default("wait").notNull(),
	body: text().notNull(),
	expiresAt: text("expires_at"),
	createdAt: text("created_at").notNull(),
	status: text().default("queued").notNull(),
	deliveredAt: text("delivered_at"),
	deliveredTo: text("delivered_to"),
	ackedBy: text("acked_by"),
	hop: integer().default(0).notNull(),
	clampedFrom: text("clamped_from"),
	remindedAt: text("reminded_at"),
	fromName: text("from_name"),
	readAt: text("read_at"),
	injectedAt: text("injected_at"),
	deadLetteredAt: text("dead_lettered_at"),
	// A response is OPT-IN [POD-835 §04b]: only a `--expect-response` send (or a
	// `question`) sets this. It is the sole trigger for the stop-hook reminder and
	// the steward settle-nag — an ordinary message owes no reply, so receipt alone
	// (mechanically proven by the ledger, POD-834) never generates ack traffic.
	expectsResponse: integer("expects_response").default(0).notNull(),
	// Message-backed notification identity [spec:SP-ba61]. Both are null for
	// ordinary mail; consume/dismiss retires the matching arbiter fact.
	factKey: text("fact_key"),
	factTarget: text("fact_target"),
},
(table) => [index("idx_messages_delivered_to").on(table.deliveredTo),
index("idx_messages_thread").on(table.threadId),
index("idx_messages_recipient").on(table.toKind, table.toId, table.status),
index("idx_messages_recipient_order").on(table.toKind, table.toId, table.status, table.createdAt, table.id),
index("idx_messages_queue_order").on(table.status, table.createdAt, table.id),
index("idx_messages_expiry_explicit").on(table.status, table.expiresAt, table.id),
index("idx_messages_expiry_implicit").on(table.status, table.lifecycle, table.expiresAt, table.createdAt, table.id),
check("messages_check_5", sql`from_kind IN ('operator','superagent','agent','system')`),
check("messages_check_6", sql`to_kind IN ('issue','session','operator')`),
check("messages_check_7", sql`kind IN ('message','ack','notification','question')`),
check("messages_check_8", sql`urgency IN ('fyi','next-turn','interrupt')`),
check("messages_check_9", sql`lifecycle IN ('wait','wake')`),
check("messages_check_10", sql`status IN ('queued','delivered','read','dead_letter','expired','cancelled')`),
]);

export const messageWakeCooldowns = sqliteTable("message_wake_cooldowns", {
	key: text().primaryKey(),
	attemptedAt: text("attempted_at").notNull(),
});

/** Durable janitor lease/fence and command idempotency [spec:SP-c29e]. */
export const maintenanceLeases = sqliteTable("maintenance_leases", {
	name: text().primaryKey(),
	generationId: text("generation_id").notNull(),
	fencingToken: integer("fencing_token").notNull(),
	expiresAt: text("expires_at").notNull(),
	protocolVersion: integer("protocol_version").notNull(),
	schemaVersion: text("schema_version").notNull(),
	updatedAt: text("updated_at").notNull(),
});

export const maintenanceCommands = sqliteTable("maintenance_commands", {
	jobKind: text("job_kind").notNull(),
	runKey: text("run_key").notNull(),
	fencingToken: integer("fencing_token").notNull(),
	resultJson: text("result_json").notNull(),
	appliedAt: text("applied_at").notNull(),
},
(table) => [primaryKey({ columns: [table.jobKind, table.runKey], name: "maintenance_commands_pk" }),
]);

export const recapWatermarks = sqliteTable("recap_watermarks", {
	reader: text().notNull(),
	sessionId: text("session_id").notNull(),
	watermark: text().notNull(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [primaryKey({ columns: [table.reader, table.sessionId], name: "recap_watermarks_pk"}),
]);

/** Telegram forum-topic ↔ issue/superagent-thread bindings [spec:SP-5d81]. */
export const messagingIssueTopics = sqliteTable("messaging_issue_topics", {
	issueId: text("issue_id").notNull(),
	chatId: text("chat_id").notNull(),
	threadRef: text("thread_ref").notNull(),
	superagentThreadId: text("superagent_thread_id").notNull(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [primaryKey({ columns: [table.issueId, table.chatId], name: "messaging_issue_topics_pk"}),
index("idx_messaging_issue_topics_ref").on(table.chatId, table.threadRef),
]);

export const workflows = sqliteTable("workflows", {
	id: text().primaryKey(),
	name: text().notNull(),
	description: text().default("").notNull(),
	scope: text().notNull(),
	scopeRef: text("scope_ref"),
	latestRevisionId: text("latest_revision_id"),
	archivedAt: text("archived_at"),
	createdByKind: text("created_by_kind").notNull(),
	createdById: text("created_by_id"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [uniqueIndex("workflows_scope_name_active").on(table.scope, sql`COALESCE(${table.scopeRef}, '')`, table.name).where(sql`${table.archivedAt} IS NULL`),
check("workflows_check_21", sql`scope IN ('global', 'repository', 'task')`),
check("workflows_check_22", sql`created_by_kind IN ('operator', 'session')`),
]);

export const workflowRevisions = sqliteTable("workflow_revisions", {
	id: text().primaryKey(),
	workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" } ),
	version: integer().notNull(),
	instructions: text().notNull(),
	stepsJson: text("steps_json", {"mode":"json"}).default([]).notNull(),
	createdByKind: text("created_by_kind").notNull(),
	createdById: text("created_by_id"),
	createdAt: text("created_at").notNull(),
	publishedAt: text("published_at"),
},
(table) => [index("workflow_revisions_workflow").on(table.workflowId, table.version),
check("workflow_revisions_check_11", sql`version > 0`),
check("workflow_revisions_check_12", sql`created_by_kind IN ('operator', 'session')`),
unique().on(table.workflowId, table.version),
]);

export const workflowBindings = sqliteTable("workflow_bindings", {
	targetKind: text("target_kind").notNull(),
	targetId: text("target_id").notNull(),
	revisionId: text("revision_id").notNull().references(() => workflowRevisions.id, { onDelete: "restrict" } ),
	updatedByKind: text("updated_by_kind").notNull(),
	updatedById: text("updated_by_id"),
	updatedAt: text("updated_at").notNull(),
},
(table) => [primaryKey({ columns: [table.targetKind, table.targetId], name: "workflow_bindings_pk"}),
check("workflow_bindings_check_13", sql`target_kind IN ('global', 'repository', 'issue', 'session')`),
check("workflow_bindings_check_14", sql`updated_by_kind IN ('operator', 'session')`),
]);

export const executionProfiles = sqliteTable("execution_profiles", {
	id: text().primaryKey(),
	name: text().notNull(),
	accountId: text("account_id").notNull(),
	machineId: text("machine_id"),
	harness: text().notNull(),
	model: text().default("auto").notNull(),
	effort: text().default("auto").notNull(),
	createdByKind: text("created_by_kind").notNull(),
	createdById: text("created_by_id"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [unique("execution_profiles_name_unique").on(table.name),
check("execution_profiles_check_15", sql`created_by_kind IN ('operator', 'session')`),
]);

export const workflowRuns = sqliteTable("workflow_runs", {
	id: text().primaryKey(),
	subjectKind: text("subject_kind").notNull(),
	subjectId: text("subject_id").notNull(),
	coordinatorSessionId: text("coordinator_session_id").notNull(),
	revisionId: text("revision_id").notNull().references(() => workflowRevisions.id, { onDelete: "restrict" } ),
	status: text().notNull(),
	supersedesRunId: text("supersedes_run_id").references((): AnySQLiteColumn => workflowRuns.id, { onDelete: "set null" } ),
	startedAt: text("started_at").notNull(),
	completedAt: text("completed_at"),
},
(table) => [uniqueIndex("workflow_runs_one_live_subject").on(table.subjectKind, table.subjectId).where(sql`${table.status} IN ('active', 'blocked')`),
index("workflow_runs_coordinator").on(table.coordinatorSessionId, desc(table.startedAt)),
check("workflow_runs_check_23", sql`subject_kind IN ('issue', 'session')`),
check("workflow_runs_check_24", sql`status IN ('active', 'blocked', 'complete', 'superseded')`),
]);

export const workflowRunSteps = sqliteTable("workflow_run_steps", {
	runId: text("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" } ),
	stepId: text("step_id").notNull(),
	position: integer().notNull(),
	title: text().notNull(),
	instructions: text().default("").notNull(),
	completionGuidance: text("completion_guidance").default("").notNull(),
	executionProfileId: text("execution_profile_id"),
	executionProfileJson: text("execution_profile_json"),
	status: text().notNull(),
	assignedSessionId: text("assigned_session_id"),
	attempt: integer().default(1).notNull(),
	summary: text().default("").notNull(),
	evidenceJson: text("evidence_json", {"mode":"json"}).default({}).notNull(),
	observationJson: text("observation_json"),
	warningsJson: text("warnings_json", {"mode":"json"}).default([]).notNull(),
	startedAt: text("started_at"),
	completedAt: text("completed_at"),
},
(table) => [index("workflow_run_steps_assignee").on(table.assignedSessionId, table.status),
primaryKey({ columns: [table.runId, table.stepId], name: "workflow_run_steps_pk"}),
check("workflow_run_steps_check_16", sql`position >= 0`),
check("workflow_run_steps_check_17", sql`status IN ('pending', 'active', 'blocked', 'complete', 'skipped')`),
check("workflow_run_steps_check_18", sql`attempt > 0`),
unique().on(table.runId, table.position),
]);

export const workflowEvents = sqliteTable("workflow_events", {
	id: integer().primaryKey({ autoIncrement: true }),
	workflowId: text("workflow_id"),
	runId: text("run_id"),
	kind: text().notNull(),
	actorKind: text("actor_kind").notNull(),
	actorId: text("actor_id"),
	// ADR 9 D5 A3 (POD-731): attribution is a PAIR. `actor_*` above is WHICH agent
	// or session acted; this is WHICH HUMAN it acted for, stamped from the
	// transport principal and never from payload. Nullable because rows written
	// before this column have no human recorded and inventing one would be a lie
	// in an audit trail — and because a `system` principal has none by
	// construction (ADR 3 Amendment 1 D14.2/D21).
	onBehalfOf: text("on_behalf_of"),
	payloadJson: text("payload_json", {"mode":"json"}).default({}).notNull(),
	createdAt: text("created_at").notNull(),
},
(table) => [index("workflow_events_run").on(table.runId, table.id),
index("workflow_events_workflow").on(table.workflowId, table.id),
check("workflow_events_check_19", sql`actor_kind IN ('operator', 'session')`),
]);

export const accounts = sqliteTable("accounts", {
	id: text().primaryKey(),
	provider: text().notNull(),
	kind: text().notNull(),
	credential: text().notNull(),
	identity: text().default("").notNull(),
	scope: text().default("role").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const automations = sqliteTable("automations", {
	id: text().primaryKey(),
	name: text().notNull(),
	enabled: integer().default(0).notNull(),
	repoPath: text("repo_path"),
	scheduleKind: text("schedule_kind").default("cron").notNull(),
	cron: text().notNull(),
	runAt: text("run_at"),
	targetSessionId: text("target_session_id"),
	agentKind: text("agent_kind").notNull(),
	model: text().default("auto").notNull(),
	effort: text().default("auto").notNull(),
	prompt: text().notNull(),
	nextRunAt: text("next_run_at"),
	lastRunAt: text("last_run_at"),
	createdAt: text("created_at").notNull(),
	sessionMode: text("session_mode").default("fresh").notNull(),
},
(table) => [check("automations_session_mode", sql`session_mode IN ('fresh', 'resume')`),
]);

export const automationRuns = sqliteTable("automation_runs", {
	id: text().primaryKey(),
	automationId: text("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" } ),
	firedAt: text("fired_at").notNull(),
	sessionId: text("session_id"),
	outcome: text().notNull(),
	detail: text(),
},
(table) => [index("idx_automation_runs_automation").on(table.automationId, table.firedAt),
check("automation_runs_check_20", sql`outcome IN ('spawned','missed','skipped_overlap','error')`),
]);
