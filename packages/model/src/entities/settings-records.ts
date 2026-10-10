import { z } from 'zod'
import { MachineId } from '../ids/brands'
import { HarnessAgent } from './agent'

/** Public account discovery; credentials never enter this record. */
export const AccountView = z.object({
  id: z.string(), provider: z.string(), source: z.enum(['native', 'managed']),
  kind: z.enum(['api-key', 'oauth']).optional(), harness: HarnessAgent.optional(),
  identity: z.string().optional(), machines: z.array(z.string()).optional(),
  identityFingerprint: z.string().optional(), status: z.enum(['connected', 'not-configured', 'unknown']),
  serverAi: z.object({ machineId: MachineId.optional(), machineName: z.string().optional(), lastError: z.string().optional() }).optional(),
  credentialSource: z.enum(['stored', 'legacy']).optional(), loginRequired: z.boolean().optional(),
  loginMachines: z.array(z.object({ id: MachineId, name: z.string() })).optional(),
  loginAttempt: z.object({ sessionId: z.string(), machineId: MachineId, machineName: z.string(),
    status: z.enum(['running', 'refreshing', 'succeeded', 'failed']), error: z.string().optional() }).optional(),
})
export type AccountView = z.infer<typeof AccountView>

/** The public member directory response, including its account identity. */
export const MemberView = z.object({
  id: z.string(), displayName: z.string(), email: z.string().nullable(), role: z.string(),
  accountId: z.string().nullable().optional(), avatar: z.string().nullable().optional(),
  createdAt: z.string().optional(), disabledAt: z.string().nullable().optional(),
})
export type MemberView = z.infer<typeof MemberView>

/** Synthetic key for a singleton request record in a principal-owned pool. */
export const RequestRecordKey = z.object({ id: z.string() })
