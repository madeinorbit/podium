import { principalKeyPrefix } from '../replica/principal-storage'
import type { StorageApi } from '../replica/contract'

const ERASE_RETRIES = 10
const ERASE_RETRY_MS = 100

/** Storage adapters supply persistence; account policy owns the exact namespace to erase. */
export async function eraseAccountData(args: {
  principal: string
  basePrefix: string
  storage: StorageApi
  enumerateKeys(): string[]
  eraseEntities(principal: string): Promise<void>
  flush?(): Promise<void>
}): Promise<void> {
  const root = principalKeyPrefix(args.basePrefix, args.principal)
  const owned = (key: string) => key === root || key.startsWith(root + '.')
  // Another tab of the same browser may still be letting go of this account
  // when the erase starts (it is told by the same sign-out, POD-6292), and can
  // write one more key on its way out. Give it a moment, then fail closed.
  for (let attempt = 0; ; attempt++) {
    for (const key of args.enumerateKeys()) if (owned(key)) args.storage.removeItem(key)
    await args.eraseEntities(args.principal)
    await args.flush?.()
    if (!args.enumerateKeys().some(owned)) return
    if (attempt >= ERASE_RETRIES) throw new Error('principal settings could not be erased')
    await new Promise((resolve) => setTimeout(resolve, ERASE_RETRY_MS))
  }
}
