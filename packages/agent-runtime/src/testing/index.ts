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

export { describeDriverConformance, runConformance } from './conformance/suite.js'
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
  resetFakeRuntime,
} from './fake-driver.js'
