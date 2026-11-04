import { z } from 'zod'
import { MachineId } from '../ids/brands'
import { HarnessAgent } from './agent'

/** Public account discovery; credentials never enter this record. */
export const AccountView = z.object({
  id: z.string(),
  provider: z.string(),
  source: z.enum(['native', 'managed']),
  kind: z.enum(['api-key', 'oauth']).optional(),
  harness: HarnessAgent.optional(),
  identity: z.string().optional(),
  machines: z.array(z.string()).optional(),
  identityFingerprint: z.string().optional(),
  status: z.enum(['connected', 'not-configured', 'unknown']),
  serverAi: z
    .object({
      machineId: MachineId.optional(),
      machineName: z.string().optional(),
      lastError: z.string().optional(),
    })
    .optional(),
  credentialSource: z.enum(['stored', 'legacy']).optional(),
  loginRequired: z.boolean().optional(),
  loginMachines: z.array(z.object({ id: MachineId, name: z.string() })).optional(),
  loginAttempt: z
    .object({
      sessionId: z.string(),
      machineId: MachineId,
      machineName: z.string(),
      status: z.enum(['running', 'refreshing', 'succeeded', 'failed']),
      error: z.string().optional(),
    })
    .optional(),
  /** A managed connection: the other people's machines its owner sent it to
   *  (POD-6300). It is used on the owner's own machines without being sent. */
  sentTo: z.array(z.object({ id: MachineId, name: z.string() })).optional(),
  /** A managed connection: the other people's machines its owner may run on
   *  (a `use` grant) and has not sent it to yet. */
  sendableTo: z.array(z.object({ id: MachineId, name: z.string() })).optional(),
  /** A native login with a known identity: the D11 box (POD-6301). True when
   *  its owner chose to copy and use it on every machine in their custody, now
   *  and in future; false when not (the default). Absent for other rows. */
  useOnMyMachines: z.boolean().optional(),
  /** The owner's machines where copying this login found a different login,
   *  which Podium kept in place (POD-6301). */
  keptOn: z.array(z.object({ id: MachineId, name: z.string() })).optional(),
})
export type AccountView = z.infer<typeof AccountView>

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

/** The public member directory response, including its account identity. */
export const MemberView = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  role: z.string(),
  accountId: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  disabledAt: z.string().nullable().optional(),
})
export type MemberView = z.infer<typeof MemberView>

/** Synthetic key for a singleton request record in a principal-owned pool. */
export const RequestRecordKey = z.object({ id: z.string() })
