/**
 * SHARED HOOK FIELD READERS (POD-4472): the spelling-union accessors for hook
 * payloads, re-homed unchanged from the daemon's `hook-payload.ts`.
 *
 * Claude/Codex post snake_case; Grok Build native hooks post camelCase. These
 * readers accept both spellings for the core routing fields. They are generic
 * daemon services' tool — session-observers' per-session routing reads the
 * adapter's own codec (`adapters/<h>/instrumentation.ts`) instead — and they
 * name no harness: which spelling a harness posts is the adapter's knowledge.
 */
function record(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined
}

/** Claude/Codex use snake_case; Grok Build native hooks use camelCase. */
export function hookEventName(payload: unknown): string | undefined {
  const fields = record(payload)
  const value = fields?.hook_event_name ?? fields?.hookEventName
  return typeof value === 'string' ? value : undefined
}

/** Podium's Grok native hook install is the only managed camelCase producer. */
export function isGrokHookPayload(payload: unknown): boolean {
  return typeof record(payload)?.hookEventName === 'string'
}

export function hookBoolean(
  payload: unknown,
  snakeCase: string,
  camelCase: string,
): boolean | undefined {
  const fields = record(payload)
  const value = fields?.[snakeCase] ?? fields?.[camelCase]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read a string hook field under both its snake_case (Claude/Codex) and
 * camelCase (Grok Build native) spelling. The daemon's generic hook consumers
 * (`onHookPayload`, git-capture) route by these core fields — reading only
 * snake_case silently drops Grok's payloads, leaving Grok on its polling
 * observer instead of the hook channel. [spec:SP-79c5]
 */
export function hookString(
  payload: unknown,
  snakeCase: string,
  camelCase: string,
): string | undefined {
  const fields = record(payload)
  const value = fields?.[snakeCase] ?? fields?.[camelCase]
  return typeof value === 'string' ? value : undefined
}
