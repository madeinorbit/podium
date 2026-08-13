/**
 * THE TIER BOUNDARY, AS DATA (spec §3 "Two tiers, so rule 1 has counter-pressure").
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TABLE AND NOT A PARAGRAPH
 * ---------------------------------------------------------------------------
 *
 * The spec's own argument for the boundary is historical: "without this tier
 * boundary, the surface audit's own history shows the contract only ever grows".
 * A tier recorded in prose grows exactly the same way — nobody's build fails when
 * a new primitive quietly calls itself core.
 *
 * So the boundary is a `satisfies Record<RuntimePrimitive, RuntimeTier>`: TOTAL
 * over the primitive names, which makes adding a primitive without tiering it a
 * COMPILE error, and makes "which primitives must a driver implement or decline"
 * a value the conformance suite reads rather than a list a reviewer remembers.
 *
 * THE RULE FOR NEW ENTRIES: new primitives default to `extended` and must argue
 * their way into `core`. The argument is: a Podium feature consumes it AND every
 * family can implement it or honestly decline it. If a primitive is core, the
 * conformance suite pins it and a driver that ships without it is incomplete.
 */

/**
 * CORE — what a new driver MUST implement or explicitly decline, and all the
 * conformance suite pins.
 *
 * EXTENDED — feature seams carried on the same registry that never block a
 * driver. A driver shipping only the core is COMPLETE.
 */
export type RuntimeTier = 'core' | 'extended'

/** Every primitive on the surface, named. The union is the key set of
 *  {@link RUNTIME_PRIMITIVE_TIER}, so the two cannot drift apart. */
export type RuntimePrimitive =
  // lifecycle & identity
  | 'create'
  | 'resume'
  | 'adopt'
  | 'stop'
  | 'hibernate'
  | 'kill'
  | 'health'
  | 'snapshot'
  | 'export'
  // turns & control
  | 'send'
  | 'stageAttachment'
  | 'interrupt'
  | 'answer'
  // interactions
  | 'interactions'
  // observation
  | 'events'
  | 'watch'
  | 'state'
  // transcript
  | 'transcript.history'
  // attach & lease
  | 'attach'
  | 'lease'
  // extended
  | 'draft'
  | 'configure'
  | 'usage'
  | 'quota'
  | 'openUrl'
  | 'title'
  | 'accentColor'

export const RUNTIME_PRIMITIVE_TIER = {
  // ---- CORE: lifecycle & identity ----------------------------------------
  create: 'core',
  resume: 'core',
  // `adopt` is core and first-class: a supervisor restart that cannot rebind a
  // surviving process tree strands it, which is the ghost-session failure the
  // whole causal contract exists to prevent.
  adopt: 'core',
  stop: 'core',
  hibernate: 'core',
  kill: 'core',
  health: 'core',
  snapshot: 'core',
  // `export` is core because the ARCHIVE GUARANTEE is core: handoff, cloud
  // migration, disaster recovery and scheduled backup all rest on it.
  export: 'core',

  // ---- CORE: turns & control ---------------------------------------------
  send: 'core',
  stageAttachment: 'core',
  interrupt: 'core',
  answer: 'core',

  // ---- CORE: interactions -------------------------------------------------
  interactions: 'core',

  // ---- CORE: observation --------------------------------------------------
  events: 'core',
  watch: 'core',
  state: 'core',

  // ---- CORE: transcript ---------------------------------------------------
  'transcript.history': 'core',

  // ---- CORE: attach & lease ----------------------------------------------
  // Core, and DECLINABLE: the embedded family has no terminal at all and says so
  // (`Declared` unsupported). Core does not mean universal — it means the
  // question must be answered.
  attach: 'core',
  lease: 'core',

  // ---- EXTENDED: feature seams -------------------------------------------
  // Each of these is a real Podium feature's seam, and NONE of them may block a
  // driver from being complete. Cross-device draft sync, the settings model
  // picker, the usage ledger, the browser-open relay, session titles and the
  // board's accent colours all degrade cleanly when a driver declines.
  draft: 'extended',
  configure: 'extended',
  usage: 'extended',
  quota: 'extended',
  openUrl: 'extended',
  title: 'extended',
  accentColor: 'extended',
} as const satisfies Record<RuntimePrimitive, RuntimeTier>

/** The core primitives, derived — never hand-listed a second time. */
export const CORE_PRIMITIVES: readonly RuntimePrimitive[] = (
  Object.keys(RUNTIME_PRIMITIVE_TIER) as RuntimePrimitive[]
).filter((primitive) => RUNTIME_PRIMITIVE_TIER[primitive] === 'core')

export const EXTENDED_PRIMITIVES: readonly RuntimePrimitive[] = (
  Object.keys(RUNTIME_PRIMITIVE_TIER) as RuntimePrimitive[]
).filter((primitive) => RUNTIME_PRIMITIVE_TIER[primitive] === 'extended')

export const tierOf = (primitive: RuntimePrimitive): RuntimeTier =>
  RUNTIME_PRIMITIVE_TIER[primitive]
