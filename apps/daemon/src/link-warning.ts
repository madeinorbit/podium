/**
 * THE DAEMON'S OWN WORD ON AN UNENCRYPTED SERVER ADDRESS (credential
 * management §8).
 *
 * The server judges every connection itself and sends no credentials over a
 * plain one; this only tells the person reading the daemon's log why, and that
 * such a connection stops being accepted after the removal date. It decides
 * nothing.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]'])

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/** The warning for a `ws://`/`http://` address on another computer, else undefined. */
export function plainRemoteServerWarning(serverUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'http:') return undefined
  if (isLoopbackHost(url.hostname)) return undefined
  return (
    `The connection to ${serverUrl} is not encrypted and leaves this computer, so the server ` +
    'sends no credentials to this machine. Podium stops accepting such connections after ' +
    'February 2027. Use a wss:// address, or ask an admin to trust this network.'
  )
}
