import { encodeJoin } from '@podium/runtime/join'
import { wssFrom } from '@podium/runtime/setup'

/** Where the one-line installer lives — `curl … | sh` fetches and runs it. */
const INSTALL = 'https://github.com/madeinorbit/podium/releases/latest/download/install.sh'

/**
 * Build the ready-to-paste join command for a new machine:
 *   curl -fsSL <install.sh> | sh -s -- --join <TOKEN>
 * The token embeds the instance's ws-ified `publicUrl` plus a freshly-minted
 * pairing code, so a single paste joins the machine to this server.
 *
 * Throws when no `publicUrl` is configured yet (setup not finished).
 */
export function buildJoinCommand(p: {
  publicUrl?: string
  pairCode: string
  name?: string
}): string {
  if (!p.publicUrl) {
    throw new Error('No public URL configured yet — finish setup (networking step) first.')
  }
  const token = encodeJoin({
    v: 1,
    serverUrl: wssFrom(p.publicUrl),
    pairCode: p.pairCode,
    ...(p.name ? { name: p.name } : {}),
  })
  return `curl -fsSL ${INSTALL} | sh -s -- --join ${token}`
}
