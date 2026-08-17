# Updating a development instance

How to move a source-run Podium onto a new commit, and the three things that will stop you.
Written after moving `ludovico` onto the update-operations work (POD-2087).

## The normal path

A development server advertises **its own checkout's HEAD** as the update target. So an update
is offered when the checkout moves ahead of the process that is running:

1. Move the checkout forward (`git pull`, or a merge onto the branch it tracks).
2. The panel offers `Podium dev+<sha> is available`, listing the places it will touch.
3. Click **Update Podium**. Machines converge by git delivery, the coordinator restarts itself
   through `podium-redeploy.service`, and the operation is adopted by the successor process so
   the panel keeps showing one continuous update rather than a second dialog.
4. When the shared steps finish, the panel asks *you* to reload. That is the only step it
   cannot take for you.

Nothing else is required: an all-git fleet plans no package build at all.

## Three things that will stop you

**A dirty checkout publishes nothing.** The publisher refuses to advertise a target it cannot
reproduce, and *untracked files count*. Before this work landed the reason stayed in the
server log and the panel simply showed nothing; it now says so with the remedy in the
sentence. If the panel is silent, check `git status` first.

**A detached HEAD can never offer an update.** The target is the checkout's HEAD, so a pinned
HEAD cannot move ahead of the process and no future commit will ever be seen. Keep the
instance on a branch. This is easy to hit if the same branch is checked out in a second
worktree, because git will not have one branch in two places — remove the redundant worktree
rather than detaching the live one.

**Going backwards is refused, on purpose.** Once a newer build's migrations have run, the
older build cannot open the database. The daemon now checks that *before* fetching anything
and refuses with a named reason, leaving the machine running. That is the guard that stops a
downgrade bricking an install — but it means moving a dev instance forward is effectively
one-way without a database restore. See `docs/data-and-upgrades.md`.

## Bootstrapping onto a branch the running code predates

The updater cannot install the fix for its own inability to offer updates. If the running
build is older than the offer resolution, do the first hop by hand — clear the checkout, move
it onto the target commit, then `systemctl --user start podium-redeploy.service`, which
installs if needed, gates, and restarts server, daemon and janitor. Afterwards the panel takes
over.

## Checking it worked

`curl -s localhost:<port>/version` should show the new `appVersion` with **no `-dirty`
suffix**, and should carry a `target` — including a `schema.migrations` list, which is what the
downgrade guard reads. If `target` is absent, the publisher is refusing; the log says why.
