/**
 * THE REACHABILITY VOCABULARY (POD-4534). `connect.check` asks Podium Connect to
 * probe a public URL from the outside and say precisely why it does not work;
 * these are the codes it can answer with, and the one human sentence each one
 * is shown as during setup.
 *
 * Pure strings, no IO — which is why this lives in @podium/runtime rather than
 * beside the signed HTTP client: the CLI setup flow (node-only) and, later, the
 * web setup screen (browser-safe, via `trpc.connect.check`) share the wording
 * without either dragging the other's transport along.
 */

export type CheckError =
  | 'INVALID_URL'
  | 'DNS_FAILED'
  | 'PRIVATE_ADDRESS'
  | 'REDIRECTED'
  | 'TLS_INVALID'
  | 'PORT_NOT_REACHABLE'
  | 'UNREACHABLE'
  | 'NOT_PODIUM'
  | 'IDENTITY_MISMATCH'
  /** Connect cannot probe this port. No opinion about the address's reachability. */
  | 'PORT_UNSUPPORTED'
  /** Connect itself could not be reached or refused the request. Never a failed check. */
  | 'CONNECT_UNAVAILABLE'

export type CheckResult =
  | { ok: true; url: string; resolvedTo: string[] }
  | { ok: false; error: CheckError; detail: string }

/**
 * One actionable sentence per code. A `Record` over the union — not a switch
 * with a default — so adding a code breaks the build until its sentence is
 * written here, and the cli-setup totality test fails the same way at runtime.
 *
 * Unavailable checks have no opinion about reachability. PORT_UNSUPPORTED is
 * displayed while the address is saved; CONNECT_UNAVAILABLE proceeds silently.
 */
export const CHECK_ERROR_SENTENCES: Record<CheckError, string> = {
  INVALID_URL:
    'That is not a usable URL — check for typos and paste the full address, starting with https://.',
  DNS_FAILED:
    'That hostname does not resolve to an address. If you just created the DNS record or ' +
    'Tailscale name, wait a minute for it to propagate and try again.',
  PRIVATE_ADDRESS:
    'That address is on a private network, so nothing on the outside can reach it. Paste the ' +
    'public address instead — your Tailscale funnel hostname or reverse-proxy URL.',
  REDIRECTED: 'That URL redirects somewhere else. Paste the final address it lands on instead.',
  TLS_INVALID:
    'The security certificate there is not valid (expired, self-signed, or issued for a ' +
    'different name). Browsers and machines will refuse to connect until it is fixed.',
  PORT_NOT_REACHABLE:
    'Nothing is listening on that port from the outside. Make sure the funnel or tunnel ' +
    'command is still running, and that no firewall or tailnet ACL blocks it.',
  UNREACHABLE:
    'Nothing answered at that address. The machine may be offline, or the tunnel or funnel ' +
    'has stopped.',
  NOT_PODIUM:
    'Something answered, but it is not Podium. Another service may be on that address, or ' +
    'the reverse proxy is pointing at the wrong port.',
  IDENTITY_MISMATCH:
    'That address serves a different Podium instance, not this one. Paste the URL of the ' +
    'machine you are setting up.',
  PORT_UNSUPPORTED:
    'Podium Connect could not check this port. Reachability from outside is unknown; ' +
    'you can still use this address.',
  CONNECT_UNAVAILABLE:
    'Podium Connect could not be reached, so the URL was not probed. Setup continues without the check.',
}

export function describeCheckError(error: CheckError): string {
  return CHECK_ERROR_SENTENCES[error]
}

/**
 * Older Connect deployments call their port restriction an invalid URL. Translate
 * only that refusal, for an explicit non-443 HTTPS port; other URL errors keep
 * their meaning. Apply at the transport and UI boundaries for mixed deployments.
 */
export function normalizeCheckResult(url: string, verdict: CheckResult): CheckResult {
  if (
    verdict.ok ||
    verdict.error !== 'INVALID_URL' ||
    verdict.detail?.trim() !== 'must be on port 443'
  ) {
    return verdict
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' && parsed.port && parsed.port !== '443') {
      return { ok: false, error: 'PORT_UNSUPPORTED', detail: '' }
    }
  } catch {
    // A malformed URL still needs correcting.
  }
  return verdict
}

export function isCheckUnavailable(verdict: CheckResult | undefined): boolean {
  return (
    verdict === undefined ||
    (!verdict.ok &&
      (verdict.error === 'CONNECT_UNAVAILABLE' || verdict.error === 'PORT_UNSUPPORTED'))
  )
}
