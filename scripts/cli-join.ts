import { saveConfig } from '../packages/core/src/config'
import { decodeJoin } from '../packages/core/src/join'

/** Decode a join token and persist a daemon config. Returns the resolved machine name. */
export function applyJoinToken(token: string): { name: string } {
  const p = decodeJoin(token)
  saveConfig({ mode: 'daemon', serverUrl: p.serverUrl, pairCode: p.pairCode })
  return { name: p.name ?? 'this machine' }
}
