/** Public, device-neutral guidance for the shared sign-in transport refusal. */
export const HTTPS_SIGN_IN_DOCS_URL =
  'https://github.com/madeinorbit/podium/blob/main/docs/adding-a-machine.md#https-for-sign-in'

export interface HttpsRequiredRefusal {
  error: 'https_required'
  message: string
  httpsUrl: string | null
  docsUrl: string
}

/** WHATWG URL is supplied by each client runtime; keep this package free of DOM types. */
declare const URL: {
  new (
    input: string,
  ): {
    protocol: string
    username: string
    password: string
    search: string
    hash: string
    href: string
  }
}

/** Only an operator-configured HTTPS address can become a sign-in destination. */
export function signInHttpsUrl(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/$/, '')
      : null
  } catch {
    return null
  }
}

export function httpsRequiredRefusal(publicUrl?: string | null): HttpsRequiredRefusal {
  const httpsUrl = signInHttpsUrl(publicUrl)
  return {
    error: 'https_required',
    message:
      'This server needs HTTPS for sign-in from other computers. ' +
      (httpsUrl
        ? `Open ${httpsUrl} and connect again. `
        : 'Ask the server admin for its HTTPS address, then connect again. ') +
      'If you administer this server, run podium setup to configure HTTPS with Tailscale Serve or a reverse proxy. ' +
      'Plain HTTP on localhost or 127.0.0.1 still works on the server itself.',
    httpsUrl,
    docsUrl: HTTPS_SIGN_IN_DOCS_URL,
  }
}

/** Older servers may send only the refusal code; keep the actionable fallback. */
export function readHttpsRequiredRefusal(body: unknown): HttpsRequiredRefusal | undefined {
  if (!body || typeof body !== 'object' || !('error' in body) || body.error !== 'https_required')
    return undefined
  const row = body as Record<string, unknown>
  const fallback = httpsRequiredRefusal(typeof row.httpsUrl === 'string' ? row.httpsUrl : null)
  return {
    ...fallback,
    ...(typeof row.message === 'string' && row.message.trim() ? { message: row.message } : {}),
  }
}
