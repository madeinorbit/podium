/**
 * POD-7163 — the budgets every store and screen test runs with unless it says
 * otherwise (design POD-7157, "Testing rules").
 *
 * The phase's tests ran small fixtures under large caps, so eviction never ran
 * in an ordinary test and neither the deck losing its tree (POD-7155) nor the
 * install freeze (POD-7165) showed up in one. Tiny budgets make every fixture
 * larger than them: the unload and prune paths run in every test.
 *
 * - `warmInstances`: the warm set in memory, as a number of instances (POD-7161:
 *   2 instances' worth). The Replica takes it as its test hook
 *   (`memory.warmInstances`) in place of the policy's MB.
 * - `memoryBudgetMb`, `diskBudgetMb`, `diskMaxIdleDays`: the policy's fields,
 *   as the server sends them. POD-7162 makes the disk budget a few KB.
 *
 * A test that needs a large budget says so with `largeBudget(why)`, so the
 * exception is named where it is taken.
 */
export const TEST_BUDGETS = {
  warmInstances: 2,
  memoryBudgetMb: 1,
  diskBudgetMb: 1,
  diskMaxIdleDays: 30,
} as const

export type TestBudgets = {
  readonly warmInstances: number
  readonly memoryBudgetMb: number
  readonly diskBudgetMb: number
  readonly diskMaxIdleDays: number
}

/** The policy's part of the budgets: what a test server sends in its load header. */
export function policyBudgets(
  budgets: TestBudgets = TEST_BUDGETS,
): Pick<TestBudgets, 'memoryBudgetMb' | 'diskBudgetMb' | 'diskMaxIdleDays'> {
  return {
    memoryBudgetMb: budgets.memoryBudgetMb,
    diskBudgetMb: budgets.diskBudgetMb,
    diskMaxIdleDays: budgets.diskMaxIdleDays,
  }
}

/** A budget no fixture reaches, for a test whose subject is not eviction. Say why. */
export function largeBudget(why: string): TestBudgets {
  if (why.trim().length === 0) throw new Error('largeBudget: say why the test needs it')
  return {
    warmInstances: 1_000_000,
    memoryBudgetMb: 1_000_000,
    diskBudgetMb: 1_000_000,
    diskMaxIdleDays: 1_000_000,
  }
}
