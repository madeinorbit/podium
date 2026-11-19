import { z } from 'zod'

/**
 * THE SHARED-MACHINE WARNING (POD-6300; design §2.4, decision Q1).
 *
 * A machine runs every agent under its one operating-system account, so a
 * second person running there shares that account with the person who looks
 * after it. The same words are shown when someone is given `use` of another
 * person's machine, to that person before their first run there, and when they
 * send a connection to it.
 */
export const SHARED_MACHINE_ACCOUNT_WARNING =
  'Everyone who runs agents on this machine shares its operating-system account. ' +
  "Their agents and yours can read each other's files there, and any credentials " +
  'installed on it, including a connection you send to it.'

/** A shared member record. Email and account details come only from the admin list. */
export const MemberView = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable().optional(),
  role: z.string(),
  accountId: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  disabledAt: z.string().nullable().optional(),
})
export type MemberView = z.infer<typeof MemberView>

/** Synthetic key for a singleton request record in a principal-owned pool. */
export const RequestRecordKey = z.object({ id: z.string() })
