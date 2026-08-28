// Part of the Agent Runtime contract (POD-1761 W1, POD-3087). See ./index.ts for
// the surface's five governing rules and the core-vs-extended tier boundary.

import type { Declared } from '@podium/harness'
import { supported, unsupported } from '@podium/harness'
import type { ConfigureCapability, ConfigureRequest } from './capabilities.js'
import { claudeSdkCapabilities } from './drivers/claude-sdk/capabilities.js'
import { codexAppServerCapabilities } from './drivers/codex/capabilities.js'
import { grokAcpCapabilities } from './drivers/grok-acp/capabilities.js'
import { opencodeServerCapabilities } from './drivers/opencode/capabilities.js'
import type { DriverId } from './families.js'

/**
 * WHAT `configure()` CAN CHANGE, ANSWERABLE FROM A DRIVER ID ALONE (POD-3087).
 *
 * ---------------------------------------------------------------------------
 * WHY A CLIENT NEEDS THIS AND CANNOT DERIVE IT
 * ---------------------------------------------------------------------------
 *
 * POD-3081 made model and effort really changeable on the three headless
 * drivers, and left the product unable to tell which sessions those are. The
 * nearest fact already on the wire is `Session.driverFamily`, and it is WRONG
 * for this question in a way that matters: `grok-acp` is family `server` and
 * declares `configure` for `permissionMode` ONLY — it sends no model on
 * `session/new` or on `session/prompt`, so there is nothing for a model change
 * to change. Gating a model picker on the family offers it on a session that can
 * only refuse, which is the same class of misreport the whole axis exists to
 * remove: a control that looks available and is not.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DERIVED AND NOT WRITTEN DOWN
 * ---------------------------------------------------------------------------
 *
 * Every value below is READ OUT OF THE DRIVER'S OWN `capabilities()`, the same
 * function the driver registers and the same one the conformance corpus holds it
 * to. A hand-kept table beside those declarations is the classic drift pair —
 * and this axis has already been burned by exactly that once, when the capability
 * catalogue described `configure` as announced on every driver while
 * `capabilities.ts` said the opposite on all four. A second copy would be a
 * third opinion.
 *
 * The map is TOTAL over `DriverId` (`satisfies` below), so a new driver is a
 * compile error here rather than a session that silently reports no configurable
 * fields — which would read to a client as "this harness cannot", the answer
 * that is safe for a picker and wrong for a bug report.
 */
const CONFIGURE_BY_DRIVER = {
  'codex-app-server': () => codexAppServerCapabilities().configure,
  'opencode-server': () => opencodeServerCapabilities().configure,
  'grok-acp': () => grokAcpCapabilities().configure,
  'claude-sdk': () => claudeSdkCapabilities().configure,
  /**
   * BOTH TERMINAL DRIVERS ANSWER `unsupported`, WITHOUT CONSULTING
   * `terminalCapabilities()` — and that is a deliberate exception to the
   * derive-it rule above, so it is worth saying why it is not a cheat.
   *
   * That factory takes a `TerminalCapabilityInput` describing the live session
   * (its send proof, whether composer-sync is running, whether the harness
   * reports a context percentage). Its `configure` axis reads NONE of them: a
   * TUI takes its model from argv at launch on every harness, so the answer is
   * constant across every input the factory accepts. Manufacturing a plausible
   * input here just to read a constant back out would be a fabricated call whose
   * arguments a reader would have to check against the real ones.
   *
   * The pairing is held by `configure-catalog.test.ts`, which calls the real
   * factory and asserts it still refuses — so if a terminal driver ever gains a
   * configure route, this line fails rather than quietly under-reporting it.
   */
  'claude-pty': () => TERMINAL_CONFIGURE,
  'generic-pty': () => TERMINAL_CONFIGURE,
  /** The in-memory reference driver. Present because the map is total; a fake
   *  that under-reported its own fields would weaken the corpus. */
  fake: () => FAKE_CONFIGURE,
} as const satisfies Record<DriverId, () => Declared<ConfigureCapability>>

/** @see CONFIGURE_BY_DRIVER — the constant the two terminal ids share. The
 *  reason travels because a client may want to TELL a person why the control is
 *  missing, and "changing it is a relaunch" is actionable where a blank is not. */
const TERMINAL_CONFIGURE: Declared<ConfigureCapability> = unsupported(
  'a TUI reads its model and effort from argv at launch; changing them is a relaunch',
)

/** Matches `createFakeDriver`'s declaration. Kept here rather than imported so
 *  the production catalog does not pull the test double into every consumer. */
const FAKE_CONFIGURE: Declared<ConfigureCapability> = supported({
  fields: ['model', 'effort'],
  effective: 'next-turn',
})

/**
 * The fields this driver's `configure()` accepts — EMPTY when it implements the
 * verb for nothing, which is the honest answer for a TUI.
 *
 * An unknown id also answers empty rather than throwing. A client asking "may I
 * offer this control" during a rolling upgrade, against a daemon reporting a
 * driver this build has never heard of, should hide the control and not crash;
 * hiding a control that would have worked costs one relaunch, and the totality
 * check above is what keeps that path unreachable for drivers we DO know.
 */
export function configureFieldsForDriver(driverId: string): readonly (keyof ConfigureRequest)[] {
  const lookup: Partial<Record<string, () => Declared<ConfigureCapability>>> = CONFIGURE_BY_DRIVER
  const declared = lookup[driverId]?.()
  return declared?.supported ? declared.value.fields : []
}
