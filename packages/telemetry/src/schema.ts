/**
 * THE telemetry schema of record [spec:SP-f933].
 *
 * This module is the single source of truth for everything that may leave a
 * user's machine. `docs/TELEMETRY.md` documents it for humans and
 * `docs-drift.test.ts` fails CI if the two disagree — so the published promise
 * and the code can never quietly diverge.
 *
 * THE INVARIANT — enums and numbers only. There is deliberately NO free-string
 * field anywhere below: every string is pinned by a regex, a uuid check, or an
 * enum, and every object is `.strict()`. That is what makes "we never send your
 * paths / repo names / prompts / code" a property of the type system rather
 * than a promise about our future diligence. `schema.test.ts` walks this tree
 * and fails on any unconstrained `z.string()`, so the invariant survives people
 * who have never read this comment.
 *
 * Adding a field? It must be an enum, a bounded number, a boolean, or a
 * regex-pinned string whose alphabet cannot express user data. If you cannot
 * express what you want that way, the answer is that you cannot send it.
 */
import { AgentKind } from '@podium/protocol'
import { z } from 'zod'

/** Wire schema version. Bump only for a breaking payload change; the relay
 *  rejects anything it does not know. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** The two independently-consented tiers (D2). There is no `perf` tier (D3). */
export const TELEMETRY_TIERS = ['usage', 'crash'] as const
export const TelemetryTier = z.enum(TELEMETRY_TIERS)
export type TelemetryTier = z.infer<typeof TelemetryTier>

// ---------------------------------------------------------------------------
// Primitive value domains — every one closed by construction
// ---------------------------------------------------------------------------

/** Random UUIDv4, minted on first opt-in, resettable (`podium telemetry reset-id`).
 *  Not derived from hostname/user/mac — nothing about the machine is recoverable. */
export const InstallId = z.string().uuid()

/** A published Podium version ('1.4.2', '0.1.2-edge.1') or the literal 'dev' for
 *  source runs. Regex-pinned: a version string is the one piece of build identity
 *  we send, and it must not become a place free text can hide. */
export const AppVersion = z.string().regex(/^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)*|dev)$/)

/** process.platform, folded to the set we support + 'other'. Never the raw value. */
export const TelemetryOs = z.enum(['linux', 'darwin', 'win32', 'other'])
export type TelemetryOs = z.infer<typeof TelemetryOs>

/** process.arch, folded the same way. */
export const TelemetryArch = z.enum(['x64', 'arm64', 'other'])
export type TelemetryArch = z.infer<typeof TelemetryArch>

/** Pre-bucketed install age — the RAW age never exists in the payload, so a
 *  precise opt-in timestamp can't be used to single an install out. */
export const InstallAgeBucket = z.enum(['0d', '1-7d', '8-30d', '31-90d', '90d+'])
export type InstallAgeBucket = z.infer<typeof InstallAgeBucket>

/** Pre-bucketed machine count, same reasoning. */
export const MachinesBucket = z.enum(['1', '2-5', '6-20', '20+'])
export type MachinesBucket = z.infer<typeof MachinesBucket>

/**
 * The feature surfaces we count, as a closed enum — NOT free-form keys.
 *
 * ONLY surfaces that are actually wired to `markFeature()` belong here. The
 * design listed `spec` and `handoff` too, and they shipped in the first cut as
 * enum members nothing ever set — so every report would have said
 * `spec: false, handoff: false` forever, and the example report advertised
 * `spec: true`, which no real report could produce.
 *
 * A field that structurally cannot be true is worse than a missing field: it
 * yields confidently wrong data ("nobody uses spec") that reads as a product
 * signal instead of the wiring bug it is. Telemetry exists to stop us guessing;
 * a lying field makes us guess with false confidence.
 *
 * Adding one back is cheap and additive — wire the event, add the member, and
 * the drift guards (docs-drift.test.ts, example.test.ts) will force the doc and
 * the example to follow. See POD-739.
 */
export const TELEMETRY_FEATURES = ['issues'] as const
export const TelemetryFeature = z.enum(TELEMETRY_FEATURES)
export type TelemetryFeature = z.infer<typeof TelemetryFeature>

/** A bounded, non-negative count. The cap keeps a runaway counter from turning
 *  into an unbounded number and makes the relay's validation total. */
const Count = z.number().int().nonnegative().max(1_000_000)

/**
 * Error CONSTRUCTOR names, as an enum of the standard JS error types plus
 * 'Other'. Deviation from the design doc, which showed `errorType: "TypeError"`
 * without saying how it is constrained: a free `z.string()` here would let a
 * custom (or dynamically-named) error class carry text off the machine, which
 * is exactly the hole the enums-only invariant exists to close. Anything not on
 * this list reports as 'Other'.
 */
export const ErrorType = z.enum([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'Other',
])
export type ErrorType = z.infer<typeof ErrorType>

/**
 * A stack-frame path, pinned to the Podium install's own source tree: a known
 * top-level directory, then a bounded [A-Za-z0-9._-]/ alphabet, ending in a JS/TS
 * extension. A user's repo name, branch, username or home directory cannot be
 * expressed in this shape — `scrub.ts` drops every frame that doesn't match
 * (it never rewrites one into matching).
 */
export const PODIUM_SOURCE_ROOTS = [
  'apps',
  'packages',
  'scripts',
  'services',
  'src',
  'dist',
] as const
export const PodiumRelativePath = z
  .string()
  .regex(
    new RegExp(
      `^(?:${PODIUM_SOURCE_ROOTS.join('|')})(?:/[A-Za-z0-9._-]{1,64}){1,12}\\.(?:m|c)?[jt]sx?$`,
    ),
  )
  .max(200)

/** A JS identifier (plus the `.`/`<>` V8 uses for methods and `<anonymous>`). */
export const FrameFunction = z
  .string()
  .regex(/^[A-Za-z_$<][A-Za-z0-9_$.<>[\] ]{0,79}$/)
  .max(80)

// ---------------------------------------------------------------------------
// The two reports
// ---------------------------------------------------------------------------

/**
 * `usage` tier — one report per day, per install.
 *
 * `sessions` is a COUNTER (sessions started since the last flush), keyed by the
 * existing protocol harness enum — not free strings. `features` says only
 * whether a surface was touched in the window, never with what.
 */
export const UsageReport = z
  .object({
    schema: z.literal(TELEMETRY_SCHEMA_VERSION),
    installId: InstallId,
    version: AppVersion,
    os: TelemetryOs,
    arch: TelemetryArch,
    installAge: InstallAgeBucket,
    machines: MachinesBucket,
    sessions: z.record(AgentKind, Count),
    features: z.record(TelemetryFeature, z.boolean()),
  })
  .strict()
export type UsageReport = z.infer<typeof UsageReport>

/** One scrubbed stack frame. Produced only by `scrub.ts`. */
export const StackFrame = z
  .object({
    file: PodiumRelativePath,
    line: z.number().int().positive().max(10_000_000),
    /** Absent when the frame is top-level or the name isn't a plain identifier. */
    fn: FrameFunction.optional(),
  })
  .strict()
export type StackFrame = z.infer<typeof StackFrame>

/**
 * `crash` tier — rate-limited per (errorType, top-frame) signature.
 *
 * NOTE what is NOT here: the error MESSAGE. Messages routinely embed paths, repo
 * names, URLs and user data, there is no way to constrain them to a safe
 * alphabet, and so they are dropped at the source rather than scrubbed.
 */
export const CrashReport = z
  .object({
    schema: z.literal(TELEMETRY_SCHEMA_VERSION),
    installId: InstallId,
    version: AppVersion,
    os: TelemetryOs,
    arch: TelemetryArch,
    errorType: ErrorType,
    frames: z.array(StackFrame).max(20),
  })
  .strict()
export type CrashReport = z.infer<typeof CrashReport>

/**
 * THE wire body. Deliberately un-tagged: the design's payloads carry no `tier`
 * discriminator, and `.strict()` on both branches makes the union unambiguous
 * anyway (usage has installAge/machines/sessions/features; crash has
 * errorType/frames). The relay classifies by which branch matched.
 */
export const TelemetryReport = z.union([UsageReport, CrashReport])
export type TelemetryReport = z.infer<typeof TelemetryReport>

/** Which tier a validated report belongs to. */
export function tierOf(report: TelemetryReport): TelemetryTier {
  return 'errorType' in report ? 'crash' : 'usage'
}

// ---------------------------------------------------------------------------
// Bucketing — the ONLY way a raw count/age becomes a payload field
// ---------------------------------------------------------------------------

export function bucketInstallAge(ageMs: number): InstallAgeBucket {
  const days = Math.floor(ageMs / 86_400_000)
  if (days < 1) return '0d'
  if (days <= 7) return '1-7d'
  if (days <= 30) return '8-30d'
  if (days <= 90) return '31-90d'
  return '90d+'
}

export function bucketMachines(count: number): MachinesBucket {
  if (count <= 1) return '1'
  if (count <= 5) return '2-5'
  if (count <= 20) return '6-20'
  return '20+'
}

export function normalizeOs(platform: string): TelemetryOs {
  return TelemetryOs.safeParse(platform).success ? (platform as TelemetryOs) : 'other'
}

export function normalizeArch(arch: string): TelemetryArch {
  return TelemetryArch.safeParse(arch).success ? (arch as TelemetryArch) : 'other'
}

/** Fold a raw version string to the schema's alphabet; anything unrecognized
 *  reports as 'dev' rather than smuggling itself through. */
export function normalizeVersion(version: string | undefined): string {
  return AppVersion.safeParse(version).success ? (version as string) : 'dev'
}

/** Fold an error constructor name to the closed enum (see {@link ErrorType}). */
export function normalizeErrorType(name: string | undefined): ErrorType {
  return ErrorType.safeParse(name).success ? (name as ErrorType) : 'Other'
}
