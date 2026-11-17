import { z } from 'zod'
import { CredentialIdField, MachineIdField, UserIdField } from '../ids'
import { HarnessAgent } from './agent'

/**
 * A CREDENTIAL AS A CLIENT SEES IT (credential management spec §4).
 *
 * The secret is never part of this record and there is no field that could
 * hold one: an unknown key is stripped on parse. `type` is a key into the
 * credential type registry (`CREDENTIAL_TYPES`), kept an open string so a
 * newer server's type still renders on an older client.
 */

export const CredentialStatus = z.enum(['ok', 'attention', 'revoked'])
export type CredentialStatus = z.infer<typeof CredentialStatus>

/** What the viewing person may do with it: own it, manage it, or only use it. */
export const CredentialAccess = z.enum(['owner', 'manage', 'use'])
export type CredentialAccess = z.infer<typeof CredentialAccess>

/** Non-secret facts about the provider account, for display and matching. */
export const CredentialIdentity = z.object({
  fingerprint: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  organisation: z.string().optional(),
  /** A display-only preview of a pasted secret (`sk-a…1234`); never the secret. */
  masked: z.string().optional(),
})
export type CredentialIdentity = z.infer<typeof CredentialIdentity>

/**
 * One harness home on one machine that holds this login, with its reported
 * login state. `removal-pending`: Podium was told to remove it and the machine
 * has not confirmed yet (spec §8 "cleanup").
 */
export const CredentialHome = z.object({
  machineId: MachineIdField,
  homeId: z.string(),
  state: z.enum(['in', 'out', 'unknown', 'removal-pending']),
})
export type CredentialHome = z.infer<typeof CredentialHome>

/** Who else may use or manage it: one person, or every member (spec §12). */
export const CredentialShare = z.object({
  grantee: z.union([z.literal('all-members'), z.object({ userId: UserIdField })]),
  verb: z.enum(['use', 'manage']),
})
export type CredentialShare = z.infer<typeof CredentialShare>

/** Owner-only observations and controls for a harness's own login directory. */
export const CredentialNativeLogin = z.object({
  harness: HarnessAgent,
  machines: z.array(
    z.object({
      id: MachineIdField,
      name: z.string(),
      state: z.enum(['in', 'out', 'unknown']),
    }),
  ),
  required: z.boolean(),
  useOnMyMachines: z.boolean().optional(),
  keptOn: z.array(z.object({ id: MachineIdField, name: z.string() })),
  attempt: z
    .object({
      sessionId: z.string(),
      machineId: MachineIdField,
      machineName: z.string(),
      status: z.enum(['running', 'refreshing', 'succeeded', 'failed']),
      error: z.string().optional(),
    })
    .optional(),
})

export const CredentialView = z.object({
  id: CredentialIdField,
  ownerUserId: UserIdField,
  label: z.string(),
  type: z.string().min(1),
  identity: CredentialIdentity,
  status: CredentialStatus,
  statusReason: z.string().optional(),
  /** ISO time until which the provider reported its usage limit reached. */
  limitReachedUntil: z.string().optional(),
  /** ISO time the secret stops working, for types that expire. */
  expiresAt: z.string().optional(),
  /** ISO time it was last shown to work. */
  verifiedAt: z.string().optional(),
  homes: z.array(CredentialHome),
  /** Machines the owner allowed beyond their own (spec §8). */
  allowedMachines: z.array(MachineIdField),
  sessionCount: z.number().int().nonnegative(),
  access: CredentialAccess,
  /** Its grants, for the owner and a holder of `manage` only; absent for `use`. */
  sharedWith: z.array(CredentialShare).optional(),
  nativeLogin: CredentialNativeLogin.optional(),
})
export type CredentialView = z.infer<typeof CredentialView>
