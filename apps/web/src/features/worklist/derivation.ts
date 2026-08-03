/**
 * THE WORKLIST DERIVATION, AS READ (POD-331, extracted POD-407).
 *
 * Its own module because THREE surfaces read it — the wide sidebar, the
 * collapsed rail, and the work hook — and the alternative was for two of them
 * to import it from the third. A shared type living inside one of its consumers
 * is how an import cycle starts.
 */

import { type WorklistSlice, worklistSlice } from '@podium/client-core/viewmodels'
import { useSlice } from '@/app/store'
/**
 * The worklist derivation, as READ rather than as COMPUTED (POD-331).
 *
 * This used to be a `useMemo` over `(repos, sessions, pins, issues, now)` whose
 * result every consumer had to be HANDED as a `derivationOverride` prop — and
 * whose absence, in any consumer that did not receive it, silently bought a
 * second execution of the identical derivation on a private clock. It is now a
 * read of the published `worklistSlice`: one derivation per snapshot however
 * many surfaces are looking, and one clock (`Store.coarseNow`) so two surfaces
 * cannot disagree about when "now" is.
 *
 * The type alias stays so the override-taking signatures below keep reading the
 * same way; the shape is the slice's.
 */
export type SidebarDerivation = WorklistSlice

export function useSidebarDerivation(): SidebarDerivation {
  return useSlice(worklistSlice)
}
