/**
 * EVICT IS NOT A DELETION (POD-646, POD-1077, doc §3.1 ¶2 and §3.1.5).
 *
 * A row can leave your view without leaving the world: the authority unshares
 * it, and it disappears from the scoped feed WITHOUT its revision moving. If
 * that happens while you are LOOKING at the issue, the page has to go somewhere
 * — and everything it might naturally do is wrong:
 *
 *   - a deletion toast or a tombstone announces a deletion that did not happen;
 *   - a "this issue was removed" empty state says the same thing more politely;
 *   - a refetch-until-it-comes-back loop is the heal loop the doc forbids, and
 *     it never terminates because the row is not late, it is invisible.
 *
 * So the guard does exactly one thing: it navigates away, once, silently. The
 * board the user lands on is honest by construction — it shows what they can
 * see.
 *
 * -------------------------------------------------------------------------
 * WHY IT ARMS ON PRESENCE FIRST, WHICH IS THE WHOLE CORRECTNESS ARGUMENT.
 * -------------------------------------------------------------------------
 *
 * "Absent from the replica" is NOT enough to mean evicted. A page can legitimately
 * be rendered for an issue the replica does not hold — mid-bootstrap, in a test,
 * or from a link opened before the feed arrived — and treating that as an
 * eviction would bounce the user off a page that was about to work. So the guard
 * ARMS only after it has seen the issue PRESENT at least once; a row that was
 * never there cannot have left. That is also what keeps it from firing on the
 * first frame of a cold load, which is the failure a naive `if (!found) onBack()`
 * has.
 *
 * It fires AT MOST ONCE, tracked in a ref rather than state: a second call to
 * `onBack` after the surface has already changed is either a no-op or a second
 * navigation, and the second one is a bug that only shows up under a slow route
 * transition.
 *
 * It is deliberately indifferent to WHY the row went. `removed` and `evicted`
 * both mean "not on this page any more", and the page's response is the same
 * navigation either way — the difference matters to what is RENDERED about other
 * entities (see ./issue-edges.tsx), not to whether this page can stay open. Note
 * the deleted case never reaches here anyway: a soft-deleted issue keeps its row
 * and renders the restore banner.
 */
import { useEffect, useRef } from 'react'
import { type IssueViewModel, useReplicaIssues } from '@/app/store'

/**
 * Navigate away, once and silently, if the open issue leaves this principal's
 * view while the page is mounted.
 *
 * @param issue  the issue this page is rendering
 * @param onLeave what to do when it goes — the page passes its `onBack`
 */
export function useEvictionGuard(issue: IssueViewModel, onLeave: () => void): void {
  const issues = useReplicaIssues()
  const wasPresent = useRef(false)
  const fired = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `issue.id` is the SUBJECT of the re-arm, not a value the body reads — dropping it is what the rule suggests and it would make the effect fire once and never re-arm on navigation
  useEffect(() => {
    // A new issue id is a new subject: re-arm from scratch rather than carrying
    // the previous one's presence across a navigation.
    wasPresent.current = false
    fired.current = false
  }, [issue.id])

  useEffect(() => {
    const present = issues.some((row) => row.id === issue.id)
    if (present) {
      wasPresent.current = true
      return
    }
    // Never seen: not an eviction, and not our business (see the module note).
    if (!wasPresent.current || fired.current) return
    fired.current = true
    onLeave()
  }, [issues, issue.id, onLeave])
}
