/**
 * `@podium/agent-runtime` — the Agent Runtime contract (POD-1761).
 *
 * HOST CAPABILITY. Importing this barrel means taking the capability to drive
 * agent processes: the drivers behind this contract spawn PTYs, harness servers
 * and SDK worker children. The architecture manifest restricts this package's
 * consumers to the machine host (`apps/daemon`) and the build tier.
 *
 * Everyone else — `apps/server` above all — imports `@podium/agent-runtime/metadata`,
 * which carries FACTS ABOUT THE CONTRACT (its tiers, its families, its
 * permitted-failures table, its wire schemas) and no way to act on a host.
 */

export * from './contract.js'
export * from './fake-driver.js'
export * from './permitted-failures.js'
export * from './schemas.js'
export * from './tiers.js'
