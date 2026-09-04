/**
 * `@podium/agent-runtime/testing` — THE CONFORMANCE CORPUS AND ITS REFERENCE
 * DRIVER.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN EXPORTED SUBPATH AND NOT A TEST FILE
 * ---------------------------------------------------------------------------
 *
 * "When codex-server lands it passes the same suite, the selection policy flips,
 * and no server module, view-model or feature changes — because none of them
 * ever knew more than this surface" (spec §3). That sentence is only true if ONE
 * body of properties runs against EVERY driver, which means W3's terminal
 * driver, W5's opencode driver and W6's codex driver must be able to IMPORT the
 * corpus. A suite that lives in a test directory of another package is a suite
 * nobody else can run, and a per-driver copy is three suites that drift.
 *
 * So `runConformance` ships as product: a parameterized function a driver author
 * calls with their own driver and a small control surface.
 */

export {
  /**
   * Exported for the same reason `assertAttachHonoursOneControlLease` is, and
   * the driver fixtures use it the same way: `archive` is the one CORE
   * capability whose declaration flips on a HOST fact, so a driver reaches only
   * ONE of its two arms under its own `runConformance` pass. Its fixture builds
   * the other world and is judged by this function rather than by a copy of it.
   */
  assertArchiveHonoursItsDeclaration,
  describeDriverConformance,
  runConformance,
} from './conformance/suite.js'
export type {
  ConformanceControl,
  ConformanceOptions,
  ConformanceTarget,
} from './conformance/target.js'
export type { FakeControl, FakeDriver, FakeDriverOptions } from './fake-driver.js'
export {
  createFakeDriver,
  createFakeServerDriver,
  createFakeTerminalDriver,
  /** The minimal valid payload per kind (POD-2020) — exported because every
   *  driver's `ConformanceControl` needs it to satisfy a bare-kind
   *  `askInteraction`, and three copies of "what does a boring permission ask
   *  look like" is three things to keep in step. */
  defaultAskFor,
  resetFakeRuntime,
} from './fake-driver.js'
