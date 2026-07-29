# `ids/` — reserved (POD-360…363)

Branded ID types live here: `IssueId`, `SessionId`, `MachineId`, `RepoId`, `WorktreeId`, and
POD-1075's `UserId`. Empty today by design — POD-299 reserved the home so the branded-ID chain
lands as a first-class module instead of being wedged into the absorbed `@podium/domain` files.

A brand belongs here and nowhere else: the point of L0 is one definition site per identity.
