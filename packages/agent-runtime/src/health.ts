// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { ScopeResources, SessionHealth } from './capabilities.js'

/**
 * Turn one supervisor-observed {@link ScopeResources} sample into the health a
 * driver reports (POD-2413).
 *
 * THE POINT IS THAT EVERY DRIVER ANSWERS THE SAME WAY. Before this, all four
 * production drivers hand-built a health object and all four hard-coded
 * `oomEvents: 0` — a number that read as "no OOM kills here" when it meant "we
 * never looked". A shared constructor makes the honest answer the easy one, and
 * a driver that gets no sample (macOS, a scope already collected, a session
 * whose pid we lost) still reports `oomEvents: 0` — but now that zero is a real
 * reading of a real counter for every session where one exists.
 *
 * `alive` stays the DRIVER's answer, never the sample's: a cgroup with
 * processes in it says nothing about whether the protocol link is usable, and
 * an OOM kill inside a session that is still serving must not read as death.
 */
export function sessionHealth(input: {
  alive: boolean
  resources?: ScopeResources | undefined
  /** Fallback when the sample carries no unit (macOS, unscoped spawn). */
  scopeUnit?: string | undefined
}): SessionHealth {
  const r = input.resources
  const scopeUnit = r?.scopeUnit ?? input.scopeUnit
  return {
    alive: input.alive,
    ...(r?.memoryBytes !== undefined ? { memoryBytes: r.memoryBytes } : {}),
    ...(r?.peakMemoryBytes !== undefined ? { peakMemoryBytes: r.peakMemoryBytes } : {}),
    ...(r?.swapBytes !== undefined ? { swapBytes: r.swapBytes } : {}),
    ...(r?.swapMaxBytes !== undefined ? { swapMaxBytes: r.swapMaxBytes } : {}),
    ...(r?.tasks !== undefined ? { tasks: r.tasks } : {}),
    ...(r?.tasksMax !== undefined ? { tasksMax: r.tasksMax } : {}),
    ...(r?.memoryMaxBytes !== undefined ? { memoryMaxBytes: r.memoryMaxBytes } : {}),
    ...(scopeUnit ? { scopeUnit } : {}),
    oomEvents: r?.oomKills ?? 0,
    ...(r?.throttleEvents !== undefined ? { throttleEvents: r.throttleEvents } : {}),
  }
}
