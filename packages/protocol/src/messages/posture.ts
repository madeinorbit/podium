import { z } from 'zod'

/**
 * How far an agent goes without asking a person, in Podium's words (POD-6858,
 * docs/design/harness-session-posture.md §4.3). No harness vocabulary: each
 * adapter's posture section maps it onto its own flags.
 *
 * - `supervised`: asks before it edits or runs a command.
 * - `autonomous`: works without asking, inside the harness's own safety net.
 * - `{ native }`: a mode the person picked from that harness's own served
 *   list. Opaque to product code.
 *
 * Folder trust is not a field: every folder a Podium session runs in was
 * chosen in Podium, so it is always trusted.
 */
export const SessionPostureSchema = z.object({
  mode: z.union([z.enum(['supervised', 'autonomous']), z.object({ native: z.string().min(1) })]),
})
export type SessionPosture = z.infer<typeof SessionPostureSchema>

/** The posture a session gets when nobody chose one (operator decision 2). */
export const DEFAULT_SESSION_POSTURE: SessionPosture = { mode: 'autonomous' }
