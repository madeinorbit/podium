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
 * So the boundary is a `satisfies Record<RuntimePrimitive, RuntimeTier>`, and
 * `RuntimePrimitive` is the key set of that table: the two cannot drift apart,
 * and "which primitives must a driver implement or decline" becomes a value the
 * conformance suite reads rather than a list a reviewer remembers.
 *
 * WHAT THIS DOES AND DOES NOT PROVE, stated plainly because the distinction is
 * easy to overclaim: `satisfies Record<>` makes the table total over the UNION,
 * not over the SURFACE. Adding a verb to `AgentSessionHandle` or `AgentRuntime`
 * without adding its name below is not a compile error — the union is maintained
 * by hand, which is the same weakness a paragraph has. What the table buys is
 * that the union and the tiering can never disagree, and that the tier is a
 * value rather than prose. Keeping the union honest against the interfaces is a
 * review obligation; `packages/agent-runtime/src/testing/manifest-axis.test.ts`
 * pins the handful the conformance corpus depends on.
 *
 * THE RULE FOR NEW ENTRIES: new primitives default to `extended` and must argue
 * their way into `core`. The argument is: a Podium feature consumes it AND every
 * family can implement it or honestly decline it. If a primitive is core, the
 * conformance suite pins it and a driver that ships without it is incomplete.
 */

/**
 * CORE — what a new driver MUST implement or explicitly decline.
 *
 * NOT "and all the conformance suite pins", which is what this said and is no
 * longer true (POD-2019's review, relayed to POD-2020). `import` and `list` are
 * core and live on the RUNTIME, not on a session handle, so the corpus — which
 * is parameterized over a driver and a session — has nothing to call them
 * through. Core is the completeness bar for a DRIVER; what the corpus pins is a
 * subset of it, and `testing/manifest-axis.test.ts` is where that subset is
 * named.
 *
 * EXTENDED — feature seams carried on the same registry that never block a
 * driver. A driver shipping only the core is COMPLETE.
 */
export type RuntimeTier = 'core' | 'extended'

/** Every primitive on the surface, named. The union is the key set of
 *  {@link RUNTIME_PRIMITIVE_TIER}, so the two cannot drift apart. */
export type RuntimePrimitive =
  // runtime-level, per machine (./runtime.ts)
  | 'import'
  | 'list'
  | 'quota'
  | 'usage'
  | 'accounts'
  | 'login'
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
  | 'openUrl'
  | 'title'
  | 'accentColor'

export const RUNTIME_PRIMITIVE_TIER = {
  // ---- CORE: runtime-level (per machine) ---------------------------------
  // `import` is core because the ARCHIVE GUARANTEE is: an archive must be
  // sufficient to continue the conversation on any machine with the same
  // harness, and without this verb that promise has nothing to honour it.
  import: 'core',
  // What is ACTUALLY running, read from the process table. Core because adopt
  // needs it: a supervisor that cannot enumerate survivors cannot rebind them.
  list: 'core',

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
  // Machine accounting and accounts. Extended because every one of them
  // degrades cleanly: a harness that reports no quota simply shows no quota,
  // and a driver is not less complete for it.
  usage: 'extended',
  quota: 'extended',
  accounts: 'extended',
  login: 'extended',
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
