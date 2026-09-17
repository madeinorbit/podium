/** Serialized JSON character budget shared by retained tool inputs.
 * JSON escaping counts toward this limit; this is not a UTF-8 byte limit. */
export const TOOL_INPUT_MAX = 24_000
export const TOOL_INPUT_TEXT_BUDGETS = [8_000, 2_400, 800, 240, 0] as const
