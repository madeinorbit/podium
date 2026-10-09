# Worklist field names

Naming proposal for POD-5822, based on `integrate/4286-pilot` at `ddc113ec4c59d438d9dc847867ef4f8bb7d085f8`. Prepared before changing code; accepted by the operator through POD-5708 on 2026-10-08, with the corrections below applied.

The desktop sidebar and phone Work tab use the same companion and shared issue. `issue.*` means a direct `IssueModel` read and deletion of the companion copy. A name beginning `visible` describes the subtree actually drawn after folding; the existing filing answers cover the retained subtree and are a different question. `self` means deletion of an adapter-only field, not a new property. Stored optional values keep their existing display defaults at the component read.

The three ports’ exhaustive contracts, their raw issue fallback, and the `standing`, `ownAttention`, `ownFacts`, `own`, and `label` bundles are covered below. Helper input interfaces may remain internal while components read the narrow fields directly. Lists contain models or IDs; components obtain companions at the read.

| Today’s name(s) | One proposed name / home | Question answered |
| --- | --- | --- |
| `sidebar.idNumber / row.seq / label.seq / own.seq` | `issue.seq` | Which issue number? |
| `sidebar.color / mobile.color` | `issue.color` | Which saved colour? |
| `sidebar.title / mobile.label / label.displayTitle / row.title` | `title` | Which title, including the named draft session? |
| `sidebar.timing / mobile.timing / rowTiming` | `timing` | Which visible phase and timer anchor? |
| `sidebar.working / mobile.working / rowWorking` | `visibleWorking` | Is any session in the visible subtree working? |
| `sidebar.asking / rowAsking` | `visibleAsking` | Does the visible subtree ask for attention? |
| `sidebar.originTick / mobile.originSeq / rowOriginTick` | `origin` | Which loaded spin-off origin is displayed? (Read origin.seq for its number.) |
| `sidebar.decision / mobile.decision / rowDecision` | `decision` | Which decision does this issue ask for? |
| `sidebar.mergeCommits` | `mergeCommits` | How many commits does the merge decision cover? |
| `sidebar.progress / mobile.progress / rowProgress` | `progress` | How many formal work units are in each state? |
| `sidebar.fromChildren / rowFromChildren` | `hasChildProgress` | Does progress come from formal descendants? |
| `sidebar.statusFromChildren / rowStatusFromChildren` | `showsChildProgress` | Does the root status show descendant progress? |
| `sidebar.gitState / mobile.gitState` | `issue.gitState` | What is the saved Git state? |
| `sidebar.unread / rowUnread` | `visibleUnread` | Is there unread activity in the visible subtree? |
| `mobile.unread / mobileUnread` | `emphasizeUnread` | Should unread activity be emphasized, including the quiet-draft exception? |
| `sidebar.errorClass / rowErrorClass` | `errorClass` | Which visible agent error should be shown? |
| `sidebar.internal / mobile.internal / rowInternal` | `issue.audience` | Who is this issue for? Compare to agent at the read. |
| `sidebar.awaitsTuck / mobile.tuckable / rowAwaitsTuck` | `canTuck` | Can this finished issue be tucked away? |
| `sidebar.canBringBack / rowCanBringBack` | `canBringBack` | Can the issue be returned from the fold? |
| `sidebar.unsnoozed / mobile.unsnoozed / rowUnsnoozed` | `returnedFromDefer` | Has the defer interval ended? |
| `sidebar.deferred / mobile.snoozed / rowDeferred` | `issue.deferred` | Is the defer interval still active? |
| `sidebar.draftAgentOnly / mobile.draftOnly / rowDraftAgentOnly` | `sessionOnlyDraft` | Is this draft represented by its agent session alone? |
| `sidebar.firstSessionId / rowFirstSessionId` | `firstSessionId` | Which own attention session comes first? |
| `sidebar.continuation / rowContinuation` | `continuation` | Where did this work continue, or which issue duplicates it? |
| `sidebar.fleet / mobile.fleet` | `visibleFleet` | Which agents are in the visible subtree? |
| `sidebar.issue / rowIssue / createIssuePort Proxy` | `issue` | Which shared issue is this row about? No second issue object. |
| `sidebar.sessions / mobile.sessions / rowSessions` | `sessions` | Which loaded own attention SessionModels belong to this row? |
| `sidebar.aggregateSessionIds` | `visibleSessionIds` | Which sessions belong to the visible subtree? |
| `sidebar.awaitingFirstPrompt / rowAwaitingFirstPrompt` | `awaitingFirstPrompt` | Is this session-only draft waiting for its first prompt? |
| `mobile.id / row.id` | `issue.id` | Which issue? |
| `mobile.kind` | `issue.entity` | Which entity kind? |
| `mobile.waitingCount / mobileWaitingCount` | `waitingCount` | How many visible attention items need a reply or decision? |
| worktree formatter `sessions.length` | `sessionCount` | How many live roster sessions are there? |
| worktree formatter `sessions.filter(isSessionWorking).length` | `workingCount` | How many roster sessions are executing? |
| `mobile.draftQuiet / mobileDraftQuiet` | `quietDraft` | Is the session-only draft still quiet? |
| `mobile.pinned / row.pinned / own.pinned` | `issue.pinned` | Is this issue pinned? |
| `mobile.branch` | `issue.branch` | Which saved branch? |
| `mobile.suppressAhead` | `decision` | Does a merge decision replace the ahead badge? Compare to merge at the read. |
| `mobile.attentionAction / mobileAttentionAction` | `attentionAction` | Which attention action is offered? |
| `mobile.navigation / mobileNavigation` | `navigation` | Which issue or session does pressing the row open? |
| `mobile.sidebar` | `self` | The formatter reads this companion directly; delete this adapter field. |
| `mobile.activityAt / rowActivityAt` | `visibleActivityAt` | When was this visible subtree last active? |
| `rowState / sidebar / mobile readiness` | `ready` | Is the drawing answer ready, LOADING, or absent? Preserve all three states. |
| `selected` | `selected` | Is this issue the worklist selection? |
| `selectionEvicted / evicted / seenSelected` | `selectionGone` | Did the sync replica evict the selected issue? |
| `foldLatch` | `selectedWasFolded` | Was the selected issue in the closed fold when selected? |
| `rowBelow` | `visibleChildIds` | Which immediate children are drawn below this issue? |
| `rowNested` | `visibleDescendantIds` | Which descendants are drawn below this issue? |
| `rowAggregate` | `visibleAttention` | What attention comes from the visible subtree? Narrow lazy fields on the attention helper. |
| `rowSeatActivity` | `visibleSessionActivity` | When were sessions in the visible subtree last active? |
| `rowParts` | `visibleParts` | Internal rollup policy input; no drawing component receives it. |
| `rowOwn` | `loadedIssue` | Has the issue payload loaded? Internal load boundary only. |
| `rowOrigin` | `loadedOrigin` | Has the origin payload loaded? Internal load boundary only. |
| `rowTip` | `continuationTip` | Which continuation tip applies to this closed issue? |
| `createIssuePort.id` | `issue.id` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.parentId` | `issue.parentId` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.seq` | `issue.seq` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.createdAt` | `issue.createdAt` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.updatedAt` | `issue.updatedAt` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.closedAt` | `issue.closedAt` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.deletedAt` | `issue.deletedAt` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.archived` | `issue.archived` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.stage` | `issue.stage` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.type` | `issue.type` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.closedReason` | `issue.closedReason` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.audience` | `issue.audience` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.isDraftVessel` | `issue.isDraftVessel` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.pinned` | `issue.pinned` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.sortKey` | `issue.sortKey` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.deferUntil` | `issue.deferUntil` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.tuckedAt` | `issue.tuckedAt` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.repoId` | `issue.repoId` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.repoPath` | `issue.repoPath` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.worktreePath` | `issue.worktreePath` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.coordinatorSessionId` | `issue.coordinatorSessionId` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.startedBySession` | `issue.startedBySession` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.deps` | `issue.deps` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.needsHuman` | `issue.needsHuman` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.blocked` | `issue.blocked` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.readAt` | `issue.readAt` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.title` | `issue.title` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.linearIdentifier` | `issue.linearIdentifier` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.color` | `issue.color` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.branch` | `issue.branch` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.parentBranch` | `issue.parentBranch` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.gitState` | `issue.gitState` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.intentOrigin` | `issue.intentOrigin` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.asked` | `issue.asked` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.supersededBy` | `issue.supersededBy` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.duplicateOf` | `issue.duplicateOf` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.displayRef` | `issue.displayRef` | Shared record fact; the Proxy fallback and row copy disappear. |
| `createIssuePort.unread` | `issue.unread` | The replica's unread activity after this user's cursor, including archived non-shell members. Reuse POD-5828's shared IssueModel answer; desktop and phone emphasis have separate fields. |
| `standing.excluded / standingExcluded` | `issue.excluded` | Shared record exclusion predicate. |
| `standing.finished / standingFinished` | `issue.finished` | Filing/presence rule, or shared record fact as named. |
| `standing.agent / standingAgent` | `issue.audience` | Filing/presence rule, or shared record fact as named. |
| `standing.activeHuman / standingActiveHuman` | `activeHuman` | Filing/presence rule, or shared record fact as named. |
| `standing.awaitingMerge / standingAwaitingMerge` | `issue.awaitingMerge` | Filing/presence rule, or shared record fact as named. |
| `standing.sessionless / standingSessionless` | `sessionless` | Filing/presence rule, or shared record fact as named. |
| `standing.rescuable / standingRescuable` | `rescuable` | Filing/presence rule, or shared record fact as named. |
| `standing.parentId / standingParentId` | `issue.parentRef` | Filing/presence rule, or shared record fact as named. |
| `standing.startedBy / standingStartedBy` | `startedBy` | Filing/presence rule, or shared record fact as named. |
| `standing.draftVessel / standingDraftVessel` | `issue.isDraftVessel` | Filing/presence rule, or shared record fact as named. |
| `standing.finishedMs / standingFinishedMs` | `issue.finishedMs` | Filing/presence rule, or shared record fact as named. |
| `standing.updatedMs / standingUpdatedMs` | `issue.updatedMs` | Filing/presence rule, or shared record fact as named. |
| `standing.replicaActivityMs / standingReplicaActivityMs` | `lastSessionActivity` | Filing/presence rule, or shared record fact as named. |
| `standing.headlessStaffed / standingHeadlessStaffed` | `issue.headlessStaffed` | Filing/presence rule, or shared record fact as named. |
| `standing.deleted / standingDeleted` | `issue.deletedAt` | Filing/presence rule, or shared record fact as named. |
| `standing.pinned / standingPinned` | `issue.pinned` | Filing/presence rule, or shared record fact as named. |
| `standing.formalParent / standingFormalParent` | `issue.formalParent` | Filing/presence rule, or shared record fact as named. |
| `own.band` | `band` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.repoKey` | `repoKey` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.closed` | `settledClosed` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.dismissed` | `settledDismissed` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.pinned` | `issue.pinned` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.sortKey` | `issue.sortKey` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.createdAt` | `issue.createdAt` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.seq` | `issue.seq` | Filing/order question; no copied own bundle handed to drawing code. |
| `own.foldAt` | `foldAt` | Filing/order question; no copied own bundle handed to drawing code. |
| `label.displayRef` | `issue.displayRef` | Use the shared label fact, or the draft-aware worklist title. |
| `label.displayTitle` | `title` | Use the shared label fact, or the draft-aware worklist title. |
| `label.seq` | `issue.seq` | Use the shared label fact, or the draft-aware worklist title. |
| `ownAttention.cold / ownAttentionCold` | `sessionsLoading` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.workingSince / ownAttentionWorkingSince` | `sessionsWorkingSince` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.firstSessionId / ownAttentionFirstSessionId` | `firstSessionId` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.sessionIds / ownAttentionSessionIds` | `attentionSessionIds` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.updatedAt / ownAttentionUpdatedAt` | `sessionsUpdatedAt` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.order / ownAttentionOrder` | `sessionOrder` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.decidingAt / ownAttentionDecidingAt` | `decisionAt` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.seated / ownAttentionSeated` | `hasSessions` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.working / ownAttentionWorking` | `sessionsWorking` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.deciding / ownAttentionDeciding` | `needsDecision` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.pending / ownAttentionPending` | `pendingSessions` | Attention of this issue’s own retained sessions, independent of descendant attention. |
| `ownAttention.railWaiting.open` | `waitingOpenSessions` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.railWaiting.finished` | `waitingFinishedSessions` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.railWaiting.decisions` | `waitingDecisions` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.open.waiting` | `openSessionsWaiting` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.open.working` | `openSessionsWorking` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.open.allDone` | `openSessionsDone` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.finished.waiting` | `finishedSessionsWaiting` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.finished.working` | `finishedSessionsWorking` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.finished.allDone` | `finishedSessionsDone` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.fleet` | `sessionFleet` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.working` | `workingTimer` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.waitingOpen` | `waitingOpenTimer` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.waitingFinished` | `waitingFinishedTimer` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.doneSince` | `sessionsDoneSince` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.totalMs` | `sessionsWorkingMs` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.errorClass` | `sessionErrorClass` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownAttention.sidebarFacts.allUnstarted` | `sessionsUnstarted` | Narrow own-session answer; delete the forwarding sub-bundle. |
| `ownFacts.state` | `issue.ownFacts.state` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.finished` | `issue.ownFacts.finished` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.decision` | `issue.ownFacts.decision` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.continuedByField` | `issue.ownFacts.continuedByField` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.updatedAt` | `issue.ownFacts.updatedAt` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.closedAt` | `issue.ownFacts.closedAt` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.coordinatorSessionId` | `issue.ownFacts.coordinatorSessionId` | Already answered by IssueModel; keep only the internal rollup interface, with direct reads. |
| `ownFacts.order / ownOrder` | `issueOrder` | Issue ordering tuple needed only by the worklist rollup. |

The own-session `workingTimer`, `waitingOpenTimer`, and `waitingFinishedTimer` answers are objects containing timer anchors (sinceMs/stateSince/baseMs), not bare timestamps. The accepted timer names therefore apply. The shared `issue.deferred` answer includes DEFER_NEXT_MESSAGE; this also keeps `issue.ready` false until that defer ends.
