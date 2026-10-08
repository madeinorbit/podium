// Generated from apps/server/src/router.ts. Run bun run api:types. Do not edit.
import * as _podium_model from '@podium/model';
import { MachineId, UserId, SessionId, IssueId, ArtifactId, UpdateChannel, MachinePresenceSource, TranscriptItem, GitRepositoryWire, GitDiscoveryDiagnosticWire, AgentKind, AccountId, AgentPhase, SessionMeta, MachineProjection, HarnessAgent } from '@podium/model';
import { z } from 'zod';
import * as Protocol from '@podium/protocol';
import { ModelChoiceWire, ConvergenceState, MobileWebIdentity, FeatureState, FeatureVisibility } from '@podium/protocol';
import * as TRPC from '@trpc/server';

interface SpecComponentMeta {
    id: string;
    title: string;
    /** Parent component id; empty for the root. */
    parent: string;
    /** Sort position among siblings. */
    order: number;
    status: 'active' | 'superseded' | 'draft';
    updatedAt: number;
}
interface SpecComponent extends SpecComponentMeta {
    /** Inner HTML of the component's <section> — the editable body. */
    body: string;
}
interface SpecSearchHit {
    id: string;
    title: string;
    /** Plain-text snippet around the first match. */
    snippet: string;
}

/**
 * THE CLIENT-LOG FAMILY — `logs.forward · logs.crash · logs.setLevel`
 * ([spec:2026-08-11-logging-strategy-design]).
 *
 * Two ingestion writes and one operator command. The first two are a client
 * reporting itself; the third is the valve the whole design exists to open —
 * raising one running client so a problem on a user's machine can be diagnosed
 * without shipping them a new build. That asymmetry is why they sit at different
 * role floors, and each contract says so where it is declared.
 *
 * A client (web, desktop webview, mobile) keeps its own ring buffer and forwards
 * what matters to ITS OWN SERVER: `forward` is the routine batch, `crash` is the
 * one-shot "I died, here is the flight recorder". Both are server-side ingestion
 * with no client code in this chunk — these contracts are the shape chunks 4 and
 * 5 build their forwarding sinks against.
 *
 * ---------------------------------------------------------------------------
 * NO CONSENT GATE ON THIS HOP, AND THAT IS A DECISION WITH A REASON
 * ---------------------------------------------------------------------------
 *
 * Podium is self-hosted: the client's server is the USER'S OWN server, so
 * forwarding a log line to it discloses nothing to anybody — it moves the user's
 * data from one of their processes to another. The consent gate sits one hop
 * further out, where a scrubbed crash SIGNATURE may leave the installation
 * entirely (`telemetry.recordCrash`, the existing `crash` tier). The design spec
 * states this in "Client → server forwarding"; it is written here too because
 * this is the contract a reviewer reads when asking "why is there no consent
 * check on an endpoint that accepts logs".
 *
 * ---------------------------------------------------------------------------
 * BOUNDS ARE PART OF THE CONTRACT, NOT OF THE HANDLER
 * ---------------------------------------------------------------------------
 *
 * An ingestion endpoint that accepts an unbounded array is a disk-filler with an
 * authentication check in front of it. Every collection and every string below
 * is capped in the SCHEMA, so an oversized batch is refused by the transport
 * before a handler sees it, and the cap is visible to the client author writing
 * the batching sink rather than discoverable by exceeding it in production.
 *
 * The caps are deliberately generous against the spec's own client behaviour
 * (flush every 5 s or 50 records) so a client that batches correctly never meets
 * them: they exist to bound the worst case, not to shape the normal one.
 */

declare const logsSetLevelInput: z.ZodObject<{
    /** `null` puts the matched clients back to their boot default. */
    level: z.ZodNullable<z.ZodEnum<["error", "warn", "info", "debug", "trace"]>>;
    /** How long the raise lasts. Absent leaves the duration to the client's own
     *  default, which is the thing holding the timer. */
    ttlMs: z.ZodOptional<z.ZodNumber>;
    /** Absent means every connected client — see {@link logLevelTarget}. */
    target: z.ZodOptional<z.ZodObject<{
        /** The server-minted connection id (`c3`), as reported by a previous call. */
        clientId: z.ZodOptional<z.ZodString>;
        role: z.ZodOptional<z.ZodString>;
        machineId: z.ZodOptional<z.ZodPipeline<z.ZodString, z.ZodBranded<z.ZodString, "MachineId">>>;
    }, "strip", z.ZodTypeAny, {
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        role?: string | undefined;
        clientId?: string | undefined;
    }, {
        machineId?: string | undefined;
        role?: string | undefined;
        clientId?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    level: "error" | "warn" | "info" | "debug" | "trace" | null;
    ttlMs?: number | undefined;
    target?: {
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        role?: string | undefined;
        clientId?: string | undefined;
    } | undefined;
}, {
    level: "error" | "warn" | "info" | "debug" | "trace" | null;
    ttlMs?: number | undefined;
    target?: {
        machineId?: string | undefined;
        role?: string | undefined;
        clientId?: string | undefined;
    } | undefined;
}>;
declare const logsSetDaemonLevelInput: z.ZodObject<{
    /** `null` puts the matched daemons back to their boot default AND stops them
     *  forwarding. */
    level: z.ZodNullable<z.ZodEnum<["error", "warn", "info", "debug", "trace"]>>;
    /** How long the raise lasts. Absent leaves the duration to the daemon's own
     *  default, which is the thing holding the timer. */
    ttlMs: z.ZodOptional<z.ZodNumber>;
    /** Absent means every daemon online right now — see {@link daemonLogLevelTarget}. */
    target: z.ZodOptional<z.ZodObject<{
        machineId: z.ZodOptional<z.ZodPipeline<z.ZodString, z.ZodBranded<z.ZodString, "MachineId">>>;
    }, "strip", z.ZodTypeAny, {
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
    }, {
        machineId?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    level: "error" | "warn" | "info" | "debug" | "trace" | null;
    ttlMs?: number | undefined;
    target?: {
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
    } | undefined;
}, {
    level: "error" | "warn" | "info" | "debug" | "trace" | null;
    ttlMs?: number | undefined;
    target?: {
        machineId?: string | undefined;
    } | undefined;
}>;
type LogsSetLevelInput = z.infer<typeof logsSetLevelInput>;
type LogsSetDaemonLevelInput = z.infer<typeof logsSetDaemonLevelInput>;

/**
 * `logs.setDaemonLevel` — THE OPERATOR REACHING A RUNNING DAEMON (POD-3156).
 *
 * The sibling of `./level-director.ts`, one plane over. That one turns "raise
 * this one user's client" into frames on `/client` sockets; this one turns
 * "raise Flatblock" into a frame on Flatblock's daemon socket. The two are
 * deliberately the same shape, because an operator holding one investigation
 * should not have to hold two mental models of what a raise is.
 *
 * ---------------------------------------------------------------------------
 * ONLINE MACHINES ONLY, AND IT DOES NOT QUEUE
 * ---------------------------------------------------------------------------
 * `MachinesService.toMachine` queues a control frame for a briefly-offline
 * machine and flushes it on the next attach. That is right for a spawn and
 * WRONG for a raise, for the reason the client contract already gives: a raise
 * held through an offline period arrives after the incident it was issued for,
 * and turns up a daemon nobody is investigating — on a host that has meanwhile
 * been rebooted, at a level nobody remembers asking for.
 *
 * So this sends only to machines with a live socket RIGHT NOW, and the reply
 * says which those were. An operator whose machine was offline sees it missing
 * from the list and re-issues, which is one keystroke and always the right
 * answer.
 *
 * ---------------------------------------------------------------------------
 * NO STATE, ON PURPOSE — AND THE STAKES ARE HIGHER THAN FOR A CLIENT
 * ---------------------------------------------------------------------------
 * Nothing is remembered here. A raise is delivered and is then the DAEMON's,
 * held under the daemon's own TTL, and a daemon that reconnects is at its
 * default again. A server-side "machines that should be at debug" table would
 * give a raise that survives a reconnect, and with it the failure this whole
 * feature is written to avoid — except that where a stuck client is fixed by a
 * page reload, a stuck daemon forwards someone else's host contents across a
 * network until a human notices. The absence of that table is the feature.
 *
 * ---------------------------------------------------------------------------
 * THE REPLY IS THE DISCOVERY MECHANISM
 * ---------------------------------------------------------------------------
 * As next door: there is no separate "list daemons" query in this family. The
 * reply names every machine the command reached, so an operator with no idea
 * what is connected resets everything, reads who that was, and narrows on the
 * next call.
 */

/** One daemon a raise reached, as the operator needs to see it. */
interface RaisedDaemon {
    machineId: MachineId;
    name: string;
    /** Records this machine reported dropping since the server booted — a LOSSY
     *  LINK, or a daemon louder than its socket. Surfaced in the same reply that
     *  raised it so the operator does not have to grep the file to find out. */
    dropped?: number;
    /** Records THIS SERVER dropped under its own ingestion backpressure. A
     *  different fact with a different fix — the far end sent them and they were
     *  lost here — so it is a different field rather than a bigger number. */
    serverDropped?: number;
}
interface SetDaemonLevelResult {
    /** What the level now is on the daemons below; `null` means "their default". */
    level: LogsSetDaemonLevelInput['level'];
    /** Every machine the command reached, in registry order. */
    daemons: RaisedDaemon[];
}

/**
 * `logs.setLevel` — THE OPERATOR REACHING A RUNNING CLIENT (POD-1920, chunk 7 of
 * [spec:2026-08-11-logging-strategy-design]).
 *
 * Everything else in this epic built the pipe: the logger, the three client
 * sinks, ingestion, the per-origin files. This is the valve. Its whole job is to
 * turn "raise this one user's client to `debug`" into frames on the connections
 * that are open right now.
 *
 * ---------------------------------------------------------------------------
 * IT PUSHES DOWN THE CHANNEL THAT ALREADY EXISTS
 * ---------------------------------------------------------------------------
 * The `/client` socket already carries server-initiated commands — the
 * browser-open family is a daemon→server→client request, not an RPC — so a raise
 * is one more `ServerMessage` through `ClientRegistry.deliver`, which is the
 * narrow waist every write to a client socket goes through. There is no second
 * channel here and there must not be one.
 *
 * ---------------------------------------------------------------------------
 * NO STATE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * This remembers nothing. A raise is delivered to the connections that match it
 * and is then the CLIENT's, held under the client's own TTL. Two things follow,
 * and both are the design rather than a gap:
 *
 *   - a client that reconnects (or reloads) is at its default again, and nobody
 *     has to remember to put it back;
 *   - a client that was offline during the call was not raised, which the reply
 *     says by not listing it.
 *
 * A server-side "clients that should be at debug" table would give the operator
 * a raise that survives a reload — and, with it, the one failure mode this whole
 * feature is written to avoid: a client stuck at `debug` because the row outlived
 * everyone's memory of why it was written.
 *
 * ---------------------------------------------------------------------------
 * THE REPLY IS THE DISCOVERY MECHANISM
 * ---------------------------------------------------------------------------
 * There is no separate "list connected clients" query. The reply names every
 * connection the command reached, with the self-description that connection sent
 * in `hello` — the same role/version/machine tuple the server files its forwarded
 * records under. So an operator with no idea what is connected raises everything,
 * reads who that was, and narrows on the next call. One command, and no surface
 * that exists only to be looked at.
 */

/** One connection a raise reached, as the operator needs to see it. */
interface RaisedClient {
    clientId: string;
    role?: string;
    v?: string;
    machineId?: MachineId;
}
interface SetLevelResult {
    /** What the level now is on the clients below; `null` means "their default". */
    level: LogsSetLevelInput['level'];
    /** Every connection the command reached, in registry order. */
    clients: RaisedClient[];
}

/**
 * CLIENT LOG INGESTION — the service behind `logs.forward` and `logs.crash`
 * (chunk 3 of [spec:2026-08-11-logging-strategy-design]).
 *
 * Two jobs, deliberately in one service because they share the origin tagging
 * and both are "a client's records, landing on the user's own server":
 *
 *  - `forward` appends a batch to a PER-ORIGIN rotating NDJSON file under the
 *    server's log dir, using the same file sink and the same 10 MB × 5 policy
 *    the server's own logs use (chunk 2). Per-origin because a web client and a
 *    phone interleaved in one file are two investigations sharing a haystack.
 *  - `crash` stores the error plus the client's whole ring buffer as a durable
 *    crash event, and then — and only then — offers it to the telemetry crash
 *    tier, which scrubs it and checks consent before anything can leave.
 *
 * ORDER MATTERS AT THE CRASH SEAM. The durable event is written FIRST and the
 * telemetry hop is best-effort after it. The crash event on the user's own disk
 * is the artifact support actually needs (`podium logs export-crash`); the
 * telemetry signature is an anonymous aggregate that may be switched off. A
 * failure in the optional half must never cost the mandatory one.
 *
 * ---------------------------------------------------------------------------
 * `forward` DOES NOT WRITE INSIDE THE REQUEST (POD-3167)
 * ---------------------------------------------------------------------------
 * It used to. The argument for it was that the cost lands on the request that
 * carried the batch and on nobody else — which is true of the CPU accounting and
 * false of the latency. The file sink writes SYNCHRONOUSLY and deliberately (a
 * buffered async sink loses precisely the records worth having, and `Sink.write`
 * may not reject), so a 500-record batch — the contract's cap — blocked the one
 * event loop this process serves everything on, and the request that paid for it
 * was whichever one happened to arrive next.
 *
 * So `forward` TAGS and QUEUES, and the writes happen in bounded slices between
 * event-loop turns, through `QueuedRecordWriter` — the same primitive the fleet
 * daemon store uses, with this file's policy: `logs/clients`, a 64-file budget,
 * and the queue budget below. `accepted` is therefore a queue admission rather
 * than a completed write; the records reach disk within a few turns, and all of
 * them reach it before `close()` returns.
 *
 * NOTHING HERE THROWS AT THE ENDPOINT for a storage failure. This is the
 * logging layer: a full disk must not turn a client's crash report into a 500,
 * and a client whose crash report failed cannot do anything useful with the
 * error anyway. Failures degrade to a single server-side log line and a truthful
 * count in the response.
 */

interface ForwardResult {
    /** Records ACCEPTED for writing. Not "written": the writes are deferred off
     *  the request, so this is a queue admission and the only way to be short of
     *  the batch is a service that is already closed. */
    accepted: number;
    /** The file they were filed under, so a client can be told where to look. */
    origin: string;
    /** Drops the CLIENT reported in this batch — its own bounded queue overflowed,
     *  or a batch went unsendable. A SENDER-side loss. */
    dropped: number;
    /** Drops THIS SERVER made for this origin since boot, under its own
     *  backpressure. Reported apart from {@link dropped} because a client that
     *  cannot reach the server and a server that cannot keep up are different
     *  problems with different fixes, and one number would answer neither. */
    serverDropped: number;
}
interface CrashResult {
    /** The stored event's id, or undefined when the write failed. */
    id?: string;
}

interface LinearIssue {
    identifier: string;
    title: string;
    state: string;
    assignee?: string;
    url: string;
}

interface PinState {
    panels: string[];
    worktrees: string[];
    repos: string[];
}
/** A durable event subscription (event-subscriptions design, Phase B). The steward
 *  matches enabled rows against every polled event; a match resolves `source` to the
 *  event's subject and delivers per `deliverNudge`/`deliverNotify`. */
interface Subscription {
    id: string;
    /** Who is notified: a session (in-session nudge) or an issue (its member sessions). */
    subscriberKind: 'session' | 'issue';
    subscriberId: string;
    /** The subscription-event kind matched (e.g. 'issue.closed', 'session.finished'). */
    event: string;
    /** What is watched: a dynamic relationship, or an explicit issue / session id. */
    sourceKind: 'relationship' | 'issue' | 'session';
    sourceRef: string;
    deliverNudge: boolean;
    deliverNotify: boolean;
    origin: 'default' | 'custom';
    enabled: boolean;
    createdAt: string;
}
/** One row of the conversation index (camelCase mirror of `conversations`). */
interface ConversationIndexRow {
    id: string;
    agentKind: string;
    providerId: string;
    title?: string;
    /** Command-center-set display name (curation; survives re-discovery). */
    name?: string;
    /** Work-LLM state summary (curation; survives re-discovery). */
    summary?: string;
    projectPath?: string;
    resumeKind?: string;
    resumeValue?: string;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    /** Which machine owns this conversation. Optional in the WIRE shape a daemon reports
     *  (it names itself in the frame, not per row); the store stamps the reporting machine
     *  on every row it writes. */
    machineId?: MachineId;
    /** Set when this conversation is a subagent (sidechain) of another — the resume
     *  picker filters these out so only top-level sessions are offered. */
    /** UNBRANDED BY DECISION: the harness-native conversation id, not Podium's stable ConversationId. */
    parentConversationId?: string;
}
interface ToolCallRow {
    id: string;
    name: string;
    arguments: string;
}
/** One message of a superagent thread (the 'global' orchestrator, or a 'btw_<id>' thread). */
interface SuperagentMessageRow {
    id: number;
    ownerUserId: UserId;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    toolCalls?: ToolCallRow[];
    toolCallId?: string;
    toolName?: string;
    createdAt: string;
}
/** A superagent conversation: the always-there 'global' thread, a per-session 'btw'
 *  thread, or a per-repo 'concierge' intake thread. */
interface SuperagentThreadRow {
    id: string;
    ownerUserId: UserId;
    kind: 'global' | 'btw' | 'concierge';
    originSessionId?: SessionId;
    /** The repo this thread fronts (concierge threads only). */
    repoPath?: string;
    title?: string;
    /** High-water mark into the origin session's transcript (btw threads), or the
     *  issue event-log id already digested (concierge threads, stringified). */
    watermarkItemId?: string;
    watermarkTs?: string;
    /** Harness last run on the thread. Settings is the default; a prompt-box
     *  pick from another connector switches this (and starts a fresh session). */
    agentKind?: string;
    /** The Podium headless session rendering this thread (concierge unification). */
    podiumSessionId?: SessionId;
    /** The harness's own session id — the resume value for every later turn. */
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    harnessSessionId?: string;
    /** PTY session holding the "open in terminal" one-writer lock; sendTurn
     *  rejects while this session is live (lazily checked, lazily cleared). */
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    terminalSessionId?: string;
    /** The thread's own model / effort (POD-782). Undefined = follow the
     *  `superagent` settings role; a value OVERRIDES it, including the role's
     *  fall-through to the `coding` backend. Unlike `agentKind` these are not
     *  frozen — the operator may change them between turns on one conversation. */
    model?: string;
    effort?: string;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
}

/**
 * Events/steward aggregate — owns the durable orchestrator event log
 * (`podium_events`), the steward's KV state (`steward_state`) and the
 * event-subscription tables (`subscriptions`, `subscription_deliveries`,
 * event-subscriptions design Phase B).
 */

interface PodiumEventRecord {
    id: number;
    ts: string;
    kind: string;
    subject: string;
    repoPath: string | null;
    payload: unknown;
}

declare const MachineFailureReason: z.ZodObject<{
    code: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
    source: z.ZodEnum<["machine", "coordinator"]>;
    at: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    message: string;
    at: number;
    source: "machine" | "coordinator";
    code?: string | undefined;
}, {
    message: string;
    at: number;
    source: "machine" | "coordinator";
    code?: string | undefined;
}>;
type MachineFailureReason = z.infer<typeof MachineFailureReason>;

/**
 * The channels an INSTANCE can default its fleet to. Deliberately the same three
 * values as `UpdateChannel` in @podium/model, which is what a single machine may
 * pin — a fleet default and a per-machine override answer the same question at
 * two scopes, so they must range over the same answers (POD-1882). Restated here
 * rather than imported because @podium/runtime is the lower layer.
 */
type FleetUpdateChannel = 'stable' | 'edge' | 'dev';
/** Which machines this instance's updater may replace. See `config.updateScope`. */
type UpdateScope = 'all' | 'fleet-only';
/** Whether this instance mirrors daemon transcripts. See `config.transcriptLake`. */
type TranscriptLakeMode = 'on' | 'off';
/**
 * Which layer answered.
 *
 * `settings` is the persisted instance-tier settings row, and it exists for the
 * instance-scoped keys. Environment and config.json overrides sit above these
 * choices. Bootstrap and operator-only keys never read the settings row.
 */
type SettingSource = 'env' | 'file' | 'settings' | 'default';

/**
 * The blob, COMPOSED from the three classified halves (POD-418). Key order is
 * the historical one; every value is the model's schema instance.
 *
 * Reading the tiers off this object: `roles` / `sidebar` / `autoContinue` and
 * three of four `notifications` members are `preferences-personal`;
 * `hibernation` / `gitWorkflow` / `issues` / `steward` / `experimental` are
 * `preferences-instance`; `apiKeys` / `integrations` /
 * `notifications.telegramBotToken` are `server-secrets`. That mapping is not
 * documentation — it is `SETTINGS_CLASSIFICATION` in `@podium/model`, and
 * `settings.classification.test.ts` fails if this object and that table
 * disagree in either direction.
 */
declare const PodiumSettings: z.ZodObject<{
    /** Every LLM/agent role on one unified shape (SP-6454 B3). Migrated from the
     *  legacy sessionDefaults/superagent/workLlm fields by `normalizeSettings`. */
    roles: z.ZodDefault<z.ZodObject<{
        coding: z.ZodDefault<z.ZodObject<{
            accountId: z.ZodDefault<z.ZodBranded<z.ZodString, "AccountId">>;
            model: z.ZodDefault<z.ZodString>;
            effort: z.ZodDefault<z.ZodString>;
            harness: z.ZodOptional<z.ZodEnum<["claude-code", "codex", "grok", "opencode", "cursor", "pi"]>>;
        } & {
            subagentModel: z.ZodDefault<z.ZodString>;
            subagentStrategy: z.ZodDefault<z.ZodEnum<["builtin", "podium"]>>;
            startScreen: z.ZodDefault<z.ZodEnum<["native", "chat", "auto"]>>;
            seedCliTheme: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            subagentModel: string;
            subagentStrategy: "builtin" | "podium";
            startScreen: "auto" | "native" | "chat";
            seedCliTheme: boolean;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }, {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
            subagentModel?: string | undefined;
            subagentStrategy?: "builtin" | "podium" | undefined;
            startScreen?: "auto" | "native" | "chat" | undefined;
            seedCliTheme?: boolean | undefined;
        }>>;
        superagent: z.ZodDefault<z.ZodObject<{
            accountId: z.ZodDefault<z.ZodBranded<z.ZodString, "AccountId">>;
            model: z.ZodDefault<z.ZodString>;
            effort: z.ZodDefault<z.ZodString>;
            harness: z.ZodOptional<z.ZodEnum<["claude-code", "codex", "grok", "opencode", "cursor", "pi"]>>;
        }, "strip", z.ZodTypeAny, {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }, {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }>>;
        background: z.ZodDefault<z.ZodObject<{
            accountId: z.ZodDefault<z.ZodBranded<z.ZodString, "AccountId">>;
            model: z.ZodDefault<z.ZodString>;
            effort: z.ZodDefault<z.ZodString>;
            harness: z.ZodOptional<z.ZodEnum<["claude-code", "codex", "grok", "opencode", "cursor", "pi"]>>;
        }, "strip", z.ZodTypeAny, {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }, {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }>>;
        shipwright: z.ZodDefault<z.ZodObject<{
            accountId: z.ZodDefault<z.ZodBranded<z.ZodString, "AccountId">>;
            model: z.ZodDefault<z.ZodString>;
            effort: z.ZodDefault<z.ZodString>;
            harness: z.ZodOptional<z.ZodEnum<["claude-code", "codex", "grok", "opencode", "cursor", "pi"]>>;
        }, "strip", z.ZodTypeAny, {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }, {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        superagent: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        coding: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            subagentModel: string;
            subagentStrategy: "builtin" | "podium";
            startScreen: "auto" | "native" | "chat";
            seedCliTheme: boolean;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        background: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        shipwright: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
    }, {
        superagent?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        } | undefined;
        coding?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
            subagentModel?: string | undefined;
            subagentStrategy?: "builtin" | "podium" | undefined;
            startScreen?: "auto" | "native" | "chat" | undefined;
            seedCliTheme?: boolean | undefined;
        } | undefined;
        background?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        } | undefined;
        shipwright?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        } | undefined;
    }>>;
    /** Provider API keys. Stored plaintext in the self-hosted SQLite — same trust
     *  domain as the shell the agents already run in. `server-secrets`: never
     *  replicated and never enqueued once POD-419/POD-420 land. */
    apiKeys: z.ZodDefault<z.ZodObject<{
        openrouter: z.ZodDefault<z.ZodString>;
        anthropic: z.ZodDefault<z.ZodString>;
        openai: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        openrouter: string;
        anthropic: string;
        openai: string;
    }, {
        openrouter?: string | undefined;
        anthropic?: string | undefined;
        openai?: string | undefined;
    }>>;
    integrations: z.ZodDefault<z.ZodObject<{
        linearApiKey: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        linearApiKey: string;
    }, {
        linearApiKey?: string | undefined;
    }>>;
    hibernation: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        memoryPct: z.ZodDefault<z.ZodNumber>;
        loadPerCore: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        maxIdleSessions: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        idleMinutes: z.ZodDefault<z.ZodNumber>;
        idleShellMinutes: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        backstopMinutes: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        memoryPct: number;
        loadPerCore: number | null;
        maxIdleSessions: number | null;
        idleMinutes: number;
        idleShellMinutes: number | null;
        backstopMinutes: number | null;
    }, {
        enabled?: boolean | undefined;
        memoryPct?: number | undefined;
        loadPerCore?: number | null | undefined;
        maxIdleSessions?: number | null | undefined;
        idleMinutes?: number | undefined;
        idleShellMinutes?: number | null | undefined;
        backstopMinutes?: number | null | undefined;
    }>>;
    notifications: z.ZodDefault<z.ZodObject<{
        web: z.ZodDefault<z.ZodBoolean>;
        ntfyTopic: z.ZodDefault<z.ZodString>;
        telegramBotToken: z.ZodDefault<z.ZodString>;
        telegramChatId: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        web: boolean;
        ntfyTopic: string;
        telegramChatId: string;
        telegramBotToken: string;
    }, {
        web?: boolean | undefined;
        ntfyTopic?: string | undefined;
        telegramChatId?: string | undefined;
        telegramBotToken?: string | undefined;
    }>>;
    sidebar: z.ZodDefault<z.ZodObject<{
        repoSort: z.ZodDefault<z.ZodEnum<["alphabetical", "lastUsed", "custom"]>>;
        repoOrder: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        groupByRepo: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        repoSort: "custom" | "alphabetical" | "lastUsed";
        repoOrder: string[];
        groupByRepo: boolean;
    }, {
        repoSort?: "custom" | "alphabetical" | "lastUsed" | undefined;
        repoOrder?: string[] | undefined;
        groupByRepo?: boolean | undefined;
    }>>;
    gitWorkflow: z.ZodDefault<z.ZodObject<{
        defaultParentBranch: z.ZodDefault<z.ZodString>;
        mergeStyle: z.ZodDefault<z.ZodEnum<["ff-only", "pr", "ask"]>>;
        autoRebaseBeforeMerge: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        defaultParentBranch: string;
        mergeStyle: "ask" | "ff-only" | "pr";
        autoRebaseBeforeMerge: boolean;
    }, {
        defaultParentBranch?: string | undefined;
        mergeStyle?: "ask" | "ff-only" | "pr" | undefined;
        autoRebaseBeforeMerge?: boolean | undefined;
    }>>;
    issues: z.ZodDefault<z.ZodObject<{
        assistantEnabled: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        assistantEnabled: boolean;
    }, {
        assistantEnabled?: boolean | undefined;
    }>>;
    /** The steward: the orchestrator's trigger queue over the durable event log
     *  (deterministic unblock nudges etc.). On by default (#470) [spec:SP-17db]:
     *  the feature has been live long enough to be trusted, and the dark default
     *  only broke NEW installs — their Notification triggers silently never fired.
     *  Existing installs are unaffected (the persisted `meta` value wins). */
    steward: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
    }, {
        enabled?: boolean | undefined;
    }>>;
    /** When enabled, the server re-sends `continue` to any session stopped on a
     *  retryable error, on an escalating backoff up to 5 min. `promptDismissed`
     *  suppresses the one-time opt-in popup once the user has answered it. */
    autoContinue: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        promptDismissed: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        promptDismissed: boolean;
    }, {
        enabled?: boolean | undefined;
        promptDismissed?: boolean | undefined;
    }>>;
    /**
     * User toggles for experimental features [spec:SP-f4b9].
     *
     * Draft Sync v2 (POD-859) lives here under `'draft-sync'`; the legacy bespoke
     * `draftSync.enabled` key is migrated onto it by `normalizeSettings` and dropped.
     */
    experimental: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    /** How long a closed issue keeps its checkout, and whether the janitor sweep
     *  only proposes the release or applies it (POD-564). Appended rather than
     *  slotted after `hibernation`: the key order here is a persisted blob's
     *  serialized order. */
    worktreeGc: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<["off", "propose", "auto"]>>;
        afterDays: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        mode: "off" | "auto" | "propose";
        afterDays: number;
    }, {
        mode?: "off" | "auto" | "propose" | undefined;
        afterDays?: number | undefined;
    }>>;
    /** Whether this server mirrors daemon transcripts into its lake (PDM-26).
     *  `PODIUM_TRANSCRIPT_LAKE` and `config.transcriptLake` sit above this row. */
    transcripts: z.ZodDefault<z.ZodObject<{
        mirror: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        mirror?: boolean | undefined;
    }, {
        mirror?: boolean | undefined;
    }>>;
    deployment: z.ZodDefault<z.ZodObject<{
        authOpenMode: z.ZodOptional<z.ZodBoolean>;
        updateChannel: z.ZodOptional<z.ZodEnum<["stable", "edge", "dev"]>>;
        connectEnabled: z.ZodOptional<z.ZodBoolean>;
        telemetryUsage: z.ZodOptional<z.ZodEnum<["on", "off"]>>;
        telemetryCrash: z.ZodOptional<z.ZodEnum<["on", "off"]>>;
        telemetryInstallId: z.ZodOptional<z.ZodString>;
        telemetrySince: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        updateChannel?: "dev" | "edge" | "stable" | undefined;
        authOpenMode?: boolean | undefined;
        connectEnabled?: boolean | undefined;
        telemetryUsage?: "off" | "on" | undefined;
        telemetryCrash?: "off" | "on" | undefined;
        telemetryInstallId?: string | undefined;
        telemetrySince?: number | undefined;
    }, {
        updateChannel?: "dev" | "edge" | "stable" | undefined;
        authOpenMode?: boolean | undefined;
        connectEnabled?: boolean | undefined;
        telemetryUsage?: "off" | "on" | undefined;
        telemetryCrash?: "off" | "on" | undefined;
        telemetryInstallId?: string | undefined;
        telemetrySince?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    issues: {
        assistantEnabled: boolean;
    };
    roles: {
        superagent: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        coding: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            subagentModel: string;
            subagentStrategy: "builtin" | "podium";
            startScreen: "auto" | "native" | "chat";
            seedCliTheme: boolean;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        background: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        shipwright: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
    };
    sidebar: {
        repoSort: "custom" | "alphabetical" | "lastUsed";
        repoOrder: string[];
        groupByRepo: boolean;
    };
    autoContinue: {
        enabled: boolean;
        promptDismissed: boolean;
    };
    notifications: {
        web: boolean;
        ntfyTopic: string;
        telegramChatId: string;
        telegramBotToken: string;
    };
    hibernation: {
        enabled: boolean;
        memoryPct: number;
        loadPerCore: number | null;
        maxIdleSessions: number | null;
        idleMinutes: number;
        idleShellMinutes: number | null;
        backstopMinutes: number | null;
    };
    gitWorkflow: {
        defaultParentBranch: string;
        mergeStyle: "ask" | "ff-only" | "pr";
        autoRebaseBeforeMerge: boolean;
    };
    steward: {
        enabled: boolean;
    };
    experimental: Record<string, boolean>;
    worktreeGc: {
        mode: "off" | "auto" | "propose";
        afterDays: number;
    };
    transcripts: {
        mirror?: boolean | undefined;
    };
    deployment: {
        updateChannel?: "dev" | "edge" | "stable" | undefined;
        authOpenMode?: boolean | undefined;
        connectEnabled?: boolean | undefined;
        telemetryUsage?: "off" | "on" | undefined;
        telemetryCrash?: "off" | "on" | undefined;
        telemetryInstallId?: string | undefined;
        telemetrySince?: number | undefined;
    };
    apiKeys: {
        openrouter: string;
        anthropic: string;
        openai: string;
    };
    integrations: {
        linearApiKey: string;
    };
}, {
    issues?: {
        assistantEnabled?: boolean | undefined;
    } | undefined;
    roles?: {
        superagent?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        } | undefined;
        coding?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
            subagentModel?: string | undefined;
            subagentStrategy?: "builtin" | "podium" | undefined;
            startScreen?: "auto" | "native" | "chat" | undefined;
            seedCliTheme?: boolean | undefined;
        } | undefined;
        background?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        } | undefined;
        shipwright?: {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        } | undefined;
    } | undefined;
    sidebar?: {
        repoSort?: "custom" | "alphabetical" | "lastUsed" | undefined;
        repoOrder?: string[] | undefined;
        groupByRepo?: boolean | undefined;
    } | undefined;
    autoContinue?: {
        enabled?: boolean | undefined;
        promptDismissed?: boolean | undefined;
    } | undefined;
    notifications?: {
        web?: boolean | undefined;
        ntfyTopic?: string | undefined;
        telegramChatId?: string | undefined;
        telegramBotToken?: string | undefined;
    } | undefined;
    hibernation?: {
        enabled?: boolean | undefined;
        memoryPct?: number | undefined;
        loadPerCore?: number | null | undefined;
        maxIdleSessions?: number | null | undefined;
        idleMinutes?: number | undefined;
        idleShellMinutes?: number | null | undefined;
        backstopMinutes?: number | null | undefined;
    } | undefined;
    gitWorkflow?: {
        defaultParentBranch?: string | undefined;
        mergeStyle?: "ask" | "ff-only" | "pr" | undefined;
        autoRebaseBeforeMerge?: boolean | undefined;
    } | undefined;
    steward?: {
        enabled?: boolean | undefined;
    } | undefined;
    experimental?: Record<string, boolean> | undefined;
    worktreeGc?: {
        mode?: "off" | "auto" | "propose" | undefined;
        afterDays?: number | undefined;
    } | undefined;
    transcripts?: {
        mirror?: boolean | undefined;
    } | undefined;
    deployment?: {
        updateChannel?: "dev" | "edge" | "stable" | undefined;
        authOpenMode?: boolean | undefined;
        connectEnabled?: boolean | undefined;
        telemetryUsage?: "off" | "on" | undefined;
        telemetryCrash?: "off" | "on" | undefined;
        telemetryInstallId?: string | undefined;
        telemetrySince?: number | undefined;
    } | undefined;
    apiKeys?: {
        openrouter?: string | undefined;
        anthropic?: string | undefined;
        openai?: string | undefined;
    } | undefined;
    integrations?: {
        linearApiKey?: string | undefined;
    } | undefined;
}>;
type PodiumSettings = z.infer<typeof PodiumSettings>;

/** One edge endpoint in a dep report: enough to render "#12 title (open, blocks)". */
interface DepReportRef {
    seq: number;
    title: string;
    type: string;
    closed: boolean;
}
/** Per-issue dependency status inside a set (epic subtree or repo) — see depReport(). */
interface DepReportEntry {
    id: IssueId;
    seq: number;
    title: string;
    stage: string;
    priority: number;
    closed: boolean;
    blocked: boolean;
    ready: boolean;
    /** Outgoing deps: issues this one waits on. */
    deps: DepReportRef[];
    /** Incoming deps: issues waiting on this one. */
    dependents: DepReportRef[];
}

/**
 * The send vocabulary — the nouns every messages module and every caller of the
 * delivery service speaks (POD-1397).
 *
 * These types were declared in `service.ts` and imported from there by the issue
 * registry, the session command plane and the mailbox surface. They live here so
 * that a module which speaks them does not have to import the service that
 * implements them: a type-only cycle still binds two files together in a
 * reader's head, and it is the same "each half reaches into the other" shape a
 * split is supposed to remove.
 *
 * `service.ts` re-exports them, so existing importers are unaffected.
 */

/** What actually happened to a send, surfaced to the sender so a message that
 *  reached no one is never a bare success [POD-834 §04b]:
 *   - `delivered`   CONFIRMED in the target's transcript (echo or turn boundary),
 *                   or injection-is-delivery for an unwrapped operator body;
 *   - `queued`      handed on toward the target (the daemon's delivery queue, or
 *                   held for a parked target's next run) — NOT yet confirmed;
 *                   the daemon's settlement confirms it later [POD-4661];
 *   - `held`        issue-addressed, issue live but NO live session — held for
 *                   the issue's next session (delivered at its next boundary);
 *   - `spawning`    a wake spawned a fresh agent to receive it;
 *   - `dead_letter` the target was gone; NOT delivered. */
type SendDisposition = 'delivered' | 'queued' | 'held' | 'spawning' | 'dead_letter';

/** One artifact's stored content, as `panelArtifactRead` answers it. */
interface IssueArtifactContent {
    /** 1-based position in the issue's artifact list — what the CLI prints. */
    index: number;
    /** Source path the artifact was added from. */
    path: string;
    title?: string;
    addedAt: string;
    artifactId: ArtifactId;
    /** Primary file of the snapshot bundle. */
    entry: string;
    files: {
        path: string;
        size: number;
    }[];
    /** Relpath actually read (`entry` unless the caller asked for another). */
    file: string;
    contentType: string;
    size: number;
    /** Streaming alternative to `dataBase64`, on the same server. */
    url: string;
    dataBase64: string;
}

type NetworkOption = 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual';

/**
 * Live per-agent model lists for ONE machine.
 *
 * KEYED BY `machineId`, deliberately: which models a harness offers is a fact
 * about a specific machine (ADR 1 Amendment 1 D13.5 — visibility class
 * `owned-compute`, owner inherits Machine). An instance-global singleton cannot
 * express that — with two machines whose installed harnesses differ, an unkeyed
 * cache reports whichever host probed last to every user. Carrying the id on the
 * value makes "which machine is this about?" unanswerable-by-accident, matching
 * `MachineHarnessInventory` in `@podium/harness`.
 *
 * This type carries no principal: no owner, no user id, no grant. Authorization
 * is applied at the server projection boundary (POD-1079).
 */
interface ModelCatalogSnapshot {
    /** The machine this fact is ABOUT — the scoping key, not decoration. */
    machineId: MachineId;
    /** Live models keyed by agent kind (grok/cursor/opencode). Absent agents fall
     *  back to the web's static catalog. */
    byAgent: Record<string, ModelChoiceWire[]>;
    /** Epoch ms of the last successful probe; 0 = never fetched yet. */
    fetchedAt: number;
    /** Shape version — a persisted snapshot with a different version is discarded. */
    version?: number;
}

interface WaveMachine {
    id: string;
    name?: string;
    channel?: UpdateChannel;
    version: string;
    state: ConvergenceState;
    online: boolean;
    /** Busy is only a canary preference; sessions survive the restart. */
    busy: boolean;
    detail?: string;
    reason?: MachineFailureReason;
    /**
     * How far this machine's current phase has got, as its last heartbeat said
     * (POD-2101). Absent for a daemon that predates progress reporting, or for a
     * delivery whose length nothing declared — never a manufactured zero.
     */
    percent?: number;
    /** The phase that percentage is about — `downloading`, and nothing else now. */
    phaseDetail?: string;
    /**
     * Whether this daemon owns a packaged install that a fleet grant can replace.
     * Absent for older reports and therefore deliberately eligible: uncertainty
     * must stay visible rather than silently dropping a machine from a wave.
     */
    installKind?: string;
    /**
     * How this machine can take delivery, as its daemon reported at handshake
     * (`deliveryCaps` in apps/daemon/src/build-report.ts): an INSTALLED machine
     * offers `update.delivery.feed`, and a machine running from SOURCE offers no
     * delivery at all — it has no install directory to swap. Absent for a machine
     * that has never reported a build.
     */
    deliveryCaps?: readonly string[];
    /**
     * Which compatibility-window presence path owns this row. Supervisor reports
     * are authoritative: an empty capability list is an explicit inability to
     * take delivery, while an old daemon's absent/empty list remains unknown.
     */
    presenceSource?: MachinePresenceSource;
    /** Display-only explanation for an explicit lack of delivery capability. */
    deliveryUnavailableReason?: string;
    /**
     * WHICH BYTES THIS MACHINE COULD EVEN RUN (POD-2783), in the release
     * manifest's own vocabulary — `darwin-aarch64`, `linux-x86_64` — derived from
     * the os/arch its daemon reported at handshake through `platformTargetFor`,
     * which is the same function the mint keys the manifest by.
     *
     * Absent for a machine that has never reported an inventory, and absent means
     * ELIGIBLE for the reason absent `deliveryCaps` does: a machine that has not
     * said what it is must stay visible rather than be silently stranded.
     */
    platform?: string;
    /**
     * DOES THIS SERVER'S OWN COORDINATOR RUN HERE (POD-3170)?
     *
     * True for exactly one machine — the host whose parent supervises the process
     * planning this round. Replacing it is not one machine's update among several:
     * it takes down the socket every other grant went out on, the artifact route
     * every other machine is downloading from, and the in-memory grant bookkeeping
     * that would let the successor notice. See {@link decideWave}.
     *
     * Absent means "not the coordinator", which is the safe direction: a fleet
     * whose composition root never states this simply plans as it did before.
     */
    coordinator?: boolean;
}

/** What one channel's last release-target lookup produced. */
type ChannelCheckOutcome = {
    status: 'ok';
} | {
    status: 'unavailable';
    reason: string;
};
/**
 * One channel's refresh bookkeeping — the answer to "when did this instance last
 * ask, and what did it hear?".
 *
 * Without it a boot-time failure is indistinguishable from a target that was
 * checked a minute ago and genuinely has nothing published, which is exactly the
 * state Settings has to be able to describe ("checked 2 h ago"). Spec §9.2 makes
 * the cadence part of the contract: shown, not implied.
 */
interface ChannelCheckRecord {
    channel: UpdateChannel;
    checkedAt: number;
    outcome: ChannelCheckOutcome;
}
/** The one decision an explicit per-machine Apply can produce. */
type MachineApplyOutcome = {
    result: 'granted';
    version: string;
} | {
    result: 'already-current';
    version: string;
} | {
    result: 'source-checkout';
} | {
    result: 'offline';
} | {
    result: 'unknown-machine';
} | {
    result: 'no-target';
    reason: string;
} | {
    result: 'in-flight';
    state: ConvergenceState;
} | {
    result: 'legacy-instance-trust';
    version: string;
}
/**
 * THE TWO ANSWERS THAT ARE NOT ABOUT TODAY (POD-2783).
 *
 * A release's platform list is fixed when it is minted, from the fleet as it
 * stood then, so a machine that enrolled afterwards can never take that
 * release however many times a human presses Apply. `platform-not-published`
 * is the harder version: Podium builds nothing for that platform at all.
 * Both carry the platform, because a row that says "no" without saying what
 * it is is the sentence this issue exists to delete.
 */
 | {
    result: 'platform-not-in-release';
    platform: string;
} | {
    result: 'platform-not-published';
    platform: string;
};

interface ScanReposResult {
    repositories: GitRepositoryWire[];
    diagnostics: GitDiscoveryDiagnosticWire[];
}
/** Outcome of a daemon-executed operation (git op / harness one-shot). */
interface OpResult {
    ok: boolean;
    output: string;
}
/** A transcript window slice as served to the chat view. */
interface TranscriptSlice {
    /** The cursor source changed; replace the held window instead of appending. */
    reset?: boolean;
    items: TranscriptItem[];
    head?: string;
    tail?: string;
    hasMore: boolean;
    /** The session's machine has no live daemon socket, so this page is the best
     *  the server could do without it (POD-4808). Present whenever the machine is
     *  offline — even when the lake served mirrored history — so an empty page
     *  does not read as "done" and a live-looking session still names its machine.
     *  The name is resolved server-side from the machines table (the same presence
     *  source as requireOnlineSession), never matched from text. */
    offline?: {
        machineName: string;
    };
}

interface SessionSpawnResult {
    sessionId: SessionId;
    agentId: string;
    harness: AgentKind;
    model: string | null;
    effort: string | null;
    machine: string;
    machineId: MachineId;
    accountId: AccountId | null;
    /** The task prompt as its spawner's message, when a session spawned this one
     *  and the prompt is queued rather than launched with the process (POD-4778):
     *  the id the spawner checks with `podium mail status`. */
    promptMessageId?: string;
}

/**
 * PER-SESSION PHASE HISTORY (POD-1854) — the durable on/off record behind the
 * Flight Deck waterfall's segmented bars.
 *
 * `AgentRuntimeState` is a snapshot: `since` is overwritten on every flip and
 * `workingMsTotal` folds all past stretches into one integer, so "worked,
 * waited for review, worked again" is unreconstructable from `SessionMeta`.
 * The bus, however, already narrates every transition (`session.stateChanged`
 * carries prev AND next), and `podium_events` is subject-indexed. This module
 * mirrors the fleet-level `AgentConcurrencyHistory` recorder one level down:
 * one `session.phase_sample` event per real phase flip, keyed by the session id.
 *
 * The log is observational. Append failures are swallowed for the same reason
 * the concurrency recorder swallows them: a full or read-only event store must
 * never interfere with the agent-state transition it is watching. Absence of
 * rows is a legal state (sessions born before this feature, pruned history) —
 * readers must treat "no samples" as "no segmentation known", not as idle.
 */

interface SessionPhaseSample {
    /** ISO timestamp of the transition. */
    at: string;
    phase: AgentPhase;
}
interface SessionActivityHistoryResult {
    sampledAt: string;
    /** Missing key = no recorded history for that session (NOT "always idle"). */
    sessions: Record<string, SessionPhaseSample[]>;
}

interface AgentConcurrencyBucket {
    start: string;
    count: number;
}
interface AgentConcurrencyHistoryResult {
    sampledAt: string;
    bucketMs: number;
    peak: number;
    buckets: AgentConcurrencyBucket[];
}

type NativeLoginAttemptStatus = 'running' | 'refreshing' | 'succeeded' | 'failed';
type NativeLoginAttempt = Pick<SessionMeta, 'sessionId'> & Required<Pick<SessionMeta, 'machineId'>> & {
    machineName: MachineProjection['name'];
    status: NativeLoginAttemptStatus;
    error?: string;
};

type ReclaimDiskEstimateState = {
    status: 'unknown';
    recoverableBytes: null;
    measuredAt: null;
    error?: string;
} | {
    status: 'measuring';
    recoverableBytes: null;
    measuredAt: null;
} | {
    status: 'ready';
    recoverableBytes: number;
    measuredAt: string;
};

type OperationActionResult = Record<string, unknown>;

interface TelegramSetupStartResult {
    setupId: string;
    code: string;
    botUsername: string;
    telegramUrl: string;
    expiresAt: string;
}

/** A row in the Accounts hub. Native rows are observed from the machine catalog;
 * managed rows reflect what Podium stores. */
interface AccountView {
    /** Stable id, e.g. "native:claude-code" or "native:claude-code:<fingerprint>". */
    id: string;
    provider: string;
    source: 'native' | 'managed';
    /** Managed only: how the credential would be injected. */
    kind?: 'api-key' | 'oauth';
    /** Native only: which harness login this is. */
    harness?: HarnessAgent;
    /** Observed, human-facing: an email/plan, a masked key, or a hint. */
    identity?: string;
    /** Native identities may be present on several machines. */
    machines?: string[];
    /** Non-secret identity fingerprint used to distinguish multiple native logins. */
    identityFingerprint?: string;
    status: 'connected' | 'not-configured' | 'unknown';
    /**
     * Native Codex only: the machine whose login the server AI runs on, resolved
     * by the same scoped picker as the one-shot transport (POD-4750). Absent
     * when no login is usable for the viewer — the row still lists every
     * machine that reports the login via `machines`.
     *
     * `lastError` is the background role's last refusal text (POD-4805), when
     * the issue assistant has recorded one. It is present even when no machine
     * could be picked, so Settings says why the server AI is failing instead of
     * looking fine.
     */
    serverAi?: {
        machineId?: MachineId;
        machineName?: string;
        lastError?: string;
    };
    /** Managed only: where the credential actually lives. */
    credentialSource?: 'stored' | 'legacy';
    loginRequired?: boolean;
    loginAttempt?: NativeLoginAttempt;
    loginMachines?: {
        id: MachineId;
        name: string;
    }[];
}

/** A tier's resolved consent. 'absent' = never asked. */
type ConsentState = 'on' | 'off' | 'absent';
/** Why telemetry is force-disabled, for UI that must explain itself. */
type SuppressionReason = 'DO_NOT_TRACK' | 'PODIUM_TELEMETRY';
interface TelemetryState {
    usage: ConsentState;
    crash: ConsentState;
    /** Present once the user has opted into anything (minted on first opt-in, not at install). */
    installId?: string;
    /** Epoch ms the clock started — set with installId on first opt-in (D5). */
    since?: number;
    /** Set ⇒ both tiers are forced off regardless of the stored values. */
    suppressedBy?: SuppressionReason;
    /** Where reports would be POSTed (resolved through the full precedence). */
    endpoint: string;
}

/** One durable turn failure, as `latestTurnFailure` serves it. `userText` is
 *  null when the turn reached a harness (the transcript carries the prompt);
 *  the user row is persisted only for turns that provably never dispatched. */
interface SuperagentTurnFailure {
    inputId: string;
    userText: string | null;
    error: string;
    at: string;
}

/** What `mail.send` answers with, narrowed to the keys the chat paths return.
 *  Exported because it is the INFERRED return type of two tRPC procedures — an
 *  unnameable local type here becomes `unknown` on the client. */
interface SubstrateOutcome {
    ok: boolean;
    queued?: boolean;
    reason?: string;
    position?: number;
    disposition: SendDisposition;
}

type CloudRuntimeKind = 'cloud-machine' | 'cloud-agent';
type CloudRuntimeState = 'provisioning' | 'running' | 'stopped' | 'failed';
interface CloudProviderCapabilities {
    provider: string;
    cloudMachines: boolean;
    cloudAgents: boolean;
    previews: boolean;
    artifacts: boolean;
    wake: boolean;
    suspend: boolean;
    destroy: boolean;
}
interface CloudRuntime {
    id: string;
    kind: CloudRuntimeKind;
    tenantId: string;
    state: CloudRuntimeState;
    provider: string;
    displayName: string;
    machineId: MachineId;
    createdAt: string;
    updatedAt: string;
    previewBaseUrl?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
}

/**
 * THE REACHABILITY VOCABULARY (POD-4534). `connect.check` asks Podium Connect to
 * probe a public URL from the outside and say precisely why it does not work;
 * these are the codes it can answer with, and the one human sentence each one
 * is shown as during setup.
 *
 * Pure strings, no IO — which is why this lives in @podium/runtime rather than
 * beside the signed HTTP client: the CLI setup flow (node-only) and, later, the
 * web setup screen (browser-safe, via `trpc.connect.check`) share the wording
 * without either dragging the other's transport along.
 */
type CheckError = 'INVALID_URL' | 'DNS_FAILED' | 'PRIVATE_ADDRESS' | 'REDIRECTED' | 'TLS_INVALID' | 'PORT_NOT_REACHABLE' | 'UNREACHABLE' | 'NOT_PODIUM' | 'IDENTITY_MISMATCH'
/** Connect itself could not be reached or refused the request. Never a failed check. */
 | 'CONNECT_UNAVAILABLE';

/**
 * [spec:SP-3701] Tiered repo discovery for a (newly paired or reconnecting) machine —
 * POD-787. Answers "what repos does this machine have?" without ever walking blindly:
 *
 *   T1 probe    — exact-path probes derived from repos registered on OTHER machines
 *                 (raw path + home-translated `~/…` form). maxDepth 0: a handful of
 *                 stats on the daemon, no walk. The common "same layout on my laptop"
 *                 case completes here in milliseconds.
 *   T2 adjacent — a shallow walk (depth 2) of the PARENT directories of everything
 *                 known on that machine (registered + T1 hits): repos cluster, so
 *                 siblings of known repos are where the rest usually live.
 *   T3 sweep    — a bounded $HOME walk (depth 4, standard ignore list). Only when
 *                 `deep: true` (the explicit "scan this machine" action) — never on
 *                 the automatic connect trigger, so reconnects stay cheap.
 *
 * All walking happens ON THE DAEMON (the target machine); the hub only awaits RPC
 * replies, so nothing here contends with the hub main loop or session reattach.
 *
 * Registration policy: a discovered repo whose origin URL matches a repo already
 * registered on another machine is auto-registered (identity converges to the same
 * repo_id via deriveRepoId, so it is unambiguously "the same repo, here too");
 * anything else is returned as a candidate for the user to confirm — never a
 * silent add.
 */
type DiscoveredRepo = {
    path: string;
    originUrl?: string;
    branch?: string;
    status: 'registered' | 'auto-registered' | 'candidate';
    /** Names of other machines that carry the same repo (origin match). */
    alsoOn: string[];
};

type DirectoryBrowserEntry = {
    name: string;
    path: string;
};

interface UpdateFleetMachine {
    id: MachineId;
    name?: string;
    version: string;
    state: ConvergenceState;
    online: boolean;
    busy: boolean;
    detail?: string;
    reason?: WaveMachine['reason'];
}
interface UpdateFleetBlocker {
    id: MachineId;
    name?: string;
    reason: 'legacy-instance-trust';
}
interface UpdateFleetSnapshot {
    /** Running coordinator version; additive so an older web bundle can ignore it. */
    appVersion?: string;
    /** Running coordinator source identity; authoritative when comparing build labels. */
    sourceDigest?: string;
    /** Served desktop-web checkout identity. A digest is comparison evidence, not display copy. */
    servedWebDigest?: string;
    /** Served phone bundle identity, absent when this installation has no phone export. */
    servedMobileWeb?: MobileWebIdentity;
    targetVersion: string | null;
    total: number;
    behind: number;
    converging: number;
    failed: number;
    /** Machines that are behind but cannot safely join this wave without host-local repair. */
    blocked?: number;
    /** Kept separate from the grantable machine set: visible, but never authorized. */
    blockers?: UpdateFleetBlocker[];
    preparation?: {
        webReady: boolean;
        bundleReady: boolean;
        failureDetail?: string;
    };
    machines: UpdateFleetMachine[];
    /**
     * Every registered machine, whatever its channel. `machines` above is the
     * dev-authority wave the global dialog accounts for; Settings needs one row
     * per machine so an edge/stable row can show its own convergence.
     */
    allMachines: UpdateFleetMachine[];
    /**
     * When each channel in use was last checked and what came back (POD-2100).
     * ADDITIVE and tolerant of absence per the frozen-contract law (spec P8): an
     * old bundle rendering a new server ignores it, and a channel that has never
     * been checked has no entry rather than a fabricated one.
     */
    channelChecks: ChannelCheckRecord[];
    /** Whether the server would accept the update action represented by this snapshot. */
    startability?: UpdateStartability;
    /**
     * The durable operation currently converging this fleet, if one is (POD-2098).
     *
     * ADDITIVE, and deliberately only an id: this payload is the OLD read model
     * and it stays exactly as it was, so the current dialog and Settings do not
     * change. The id is the thread from here to `operations.active`, which the
     * update panel picks up in its own issue. An old bundle ignores it (P8).
     */
    operationId?: string;
    operation?: {
        id: string;
        failureReason?: string;
    };
    /**
     * A version published while the operation ran, waiting its turn (§3.2). Shown
     * so "0.4.4 arrived and will be offered when this finishes" is sayable rather
     * than a target that silently changes underneath the panel.
     */
    nextTargetVersion?: string;
}
/**
 * The preconditions that must refuse BEFORE an operation exists (§6.3).
 *
 * "Never show an internal precondition as an error" cuts both ways: the panel
 * must not render one, and the server must not manufacture an operation that
 * exists only to fail with one. A refusal here is the same sentence the old
 * `startUpdate` produced, so the current dialog's copy is unchanged.
 */
type UpdateStartability = {
    startable: true;
} | {
    startable: false;
    reason: string;
};

/**
 * Server-side experimental feature flags [spec:SP-f4b9].
 *
 * Resolves the shared protocol registry against config.json overrides,
 * user settings, update channel, and the dev-mode version sentinel.
 */

interface FeatureStateWire extends FeatureState {
    id: string;
    name: string;
    description: string;
    visibility: FeatureVisibility;
}

type Input_cloud_createMachine = {
    tenantId: string;
    displayName: string;
    size: "small" | "medium" | "large";
    repo?: {
        provider: "github";
        owner: string;
        name: string;
        ref?: string | undefined;
    } | undefined;
    purpose?: string | undefined;
};
type Input_cloud_createAgent = {
    tenantId: string;
    displayName: string;
    repo: {
        provider: "github";
        owner: string;
        name: string;
        ref?: string | undefined;
    };
    size?: "small" | "medium" | "large" | undefined;
    purpose?: string | undefined;
    issueId?: string | undefined;
    sourceSession?: {
        sessionId: string;
        agent: "claude-code" | "codex";
        resumeRef?: string | undefined;
        cwd?: string | undefined;
        machineId?: string | undefined;
    } | undefined;
};
type Input_cloud_moveSession = {
    tenantId: string;
    sessionId: string;
    size?: "small" | "medium" | "large" | undefined;
    repo?: {
        provider: "github";
        owner: string;
        name: string;
        ref?: string | undefined;
    } | undefined;
    hibernateLocal?: boolean | undefined;
};
type Output_sessions_stop = ({
    ok: boolean;
    reason: string;
}) | ({
    ok: boolean;
    reason?: string;
    worktreeFreed?: boolean;
    deferredKill?: boolean;
});
type Input_sessions_answerAskUserQuestion = {
    sessionId: string;
    interactionId?: string | undefined;
    skip?: true | undefined;
    choices?: ({
        optionIndices: number[];
        multiSelect?: boolean | undefined;
        previewLayout?: boolean | undefined;
    } | {
        freeText: string;
        otherIndex: number;
        multiSelect?: boolean | undefined;
        previewLayout?: boolean | undefined;
    })[] | undefined;
};
type Output_sessions_configure = ({
    reason: "not_running";
    detail: string;
}) | ({
    ok: true;
    effective: "immediate" | "next-turn";
}) | ({
    reason: "needs_user" | "busy" | "not_running" | "lease_held" | "unsupported" | "no_resume_ref" | "session_ended" | "staging_failed" | "no_archive_yet" | "invalid_value";
    detail?: string | undefined;
    cause?: "not-accepting-input" | "unconfirmed" | "rejected-by-agent" | "dropped-by-agent" | "not-recorded" | "agent-exited" | undefined;
});
type Input_sessions_create = {
    cwd: string;
    issueId?: string | undefined;
    sessionId?: string | undefined;
    machineId?: string | undefined;
    model?: string | undefined;
    effort?: string | undefined;
    agentKind?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell" | undefined;
    title?: string | undefined;
    workflowRevisionId?: string | undefined;
    initialPrompt?: string | undefined;
    forceUnknownModel?: boolean | undefined;
    draftIssue?: {
        repoPath: string;
        issueId?: string | undefined;
    } | undefined;
    draftArtifacts?: {
        id: string;
        filename: string;
        mimeType: string;
        dataBase64: string;
    }[] | undefined;
    requestedDriverId?: string | undefined;
    mutationId?: string | undefined;
};
type Output_sessions_interrupt = ({
    ok: true;
    requested: "keystroke" | "protocol" | "retraction";
    reason?: undefined;
}) | ({
    ok: false;
    reason: string;
    requested?: undefined;
}) | ({
    readonly ok: true;
    readonly requested: "retraction";
}) | ({
    ok: boolean;
    reason: string;
});
type Input_sessions_resume = {
    cwd: string;
    resume: {
        value: string;
        kind: string;
    };
    agentKind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell";
    conversationId: string;
    machineId?: string | undefined;
    title?: string | undefined;
};
type Input_sessions_resumeAndSend = {
    sessionId: string;
    text: string;
    mutationId?: string | undefined;
    attachments?: {
        path: string;
        id: string;
        filename: string;
        kind: "image" | "file";
        mediaType: string;
    }[] | undefined;
};
type Output_sessions_uploadImage = ({
    path: string;
    error?: string;
}) | ({
    refusal: {
        reason: "needs_user" | "busy" | "not_running" | "lease_held" | "unsupported" | "no_resume_ref" | "session_ended" | "staging_failed" | "no_archive_yet" | "invalid_value";
        detail?: string | undefined;
        cause?: "not-accepting-input" | "unconfirmed" | "rejected-by-agent" | "dropped-by-agent" | "not-recorded" | "agent-exited" | undefined;
    };
    path?: undefined;
    attachment?: undefined;
}) | ({
    path: string;
    attachment: {
        path: string;
        id: string;
        filename: string;
        kind: "image" | "file";
        mediaType: string;
    };
    refusal?: undefined;
});
type Input_sessions_setWorkState = {
    sessionId: string;
    workState: "planning" | "done" | "implementing" | "testing" | "icebox" | null;
    mutationId?: string | undefined;
};
type Input_superagent_sendTurn = {
    text: string;
    model?: string | undefined;
    effort?: string | undefined;
    agentKind?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
    threadId?: string | undefined;
    focus?: {
        issueId?: string | undefined;
        worktreePath?: string | undefined;
        view?: string | undefined;
        focusedSessionId?: string | undefined;
        visibleSessionIds?: string[] | undefined;
        filePath?: string | undefined;
        openFilePaths?: string[] | undefined;
        openIssueId?: string | undefined;
    } | undefined;
    attachSessionId?: string | undefined;
};
type Input_superagent_concierge = {
    repoPath: string;
    text: string;
    focus?: {
        issueId?: string | undefined;
        worktreePath?: string | undefined;
        view?: string | undefined;
        focusedSessionId?: string | undefined;
        visibleSessionIds?: string[] | undefined;
        filePath?: string | undefined;
        openFilePaths?: string[] | undefined;
        openIssueId?: string | undefined;
    } | undefined;
};
type Output_settings_updatePersonal = {
    experimental: Record<string, boolean>;
    issues: {
        assistantEnabled: boolean;
    };
    roles: {
        superagent: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        coding: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            subagentModel: string;
            subagentStrategy: "builtin" | "podium";
            startScreen: "auto" | "native" | "chat";
            seedCliTheme: boolean;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        background: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
        shipwright: {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        };
    };
    apiKeys: {
        openrouter: string;
        anthropic: string;
        openai: string;
    };
    integrations: {
        linearApiKey: string;
    };
    hibernation: {
        enabled: boolean;
        memoryPct: number;
        loadPerCore: number | null;
        maxIdleSessions: number | null;
        idleMinutes: number;
        idleShellMinutes: number | null;
        backstopMinutes: number | null;
    };
    notifications: {
        web: boolean;
        ntfyTopic: string;
        telegramChatId: string;
        telegramBotToken: string;
    };
    sidebar: {
        repoSort: "custom" | "alphabetical" | "lastUsed";
        repoOrder: string[];
        groupByRepo: boolean;
    };
    gitWorkflow: {
        defaultParentBranch: string;
        mergeStyle: "ask" | "ff-only" | "pr";
        autoRebaseBeforeMerge: boolean;
    };
    steward: {
        enabled: boolean;
    };
    autoContinue: {
        enabled: boolean;
        promptDismissed: boolean;
    };
    worktreeGc: {
        mode: "auto" | "off" | "propose";
        afterDays: number;
    };
    transcripts: {
        mirror?: boolean | undefined;
    };
    deployment: {
        authOpenMode?: boolean | undefined;
        updateChannel?: "stable" | "edge" | "dev" | undefined;
        connectEnabled?: boolean | undefined;
        telemetryUsage?: "off" | "on" | undefined;
        telemetryCrash?: "off" | "on" | undefined;
        telemetryInstallId?: string | undefined;
        telemetrySince?: number | undefined;
    };
};
type Input_settings_setSecret = {
    value: string;
    key: "apiKeys.openrouter" | "apiKeys.anthropic" | "apiKeys.openai" | "integrations.linearApiKey" | "notifications.telegramBotToken";
};
type Input_settings_clearSecret = {
    key: "apiKeys.openrouter" | "apiKeys.anthropic" | "apiKeys.openai" | "integrations.linearApiKey" | "notifications.telegramBotToken";
};
type Output_settings_telegramSetupPoll = ({
    status: "pending";
    expiresAt: string;
}) | ({
    status: "expired";
}) | ({
    status: "connected";
    chatId: string;
    chatType: string;
    chatLabel?: string;
    settings: PodiumSettings;
});
type Input_perf_report = {
    sessionId: string;
    mode: "unknown" | "native" | "chat";
    switchId: string;
    startedAt: number;
    cold: boolean;
    totalMs: number;
    timedOut: boolean;
    marks: {
        name: string;
        atMs: number;
        meta?: Record<string, string | number | boolean> | undefined;
    }[];
    issueId?: string | null | undefined;
    meta?: Record<string, string | number | boolean> | undefined;
};
type Output_features_state = {
    devMode: boolean;
    channel: "stable" | "edge";
    flags: FeatureStateWire[];
};
type Output_telemetry_preview = (null) | ({
    sessions: Partial<Record<"claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell", number>>;
    machines: "1" | "2-5" | "6-20" | "20+";
    features: Partial<Record<"issues", boolean>>;
    installId: string;
    schema: 1;
    version: string;
    os: "linux" | "darwin" | "win32" | "other";
    arch: "other" | "x64" | "arm64";
    installAge: "0d" | "1-7d" | "8-30d" | "31-90d" | "90d+";
});
type Output_accounts_login = Pick<{
    status: "starting" | "live" | "reconnecting" | "hibernated" | "exited";
    sessionId: string & z.BRAND<"SessionId">;
    cwd: string;
    agentKind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell";
    title: string;
    archived: boolean;
    createdAt: string;
    controllerId: string | null;
    geometry: {
        cols: number;
        rows: number;
    };
    epoch: number;
    clientCount: number;
    lastActiveAt: string;
    origin: {
        kind: "spawn";
    } | {
        kind: "resume";
        conversationId: string;
    };
    name?: string | undefined;
    issueId?: (string & z.BRAND<"IssueId">) | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    resume?: {
        value: string;
        kind: string;
    } | undefined;
    model?: string | undefined;
    effort?: string | undefined;
    requestedDriverId?: string | undefined;
    delegation?: {
        actor: string & z.BRAND<"AgentIdentityId">;
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
        grantedScope: {
            kind: "all";
        } | {
            kind: "none";
        } | {
            kind: "subtree";
            rootId: string & z.BRAND<"IssueId">;
        } | {
            kind: "owned";
            userId: string & z.BRAND<"UserId">;
        } | {
            kind: "self";
            userId: string & z.BRAND<"UserId">;
        };
        parentBindingId: (string & z.BRAND<"SessionId">) | null;
        revision: number;
    } | undefined;
    createdBy?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    accountId?: (string & z.BRAND<"AccountId">) | undefined;
    nameSource?: "agent" | "user" | undefined;
    exitCode?: number | undefined;
    spawnFailure?: string | undefined;
    geometryState?: "unknown" | "current" | "absent" | undefined;
    requestsGated?: number | undefined;
    requestsDuplicate?: number | undefined;
    requestsUnanswered?: number | undefined;
    lastInputAt?: string | undefined;
    agentState?: {
        phase: "unknown" | "working" | "idle" | "needs_user" | "errored" | "compacting" | "ended";
        since: string;
        nativeSubagentCount: number;
        error?: {
            class: string;
            retryable: boolean;
            detail?: string | undefined;
        } | undefined;
        idle?: {
            kind: "done" | "question" | "approval" | "open_todos" | "interrupted";
            summary?: string | undefined;
        } | undefined;
        workingMsTotal?: number | undefined;
        nativeSubagents?: {
            id: string;
            type?: string | undefined;
        }[] | undefined;
        awaitingSubagents?: boolean | undefined;
        need?: {
            kind: "question" | "permission";
            summary?: string | undefined;
            ask?: {
                toolName: string;
                detail?: string | undefined;
                canAlwaysAllow?: boolean | undefined;
            } | undefined;
            interview?: {
                questions: {
                    options: {
                        label: string;
                        description?: string | undefined;
                        preview?: string | undefined;
                    }[];
                    question: string;
                    multiSelect?: boolean | undefined;
                    header?: string | undefined;
                }[];
            } | undefined;
        } | undefined;
        observationGap?: {
            reason: "transcript_disabled";
        } | undefined;
        stateSource?: "hook" | "poll" | "classifier" | undefined;
        stateConfidence?: number | undefined;
        stateObservedAt?: string | undefined;
    } | undefined;
    stoppedAt?: string | undefined;
    stopReason?: "parent" | "self" | "exited" | "forced" | "oom" | undefined;
    workState?: "planning" | "done" | "implementing" | "testing" | "icebox" | undefined;
    resumable?: boolean | undefined;
    neverBound?: true | undefined;
    transcriptAvailable?: boolean | undefined;
    harnessHandoff?: boolean | undefined;
    harnessPromptModeHints?: boolean | undefined;
    busy?: boolean | undefined;
    agentColor?: string | undefined;
    observedModel?: string | undefined;
    observedEffort?: string | undefined;
    requestedModel?: string | undefined;
    requestedEffort?: string | undefined;
    contextUsagePercent?: number | undefined;
    draftUpdatedAt?: string | undefined;
    draftSyncEngine?: boolean | undefined;
    driverId?: string | undefined;
    driverFamily?: "server" | "terminal" | undefined;
    configureFields?: string[] | undefined;
    attachKinds?: ("engine" | "client")[] | undefined;
    queuedMessageCount?: number | undefined;
    offer?: {
        message: string;
        createdAt: string;
        actions: {
            label: string;
            prompt: string;
            input?: boolean | undefined;
        }[];
        artifacts?: string[] | undefined;
    } | null | undefined;
    handoffTargetMachineId?: (string & z.BRAND<"MachineId">) | undefined;
    conversationPodiumId?: (string & z.BRAND<"ConversationId">) | undefined;
    spawnedBy?: string | undefined;
    workflowRunId?: string | undefined;
    workflowStepId?: string | undefined;
    executionProfileId?: string | undefined;
    refIssueId?: (string & z.BRAND<"IssueId">) | undefined;
    refLetter?: string | undefined;
    refDraft?: number | undefined;
    refRepoId?: (string & z.BRAND<"RepoId">) | undefined;
    refSeq?: number | undefined;
    headless?: boolean | undefined;
    viaHub?: boolean | undefined;
    upstreamStale?: boolean | undefined;
}, "sessionId"> & Required<Pick<{
    status: "starting" | "live" | "reconnecting" | "hibernated" | "exited";
    sessionId: string & z.BRAND<"SessionId">;
    cwd: string;
    agentKind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell";
    title: string;
    archived: boolean;
    createdAt: string;
    controllerId: string | null;
    geometry: {
        cols: number;
        rows: number;
    };
    epoch: number;
    clientCount: number;
    lastActiveAt: string;
    origin: {
        kind: "spawn";
    } | {
        kind: "resume";
        conversationId: string;
    };
    name?: string | undefined;
    issueId?: (string & z.BRAND<"IssueId">) | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    resume?: {
        value: string;
        kind: string;
    } | undefined;
    model?: string | undefined;
    effort?: string | undefined;
    requestedDriverId?: string | undefined;
    delegation?: {
        actor: string & z.BRAND<"AgentIdentityId">;
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
        grantedScope: {
            kind: "all";
        } | {
            kind: "none";
        } | {
            kind: "subtree";
            rootId: string & z.BRAND<"IssueId">;
        } | {
            kind: "owned";
            userId: string & z.BRAND<"UserId">;
        } | {
            kind: "self";
            userId: string & z.BRAND<"UserId">;
        };
        parentBindingId: (string & z.BRAND<"SessionId">) | null;
        revision: number;
    } | undefined;
    createdBy?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    accountId?: (string & z.BRAND<"AccountId">) | undefined;
    nameSource?: "agent" | "user" | undefined;
    exitCode?: number | undefined;
    spawnFailure?: string | undefined;
    geometryState?: "unknown" | "current" | "absent" | undefined;
    requestsGated?: number | undefined;
    requestsDuplicate?: number | undefined;
    requestsUnanswered?: number | undefined;
    lastInputAt?: string | undefined;
    agentState?: {
        phase: "unknown" | "working" | "idle" | "needs_user" | "errored" | "compacting" | "ended";
        since: string;
        nativeSubagentCount: number;
        error?: {
            class: string;
            retryable: boolean;
            detail?: string | undefined;
        } | undefined;
        idle?: {
            kind: "done" | "question" | "approval" | "open_todos" | "interrupted";
            summary?: string | undefined;
        } | undefined;
        workingMsTotal?: number | undefined;
        nativeSubagents?: {
            id: string;
            type?: string | undefined;
        }[] | undefined;
        awaitingSubagents?: boolean | undefined;
        need?: {
            kind: "question" | "permission";
            summary?: string | undefined;
            ask?: {
                toolName: string;
                detail?: string | undefined;
                canAlwaysAllow?: boolean | undefined;
            } | undefined;
            interview?: {
                questions: {
                    options: {
                        label: string;
                        description?: string | undefined;
                        preview?: string | undefined;
                    }[];
                    question: string;
                    multiSelect?: boolean | undefined;
                    header?: string | undefined;
                }[];
            } | undefined;
        } | undefined;
        observationGap?: {
            reason: "transcript_disabled";
        } | undefined;
        stateSource?: "hook" | "poll" | "classifier" | undefined;
        stateConfidence?: number | undefined;
        stateObservedAt?: string | undefined;
    } | undefined;
    stoppedAt?: string | undefined;
    stopReason?: "parent" | "self" | "exited" | "forced" | "oom" | undefined;
    workState?: "planning" | "done" | "implementing" | "testing" | "icebox" | undefined;
    resumable?: boolean | undefined;
    neverBound?: true | undefined;
    transcriptAvailable?: boolean | undefined;
    harnessHandoff?: boolean | undefined;
    harnessPromptModeHints?: boolean | undefined;
    busy?: boolean | undefined;
    agentColor?: string | undefined;
    observedModel?: string | undefined;
    observedEffort?: string | undefined;
    requestedModel?: string | undefined;
    requestedEffort?: string | undefined;
    contextUsagePercent?: number | undefined;
    draftUpdatedAt?: string | undefined;
    draftSyncEngine?: boolean | undefined;
    driverId?: string | undefined;
    driverFamily?: "server" | "terminal" | undefined;
    configureFields?: string[] | undefined;
    attachKinds?: ("engine" | "client")[] | undefined;
    queuedMessageCount?: number | undefined;
    offer?: {
        message: string;
        createdAt: string;
        actions: {
            label: string;
            prompt: string;
            input?: boolean | undefined;
        }[];
        artifacts?: string[] | undefined;
    } | null | undefined;
    handoffTargetMachineId?: (string & z.BRAND<"MachineId">) | undefined;
    conversationPodiumId?: (string & z.BRAND<"ConversationId">) | undefined;
    spawnedBy?: string | undefined;
    workflowRunId?: string | undefined;
    workflowStepId?: string | undefined;
    executionProfileId?: string | undefined;
    refIssueId?: (string & z.BRAND<"IssueId">) | undefined;
    refLetter?: string | undefined;
    refDraft?: number | undefined;
    refRepoId?: (string & z.BRAND<"RepoId">) | undefined;
    refSeq?: number | undefined;
    headless?: boolean | undefined;
    viaHub?: boolean | undefined;
    upstreamStale?: boolean | undefined;
}, "machineId">> & {
    machineName: _podium_model.MachineProjection["name"];
    status: NativeLoginAttemptStatus;
    error?: string;
};
type Output_repos_setPrefix = Array<{
    machineId: _podium_model.MachineId;
    path: string;
    originUrl: string | null;
    repoId: _podium_model.RepoId | null;
    prefix: string | null;
}>;
type Output_repos_browse = {
    path: string;
    homePath: string;
    parentPath: string | null;
    entries: DirectoryBrowserEntry[];
};
type Output_repos_githubStatus = {
    error?: string | undefined;
    path?: string | undefined;
    status: {
        state: "missing";
    } | {
        state: "logged-out";
    } | {
        state: "ready";
        login?: string | undefined;
    };
    repositories?: {
        description: string | null;
        url: string;
        nameWithOwner: string;
        isPrivate: boolean;
        pushedAt: string | null;
    }[] | undefined;
};
type Output_repos_githubList = {
    status: {
        state: "missing";
    } | {
        state: "logged-out";
    } | {
        state: "ready";
        login?: string | undefined;
    };
    error?: string | undefined;
    path?: string | undefined;
    repositories?: {
        description: string | null;
        url: string;
        nameWithOwner: string;
        isPrivate: boolean;
        pushedAt: string | null;
    }[] | undefined;
};
type Output_hosts_memoryBreakdown = {
    hostname: string;
    agents: {
        sessionId: string & z.BRAND<"SessionId">;
        bytes: number;
        processCount: number;
    }[];
    supported: boolean;
    sampledAt: string;
    memory: {
        totalBytes: number;
        availableBytes: number;
        swapTotalBytes: number;
        swapFreeBytes: number;
    };
    disk?: {
        path: string;
        totalBytes: number;
        availableBytes: number;
        usedBytes: number;
    } | undefined;
    projects: {
        root: string;
        bytes: number;
        processCount: number;
        topProcesses: {
            name: string;
            bytes: number;
        }[];
    }[];
    otherBytes: number;
};
type Output_hosts_reclaimInventory = {
    estimate: ReclaimDiskEstimateState;
    candidates: {
        issueId: string & z.BRAND<"IssueId">;
        title: string;
        worktreePath: string;
        closedAt: string;
        machineId: string & z.BRAND<"MachineId">;
        present: boolean;
        protectedReason: string | null;
    }[];
    orphans: {
        path: string;
        branch: string | null;
        headSha: string | null;
        machineId: _podium_model.MachineId;
        repoPath: string;
    }[];
    diagnostics: {
        repoPath: string;
        machineId: _podium_model.MachineId;
        reason: string;
    }[];
};
type Output_connect_check = ({
    ok: true;
    url: string;
    resolvedTo: string[];
}) | ({
    ok: false;
    error: CheckError;
    detail: string;
});
type Output_discovery_lastMachineScan = (null) | ({
    machineId: _podium_model.MachineId;
    startedAt: number;
    durationMs: number;
    deep: boolean;
    repos: DiscoveredRepo[];
    diagnostics: _podium_model.GitDiscoveryDiagnosticWire[];
});
type Output_discovery_refreshRepos = {
    machines: {
        name: string;
        id: string & z.BRAND<"MachineId">;
        hostname: string;
        online: boolean;
        lastSeenAt: string;
        use?: "denied" | "granted" | undefined;
        owned?: boolean | undefined;
        supersededBy?: (string & z.BRAND<"MachineId">) | null | undefined;
        updateChannel?: "stable" | "edge" | "dev" | undefined;
        podiumManaged?: boolean | undefined;
        revokedAt?: string | null | undefined;
        supersedable?: boolean | undefined;
        daemonReadiness?: {
            reason: string;
            state: "attached" | "recovering" | "ready";
            quarantinedBindings: number;
        } | undefined;
        harnessVersions?: {
            harness: string;
            version: string;
            firstSeen: string;
            lastSeen: string;
            unverified?: boolean | undefined;
            verifiedThrough?: string | undefined;
        }[] | undefined;
        presenceSource?: "supervisor" | "legacy-daemon" | undefined;
        services?: {
            server: {
                state: "starting" | "available" | "refused" | "stopped";
                policy: "enabled" | "disabled";
                observedAt: string;
                reason?: string | undefined;
            };
            agentExecution: {
                state: "starting" | "available" | "refused" | "stopped";
                policy: "enabled" | "disabled";
                observedAt: string;
                reason?: string | undefined;
            };
            agentExecutionLockout?: boolean | undefined;
            crashOwner?: string | undefined;
            topology?: {
                persistence: "systemd" | "detached" | "unmanaged";
                legacyUnits: string[];
                parentUnit: "absent" | "active" | "inactive";
            } | undefined;
        } | undefined;
        serviceAssignment?: {
            server: boolean;
            agentExecution: boolean;
        } | undefined;
        availability?: {
            epoch: string;
            server: boolean;
            daemon: boolean;
            supervisor: boolean;
        } | undefined;
        transferable?: boolean | undefined;
        unowned?: boolean | undefined;
        adoptable?: boolean | undefined;
        components?: ("server" | "daemon")[] | undefined;
        inventory?: {
            os: "linux" | "darwin" | "win32";
            arch: "x64" | "arm64";
            agents: {
                installed: boolean | null;
                kind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi";
                login: {
                    state: "unknown" | "in" | "out";
                    account?: string | undefined;
                    identity?: {
                        fingerprint: string;
                        email?: string | undefined;
                        providerAccountId?: string | undefined;
                    } | undefined;
                    freshness?: number | undefined;
                };
                path?: string | undefined;
                version?: string | undefined;
                probeError?: {
                    reason: "timed-out";
                    timeoutMs: number;
                } | undefined;
            }[];
            tools: {
                installed: boolean | null;
                name: string;
                path?: string | undefined;
                version?: string | undefined;
                probeError?: {
                    reason: "timed-out";
                    timeoutMs: number;
                } | undefined;
            }[];
            podiumVersion?: string | undefined;
            runtimeDrivers?: {
                id: string;
                harness: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi";
                family: "server" | "terminal";
            }[] | undefined;
        } | undefined;
        updateChannelOverride?: "stable" | "edge" | "dev" | null | undefined;
        appVersion?: string | null | undefined;
        wireSchemaDigest?: string | null | undefined;
        installKind?: string | null | undefined;
        deliveryCaps?: string[] | undefined;
        serverMoveEligibility?: {
            eligible: boolean;
            reason?: "unsupported" | "current-server" | "offline" | undefined;
        } | undefined;
        buildReportedAt?: string | null | undefined;
        versionState?: "current" | "ahead" | "unreported" | "behind" | undefined;
        targetVersion?: string | null | undefined;
        targetUnavailableReason?: string | null | undefined;
    }[];
    repositories: _podium_model.GitRepositoryWire[];
    diagnostics: _podium_model.GitDiscoveryDiagnosticWire[];
};
type Output_discovery_scanMachine = {
    machineId: _podium_model.MachineId;
    startedAt: number;
    durationMs: number;
    deep: boolean;
    repos: DiscoveredRepo[];
    diagnostics: _podium_model.GitDiscoveryDiagnosticWire[];
};
type Output_machines_applyUpdate = {
    machines: {
        name: string;
        id: string & z.BRAND<"MachineId">;
        hostname: string;
        online: boolean;
        lastSeenAt: string;
        use?: "denied" | "granted" | undefined;
        owned?: boolean | undefined;
        supersededBy?: (string & z.BRAND<"MachineId">) | null | undefined;
        updateChannel?: "stable" | "edge" | "dev" | undefined;
        podiumManaged?: boolean | undefined;
        revokedAt?: string | null | undefined;
        supersedable?: boolean | undefined;
        daemonReadiness?: {
            reason: string;
            state: "attached" | "recovering" | "ready";
            quarantinedBindings: number;
        } | undefined;
        harnessVersions?: {
            harness: string;
            version: string;
            firstSeen: string;
            lastSeen: string;
            unverified?: boolean | undefined;
            verifiedThrough?: string | undefined;
        }[] | undefined;
        presenceSource?: "supervisor" | "legacy-daemon" | undefined;
        services?: {
            server: {
                state: "starting" | "available" | "refused" | "stopped";
                policy: "enabled" | "disabled";
                observedAt: string;
                reason?: string | undefined;
            };
            agentExecution: {
                state: "starting" | "available" | "refused" | "stopped";
                policy: "enabled" | "disabled";
                observedAt: string;
                reason?: string | undefined;
            };
            agentExecutionLockout?: boolean | undefined;
            crashOwner?: string | undefined;
            topology?: {
                persistence: "systemd" | "detached" | "unmanaged";
                legacyUnits: string[];
                parentUnit: "absent" | "active" | "inactive";
            } | undefined;
        } | undefined;
        serviceAssignment?: {
            server: boolean;
            agentExecution: boolean;
        } | undefined;
        availability?: {
            epoch: string;
            server: boolean;
            daemon: boolean;
            supervisor: boolean;
        } | undefined;
        transferable?: boolean | undefined;
        unowned?: boolean | undefined;
        adoptable?: boolean | undefined;
        components?: ("server" | "daemon")[] | undefined;
        inventory?: {
            os: "linux" | "darwin" | "win32";
            arch: "x64" | "arm64";
            agents: {
                installed: boolean | null;
                kind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi";
                login: {
                    state: "unknown" | "in" | "out";
                    account?: string | undefined;
                    identity?: {
                        fingerprint: string;
                        email?: string | undefined;
                        providerAccountId?: string | undefined;
                    } | undefined;
                    freshness?: number | undefined;
                };
                path?: string | undefined;
                version?: string | undefined;
                probeError?: {
                    reason: "timed-out";
                    timeoutMs: number;
                } | undefined;
            }[];
            tools: {
                installed: boolean | null;
                name: string;
                path?: string | undefined;
                version?: string | undefined;
                probeError?: {
                    reason: "timed-out";
                    timeoutMs: number;
                } | undefined;
            }[];
            podiumVersion?: string | undefined;
            runtimeDrivers?: {
                id: string;
                harness: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi";
                family: "server" | "terminal";
            }[] | undefined;
        } | undefined;
        updateChannelOverride?: "stable" | "edge" | "dev" | null | undefined;
        appVersion?: string | null | undefined;
        wireSchemaDigest?: string | null | undefined;
        installKind?: string | null | undefined;
        deliveryCaps?: string[] | undefined;
        serverMoveEligibility?: {
            eligible: boolean;
            reason?: "unsupported" | "current-server" | "offline" | undefined;
        } | undefined;
        buildReportedAt?: string | null | undefined;
        versionState?: "current" | "ahead" | "unreported" | "behind" | undefined;
        targetVersion?: string | null | undefined;
        targetUnavailableReason?: string | null | undefined;
    }[];
    outcome: MachineApplyOutcome;
};
type Input_machines_moveServer = {
    bindHost: "127.0.0.1" | "0.0.0.0";
    publicUrl: string;
    targetMachineId: string;
    confirmation: "TRANSFER SERVER";
    port?: number | undefined;
};
type Output_machines_moveServer = ({
    started: true;
    operationId: string;
    alreadyRunning?: undefined;
}) | ({
    started: false;
    alreadyRunning: string;
    operationId?: undefined;
});
type Input_machines_pairingCode = (undefined) | ({
    podiumManaged?: boolean | undefined;
    copyAgentCredentials?: boolean | undefined;
    replaceMachineId?: string | undefined;
});
type Input_setup_complete = {
    publicUrl: string;
    telemetry?: {
        usage: "off" | "on";
        crash: "off" | "on";
    } | undefined;
    mode?: "server" | "all-in-one" | undefined;
    networkOption?: "tailscale-funnel" | "tailscale-serve" | "cloudflare-tunnel" | "manual" | undefined;
    password?: string | undefined;
    acknowledgeNoPassword?: true | undefined;
    confirmUrlChange?: true | undefined;
};
type Output_setup_complete = {
    workspaceId?: string | undefined;
    telemetry?: {
        since?: number | undefined;
        installId?: string | undefined;
        usage?: "off" | "on" | undefined;
        crash?: "off" | "on" | undefined;
        endpoint?: string | undefined;
    } | undefined;
    connect?: {
        enabled?: boolean | undefined;
        baseUrl?: string | undefined;
        trustedProbeKeys?: string[] | undefined;
    } | undefined;
    mode?: "server" | "client" | "all-in-one" | "daemon" | "supervisor" | undefined;
    updateChannel?: "stable" | "edge" | "dev" | undefined;
    features?: Record<string, boolean> | undefined;
    configVersion?: number | undefined;
    serverUrl?: string | undefined;
    installationId?: string | undefined;
    installationPublicKey?: string | undefined;
    port?: number | undefined;
    bindHost?: "127.0.0.1" | "0.0.0.0" | undefined;
    hookPort?: number | undefined;
    agentRelayPort?: number | undefined;
    agentHome?: string | undefined;
    pairCode?: string | undefined;
    agentExecutionLockout?: boolean | undefined;
    podiumManaged?: boolean | undefined;
    updateFeed?: string | undefined;
    loopProfile?: "attribution" | "off" | "accounting" | "full" | undefined;
    profileOnStall?: boolean | undefined;
    publicUrl?: string | undefined;
    appUrl?: string | undefined;
    uiUrl?: string | undefined;
    allowedOrigins?: string[] | undefined;
    updateScope?: "all" | "fleet-only" | undefined;
    transcriptLake?: "off" | "on" | undefined;
    networkOption?: "tailscale-funnel" | "tailscale-serve" | "cloudflare-tunnel" | "manual" | undefined;
    persistence?: "systemd" | "detached" | undefined;
    auth?: {
        mode?: "cloud" | "local" | undefined;
        openMode?: boolean | undefined;
        signInUrl?: string | undefined;
    } | undefined;
};
type Output_setup_setChannel = {
    channel: FleetUpdateChannel;
    envForced: boolean;
    channelSource: SettingSource;
    configured: FleetUpdateChannel;
    updateScope: UpdateScope;
    updateScopeSource: SettingSource;
    desktopUpdateEndpoint: string | undefined;
};
type Output_setup_info = {
    mode: "server" | "client" | "all-in-one" | "daemon" | "supervisor" | null;
    modeSource: SettingSource;
    publicUrl: string | null;
    publicUrlSource: SettingSource;
    appUrl: string | null;
    appUrlSource: SettingSource;
    allowedOrigins: string[];
    allowedOriginsSource: SettingSource;
    transcriptLake: TranscriptLakeMode;
    transcriptLakeSource: SettingSource;
    networkOption: "tailscale-funnel" | "tailscale-serve" | "cloudflare-tunnel" | "manual" | null;
    serverUrl: string | null;
    appVersion: string;
};
type Output_setup_provenance = {
    mode: {
        source: SettingSource;
        env?: string;
    };
    authOpenMode: {
        source: SettingSource;
        env?: string;
    };
    updateChannel: {
        source: SettingSource;
        env?: string;
    };
    connectEnabled: {
        source: SettingSource;
        env?: string;
    };
    telemetryUsage: {
        source: SettingSource;
        env?: string;
    };
    telemetryCrash: {
        source: SettingSource;
        env?: string;
    };
    telemetryInstallId: {
        source: SettingSource;
        env?: string;
    };
    telemetrySince: {
        source: SettingSource;
        env?: string;
    };
    port: {
        source: SettingSource;
        env?: string;
    };
    hookPort: {
        source: SettingSource;
        env?: string;
    };
    agentRelayPort: {
        source: SettingSource;
        env?: string;
    };
    agentHome: {
        source: SettingSource;
        env?: string;
    };
    updateFeed: {
        source: SettingSource;
        env?: string;
    };
    publicUrl: {
        source: SettingSource;
        env?: string;
    };
    appUrl: {
        source: SettingSource;
        env?: string;
    };
    allowedOrigins: {
        source: SettingSource;
        env?: string;
    };
    updateScope: {
        source: SettingSource;
        env?: string;
    };
    transcriptLake: {
        source: SettingSource;
        env?: string;
    };
    authMode: {
        source: SettingSource;
        env?: string;
    };
    authSignInUrl: {
        source: SettingSource;
        env?: string;
    };
    connectBaseUrl: {
        source: SettingSource;
        env?: string;
    };
    connectProbeKeys: {
        source: SettingSource;
        env?: string;
    };
};
type Output_updates_repairPayload = {
    outcome: {
        result: "granted";
        version: string;
    } | {
        result: "in-flight";
        state: Protocol.ConvergenceState;
    };
    fleet: UpdateFleetSnapshot;
};
type Output_updates_start = {
    operationId: string;
    alreadyRunning: boolean;
    operation: z.objectOutputType<{
        id: z.ZodString;
        kind: z.ZodString;
        state: z.ZodEnum<["pending", "running", "waiting", "done", "failed", "canceled"]>;
        exclusionGroup: z.ZodOptional<z.ZodString>;
        details: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        createdBy: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodOptional<z.ZodNumber>;
        startedAt: z.ZodOptional<z.ZodNumber>;
        updatedAt: z.ZodOptional<z.ZodNumber>;
        finishedAt: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            state: z.ZodEnum<["pending", "running", "stalled", "done", "failed", "skipped"]>;
            title: z.ZodOptional<z.ZodString>;
            progress: z.ZodOptional<z.ZodObject<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, z.ZodTypeAny, "passthrough">>>;
            places: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, z.ZodTypeAny, "passthrough">>, "many">>;
            startedAt: z.ZodOptional<z.ZodNumber>;
            lastProgressAt: z.ZodOptional<z.ZodNumber>;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            attempts: z.ZodOptional<z.ZodNumber>;
            stalls: z.ZodOptional<z.ZodNumber>;
            stalledMs: z.ZodOptional<z.ZodNumber>;
            detail: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">>>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodString;
            state: z.ZodEnum<["pending", "running", "stalled", "done", "failed", "skipped"]>;
            title: z.ZodOptional<z.ZodString>;
            progress: z.ZodOptional<z.ZodObject<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, z.ZodTypeAny, "passthrough">>>;
            places: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, z.ZodTypeAny, "passthrough">>, "many">>;
            startedAt: z.ZodOptional<z.ZodNumber>;
            lastProgressAt: z.ZodOptional<z.ZodNumber>;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            attempts: z.ZodOptional<z.ZodNumber>;
            stalls: z.ZodOptional<z.ZodNumber>;
            stalledMs: z.ZodOptional<z.ZodNumber>;
            detail: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">>>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodString;
            state: z.ZodEnum<["pending", "running", "stalled", "done", "failed", "skipped"]>;
            title: z.ZodOptional<z.ZodString>;
            progress: z.ZodOptional<z.ZodObject<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                done: z.ZodNumber;
                total: z.ZodNumber;
            }, z.ZodTypeAny, "passthrough">>>;
            places: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                state: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                detail: z.ZodOptional<z.ZodString>;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
            }, z.ZodTypeAny, "passthrough">>, "many">>;
            startedAt: z.ZodOptional<z.ZodNumber>;
            lastProgressAt: z.ZodOptional<z.ZodNumber>;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            attempts: z.ZodOptional<z.ZodNumber>;
            stalls: z.ZodOptional<z.ZodNumber>;
            stalledMs: z.ZodOptional<z.ZodNumber>;
            detail: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                code: z.ZodString;
                message: z.ZodOptional<z.ZodString>;
                detail: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">>>>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        awaiting: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            surface: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
            place: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodString;
            surface: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
            place: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodString;
            surface: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
            place: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        deferred: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            id: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            id: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            reason: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            message: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
            places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            code: z.ZodString;
            message: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
            places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            code: z.ZodString;
            message: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
            places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, z.ZodTypeAny, "passthrough">>>>;
        retryOf: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | null;
};
type Output_updates_converge = {
    state: "in-progress";
    version: string;
    done: number;
    total: number;
    fleet: UpdateFleetSnapshot;
    grantedMachineIds: string[];
    includesBundle: boolean;
};
type Output_operations_cancel = ({
    canceled: true;
    operation: Protocol.Operation;
}) | ({
    canceled: false;
    refused: "not-found" | "already-finished" | "irreversible" | "handed-off";
    step?: string;
});
type Output_operations_settleAsk = ({
    handled: true;
    result: OperationActionResult;
}) | ({
    handled: false;
    refused: "not-found" | "already-finished" | "not-offered" | "unsupported";
});
type Output_auth_status = {
    loginRequired: boolean;
    loginPolicySource: SettingSource;
    hasOwnCredential: boolean;
    canManageInstance: boolean;
};
type Input_issues_search = {
    status?: "deferred" | "ready" | "closed" | "open" | "blocked" | undefined;
    type?: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation" | undefined;
    repoPath?: string | undefined;
    text?: string | undefined;
    stage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    priority?: number | undefined;
    assignee?: string | undefined;
    parentId?: string | undefined;
    label?: string | undefined;
};
type Output_issues_searchNormalized = Array<{
    displayRef: string;
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}>;
type Output_issues_get = (null) | ({
    sessions: {
        status: "starting" | "live" | "reconnecting" | "hibernated" | "exited";
        sessionId: string & z.BRAND<"SessionId">;
        cwd: string;
        agentKind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell";
        title: string;
        archived: boolean;
        createdAt: string;
        controllerId: string | null;
        geometry: {
            cols: number;
            rows: number;
        };
        epoch: number;
        clientCount: number;
        lastActiveAt: string;
        origin: {
            kind: "spawn";
        } | {
            kind: "resume";
            conversationId: string;
        };
        name?: string | undefined;
        issueId?: (string & z.BRAND<"IssueId">) | undefined;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        resume?: {
            value: string;
            kind: string;
        } | undefined;
        model?: string | undefined;
        effort?: string | undefined;
        requestedDriverId?: string | undefined;
        delegation?: {
            actor: string & z.BRAND<"AgentIdentityId">;
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
            grantedScope: {
                kind: "all";
            } | {
                kind: "none";
            } | {
                kind: "subtree";
                rootId: string & z.BRAND<"IssueId">;
            } | {
                kind: "owned";
                userId: string & z.BRAND<"UserId">;
            } | {
                kind: "self";
                userId: string & z.BRAND<"UserId">;
            };
            parentBindingId: (string & z.BRAND<"SessionId">) | null;
            revision: number;
        } | undefined;
        createdBy?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
        accountId?: (string & z.BRAND<"AccountId">) | undefined;
        nameSource?: "agent" | "user" | undefined;
        exitCode?: number | undefined;
        spawnFailure?: string | undefined;
        geometryState?: "unknown" | "current" | "absent" | undefined;
        requestsGated?: number | undefined;
        requestsDuplicate?: number | undefined;
        requestsUnanswered?: number | undefined;
        lastInputAt?: string | undefined;
        agentState?: {
            phase: "unknown" | "working" | "idle" | "needs_user" | "errored" | "compacting" | "ended";
            since: string;
            nativeSubagentCount: number;
            error?: {
                class: string;
                retryable: boolean;
                detail?: string | undefined;
            } | undefined;
            idle?: {
                kind: "done" | "question" | "approval" | "open_todos" | "interrupted";
                summary?: string | undefined;
            } | undefined;
            workingMsTotal?: number | undefined;
            nativeSubagents?: {
                id: string;
                type?: string | undefined;
            }[] | undefined;
            awaitingSubagents?: boolean | undefined;
            need?: {
                kind: "question" | "permission";
                summary?: string | undefined;
                ask?: {
                    toolName: string;
                    detail?: string | undefined;
                    canAlwaysAllow?: boolean | undefined;
                } | undefined;
                interview?: {
                    questions: {
                        options: {
                            label: string;
                            description?: string | undefined;
                            preview?: string | undefined;
                        }[];
                        question: string;
                        multiSelect?: boolean | undefined;
                        header?: string | undefined;
                    }[];
                } | undefined;
            } | undefined;
            observationGap?: {
                reason: "transcript_disabled";
            } | undefined;
            stateSource?: "hook" | "poll" | "classifier" | undefined;
            stateConfidence?: number | undefined;
            stateObservedAt?: string | undefined;
        } | undefined;
        stoppedAt?: string | undefined;
        stopReason?: "parent" | "self" | "exited" | "forced" | "oom" | undefined;
        workState?: "planning" | "done" | "implementing" | "testing" | "icebox" | undefined;
        resumable?: boolean | undefined;
        neverBound?: true | undefined;
        transcriptAvailable?: boolean | undefined;
        harnessHandoff?: boolean | undefined;
        harnessPromptModeHints?: boolean | undefined;
        busy?: boolean | undefined;
        agentColor?: string | undefined;
        observedModel?: string | undefined;
        observedEffort?: string | undefined;
        requestedModel?: string | undefined;
        requestedEffort?: string | undefined;
        contextUsagePercent?: number | undefined;
        draftUpdatedAt?: string | undefined;
        draftSyncEngine?: boolean | undefined;
        driverId?: string | undefined;
        driverFamily?: "server" | "terminal" | undefined;
        configureFields?: string[] | undefined;
        attachKinds?: ("engine" | "client")[] | undefined;
        queuedMessageCount?: number | undefined;
        offer?: {
            message: string;
            createdAt: string;
            actions: {
                label: string;
                prompt: string;
                input?: boolean | undefined;
            }[];
            artifacts?: string[] | undefined;
        } | null | undefined;
        handoffTargetMachineId?: (string & z.BRAND<"MachineId">) | undefined;
        conversationPodiumId?: (string & z.BRAND<"ConversationId">) | undefined;
        spawnedBy?: string | undefined;
        workflowRunId?: string | undefined;
        workflowStepId?: string | undefined;
        executionProfileId?: string | undefined;
        refIssueId?: (string & z.BRAND<"IssueId">) | undefined;
        refLetter?: string | undefined;
        refDraft?: number | undefined;
        refRepoId?: (string & z.BRAND<"RepoId">) | undefined;
        refSeq?: number | undefined;
        headless?: boolean | undefined;
        viaHub?: boolean | undefined;
        upstreamStale?: boolean | undefined;
    }[];
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    id: string & z.BRAND<"IssueId">;
    title: string;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    seq: number;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    archived: boolean;
    deletedAt?: string | undefined;
    priority: number;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    labels: string[];
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    audience: "agent" | "human";
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
    createdAt: string;
    updatedAt: string;
    readAt: string | null;
    tuckedAt: string | null;
    pinned: boolean;
    description: string;
    humanQuestion?: string;
    humanQuestionOptions?: string[];
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionAskedAt?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    draft: boolean;
    worktreePath: string | null;
    branch: string | null;
    commentCount: number;
    notes?: string;
    repoPath: string;
    prefix?: string;
    displayRef: string;
    deps: _podium_model.IssueDepWire[];
    dependents: _podium_model.IssueDepWire[];
    ready: boolean;
    blocked: boolean;
    deferred: boolean;
    childCount: number;
    childDoneCount: number;
    gitState?: _podium_model.IssueGitState;
});
type Input_issues_events = {
    repoPath?: string | undefined;
    since?: number | undefined;
    limit?: number | undefined;
    subject?: string | undefined;
    kinds?: string[] | undefined;
};
type Output_issues_setState = Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, "description" | "owner" | "notes" | "lastLifecycleActor" | "worktreePath" | "branch" | "asked" | "intentOrigin" | "isDraftVessel" | "createdBy" | "visibility"> & _podium_model.IssueUserOverlay & {
    description: string;
    humanQuestion?: string;
    humanQuestionOptions?: string[];
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionAskedAt?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    draft: boolean;
    worktreePath: string | null;
    branch: string | null;
    commentCount: number;
    notes?: string;
    repoPath: string;
    prefix?: string;
    displayRef: string;
    deps: _podium_model.IssueDepWire[];
    dependents: _podium_model.IssueDepWire[];
    ready: boolean;
    blocked: boolean;
    deferred: boolean;
    childCount: number;
    childDoneCount: number;
    gitState?: _podium_model.IssueGitState;
} & Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, ("description" | "type" | "owner" | "id" | "title" | "seq" | "stage" | "archived" | "priority" | "labels" | "blockedByNotes" | "parentBranch" | "defaultAgent" | "defaultModel" | "defaultEffort" | "needsHuman" | "intentOrigin" | "audience" | "isDraftVessel" | "createdBy" | "visibility" | "createdAt" | "updatedAt") | ("machineId" | "revision" | "repoId" | "brief" | "design" | "acceptance" | "activityNotes" | "notesUpdatedAt" | "dependencyNote" | "suggestedReason" | "notes" | "suggestedStage" | "closedReason" | "closedAt" | "deferUntil" | "deletedAt" | "lastLifecycleActor" | "assignee" | "estimateMin" | "color" | "sortKey" | "dueAt" | "parentId" | "supersededBy" | "duplicateOf" | "worktreePath" | "branch" | "asked" | "panel" | "coordinatorSessionId" | "startedBySession" | "linearId" | "linearIdentifier" | "linearUrl" | "prUrl")>;
type Input_issues_panelApply = {
    id: string;
    op: "todo-add" | "todo-done" | "todo-undone" | "todo-remove" | "todo-clear" | "artifact-add" | "artifact-remove" | "deferred-add" | "deferred-remove";
    path?: string | undefined;
    title?: string | undefined;
    text?: string | undefined;
    index?: number | undefined;
    expectedRevision?: number | undefined;
    extraPaths?: string[] | undefined;
    terminalEvidence?: boolean | undefined;
    sourceRoot?: string | undefined;
};
type Input_issues_create = {
    title: string;
    repoPath: string;
    startNow: boolean;
    description?: string | undefined;
    type?: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation" | undefined;
    machineId?: string | undefined;
    id?: string | undefined;
    mutationId?: string | undefined;
    brief?: string | undefined;
    priority?: number | undefined;
    assignee?: string | undefined;
    labels?: string[] | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    parentId?: string | undefined;
    parentBranch?: string | undefined;
    defaultAgent?: string | undefined;
    defaultModel?: string | undefined;
    defaultEffort?: string | undefined;
    audience?: "agent" | "human" | undefined;
    startSessionId?: string | undefined;
    linear?: {
        identifier: string;
        url: string;
        id?: string | undefined;
    } | undefined;
};
type Output_issues_create = (Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, "description" | "owner" | "notes" | "lastLifecycleActor" | "worktreePath" | "branch" | "asked" | "intentOrigin" | "isDraftVessel" | "createdBy" | "visibility"> & _podium_model.IssueUserOverlay & {
    description: string;
    humanQuestion?: string;
    humanQuestionOptions?: string[];
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionAskedAt?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    draft: boolean;
    worktreePath: string | null;
    branch: string | null;
    commentCount: number;
    notes?: string;
    repoPath: string;
    prefix?: string;
    displayRef: string;
    deps: _podium_model.IssueDepWire[];
    dependents: _podium_model.IssueDepWire[];
    ready: boolean;
    blocked: boolean;
    deferred: boolean;
    childCount: number;
    childDoneCount: number;
    gitState?: _podium_model.IssueGitState;
} & Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, ("description" | "type" | "owner" | "id" | "title" | "seq" | "stage" | "archived" | "priority" | "labels" | "blockedByNotes" | "parentBranch" | "defaultAgent" | "defaultModel" | "defaultEffort" | "needsHuman" | "intentOrigin" | "audience" | "isDraftVessel" | "createdBy" | "visibility" | "createdAt" | "updatedAt") | ("machineId" | "revision" | "repoId" | "brief" | "design" | "acceptance" | "activityNotes" | "notesUpdatedAt" | "dependencyNote" | "suggestedReason" | "notes" | "suggestedStage" | "closedReason" | "closedAt" | "deferUntil" | "deletedAt" | "lastLifecycleActor" | "assignee" | "estimateMin" | "color" | "sortKey" | "dueAt" | "parentId" | "supersededBy" | "duplicateOf" | "worktreePath" | "branch" | "asked" | "panel" | "coordinatorSessionId" | "startedBySession" | "linearId" | "linearIdentifier" | "linearUrl" | "prUrl")>) | (Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, "description" | "owner" | "notes" | "lastLifecycleActor" | "worktreePath" | "branch" | "asked" | "intentOrigin" | "isDraftVessel" | "createdBy" | "visibility"> & _podium_model.IssueUserOverlay & {
    description: string;
    humanQuestion?: string;
    humanQuestionOptions?: string[];
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionAskedAt?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    draft: boolean;
    worktreePath: string | null;
    branch: string | null;
    commentCount: number;
    notes?: string;
    repoPath: string;
    prefix?: string;
    displayRef: string;
    deps: _podium_model.IssueDepWire[];
    dependents: _podium_model.IssueDepWire[];
    ready: boolean;
    blocked: boolean;
    deferred: boolean;
    childCount: number;
    childDoneCount: number;
    gitState?: _podium_model.IssueGitState;
} & Omit<{
    warning: string;
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, ("description" | "type" | "owner" | "id" | "title" | "seq" | "stage" | "archived" | "priority" | "labels" | "blockedByNotes" | "parentBranch" | "defaultAgent" | "defaultModel" | "defaultEffort" | "needsHuman" | "intentOrigin" | "audience" | "isDraftVessel" | "createdBy" | "visibility" | "createdAt" | "updatedAt") | ("machineId" | "revision" | "repoId" | "brief" | "design" | "acceptance" | "activityNotes" | "notesUpdatedAt" | "dependencyNote" | "suggestedReason" | "notes" | "suggestedStage" | "closedReason" | "closedAt" | "deferUntil" | "deletedAt" | "lastLifecycleActor" | "assignee" | "estimateMin" | "color" | "sortKey" | "dueAt" | "parentId" | "supersededBy" | "duplicateOf" | "worktreePath" | "branch" | "asked" | "panel" | "coordinatorSessionId" | "startedBySession" | "linearId" | "linearIdentifier" | "linearUrl" | "prUrl")>);
type Input_issues_start = {
    id: string;
    agentKind?: string | undefined;
    forceUnknownModel?: boolean | undefined;
    mutationId?: string | undefined;
    defaultModel?: string | undefined;
    defaultEffort?: string | undefined;
};
type Output_issues_start = Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
}, "description" | "owner" | "notes" | "lastLifecycleActor" | "worktreePath" | "branch" | "asked" | "intentOrigin" | "isDraftVessel" | "createdBy" | "visibility"> & _podium_model.IssueUserOverlay & {
    description: string;
    humanQuestion?: string;
    humanQuestionOptions?: string[];
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionAskedAt?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    draft: boolean;
    worktreePath: string | null;
    branch: string | null;
    commentCount: number;
    notes?: string;
    repoPath: string;
    prefix?: string;
    displayRef: string;
    deps: _podium_model.IssueDepWire[];
    dependents: _podium_model.IssueDepWire[];
    ready: boolean;
    blocked: boolean;
    deferred: boolean;
    childCount: number;
    childDoneCount: number;
    gitState?: _podium_model.IssueGitState;
} & Omit<{
    description: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    };
    type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
    owner: string & z.BRAND<"UserId">;
    id: string & z.BRAND<"IssueId">;
    title: string;
    seq: number;
    stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
    archived: boolean;
    priority: number;
    labels: string[];
    blockedByNotes: string[];
    parentBranch: string;
    defaultAgent: string;
    defaultModel: string;
    defaultEffort: string;
    needsHuman: boolean;
    intentOrigin: "agent" | "human";
    audience: "agent" | "human";
    isDraftVessel: boolean;
    createdBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
    createdAt: string;
    updatedAt: string;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    revision?: number | undefined;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    brief?: string | undefined;
    design?: string | undefined;
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    notesUpdatedAt?: string | undefined;
    dependencyNote?: string | undefined;
    suggestedReason?: string | undefined;
    notes?: {
        value: string;
        revision?: number | undefined;
        opsTail?: unknown[] | undefined;
    } | undefined;
    suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
    closedReason?: string | undefined;
    closedAt?: string | undefined;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    lastLifecycleActor?: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    } | undefined;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    estimateMin?: number | undefined;
    color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
    sortKey?: string | undefined;
    dueAt?: string | undefined;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    worktreePath?: string | undefined;
    branch?: string | undefined;
    asked?: {
        question: string;
        at?: string | undefined;
        options?: string[] | undefined;
        by?: (string & z.BRAND<"SessionId">) | undefined;
        attribution?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
    } | undefined;
    panel?: {
        todos: {
            text: string;
            done: boolean;
        }[];
        artifacts: {
            path: string;
            addedAt: string;
            title?: string | undefined;
            sourceKind?: "terminal-evidence" | undefined;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: {
                path: string;
                size: number;
            }[] | undefined;
            sourcePaths?: string[] | undefined;
            tracking?: "unknown" | "tracked" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            text: string;
            addedAt: string;
        }[];
    } | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    prUrl?: string | undefined;
} & Partial<{
    agentId: string;
    harness: string;
    model: string | null;
    effort: string | null;
    machine: string;
}>, ("description" | "type" | "owner" | "id" | "title" | "seq" | "stage" | "archived" | "priority" | "labels" | "blockedByNotes" | "parentBranch" | "defaultAgent" | "defaultModel" | "defaultEffort" | "needsHuman" | "intentOrigin" | "audience" | "isDraftVessel" | "createdBy" | "visibility" | "createdAt" | "updatedAt") | ("machineId" | "revision" | "repoId" | "brief" | "design" | "acceptance" | "activityNotes" | "notesUpdatedAt" | "dependencyNote" | "suggestedReason" | "notes" | "suggestedStage" | "closedReason" | "closedAt" | "deferUntil" | "deletedAt" | "lastLifecycleActor" | "assignee" | "estimateMin" | "color" | "sortKey" | "dueAt" | "parentId" | "supersededBy" | "duplicateOf" | "worktreePath" | "branch" | "asked" | "panel" | "coordinatorSessionId" | "startedBySession" | "linearId" | "linearIdentifier" | "linearUrl" | "prUrl")>;
type Input_issues_update = {
    id: string;
    patch: {
        description?: string | undefined;
        type?: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation" | undefined;
        machineId?: string | null | undefined;
        title?: string | undefined;
        brief?: string | undefined;
        design?: string | undefined;
        acceptance?: string | undefined;
        notes?: string | undefined;
        stage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
        closedReason?: string | undefined;
        deferUntil?: string | undefined;
        archived?: boolean | undefined;
        priority?: number | undefined;
        assignee?: string | undefined;
        estimateMin?: number | undefined;
        color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | null | undefined;
        sortKey?: string | undefined;
        dueAt?: string | undefined;
        parentId?: string | undefined;
        parentBranch?: string | undefined;
        defaultAgent?: string | undefined;
        defaultModel?: string | undefined;
        defaultEffort?: string | undefined;
        pinned?: boolean | undefined;
    };
    mutationId?: string | undefined;
    expectedRevision?: number | undefined;
    confirmInterrupt?: boolean | undefined;
};
type Input_issues_attachSession = {
    sessionId: string;
    targetId?: string | undefined;
    confirmRehome?: boolean | undefined;
    newSubissue?: {
        title: string;
    } | undefined;
    newSpinoff?: {
        title: string;
    } | undefined;
};
type Output_issues_action = {
    ok: boolean;
    output: string;
    issue: Omit<{
        description: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        };
        type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
        owner: string & z.BRAND<"UserId">;
        id: string & z.BRAND<"IssueId">;
        title: string;
        seq: number;
        stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
        archived: boolean;
        priority: number;
        labels: string[];
        blockedByNotes: string[];
        parentBranch: string;
        defaultAgent: string;
        defaultModel: string;
        defaultEffort: string;
        needsHuman: boolean;
        intentOrigin: "agent" | "human";
        audience: "agent" | "human";
        isDraftVessel: boolean;
        createdBy: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
        createdAt: string;
        updatedAt: string;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        revision?: number | undefined;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        brief?: string | undefined;
        design?: string | undefined;
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        notesUpdatedAt?: string | undefined;
        dependencyNote?: string | undefined;
        suggestedReason?: string | undefined;
        notes?: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        } | undefined;
        suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
        closedReason?: string | undefined;
        closedAt?: string | undefined;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        lastLifecycleActor?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        estimateMin?: number | undefined;
        color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
        sortKey?: string | undefined;
        dueAt?: string | undefined;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        worktreePath?: string | undefined;
        branch?: string | undefined;
        asked?: {
            question: string;
            at?: string | undefined;
            options?: string[] | undefined;
            by?: (string & z.BRAND<"SessionId">) | undefined;
            attribution?: {
                actor: {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    kind: "system";
                    job: string;
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            } | undefined;
        } | undefined;
        panel?: {
            todos: {
                text: string;
                done: boolean;
            }[];
            artifacts: {
                path: string;
                addedAt: string;
                title?: string | undefined;
                sourceKind?: "terminal-evidence" | undefined;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: {
                    path: string;
                    size: number;
                }[] | undefined;
                sourcePaths?: string[] | undefined;
                tracking?: "unknown" | "tracked" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                text: string;
                addedAt: string;
            }[];
        } | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        prUrl?: string | undefined;
    }, "description" | "owner" | "notes" | "lastLifecycleActor" | "worktreePath" | "branch" | "asked" | "intentOrigin" | "isDraftVessel" | "createdBy" | "visibility"> & _podium_model.IssueUserOverlay & {
        description: string;
        humanQuestion?: string;
        humanQuestionOptions?: string[];
        humanQuestionAskedBy?: _podium_model.SessionId;
        humanQuestionAskedAt?: string;
        origin: _podium_model.IssueProjection["intentOrigin"];
        draft: boolean;
        worktreePath: string | null;
        branch: string | null;
        commentCount: number;
        notes?: string;
        repoPath: string;
        prefix?: string;
        displayRef: string;
        deps: _podium_model.IssueDepWire[];
        dependents: _podium_model.IssueDepWire[];
        ready: boolean;
        blocked: boolean;
        deferred: boolean;
        childCount: number;
        childDoneCount: number;
        gitState?: _podium_model.IssueGitState;
    } & Omit<{
        description: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        };
        type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
        owner: string & z.BRAND<"UserId">;
        id: string & z.BRAND<"IssueId">;
        title: string;
        seq: number;
        stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
        archived: boolean;
        priority: number;
        labels: string[];
        blockedByNotes: string[];
        parentBranch: string;
        defaultAgent: string;
        defaultModel: string;
        defaultEffort: string;
        needsHuman: boolean;
        intentOrigin: "agent" | "human";
        audience: "agent" | "human";
        isDraftVessel: boolean;
        createdBy: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
        createdAt: string;
        updatedAt: string;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        revision?: number | undefined;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        brief?: string | undefined;
        design?: string | undefined;
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        notesUpdatedAt?: string | undefined;
        dependencyNote?: string | undefined;
        suggestedReason?: string | undefined;
        notes?: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        } | undefined;
        suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
        closedReason?: string | undefined;
        closedAt?: string | undefined;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        lastLifecycleActor?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        estimateMin?: number | undefined;
        color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
        sortKey?: string | undefined;
        dueAt?: string | undefined;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        worktreePath?: string | undefined;
        branch?: string | undefined;
        asked?: {
            question: string;
            at?: string | undefined;
            options?: string[] | undefined;
            by?: (string & z.BRAND<"SessionId">) | undefined;
            attribution?: {
                actor: {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    kind: "system";
                    job: string;
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            } | undefined;
        } | undefined;
        panel?: {
            todos: {
                text: string;
                done: boolean;
            }[];
            artifacts: {
                path: string;
                addedAt: string;
                title?: string | undefined;
                sourceKind?: "terminal-evidence" | undefined;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: {
                    path: string;
                    size: number;
                }[] | undefined;
                sourcePaths?: string[] | undefined;
                tracking?: "unknown" | "tracked" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                text: string;
                addedAt: string;
            }[];
        } | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        prUrl?: string | undefined;
    }, ("description" | "type" | "owner" | "id" | "title" | "seq" | "stage" | "archived" | "priority" | "labels" | "blockedByNotes" | "parentBranch" | "defaultAgent" | "defaultModel" | "defaultEffort" | "needsHuman" | "intentOrigin" | "audience" | "isDraftVessel" | "createdBy" | "visibility" | "createdAt" | "updatedAt") | ("machineId" | "revision" | "repoId" | "brief" | "design" | "acceptance" | "activityNotes" | "notesUpdatedAt" | "dependencyNote" | "suggestedReason" | "notes" | "suggestedStage" | "closedReason" | "closedAt" | "deferUntil" | "deletedAt" | "lastLifecycleActor" | "assignee" | "estimateMin" | "color" | "sortKey" | "dueAt" | "parentId" | "supersededBy" | "duplicateOf" | "worktreePath" | "branch" | "asked" | "panel" | "coordinatorSessionId" | "startedBySession" | "linearId" | "linearIdentifier" | "linearUrl" | "prUrl")>;
};
type Output_issues_ship = {
    order: {
        issueId: string & z.BRAND<"IssueId">;
        id: string & z.BRAND<"ShipOrderId">;
        repoId: string & z.BRAND<"RepoId">;
        targetBranch: string;
        destination: string;
        state: "queued" | "held" | "preflight" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped" | "cancelled";
        stateChangedAt: string;
        approvedBaseSha: string;
        approvedHeadSha: string;
        descendantManifest: {
            issueId: string & z.BRAND<"IssueId">;
            approvedHeadSha: string;
        }[];
        deliveryDependsOn: (string & z.BRAND<"ShipOrderId">)[];
        requestedBy: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        requestedAt: string;
        policyId: string;
        closeMode: "after-destination" | "leave-open";
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        repoPath?: string | undefined;
        evidenceManifestRef?: string | undefined;
        currentIntegrationReceipt?: {
            approvedHeadSha: string;
            rootIssueId: string & z.BRAND<"IssueId">;
            descendants: {
                issueId: string & z.BRAND<"IssueId">;
                approvedHeadSha: string;
            }[];
        } | undefined;
        providerRef?: {
            provider: string;
            id: string;
            url?: string | undefined;
        } | undefined;
        validationProfile?: {
            cwd: "integration-root";
            id: string;
            timeoutMs: number;
            argv: string[];
            resourceLocks: string[];
        } | undefined;
        validationProfileDigest?: string | undefined;
        holdCode?: string | undefined;
    };
    projection: {
        issueId: string & z.BRAND<"IssueId">;
        id: string & z.BRAND<"ShipOrderId">;
        repoId: string & z.BRAND<"RepoId">;
        targetBranch: string;
        destination: string;
        state: "queued" | "held" | "preflight" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped";
        humanState: "in_progress" | "shipped" | "waiting" | "needs_you";
        activity: "held" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped" | "waiting" | "checking";
        queuedAt: string;
        stateChangedAt: string;
        queueRank?: number | undefined;
        train?: {
            size: number;
            id: string;
            index: number;
        } | undefined;
        waitEstimate?: {
            lowerBoundMs: number;
            upperBoundMs: number;
            sampleSize: number;
            basis: "lane-history";
        } | undefined;
        hold?: {
            id: string & z.BRAND<"ShipHoldId">;
            actions: string[];
            generation: number;
            reasonCode: string;
            headline: string;
        } | undefined;
        receiptId?: (string & z.BRAND<"DeliveryReceiptId">) | undefined;
    };
    descendantManifest: {
        issueId: string & z.BRAND<"IssueId">;
        approvedHeadSha: string;
    }[];
    created: boolean;
};
type Output_issues_cancelShip = {
    issueId: string & z.BRAND<"IssueId">;
    id: string & z.BRAND<"ShipOrderId">;
    repoId: string & z.BRAND<"RepoId">;
    targetBranch: string;
    destination: string;
    state: "queued" | "held" | "preflight" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped" | "cancelled";
    stateChangedAt: string;
    approvedBaseSha: string;
    approvedHeadSha: string;
    descendantManifest: {
        issueId: string & z.BRAND<"IssueId">;
        approvedHeadSha: string;
    }[];
    deliveryDependsOn: (string & z.BRAND<"ShipOrderId">)[];
    requestedBy: {
        actor: {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            kind: "system";
            job: string;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    requestedAt: string;
    policyId: string;
    closeMode: "after-destination" | "leave-open";
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    repoPath?: string | undefined;
    evidenceManifestRef?: string | undefined;
    currentIntegrationReceipt?: {
        approvedHeadSha: string;
        rootIssueId: string & z.BRAND<"IssueId">;
        descendants: {
            issueId: string & z.BRAND<"IssueId">;
            approvedHeadSha: string;
        }[];
    } | undefined;
    providerRef?: {
        provider: string;
        id: string;
        url?: string | undefined;
    } | undefined;
    validationProfile?: {
        cwd: "integration-root";
        id: string;
        timeoutMs: number;
        argv: string[];
        resourceLocks: string[];
    } | undefined;
    validationProfileDigest?: string | undefined;
    holdCode?: string | undefined;
};
type Output_issues_resolveShipHold = {
    order: {
        issueId: string & z.BRAND<"IssueId">;
        id: string & z.BRAND<"ShipOrderId">;
        repoId: string & z.BRAND<"RepoId">;
        targetBranch: string;
        destination: string;
        state: "queued" | "held" | "preflight" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped" | "cancelled";
        stateChangedAt: string;
        approvedBaseSha: string;
        approvedHeadSha: string;
        descendantManifest: {
            issueId: string & z.BRAND<"IssueId">;
            approvedHeadSha: string;
        }[];
        deliveryDependsOn: (string & z.BRAND<"ShipOrderId">)[];
        requestedBy: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        requestedAt: string;
        policyId: string;
        closeMode: "after-destination" | "leave-open";
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        repoPath?: string | undefined;
        evidenceManifestRef?: string | undefined;
        currentIntegrationReceipt?: {
            approvedHeadSha: string;
            rootIssueId: string & z.BRAND<"IssueId">;
            descendants: {
                issueId: string & z.BRAND<"IssueId">;
                approvedHeadSha: string;
            }[];
        } | undefined;
        providerRef?: {
            provider: string;
            id: string;
            url?: string | undefined;
        } | undefined;
        validationProfile?: {
            cwd: "integration-root";
            id: string;
            timeoutMs: number;
            argv: string[];
            resourceLocks: string[];
        } | undefined;
        validationProfileDigest?: string | undefined;
        holdCode?: string | undefined;
    };
    projection: {
        issueId: string & z.BRAND<"IssueId">;
        id: string & z.BRAND<"ShipOrderId">;
        repoId: string & z.BRAND<"RepoId">;
        targetBranch: string;
        destination: string;
        state: "queued" | "held" | "preflight" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped";
        humanState: "in_progress" | "shipped" | "waiting" | "needs_you";
        activity: "held" | "composing" | "validating" | "repairing" | "landing" | "publishing" | "verifying" | "shipped" | "waiting" | "checking";
        queuedAt: string;
        stateChangedAt: string;
        queueRank?: number | undefined;
        train?: {
            size: number;
            id: string;
            index: number;
        } | undefined;
        waitEstimate?: {
            lowerBoundMs: number;
            upperBoundMs: number;
            sampleSize: number;
            basis: "lane-history";
        } | undefined;
        hold?: {
            id: string & z.BRAND<"ShipHoldId">;
            actions: string[];
            generation: number;
            reasonCode: string;
            headline: string;
        } | undefined;
        receiptId?: (string & z.BRAND<"DeliveryReceiptId">) | undefined;
    };
};
type Input_issues_setNeedsHuman = {
    id: string;
    options?: string[] | undefined;
    question?: string | undefined;
    expectedRevision?: number | undefined;
    askedBy?: string | undefined;
};
type Output_issues_answerQuestion = {
    issue: Omit<{
        description: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        };
        type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
        owner: string & z.BRAND<"UserId">;
        id: string & z.BRAND<"IssueId">;
        title: string;
        seq: number;
        stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
        archived: boolean;
        priority: number;
        labels: string[];
        blockedByNotes: string[];
        parentBranch: string;
        defaultAgent: string;
        defaultModel: string;
        defaultEffort: string;
        needsHuman: boolean;
        intentOrigin: "agent" | "human";
        audience: "agent" | "human";
        isDraftVessel: boolean;
        createdBy: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
        createdAt: string;
        updatedAt: string;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        revision?: number | undefined;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        brief?: string | undefined;
        design?: string | undefined;
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        notesUpdatedAt?: string | undefined;
        dependencyNote?: string | undefined;
        suggestedReason?: string | undefined;
        notes?: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        } | undefined;
        suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
        closedReason?: string | undefined;
        closedAt?: string | undefined;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        lastLifecycleActor?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        estimateMin?: number | undefined;
        color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
        sortKey?: string | undefined;
        dueAt?: string | undefined;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        worktreePath?: string | undefined;
        branch?: string | undefined;
        asked?: {
            question: string;
            at?: string | undefined;
            options?: string[] | undefined;
            by?: (string & z.BRAND<"SessionId">) | undefined;
            attribution?: {
                actor: {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    kind: "system";
                    job: string;
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            } | undefined;
        } | undefined;
        panel?: {
            todos: {
                text: string;
                done: boolean;
            }[];
            artifacts: {
                path: string;
                addedAt: string;
                title?: string | undefined;
                sourceKind?: "terminal-evidence" | undefined;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: {
                    path: string;
                    size: number;
                }[] | undefined;
                sourcePaths?: string[] | undefined;
                tracking?: "unknown" | "tracked" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                text: string;
                addedAt: string;
            }[];
        } | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        prUrl?: string | undefined;
    }, "description" | "owner" | "notes" | "lastLifecycleActor" | "worktreePath" | "branch" | "asked" | "intentOrigin" | "isDraftVessel" | "createdBy" | "visibility"> & _podium_model.IssueUserOverlay & {
        description: string;
        humanQuestion?: string;
        humanQuestionOptions?: string[];
        humanQuestionAskedBy?: _podium_model.SessionId;
        humanQuestionAskedAt?: string;
        origin: _podium_model.IssueProjection["intentOrigin"];
        draft: boolean;
        worktreePath: string | null;
        branch: string | null;
        commentCount: number;
        notes?: string;
        repoPath: string;
        prefix?: string;
        displayRef: string;
        deps: _podium_model.IssueDepWire[];
        dependents: _podium_model.IssueDepWire[];
        ready: boolean;
        blocked: boolean;
        deferred: boolean;
        childCount: number;
        childDoneCount: number;
        gitState?: _podium_model.IssueGitState;
    } & Omit<{
        description: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        };
        type: "task" | "bug" | "feature" | "chore" | "epic" | "decision" | "spike" | "story" | "milestone" | "automation";
        owner: string & z.BRAND<"UserId">;
        id: string & z.BRAND<"IssueId">;
        title: string;
        seq: number;
        stage: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done";
        archived: boolean;
        priority: number;
        labels: string[];
        blockedByNotes: string[];
        parentBranch: string;
        defaultAgent: string;
        defaultModel: string;
        defaultEffort: string;
        needsHuman: boolean;
        intentOrigin: "agent" | "human";
        audience: "agent" | "human";
        isDraftVessel: boolean;
        createdBy: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        visibility: "personal" | "per-user-state" | "owned-compute" | "deployment-substrate" | "secret";
        createdAt: string;
        updatedAt: string;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        revision?: number | undefined;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        brief?: string | undefined;
        design?: string | undefined;
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        notesUpdatedAt?: string | undefined;
        dependencyNote?: string | undefined;
        suggestedReason?: string | undefined;
        notes?: {
            value: string;
            revision?: number | undefined;
            opsTail?: unknown[] | undefined;
        } | undefined;
        suggestedStage?: "proposed" | "backlog" | "planning" | "in_progress" | "review" | "shipping" | "done" | undefined;
        closedReason?: string | undefined;
        closedAt?: string | undefined;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        lastLifecycleActor?: {
            actor: {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                kind: "system";
                job: string;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        } | undefined;
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        estimateMin?: number | undefined;
        color?: "rose" | "pink" | "fuchsia" | "violet" | "indigo" | "blue" | "cyan" | "teal" | "green" | "lime" | undefined;
        sortKey?: string | undefined;
        dueAt?: string | undefined;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        worktreePath?: string | undefined;
        branch?: string | undefined;
        asked?: {
            question: string;
            at?: string | undefined;
            options?: string[] | undefined;
            by?: (string & z.BRAND<"SessionId">) | undefined;
            attribution?: {
                actor: {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    kind: "system";
                    job: string;
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            } | undefined;
        } | undefined;
        panel?: {
            todos: {
                text: string;
                done: boolean;
            }[];
            artifacts: {
                path: string;
                addedAt: string;
                title?: string | undefined;
                sourceKind?: "terminal-evidence" | undefined;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: {
                    path: string;
                    size: number;
                }[] | undefined;
                sourcePaths?: string[] | undefined;
                tracking?: "unknown" | "tracked" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                text: string;
                addedAt: string;
            }[];
        } | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        prUrl?: string | undefined;
    }, ("description" | "type" | "owner" | "id" | "title" | "seq" | "stage" | "archived" | "priority" | "labels" | "blockedByNotes" | "parentBranch" | "defaultAgent" | "defaultModel" | "defaultEffort" | "needsHuman" | "intentOrigin" | "audience" | "isDraftVessel" | "createdBy" | "visibility" | "createdAt" | "updatedAt") | ("machineId" | "revision" | "repoId" | "brief" | "design" | "acceptance" | "activityNotes" | "notesUpdatedAt" | "dependencyNote" | "suggestedReason" | "notes" | "suggestedStage" | "closedReason" | "closedAt" | "deferUntil" | "deletedAt" | "lastLifecycleActor" | "assignee" | "estimateMin" | "color" | "sortKey" | "dueAt" | "parentId" | "supersededBy" | "duplicateOf" | "worktreePath" | "branch" | "asked" | "panel" | "coordinatorSessionId" | "startedBySession" | "linearId" | "linearIdentifier" | "linearUrl" | "prUrl")>;
    deliveredVia: "text" | "menu";
};
type Input_issues_setPlacement = {
    id: string;
    placement: "own" | "mission";
    originId: string;
    mutationId?: string | undefined;
    expectedRevision?: number | undefined;
};
type Input_issues_setCoordinator = {
    id: string;
    sessionId?: string | null | undefined;
    expectedRevision?: number | undefined;
    claim?: boolean | undefined;
};
type Input_issues_close = {
    id: string;
    mutationId?: string | undefined;
    reason?: string | undefined;
    expectedRevision?: number | undefined;
    confirmInterrupt?: boolean | undefined;
};
type Output_issues_mailSend = ({
    reason?: string | undefined;
    ok: boolean;
    disposition: SendDisposition;
    id: string;
    issueId: _podium_model.IssueId;
    fromAuthor: string;
    body: string;
    createdAt: string;
    status: "unread" | "read" | "claimed";
    claimedBy: string | null;
    claimedAt: string | null;
}) | ({
    reason?: string | undefined;
    ok: boolean;
    disposition: SendDisposition;
    id: string;
    issueId: string;
    fromAuthor: string;
    body: string;
    createdAt: string;
    status: "unread";
    claimedBy: null;
    readAt: null;
    claimedAt: null;
});
type Output_issues_mailInbox = Array<{
    id: string;
    issueId: _podium_model.IssueId;
    fromAuthor: string;
    body: string;
    createdAt: string;
    status: "unread" | "read" | "claimed";
    claimedBy: string | null;
    claimedAt: string | null;
    wasUnread: boolean;
}>;
type Output_issues_mailClaim = {
    claimed: boolean;
    message: {
        id: string;
        issueId: _podium_model.IssueId;
        fromAuthor: string;
        body: string;
        createdAt: string;
        status: "unread" | "read" | "claimed";
        claimedBy: string | null;
        claimedAt: string | null;
    };
};
type Input_issues_subscriptionAdd = {
    source: {
        ref: string;
        kind: "issue" | "session" | "relationship";
    };
    event: string;
    deliver?: {
        nudge?: boolean | undefined;
        notify?: boolean | undefined;
    } | undefined;
    subscriber?: {
        id: string;
        kind: "issue" | "session";
    } | undefined;
};
type Output_issues_subscriptionAdd = {
    id: string;
    subscriberKind: "session" | "issue";
    subscriberId: string;
    event: string;
    sourceKind: "relationship" | "issue" | "session";
    sourceRef: string;
    deliverNudge: boolean;
    deliverNotify: boolean;
    origin: "default" | "custom";
    enabled: boolean;
    createdAt: string;
};
type Input_lock_acquire = {
    name: string;
    repoPath: string;
    note?: string | undefined;
    allowSibling?: boolean | undefined;
    ttlSeconds?: number | undefined;
};
type Input_logs_forward = {
    origin: {
        role: string;
        machineId?: string | undefined;
        v?: string | undefined;
    };
    records: z.objectInputType<{
        ts: z.ZodString;
        level: z.ZodEnum<["error", "warn", "info", "debug", "trace"]>;
        ns: z.ZodString;
        msg: z.ZodString;
        err: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            message: z.ZodString;
            stack: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            message: string;
            name: string;
            stack?: string | undefined;
        }, {
            message: string;
            name: string;
            stack?: string | undefined;
        }>>;
    }, z.ZodUnknown, "strip">[];
    dropped?: number | undefined;
};
type Input_logs_setLevel = {
    level: "error" | "warn" | "info" | "debug" | "trace" | null;
    ttlMs?: number | undefined;
    target?: {
        role?: string | undefined;
        machineId?: string | undefined;
        clientId?: string | undefined;
    } | undefined;
};
type Input_logs_setDaemonLevel = {
    level: "error" | "warn" | "info" | "debug" | "trace" | null;
    ttlMs?: number | undefined;
    target?: {
        machineId?: string | undefined;
    } | undefined;
};
type Input_logs_crash = {
    origin: {
        role: string;
        machineId?: string | undefined;
        v?: string | undefined;
    };
    err: {
        message: string;
        name: string;
        stack?: string | undefined;
    };
    snapshot?: z.objectInputType<{
        ts: z.ZodString;
        level: z.ZodEnum<["error", "warn", "info", "debug", "trace"]>;
        ns: z.ZodString;
        msg: z.ZodString;
        err: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            message: z.ZodString;
            stack: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            message: string;
            name: string;
            stack?: string | undefined;
        }, {
            message: string;
            name: string;
            stack?: string | undefined;
        }>>;
    }, z.ZodUnknown, "strip">[] | undefined;
    context?: Record<string, unknown> | undefined;
};
type Input_files_write = ({
    path: string;
    sessionId: string;
    content: string;
    baseHash?: string | undefined;
}) | ({
    path: string;
    content: string;
    root: string;
    machineId?: string | undefined;
    baseHash?: string | undefined;
});
type Input_files_read = ({
    path: string;
    sessionId: string;
}) | ({
    path: string;
    issueId: string;
    artifactId: string;
}) | ({
    path: string;
    root: string;
    machineId?: string | undefined;
});
type Output_files_read = {
    error?: string | undefined;
    path: string;
    ok: boolean;
    content?: string | undefined;
    baseHash?: string | undefined;
    tooLarge?: boolean | undefined;
    binary?: boolean | undefined;
};
type Input_workflows_create = {
    name: string;
    scope: "global" | "task" | "repository";
    description?: string | undefined;
    steps?: {
        id: string;
        title: string;
        executionProfileId?: string | undefined;
        instructions?: string | undefined;
        completionGuidance?: string | undefined;
    }[] | undefined;
    scopeRef?: string | null | undefined;
    instructions?: string | undefined;
};
type Output_workflows_create = {
    workflow: {
        description: string;
        name: string;
        id: string;
        createdAt: string;
        updatedAt: string;
        scope: "global" | "task" | "repository";
        scopeRef: string | null;
        latestRevisionId: string | null;
        latestVersion: number;
        archivedAt: string | null;
    };
    revision: {
        id: string;
        createdAt: string;
        version: number;
        steps: {
            id: string;
            title: string;
            instructions: string;
            completionGuidance: string;
            executionProfileId?: string | undefined;
        }[];
        instructions: string;
        workflowId: string;
        publishedAt: string | null;
    };
};
type Input_workflows_revise = {
    workflowId: string;
    steps?: {
        id: string;
        title: string;
        executionProfileId?: string | undefined;
        instructions?: string | undefined;
        completionGuidance?: string | undefined;
    }[] | undefined;
    instructions?: string | undefined;
};
type Input_workflows_fork = {
    name: string;
    scope: "global" | "task" | "repository";
    revisionId: string;
    description?: string | undefined;
    scopeRef?: string | null | undefined;
};
type Input_workflows_profileSave = {
    name: string;
    accountId: string;
    harness: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell";
    machineId?: string | null | undefined;
    id?: string | undefined;
    model?: string | undefined;
    effort?: string | undefined;
};
type Input_workflows_checkpoint = {
    status: "active" | "complete" | "blocked";
    mutationId?: string | undefined;
    summary?: string | undefined;
    observation?: {
        dirty: boolean | null;
        cwd: string;
        branch: string | null;
        worktree: string | null;
        ahead: number | null;
        observedAt: string;
        behind: number | null;
        head: string | null;
    } | null | undefined;
    runId?: string | undefined;
    stepId?: string | undefined;
    evidence?: {
        artifacts?: string[] | undefined;
        summary?: string | undefined;
        tests?: string[] | undefined;
    } | undefined;
};
type Input_workflows_list = {
    scope?: "global" | "task" | "repository" | undefined;
    scopeRef?: string | undefined;
    includeArchived?: boolean | undefined;
};
type Output_workflows_get = {
    workflow: {
        description: string;
        name: string;
        id: string;
        createdAt: string;
        updatedAt: string;
        scope: "global" | "task" | "repository";
        scopeRef: string | null;
        latestRevisionId: string | null;
        latestVersion: number;
        archivedAt: string | null;
    };
    revisions: {
        id: string;
        createdAt: string;
        version: number;
        steps: {
            id: string;
            title: string;
            instructions: string;
            completionGuidance: string;
            executionProfileId?: string | undefined;
        }[];
        instructions: string;
        workflowId: string;
        publishedAt: string | null;
    }[];
};
type Input_automations_create = {
    name: string;
    agentKind: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell";
    prompt: string;
    model?: string | undefined;
    effort?: string | undefined;
    repoPath?: string | null | undefined;
    enabled?: boolean | undefined;
    cron?: string | null | undefined;
    scheduleKind?: "once" | "cron" | undefined;
    runAt?: string | null | undefined;
    targetSessionId?: string | null | undefined;
    sessionMode?: "resume" | "fresh" | undefined;
};
type Output_automations_create = {
    name: string;
    id: string & z.BRAND<"AutomationId">;
    model: string;
    effort: string;
    agentKind: string;
    repoPath: string | null;
    createdAt: string;
    prompt: string;
    enabled: boolean;
    cron: string | null;
    scheduleKind: "once" | "cron";
    runAt: string | null;
    targetSessionId: (string & z.BRAND<"SessionId">) | null;
    sessionMode: "resume" | "fresh";
    nextRunAt: string | null;
    lastRunAt: string | null;
} & {
    ownerUserId: _podium_model.UserId;
    createdByActor: string;
    createdByOnBehalfOf: _podium_model.UserId;
};
type Input_automations_update = {
    id: string;
    patch: {
        name?: string | undefined;
        model?: string | undefined;
        effort?: string | undefined;
        agentKind?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | "shell" | undefined;
        repoPath?: string | null | undefined;
        prompt?: string | undefined;
        enabled?: boolean | undefined;
        cron?: string | null | undefined;
        scheduleKind?: "once" | "cron" | undefined;
        runAt?: string | null | undefined;
        targetSessionId?: string | null | undefined;
        sessionMode?: "resume" | "fresh" | undefined;
    };
};
type Output_automations_list = Array<{
    name: string;
    id: string & z.BRAND<"AutomationId">;
    model: string;
    effort: string;
    agentKind: string;
    repoPath: string | null;
    createdAt: string;
    prompt: string;
    enabled: boolean;
    cron: string | null;
    scheduleKind: "once" | "cron";
    runAt: string | null;
    targetSessionId: (string & z.BRAND<"SessionId">) | null;
    sessionMode: "resume" | "fresh";
    nextRunAt: string | null;
    lastRunAt: string | null;
} & {
    ownerUserId: _podium_model.UserId;
    createdByActor: string;
    createdByOnBehalfOf: _podium_model.UserId;
}>;
type Output_automations_runs = Array<{
    sessionId: (string & z.BRAND<"SessionId">) | null;
    id: string & z.BRAND<"AutomationRunId">;
    detail: string | null;
    automationId: string & z.BRAND<"AutomationId">;
    firedAt: string;
    outcome: "error" | "spawned" | "missed" | "skipped_overlap";
} & {
    actor: string;
    onBehalfOf: _podium_model.UserId;
}>;
type Input_specs_save = {
    id: string;
    repoPath: string;
    status?: "superseded" | "active" | "draft" | undefined;
    parent?: string | undefined;
    title?: string | undefined;
    body?: string | undefined;
    order?: number | undefined;
};
type Input_interactions_answer = {
    id: string;
    text?: string | undefined;
    answer?: z.objectInputType<{
        kind: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | undefined;
};
type Output_interactions_answer = ({
    ok: true;
} & {
    detail?: string;
}) | ({
    reason: "expired" | "delivery-failed" | "already-answered" | "unknown-interaction" | "not-yet-supported" | "partial-delivery";
    ok: false;
    detail?: string | undefined;
} & {
    detail?: string;
});
type AppRouter = TRPC.TRPCBuiltRouter<{
    ctx: object;
    meta: object;
    errorShape: TRPC.TRPCDefaultErrorShape;
    transformer: false;
}, {
    "cloud": {
        "createMachine": TRPC.TRPCMutationProcedure<{
            input: Input_cloud_createMachine;
            output: CloudRuntime;
            meta: unknown;
        }>;
        "createAgent": TRPC.TRPCMutationProcedure<{
            input: Input_cloud_createAgent;
            output: CloudRuntime;
            meta: unknown;
        }>;
        "moveSession": TRPC.TRPCMutationProcedure<{
            input: Input_cloud_moveSession;
            output: CloudRuntime;
            meta: unknown;
        }>;
        "stop": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: CloudRuntime;
            meta: unknown;
        }>;
        "wake": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: CloudRuntime;
            meta: unknown;
        }>;
        "capabilities": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: CloudProviderCapabilities;
            meta: unknown;
        }>;
        "runtime": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: (null) | (CloudRuntime);
            meta: unknown;
        }>;
    };
    "sessions": {
        "ask": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<_podium_model.SessionMeta>;
            meta: unknown;
        }>;
        "concurrencyHistory": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: AgentConcurrencyHistoryResult;
            meta: unknown;
        }>;
        "activityHistory": TRPC.TRPCQueryProcedure<{
            input: {
                sessionIds: string[];
            };
            output: SessionActivityHistoryResult;
            meta: unknown;
        }>;
        "transcriptRead": TRPC.TRPCQueryProcedure<{
            input: {
                sessionId: string;
                direction: "before" | "after";
                limit: number;
                anchor?: string | undefined;
            };
            output: TranscriptSlice;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: {
                ref: string;
            };
            output: _podium_model.SessionStatusResult;
            meta: unknown;
        }>;
        "resolve": TRPC.TRPCQueryProcedure<{
            input: {
                identifier: string;
            };
            output: Protocol.SessionIdentifierResolution;
            meta: unknown;
        }>;
        "read": TRPC.TRPCQueryProcedure<{
            input: {
                sessionId: string;
                cursor?: string | undefined;
                turns?: number | undefined;
            };
            output: _podium_model.SessionReadResult;
            meta: unknown;
        }>;
        "recap": TRPC.TRPCQueryProcedure<{
            input: {
                sessionId: string;
                since?: string | undefined;
            };
            output: _podium_model.SessionRecapResult;
            meta: unknown;
        }>;
        "stop": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                force?: boolean | undefined;
            };
            output: Output_sessions_stop;
            meta: unknown;
        }>;
        "answerAskUserQuestion": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_answerAskUserQuestion;
            output: {
                ok: boolean;
                reason?: string;
            };
            meta: unknown;
        }>;
        "configure": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                model?: string | undefined;
                effort?: string | undefined;
            };
            output: Output_sessions_configure;
            meta: unknown;
        }>;
        "continue": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: any;
            meta: unknown;
        }>;
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_create;
            output: SessionSpawnResult;
            meta: unknown;
        }>;
        "hibernate": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: {
                ok: boolean;
                reason?: string;
            };
            meta: unknown;
        }>;
        "interrupt": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                messageId?: string | undefined;
            };
            output: Output_sessions_interrupt;
            meta: unknown;
        }>;
        "kill": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "resume": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_resume;
            output: {
                sessionId: _podium_model.SessionId;
            };
            meta: unknown;
        }>;
        "resumeAndSend": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_resumeAndSend;
            output: SubstrateOutcome;
            meta: unknown;
        }>;
        "resurrect": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: {
                ok: boolean;
                reason?: string;
            };
            meta: unknown;
        }>;
        "sendText": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_resumeAndSend;
            output: SubstrateOutcome;
            meta: unknown;
        }>;
        "uploadImage": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                filename: string;
                mimeType: string;
                dataBase64: string;
                machineId?: string | undefined;
            };
            output: Output_sessions_uploadImage;
            meta: unknown;
        }>;
        "rename": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                sessionId: string;
                mutationId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "setArchived": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                archived: boolean;
                mutationId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "setWorkState": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_setWorkState;
            output: void;
            meta: unknown;
        }>;
        "setIssueId": TRPC.TRPCMutationProcedure<{
            input: {
                issueId: string | null;
                sessionId: string;
                mutationId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "dismissOffer": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                offerCreatedAt: string;
                mutationId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "markRead": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                mutationId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "markUnread": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                mutationId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "handoff": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                machineId: string;
            };
            output: {
                ok: true;
                newCwd: string;
            };
            meta: unknown;
        }>;
    };
    "sync": {
        "changesSince": TRPC.TRPCQueryProcedure<{
            input: {
                cursor: number | null;
            };
            output: Protocol.SyncChangesSinceResult;
            meta: unknown;
        }>;
        "feedSlice": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({});
            output: {
                feedId: string;
                epoch: string;
                throughSeq: number;
                rows: {
                    entity: string;
                    entityId: string;
                }[];
            };
            meta: unknown;
        }>;
    };
    "layout": {
        "get": TRPC.TRPCQueryProcedure<{
            input: void;
            output: _podium_model.LayoutSnapshot;
            meta: unknown;
        }>;
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                values: Record<string, unknown>;
                mutationId?: string | undefined;
            };
            output: _podium_model.LayoutSnapshot;
            meta: unknown;
        }>;
        "clear": TRPC.TRPCMutationProcedure<{
            input: {
                keys: string[];
                mutationId?: string | undefined;
            };
            output: _podium_model.LayoutSnapshot;
            meta: unknown;
        }>;
    };
    "readPosition": {
        "get": TRPC.TRPCQueryProcedure<{
            input: void;
            output: _podium_model.ReadPositionSnapshot;
            meta: unknown;
        }>;
        "advance": TRPC.TRPCMutationProcedure<{
            input: {
                streamId: string;
                lastEventId: number;
                mutationId?: string | undefined;
                seenAt?: string | null | undefined;
            };
            output: _podium_model.ReadPositionSnapshot;
            meta: unknown;
        }>;
    };
    "shells": {
        "forWorktree": TRPC.TRPCMutationProcedure<{
            input: {
                worktreePath: string;
                machineId?: string | undefined;
            };
            output: {
                sessionId: string & z.BRAND<"SessionId">;
                created: boolean;
            };
            meta: unknown;
        }>;
    };
    "pins": {
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                kind: "repo" | "panel" | "worktree";
                pinned: boolean;
                mutationId?: string | undefined;
            };
            output: PinState;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: PinState;
            meta: unknown;
        }>;
    };
    "snoozes": {
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                until: string | null;
                mutationId?: string | undefined;
            };
            output: {
                [x: string]: string | null;
            };
            meta: unknown;
        }>;
        "clear": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
                mutationId?: string | undefined;
            };
            output: {
                [x: string]: string | null;
            };
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: {
                [x: string]: string | null;
            };
            meta: unknown;
        }>;
    };
    "superagent": {
        "interruptTurn": TRPC.TRPCMutationProcedure<{
            input: {
                threadId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "clear": TRPC.TRPCMutationProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "sendTurn": TRPC.TRPCMutationProcedure<{
            input: Input_superagent_sendTurn;
            output: {
                threadId: _podium_model.ThreadId;
                podiumSessionId: _podium_model.SessionId;
                queued: boolean;
            };
            meta: unknown;
        }>;
        "openInTerminal": TRPC.TRPCMutationProcedure<{
            input: {
                threadId: string;
            };
            output: {
                sessionId: _podium_model.SessionId;
            };
            meta: unknown;
        }>;
        "restart": TRPC.TRPCMutationProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "ensureSession": TRPC.TRPCMutationProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: {
                threadId: _podium_model.ThreadId;
                podiumSessionId: _podium_model.SessionId;
            };
            meta: unknown;
        }>;
        "startBtw": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: {
                threadId: _podium_model.ThreadId;
                isNew: boolean;
            };
            meta: unknown;
        }>;
        "concierge": TRPC.TRPCMutationProcedure<{
            input: Input_superagent_concierge;
            output: {
                threadId: _podium_model.ThreadId;
                podiumSessionId: _podium_model.SessionId;
                isNew: boolean;
            };
            meta: unknown;
        }>;
        "listThreads": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<SuperagentThreadRow & {
                turnRunning: boolean;
            }>;
            meta: unknown;
        }>;
        "history": TRPC.TRPCQueryProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: Array<SuperagentMessageRow>;
            meta: unknown;
        }>;
        "latestTurnFailure": TRPC.TRPCQueryProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: (null) | (SuperagentTurnFailure);
            meta: unknown;
        }>;
    };
    "conversations": {
        "setMeta": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                name?: string | undefined;
                summary?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "search": TRPC.TRPCQueryProcedure<{
            input: {
                query?: string | undefined;
                limit?: number | undefined;
                projectPath?: string | undefined;
            };
            output: Array<ConversationIndexRow>;
            meta: unknown;
        }>;
    };
    "search": {
        "query": TRPC.TRPCQueryProcedure<{
            input: {
                text: string;
                limit?: number | undefined;
            };
            output: Array<Protocol.SearchResultWire>;
            meta: unknown;
        }>;
    };
    "settings": {
        "updatePersonal": TRPC.TRPCMutationProcedure<{
            input: {
                values: Record<string, unknown>;
                mutationId?: string | undefined;
            };
            output: Output_settings_updatePersonal;
            meta: unknown;
        }>;
        "updateInstance": TRPC.TRPCMutationProcedure<{
            input: {
                values: Record<string, unknown>;
            };
            output: Output_settings_updatePersonal;
            meta: unknown;
        }>;
        "setSecret": TRPC.TRPCMutationProcedure<{
            input: Input_settings_setSecret;
            output: _podium_model.SecretPresenceWire;
            meta: unknown;
        }>;
        "clearSecret": TRPC.TRPCMutationProcedure<{
            input: Input_settings_clearSecret;
            output: _podium_model.SecretPresenceWire;
            meta: unknown;
        }>;
        "secretPresence": TRPC.TRPCQueryProcedure<{
            input: {};
            output: Array<_podium_model.SecretPresenceWire>;
            meta: unknown;
        }>;
        "telegramSetupStart": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({});
            output: TelegramSetupStartResult;
            meta: unknown;
        }>;
        "telegramSetupPoll": TRPC.TRPCMutationProcedure<{
            input: {
                setupId: string;
            };
            output: Output_settings_telegramSetupPoll;
            meta: unknown;
        }>;
        "viewer": TRPC.TRPCQueryProcedure<{
            input: void;
            output: {
                permitted: Record<string, boolean>;
            };
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_settings_updatePersonal;
            meta: unknown;
        }>;
    };
    "perf": {
        "report": TRPC.TRPCMutationProcedure<{
            input: Input_perf_report;
            output: {
                ok: true;
            };
            meta: unknown;
        }>;
        "reset": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: {
                ok: true;
            };
            meta: unknown;
        }>;
        "snapshot": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Protocol.PerfSnapshot;
            meta: unknown;
        }>;
    };
    "features": {
        "state": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_features_state;
            meta: unknown;
        }>;
    };
    "telemetry": {
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                usage?: "off" | "on" | undefined;
                crash?: "off" | "on" | undefined;
            };
            output: TelemetryState;
            meta: unknown;
        }>;
        "resetId": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: TelemetryState;
            meta: unknown;
        }>;
        "state": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: TelemetryState;
            meta: unknown;
        }>;
        "preview": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_telemetry_preview;
            meta: unknown;
        }>;
    };
    "accounts": {
        "login": TRPC.TRPCMutationProcedure<{
            input: {
                harness: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi";
                machineId?: string | undefined;
            };
            output: Output_accounts_login;
            meta: unknown;
        }>;
        "connect": TRPC.TRPCMutationProcedure<{
            input: {
                provider: "openrouter" | "anthropic" | "openai";
                kind: "api-key" | "oauth";
                credential: string;
            };
            output: {
                id: string;
            };
            meta: unknown;
        }>;
        "disconnect": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: {
                ok: true;
            };
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<AccountView>;
            meta: unknown;
        }>;
    };
    "tabs": {
        "setOrder": TRPC.TRPCMutationProcedure<{
            input: {
                worktree: string;
                sessionIds: string[];
                mutationId?: string | undefined;
            };
            output: {
                [x: string]: string[];
            };
            meta: unknown;
        }>;
        "listOrders": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: {
                [x: string]: string[];
            };
            meta: unknown;
        }>;
    };
    "repos": {
        "add": TRPC.TRPCMutationProcedure<{
            input: {
                path: string;
                machineId?: string | undefined;
                prefix?: string | undefined;
            };
            output: Array<string>;
            meta: unknown;
        }>;
        "addMany": TRPC.TRPCMutationProcedure<{
            input: {
                paths: string[];
                machineId?: string | undefined;
            };
            output: {
                repos: string[];
                failed: {
                    path: string;
                    message: string;
                }[];
            };
            meta: unknown;
        }>;
        "remove": TRPC.TRPCMutationProcedure<{
            input: {
                path: string;
                machineId?: string | undefined;
            };
            output: Array<string>;
            meta: unknown;
        }>;
        "setPrefix": TRPC.TRPCMutationProcedure<{
            input: {
                path: string;
                prefix: string;
                machineId?: string | undefined;
            };
            output: Output_repos_setPrefix;
            meta: unknown;
        }>;
        "cloneGithub": TRPC.TRPCMutationProcedure<{
            input: {
                machineId: string;
                destination: string;
                repository: string;
            };
            output: {
                path: string;
                repos: string[];
            };
            meta: unknown;
        }>;
        "createFolder": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                machineId: string;
                parentPath: string;
            };
            output: {
                path: string;
            };
            meta: unknown;
        }>;
        "createRepo": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                machineId: string;
                parentPath: string;
            };
            output: {
                path: string;
                repos: string[];
            };
            meta: unknown;
        }>;
        "renameFolder": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                machineId: string;
                parentPath: string;
                currentName: string;
            };
            output: {
                path: string;
            };
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<string>;
            meta: unknown;
        }>;
        "listDetailed": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_repos_setPrefix;
            meta: unknown;
        }>;
        "inferFromPath": TRPC.TRPCQueryProcedure<{
            input: {
                path: string;
            };
            output: {
                repoPath: string | null;
            };
            meta: unknown;
        }>;
        "browse": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                path?: string | undefined;
                machineId?: string | undefined;
                includeHidden?: boolean | undefined;
            });
            output: Output_repos_browse;
            meta: unknown;
        }>;
        "githubStatus": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Output_repos_githubStatus;
            meta: unknown;
        }>;
        "githubList": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Output_repos_githubList;
            meta: unknown;
        }>;
    };
    "usage": {
        "summary": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: {
                hostname: string;
                sampledAt?: string;
                buckets: _podium_model.UsageBucketWire[];
            };
            meta: unknown;
        }>;
    };
    "cost": {
        "task": TRPC.TRPCQueryProcedure<{
            input: {
                issueId: string;
            };
            output: _podium_model.TaskCostWire;
            meta: unknown;
        }>;
        "tasks": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<_podium_model.TaskCostRowWire>;
            meta: unknown;
        }>;
    };
    "quota": {
        "summary": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<_podium_model.MachineQuotaWire>;
            meta: unknown;
        }>;
        "history": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                days?: number | undefined;
            });
            output: Array<_podium_model.QuotaWindowHistoryWire>;
            meta: unknown;
        }>;
    };
    "models": {
        "refresh": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                machineId?: string | undefined;
            } & {
                [k: string]: unknown;
            });
            output: ModelCatalogSnapshot;
            meta: unknown;
        }>;
        "catalog": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                machineId?: string | undefined;
            } & {
                [k: string]: unknown;
            });
            output: ModelCatalogSnapshot;
            meta: unknown;
        }>;
    };
    "hosts": {
        "memoryBreakdown": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                machineId?: string | undefined;
            });
            output: Output_hosts_memoryBreakdown;
            meta: unknown;
        }>;
        "reclaimInventory": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                machineId?: string | undefined;
            });
            output: Output_hosts_reclaimInventory;
            meta: unknown;
        }>;
    };
    "connect": {
        "check": TRPC.TRPCQueryProcedure<{
            input: {
                url: string;
            };
            output: Output_connect_check;
            meta: unknown;
        }>;
    };
    "discovery": {
        "lastMachineScan": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Output_discovery_lastMachineScan;
            meta: unknown;
        }>;
        "refreshRepos": TRPC.TRPCMutationProcedure<{
            input: void;
            output: Output_discovery_refreshRepos;
            meta: unknown;
        }>;
        "scanFolder": TRPC.TRPCMutationProcedure<{
            input: {
                path: string;
                machineId?: string | undefined;
                maxDepth?: number | undefined;
            };
            output: ScanReposResult;
            meta: unknown;
        }>;
        "scanMachine": TRPC.TRPCMutationProcedure<{
            input: {
                machineId: string;
                deep?: boolean | undefined;
                atPath?: string | undefined;
            };
            output: Output_discovery_scanMachine;
            meta: unknown;
        }>;
    };
    "machines": {
        "rename": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                id: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "setAssignment": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                requestId: string;
                assignment: {
                    server: boolean;
                    agentExecution: boolean;
                };
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "setUpdateChannel": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                channel: "stable" | "edge" | "dev" | null;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "share": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                grantee: string;
                verb: "manage" | "see" | "use";
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "unshare": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                grantee: string;
                verb: "manage" | "see" | "use";
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "transferOwnership": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                newOwnerUserId: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "adopt": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                newOwnerUserId?: string | undefined;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "supersede": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                replacementId: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "applyUpdate": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_machines_applyUpdate;
            meta: unknown;
        }>;
        "revoke": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "moveServer": TRPC.TRPCMutationProcedure<{
            input: Input_machines_moveServer;
            output: Output_machines_moveServer;
            meta: unknown;
        }>;
        "pairingCode": TRPC.TRPCMutationProcedure<{
            input: Input_machines_pairingCode;
            output: {
                code: string;
                joinCommand: string | null;
            };
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: void;
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "descriptors": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Array<Protocol.HarnessDescriptorWire>;
            meta: unknown;
        }>;
    };
    "setup": {
        "complete": TRPC.TRPCMutationProcedure<{
            input: Input_setup_complete;
            output: Output_setup_complete;
            meta: unknown;
        }>;
        "join": TRPC.TRPCMutationProcedure<{
            input: {
                code: string;
            };
            output: {
                name: string;
                warning?: string;
            };
            meta: unknown;
        }>;
        "connect": TRPC.TRPCMutationProcedure<{
            input: {
                mode: "server" | "client" | "all-in-one";
                serverUrl?: string | undefined;
            };
            output: Output_setup_complete;
            meta: unknown;
        }>;
        "setChannel": TRPC.TRPCMutationProcedure<{
            input: {
                channel: "stable" | "edge" | "dev";
            };
            output: Output_setup_setChannel;
            meta: unknown;
        }>;
        "activate": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: {
                state: "restarting";
                stale: readonly ("mode" | "persistence")[];
                from: string;
            };
            meta: unknown;
        }>;
        "info": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_setup_info;
            meta: unknown;
        }>;
        "options": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<{
                id: NetworkOption;
                label: string;
                note: string;
            }>;
            meta: unknown;
        }>;
        "commandFor": TRPC.TRPCQueryProcedure<{
            input: {
                port: number;
                option: "tailscale-funnel" | "tailscale-serve" | "cloudflare-tunnel" | "manual";
            };
            output: {
                command: string;
                hint: string;
            };
            meta: unknown;
        }>;
        "channel": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_setup_setChannel;
            meta: unknown;
        }>;
        "provenance": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_setup_provenance;
            meta: unknown;
        }>;
    };
    "updates": {
        "proposal": TRPC.TRPCQueryProcedure<{
            input: void;
            output: (null) | (Protocol.ReleaseProposal);
            meta: unknown;
        }>;
        "approveProposal": TRPC.TRPCMutationProcedure<{
            input: {
                version: string;
                headSha: string;
            };
            output: (null) | (Protocol.ReleaseProposal);
            meta: unknown;
        }>;
        "fleet": TRPC.TRPCQueryProcedure<{
            input: void;
            output: UpdateFleetSnapshot;
            meta: unknown;
        }>;
        "checkNow": TRPC.TRPCMutationProcedure<{
            input: void;
            output: Array<ChannelCheckRecord>;
            meta: unknown;
        }>;
        "repairPayload": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                id?: string | undefined;
            });
            output: Output_updates_repairPayload;
            meta: unknown;
        }>;
        "repairCompatibility": TRPC.TRPCMutationProcedure<{
            input: void;
            output: {
                state: "in-progress";
                version: string;
            };
            meta: unknown;
        }>;
        "start": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                surface?: string | undefined;
            });
            output: Output_updates_start;
            meta: unknown;
        }>;
        "retry": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_updates_start;
            meta: unknown;
        }>;
        "converge": TRPC.TRPCMutationProcedure<{
            input: void;
            output: Output_updates_converge;
            meta: unknown;
        }>;
    };
    "operations": {
        "active": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                group?: string | undefined;
            });
            output: (null) | (Protocol.Operation);
            meta: unknown;
        }>;
        "history": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                kind?: string | undefined;
                limit?: number | undefined;
            });
            output: Array<unknown>;
            meta: unknown;
        }>;
        "cancel": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_operations_cancel;
            meta: unknown;
        }>;
        "settleAsk": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                actionId: string;
            };
            output: Output_operations_settleAsk;
            meta: unknown;
        }>;
        "action": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                actionId: string;
            };
            output: Output_operations_settleAsk;
            meta: unknown;
        }>;
    };
    "auth": {
        "setEmail": TRPC.TRPCMutationProcedure<{
            input: {
                email: string;
                current?: string | undefined;
            };
            output: {
                email: string;
            };
            meta: unknown;
        }>;
        "setPassword": TRPC.TRPCMutationProcedure<{
            input: {
                next: string;
                current?: string | undefined;
            };
            output: {
                loginRequired: boolean;
            };
            meta: unknown;
        }>;
        "setLoginRequired": TRPC.TRPCMutationProcedure<{
            input: {
                current: string;
                required: boolean;
                acknowledgeNoPassword?: true | undefined;
            };
            output: {
                loginRequired: boolean;
            };
            meta: unknown;
        }>;
        "profile": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: {
                email: string | null;
            };
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_auth_status;
            meta: unknown;
        }>;
    };
    "issues": {
        "list": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "prime": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                repoPath?: string | undefined;
            });
            output: string;
            meta: unknown;
        }>;
        "ready": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "blocked": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "graph": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.IssueGraph;
            meta: unknown;
        }>;
        "epicStatus": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: _podium_model.EpicStatus;
            meta: unknown;
        }>;
        "children": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
                recursive?: boolean | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "tree": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
                maxDepth?: number | undefined;
                maxNodes?: number | undefined;
            };
            output: _podium_model.IssueTree<_podium_model.IssueTreeSession>;
            meta: unknown;
        }>;
        "depReport": TRPC.TRPCQueryProcedure<{
            input: {
                id?: string | undefined;
                repoPath?: string | undefined;
            };
            output: Array<DepReportEntry>;
            meta: unknown;
        }>;
        "closeEligibleEpics": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "findDuplicates": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
                threshold?: number | undefined;
            };
            output: Array<_podium_model.DuplicateCandidate>;
            meta: unknown;
        }>;
        "stale": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
                days?: number | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "lint": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.LintFinding>;
            meta: unknown;
        }>;
        "doctor": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.DoctorReport;
            meta: unknown;
        }>;
        "preflight": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: {
                ok: boolean;
                report: _podium_model.DoctorReport;
            };
            meta: unknown;
        }>;
        "deliveryReceipt": TRPC.TRPCQueryProcedure<{
            input: {
                orderId: string;
            };
            output: (null) | (_podium_model.DeliveryReceipt);
            meta: unknown;
        }>;
        "search": TRPC.TRPCQueryProcedure<{
            input: Input_issues_search;
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "searchNormalized": TRPC.TRPCQueryProcedure<{
            input: Input_issues_search;
            output: Output_issues_searchNormalized;
            meta: unknown;
        }>;
        "count": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.IssueCount;
            meta: unknown;
        }>;
        "stats": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.IssueStats;
            meta: unknown;
        }>;
        "orphans": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath: string;
            };
            output: Array<_podium_model.OrphanIssue>;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_get;
            meta: unknown;
        }>;
        "resolveRefs": TRPC.TRPCQueryProcedure<{
            input: {
                refs: string[];
            };
            output: Array<{
                ref: string;
                id: (string & z.BRAND<"IssueId">) | null;
            }>;
            meta: unknown;
        }>;
        "artifactRead": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
                path?: string | undefined;
                file?: string | undefined;
                index?: number | undefined;
            };
            output: IssueArtifactContent;
            meta: unknown;
        }>;
        "comments": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: Array<_podium_model.IssueComment>;
            meta: unknown;
        }>;
        "events": TRPC.TRPCQueryProcedure<{
            input: Input_issues_events;
            output: Array<PodiumEventRecord>;
            meta: unknown;
        }>;
        "linearSearch": TRPC.TRPCQueryProcedure<{
            input: {
                query: string;
            };
            output: Array<LinearIssue>;
            meta: unknown;
        }>;
        "setState": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                text: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "panelApply": TRPC.TRPCMutationProcedure<{
            input: Input_issues_panelApply;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_issues_create;
            output: Output_issues_create;
            meta: unknown;
        }>;
        "start": TRPC.TRPCMutationProcedure<{
            input: Input_issues_start;
            output: Output_issues_start;
            meta: unknown;
        }>;
        "update": TRPC.TRPCMutationProcedure<{
            input: Input_issues_update;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "promote": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "attachSession": TRPC.TRPCMutationProcedure<{
            input: Input_issues_attachSession;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "archive": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "delete": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: unknown;
            meta: unknown;
        }>;
        "restore": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: unknown;
            meta: unknown;
        }>;
        "action": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                kind: "merge" | "pr" | "rebase";
            };
            output: Output_issues_action;
            meta: unknown;
        }>;
        "cleanup": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_action;
            meta: unknown;
        }>;
        "stop": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                force?: boolean | undefined;
            };
            output: {
                ok: boolean;
                reason?: string | undefined;
                stopped: string[];
                worktreeFreed: boolean;
            };
            meta: unknown;
        }>;
        "integrate": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_action;
            meta: unknown;
        }>;
        "ship": TRPC.TRPCMutationProcedure<{
            input: {
                id?: string | undefined;
            };
            output: Output_issues_ship;
            meta: unknown;
        }>;
        "cancelShip": TRPC.TRPCMutationProcedure<{
            input: {
                orderId: string;
            };
            output: Output_issues_cancelShip;
            meta: unknown;
        }>;
        "resolveShipHold": TRPC.TRPCMutationProcedure<{
            input: {
                action: string;
                orderId: string;
                expectedGeneration: number;
            };
            output: Output_issues_resolveShipHold;
            meta: unknown;
        }>;
        "addSession": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                agentKind?: string | undefined;
                forceUnknownModel?: boolean | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "addShell": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "applySuggestion": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "dismissSuggestion": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "refreshAssistant": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "setLabels": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                labels: string[];
                mutationId?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "share": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                grantee: string;
                verb: "manage" | "read" | "write";
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "unshare": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                grantee: string;
                verb: "manage" | "read" | "write";
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "addComment": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                body: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "depAdd": TRPC.TRPCMutationProcedure<{
            input: {
                fromId: string;
                toId: string;
                type?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "depRemove": TRPC.TRPCMutationProcedure<{
            input: {
                fromId: string;
                toId: string;
                type?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "defer": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                until: string | null;
                mutationId?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "undefer": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "markRead": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "markUnread": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "setTucked": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                tucked: boolean;
                mutationId?: string | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "setNeedsHuman": TRPC.TRPCMutationProcedure<{
            input: Input_issues_setNeedsHuman;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "answerQuestion": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                answer: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_answerQuestion;
            meta: unknown;
        }>;
        "clearNeedsHuman": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "reparent": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                parentId: string | null;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "setPlacement": TRPC.TRPCMutationProcedure<{
            input: Input_issues_setPlacement;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "claim": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                assignee: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "setCoordinator": TRPC.TRPCMutationProcedure<{
            input: Input_issues_setCoordinator;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "close": TRPC.TRPCMutationProcedure<{
            input: Input_issues_close;
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "supersede": TRPC.TRPCMutationProcedure<{
            input: {
                oldId: string;
                newId: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "duplicate": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                canonicalId: string;
                expectedRevision?: number | undefined;
            };
            output: Output_issues_setState;
            meta: unknown;
        }>;
        "mailSend": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                body: string;
                messageId?: string | undefined;
            };
            output: Output_issues_mailSend;
            meta: unknown;
        }>;
        "mailInbox": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                id?: string | undefined;
            });
            output: Output_issues_mailInbox;
            meta: unknown;
        }>;
        "mailClaim": TRPC.TRPCMutationProcedure<{
            input: {
                messageId: string;
            };
            output: Output_issues_mailClaim;
            meta: unknown;
        }>;
        "mailPending": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                id?: string | undefined;
            });
            output: {
                unread: number;
                senders: string[];
            };
            meta: unknown;
        }>;
        "subscriptionAdd": TRPC.TRPCMutationProcedure<{
            input: Input_issues_subscriptionAdd;
            output: Output_issues_subscriptionAdd;
            meta: unknown;
        }>;
        "subscriptionRemove": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: {
                removed: boolean;
            };
            meta: unknown;
        }>;
        "subscriptionSetEnabled": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                enabled: boolean;
            };
            output: {
                updated: boolean;
            };
            meta: unknown;
        }>;
        "subscriptionList": TRPC.TRPCQueryProcedure<{
            input: void;
            output: Array<Subscription>;
            meta: unknown;
        }>;
    };
    "lock": {
        "acquire": TRPC.TRPCMutationProcedure<{
            input: Input_lock_acquire;
            output: Protocol.LockAcquireResultWire;
            meta: unknown;
        }>;
        "cancel": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                repoPath: string;
            };
            output: {
                cancelled: true;
            };
            meta: unknown;
        }>;
        "release": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                repoPath: string;
            };
            output: {
                released: true;
                next: Protocol.LockHolderWire | null;
            };
            meta: unknown;
        }>;
        "renew": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                repoPath: string;
                ttlSeconds?: number | undefined;
            };
            output: Protocol.LockWire;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath: string;
                name?: string | undefined;
            };
            output: Array<Protocol.LockWire>;
            meta: unknown;
        }>;
        "steal": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                repoPath: string;
                note?: string | undefined;
                ttlSeconds?: number | undefined;
            };
            output: {
                lock: Protocol.LockWire;
                previousHolder: Protocol.LockHolderWire | null;
            };
            meta: unknown;
        }>;
    };
    "messages": {
        "send": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "inbox": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "dismiss": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "cancel": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "dismissNotice": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "show": TRPC.TRPCQueryProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "records": TRPC.TRPCQueryProcedure<{
            input: any;
            output: {
                records: _podium_model.MessageRecordWire[];
            };
            meta: unknown;
        }>;
        "ledger": TRPC.TRPCQueryProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "reply": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "spawnAgent": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "awaitAgent": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
    };
    "logs": {
        "forward": TRPC.TRPCMutationProcedure<{
            input: Input_logs_forward;
            output: ForwardResult;
            meta: unknown;
        }>;
        "setLevel": TRPC.TRPCMutationProcedure<{
            input: Input_logs_setLevel;
            output: SetLevelResult;
            meta: unknown;
        }>;
        "setDaemonLevel": TRPC.TRPCMutationProcedure<{
            input: Input_logs_setDaemonLevel;
            output: SetDaemonLevelResult;
            meta: unknown;
        }>;
        "crash": TRPC.TRPCMutationProcedure<{
            input: Input_logs_crash;
            output: CrashResult;
            meta: unknown;
        }>;
    };
    "git": {
        "status": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                root: string;
                path?: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "log": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                root: string;
                path?: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "diffFile": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                root: string;
                path?: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "commitFiles": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                root: string;
                path?: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "commitDiffFile": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                root: string;
                path?: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
    };
    "files": {
        "write": TRPC.TRPCMutationProcedure<{
            input: Input_files_write;
            output: {
                error?: string | undefined;
                ok: boolean;
                baseHash?: string | undefined;
                conflict?: boolean | undefined;
            };
            meta: unknown;
        }>;
        "read": TRPC.TRPCQueryProcedure<{
            input: Input_files_read;
            output: Output_files_read;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: {
                root: string;
                path?: string | undefined;
                machineId?: string | undefined;
            };
            output: {
                error?: string | undefined;
                path: string;
                entries: {
                    name: string;
                    isDir: boolean;
                }[];
                ok: boolean;
            };
            meta: unknown;
        }>;
        "search": TRPC.TRPCQueryProcedure<{
            input: {
                root: string;
                query?: string | undefined;
                machineId?: string | undefined;
                limit?: number | undefined;
            };
            output: {
                paths: string[];
            };
            meta: unknown;
        }>;
    };
    "workflows": {
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_create;
            output: Output_workflows_create;
            meta: unknown;
        }>;
        "skip": TRPC.TRPCMutationProcedure<{
            input: {
                stepId: string;
                mutationId?: string | undefined;
                reason?: string | undefined;
                runId?: string | undefined;
            };
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "retry": TRPC.TRPCMutationProcedure<{
            input: {
                stepId: string;
                mutationId?: string | undefined;
                runId?: string | undefined;
            };
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "adopt": TRPC.TRPCMutationProcedure<{
            input: {
                revisionId: string;
                mutationId?: string | undefined;
                runId?: string | undefined;
                startStepId?: string | undefined;
            };
            output: Protocol.WorkflowRunWire;
            meta: unknown;
        }>;
        "publish": TRPC.TRPCMutationProcedure<{
            input: {
                revisionId: string;
            };
            output: Protocol.WorkflowRevisionWire;
            meta: unknown;
        }>;
        "revise": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_revise;
            output: Protocol.WorkflowRevisionWire;
            meta: unknown;
        }>;
        "fork": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_fork;
            output: Output_workflows_create;
            meta: unknown;
        }>;
        "assign": TRPC.TRPCMutationProcedure<{
            input: {
                targetId: string;
                revisionId: string;
                targetKind: "issue" | "session" | "global" | "repository";
            };
            output: Protocol.WorkflowBindingWire;
            meta: unknown;
        }>;
        "profileSave": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_profileSave;
            output: Protocol.ExecutionProfileWire;
            meta: unknown;
        }>;
        "checkpoint": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_checkpoint;
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "assignStep": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string | null;
                stepId: string;
                mutationId?: string | undefined;
                runId?: string | undefined;
            };
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: {
                runId?: string | undefined;
            };
            output: Protocol.WorkflowRunWire;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: Input_workflows_list;
            output: Array<Protocol.WorkflowWire>;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: Output_workflows_get;
            meta: unknown;
        }>;
        "prime": TRPC.TRPCQueryProcedure<{
            input: {} & {
                [k: string]: unknown;
            };
            output: string;
            meta: unknown;
        }>;
        "bindings": TRPC.TRPCQueryProcedure<{
            input: {} & {
                [k: string]: unknown;
            };
            output: Array<Protocol.WorkflowBindingWire>;
            meta: unknown;
        }>;
        "profiles": TRPC.TRPCQueryProcedure<{
            input: {} & {
                [k: string]: unknown;
            };
            output: Array<Protocol.ExecutionProfileWire>;
            meta: unknown;
        }>;
        "runs": TRPC.TRPCQueryProcedure<{
            input: {
                includeTerminal?: boolean | undefined;
            };
            output: Array<Protocol.WorkflowRunWire>;
            meta: unknown;
        }>;
    };
    "automations": {
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_automations_create;
            output: Output_automations_create;
            meta: unknown;
        }>;
        "remove": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: {
                removed: boolean;
            };
            meta: unknown;
        }>;
        "update": TRPC.TRPCMutationProcedure<{
            input: Input_automations_update;
            output: Output_automations_create;
            meta: unknown;
        }>;
        "setEnabled": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                enabled: boolean;
            };
            output: Output_automations_create;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Output_automations_list;
            meta: unknown;
        }>;
        "runs": TRPC.TRPCQueryProcedure<{
            input: {
                automationId: string;
                limit?: number | undefined;
            };
            output: Output_automations_runs;
            meta: unknown;
        }>;
    };
    "specs": {
        "create": TRPC.TRPCMutationProcedure<{
            input: {
                parent: string;
                title: string;
                repoPath: string;
            };
            output: SpecComponent;
            meta: unknown;
        }>;
        "remove": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                repoPath: string;
            };
            output: {
                ok: boolean;
            };
            meta: unknown;
        }>;
        "save": TRPC.TRPCMutationProcedure<{
            input: Input_specs_save;
            output: SpecComponent;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath: string;
            };
            output: Array<SpecComponentMeta>;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
                repoPath: string;
            };
            output: (null) | (SpecComponent);
            meta: unknown;
        }>;
        "search": TRPC.TRPCQueryProcedure<{
            input: {
                query: string;
                repoPath: string;
            };
            output: Array<SpecSearchHit>;
            meta: unknown;
        }>;
    };
    "approvals": {
        "approve": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Protocol.ApprovalWire;
            meta: unknown;
        }>;
        "deny": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Protocol.ApprovalWire;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({} & {
                [k: string]: unknown;
            });
            output: Array<Protocol.ApprovalWire>;
            meta: unknown;
        }>;
    };
    "interactions": {
        "answer": TRPC.TRPCMutationProcedure<{
            input: Input_interactions_answer;
            output: Output_interactions_answer;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                sessionId?: string | undefined;
            });
            output: Array<Protocol.PendingInteractionWire>;
            meta: unknown;
        }>;
        "forSession": TRPC.TRPCQueryProcedure<{
            input: {
                sessionId: string;
                limit?: number | undefined;
            };
            output: Array<Protocol.PendingInteractionWire>;
            meta: unknown;
        }>;
    };
}>;
type RouterInputs = TRPC.inferRouterInputs<AppRouter>;
type RouterOutputs = TRPC.inferRouterOutputs<AppRouter>;

export type { AppRouter, RouterInputs, RouterOutputs };
