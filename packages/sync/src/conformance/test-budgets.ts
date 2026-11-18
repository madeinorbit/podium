/**
 * POD-7163 — the budgets every store and screen test runs with unless it says
 * otherwise (design POD-7157, "Testing rules").
 *
 * The phase's tests ran small fixtures under large caps, so the trim never ran
 * in an ordinary test and neither the deck losing its tree (POD-7155) nor the
 * install freeze (POD-7165) showed up in one. Tiny budgets make every fixture
 * larger than them: the trim, unload and prune paths run in every test.
 *
 * - `cacheCap`: records the device keeps beyond what is held (until POD-7161
 *   replaces it with the warm set's budget, 2 instances in tests).
 * - POD-7161 adds the warm set (`warmInstances: 2`) here; POD-7162 the disk
 *   budget (a few KB). Every fixture that reads these picks them up.
 *
 * A test that needs a large budget says so with `largeBudget(why)`, so the
 * exception is named where it is taken.
 */
export const TEST_BUDGETS = {
  cacheCap: 10,
} as const

export type TestBudgets = { readonly cacheCap: number }

/** A budget no fixture reaches, for a test whose subject is not eviction. Say why. */
export function largeBudget(why: string): TestBudgets {
  if (why.trim().length === 0) throw new Error('largeBudget: say why the test needs it')
  return { cacheCap: 1_000_000 }
}
