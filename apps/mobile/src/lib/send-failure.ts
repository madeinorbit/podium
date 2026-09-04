/**
 * A failed send names its reason on the row (POD-346) — but a transport-level
 * failure has no reason a person can use. When the server is wedged or
 * restarting (the VPS watchdog kill, POD-1607-adjacent), the reply is empty or
 * an HTML error page, and the tRPC client surfaces the literal parser noise:
 * "JSON Parse error: Unexpected end of input". That string on a red bubble
 * reads as an app bug and says nothing about what to do.
 *
 * Recognize the transport class — unparsable replies, dead connections,
 * gateway errors — and speak to the situation instead. Anything else (a real
 * server-worded refusal, a policy error) passes through untouched: those
 * messages were written to be shown.
 */
const TRANSPORT_NOISE =
  /JSON Parse error|Unexpected end of (?:input|JSON)|Unexpected token|Failed to fetch|Network request failed|Load failed|fetch failed|socket hang up|ECONNREFUSED|ECONNRESET|Bad Gateway|502|503|504/i

export function humanizeSendFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (TRANSPORT_NOISE.test(raw)) {
    return 'The server did not answer — it may be busy or restarting. Nothing was sent; try again in a moment.'
  }
  return raw
}
