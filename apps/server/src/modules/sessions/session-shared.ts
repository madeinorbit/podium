/**
 * The one constant genuinely shared by the session modules (POD-1396).
 *
 * WHY THIS FILE IS THIS SMALL. It briefly held `SessionSpawnResult` too, which
 * was wrong: a representation's home is the module that PRODUCES it, and that
 * is `session-start.ts`. POD-302's representation registry caught the mistake —
 * it names a declaration SITE, and after the extraction the registered site was
 * `lifecycle.ts`, which by then only re-exported. A re-export is not a
 * declaration.
 *
 * `DEFAULT_GEOMETRY` genuinely belongs here and not with either owner: it is a
 * VALUE read by `session-start.ts` (the spawn frame), `lifecycle.ts` (the
 * headless port) and `relay.ts`. Putting it on `session-start.ts` would have
 * been the same mistake in the other direction — a shared constant filed under
 * one of its three consumers. `lifecycle.ts` re-exports it so `relay.ts` is
 * unaffected.
 */

import type { Geometry } from '@podium/model'

/** The geometry a session is born with, before any client reports a real one. */
export const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }
