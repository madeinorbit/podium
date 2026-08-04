import { z } from 'zod'
import { UpdateTarget } from '../update/target'

/**
 * CONVERGENCE FRAMES — the server tells a machine to move, the machine says
 * where it got to.
 *
 * A daemon never converges on a version delta it noticed by itself. It converges
 * because it was granted permission, and only the server issues grants. That is
 * what makes waves possible: without it, every machine would move the instant a
 * new target was published.
 */

/** server -> daemon: you may converge to this target now. */
export const UpdateGrantMessage = z.object({
  type: z.literal('updateGrant'),
  /** Correlates the grant with the status reports it produces, across a restart. */
  grantId: z.string().min(1),
  target: UpdateTarget,
})
export type UpdateGrantMessage = z.infer<typeof UpdateGrantMessage>

/** Where a machine is, relative to its grant. */
export const CONVERGENCE_STATES = [
  'current',
  'granted',
  'downloading',
  'restarting',
  'rejected',
  'stuck',
] as const
export type ConvergenceState = (typeof CONVERGENCE_STATES)[number]

/**
 * daemon -> server: progress against a grant, or an unsolicited report on
 * reconnect. The machine identity comes from the authenticated transport, not
 * from this payload.
 */
export const UpdateStatusMessage = z.object({
  type: z.literal('updateStatus'),
  grantId: z.string().min(1).optional(),
  state: z.enum(CONVERGENCE_STATES),
  /** A label, never parsed or ordered as a semver. */
  version: z.string().min(1),
  /** Human-readable detail for rejected/stuck reports. */
  detail: z.string().optional(),
})
export type UpdateStatusMessage = z.infer<typeof UpdateStatusMessage>
