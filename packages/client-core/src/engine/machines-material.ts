/** Only audited reporting clocks are volatile. Never ignore a field by suffix:
 * revocation and harness history timestamps carry material information. Paths
 * are segment arrays so an unknown key containing dots cannot alias a clock. */
export const VOLATILE_MACHINE_PATHS: readonly (readonly string[])[] = [
  ['lastSeenAt'],
  ['buildReportedAt'],
  ['services', 'server', 'observedAt'],
  ['services', 'agentExecution', 'observedAt'],
]
const volatile = new Set(VOLATILE_MACHINE_PATHS.map((path) => JSON.stringify(path)))

/** JSON wire data only. Objects have stable key order; only machine membership
 * is unordered. Preserve nested array order and all unknown fields. */
export function machinesMaterialSignature(machines: readonly { id: string }[]): string | undefined {
  try {
    const canonical = (value: unknown, path: string[]): unknown => {
      if (Array.isArray(value)) return value.map((item) => canonical(item, [...path, '*']))
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.keys(value).sort()
            .filter((key) => !volatile.has(JSON.stringify([...path, key])))
            .map((key) => [key, canonical((value as Record<string, unknown>)[key], [...path, key])]),
        )
      }
      return value
    }
    return JSON.stringify(
      [...machines].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map((machine) => canonical(machine, [])),
    )
  } catch {
    // Malformed/non-JSON input must publish, and clear the prior comparison.
    return undefined
  }
}
