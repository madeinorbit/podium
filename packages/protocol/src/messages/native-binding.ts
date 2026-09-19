import { MachineIdField, UserIdField } from '@podium/model'
import { z } from 'zod'

/** Host-persisted receipt identity. A later incarnation or owner cannot consume it. */
export const NativeBindingReceipt = z.object({
  id: z.string().min(1),
  ownerId: UserIdField,
  machineId: MachineIdField.optional(),
  attemptId: z.string().nullable(),
  observerGeneration: z.number().int().nonnegative(),
})
export type NativeBindingReceipt = z.infer<typeof NativeBindingReceipt>
