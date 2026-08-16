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
 *
 * A FRAME IS ALSO A HEARTBEAT (POD-2101, spec §3.3). The same shape is sent
 * repeatedly while one phase is still running, carrying how far it has got, so
 * that "moving" and "stuck" are distinguishable by the server rather than
 * guessed by whoever is watching. `percent` and `phaseDetail` are ADDITIVE and
 * optional in both directions: a daemon that predates them sends neither and
 * still converges, and a server that predates them ignores both.
 */
export const UpdateStatusMessage = z.object({
  type: z.literal('updateStatus'),
  grantId: z.string().min(1).optional(),
  state: z.enum(CONVERGENCE_STATES),
  /** A label, never parsed or ordered as a semver. */
  version: z.string().min(1),
  /** Human-readable detail for rejected/stuck reports. */
  detail: z.string().optional(),
  /**
   * How far the current phase has got, when the delivery can measure it at all.
   * Integer percent: a download of unknown length reports its phase without one
   * rather than inventing a denominator.
   */
  percent: z.number().int().min(0).max(100).optional(),
  /**
   * The phase within the state, as a short machine string (`downloading`,
   * `git-fetch`, `git-checkout`). It names WHAT is taking the time; `detail` is
   * still the sentence a human reads.
   */
  phaseDetail: z.string().min(1).optional(),
})
export type UpdateStatusMessage = z.infer<typeof UpdateStatusMessage>
