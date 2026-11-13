/**
 * STAND-IN for `CredentialId` until POD-6888 lands it in `@podium/model` (epic plan,
 * "Shared names": `CredentialId`, `asCredentialId`, `cred_<uuid>`). Same shape, so
 * the switch is an import change; delete this file then.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const CredentialId = z.string().min(1).brand<'CredentialId'>()
export type CredentialId = z.infer<typeof CredentialId>
export const asCredentialId = (s: string): CredentialId => s as CredentialId

/** A new id: `cred_<uuid>`, minted by the server, meaning nothing by itself. */
export const newCredentialId = (): CredentialId => asCredentialId(`cred_${randomUUID()}`)
