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
