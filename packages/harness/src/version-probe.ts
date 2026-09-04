/**
 * One budget for every coding-agent `--version` probe.
 *
 * POD-2056 measured OpenCode at 11–15s on the build host and POD-2024 measured
 * Codex at 26s. Inventory and driver admission must observe the same boundary:
 * otherwise a binary can be absent to placement while drivable at spawn time.
 */
export const AGENT_VERSION_PROBE_TIMEOUT_MS = 60_000
