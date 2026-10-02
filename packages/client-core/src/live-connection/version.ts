import { CLIENT_WIRE_VERSION, classifySkew, parseServerVersion, wireSchemaDigest } from '@podium/protocol'

/** Both app remedies start from the same handshake; an unreachable or malformed
 * /version is never evidence that an installed app should be replaced. */
export async function checkWireVersion(fetchVersion: () => Promise<unknown>) {
  let server: ReturnType<typeof parseServerVersion>
  try { server = parseServerVersion(await fetchVersion()) }
  catch { return null }
  return { server, verdict: classifySkew(server, { wire: CLIENT_WIRE_VERSION, digest: wireSchemaDigest() }) }
}
