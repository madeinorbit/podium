// Generated from apps/server/src/router.ts. Run bun run api:types. Do not edit.
import * as _podium_model from '@podium/model';
import { MachineId, UserId, SessionId, IssueId, ArtifactId, UpdateChannel, MachinePresenceSource, GitRepositoryWire, GitDiscoveryDiagnosticWire, TranscriptItem, AgentKind, AccountId, AgentPhase, SessionMeta, MachineProjection, HarnessAgent } from '@podium/model';
import { z } from 'zod';
import * as Protocol from '@podium/protocol';
import { ModelChoiceWire, ConvergenceState, MobileWebIdentity, FeatureState, FeatureVisibility } from '@podium/protocol';
import * as TRPC from '@trpc/server';

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
            startScreen: z.ZodDefault<z.ZodEnum<["native", "chat", "auto"]>>;
            seedCliTheme: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            model: string;
            effort: string;
            accountId: string & z.BRAND<"AccountId">;
            subagentModel: string;
            startScreen: "auto" | "native" | "chat";
            seedCliTheme: boolean;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
        }, {
            model?: string | undefined;
            effort?: string | undefined;
            accountId?: string | undefined;
            harness?: "claude-code" | "codex" | "grok" | "opencode" | "cursor" | "pi" | undefined;
            subagentModel?: string | undefined;
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

interface LinearIssue {
    identifier: string;
    title: string;
    state: string;
    assignee?: string;
    url: string;
}

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

type OperationActionResult = Record<string, unknown>;

interface TelegramSetupStartResult {
    setupId: string;
    code: string;
    botUsername: string;
    telegramUrl: string;
    expiresAt: string;
}

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

/** One durable turn failure, as `latestTurnFailure` serves it. `userText` is
 *  null when the turn reached a harness (the transcript carries the prompt);
 *  the user row is persisted only for turns that provably never dispatched. */
interface SuperagentTurnFailure {
    inputId: string;
    userText: string | null;
    error: string;
    at: string;
}

type NetworkOption = 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual';

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

type Input_automations_create = {
    agentKind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell";
    cron?: null | string | undefined;
    effort?: string | undefined;
    enabled?: boolean | undefined;
    model?: string | undefined;
    name: string;
    prompt: string;
    repoPath?: null | string | undefined;
    runAt?: null | string | undefined;
    scheduleKind?: "cron" | "once" | undefined;
    sessionMode?: "fresh" | "resume" | undefined;
    targetSessionId?: null | string | undefined;
};
type Input_automations_update = {
    id: string;
    patch: {
        agentKind?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell" | undefined;
        cron?: null | string | undefined;
        effort?: string | undefined;
        enabled?: boolean | undefined;
        model?: string | undefined;
        name?: string | undefined;
        prompt?: string | undefined;
        repoPath?: null | string | undefined;
        runAt?: null | string | undefined;
        scheduleKind?: "cron" | "once" | undefined;
        sessionMode?: "fresh" | "resume" | undefined;
        targetSessionId?: null | string | undefined;
    };
};
type Input_cloud_createAgent = {
    displayName: string;
    issueId?: string | undefined;
    purpose?: string | undefined;
    repo: {
        name: string;
        owner: string;
        provider: "github";
        ref?: string | undefined;
    };
    size?: "large" | "medium" | "small" | undefined;
    sourceSession?: undefined | {
        agent: "claude-code" | "codex";
        cwd?: string | undefined;
        machineId?: string | undefined;
        resumeRef?: string | undefined;
        sessionId: string;
    };
    tenantId: string;
};
type Input_cloud_createMachine = {
    displayName: string;
    purpose?: string | undefined;
    repo?: undefined | {
        name: string;
        owner: string;
        provider: "github";
        ref?: string | undefined;
    };
    size: "large" | "medium" | "small";
    tenantId: string;
};
type Input_cloud_moveSession = {
    hibernateLocal?: boolean | undefined;
    repo?: undefined | {
        name: string;
        owner: string;
        provider: "github";
        ref?: string | undefined;
    };
    sessionId: string;
    size?: "large" | "medium" | "small" | undefined;
    tenantId: string;
};
type Input_files_read = ({
    artifactId: string;
    issueId: string;
    path: string;
}) | ({
    machineId?: string | undefined;
    path: string;
    root: string;
}) | ({
    path: string;
    sessionId: string;
});
type Input_files_write = ({
    baseHash?: string | undefined;
    content: string;
    machineId?: string | undefined;
    path: string;
    root: string;
}) | ({
    baseHash?: string | undefined;
    content: string;
    path: string;
    sessionId: string;
});
type Input_interactions_answer = {
    answer?: undefined | z.objectInputType<{
        kind: z.ZodString;
    }, z.ZodTypeAny, "passthrough">;
    id: string;
    text?: string | undefined;
};
type Input_issues_attachSession = {
    confirmRehome?: boolean | undefined;
    newSpinoff?: undefined | {
        title: string;
    };
    newSubissue?: undefined | {
        title: string;
    };
    sessionId: string;
    targetId?: string | undefined;
};
type Input_issues_close = {
    confirmInterrupt?: boolean | undefined;
    expectedRevision?: number | undefined;
    id: string;
    mutationId?: string | undefined;
    reason?: string | undefined;
};
type Input_issues_create = {
    assignee?: string | undefined;
    audience?: "agent" | "human" | undefined;
    brief?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    defaultAgent?: string | undefined;
    defaultEffort?: string | undefined;
    defaultModel?: string | undefined;
    description?: string | undefined;
    id?: string | undefined;
    labels?: string[] | undefined;
    linear?: undefined | {
        id?: string | undefined;
        identifier: string;
        url: string;
    };
    machineId?: string | undefined;
    mutationId?: string | undefined;
    parentBranch?: string | undefined;
    parentId?: string | undefined;
    priority?: number | undefined;
    repoPath: string;
    startNow: boolean;
    startSessionId?: string | undefined;
    title: string;
    type?: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task" | undefined;
};
type Input_issues_events = {
    kinds?: string[] | undefined;
    limit?: number | undefined;
    repoPath?: string | undefined;
    since?: number | undefined;
    subject?: string | undefined;
};
type Input_issues_panelApply = {
    expectedRevision?: number | undefined;
    extraPaths?: string[] | undefined;
    id: string;
    index?: number | undefined;
    op: "artifact-add" | "artifact-remove" | "deferred-add" | "deferred-remove" | "todo-add" | "todo-clear" | "todo-done" | "todo-remove" | "todo-undone";
    path?: string | undefined;
    sourceRoot?: string | undefined;
    terminalEvidence?: boolean | undefined;
    text?: string | undefined;
    title?: string | undefined;
};
type Input_issues_search = {
    assignee?: string | undefined;
    label?: string | undefined;
    parentId?: string | undefined;
    priority?: number | undefined;
    repoPath?: string | undefined;
    stage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    status?: "blocked" | "closed" | "deferred" | "open" | "ready" | undefined;
    text?: string | undefined;
    type?: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task" | undefined;
};
type Input_issues_setCoordinator = {
    claim?: boolean | undefined;
    expectedRevision?: number | undefined;
    id: string;
    sessionId?: null | string | undefined;
};
type Input_issues_setNeedsHuman = {
    askedBy?: string | undefined;
    expectedRevision?: number | undefined;
    id: string;
    options?: string[] | undefined;
    question?: string | undefined;
};
type Input_issues_setPlacement = {
    expectedRevision?: number | undefined;
    id: string;
    mutationId?: string | undefined;
    originId: string;
    placement: "mission" | "own";
};
type Input_issues_start = {
    agentKind?: string | undefined;
    defaultEffort?: string | undefined;
    defaultModel?: string | undefined;
    forceUnknownModel?: boolean | undefined;
    id: string;
    mutationId?: string | undefined;
};
type Input_issues_subscriptionAdd = {
    deliver?: undefined | {
        notify?: boolean | undefined;
        nudge?: boolean | undefined;
    };
    event: string;
    source: {
        kind: "issue" | "relationship" | "session";
        ref: string;
    };
    subscriber?: undefined | {
        id: string;
        kind: "issue" | "session";
    };
};
type Input_issues_update = {
    confirmInterrupt?: boolean | undefined;
    expectedRevision?: number | undefined;
    id: string;
    mutationId?: string | undefined;
    patch: {
        acceptance?: string | undefined;
        archived?: boolean | undefined;
        assignee?: string | undefined;
        brief?: string | undefined;
        closedReason?: string | undefined;
        color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | null | undefined;
        defaultAgent?: string | undefined;
        defaultEffort?: string | undefined;
        defaultModel?: string | undefined;
        deferUntil?: string | undefined;
        description?: string | undefined;
        design?: string | undefined;
        dueAt?: string | undefined;
        estimateMin?: number | undefined;
        machineId?: null | string | undefined;
        notes?: string | undefined;
        parentBranch?: string | undefined;
        parentId?: string | undefined;
        pinned?: boolean | undefined;
        priority?: number | undefined;
        sortKey?: string | undefined;
        stage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
        title?: string | undefined;
        type?: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task" | undefined;
    };
};
type Input_lock_acquire = {
    allowSibling?: boolean | undefined;
    name: string;
    note?: string | undefined;
    repoPath: string;
    ttlSeconds?: number | undefined;
};
type Input_logs_crash = {
    context?: Record<string, unknown> | undefined;
    err: {
        message: string;
        name: string;
        stack?: string | undefined;
    };
    origin: {
        machineId?: string | undefined;
        role: string;
        v?: string | undefined;
    };
    snapshot?: undefined | z.objectInputType<{
        err: z.ZodOptional<z.ZodObject<{
            message: z.ZodString;
            name: z.ZodString;
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
        level: z.ZodEnum<["error", "warn", "info", "debug", "trace"]>;
        msg: z.ZodString;
        ns: z.ZodString;
        ts: z.ZodString;
    }, z.ZodUnknown, "strip">[];
};
type Input_logs_forward = {
    dropped?: number | undefined;
    origin: {
        machineId?: string | undefined;
        role: string;
        v?: string | undefined;
    };
    records: z.objectInputType<{
        err: z.ZodOptional<z.ZodObject<{
            message: z.ZodString;
            name: z.ZodString;
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
        level: z.ZodEnum<["error", "warn", "info", "debug", "trace"]>;
        msg: z.ZodString;
        ns: z.ZodString;
        ts: z.ZodString;
    }, z.ZodUnknown, "strip">[];
};
type Input_logs_setDaemonLevel = {
    level: "debug" | "error" | "info" | "trace" | "warn" | null;
    target?: undefined | {
        machineId?: string | undefined;
    };
    ttlMs?: number | undefined;
};
type Input_logs_setLevel = {
    level: "debug" | "error" | "info" | "trace" | "warn" | null;
    target?: undefined | {
        clientId?: string | undefined;
        machineId?: string | undefined;
        role?: string | undefined;
    };
    ttlMs?: number | undefined;
};
type Input_machines_moveServer = {
    bindHost: "0.0.0.0" | "127.0.0.1";
    confirmation: "TRANSFER SERVER";
    port?: number | undefined;
    publicUrl: string;
    targetMachineId: string;
};
type Input_machines_pairingCode = (undefined) | ({
    copyAgentCredentials?: boolean | undefined;
    podiumManaged?: boolean | undefined;
    replaceMachineId?: string | undefined;
});
type Input_perf_report = {
    cold: boolean;
    issueId?: null | string | undefined;
    marks: {
        atMs: number;
        meta?: Record<string, boolean | number | string> | undefined;
        name: string;
    }[];
    meta?: Record<string, boolean | number | string> | undefined;
    mode: "chat" | "native" | "unknown";
    sessionId: string;
    startedAt: number;
    switchId: string;
    timedOut: boolean;
    totalMs: number;
};
type Input_sessions_answerAskUserQuestion = {
    choices?: ({
        freeText: string;
        multiSelect?: boolean | undefined;
        otherIndex: number;
        previewLayout?: boolean | undefined;
    } | {
        multiSelect?: boolean | undefined;
        optionIndices: number[];
        previewLayout?: boolean | undefined;
    })[] | undefined;
    interactionId?: string | undefined;
    sessionId: string;
    skip?: true | undefined;
};
type Input_sessions_create = {
    agentKind?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell" | undefined;
    cwd: string;
    draftArtifacts?: undefined | {
        dataBase64: string;
        filename: string;
        id: string;
        mimeType: string;
    }[];
    draftIssue?: undefined | {
        issueId?: string | undefined;
        repoPath: string;
    };
    effort?: string | undefined;
    forceUnknownModel?: boolean | undefined;
    initialPrompt?: string | undefined;
    issueId?: string | undefined;
    machineId?: string | undefined;
    model?: string | undefined;
    mutationId?: string | undefined;
    requestedDriverId?: string | undefined;
    sessionId?: string | undefined;
    title?: string | undefined;
    workflowRevisionId?: string | undefined;
};
type Input_sessions_resume = {
    agentKind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell";
    conversationId: string;
    cwd: string;
    machineId?: string | undefined;
    resume: {
        kind: string;
        value: string;
    };
    title?: string | undefined;
};
type Input_sessions_resumeAndSend = {
    attachments?: undefined | {
        filename: string;
        id: string;
        kind: "file" | "image";
        mediaType: string;
        path: string;
    }[];
    mutationId?: string | undefined;
    sessionId: string;
    text: string;
};
type Input_sessions_setWorkState = {
    mutationId?: string | undefined;
    sessionId: string;
    workState: "done" | "icebox" | "implementing" | "planning" | "testing" | null;
};
type Input_settings_clearSecret = {
    key: "apiKeys.anthropic" | "apiKeys.openai" | "apiKeys.openrouter" | "integrations.linearApiKey" | "notifications.telegramBotToken";
};
type Input_settings_setSecret = {
    key: "apiKeys.anthropic" | "apiKeys.openai" | "apiKeys.openrouter" | "integrations.linearApiKey" | "notifications.telegramBotToken";
    value: string;
};
type Input_setup_complete = {
    acknowledgeNoPassword?: true | undefined;
    confirmUrlChange?: true | undefined;
    mode?: "all-in-one" | "server" | undefined;
    networkOption?: "cloudflare-tunnel" | "manual" | "tailscale-funnel" | "tailscale-serve" | undefined;
    password?: string | undefined;
    publicUrl: string;
    telemetry?: undefined | {
        crash: "off" | "on";
        usage: "off" | "on";
    };
};
type Input_specs_save = {
    body?: string | undefined;
    id: string;
    order?: number | undefined;
    parent?: string | undefined;
    repoPath: string;
    status?: "active" | "draft" | "superseded" | undefined;
    title?: string | undefined;
};
type Input_superagent_concierge = {
    focus?: undefined | {
        filePath?: string | undefined;
        focusedSessionId?: string | undefined;
        issueId?: string | undefined;
        openFilePaths?: string[] | undefined;
        openIssueId?: string | undefined;
        view?: string | undefined;
        visibleSessionIds?: string[] | undefined;
        worktreePath?: string | undefined;
    };
    repoPath: string;
    text: string;
};
type Input_superagent_sendTurn = {
    agentKind?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | undefined;
    attachSessionId?: string | undefined;
    effort?: string | undefined;
    focus?: undefined | {
        filePath?: string | undefined;
        focusedSessionId?: string | undefined;
        issueId?: string | undefined;
        openFilePaths?: string[] | undefined;
        openIssueId?: string | undefined;
        view?: string | undefined;
        visibleSessionIds?: string[] | undefined;
        worktreePath?: string | undefined;
    };
    model?: string | undefined;
    text: string;
    threadId?: string | undefined;
};
type Input_workflows_checkpoint = {
    evidence?: undefined | {
        artifacts?: string[] | undefined;
        summary?: string | undefined;
        tests?: string[] | undefined;
    };
    mutationId?: string | undefined;
    observation?: null | undefined | {
        ahead: null | number;
        behind: null | number;
        branch: null | string;
        cwd: string;
        dirty: boolean | null;
        head: null | string;
        observedAt: string;
        worktree: null | string;
    };
    runId?: string | undefined;
    status: "active" | "blocked" | "complete";
    stepId?: string | undefined;
    summary?: string | undefined;
};
type Input_workflows_create = {
    description?: string | undefined;
    instructions?: string | undefined;
    name: string;
    scope: "global" | "repository" | "task";
    scopeRef?: null | string | undefined;
    steps?: undefined | {
        completionGuidance?: string | undefined;
        executionProfileId?: string | undefined;
        id: string;
        instructions?: string | undefined;
        title: string;
    }[];
};
type Input_workflows_fork = {
    description?: string | undefined;
    name: string;
    revisionId: string;
    scope: "global" | "repository" | "task";
    scopeRef?: null | string | undefined;
};
type Input_workflows_list = {
    includeArchived?: boolean | undefined;
    scope?: "global" | "repository" | "task" | undefined;
    scopeRef?: string | undefined;
};
type Input_workflows_profileSave = {
    accountId: string;
    effort?: string | undefined;
    harness: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell";
    id?: string | undefined;
    machineId?: null | string | undefined;
    model?: string | undefined;
    name: string;
};
type Input_workflows_revise = {
    instructions?: string | undefined;
    steps?: undefined | {
        completionGuidance?: string | undefined;
        executionProfileId?: string | undefined;
        id: string;
        instructions?: string | undefined;
        title: string;
    }[];
    workflowId: string;
};
type Output_accounts_login = Pick<{
    accountId?: (string & z.BRAND<"AccountId">) | undefined;
    agentColor?: string | undefined;
    agentKind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell";
    agentState?: undefined | {
        awaitingSubagents?: boolean | undefined;
        error?: undefined | {
            class: string;
            detail?: string | undefined;
            retryable: boolean;
        };
        idle?: undefined | {
            kind: "approval" | "done" | "interrupted" | "open_todos" | "question";
            summary?: string | undefined;
        };
        nativeSubagentCount: number;
        nativeSubagents?: undefined | {
            id: string;
            type?: string | undefined;
        }[];
        need?: undefined | {
            ask?: undefined | {
                canAlwaysAllow?: boolean | undefined;
                detail?: string | undefined;
                toolName: string;
            };
            interview?: undefined | {
                questions: {
                    header?: string | undefined;
                    multiSelect?: boolean | undefined;
                    options: {
                        description?: string | undefined;
                        label: string;
                        preview?: string | undefined;
                    }[];
                    question: string;
                }[];
            };
            kind: "permission" | "question";
            summary?: string | undefined;
        };
        observationGap?: undefined | {
            reason: "transcript_disabled";
        };
        phase: "compacting" | "ended" | "errored" | "idle" | "needs_user" | "unknown" | "working";
        since: string;
        stateConfidence?: number | undefined;
        stateObservedAt?: string | undefined;
        stateSource?: "classifier" | "hook" | "poll" | undefined;
        workingMsTotal?: number | undefined;
    };
    archived: boolean;
    attachKinds?: ("client" | "engine")[] | undefined;
    busy?: boolean | undefined;
    clientCount: number;
    configureFields?: string[] | undefined;
    contextUsagePercent?: number | undefined;
    controllerId: null | string;
    conversationPodiumId?: (string & z.BRAND<"ConversationId">) | undefined;
    createdAt: string;
    createdBy?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    cwd: string;
    delegation?: undefined | {
        actor: string & z.BRAND<"AgentIdentityId">;
        grantedScope: {
            kind: "all";
        } | {
            kind: "none";
        } | {
            kind: "owned";
            userId: string & z.BRAND<"UserId">;
        } | {
            kind: "self";
            userId: string & z.BRAND<"UserId">;
        } | {
            kind: "subtree";
            rootId: string & z.BRAND<"IssueId">;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
        parentBindingId: (string & z.BRAND<"SessionId">) | null;
        revision: number;
    };
    draftSyncEngine?: boolean | undefined;
    draftUpdatedAt?: string | undefined;
    driverFamily?: "server" | "terminal" | undefined;
    driverId?: string | undefined;
    effort?: string | undefined;
    epoch: number;
    executionProfileId?: string | undefined;
    exitCode?: number | undefined;
    geometry: {
        cols: number;
        rows: number;
    };
    geometryState?: "absent" | "current" | "unknown" | undefined;
    handoffTargetMachineId?: (string & z.BRAND<"MachineId">) | undefined;
    harnessHandoff?: boolean | undefined;
    harnessPromptModeHints?: boolean | undefined;
    headless?: boolean | undefined;
    issueId?: (string & z.BRAND<"IssueId">) | undefined;
    lastActiveAt: string;
    lastInputAt?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    model?: string | undefined;
    name?: string | undefined;
    nameSource?: "agent" | "user" | undefined;
    neverBound?: true | undefined;
    observedEffort?: string | undefined;
    observedModel?: string | undefined;
    offer?: null | undefined | {
        actions: {
            input?: boolean | undefined;
            label: string;
            prompt: string;
        }[];
        artifacts?: string[] | undefined;
        createdAt: string;
        message: string;
    };
    origin: {
        conversationId: string;
        kind: "resume";
    } | {
        kind: "spawn";
    };
    queuedMessageCount?: number | undefined;
    refDraft?: number | undefined;
    refIssueId?: (string & z.BRAND<"IssueId">) | undefined;
    refLetter?: string | undefined;
    refRepoId?: (string & z.BRAND<"RepoId">) | undefined;
    refSeq?: number | undefined;
    requestedDriverId?: string | undefined;
    requestedEffort?: string | undefined;
    requestedModel?: string | undefined;
    requestsDuplicate?: number | undefined;
    requestsGated?: number | undefined;
    requestsUnanswered?: number | undefined;
    resumable?: boolean | undefined;
    resume?: undefined | {
        kind: string;
        value: string;
    };
    sessionId: string & z.BRAND<"SessionId">;
    spawnFailure?: string | undefined;
    spawnedBy?: string | undefined;
    status: "exited" | "hibernated" | "live" | "reconnecting" | "starting";
    stopReason?: "exited" | "forced" | "oom" | "parent" | "self" | undefined;
    stoppedAt?: string | undefined;
    title: string;
    transcriptAvailable?: boolean | undefined;
    upstreamStale?: boolean | undefined;
    viaHub?: boolean | undefined;
    workState?: "done" | "icebox" | "implementing" | "planning" | "testing" | undefined;
    workflowRunId?: string | undefined;
    workflowStepId?: string | undefined;
}, "sessionId"> & Required<Pick<{
    accountId?: (string & z.BRAND<"AccountId">) | undefined;
    agentColor?: string | undefined;
    agentKind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell";
    agentState?: undefined | {
        awaitingSubagents?: boolean | undefined;
        error?: undefined | {
            class: string;
            detail?: string | undefined;
            retryable: boolean;
        };
        idle?: undefined | {
            kind: "approval" | "done" | "interrupted" | "open_todos" | "question";
            summary?: string | undefined;
        };
        nativeSubagentCount: number;
        nativeSubagents?: undefined | {
            id: string;
            type?: string | undefined;
        }[];
        need?: undefined | {
            ask?: undefined | {
                canAlwaysAllow?: boolean | undefined;
                detail?: string | undefined;
                toolName: string;
            };
            interview?: undefined | {
                questions: {
                    header?: string | undefined;
                    multiSelect?: boolean | undefined;
                    options: {
                        description?: string | undefined;
                        label: string;
                        preview?: string | undefined;
                    }[];
                    question: string;
                }[];
            };
            kind: "permission" | "question";
            summary?: string | undefined;
        };
        observationGap?: undefined | {
            reason: "transcript_disabled";
        };
        phase: "compacting" | "ended" | "errored" | "idle" | "needs_user" | "unknown" | "working";
        since: string;
        stateConfidence?: number | undefined;
        stateObservedAt?: string | undefined;
        stateSource?: "classifier" | "hook" | "poll" | undefined;
        workingMsTotal?: number | undefined;
    };
    archived: boolean;
    attachKinds?: ("client" | "engine")[] | undefined;
    busy?: boolean | undefined;
    clientCount: number;
    configureFields?: string[] | undefined;
    contextUsagePercent?: number | undefined;
    controllerId: null | string;
    conversationPodiumId?: (string & z.BRAND<"ConversationId">) | undefined;
    createdAt: string;
    createdBy?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    cwd: string;
    delegation?: undefined | {
        actor: string & z.BRAND<"AgentIdentityId">;
        grantedScope: {
            kind: "all";
        } | {
            kind: "none";
        } | {
            kind: "owned";
            userId: string & z.BRAND<"UserId">;
        } | {
            kind: "self";
            userId: string & z.BRAND<"UserId">;
        } | {
            kind: "subtree";
            rootId: string & z.BRAND<"IssueId">;
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
        parentBindingId: (string & z.BRAND<"SessionId">) | null;
        revision: number;
    };
    draftSyncEngine?: boolean | undefined;
    draftUpdatedAt?: string | undefined;
    driverFamily?: "server" | "terminal" | undefined;
    driverId?: string | undefined;
    effort?: string | undefined;
    epoch: number;
    executionProfileId?: string | undefined;
    exitCode?: number | undefined;
    geometry: {
        cols: number;
        rows: number;
    };
    geometryState?: "absent" | "current" | "unknown" | undefined;
    handoffTargetMachineId?: (string & z.BRAND<"MachineId">) | undefined;
    harnessHandoff?: boolean | undefined;
    harnessPromptModeHints?: boolean | undefined;
    headless?: boolean | undefined;
    issueId?: (string & z.BRAND<"IssueId">) | undefined;
    lastActiveAt: string;
    lastInputAt?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    model?: string | undefined;
    name?: string | undefined;
    nameSource?: "agent" | "user" | undefined;
    neverBound?: true | undefined;
    observedEffort?: string | undefined;
    observedModel?: string | undefined;
    offer?: null | undefined | {
        actions: {
            input?: boolean | undefined;
            label: string;
            prompt: string;
        }[];
        artifacts?: string[] | undefined;
        createdAt: string;
        message: string;
    };
    origin: {
        conversationId: string;
        kind: "resume";
    } | {
        kind: "spawn";
    };
    queuedMessageCount?: number | undefined;
    refDraft?: number | undefined;
    refIssueId?: (string & z.BRAND<"IssueId">) | undefined;
    refLetter?: string | undefined;
    refRepoId?: (string & z.BRAND<"RepoId">) | undefined;
    refSeq?: number | undefined;
    requestedDriverId?: string | undefined;
    requestedEffort?: string | undefined;
    requestedModel?: string | undefined;
    requestsDuplicate?: number | undefined;
    requestsGated?: number | undefined;
    requestsUnanswered?: number | undefined;
    resumable?: boolean | undefined;
    resume?: undefined | {
        kind: string;
        value: string;
    };
    sessionId: string & z.BRAND<"SessionId">;
    spawnFailure?: string | undefined;
    spawnedBy?: string | undefined;
    status: "exited" | "hibernated" | "live" | "reconnecting" | "starting";
    stopReason?: "exited" | "forced" | "oom" | "parent" | "self" | undefined;
    stoppedAt?: string | undefined;
    title: string;
    transcriptAvailable?: boolean | undefined;
    upstreamStale?: boolean | undefined;
    viaHub?: boolean | undefined;
    workState?: "done" | "icebox" | "implementing" | "planning" | "testing" | undefined;
    workflowRunId?: string | undefined;
    workflowStepId?: string | undefined;
}, "machineId">> & {
    error?: string;
    machineName: _podium_model.MachineProjection["name"];
    status: NativeLoginAttemptStatus;
};
type Output_auth_status = {
    canManageInstance: boolean;
    hasOwnCredential: boolean;
    loginPolicySource: SettingSource;
    loginRequired: boolean;
};
type Output_automations_create = {
    agentKind: string;
    createdAt: string;
    cron: null | string;
    effort: string;
    enabled: boolean;
    id: string & z.BRAND<"AutomationId">;
    lastRunAt: null | string;
    model: string;
    name: string;
    nextRunAt: null | string;
    prompt: string;
    repoPath: null | string;
    runAt: null | string;
    scheduleKind: "cron" | "once";
    sessionMode: "fresh" | "resume";
    targetSessionId: (string & z.BRAND<"SessionId">) | null;
} & {
    createdByActor: string;
    createdByOnBehalfOf: _podium_model.UserId;
    ownerUserId: _podium_model.UserId;
};
type Output_automations_list = Array<{
    agentKind: string;
    createdAt: string;
    cron: null | string;
    effort: string;
    enabled: boolean;
    id: string & z.BRAND<"AutomationId">;
    lastRunAt: null | string;
    model: string;
    name: string;
    nextRunAt: null | string;
    prompt: string;
    repoPath: null | string;
    runAt: null | string;
    scheduleKind: "cron" | "once";
    sessionMode: "fresh" | "resume";
    targetSessionId: (string & z.BRAND<"SessionId">) | null;
} & {
    createdByActor: string;
    createdByOnBehalfOf: _podium_model.UserId;
    ownerUserId: _podium_model.UserId;
}>;
type Output_automations_runs = Array<{
    actor: string;
    onBehalfOf: _podium_model.UserId;
} & {
    automationId: string & z.BRAND<"AutomationId">;
    detail: null | string;
    firedAt: string;
    id: string & z.BRAND<"AutomationRunId">;
    outcome: "error" | "missed" | "skipped_overlap" | "spawned";
    sessionId: (string & z.BRAND<"SessionId">) | null;
}>;
type Output_connect_check = ({
    detail: string;
    error: CheckError;
    ok: false;
}) | ({
    ok: true;
    resolvedTo: string[];
    url: string;
});
type Output_discovery_lastMachineScan = (null) | ({
    deep: boolean;
    diagnostics: _podium_model.GitDiscoveryDiagnosticWire[];
    durationMs: number;
    machineId: _podium_model.MachineId;
    repos: DiscoveredRepo[];
    startedAt: number;
});
type Output_discovery_refreshRepos = {
    diagnostics: _podium_model.GitDiscoveryDiagnosticWire[];
    machines: {
        adoptable?: boolean | undefined;
        appVersion?: null | string | undefined;
        availability?: undefined | {
            daemon: boolean;
            epoch: string;
            server: boolean;
            supervisor: boolean;
        };
        buildReportedAt?: null | string | undefined;
        components?: ("daemon" | "server")[] | undefined;
        daemonReadiness?: undefined | {
            quarantinedBindings: number;
            reason: string;
            state: "attached" | "ready" | "recovering";
        };
        deliveryCaps?: string[] | undefined;
        harnessVersions?: undefined | {
            firstSeen: string;
            harness: string;
            lastSeen: string;
            unverified?: boolean | undefined;
            verifiedThrough?: string | undefined;
            version: string;
        }[];
        hostname: string;
        id: string & z.BRAND<"MachineId">;
        installKind?: null | string | undefined;
        inventory?: undefined | {
            agents: {
                installed: boolean | null;
                kind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi";
                login: {
                    account?: string | undefined;
                    freshness?: number | undefined;
                    identity?: undefined | {
                        email?: string | undefined;
                        fingerprint: string;
                        providerAccountId?: string | undefined;
                    };
                    state: "in" | "out" | "unknown";
                };
                path?: string | undefined;
                probeError?: undefined | {
                    reason: "timed-out";
                    timeoutMs: number;
                };
                version?: string | undefined;
            }[];
            arch: "arm64" | "x64";
            os: "darwin" | "linux" | "win32";
            podiumVersion?: string | undefined;
            runtimeDrivers?: undefined | {
                family: "server" | "terminal";
                harness: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi";
                id: string;
            }[];
            tools: {
                installed: boolean | null;
                name: string;
                path?: string | undefined;
                probeError?: undefined | {
                    reason: "timed-out";
                    timeoutMs: number;
                };
                version?: string | undefined;
            }[];
        };
        lastSeenAt: string;
        name: string;
        online: boolean;
        owned?: boolean | undefined;
        podiumManaged?: boolean | undefined;
        presenceSource?: "legacy-daemon" | "supervisor" | undefined;
        revokedAt?: null | string | undefined;
        serverMoveEligibility?: undefined | {
            eligible: boolean;
            reason?: "current-server" | "offline" | "unsupported" | undefined;
        };
        serviceAssignment?: undefined | {
            agentExecution: boolean;
            server: boolean;
        };
        services?: undefined | {
            agentExecution: {
                observedAt: string;
                policy: "disabled" | "enabled";
                reason?: string | undefined;
                state: "available" | "refused" | "starting" | "stopped";
            };
            agentExecutionLockout?: boolean | undefined;
            crashOwner?: string | undefined;
            server: {
                observedAt: string;
                policy: "disabled" | "enabled";
                reason?: string | undefined;
                state: "available" | "refused" | "starting" | "stopped";
            };
            topology?: undefined | {
                legacyUnits: string[];
                parentUnit: "absent" | "active" | "inactive";
                persistence: "detached" | "systemd" | "unmanaged";
            };
        };
        supersedable?: boolean | undefined;
        supersededBy?: (string & z.BRAND<"MachineId">) | null | undefined;
        targetUnavailableReason?: null | string | undefined;
        targetVersion?: null | string | undefined;
        transferable?: boolean | undefined;
        unowned?: boolean | undefined;
        updateChannel?: "dev" | "edge" | "stable" | undefined;
        updateChannelOverride?: "dev" | "edge" | "stable" | null | undefined;
        use?: "denied" | "granted" | undefined;
        versionState?: "ahead" | "behind" | "current" | "unreported" | undefined;
        wireSchemaDigest?: null | string | undefined;
    }[];
    repositories: _podium_model.GitRepositoryWire[];
};
type Output_discovery_scanMachine = {
    deep: boolean;
    diagnostics: _podium_model.GitDiscoveryDiagnosticWire[];
    durationMs: number;
    machineId: _podium_model.MachineId;
    repos: DiscoveredRepo[];
    startedAt: number;
};
type Output_features_state = {
    channel: "edge" | "stable";
    devMode: boolean;
    flags: FeatureStateWire[];
};
type Output_files_read = {
    baseHash?: string | undefined;
    binary?: boolean | undefined;
    content?: string | undefined;
    error?: string | undefined;
    ok: boolean;
    path: string;
    tooLarge?: boolean | undefined;
};
type Output_hosts_memoryBreakdown = {
    agents: {
        bytes: number;
        processCount: number;
        sessionId: string & z.BRAND<"SessionId">;
    }[];
    disk?: undefined | {
        availableBytes: number;
        path: string;
        totalBytes: number;
        usedBytes: number;
    };
    hostname: string;
    memory: {
        availableBytes: number;
        swapFreeBytes: number;
        swapTotalBytes: number;
        totalBytes: number;
    };
    otherBytes: number;
    projects: {
        bytes: number;
        processCount: number;
        root: string;
        topProcesses: {
            bytes: number;
            name: string;
        }[];
    }[];
    sampledAt: string;
    supported: boolean;
};
type Output_hosts_reclaimInventory = {
    candidates: {
        closedAt: string;
        issueId: string & z.BRAND<"IssueId">;
        machineId: string & z.BRAND<"MachineId">;
        present: boolean;
        protectedReason: null | string;
        title: string;
        worktreePath: string;
    }[];
    diagnostics: {
        machineId: _podium_model.MachineId;
        reason: string;
        repoPath: string;
    }[];
    estimate: ReclaimDiskEstimateState;
    orphans: {
        branch: null | string;
        headSha: null | string;
        machineId: _podium_model.MachineId;
        path: string;
        repoPath: string;
    }[];
};
type Output_interactions_answer = ({
    detail?: string | undefined;
    ok: false;
    reason: "already-answered" | "delivery-failed" | "expired" | "not-yet-supported" | "partial-delivery" | "unknown-interaction";
} & {
    detail?: string;
}) | ({
    detail?: string;
} & {
    ok: true;
});
type Output_issues_action = {
    issue: _podium_model.IssueUserOverlay & Omit<{
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        archived: boolean;
        asked?: undefined | {
            at?: string | undefined;
            attribution?: undefined | {
                actor: {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    job: string;
                    kind: "system";
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            };
            by?: (string & z.BRAND<"SessionId">) | undefined;
            options?: string[] | undefined;
            question: string;
        };
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        audience: "agent" | "human";
        blockedByNotes: string[];
        branch?: string | undefined;
        brief?: string | undefined;
        closedAt?: string | undefined;
        closedReason?: string | undefined;
        color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        createdAt: string;
        createdBy: {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        defaultAgent: string;
        defaultEffort: string;
        defaultModel: string;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        dependencyNote?: string | undefined;
        description: {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        design?: string | undefined;
        dueAt?: string | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        estimateMin?: number | undefined;
        id: string & z.BRAND<"IssueId">;
        intentOrigin: "agent" | "human";
        isDraftVessel: boolean;
        labels: string[];
        lastLifecycleActor?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        needsHuman: boolean;
        notes?: undefined | {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        notesUpdatedAt?: string | undefined;
        owner: string & z.BRAND<"UserId">;
        panel?: undefined | {
            artifacts: {
                addedAt: string;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: undefined | {
                    path: string;
                    size: number;
                }[];
                path: string;
                sourceKind?: "terminal-evidence" | undefined;
                sourcePaths?: string[] | undefined;
                title?: string | undefined;
                tracking?: "tracked" | "unknown" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                addedAt: string;
                text: string;
            }[];
            todos: {
                done: boolean;
                text: string;
            }[];
        };
        parentBranch: string;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        prUrl?: string | undefined;
        priority: number;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        revision?: number | undefined;
        seq: number;
        sortKey?: string | undefined;
        stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        suggestedReason?: string | undefined;
        suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        title: string;
        type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
        updatedAt: string;
        visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
        worktreePath?: string | undefined;
    }, "asked" | "branch" | "createdBy" | "description" | "intentOrigin" | "isDraftVessel" | "lastLifecycleActor" | "notes" | "owner" | "visibility" | "worktreePath"> & Omit<{
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        archived: boolean;
        asked?: undefined | {
            at?: string | undefined;
            attribution?: undefined | {
                actor: {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    job: string;
                    kind: "system";
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            };
            by?: (string & z.BRAND<"SessionId">) | undefined;
            options?: string[] | undefined;
            question: string;
        };
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        audience: "agent" | "human";
        blockedByNotes: string[];
        branch?: string | undefined;
        brief?: string | undefined;
        closedAt?: string | undefined;
        closedReason?: string | undefined;
        color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        createdAt: string;
        createdBy: {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        defaultAgent: string;
        defaultEffort: string;
        defaultModel: string;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        dependencyNote?: string | undefined;
        description: {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        design?: string | undefined;
        dueAt?: string | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        estimateMin?: number | undefined;
        id: string & z.BRAND<"IssueId">;
        intentOrigin: "agent" | "human";
        isDraftVessel: boolean;
        labels: string[];
        lastLifecycleActor?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        needsHuman: boolean;
        notes?: undefined | {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        notesUpdatedAt?: string | undefined;
        owner: string & z.BRAND<"UserId">;
        panel?: undefined | {
            artifacts: {
                addedAt: string;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: undefined | {
                    path: string;
                    size: number;
                }[];
                path: string;
                sourceKind?: "terminal-evidence" | undefined;
                sourcePaths?: string[] | undefined;
                title?: string | undefined;
                tracking?: "tracked" | "unknown" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                addedAt: string;
                text: string;
            }[];
            todos: {
                done: boolean;
                text: string;
            }[];
        };
        parentBranch: string;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        prUrl?: string | undefined;
        priority: number;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        revision?: number | undefined;
        seq: number;
        sortKey?: string | undefined;
        stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        suggestedReason?: string | undefined;
        suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        title: string;
        type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
        updatedAt: string;
        visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
        worktreePath?: string | undefined;
    }, ("acceptance" | "activityNotes" | "asked" | "assignee" | "branch" | "brief" | "closedAt" | "closedReason" | "color" | "coordinatorSessionId" | "deferUntil" | "deletedAt" | "dependencyNote" | "design" | "dueAt" | "duplicateOf" | "estimateMin" | "lastLifecycleActor" | "linearId" | "linearIdentifier" | "linearUrl" | "machineId" | "notes" | "notesUpdatedAt" | "panel" | "parentId" | "prUrl" | "repoId" | "revision" | "sortKey" | "startedBySession" | "suggestedReason" | "suggestedStage" | "supersededBy" | "worktreePath") | ("archived" | "audience" | "blockedByNotes" | "createdAt" | "createdBy" | "defaultAgent" | "defaultEffort" | "defaultModel" | "description" | "id" | "intentOrigin" | "isDraftVessel" | "labels" | "needsHuman" | "owner" | "parentBranch" | "priority" | "seq" | "stage" | "title" | "type" | "updatedAt" | "visibility")> & {
        blocked: boolean;
        branch: null | string;
        childCount: number;
        childDoneCount: number;
        commentCount: number;
        deferred: boolean;
        dependents: _podium_model.IssueDepWire[];
        deps: _podium_model.IssueDepWire[];
        description: string;
        displayRef: string;
        draft: boolean;
        gitState?: _podium_model.IssueGitState;
        humanQuestion?: string;
        humanQuestionAskedAt?: string;
        humanQuestionAskedBy?: _podium_model.SessionId;
        humanQuestionOptions?: string[];
        notes?: string;
        origin: _podium_model.IssueProjection["intentOrigin"];
        prefix?: string;
        ready: boolean;
        repoPath: string;
        worktreePath: null | string;
    };
    ok: boolean;
    output: string;
};
type Output_issues_addComment = _podium_model.IssueUserOverlay & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, "asked" | "branch" | "createdBy" | "description" | "intentOrigin" | "isDraftVessel" | "lastLifecycleActor" | "notes" | "owner" | "visibility" | "worktreePath"> & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, ("acceptance" | "activityNotes" | "asked" | "assignee" | "branch" | "brief" | "closedAt" | "closedReason" | "color" | "coordinatorSessionId" | "deferUntil" | "deletedAt" | "dependencyNote" | "design" | "dueAt" | "duplicateOf" | "estimateMin" | "lastLifecycleActor" | "linearId" | "linearIdentifier" | "linearUrl" | "machineId" | "notes" | "notesUpdatedAt" | "panel" | "parentId" | "prUrl" | "repoId" | "revision" | "sortKey" | "startedBySession" | "suggestedReason" | "suggestedStage" | "supersededBy" | "worktreePath") | ("archived" | "audience" | "blockedByNotes" | "createdAt" | "createdBy" | "defaultAgent" | "defaultEffort" | "defaultModel" | "description" | "id" | "intentOrigin" | "isDraftVessel" | "labels" | "needsHuman" | "owner" | "parentBranch" | "priority" | "seq" | "stage" | "title" | "type" | "updatedAt" | "visibility")> & {
    blocked: boolean;
    branch: null | string;
    childCount: number;
    childDoneCount: number;
    commentCount: number;
    deferred: boolean;
    dependents: _podium_model.IssueDepWire[];
    deps: _podium_model.IssueDepWire[];
    description: string;
    displayRef: string;
    draft: boolean;
    gitState?: _podium_model.IssueGitState;
    humanQuestion?: string;
    humanQuestionAskedAt?: string;
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionOptions?: string[];
    notes?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    prefix?: string;
    ready: boolean;
    repoPath: string;
    worktreePath: null | string;
};
type Output_issues_answerQuestion = {
    deliveredVia: "menu" | "text";
    issue: _podium_model.IssueUserOverlay & Omit<{
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        archived: boolean;
        asked?: undefined | {
            at?: string | undefined;
            attribution?: undefined | {
                actor: {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    job: string;
                    kind: "system";
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            };
            by?: (string & z.BRAND<"SessionId">) | undefined;
            options?: string[] | undefined;
            question: string;
        };
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        audience: "agent" | "human";
        blockedByNotes: string[];
        branch?: string | undefined;
        brief?: string | undefined;
        closedAt?: string | undefined;
        closedReason?: string | undefined;
        color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        createdAt: string;
        createdBy: {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        defaultAgent: string;
        defaultEffort: string;
        defaultModel: string;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        dependencyNote?: string | undefined;
        description: {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        design?: string | undefined;
        dueAt?: string | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        estimateMin?: number | undefined;
        id: string & z.BRAND<"IssueId">;
        intentOrigin: "agent" | "human";
        isDraftVessel: boolean;
        labels: string[];
        lastLifecycleActor?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        needsHuman: boolean;
        notes?: undefined | {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        notesUpdatedAt?: string | undefined;
        owner: string & z.BRAND<"UserId">;
        panel?: undefined | {
            artifacts: {
                addedAt: string;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: undefined | {
                    path: string;
                    size: number;
                }[];
                path: string;
                sourceKind?: "terminal-evidence" | undefined;
                sourcePaths?: string[] | undefined;
                title?: string | undefined;
                tracking?: "tracked" | "unknown" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                addedAt: string;
                text: string;
            }[];
            todos: {
                done: boolean;
                text: string;
            }[];
        };
        parentBranch: string;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        prUrl?: string | undefined;
        priority: number;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        revision?: number | undefined;
        seq: number;
        sortKey?: string | undefined;
        stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        suggestedReason?: string | undefined;
        suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        title: string;
        type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
        updatedAt: string;
        visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
        worktreePath?: string | undefined;
    }, "asked" | "branch" | "createdBy" | "description" | "intentOrigin" | "isDraftVessel" | "lastLifecycleActor" | "notes" | "owner" | "visibility" | "worktreePath"> & Omit<{
        acceptance?: string | undefined;
        activityNotes?: string | undefined;
        archived: boolean;
        asked?: undefined | {
            at?: string | undefined;
            attribution?: undefined | {
                actor: {
                    id: string & z.BRAND<"AgentIdentityId">;
                    kind: "agent";
                } | {
                    id: string & z.BRAND<"MachineId">;
                    kind: "machine";
                } | {
                    id: string & z.BRAND<"UserId">;
                    kind: "user";
                } | {
                    job: string;
                    kind: "system";
                };
                onBehalfOf: (string & z.BRAND<"UserId">) | null;
            };
            by?: (string & z.BRAND<"SessionId">) | undefined;
            options?: string[] | undefined;
            question: string;
        };
        assignee?: (string & z.BRAND<"UserId">) | undefined;
        audience: "agent" | "human";
        blockedByNotes: string[];
        branch?: string | undefined;
        brief?: string | undefined;
        closedAt?: string | undefined;
        closedReason?: string | undefined;
        color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
        coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
        createdAt: string;
        createdBy: {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        defaultAgent: string;
        defaultEffort: string;
        defaultModel: string;
        deferUntil?: string | undefined;
        deletedAt?: string | undefined;
        dependencyNote?: string | undefined;
        description: {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        design?: string | undefined;
        dueAt?: string | undefined;
        duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
        estimateMin?: number | undefined;
        id: string & z.BRAND<"IssueId">;
        intentOrigin: "agent" | "human";
        isDraftVessel: boolean;
        labels: string[];
        lastLifecycleActor?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        linearId?: string | undefined;
        linearIdentifier?: string | undefined;
        linearUrl?: string | undefined;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        needsHuman: boolean;
        notes?: undefined | {
            opsTail?: undefined | unknown[];
            revision?: number | undefined;
            value: string;
        };
        notesUpdatedAt?: string | undefined;
        owner: string & z.BRAND<"UserId">;
        panel?: undefined | {
            artifacts: {
                addedAt: string;
                artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
                entry?: string | undefined;
                files?: undefined | {
                    path: string;
                    size: number;
                }[];
                path: string;
                sourceKind?: "terminal-evidence" | undefined;
                sourcePaths?: string[] | undefined;
                title?: string | undefined;
                tracking?: "tracked" | "unknown" | "untracked" | undefined;
                untrackedPaths?: string[] | undefined;
            }[];
            deferred: {
                addedAt: string;
                text: string;
            }[];
            todos: {
                done: boolean;
                text: string;
            }[];
        };
        parentBranch: string;
        parentId?: (string & z.BRAND<"IssueId">) | undefined;
        prUrl?: string | undefined;
        priority: number;
        repoId?: (string & z.BRAND<"RepoId">) | undefined;
        revision?: number | undefined;
        seq: number;
        sortKey?: string | undefined;
        stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
        startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
        suggestedReason?: string | undefined;
        suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
        supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
        title: string;
        type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
        updatedAt: string;
        visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
        worktreePath?: string | undefined;
    }, ("acceptance" | "activityNotes" | "asked" | "assignee" | "branch" | "brief" | "closedAt" | "closedReason" | "color" | "coordinatorSessionId" | "deferUntil" | "deletedAt" | "dependencyNote" | "design" | "dueAt" | "duplicateOf" | "estimateMin" | "lastLifecycleActor" | "linearId" | "linearIdentifier" | "linearUrl" | "machineId" | "notes" | "notesUpdatedAt" | "panel" | "parentId" | "prUrl" | "repoId" | "revision" | "sortKey" | "startedBySession" | "suggestedReason" | "suggestedStage" | "supersededBy" | "worktreePath") | ("archived" | "audience" | "blockedByNotes" | "createdAt" | "createdBy" | "defaultAgent" | "defaultEffort" | "defaultModel" | "description" | "id" | "intentOrigin" | "isDraftVessel" | "labels" | "needsHuman" | "owner" | "parentBranch" | "priority" | "seq" | "stage" | "title" | "type" | "updatedAt" | "visibility")> & {
        blocked: boolean;
        branch: null | string;
        childCount: number;
        childDoneCount: number;
        commentCount: number;
        deferred: boolean;
        dependents: _podium_model.IssueDepWire[];
        deps: _podium_model.IssueDepWire[];
        description: string;
        displayRef: string;
        draft: boolean;
        gitState?: _podium_model.IssueGitState;
        humanQuestion?: string;
        humanQuestionAskedAt?: string;
        humanQuestionAskedBy?: _podium_model.SessionId;
        humanQuestionOptions?: string[];
        notes?: string;
        origin: _podium_model.IssueProjection["intentOrigin"];
        prefix?: string;
        ready: boolean;
        repoPath: string;
        worktreePath: null | string;
    };
};
type Output_issues_cancelShip = {
    approvedBaseSha: string;
    approvedHeadSha: string;
    closeMode: "after-destination" | "leave-open";
    currentIntegrationReceipt?: undefined | {
        approvedHeadSha: string;
        descendants: {
            approvedHeadSha: string;
            issueId: string & z.BRAND<"IssueId">;
        }[];
        rootIssueId: string & z.BRAND<"IssueId">;
    };
    deliveryDependsOn: (string & z.BRAND<"ShipOrderId">)[];
    descendantManifest: {
        approvedHeadSha: string;
        issueId: string & z.BRAND<"IssueId">;
    }[];
    destination: string;
    evidenceManifestRef?: string | undefined;
    holdCode?: string | undefined;
    id: string & z.BRAND<"ShipOrderId">;
    issueId: string & z.BRAND<"IssueId">;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    policyId: string;
    providerRef?: undefined | {
        id: string;
        provider: string;
        url?: string | undefined;
    };
    repoId: string & z.BRAND<"RepoId">;
    repoPath?: string | undefined;
    requestedAt: string;
    requestedBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    state: "cancelled" | "composing" | "held" | "landing" | "preflight" | "publishing" | "queued" | "repairing" | "shipped" | "validating" | "verifying";
    stateChangedAt: string;
    targetBranch: string;
    validationProfile?: undefined | {
        argv: string[];
        cwd: "integration-root";
        id: string;
        resourceLocks: string[];
        timeoutMs: number;
    };
    validationProfileDigest?: string | undefined;
};
type Output_issues_create = (_podium_model.IssueUserOverlay & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    warning: string;
    worktreePath?: string | undefined;
}, ("acceptance" | "activityNotes" | "asked" | "assignee" | "branch" | "brief" | "closedAt" | "closedReason" | "color" | "coordinatorSessionId" | "deferUntil" | "deletedAt" | "dependencyNote" | "design" | "dueAt" | "duplicateOf" | "estimateMin" | "lastLifecycleActor" | "linearId" | "linearIdentifier" | "linearUrl" | "machineId" | "notes" | "notesUpdatedAt" | "panel" | "parentId" | "prUrl" | "repoId" | "revision" | "sortKey" | "startedBySession" | "suggestedReason" | "suggestedStage" | "supersededBy" | "worktreePath") | ("archived" | "audience" | "blockedByNotes" | "createdAt" | "createdBy" | "defaultAgent" | "defaultEffort" | "defaultModel" | "description" | "id" | "intentOrigin" | "isDraftVessel" | "labels" | "needsHuman" | "owner" | "parentBranch" | "priority" | "seq" | "stage" | "title" | "type" | "updatedAt" | "visibility")> & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, "asked" | "branch" | "createdBy" | "description" | "intentOrigin" | "isDraftVessel" | "lastLifecycleActor" | "notes" | "owner" | "visibility" | "worktreePath"> & {
    blocked: boolean;
    branch: null | string;
    childCount: number;
    childDoneCount: number;
    commentCount: number;
    deferred: boolean;
    dependents: _podium_model.IssueDepWire[];
    deps: _podium_model.IssueDepWire[];
    description: string;
    displayRef: string;
    draft: boolean;
    gitState?: _podium_model.IssueGitState;
    humanQuestion?: string;
    humanQuestionAskedAt?: string;
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionOptions?: string[];
    notes?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    prefix?: string;
    ready: boolean;
    repoPath: string;
    worktreePath: null | string;
}) | (_podium_model.IssueUserOverlay & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, "asked" | "branch" | "createdBy" | "description" | "intentOrigin" | "isDraftVessel" | "lastLifecycleActor" | "notes" | "owner" | "visibility" | "worktreePath"> & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, ("acceptance" | "activityNotes" | "asked" | "assignee" | "branch" | "brief" | "closedAt" | "closedReason" | "color" | "coordinatorSessionId" | "deferUntil" | "deletedAt" | "dependencyNote" | "design" | "dueAt" | "duplicateOf" | "estimateMin" | "lastLifecycleActor" | "linearId" | "linearIdentifier" | "linearUrl" | "machineId" | "notes" | "notesUpdatedAt" | "panel" | "parentId" | "prUrl" | "repoId" | "revision" | "sortKey" | "startedBySession" | "suggestedReason" | "suggestedStage" | "supersededBy" | "worktreePath") | ("archived" | "audience" | "blockedByNotes" | "createdAt" | "createdBy" | "defaultAgent" | "defaultEffort" | "defaultModel" | "description" | "id" | "intentOrigin" | "isDraftVessel" | "labels" | "needsHuman" | "owner" | "parentBranch" | "priority" | "seq" | "stage" | "title" | "type" | "updatedAt" | "visibility")> & {
    blocked: boolean;
    branch: null | string;
    childCount: number;
    childDoneCount: number;
    commentCount: number;
    deferred: boolean;
    dependents: _podium_model.IssueDepWire[];
    deps: _podium_model.IssueDepWire[];
    description: string;
    displayRef: string;
    draft: boolean;
    gitState?: _podium_model.IssueGitState;
    humanQuestion?: string;
    humanQuestionAskedAt?: string;
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionOptions?: string[];
    notes?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    prefix?: string;
    ready: boolean;
    repoPath: string;
    worktreePath: null | string;
});
type Output_issues_get = (null) | ({
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blocked: boolean;
    blockedByNotes: string[];
    branch: null | string;
    brief?: string | undefined;
    childCount: number;
    childDoneCount: number;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    commentCount: number;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deferred: boolean;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    dependents: _podium_model.IssueDepWire[];
    deps: _podium_model.IssueDepWire[];
    description: string;
    design?: string | undefined;
    displayRef: string;
    draft: boolean;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    gitState?: _podium_model.IssueGitState;
    humanQuestion?: string;
    humanQuestionAskedAt?: string;
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionOptions?: string[];
    id: string & z.BRAND<"IssueId">;
    labels: string[];
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: string;
    notesUpdatedAt?: string | undefined;
    origin: _podium_model.IssueProjection["intentOrigin"];
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    pinned: boolean;
    prUrl?: string | undefined;
    prefix?: string;
    priority: number;
    readAt: null | string;
    ready: boolean;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    repoPath: string;
    revision?: number | undefined;
    seq: number;
    sessions: {
        accountId?: (string & z.BRAND<"AccountId">) | undefined;
        agentColor?: string | undefined;
        agentKind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell";
        agentState?: undefined | {
            awaitingSubagents?: boolean | undefined;
            error?: undefined | {
                class: string;
                detail?: string | undefined;
                retryable: boolean;
            };
            idle?: undefined | {
                kind: "approval" | "done" | "interrupted" | "open_todos" | "question";
                summary?: string | undefined;
            };
            nativeSubagentCount: number;
            nativeSubagents?: undefined | {
                id: string;
                type?: string | undefined;
            }[];
            need?: undefined | {
                ask?: undefined | {
                    canAlwaysAllow?: boolean | undefined;
                    detail?: string | undefined;
                    toolName: string;
                };
                interview?: undefined | {
                    questions: {
                        header?: string | undefined;
                        multiSelect?: boolean | undefined;
                        options: {
                            description?: string | undefined;
                            label: string;
                            preview?: string | undefined;
                        }[];
                        question: string;
                    }[];
                };
                kind: "permission" | "question";
                summary?: string | undefined;
            };
            observationGap?: undefined | {
                reason: "transcript_disabled";
            };
            phase: "compacting" | "ended" | "errored" | "idle" | "needs_user" | "unknown" | "working";
            since: string;
            stateConfidence?: number | undefined;
            stateObservedAt?: string | undefined;
            stateSource?: "classifier" | "hook" | "poll" | undefined;
            workingMsTotal?: number | undefined;
        };
        archived: boolean;
        attachKinds?: ("client" | "engine")[] | undefined;
        busy?: boolean | undefined;
        clientCount: number;
        configureFields?: string[] | undefined;
        contextUsagePercent?: number | undefined;
        controllerId: null | string;
        conversationPodiumId?: (string & z.BRAND<"ConversationId">) | undefined;
        createdAt: string;
        createdBy?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        cwd: string;
        delegation?: undefined | {
            actor: string & z.BRAND<"AgentIdentityId">;
            grantedScope: {
                kind: "all";
            } | {
                kind: "none";
            } | {
                kind: "owned";
                userId: string & z.BRAND<"UserId">;
            } | {
                kind: "self";
                userId: string & z.BRAND<"UserId">;
            } | {
                kind: "subtree";
                rootId: string & z.BRAND<"IssueId">;
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
            parentBindingId: (string & z.BRAND<"SessionId">) | null;
            revision: number;
        };
        draftSyncEngine?: boolean | undefined;
        draftUpdatedAt?: string | undefined;
        driverFamily?: "server" | "terminal" | undefined;
        driverId?: string | undefined;
        effort?: string | undefined;
        epoch: number;
        executionProfileId?: string | undefined;
        exitCode?: number | undefined;
        geometry: {
            cols: number;
            rows: number;
        };
        geometryState?: "absent" | "current" | "unknown" | undefined;
        handoffTargetMachineId?: (string & z.BRAND<"MachineId">) | undefined;
        harnessHandoff?: boolean | undefined;
        harnessPromptModeHints?: boolean | undefined;
        headless?: boolean | undefined;
        issueId?: (string & z.BRAND<"IssueId">) | undefined;
        lastActiveAt: string;
        lastInputAt?: string | undefined;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        model?: string | undefined;
        name?: string | undefined;
        nameSource?: "agent" | "user" | undefined;
        neverBound?: true | undefined;
        observedEffort?: string | undefined;
        observedModel?: string | undefined;
        offer?: null | undefined | {
            actions: {
                input?: boolean | undefined;
                label: string;
                prompt: string;
            }[];
            artifacts?: string[] | undefined;
            createdAt: string;
            message: string;
        };
        origin: {
            conversationId: string;
            kind: "resume";
        } | {
            kind: "spawn";
        };
        queuedMessageCount?: number | undefined;
        refDraft?: number | undefined;
        refIssueId?: (string & z.BRAND<"IssueId">) | undefined;
        refLetter?: string | undefined;
        refRepoId?: (string & z.BRAND<"RepoId">) | undefined;
        refSeq?: number | undefined;
        requestedDriverId?: string | undefined;
        requestedEffort?: string | undefined;
        requestedModel?: string | undefined;
        requestsDuplicate?: number | undefined;
        requestsGated?: number | undefined;
        requestsUnanswered?: number | undefined;
        resumable?: boolean | undefined;
        resume?: undefined | {
            kind: string;
            value: string;
        };
        sessionId: string & z.BRAND<"SessionId">;
        spawnFailure?: string | undefined;
        spawnedBy?: string | undefined;
        status: "exited" | "hibernated" | "live" | "reconnecting" | "starting";
        stopReason?: "exited" | "forced" | "oom" | "parent" | "self" | undefined;
        stoppedAt?: string | undefined;
        title: string;
        transcriptAvailable?: boolean | undefined;
        upstreamStale?: boolean | undefined;
        viaHub?: boolean | undefined;
        workState?: "done" | "icebox" | "implementing" | "planning" | "testing" | undefined;
        workflowRunId?: string | undefined;
        workflowStepId?: string | undefined;
    }[];
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    tuckedAt: null | string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    worktreePath: null | string;
});
type Output_issues_mailClaim = {
    claimed: boolean;
    message: {
        body: string;
        claimedAt: null | string;
        claimedBy: null | string;
        createdAt: string;
        fromAuthor: string;
        id: string;
        issueId: _podium_model.IssueId;
        status: "claimed" | "read" | "unread";
    };
};
type Output_issues_mailInbox = Array<{
    body: string;
    claimedAt: null | string;
    claimedBy: null | string;
    createdAt: string;
    fromAuthor: string;
    id: string;
    issueId: _podium_model.IssueId;
    status: "claimed" | "read" | "unread";
    wasUnread: boolean;
}>;
type Output_issues_mailSend = ({
    body: string;
    claimedAt: null | string;
    claimedBy: null | string;
    createdAt: string;
    disposition: SendDisposition;
    fromAuthor: string;
    id: string;
    issueId: _podium_model.IssueId;
    ok: boolean;
    reason?: string | undefined;
    status: "claimed" | "read" | "unread";
}) | ({
    body: string;
    claimedAt: null;
    claimedBy: null;
    createdAt: string;
    disposition: SendDisposition;
    fromAuthor: string;
    id: string;
    issueId: string;
    ok: boolean;
    readAt: null;
    reason?: string | undefined;
    status: "unread";
});
type Output_issues_resolveShipHold = {
    order: {
        approvedBaseSha: string;
        approvedHeadSha: string;
        closeMode: "after-destination" | "leave-open";
        currentIntegrationReceipt?: undefined | {
            approvedHeadSha: string;
            descendants: {
                approvedHeadSha: string;
                issueId: string & z.BRAND<"IssueId">;
            }[];
            rootIssueId: string & z.BRAND<"IssueId">;
        };
        deliveryDependsOn: (string & z.BRAND<"ShipOrderId">)[];
        descendantManifest: {
            approvedHeadSha: string;
            issueId: string & z.BRAND<"IssueId">;
        }[];
        destination: string;
        evidenceManifestRef?: string | undefined;
        holdCode?: string | undefined;
        id: string & z.BRAND<"ShipOrderId">;
        issueId: string & z.BRAND<"IssueId">;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        policyId: string;
        providerRef?: undefined | {
            id: string;
            provider: string;
            url?: string | undefined;
        };
        repoId: string & z.BRAND<"RepoId">;
        repoPath?: string | undefined;
        requestedAt: string;
        requestedBy: {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        state: "cancelled" | "composing" | "held" | "landing" | "preflight" | "publishing" | "queued" | "repairing" | "shipped" | "validating" | "verifying";
        stateChangedAt: string;
        targetBranch: string;
        validationProfile?: undefined | {
            argv: string[];
            cwd: "integration-root";
            id: string;
            resourceLocks: string[];
            timeoutMs: number;
        };
        validationProfileDigest?: string | undefined;
    };
    projection: {
        activity: "checking" | "composing" | "held" | "landing" | "publishing" | "repairing" | "shipped" | "validating" | "verifying" | "waiting";
        destination: string;
        hold?: undefined | {
            actions: string[];
            generation: number;
            headline: string;
            id: string & z.BRAND<"ShipHoldId">;
            reasonCode: string;
        };
        humanState: "in_progress" | "needs_you" | "shipped" | "waiting";
        id: string & z.BRAND<"ShipOrderId">;
        issueId: string & z.BRAND<"IssueId">;
        queueRank?: number | undefined;
        queuedAt: string;
        receiptId?: (string & z.BRAND<"DeliveryReceiptId">) | undefined;
        repoId: string & z.BRAND<"RepoId">;
        state: "composing" | "held" | "landing" | "preflight" | "publishing" | "queued" | "repairing" | "shipped" | "validating" | "verifying";
        stateChangedAt: string;
        targetBranch: string;
        train?: undefined | {
            id: string;
            index: number;
            size: number;
        };
        waitEstimate?: undefined | {
            basis: "lane-history";
            lowerBoundMs: number;
            sampleSize: number;
            upperBoundMs: number;
        };
    };
};
type Output_issues_searchNormalized = Array<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    displayRef: string;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}>;
type Output_issues_ship = {
    created: boolean;
    descendantManifest: {
        approvedHeadSha: string;
        issueId: string & z.BRAND<"IssueId">;
    }[];
    order: {
        approvedBaseSha: string;
        approvedHeadSha: string;
        closeMode: "after-destination" | "leave-open";
        currentIntegrationReceipt?: undefined | {
            approvedHeadSha: string;
            descendants: {
                approvedHeadSha: string;
                issueId: string & z.BRAND<"IssueId">;
            }[];
            rootIssueId: string & z.BRAND<"IssueId">;
        };
        deliveryDependsOn: (string & z.BRAND<"ShipOrderId">)[];
        descendantManifest: {
            approvedHeadSha: string;
            issueId: string & z.BRAND<"IssueId">;
        }[];
        destination: string;
        evidenceManifestRef?: string | undefined;
        holdCode?: string | undefined;
        id: string & z.BRAND<"ShipOrderId">;
        issueId: string & z.BRAND<"IssueId">;
        machineId?: (string & z.BRAND<"MachineId">) | undefined;
        policyId: string;
        providerRef?: undefined | {
            id: string;
            provider: string;
            url?: string | undefined;
        };
        repoId: string & z.BRAND<"RepoId">;
        repoPath?: string | undefined;
        requestedAt: string;
        requestedBy: {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        state: "cancelled" | "composing" | "held" | "landing" | "preflight" | "publishing" | "queued" | "repairing" | "shipped" | "validating" | "verifying";
        stateChangedAt: string;
        targetBranch: string;
        validationProfile?: undefined | {
            argv: string[];
            cwd: "integration-root";
            id: string;
            resourceLocks: string[];
            timeoutMs: number;
        };
        validationProfileDigest?: string | undefined;
    };
    projection: {
        activity: "checking" | "composing" | "held" | "landing" | "publishing" | "repairing" | "shipped" | "validating" | "verifying" | "waiting";
        destination: string;
        hold?: undefined | {
            actions: string[];
            generation: number;
            headline: string;
            id: string & z.BRAND<"ShipHoldId">;
            reasonCode: string;
        };
        humanState: "in_progress" | "needs_you" | "shipped" | "waiting";
        id: string & z.BRAND<"ShipOrderId">;
        issueId: string & z.BRAND<"IssueId">;
        queueRank?: number | undefined;
        queuedAt: string;
        receiptId?: (string & z.BRAND<"DeliveryReceiptId">) | undefined;
        repoId: string & z.BRAND<"RepoId">;
        state: "composing" | "held" | "landing" | "preflight" | "publishing" | "queued" | "repairing" | "shipped" | "validating" | "verifying";
        stateChangedAt: string;
        targetBranch: string;
        train?: undefined | {
            id: string;
            index: number;
            size: number;
        };
        waitEstimate?: undefined | {
            basis: "lane-history";
            lowerBoundMs: number;
            sampleSize: number;
            upperBoundMs: number;
        };
    };
};
type Output_issues_start = _podium_model.IssueUserOverlay & Omit<Partial<{
    agentId: string;
    effort: null | string;
    harness: string;
    machine: string;
    model: null | string;
}> & {
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, ("acceptance" | "activityNotes" | "asked" | "assignee" | "branch" | "brief" | "closedAt" | "closedReason" | "color" | "coordinatorSessionId" | "deferUntil" | "deletedAt" | "dependencyNote" | "design" | "dueAt" | "duplicateOf" | "estimateMin" | "lastLifecycleActor" | "linearId" | "linearIdentifier" | "linearUrl" | "machineId" | "notes" | "notesUpdatedAt" | "panel" | "parentId" | "prUrl" | "repoId" | "revision" | "sortKey" | "startedBySession" | "suggestedReason" | "suggestedStage" | "supersededBy" | "worktreePath") | ("archived" | "audience" | "blockedByNotes" | "createdAt" | "createdBy" | "defaultAgent" | "defaultEffort" | "defaultModel" | "description" | "id" | "intentOrigin" | "isDraftVessel" | "labels" | "needsHuman" | "owner" | "parentBranch" | "priority" | "seq" | "stage" | "title" | "type" | "updatedAt" | "visibility")> & Omit<{
    acceptance?: string | undefined;
    activityNotes?: string | undefined;
    archived: boolean;
    asked?: undefined | {
        at?: string | undefined;
        attribution?: undefined | {
            actor: {
                id: string & z.BRAND<"AgentIdentityId">;
                kind: "agent";
            } | {
                id: string & z.BRAND<"MachineId">;
                kind: "machine";
            } | {
                id: string & z.BRAND<"UserId">;
                kind: "user";
            } | {
                job: string;
                kind: "system";
            };
            onBehalfOf: (string & z.BRAND<"UserId">) | null;
        };
        by?: (string & z.BRAND<"SessionId">) | undefined;
        options?: string[] | undefined;
        question: string;
    };
    assignee?: (string & z.BRAND<"UserId">) | undefined;
    audience: "agent" | "human";
    blockedByNotes: string[];
    branch?: string | undefined;
    brief?: string | undefined;
    closedAt?: string | undefined;
    closedReason?: string | undefined;
    color?: "blue" | "cyan" | "fuchsia" | "green" | "indigo" | "lime" | "pink" | "rose" | "teal" | "violet" | undefined;
    coordinatorSessionId?: (string & z.BRAND<"SessionId">) | undefined;
    createdAt: string;
    createdBy: {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    defaultAgent: string;
    defaultEffort: string;
    defaultModel: string;
    deferUntil?: string | undefined;
    deletedAt?: string | undefined;
    dependencyNote?: string | undefined;
    description: {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    design?: string | undefined;
    dueAt?: string | undefined;
    duplicateOf?: (string & z.BRAND<"IssueId">) | undefined;
    estimateMin?: number | undefined;
    id: string & z.BRAND<"IssueId">;
    intentOrigin: "agent" | "human";
    isDraftVessel: boolean;
    labels: string[];
    lastLifecycleActor?: undefined | {
        actor: {
            id: string & z.BRAND<"AgentIdentityId">;
            kind: "agent";
        } | {
            id: string & z.BRAND<"MachineId">;
            kind: "machine";
        } | {
            id: string & z.BRAND<"UserId">;
            kind: "user";
        } | {
            job: string;
            kind: "system";
        };
        onBehalfOf: (string & z.BRAND<"UserId">) | null;
    };
    linearId?: string | undefined;
    linearIdentifier?: string | undefined;
    linearUrl?: string | undefined;
    machineId?: (string & z.BRAND<"MachineId">) | undefined;
    needsHuman: boolean;
    notes?: undefined | {
        opsTail?: undefined | unknown[];
        revision?: number | undefined;
        value: string;
    };
    notesUpdatedAt?: string | undefined;
    owner: string & z.BRAND<"UserId">;
    panel?: undefined | {
        artifacts: {
            addedAt: string;
            artifactId?: (string & z.BRAND<"ArtifactId">) | undefined;
            entry?: string | undefined;
            files?: undefined | {
                path: string;
                size: number;
            }[];
            path: string;
            sourceKind?: "terminal-evidence" | undefined;
            sourcePaths?: string[] | undefined;
            title?: string | undefined;
            tracking?: "tracked" | "unknown" | "untracked" | undefined;
            untrackedPaths?: string[] | undefined;
        }[];
        deferred: {
            addedAt: string;
            text: string;
        }[];
        todos: {
            done: boolean;
            text: string;
        }[];
    };
    parentBranch: string;
    parentId?: (string & z.BRAND<"IssueId">) | undefined;
    prUrl?: string | undefined;
    priority: number;
    repoId?: (string & z.BRAND<"RepoId">) | undefined;
    revision?: number | undefined;
    seq: number;
    sortKey?: string | undefined;
    stage: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping";
    startedBySession?: (string & z.BRAND<"SessionId">) | undefined;
    suggestedReason?: string | undefined;
    suggestedStage?: "backlog" | "done" | "in_progress" | "planning" | "proposed" | "review" | "shipping" | undefined;
    supersededBy?: (string & z.BRAND<"IssueId">) | undefined;
    title: string;
    type: "automation" | "bug" | "chore" | "decision" | "epic" | "feature" | "milestone" | "spike" | "story" | "task";
    updatedAt: string;
    visibility: "deployment-substrate" | "owned-compute" | "per-user-state" | "personal" | "secret";
    worktreePath?: string | undefined;
}, "asked" | "branch" | "createdBy" | "description" | "intentOrigin" | "isDraftVessel" | "lastLifecycleActor" | "notes" | "owner" | "visibility" | "worktreePath"> & {
    blocked: boolean;
    branch: null | string;
    childCount: number;
    childDoneCount: number;
    commentCount: number;
    deferred: boolean;
    dependents: _podium_model.IssueDepWire[];
    deps: _podium_model.IssueDepWire[];
    description: string;
    displayRef: string;
    draft: boolean;
    gitState?: _podium_model.IssueGitState;
    humanQuestion?: string;
    humanQuestionAskedAt?: string;
    humanQuestionAskedBy?: _podium_model.SessionId;
    humanQuestionOptions?: string[];
    notes?: string;
    origin: _podium_model.IssueProjection["intentOrigin"];
    prefix?: string;
    ready: boolean;
    repoPath: string;
    worktreePath: null | string;
};
type Output_issues_subscriptionAdd = {
    createdAt: string;
    deliverNotify: boolean;
    deliverNudge: boolean;
    enabled: boolean;
    event: string;
    id: string;
    origin: "custom" | "default";
    sourceKind: "issue" | "relationship" | "session";
    sourceRef: string;
    subscriberId: string;
    subscriberKind: "issue" | "session";
};
type Output_machines_applyUpdate = {
    machines: {
        adoptable?: boolean | undefined;
        appVersion?: null | string | undefined;
        availability?: undefined | {
            daemon: boolean;
            epoch: string;
            server: boolean;
            supervisor: boolean;
        };
        buildReportedAt?: null | string | undefined;
        components?: ("daemon" | "server")[] | undefined;
        daemonReadiness?: undefined | {
            quarantinedBindings: number;
            reason: string;
            state: "attached" | "ready" | "recovering";
        };
        deliveryCaps?: string[] | undefined;
        harnessVersions?: undefined | {
            firstSeen: string;
            harness: string;
            lastSeen: string;
            unverified?: boolean | undefined;
            verifiedThrough?: string | undefined;
            version: string;
        }[];
        hostname: string;
        id: string & z.BRAND<"MachineId">;
        installKind?: null | string | undefined;
        inventory?: undefined | {
            agents: {
                installed: boolean | null;
                kind: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi";
                login: {
                    account?: string | undefined;
                    freshness?: number | undefined;
                    identity?: undefined | {
                        email?: string | undefined;
                        fingerprint: string;
                        providerAccountId?: string | undefined;
                    };
                    state: "in" | "out" | "unknown";
                };
                path?: string | undefined;
                probeError?: undefined | {
                    reason: "timed-out";
                    timeoutMs: number;
                };
                version?: string | undefined;
            }[];
            arch: "arm64" | "x64";
            os: "darwin" | "linux" | "win32";
            podiumVersion?: string | undefined;
            runtimeDrivers?: undefined | {
                family: "server" | "terminal";
                harness: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi";
                id: string;
            }[];
            tools: {
                installed: boolean | null;
                name: string;
                path?: string | undefined;
                probeError?: undefined | {
                    reason: "timed-out";
                    timeoutMs: number;
                };
                version?: string | undefined;
            }[];
        };
        lastSeenAt: string;
        name: string;
        online: boolean;
        owned?: boolean | undefined;
        podiumManaged?: boolean | undefined;
        presenceSource?: "legacy-daemon" | "supervisor" | undefined;
        revokedAt?: null | string | undefined;
        serverMoveEligibility?: undefined | {
            eligible: boolean;
            reason?: "current-server" | "offline" | "unsupported" | undefined;
        };
        serviceAssignment?: undefined | {
            agentExecution: boolean;
            server: boolean;
        };
        services?: undefined | {
            agentExecution: {
                observedAt: string;
                policy: "disabled" | "enabled";
                reason?: string | undefined;
                state: "available" | "refused" | "starting" | "stopped";
            };
            agentExecutionLockout?: boolean | undefined;
            crashOwner?: string | undefined;
            server: {
                observedAt: string;
                policy: "disabled" | "enabled";
                reason?: string | undefined;
                state: "available" | "refused" | "starting" | "stopped";
            };
            topology?: undefined | {
                legacyUnits: string[];
                parentUnit: "absent" | "active" | "inactive";
                persistence: "detached" | "systemd" | "unmanaged";
            };
        };
        supersedable?: boolean | undefined;
        supersededBy?: (string & z.BRAND<"MachineId">) | null | undefined;
        targetUnavailableReason?: null | string | undefined;
        targetVersion?: null | string | undefined;
        transferable?: boolean | undefined;
        unowned?: boolean | undefined;
        updateChannel?: "dev" | "edge" | "stable" | undefined;
        updateChannelOverride?: "dev" | "edge" | "stable" | null | undefined;
        use?: "denied" | "granted" | undefined;
        versionState?: "ahead" | "behind" | "current" | "unreported" | undefined;
        wireSchemaDigest?: null | string | undefined;
    }[];
    outcome: MachineApplyOutcome;
};
type Output_machines_moveServer = ({
    alreadyRunning: string;
    operationId?: undefined;
    started: false;
}) | ({
    alreadyRunning?: undefined;
    operationId: string;
    started: true;
});
type Output_operations_action = ({
    handled: false;
    refused: "already-finished" | "not-found" | "not-offered" | "unsupported";
}) | ({
    handled: true;
    result: OperationActionResult;
});
type Output_operations_cancel = ({
    canceled: false;
    refused: "already-finished" | "handed-off" | "irreversible" | "not-found";
    step?: string;
}) | ({
    canceled: true;
    operation: Protocol.Operation;
});
type Output_repos_browse = {
    entries: DirectoryBrowserEntry[];
    homePath: string;
    parentPath: null | string;
    path: string;
};
type Output_repos_githubList = {
    error?: string | undefined;
    path?: string | undefined;
    repositories?: undefined | {
        description: null | string;
        isPrivate: boolean;
        nameWithOwner: string;
        pushedAt: null | string;
        url: string;
    }[];
    status: {
        login?: string | undefined;
        state: "ready";
    } | {
        state: "logged-out";
    } | {
        state: "missing";
    };
};
type Output_repos_listDetailed = Array<{
    machineId: _podium_model.MachineId;
    originUrl: null | string;
    path: string;
    prefix: null | string;
    repoId: _podium_model.RepoId | null;
}>;
type Output_sessions_configure = ({
    cause?: "agent-exited" | "dropped-by-agent" | "not-accepting-input" | "not-recorded" | "rejected-by-agent" | "unconfirmed" | undefined;
    detail?: string | undefined;
    reason: "busy" | "invalid_value" | "lease_held" | "needs_user" | "no_archive_yet" | "no_resume_ref" | "not_running" | "session_ended" | "staging_failed" | "unsupported";
}) | ({
    detail: string;
    reason: "not_running";
}) | ({
    effective: "immediate" | "next-turn";
    ok: true;
});
type Output_sessions_interrupt = ({
    ok: boolean;
    reason: string;
}) | ({
    ok: false;
    reason: string;
    requested?: undefined;
}) | ({
    ok: true;
    reason?: undefined;
    requested: "keystroke" | "protocol" | "retraction";
}) | ({
    readonly ok: true;
    readonly requested: "retraction";
});
type Output_sessions_stop = ({
    deferredKill?: boolean;
    ok: boolean;
    reason?: string;
    worktreeFreed?: boolean;
}) | ({
    ok: boolean;
    reason: string;
});
type Output_sessions_uploadImage = ({
    attachment: {
        filename: string;
        id: string;
        kind: "file" | "image";
        mediaType: string;
        path: string;
    };
    path: string;
    refusal?: undefined;
}) | ({
    attachment?: undefined;
    path?: undefined;
    refusal: {
        cause?: "agent-exited" | "dropped-by-agent" | "not-accepting-input" | "not-recorded" | "rejected-by-agent" | "unconfirmed" | undefined;
        detail?: string | undefined;
        reason: "busy" | "invalid_value" | "lease_held" | "needs_user" | "no_archive_yet" | "no_resume_ref" | "not_running" | "session_ended" | "staging_failed" | "unsupported";
    };
}) | ({
    error?: string;
    path: string;
});
type Output_settings_get = {
    apiKeys: {
        anthropic: string;
        openai: string;
        openrouter: string;
    };
    autoContinue: {
        enabled: boolean;
        promptDismissed: boolean;
    };
    deployment: {
        authOpenMode?: boolean | undefined;
        connectEnabled?: boolean | undefined;
        telemetryCrash?: "off" | "on" | undefined;
        telemetryInstallId?: string | undefined;
        telemetrySince?: number | undefined;
        telemetryUsage?: "off" | "on" | undefined;
        updateChannel?: "dev" | "edge" | "stable" | undefined;
    };
    experimental: Record<string, boolean>;
    gitWorkflow: {
        autoRebaseBeforeMerge: boolean;
        defaultParentBranch: string;
        mergeStyle: "ask" | "ff-only" | "pr";
    };
    hibernation: {
        backstopMinutes: null | number;
        enabled: boolean;
        idleMinutes: number;
        idleShellMinutes: null | number;
        loadPerCore: null | number;
        maxIdleSessions: null | number;
        memoryPct: number;
    };
    integrations: {
        linearApiKey: string;
    };
    issues: {
        assistantEnabled: boolean;
    };
    notifications: {
        ntfyTopic: string;
        telegramBotToken: string;
        telegramChatId: string;
        web: boolean;
    };
    roles: {
        background: {
            accountId: string & z.BRAND<"AccountId">;
            effort: string;
            harness?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | undefined;
            model: string;
        };
        coding: {
            accountId: string & z.BRAND<"AccountId">;
            effort: string;
            harness?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | undefined;
            model: string;
            seedCliTheme: boolean;
            startScreen: "auto" | "chat" | "native";
            subagentModel: string;
        };
        shipwright: {
            accountId: string & z.BRAND<"AccountId">;
            effort: string;
            harness?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | undefined;
            model: string;
        };
        superagent: {
            accountId: string & z.BRAND<"AccountId">;
            effort: string;
            harness?: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | undefined;
            model: string;
        };
    };
    sidebar: {
        groupByRepo: boolean;
        repoOrder: string[];
        repoSort: "alphabetical" | "custom" | "lastUsed";
    };
    steward: {
        enabled: boolean;
    };
    transcripts: {
        mirror?: boolean | undefined;
    };
    worktreeGc: {
        afterDays: number;
        mode: "auto" | "off" | "propose";
    };
};
type Output_settings_telegramSetupPoll = ({
    chatId: string;
    chatLabel?: string;
    chatType: string;
    settings: PodiumSettings;
    status: "connected";
}) | ({
    expiresAt: string;
    status: "pending";
}) | ({
    status: "expired";
});
type Output_setup_channel = {
    channel: FleetUpdateChannel;
    channelSource: SettingSource;
    configured: FleetUpdateChannel;
    desktopUpdateEndpoint: string | undefined;
    envForced: boolean;
    updateScope: UpdateScope;
    updateScopeSource: SettingSource;
};
type Output_setup_complete = {
    agentExecutionLockout?: boolean | undefined;
    agentHome?: string | undefined;
    agentRelayPort?: number | undefined;
    allowedOrigins?: string[] | undefined;
    appUrl?: string | undefined;
    auth?: undefined | {
        mode?: "cloud" | "local" | undefined;
        openMode?: boolean | undefined;
        signInUrl?: string | undefined;
    };
    bindHost?: "0.0.0.0" | "127.0.0.1" | undefined;
    configVersion?: number | undefined;
    connect?: undefined | {
        baseUrl?: string | undefined;
        enabled?: boolean | undefined;
        locateProofVerified?: boolean | undefined;
        trustedProbeKeys?: string[] | undefined;
    };
    features?: Record<string, boolean> | undefined;
    hookPort?: number | undefined;
    installationId?: string | undefined;
    installationPublicKey?: string | undefined;
    loopProfile?: "accounting" | "attribution" | "full" | "off" | undefined;
    mode?: "all-in-one" | "client" | "daemon" | "server" | "supervisor" | undefined;
    networkOption?: "cloudflare-tunnel" | "manual" | "tailscale-funnel" | "tailscale-serve" | undefined;
    pairCode?: string | undefined;
    persistence?: "detached" | "systemd" | undefined;
    podiumManaged?: boolean | undefined;
    port?: number | undefined;
    profileOnStall?: boolean | undefined;
    publicUrl?: string | undefined;
    serverUrl?: string | undefined;
    telemetry?: undefined | {
        crash?: "off" | "on" | undefined;
        endpoint?: string | undefined;
        installId?: string | undefined;
        since?: number | undefined;
        usage?: "off" | "on" | undefined;
    };
    transcriptLake?: "off" | "on" | undefined;
    uiUrl?: string | undefined;
    updateChannel?: "dev" | "edge" | "stable" | undefined;
    updateFeed?: string | undefined;
    updateScope?: "all" | "fleet-only" | undefined;
    workspaceId?: string | undefined;
};
type Output_setup_info = {
    allowedOrigins: string[];
    allowedOriginsSource: SettingSource;
    appUrl: null | string;
    appUrlSource: SettingSource;
    appVersion: string;
    mode: "all-in-one" | "client" | "daemon" | "server" | "supervisor" | null;
    modeSource: SettingSource;
    networkOption: "cloudflare-tunnel" | "manual" | "tailscale-funnel" | "tailscale-serve" | null;
    publicUrl: null | string;
    publicUrlSource: SettingSource;
    serverUrl: null | string;
    transcriptLake: TranscriptLakeMode;
    transcriptLakeSource: SettingSource;
};
type Output_setup_provenance = {
    agentHome: {
        env?: string;
        source: SettingSource;
    };
    agentRelayPort: {
        env?: string;
        source: SettingSource;
    };
    allowedOrigins: {
        env?: string;
        source: SettingSource;
    };
    appUrl: {
        env?: string;
        source: SettingSource;
    };
    authMode: {
        env?: string;
        source: SettingSource;
    };
    authOpenMode: {
        env?: string;
        source: SettingSource;
    };
    authSignInUrl: {
        env?: string;
        source: SettingSource;
    };
    connectBaseUrl: {
        env?: string;
        source: SettingSource;
    };
    connectEnabled: {
        env?: string;
        source: SettingSource;
    };
    connectProbeKeys: {
        env?: string;
        source: SettingSource;
    };
    hookPort: {
        env?: string;
        source: SettingSource;
    };
    mode: {
        env?: string;
        source: SettingSource;
    };
    port: {
        env?: string;
        source: SettingSource;
    };
    publicUrl: {
        env?: string;
        source: SettingSource;
    };
    telemetryCrash: {
        env?: string;
        source: SettingSource;
    };
    telemetryInstallId: {
        env?: string;
        source: SettingSource;
    };
    telemetrySince: {
        env?: string;
        source: SettingSource;
    };
    telemetryUsage: {
        env?: string;
        source: SettingSource;
    };
    transcriptLake: {
        env?: string;
        source: SettingSource;
    };
    updateChannel: {
        env?: string;
        source: SettingSource;
    };
    updateFeed: {
        env?: string;
        source: SettingSource;
    };
    updateScope: {
        env?: string;
        source: SettingSource;
    };
};
type Output_telemetry_preview = (null) | ({
    arch: "arm64" | "other" | "x64";
    features: Partial<Record<"issues", boolean>>;
    installAge: "0d" | "1-7d" | "31-90d" | "8-30d" | "90d+";
    installId: string;
    machines: "1" | "2-5" | "20+" | "6-20";
    os: "darwin" | "linux" | "other" | "win32";
    schema: 1;
    sessions: Partial<Record<"claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "shell", number>>;
    version: string;
});
type Output_updates_converge = {
    done: number;
    fleet: UpdateFleetSnapshot;
    grantedMachineIds: string[];
    includesBundle: boolean;
    state: "in-progress";
    total: number;
    version: string;
};
type Output_updates_repairPayload = {
    fleet: UpdateFleetSnapshot;
    outcome: {
        result: "granted";
        version: string;
    } | {
        result: "in-flight";
        state: Protocol.ConvergenceState;
    };
};
type Output_updates_retry = {
    alreadyRunning: boolean;
    operation: null | z.objectOutputType<{
        awaiting: z.ZodOptional<z.ZodArray<z.ZodObject<{
            detail: z.ZodOptional<z.ZodString>;
            id: z.ZodString;
            place: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            surface: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            detail: z.ZodOptional<z.ZodString>;
            id: z.ZodString;
            place: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            surface: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            detail: z.ZodOptional<z.ZodString>;
            id: z.ZodString;
            place: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            surface: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        createdAt: z.ZodOptional<z.ZodNumber>;
        createdBy: z.ZodOptional<z.ZodString>;
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
        details: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
        error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            code: z.ZodString;
            detail: z.ZodOptional<z.ZodString>;
            message: z.ZodOptional<z.ZodString>;
            places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            code: z.ZodString;
            detail: z.ZodOptional<z.ZodString>;
            message: z.ZodOptional<z.ZodString>;
            places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            code: z.ZodString;
            detail: z.ZodOptional<z.ZodString>;
            message: z.ZodOptional<z.ZodString>;
            places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, z.ZodTypeAny, "passthrough">>>>;
        exclusionGroup: z.ZodOptional<z.ZodString>;
        finishedAt: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        id: z.ZodString;
        kind: z.ZodString;
        retryOf: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodOptional<z.ZodNumber>;
        state: z.ZodEnum<["pending", "running", "waiting", "done", "failed", "canceled"]>;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            attempts: z.ZodOptional<z.ZodNumber>;
            detail: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">>>>;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            id: z.ZodString;
            lastProgressAt: z.ZodOptional<z.ZodNumber>;
            places: z.ZodOptional<z.ZodArray<z.ZodObject<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, z.ZodTypeAny, "passthrough">>, "many">>;
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
            stalledMs: z.ZodOptional<z.ZodNumber>;
            stalls: z.ZodOptional<z.ZodNumber>;
            startedAt: z.ZodOptional<z.ZodNumber>;
            state: z.ZodEnum<["pending", "running", "stalled", "done", "failed", "skipped"]>;
            title: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            attempts: z.ZodOptional<z.ZodNumber>;
            detail: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">>>>;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            id: z.ZodString;
            lastProgressAt: z.ZodOptional<z.ZodNumber>;
            places: z.ZodOptional<z.ZodArray<z.ZodObject<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, z.ZodTypeAny, "passthrough">>, "many">>;
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
            stalledMs: z.ZodOptional<z.ZodNumber>;
            stalls: z.ZodOptional<z.ZodNumber>;
            startedAt: z.ZodOptional<z.ZodNumber>;
            state: z.ZodEnum<["pending", "running", "stalled", "done", "failed", "skipped"]>;
            title: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            attempts: z.ZodOptional<z.ZodNumber>;
            detail: z.ZodOptional<z.ZodString>;
            error: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                code: z.ZodString;
                detail: z.ZodOptional<z.ZodString>;
                message: z.ZodOptional<z.ZodString>;
                places: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, z.ZodTypeAny, "passthrough">>>>;
            finishedAt: z.ZodOptional<z.ZodNumber>;
            id: z.ZodString;
            lastProgressAt: z.ZodOptional<z.ZodNumber>;
            places: z.ZodOptional<z.ZodArray<z.ZodObject<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
                detail: z.ZodOptional<z.ZodString>;
                id: z.ZodString;
                lastProgressAt: z.ZodOptional<z.ZodNumber>;
                name: z.ZodOptional<z.ZodString>;
                percent: z.ZodOptional<z.ZodNumber>;
                state: z.ZodOptional<z.ZodString>;
            }, z.ZodTypeAny, "passthrough">>, "many">>;
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
            stalledMs: z.ZodOptional<z.ZodNumber>;
            stalls: z.ZodOptional<z.ZodNumber>;
            startedAt: z.ZodOptional<z.ZodNumber>;
            state: z.ZodEnum<["pending", "running", "stalled", "done", "failed", "skipped"]>;
            title: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        updatedAt: z.ZodOptional<z.ZodNumber>;
    }, z.ZodTypeAny, "passthrough">;
    operationId: string;
};
type Output_workflows_create = {
    revision: {
        createdAt: string;
        id: string;
        instructions: string;
        publishedAt: null | string;
        steps: {
            completionGuidance: string;
            executionProfileId?: string | undefined;
            id: string;
            instructions: string;
            title: string;
        }[];
        version: number;
        workflowId: string;
    };
    workflow: {
        archivedAt: null | string;
        createdAt: string;
        description: string;
        id: string;
        latestRevisionId: null | string;
        latestVersion: number;
        name: string;
        scope: "global" | "repository" | "task";
        scopeRef: null | string;
        updatedAt: string;
    };
};
type Output_workflows_get = {
    revisions: {
        createdAt: string;
        id: string;
        instructions: string;
        publishedAt: null | string;
        steps: {
            completionGuidance: string;
            executionProfileId?: string | undefined;
            id: string;
            instructions: string;
            title: string;
        }[];
        version: number;
        workflowId: string;
    }[];
    workflow: {
        archivedAt: null | string;
        createdAt: string;
        description: string;
        id: string;
        latestRevisionId: null | string;
        latestVersion: number;
        name: string;
        scope: "global" | "repository" | "task";
        scopeRef: null | string;
        updatedAt: string;
    };
};
type AppRouter = TRPC.TRPCBuiltRouter<{
    ctx: object;
    meta: object;
    errorShape: TRPC.TRPCDefaultErrorShape;
    transformer: false;
}, {
    "accounts": {
        "connect": TRPC.TRPCMutationProcedure<{
            input: {
                credential: string;
                kind: "api-key" | "oauth";
                provider: "anthropic" | "openai" | "openrouter";
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
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<AccountView>;
            meta: unknown;
        }>;
        "login": TRPC.TRPCMutationProcedure<{
            input: {
                harness: "claude-code" | "codex" | "cursor" | "grok" | "opencode" | "pi";
                machineId?: string | undefined;
            };
            output: Output_accounts_login;
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
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<Protocol.ApprovalWire>;
            meta: unknown;
        }>;
    };
    "auth": {
        "profile": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: {
                email: null | string;
            };
            meta: unknown;
        }>;
        "setEmail": TRPC.TRPCMutationProcedure<{
            input: {
                current?: string | undefined;
                email: string;
            };
            output: {
                email: string;
            };
            meta: unknown;
        }>;
        "setLoginRequired": TRPC.TRPCMutationProcedure<{
            input: {
                acknowledgeNoPassword?: true | undefined;
                current: string;
                required: boolean;
            };
            output: {
                loginRequired: boolean;
            };
            meta: unknown;
        }>;
        "setPassword": TRPC.TRPCMutationProcedure<{
            input: {
                current?: string | undefined;
                next: string;
            };
            output: {
                loginRequired: boolean;
            };
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_auth_status;
            meta: unknown;
        }>;
    };
    "automations": {
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_automations_create;
            output: Output_automations_create;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_automations_list;
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
        "runs": TRPC.TRPCQueryProcedure<{
            input: {
                automationId: string;
                limit?: number | undefined;
            };
            output: Output_automations_runs;
            meta: unknown;
        }>;
        "setEnabled": TRPC.TRPCMutationProcedure<{
            input: {
                enabled: boolean;
                id: string;
            };
            output: Output_automations_create;
            meta: unknown;
        }>;
        "update": TRPC.TRPCMutationProcedure<{
            input: Input_automations_update;
            output: Output_automations_create;
            meta: unknown;
        }>;
    };
    "cloud": {
        "capabilities": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: CloudProviderCapabilities;
            meta: unknown;
        }>;
        "createAgent": TRPC.TRPCMutationProcedure<{
            input: Input_cloud_createAgent;
            output: CloudRuntime;
            meta: unknown;
        }>;
        "createMachine": TRPC.TRPCMutationProcedure<{
            input: Input_cloud_createMachine;
            output: CloudRuntime;
            meta: unknown;
        }>;
        "moveSession": TRPC.TRPCMutationProcedure<{
            input: Input_cloud_moveSession;
            output: CloudRuntime;
            meta: unknown;
        }>;
        "runtime": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: (CloudRuntime) | (null);
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
    "conversations": {
        "search": TRPC.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                projectPath?: string | undefined;
                query?: string | undefined;
            };
            output: Array<ConversationIndexRow>;
            meta: unknown;
        }>;
        "setMeta": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                name?: string | undefined;
                summary?: string | undefined;
            };
            output: void;
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
        "taskComparison": TRPC.TRPCQueryProcedure<{
            input: {
                includeSessions?: boolean | undefined;
                issueId: string;
            };
            output: _podium_model.TaskCostComparisonWire;
            meta: unknown;
        }>;
        "tasks": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<_podium_model.TaskCostRowWire>;
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
                machineId?: string | undefined;
                maxDepth?: number | undefined;
                path: string;
            };
            output: ScanReposResult;
            meta: unknown;
        }>;
        "scanMachine": TRPC.TRPCMutationProcedure<{
            input: {
                atPath?: string | undefined;
                deep?: boolean | undefined;
                machineId: string;
            };
            output: Output_discovery_scanMachine;
            meta: unknown;
        }>;
    };
    "features": {
        "state": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_features_state;
            meta: unknown;
        }>;
    };
    "files": {
        "list": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: string | undefined;
                path?: string | undefined;
                root: string;
            };
            output: {
                entries: {
                    isDir: boolean;
                    name: string;
                }[];
                error?: string | undefined;
                ok: boolean;
                path: string;
            };
            meta: unknown;
        }>;
        "read": TRPC.TRPCQueryProcedure<{
            input: Input_files_read;
            output: Output_files_read;
            meta: unknown;
        }>;
        "search": TRPC.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                machineId?: string | undefined;
                query?: string | undefined;
                root: string;
            };
            output: {
                paths: string[];
            };
            meta: unknown;
        }>;
        "write": TRPC.TRPCMutationProcedure<{
            input: Input_files_write;
            output: {
                baseHash?: string | undefined;
                conflict?: boolean | undefined;
                error?: string | undefined;
                ok: boolean;
            };
            meta: unknown;
        }>;
    };
    "git": {
        "commitDiffFile": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                path?: string;
                root: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "commitFiles": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                path?: string;
                root: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "diffFile": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                path?: string;
                root: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "log": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                path?: string;
                root: string;
                sha?: string;
            };
            output: OpResult;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: {
                machineId?: _podium_model.MachineId | undefined;
                path?: string;
                root: string;
                sha?: string;
            };
            output: OpResult;
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
    "interactions": {
        "answer": TRPC.TRPCMutationProcedure<{
            input: Input_interactions_answer;
            output: Output_interactions_answer;
            meta: unknown;
        }>;
        "forSession": TRPC.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                sessionId: string;
            };
            output: Array<Protocol.PendingInteractionWire>;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                sessionId?: string | undefined;
            });
            output: Array<Protocol.PendingInteractionWire>;
            meta: unknown;
        }>;
    };
    "issues": {
        "action": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                kind: "merge" | "pr" | "rebase";
            };
            output: Output_issues_action;
            meta: unknown;
        }>;
        "addComment": TRPC.TRPCMutationProcedure<{
            input: {
                body: string;
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "addSession": TRPC.TRPCMutationProcedure<{
            input: {
                agentKind?: string | undefined;
                forceUnknownModel?: boolean | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "addShell": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "answerQuestion": TRPC.TRPCMutationProcedure<{
            input: {
                answer: string;
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_answerQuestion;
            meta: unknown;
        }>;
        "applySuggestion": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "archive": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "artifactRead": TRPC.TRPCQueryProcedure<{
            input: {
                file?: string | undefined;
                id: string;
                index?: number | undefined;
                path?: string | undefined;
            };
            output: IssueArtifactContent;
            meta: unknown;
        }>;
        "attachSession": TRPC.TRPCMutationProcedure<{
            input: Input_issues_attachSession;
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "blocked": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "cancelShip": TRPC.TRPCMutationProcedure<{
            input: {
                orderId: string;
            };
            output: Output_issues_cancelShip;
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
        "claim": TRPC.TRPCMutationProcedure<{
            input: {
                assignee: string;
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "cleanup": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_action;
            meta: unknown;
        }>;
        "clearNeedsHuman": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "close": TRPC.TRPCMutationProcedure<{
            input: Input_issues_close;
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "closeEligibleEpics": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "comments": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: Array<_podium_model.IssueComment>;
            meta: unknown;
        }>;
        "count": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.IssueCount;
            meta: unknown;
        }>;
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_issues_create;
            output: Output_issues_create;
            meta: unknown;
        }>;
        "defer": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                mutationId?: string | undefined;
                until: null | string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "delete": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                mutationId?: string | undefined;
            };
            output: unknown;
            meta: unknown;
        }>;
        "deliveryReceipt": TRPC.TRPCQueryProcedure<{
            input: {
                orderId: string;
            };
            output: (_podium_model.DeliveryReceipt) | (null);
            meta: unknown;
        }>;
        "depAdd": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                fromId: string;
                toId: string;
                type?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "depRemove": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                fromId: string;
                toId: string;
                type?: string | undefined;
            };
            output: Output_issues_addComment;
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
        "dismissSuggestion": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "doctor": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.DoctorReport;
            meta: unknown;
        }>;
        "duplicate": TRPC.TRPCMutationProcedure<{
            input: {
                canonicalId: string;
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "epicStatus": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: _podium_model.EpicStatus;
            meta: unknown;
        }>;
        "events": TRPC.TRPCQueryProcedure<{
            input: Input_issues_events;
            output: Array<PodiumEventRecord>;
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
        "get": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_get;
            meta: unknown;
        }>;
        "graph": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.IssueGraph;
            meta: unknown;
        }>;
        "integrate": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_action;
            meta: unknown;
        }>;
        "linearSearch": TRPC.TRPCQueryProcedure<{
            input: {
                query: string;
            };
            output: Array<LinearIssue>;
            meta: unknown;
        }>;
        "lint": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.LintFinding>;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "mailClaim": TRPC.TRPCMutationProcedure<{
            input: {
                messageId: string;
            };
            output: Output_issues_mailClaim;
            meta: unknown;
        }>;
        "mailInbox": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                id?: string | undefined;
            });
            output: Output_issues_mailInbox;
            meta: unknown;
        }>;
        "mailPending": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                id?: string | undefined;
            });
            output: {
                senders: string[];
                unread: number;
            };
            meta: unknown;
        }>;
        "mailSend": TRPC.TRPCMutationProcedure<{
            input: {
                body: string;
                id: string;
                messageId?: string | undefined;
            };
            output: Output_issues_mailSend;
            meta: unknown;
        }>;
        "markRead": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "markUnread": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "orphans": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath: string;
            };
            output: Array<_podium_model.OrphanIssue>;
            meta: unknown;
        }>;
        "panelApply": TRPC.TRPCMutationProcedure<{
            input: Input_issues_panelApply;
            output: Output_issues_addComment;
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
        "prime": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                repoPath?: string | undefined;
            });
            output: string;
            meta: unknown;
        }>;
        "promote": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "ready": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "refreshAssistant": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "reparent": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                parentId: null | string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "resolveRefs": TRPC.TRPCQueryProcedure<{
            input: {
                refs: string[];
            };
            output: Array<{
                id: (string & z.BRAND<"IssueId">) | null;
                ref: string;
            }>;
            meta: unknown;
        }>;
        "resolveShipHold": TRPC.TRPCMutationProcedure<{
            input: {
                action: string;
                expectedGeneration: number;
                orderId: string;
            };
            output: Output_issues_resolveShipHold;
            meta: unknown;
        }>;
        "restore": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                mutationId?: string | undefined;
            };
            output: unknown;
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
        "setCoordinator": TRPC.TRPCMutationProcedure<{
            input: Input_issues_setCoordinator;
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "setLabels": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                labels: string[];
                mutationId?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "setNeedsHuman": TRPC.TRPCMutationProcedure<{
            input: Input_issues_setNeedsHuman;
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "setPlacement": TRPC.TRPCMutationProcedure<{
            input: Input_issues_setPlacement;
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "setState": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                text: string;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "setTucked": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                mutationId?: string | undefined;
                tucked: boolean;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "share": TRPC.TRPCMutationProcedure<{
            input: {
                grantee: string;
                id: string;
                verb: "manage" | "read" | "write";
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "ship": TRPC.TRPCMutationProcedure<{
            input: {
                id?: string | undefined;
            };
            output: Output_issues_ship;
            meta: unknown;
        }>;
        "stale": TRPC.TRPCQueryProcedure<{
            input: {
                days?: number | undefined;
                repoPath?: string | undefined;
            };
            output: Array<_podium_model.IssueReport>;
            meta: unknown;
        }>;
        "start": TRPC.TRPCMutationProcedure<{
            input: Input_issues_start;
            output: Output_issues_start;
            meta: unknown;
        }>;
        "stats": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath?: string | undefined;
            };
            output: _podium_model.IssueStats;
            meta: unknown;
        }>;
        "stop": TRPC.TRPCMutationProcedure<{
            input: {
                force?: boolean | undefined;
                id: string;
            };
            output: {
                ok: boolean;
                reason?: string | undefined;
                stopped: string[];
                worktreeFreed: boolean;
            };
            meta: unknown;
        }>;
        "subscriptionAdd": TRPC.TRPCMutationProcedure<{
            input: Input_issues_subscriptionAdd;
            output: Output_issues_subscriptionAdd;
            meta: unknown;
        }>;
        "subscriptionList": TRPC.TRPCQueryProcedure<{
            input: void;
            output: Array<Subscription>;
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
                enabled: boolean;
                id: string;
            };
            output: {
                updated: boolean;
            };
            meta: unknown;
        }>;
        "supersede": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                newId: string;
                oldId: string;
            };
            output: Output_issues_addComment;
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
        "undefer": TRPC.TRPCMutationProcedure<{
            input: {
                expectedRevision?: number | undefined;
                id: string;
                mutationId?: string | undefined;
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "unshare": TRPC.TRPCMutationProcedure<{
            input: {
                grantee: string;
                id: string;
                verb: "manage" | "read" | "write";
            };
            output: Output_issues_addComment;
            meta: unknown;
        }>;
        "update": TRPC.TRPCMutationProcedure<{
            input: Input_issues_update;
            output: Output_issues_addComment;
            meta: unknown;
        }>;
    };
    "layout": {
        "clear": TRPC.TRPCMutationProcedure<{
            input: {
                keys: string[];
                mutationId?: string | undefined;
            };
            output: _podium_model.LayoutSnapshot;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: void;
            output: _podium_model.LayoutSnapshot;
            meta: unknown;
        }>;
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                values: Record<string, unknown>;
            };
            output: _podium_model.LayoutSnapshot;
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
                next: Protocol.LockHolderWire | null;
                released: true;
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
                name?: string | undefined;
                repoPath: string;
            };
            output: Array<Protocol.LockWire>;
            meta: unknown;
        }>;
        "steal": TRPC.TRPCMutationProcedure<{
            input: {
                name: string;
                note?: string | undefined;
                repoPath: string;
                ttlSeconds?: number | undefined;
            };
            output: {
                lock: Protocol.LockWire;
                previousHolder: Protocol.LockHolderWire | null;
            };
            meta: unknown;
        }>;
    };
    "logs": {
        "crash": TRPC.TRPCMutationProcedure<{
            input: Input_logs_crash;
            output: CrashResult;
            meta: unknown;
        }>;
        "forward": TRPC.TRPCMutationProcedure<{
            input: Input_logs_forward;
            output: ForwardResult;
            meta: unknown;
        }>;
        "setDaemonLevel": TRPC.TRPCMutationProcedure<{
            input: Input_logs_setDaemonLevel;
            output: SetDaemonLevelResult;
            meta: unknown;
        }>;
        "setLevel": TRPC.TRPCMutationProcedure<{
            input: Input_logs_setLevel;
            output: SetLevelResult;
            meta: unknown;
        }>;
    };
    "machines": {
        "adopt": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                newOwnerUserId?: string | undefined;
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
        "descriptors": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Array<Protocol.HarnessDescriptorWire>;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: void;
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
                joinCommand: null | string;
            };
            meta: unknown;
        }>;
        "rename": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                name: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "revoke": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "setAssignment": TRPC.TRPCMutationProcedure<{
            input: {
                assignment: {
                    agentExecution: boolean;
                    server: boolean;
                };
                id: string;
                requestId: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "setUpdateChannel": TRPC.TRPCMutationProcedure<{
            input: {
                channel: "dev" | "edge" | "stable" | null;
                id: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "share": TRPC.TRPCMutationProcedure<{
            input: {
                grantee: string;
                id: string;
                verb: "manage" | "see" | "use";
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
        "transferOwnership": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                newOwnerUserId: string;
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
        "unshare": TRPC.TRPCMutationProcedure<{
            input: {
                grantee: string;
                id: string;
                verb: "manage" | "see" | "use";
            };
            output: Array<_podium_model.MachineWire>;
            meta: unknown;
        }>;
    };
    "messages": {
        "awaitAgent": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "cancel": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "dismiss": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "dismissNotice": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "inbox": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "ledger": TRPC.TRPCQueryProcedure<{
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
        "reply": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "send": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "show": TRPC.TRPCQueryProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "spawnAgent": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
    };
    "models": {
        "catalog": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {
                machineId?: string | undefined;
            });
            output: ModelCatalogSnapshot;
            meta: unknown;
        }>;
        "refresh": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {
                machineId?: string | undefined;
            });
            output: ModelCatalogSnapshot;
            meta: unknown;
        }>;
    };
    "operations": {
        "action": TRPC.TRPCMutationProcedure<{
            input: {
                actionId: string;
                id: string;
            };
            output: Output_operations_action;
            meta: unknown;
        }>;
        "active": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                group?: string | undefined;
            });
            output: (Protocol.Operation) | (null);
            meta: unknown;
        }>;
        "cancel": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_operations_cancel;
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
        "settleAsk": TRPC.TRPCMutationProcedure<{
            input: {
                actionId: string;
                id: string;
            };
            output: Output_operations_action;
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
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: {
                ok: true;
            };
            meta: unknown;
        }>;
        "snapshot": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Protocol.PerfSnapshot;
            meta: unknown;
        }>;
    };
    "pins": {
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: PinState;
            meta: unknown;
        }>;
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
                kind: "panel" | "repo" | "worktree";
                mutationId?: string | undefined;
                pinned: boolean;
            };
            output: PinState;
            meta: unknown;
        }>;
    };
    "quota": {
        "history": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                days?: number | undefined;
            });
            output: Array<_podium_model.QuotaWindowHistoryWire>;
            meta: unknown;
        }>;
        "summary": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<_podium_model.MachineQuotaWire>;
            meta: unknown;
        }>;
    };
    "readPosition": {
        "advance": TRPC.TRPCMutationProcedure<{
            input: {
                lastEventId: number;
                mutationId?: string | undefined;
                seenAt?: null | string | undefined;
                streamId: string;
            };
            output: _podium_model.ReadPositionSnapshot;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: void;
            output: _podium_model.ReadPositionSnapshot;
            meta: unknown;
        }>;
    };
    "repos": {
        "add": TRPC.TRPCMutationProcedure<{
            input: {
                machineId?: string | undefined;
                path: string;
                prefix?: string | undefined;
            };
            output: Array<string>;
            meta: unknown;
        }>;
        "addMany": TRPC.TRPCMutationProcedure<{
            input: {
                machineId?: string | undefined;
                paths: string[];
            };
            output: {
                failed: {
                    message: string;
                    path: string;
                }[];
                repos: string[];
            };
            meta: unknown;
        }>;
        "browse": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                includeHidden?: boolean | undefined;
                machineId?: string | undefined;
                path?: string | undefined;
            });
            output: Output_repos_browse;
            meta: unknown;
        }>;
        "cloneGithub": TRPC.TRPCMutationProcedure<{
            input: {
                destination: string;
                machineId: string;
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
                machineId: string;
                name: string;
                parentPath: string;
            };
            output: {
                path: string;
            };
            meta: unknown;
        }>;
        "createRepo": TRPC.TRPCMutationProcedure<{
            input: {
                machineId: string;
                name: string;
                parentPath: string;
            };
            output: {
                path: string;
                repos: string[];
            };
            meta: unknown;
        }>;
        "githubList": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Output_repos_githubList;
            meta: unknown;
        }>;
        "githubStatus": TRPC.TRPCQueryProcedure<{
            input: {
                machineId: string;
            };
            output: Output_repos_githubList;
            meta: unknown;
        }>;
        "inferFromPath": TRPC.TRPCQueryProcedure<{
            input: {
                path: string;
            };
            output: {
                repoPath: null | string;
            };
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<string>;
            meta: unknown;
        }>;
        "listDetailed": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_repos_listDetailed;
            meta: unknown;
        }>;
        "remove": TRPC.TRPCMutationProcedure<{
            input: {
                machineId?: string | undefined;
                path: string;
            };
            output: Array<string>;
            meta: unknown;
        }>;
        "renameFolder": TRPC.TRPCMutationProcedure<{
            input: {
                currentName: string;
                machineId: string;
                name: string;
                parentPath: string;
            };
            output: {
                path: string;
            };
            meta: unknown;
        }>;
        "setPrefix": TRPC.TRPCMutationProcedure<{
            input: {
                machineId?: string | undefined;
                path: string;
                prefix: string;
            };
            output: Output_repos_listDetailed;
            meta: unknown;
        }>;
    };
    "search": {
        "query": TRPC.TRPCQueryProcedure<{
            input: {
                limit?: number | undefined;
                text: string;
            };
            output: Array<Protocol.SearchResultWire>;
            meta: unknown;
        }>;
    };
    "sessions": {
        "activityHistory": TRPC.TRPCQueryProcedure<{
            input: {
                sessionIds: string[];
            };
            output: SessionActivityHistoryResult;
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
        "ask": TRPC.TRPCMutationProcedure<{
            input: any;
            output: any;
            meta: unknown;
        }>;
        "concurrencyHistory": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: AgentConcurrencyHistoryResult;
            meta: unknown;
        }>;
        "configure": TRPC.TRPCMutationProcedure<{
            input: {
                effort?: string | undefined;
                model?: string | undefined;
                sessionId: string;
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
        "dismissOffer": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                offerCreatedAt: string;
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "handoff": TRPC.TRPCMutationProcedure<{
            input: {
                machineId: string;
                sessionId: string;
            };
            output: {
                newCwd: string;
                ok: true;
            };
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
                messageId?: string | undefined;
                sessionId: string;
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
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<_podium_model.SessionMeta>;
            meta: unknown;
        }>;
        "markRead": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "markUnread": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "read": TRPC.TRPCQueryProcedure<{
            input: {
                cursor?: string | undefined;
                sessionId: string;
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
        "rename": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                name: string;
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "resolve": TRPC.TRPCQueryProcedure<{
            input: {
                identifier: string;
            };
            output: Protocol.SessionIdentifierResolution;
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
        "setArchived": TRPC.TRPCMutationProcedure<{
            input: {
                archived: boolean;
                mutationId?: string | undefined;
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "setIssueId": TRPC.TRPCMutationProcedure<{
            input: {
                issueId: null | string;
                mutationId?: string | undefined;
                sessionId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "setWorkState": TRPC.TRPCMutationProcedure<{
            input: Input_sessions_setWorkState;
            output: void;
            meta: unknown;
        }>;
        "status": TRPC.TRPCQueryProcedure<{
            input: {
                ref: string;
            };
            output: _podium_model.SessionStatusResult;
            meta: unknown;
        }>;
        "stop": TRPC.TRPCMutationProcedure<{
            input: {
                force?: boolean | undefined;
                sessionId: string;
            };
            output: Output_sessions_stop;
            meta: unknown;
        }>;
        "transcriptRead": TRPC.TRPCQueryProcedure<{
            input: {
                anchor?: string | undefined;
                direction: "after" | "before";
                limit: number;
                sessionId: string;
            };
            output: TranscriptSlice;
            meta: unknown;
        }>;
        "uploadImage": TRPC.TRPCMutationProcedure<{
            input: {
                dataBase64: string;
                filename: string;
                machineId?: string | undefined;
                mimeType: string;
                sessionId: string;
            };
            output: Output_sessions_uploadImage;
            meta: unknown;
        }>;
    };
    "settings": {
        "clearSecret": TRPC.TRPCMutationProcedure<{
            input: Input_settings_clearSecret;
            output: _podium_model.SecretPresenceWire;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_settings_get;
            meta: unknown;
        }>;
        "secretPresence": TRPC.TRPCQueryProcedure<{
            input: {};
            output: Array<_podium_model.SecretPresenceWire>;
            meta: unknown;
        }>;
        "setSecret": TRPC.TRPCMutationProcedure<{
            input: Input_settings_setSecret;
            output: _podium_model.SecretPresenceWire;
            meta: unknown;
        }>;
        "telegramSetupPoll": TRPC.TRPCMutationProcedure<{
            input: {
                setupId: string;
            };
            output: Output_settings_telegramSetupPoll;
            meta: unknown;
        }>;
        "telegramSetupStart": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({});
            output: TelegramSetupStartResult;
            meta: unknown;
        }>;
        "updateInstance": TRPC.TRPCMutationProcedure<{
            input: {
                values: Record<string, unknown>;
            };
            output: Output_settings_get;
            meta: unknown;
        }>;
        "updatePersonal": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                values: Record<string, unknown>;
            };
            output: Output_settings_get;
            meta: unknown;
        }>;
        "viewer": TRPC.TRPCQueryProcedure<{
            input: void;
            output: {
                permitted: Record<string, boolean>;
            };
            meta: unknown;
        }>;
    };
    "setup": {
        "activate": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: {
                from: string;
                stale: readonly ("mode" | "persistence")[];
                state: "restarting";
            };
            meta: unknown;
        }>;
        "channel": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_setup_channel;
            meta: unknown;
        }>;
        "commandFor": TRPC.TRPCQueryProcedure<{
            input: {
                option: "cloudflare-tunnel" | "manual" | "tailscale-funnel" | "tailscale-serve";
                port: number;
            };
            output: {
                command: string;
                hint: string;
            };
            meta: unknown;
        }>;
        "complete": TRPC.TRPCMutationProcedure<{
            input: Input_setup_complete;
            output: Output_setup_complete;
            meta: unknown;
        }>;
        "connect": TRPC.TRPCMutationProcedure<{
            input: {
                mode: "all-in-one" | "client" | "server";
                serverUrl?: string | undefined;
            };
            output: Output_setup_complete;
            meta: unknown;
        }>;
        "info": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_setup_info;
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
        "options": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<{
                id: NetworkOption;
                label: string;
                note: string;
            }>;
            meta: unknown;
        }>;
        "provenance": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_setup_provenance;
            meta: unknown;
        }>;
        "setChannel": TRPC.TRPCMutationProcedure<{
            input: {
                channel: "dev" | "edge" | "stable";
            };
            output: Output_setup_channel;
            meta: unknown;
        }>;
    };
    "shells": {
        "forWorktree": TRPC.TRPCMutationProcedure<{
            input: {
                machineId?: string | undefined;
                worktreePath: string;
            };
            output: {
                created: boolean;
                sessionId: string & z.BRAND<"SessionId">;
            };
            meta: unknown;
        }>;
    };
    "snoozes": {
        "clear": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                sessionId: string;
            };
            output: {
                [x: string]: null | string;
            };
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: {
                [x: string]: null | string;
            };
            meta: unknown;
        }>;
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                sessionId: string;
                until: null | string;
            };
            output: {
                [x: string]: null | string;
            };
            meta: unknown;
        }>;
    };
    "specs": {
        "create": TRPC.TRPCMutationProcedure<{
            input: {
                parent: string;
                repoPath: string;
                title: string;
            };
            output: SpecComponent;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
                repoPath: string;
            };
            output: (SpecComponent) | (null);
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: {
                repoPath: string;
            };
            output: Array<SpecComponentMeta>;
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
        "search": TRPC.TRPCQueryProcedure<{
            input: {
                query: string;
                repoPath: string;
            };
            output: Array<SpecSearchHit>;
            meta: unknown;
        }>;
    };
    "superagent": {
        "clear": TRPC.TRPCMutationProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: void;
            meta: unknown;
        }>;
        "concierge": TRPC.TRPCMutationProcedure<{
            input: Input_superagent_concierge;
            output: {
                isNew: boolean;
                podiumSessionId: _podium_model.SessionId;
                threadId: _podium_model.ThreadId;
            };
            meta: unknown;
        }>;
        "ensureSession": TRPC.TRPCMutationProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: {
                podiumSessionId: _podium_model.SessionId;
                threadId: _podium_model.ThreadId;
            };
            meta: unknown;
        }>;
        "history": TRPC.TRPCQueryProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: Array<SuperagentMessageRow>;
            meta: unknown;
        }>;
        "interruptTurn": TRPC.TRPCMutationProcedure<{
            input: {
                threadId: string;
            };
            output: void;
            meta: unknown;
        }>;
        "latestTurnFailure": TRPC.TRPCQueryProcedure<{
            input: {
                threadId?: string | undefined;
            };
            output: (SuperagentTurnFailure) | (null);
            meta: unknown;
        }>;
        "listThreads": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Array<SuperagentThreadRow & {
                turnRunning: boolean;
            }>;
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
        "sendTurn": TRPC.TRPCMutationProcedure<{
            input: Input_superagent_sendTurn;
            output: {
                podiumSessionId: _podium_model.SessionId;
                queued: boolean;
                threadId: _podium_model.ThreadId;
            };
            meta: unknown;
        }>;
        "startBtw": TRPC.TRPCMutationProcedure<{
            input: {
                sessionId: string;
            };
            output: {
                isNew: boolean;
                threadId: _podium_model.ThreadId;
            };
            meta: unknown;
        }>;
    };
    "sync": {
        "changesSince": TRPC.TRPCQueryProcedure<{
            input: {
                cursor: null | number;
            };
            output: Protocol.SyncChangesSinceResult;
            meta: unknown;
        }>;
        "feedSlice": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({});
            output: {
                epoch: string;
                feedId: string;
                rows: {
                    entity: string;
                    entityId: string;
                }[];
                throughSeq: number;
            };
            meta: unknown;
        }>;
    };
    "tabs": {
        "listOrders": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: {
                [x: string]: string[];
            };
            meta: unknown;
        }>;
        "setOrder": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                sessionIds: string[];
                worktree: string;
            };
            output: {
                [x: string]: string[];
            };
            meta: unknown;
        }>;
    };
    "telemetry": {
        "preview": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: Output_telemetry_preview;
            meta: unknown;
        }>;
        "resetId": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: TelemetryState;
            meta: unknown;
        }>;
        "set": TRPC.TRPCMutationProcedure<{
            input: {
                crash?: "off" | "on" | undefined;
                usage?: "off" | "on" | undefined;
            };
            output: TelemetryState;
            meta: unknown;
        }>;
        "state": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: TelemetryState;
            meta: unknown;
        }>;
    };
    "updates": {
        "approveProposal": TRPC.TRPCMutationProcedure<{
            input: {
                headSha: string;
                version: string;
            };
            output: (Protocol.ReleaseProposal) | (null);
            meta: unknown;
        }>;
        "checkNow": TRPC.TRPCMutationProcedure<{
            input: void;
            output: Array<ChannelCheckRecord>;
            meta: unknown;
        }>;
        "converge": TRPC.TRPCMutationProcedure<{
            input: void;
            output: Output_updates_converge;
            meta: unknown;
        }>;
        "fleet": TRPC.TRPCQueryProcedure<{
            input: void;
            output: UpdateFleetSnapshot;
            meta: unknown;
        }>;
        "proposal": TRPC.TRPCQueryProcedure<{
            input: void;
            output: (Protocol.ReleaseProposal) | (null);
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
        "repairPayload": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                id?: string | undefined;
            });
            output: Output_updates_repairPayload;
            meta: unknown;
        }>;
        "retry": TRPC.TRPCMutationProcedure<{
            input: {
                id: string;
            };
            output: Output_updates_retry;
            meta: unknown;
        }>;
        "start": TRPC.TRPCMutationProcedure<{
            input: (undefined) | ({
                surface?: string | undefined;
            });
            output: Output_updates_retry;
            meta: unknown;
        }>;
    };
    "usage": {
        "summary": TRPC.TRPCQueryProcedure<{
            input: (undefined) | ({
                [k: string]: unknown;
            } & {});
            output: {
                buckets: _podium_model.UsageBucketWire[];
                hostname: string;
                sampledAt?: string;
            };
            meta: unknown;
        }>;
    };
    "workflows": {
        "adopt": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                revisionId: string;
                runId?: string | undefined;
                startStepId?: string | undefined;
            };
            output: Protocol.WorkflowRunWire;
            meta: unknown;
        }>;
        "assign": TRPC.TRPCMutationProcedure<{
            input: {
                revisionId: string;
                targetId: string;
                targetKind: "global" | "issue" | "repository" | "session";
            };
            output: Protocol.WorkflowBindingWire;
            meta: unknown;
        }>;
        "assignStep": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                runId?: string | undefined;
                sessionId: null | string;
                stepId: string;
            };
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "bindings": TRPC.TRPCQueryProcedure<{
            input: {
                [k: string]: unknown;
            } & {};
            output: Array<Protocol.WorkflowBindingWire>;
            meta: unknown;
        }>;
        "checkpoint": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_checkpoint;
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "create": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_create;
            output: Output_workflows_create;
            meta: unknown;
        }>;
        "fork": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_fork;
            output: Output_workflows_create;
            meta: unknown;
        }>;
        "get": TRPC.TRPCQueryProcedure<{
            input: {
                id: string;
            };
            output: Output_workflows_get;
            meta: unknown;
        }>;
        "list": TRPC.TRPCQueryProcedure<{
            input: Input_workflows_list;
            output: Array<Protocol.WorkflowWire>;
            meta: unknown;
        }>;
        "prime": TRPC.TRPCQueryProcedure<{
            input: {
                [k: string]: unknown;
            } & {};
            output: string;
            meta: unknown;
        }>;
        "profileSave": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_profileSave;
            output: Protocol.ExecutionProfileWire;
            meta: unknown;
        }>;
        "profiles": TRPC.TRPCQueryProcedure<{
            input: {
                [k: string]: unknown;
            } & {};
            output: Array<Protocol.ExecutionProfileWire>;
            meta: unknown;
        }>;
        "publish": TRPC.TRPCMutationProcedure<{
            input: {
                revisionId: string;
            };
            output: Protocol.WorkflowRevisionWire;
            meta: unknown;
        }>;
        "retry": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                runId?: string | undefined;
                stepId: string;
            };
            output: Protocol.WorkflowNextActionWire;
            meta: unknown;
        }>;
        "revise": TRPC.TRPCMutationProcedure<{
            input: Input_workflows_revise;
            output: Protocol.WorkflowRevisionWire;
            meta: unknown;
        }>;
        "runs": TRPC.TRPCQueryProcedure<{
            input: {
                includeTerminal?: boolean | undefined;
            };
            output: Array<Protocol.WorkflowRunWire>;
            meta: unknown;
        }>;
        "skip": TRPC.TRPCMutationProcedure<{
            input: {
                mutationId?: string | undefined;
                reason?: string | undefined;
                runId?: string | undefined;
                stepId: string;
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
    };
}>;
type RouterInputs = TRPC.inferRouterInputs<AppRouter>;
type RouterOutputs = TRPC.inferRouterOutputs<AppRouter>;

export type { AppRouter, RouterInputs, RouterOutputs };
