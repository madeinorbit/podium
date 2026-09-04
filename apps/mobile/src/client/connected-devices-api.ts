import { MobileClientSessionsResponse, type MobileClientSession } from '@podium/protocol'
import { fetchMobileTransport } from './trpc'

/**
 * Read the existing per-user device inventory. The server returns public
 * session metadata only; credentials and token hashes never leave it.
 */
export async function readConnectedDevices(
  httpOrigin: string,
  bearer: string | null,
  fetcher: typeof fetchMobileTransport = fetchMobileTransport,
): Promise<MobileClientSession[]> {
  const response = await fetcher(
    `${httpOrigin.replace(/\/+$/, '')}/auth/client-sessions`,
    { cache: 'no-store', headers: { accept: 'application/json' } },
    bearer,
  )
  if (!response.ok) throw new Error(`device inventory failed: ${response.status}`)
  return MobileClientSessionsResponse.parse(await response.json()).sessions
}
