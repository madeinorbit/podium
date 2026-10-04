import {
  browserProfileMetadataStorage,
  createSingleServerAccounts,
} from '@podium/client-core/accounts'
import { mobileAccountEraser } from './account-data'

const instances = new Map<string, ReturnType<typeof createSingleServerAccounts>>()
export function mobileBrowserAccounts(
  origin: string,
  workspaceId?: string,
  workspaceSlug?: string,
) {
  const scope = JSON.stringify([origin, workspaceId ?? workspaceSlug ?? ''])
  let accounts = instances.get(scope)
  if (!accounts) {
    accounts = createSingleServerAccounts({
      httpOrigin: origin,
      metadataPrefix: `podium.accounts.mobile-web.${encodeURIComponent(scope)}`,
      storage: browserProfileMetadataStorage,
      erasePrincipal: mobileAccountEraser.erase,
    })
    instances.set(scope, accounts)
  }
  return accounts
}
