import type { WorkspaceIdentity } from '../types'

/** A link already issued by a server, whose plaintext token was never stored. */
export type LegacyLink = {
  id: string
  tokenHash: string
  createdBy: string
  createdAt: Date
  expiresAt: Date
} & (
  | { kind: 'invitation'; memberId: string | null; role: 'admin' | 'member'; email: string | null }
  | { kind: 'password-reset'; accountId: string }
)

export const legacyLinkImport = Symbol('legacy link import')

export interface LegacyLinkImporter {
  [legacyLinkImport](link: LegacyLink): Promise<boolean>
}

/** Import a legacy hash through the workspace transaction. No token is minted. */
export async function importLegacyLink(
  workspace: WorkspaceIdentity,
  link: LegacyLink,
): Promise<boolean> {
  const operations: Partial<LegacyLinkImporter> & WorkspaceIdentity['memberships'] =
    workspace.memberships
  const importLink = operations[legacyLinkImport]
  if (!importLink) throw new Error('identity: this workspace does not support legacy link import')
  return await importLink(link)
}
