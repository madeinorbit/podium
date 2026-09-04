/**
 * SAY IT ONCE, AND SAY WHICH ORIGIN.
 *
 * A deployment whose `allowedOrigins` is wrong fails silently from the server's
 * side: the CORS response simply carries no allow-origin header, and the socket
 * upgrade gets a bare 403. The browser reports both as a network error with no
 * server-side trace, so the operator has a UI that does not work and a log that
 * says nothing.
 *
 * This turns both refusals into one `warn` per distinct (reason, origin, host),
 * which is enough to diagnose a typo'd or missing entry from `fly logs` and
 * bounded enough that a page retrying — or a hostile one retrying deliberately —
 * cannot use the log as an amplifier. The predicates themselves stay pure; this
 * is what their callers hand to `onRefused`.
 */
export interface OriginRefusal {
  origin?: string | undefined
  host?: string | undefined
  reason: string
}

export function originRefusalReporter(
  warn: (message: string, fields: Record<string, unknown>) => void,
): (refusal: OriginRefusal) => void {
  const said = new Set<string>()
  return ({ origin, host, reason }) => {
    const key = `${reason}|${origin ?? ''}|${host ?? ''}`
    if (said.has(key)) return
    said.add(key)
    warn('cross-origin request refused', {
      ...(origin === undefined ? {} : { origin }),
      ...(host === undefined ? {} : { host }),
      reason,
    })
  }
}
