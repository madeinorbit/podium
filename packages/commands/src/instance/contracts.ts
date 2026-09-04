/**
 * THE NINE INSTANCE CONTRACTS — the three routers that administer THIS
 * DEPLOYMENT rather than any entity inside it.
 *
 *   setup.complete · setup.join · setup.connect · setup.setChannel · setup.activate
 *   auth.setPassword · auth.setLoginRequired
 *   telemetry.set · telemetry.resetId
 *
 * They share a file because they share a subject: eight of them write
 * `config.json` or the password store on the host serving the request — never a
 * row, never a session, never a repo — and the ninth, `setup.activate`, is how
 * the deployment ADOPTS what the other eight wrote. Their reads (`setup.info`, `setup.options`,
 * `setup.commandFor`, `setup.channel`, `auth.status`, `telemetry.state`,
 * `telemetry.preview`) stay queries.
 *
 * ---------------------------------------------------------------------------
 * TWO VISIBILITY CLASSES, AND THE SPLIT IS THE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 *
 * Seven are `deployment-substrate` — ADR 9 D3 rule 1, a property of the DEPLOYMENT
 * rather than of a person, the same class ADR 1 gives `configFeatures` (operator
 * `config.features`, `home: 'runtime-local'`). Nobody owns the public URL or the
 * update channel; they are facts about the box, and so is when the box turns over.
 *
 * TWO ARE `secret`, and getting this wrong in the other direction is the trap.
 * `auth.setPassword` and `auth.setLoginRequired` write CREDENTIAL MATERIAL — the
 * login password gating every human client — which ADR 1 classes `secret` with
 * `secret: 'secret-value'` (the `serverSecrets` row's shape) and which
 * `classificationErrors` then forces to `online-sensitive` delivery. Copying
 * `deployment-substrate` onto them because they sit beside `setup` would have
 * keyed a credential as an ordinary config toggle and made it offline-eligible
 * by neighbourhood.
 *
 * `setup.complete` IS THE HARD ONE and it takes the stronger class. It writes
 * deployment identity (the public URL, the host mode) AND, optionally, the login
 * password AND the telemetry answers — three things in three classes, because
 * the setup wizard commits atomically and must: setting a password closes the
 * /trpc guard, so a follow-up call from the not-yet-logged-in setup page would
 * 401. When one command writes several classes the honest answer is the most
 * restrictive one, which is the same default-closed instinct ADR 3 D3 and ADR 9
 * D4 apply everywhere else. Declared `secret`, with the reasoning, rather than
 * averaged down to the class most of its payload belongs to.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

/** `trpc` alone for all nine. The CLI reaches the SAME core functions
 *  (`applyJoin`, `applySetup`) directly rather than through a procedure, so a
 *  `cli` tag here would open nothing — measured, as POD-386 did for specs. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

const SUBSTRATE: VisibilityClass = 'deployment-substrate'
const SECRET: VisibilityClass = 'secret'

/**
 * ONLINE-ONLY for the substrate writes. These edit `config.json` ON THE HOST
 * SERVING THE REQUEST and several of them change how that host is reachable at
 * all — a queued `setup.connect` drained after the box moved would reconfigure
 * it to an identity nobody asked for, and there is no client Outbox path for
 * deployment config to ride in the first place.
 */
const SUBSTRATE_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. These write `config.json` on the host serving the request, and several change ' +
    'how that host is REACHABLE — a queued reachability change drained after the deployment moved ' +
    'would reconfigure it to an identity nobody asked for, with no way to reach it to undo. ADR 3 ' +
    'D4 rule 4 also applies: no client Outbox carries deployment config, and none should.',
  applyTimeReauthorization:
    'Re-authorized live at apply against the delegation resolved at that moment (ADR 9 D5 A1). A ' +
    'principal who has lost the grade between call and apply is refused and the config is left as ' +
    'it was — a half-applied deployment identity is worse than a rejected one.',
}

/** ADR 3 D4 rule 1, forced by the lint for a `secret` resource and correct on its
 *  own terms: credential material is never held in a queue and never replayed. */
const SECRET_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued, and ADR 3 D4 rule 1 makes that structural rather than a promise — a `secret` ' +
    'resource forces `online-sensitive`, which `classificationErrors` enforces. A password sitting ' +
    'in a durable client-side queue is the failure this class exists to prevent, and a replayed ' +
    'password change could silently re-open an instance the operator had just locked.',
  applyTimeReauthorization:
    'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 D8). ' +
    'The live check is stronger than re-authorization anyway: changing or disabling a password ' +
    'requires the CURRENT one, so a hijacked session cannot use a stale grade.',
}

const NO_SECRETS: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'No credential crosses this surface. The candidates were reviewed rather than assumed: a public ' +
    'URL, a host mode, an update channel and a pairing-derived join code are deployment identity, ' +
    'not secrets — the URL is by definition public, and the join code is single-use and already ' +
    'displayed to the operator who is pasting it.',
}

/** Attribution for the substrate writes. A pair, because config.json records no
 *  writer and the accountability has to come from somewhere. */
const INSTANCE_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. `config.json` records no writer, ' +
    'so this pair exists to authorize and audit the change rather than to be persisted — and these ' +
    'are the commands that decide how an instance is reached and who may log into it, which is ' +
    'precisely where "who did this" must not be guessable from the payload.',
}

/** None of the nine takes a caller-supplied entity id: they address THIS
 *  deployment, which the caller has already reached. */
const NO_TARGET: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'No entity id on any of these — the target is the deployment the caller has already reached, so ' +
    'there is nothing to iterate and no existence to leak. Amendment 1 D20.3’s question does not ' +
    'arise rather than being answered permissively.',
}

const CREATES_NOTHING = {
  creates: [],
  note: 'Rewrites deployment configuration or the password store in place, or replaces the process running it. Mints no entity and moves no ownership.',
} as const

// ---------------------------------------------------------------------------
// setup.*
// ---------------------------------------------------------------------------

export const setupCompleteInput = z.object({
  publicUrl: z.string(),
  /** The reachability method selected alongside the URL. */
  networkOption: z
    .enum(['tailscale-funnel', 'tailscale-serve', 'cloudflare-tunnel', 'manual'])
    .optional(),
  /** Which host mode this reachable box is (the web runs this step for both);
   *  absent preserves the existing mode (default all-in-one on first run). */
  mode: z.enum(['all-in-one', 'server']).optional(),
  password: z.string().optional(),
  acknowledgeNoPassword: z.literal(true).optional(),
  /** The web setup's telemetry answers [spec:SP-f933]. Rides THIS payload so the
   *  wizard commits atomically — and because setting a password closes the /trpc
   *  guard, a follow-up telemetry call from the not-yet-logged-in setup page
   *  would 401. Absent = not asked. */
  telemetry: z.object({ usage: z.enum(['on', 'off']), crash: z.enum(['on', 'off']) }).optional(),
  /**
   * Acknowledge that replacing an ALREADY-SET public URL strands every joined
   * machine (PDM-26): the old URL is embedded in every join token issued and
   * every paired device's record, and none of them can be told about the new
   * one. Never needed for the first URL, and writing the same URL again is
   * idempotent — so it is only ever collected when a live deployment's address
   * is actually being changed.
   */
  confirmUrlChange: z.literal(true).optional(),
})

export const setupCompleteContract = {
  name: 'setup.complete',
  version: 1,
  visibility: SECRET,
  input: setupCompleteInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'MANAGE and `admin`: this decides how the instance is reached and, optionally, the password ' +
      'gating every human client. `resource: secret` because the payload can carry credential ' +
      'material, which is also what forces `online-sensitive` delivery through the lint — the ' +
      'stronger of the classes it writes, chosen deliberately (see the file header). Note this is ' +
      'the FIRST-RUN surface, so the grade describes intent rather than a gate that can already ' +
      'bite: on a fresh instance there is no password and every caller is the operator by ' +
      'construction. No confirmation: the wizard IS the confirmation, and the no-password case ' +
      'already demands an explicit `acknowledgeNoPassword` rather than a silent default.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: ['password'],
    outputPaths: [],
    note:
      '`password` IS credential material and is redacted from any log or audit record of this ' +
      'command. `publicUrl`, `networkOption`, and `mode` are deployment identity and stay visible. ' +
      'A refusal must name the URL to be actionable. The telemetry answers are ' +
      'consent booleans, not data. The RESULT is the resolved config and carries no password back, ' +
      'which is why `outputPaths` is empty rather than unexamined.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'One-shot deployment bootstrap: a deployment already set up refuses a second complete rather than re-running it',
} as const satisfies CommandContract<typeof setupCompleteInput>

export const setupJoinInput = z.object({ code: z.string() })

export const setupJoinContract = {
  name: 'setup.join',
  version: 1,
  visibility: SUBSTRATE,
  input: setupJoinInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'Daemon onboarding: one pasted join code (server URL + pairing code) becomes this daemon’s ' +
      'config. MANAGE and `admin` because it decides which server this machine answers to, which is ' +
      'the strongest statement a daemon makes about itself. `resource: global` — the target is this ' +
      'deployment, not a row. No confirmation: pasting the code IS the deliberate act, and the same ' +
      'core `applyJoin` backs the CLI flow so the web and terminal paths stay identical.',
  },
  exposure: SERVED_ON,
  delivery: SUBSTRATE_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      '`code` was the candidate and is deliberately NOT redacted: a join code is single-use, ' +
      'short-lived, and is at this moment sitting in the operator’s clipboard and on their screen. ' +
      'Redacting it would hide the one field a "that code is invalid" refusal must name to be ' +
      'actionable, while protecting nothing — the pairing secret it derives from is never echoed.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'One-shot: joining an already-joined deployment is refused, so a second join cannot repoint a live instance underneath its sessions',
} as const satisfies CommandContract<typeof setupJoinInput>

export const setupConnectInput = z.object({
  mode: z.enum(['all-in-one', 'client', 'server']),
  serverUrl: z.string().optional(),
})

export const setupConnectContract = {
  name: 'setup.connect',
  version: 1,
  visibility: SUBSTRATE,
  input: setupConnectInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'The modes with no reachability flow — all-in-one ("skip"), client (remote URL), server-only. ' +
      'MANAGE and `admin` for `setup.join`’s reason: it decides what this box IS. Replaces the ' +
      'legacy POST /setup/config so there is one tRPC surface for every setup write. No ' +
      'confirmation: choosing a mode in the wizard is itself the deliberate act.',
  },
  exposure: SERVED_ON,
  delivery: SUBSTRATE_DELIVERY,
  redaction: NO_SECRETS,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'One-shot pairing of this instance to its upstream; a concurrent connect is refused rather than merged, since two upstreams is not a mergeable state',
} as const satisfies CommandContract<typeof setupConnectInput>

export const setupSetChannelInput = z.object({ channel: z.enum(['stable', 'edge', 'dev']) })

export const setupSetChannelContract = {
  name: 'setup.setChannel',
  version: 1,
  visibility: SUBSTRATE,
  input: setupSetChannelInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'The update channel is a property of the deployment and decides which BUILDS this instance ' +
      'and its daemons will install — an `edge` or `dev` switch changes what code runs on every ' +
      'machine joined to it that has not pinned an override of its own (POD-1882), which is why ' +
      'this is `manage`/`admin` and not an ordinary preference write ' +
      'despite looking like a toggle. No confirmation: it is reversible by switching back, and the ' +
      'change takes effect at the next update rather than immediately.',
  },
  exposure: SERVED_ON,
  delivery: SUBSTRATE_DELIVERY,
  redaction: NO_SECRETS,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'Single deployment-wide release channel; the later Authority commit wins and there is no per-user partition to merge',
} as const satisfies CommandContract<typeof setupSetChannelInput>

/**
 * THE REMEDY, AND IT HAD TO STOP BEING BEHIND THE FAILURE (POD-2766).
 *
 * Writing boot-relevant config and RUNNING it are two events. Between them the
 * server reports `activation_pending` and refuses to serve work, which is right —
 * a process running config nobody asked it to run should not be trusted with
 * agents, sessions or repos. What was wrong is that the restart which ends that
 * state had no command: the operator was told "restart Podium on the server" by a
 * screen reached over the internet, and the only way to comply was to reach into
 * the box. A safety mechanism whose remedy is unreachable gets worked around.
 *
 * So the restart is a command, and it is on the CONTROL plane: the boundary
 * serves it while the data plane is blocked, precisely so the person who can fix
 * the instance can reach it. It is not a general "restart the server" button —
 * the procedure refuses unless the instance is actually activation-pending, so
 * this cannot become a remote bounce lever on a healthy deployment.
 */
export const setupActivateInput = z.object({}).passthrough().optional()

export const setupActivateContract = {
  name: 'setup.activate',
  version: 1,
  visibility: SUBSTRATE,
  input: setupActivateInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'confirm',
    rationale:
      'RESTARTS THE PROCESS SERVING THE REQUEST so it adopts the config already on disk. `manage` ' +
      'and `admin` because it decides when this deployment turns over, which is the same grade as ' +
      'deciding what it IS — and because an unauthenticated restart on a reachable box would be a ' +
      'bounce lever for anyone who can resolve the URL. `resource: global`: the target is the ' +
      'deployment the caller has already reached. CONFIRMATION, unlike every other setup write ' +
      'here: this one drops live connections. It is not destructive in ADR 3 D2’s sense — nothing ' +
      'is deleted and the config being adopted is the config the operator asked for — but a ' +
      'mis-click costs everyone connected their transport, and the screen that offers it is one an ' +
      'operator lands on while something is already wrong. The narrower guard is in the procedure ' +
      'rather than the grade: it refuses outright unless readiness is `activation_pending`, so a ' +
      'healthy instance has no restart button to press by accident.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued, and this is the clearest case in the file. A restart drained from a queue ' +
      'minutes or hours later would bounce a deployment that had long since been activated by ' +
      'other means — the operator restarting it themselves, an update, a host reboot — for a ' +
      'staleness that no longer exists. The command is only meaningful against the readiness the ' +
      'caller was looking at, which is exactly what "online-only" encodes.',
    applyTimeReauthorization:
      'Not reachable, since the class forbids queuing; stated for totality (ADR 3 D8). The live ' +
      'precondition is stronger than a re-authorization anyway: the procedure re-reads readiness ' +
      'at apply and refuses a deployment that is no longer activation-pending, so a second click ' +
      'on a stale screen cannot restart an instance that has already recovered.',
  } satisfies DeliveryPolicy,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'No input and no secret. The result names the state the caller should now expect and the ' +
      'version being left behind, both of which the readiness route already publishes.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'One process, one turnover: a second activate while a restart is already scheduled is a no-op rather than a second restart, and there is nothing to merge',
} as const satisfies CommandContract<typeof setupActivateInput>

// ---------------------------------------------------------------------------
// auth.*
// ---------------------------------------------------------------------------

export const authSetPasswordInput = z.object({
  current: z.string().optional(),
  next: z.string().min(1),
})

export const authSetPasswordContract = {
  name: 'auth.setPassword',
  version: 1,
  visibility: SECRET,
  input: authSetPasswordInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      "MY OWN PASSWORD. The command writes the CALLING account's credential and no other, so the " +
      'floor is `member`: every user may change their own password, and admin is not a ' +
      'prerequisite for having one. It was `admin` when there was ONE password for the whole ' +
      'instance and holding it meant holding the box (POD-1554 retired that). `resource: secret` ' +
      'stays — it is still credential material, and it forces `online-sensitive` delivery through ' +
      'the lint. NO CONFIRMATION FIELD, and that is not a gap: the confirmation is IN THE INPUT ' +
      'and stronger than a dialog. `current` must verify when the caller already has a ' +
      'credential, which defends against a hijacked session in a way `confirmation: "confirm"` — ' +
      'a client-side prompt — cannot. A caller with no credential yet skips the check; that is ' +
      'bootstrap, and the shipped behaviour is kept exactly.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: ['current', 'next'],
    outputPaths: [],
    note:
      'BOTH password fields are credential material and both are redacted — `current` as much as ' +
      '`next`, because a log that captured the old password would leak a live credential for every ' +
      'instance that had not yet rotated. The result is `{ enabled: true }` and deliberately carries ' +
      'nothing else back.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'ROW.serverSecrets declared rule; the later Authority commit wins outright — a password is never merged, and the previous value is not recoverable from the new one',
} as const satisfies CommandContract<typeof authSetPasswordInput>

export const authSetLoginRequiredInput = z.object({
  /** `false` enters open mode — this instance serves everything with no login. */
  required: z.boolean(),
  current: z.string(),
  acknowledgeNoPassword: z.literal(true).optional(),
})

export const authSetLoginRequiredContract = {
  name: 'auth.setLoginRequired',
  version: 1,
  visibility: SECRET,
  input: authSetLoginRequiredInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'INSTANCE POLICY, AND THE ONE COMMAND HERE THAT CARRIES A CONFIRMATION. `admin`, unlike ' +
      "`setPassword`'s `member`, and the split is the whole point of POD-1554: setting YOUR " +
      "password is yours, turning login off is the INSTANCE's, and one user cannot decide it for " +
      'everyone. Disabling login leaves the instance open to anyone who can reach it, which is ' +
      'destructive in ADR 3 D2’s sense even though it deletes no data — hence ' +
      '`confirmation: "confirm"` on top of the explicit `acknowledgeNoPassword` the procedure ' +
      'already demands, and `current` verified on top of that. It writes a config flag rather than ' +
      "deleting credentials, so re-enabling login restores every account's existing password " +
      'instead of making everyone re-enrol.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: ['current'],
    outputPaths: [],
    note: '`current` is a live credential and is redacted. The acknowledgement flag and `required` are booleans, and the result is `{ loginRequired }`.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'As auth.setPassword; idempotent — setting loginRequired to the value it already holds is ' +
    'a no-op. (POD-1250 declared this against the command when it was `auth.clearPassword`; ' +
    'POD-1554 renamed it to `auth.setLoginRequired` and made it write a config flag instead of ' +
    'deleting credentials. The class is unchanged: it is still a single-writer instance setting.)',
} as const satisfies CommandContract<typeof authSetLoginRequiredInput>

// ---------------------------------------------------------------------------
// telemetry.*
// ---------------------------------------------------------------------------

/** At least one tier, so an empty call cannot silently no-op — the shipped
 *  refinement, kept verbatim. */
export const telemetrySetInput = z
  .object({
    usage: z.enum(['on', 'off']).optional(),
    crash: z.enum(['on', 'off']).optional(),
  })
  .refine((v) => v.usage !== undefined || v.crash !== undefined, {
    message: 'specify usage and/or crash',
  })

export const telemetrySetContract = {
  name: 'telemetry.set',
  version: 1,
  visibility: SUBSTRATE,
  input: telemetrySetInput,
  policy: {
    action: 'write',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'Opt-in telemetry consent [spec:SP-f933] — Settings → Privacy’s backing surface. Writes ' +
      '`config.json` (D8) and NOT the settings blob, so the web toggles and `podium telemetry off` ' +
      'are the same switch. `write` rather than `manage`: it records an answer, it does not ' +
      'administer the box. `admin` because consent is given ONCE FOR THE WHOLE DEPLOYMENT — there ' +
      'is no per-user telemetry partition, so a member toggling it would be answering on everyone ' +
      'else’s behalf. No confirmation: it is a preference and instantly reversible. Self-persisting ' +
      'by design, because "I turned telemetry off" must never be lost to an unsaved page.',
  },
  exposure: SERVED_ON,
  delivery: SUBSTRATE_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Two on/off enums. Consent booleans are not data about anyone, and nothing is returned but the resulting state.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'One deployment-wide consent answer (there is no per-user telemetry partition); the later Authority commit wins',
} as const satisfies CommandContract<typeof telemetrySetInput>

export const telemetryResetIdInput = z.object({}).passthrough().optional()

export const telemetryResetIdContract = {
  name: 'telemetry.resetId',
  version: 1,
  visibility: SUBSTRATE,
  input: telemetryResetIdInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'Rotates the anonymous install id. `manage` rather than `write` — and the reason is worth ' +
      'stating, because this is the most privacy-protective command in the file and could be argued ' +
      'the other way. Rotating the id SEVERS the deployment’s continuity in every downstream ' +
      'report, which is exactly what a user asking for it wants and is also irreversible: the old ' +
      'id cannot be recovered, so a rotation nobody intended silently discards history. It is an ' +
      'administrative act on deployment identity. No confirmation: a user reaching for this wants ' +
      'it to work, and the cost of an accidental rotation is analytics continuity, not their data.',
  },
  exposure: SERVED_ON,
  delivery: SUBSTRATE_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'No input. The output is the NEW anonymous install id — reviewed and deliberately returned, ' +
      'because the Privacy page shows the user the id that identifies their deployment, and hiding ' +
      'it would undercut the transparency the opt-in surface exists to provide.',
  } satisfies RedactionPolicy,
  ownership: CREATES_NOTHING,
  attribution: INSTANCE_ATTRIBUTION,
  errorConsistency: NO_TARGET,
  conflict: 'cmd',
  conflictRule:
    'Mints a fresh anonymous id; two concurrent resets leave one id, and the previous one is deliberately unrecoverable',
} as const satisfies CommandContract<typeof telemetryResetIdInput>

// ---------------------------------------------------------------------------
// The tables — one per ROUTER, because the wire groups them that way
// ---------------------------------------------------------------------------

export const SETUP_CONTRACTS = {
  complete: setupCompleteContract,
  join: setupJoinContract,
  connect: setupConnectContract,
  setChannel: setupSetChannelContract,
  activate: setupActivateContract,
} as const
export type SetupContractName = keyof typeof SETUP_CONTRACTS
export const SETUP_CONTRACT_NAMES = Object.keys(SETUP_CONTRACTS).sort() as SetupContractName[]

export const AUTH_CONTRACTS = {
  setPassword: authSetPasswordContract,
  setLoginRequired: authSetLoginRequiredContract,
} as const
export type AuthContractName = keyof typeof AUTH_CONTRACTS
export const AUTH_CONTRACT_NAMES = Object.keys(AUTH_CONTRACTS).sort() as AuthContractName[]

export const TELEMETRY_CONTRACTS = {
  set: telemetrySetContract,
  resetId: telemetryResetIdContract,
} as const
export type TelemetryContractName = keyof typeof TELEMETRY_CONTRACTS
export const TELEMETRY_CONTRACT_NAMES = Object.keys(
  TELEMETRY_CONTRACTS,
).sort() as TelemetryContractName[]
