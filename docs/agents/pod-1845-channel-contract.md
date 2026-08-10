# Machine update authority

Podium has two deliberately separate channel concepts. The existing deployment channel remains `stable | edge`; it controls server installation, the legacy local updater, desktop updates, and feature visibility. A managed machine gains a distinct `dev | edge | stable` update authority selected centrally and persisted on that machine's fleet row.

## Channel contract

- `dev` resolves to the coordinating source server's exact signed git or bundle target. A bundle is trusted through the daemon's pairing-pinned server update key; a git target is an exact repository and commit selected by that same coordinator.
- `edge` and `stable` resolve to release descriptors and retain the baked release-feed public-key trust path. They do not accept a source-server bundle merely because the label changed.
- Central convergence compares exact target identity and may move in either version direction. The legacy `podium update` newer-only behavior is not the mechanism for managed-machine channel switches.
- The daemon never chooses or polls a development feed locally. The coordinator advertises one resolved target for the machine's selected authority and issues the grant.

## State and failure semantics

The persisted channel records operator intent, not convergence success. The fleet read model must expose both the selected channel and its resolved target state: available with a concrete descriptor/version, or unavailable with an actionable reason. In particular, selecting `stable` while the stable manifest is absent must show target unavailable and issue no grant; it must not present the stored label as a completed switch.

Changing authority must not drop pairing, machine identity, or the control connection. A grant is valid only for the channel and target under which it was issued, so a late status from a previous channel cannot complete or halt the newly selected channel. Existing global `stable | edge` configuration remains untouched by this state.

## Ownership boundaries

- POD-1837 owns exact source build identity after restart.
- POD-1838 owns development publisher and source-target production.
- POD-1842 owns an externally reachable authenticated development bundle URL.
- POD-1848 owns establishing the currently missing stable release manifest.
- POD-1845 owns the machine-scoped protocol, persistence, central mutation, read model, and operator UI.

## Scheduled real drive

The coordinator must schedule this drive; implementation work must not mutate Ludovico or Flatblock beforehand.

1. Confirm Flatblock is paired, centrally controlled, and reports its exact installed build; capture daemon/service identity and the current selected authority.
2. Resolve Ludovico's signed development target, select `dev`, grant convergence, and observe reconnect plus exact current target without reinstalling.
3. Resolve the edge release target, select `edge`, grant exact convergence even when it is a downgrade or the same installed version, and observe continued central control.
4. Resolve the stable release target after POD-1848, select `stable`, grant exact convergence, and observe reconnect/current.
5. Select `dev` again and repeat the signed source convergence, proving the release trust path did not strand or replace the paired daemon.
6. At every step record selected channel, descriptor delivery kind, signing authority, grant id, pre/post build identity, service continuity, and final fleet state.
