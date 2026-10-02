import { principalKeyPrefix } from '../replica/principal-storage'
import type { StorageApi } from '../replica/contract'

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
  for (const key of args.enumerateKeys()) {
    if (key === root || key.startsWith(root + '.')) args.storage.removeItem(key)
  }
  await args.eraseEntities(args.principal)
  await args.flush?.()
  if (args.enumerateKeys().some((key) => key === root || key.startsWith(root + '.')))
    throw new Error('principal settings could not be erased')
}
