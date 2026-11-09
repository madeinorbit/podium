# Release origins

`packages/runtime/src/release-origins.ts` owns release addressing, fallback and transport trust.
Its adjacent JSON policy is also consumed by the native desktop adapter and the generated
installer policy. GitHub always goes first. `https://releases.podium.do/` is the public R2
mirror; set `mirrorReadEnabled` to false in the policy to disable fallback everywhere.
Successful origins are remembered only in process memory, without changing priority. An
unavailable mirror is attempted once and cooled down for one minute; no background retries run.

Paths are `download/<tag>/`, `download/edge/`, `download/dev/`, and `latest/`. GitHub alone
maps `latest/` to its `latest/download/` route. A manifest and any required companion are
read from one origin. Absolute artifact references must name that same origin; relative
references start at the release root. Signatures and digest verification remain mandatory.

## Publishing

Both OSS publisher workflows map the bucket-scoped Actions secrets
`PODIUM_RELEASE_R2_ACCESS_KEY_ID` and `PODIUM_RELEASE_R2_SECRET_ACCESS_KEY` to
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The public repository variables are
`PODIUM_RELEASE_R2_ENDPOINT`, `PODIUM_RELEASE_R2_BUCKET` and the explicit opt-in
`PODIUM_PUBLISH_RELEASE_MIRROR=1`. The runner checks credentials and provides the AWS CLI
with `scripts/setup-release-mirror.sh`. No credentials belong in source or synced data.

After a headless candidate has passed its preparation/acceptance gates, GitHub and R2
publication are attempted independently; failures remain visible in the job result. Desktop
mirror publication likewise requires its validated inventory, and still runs if the GitHub
upload step fails. Earlier candidate requirements (including the required desktop half)
remain fail-closed; an unavailable inventory is never permission to omit files.

Files use the same release paths, with stable copied to `latest/`. Only artifact URL fields
are rebound; payload bytes, signatures, digests and notes are preserved. Mirror checksums
are regenerated. Payloads precede discovery documents and installer aliases switch last.
The publishers never delete the other publisher's files.

### Initial inventory and recovery

The existing `release.yml` workflow has a `mirror_backfill` dispatch input. Select `all`,
`stable`, `edge` or `dev` to copy existing published releases without building or mutating a
GitHub release; normal dispatches use `off`. This job explicitly opts into R2 publication,
uses a read-only GitHub token, and leaves the global publishing switch unchanged.

The backfill downloads the complete current inventory plus every older artifact referenced
by a carried-forward manifest. GitHub asset size/digest checks, the baked headless Ed25519
key, and the desktop minisign key all have to pass before the first R2 write. Legacy rolling
headless names are frozen under digest names in the mirror documents, while fixed installer
aliases remain available. The installer comes from the reviewed workflow checkout. All
referenced tags receive their payloads before any manifest; historical objects cannot
promote themselves to `latest/`, and the selected stable inventory is promoted last.

The job then uses the real shared release fetcher and artifact delivery code with GitHub
responses deliberately forced to fail. It checks public artifact availability, downloads a
signed Linux payload through R2 and confirms that an invalid signature still fails closed.
The copied-channel report is retained as the `release-mirror-backfill` workflow artifact.
Only enable routine publication after this inventory and public verification succeed.

## Native and bootstrap adapters

The desktop reads the canonical policy JSON directly through `release-origins.rs`, uses the
ordered endpoints with a five-second timeout per endpoint, and validates each document before
Tauri parses it. Its config has no endpoint literals; the runtime builder supplies them.
Tauri still verifies minisign signatures. Artifact redirects use each origin's exact host set.

Run `bun scripts/render-release-origins.ts` after changing policy. The marked block in
`install.sh` is generated, not a second editable address list, and a focused test checks it.
The bootstrap retries the payload/signature pair together, then verifies before extracting or
running anything. Join and VPS commands fetch `install.sh` from the same ordered origin list.

The remaining independent GitHub paths in `scripts/docker-update-e2e/{real-release-lane.sh,
server-lane.sh,edge-feed.ts}` and `scripts/verify-stable-bridge-candidate.ts` are build/verification
fixtures: they emulate or validate published GitHub releases, including historical clients.
`scripts/carry-forward-desktop-manifest.ts` uses GitHub API release routes for publication
inventory, not a runtime download origin. Repository homepage/issue links, historical docs,
release-note links and test fixtures are not release-file fetchers. Headless and desktop
publication now obtain their artifact URLs and trust fence from the shared module as well.
`scripts/verify-published-headless-update.sh` and the publishers retain GitHub repository
identifiers for the `gh` CLI; those are publication inventory, not runtime origin policy.

The API declaration builder skips JSON assets when emitting declarations, and the module's
public `ReleaseOrigin` interface keeps client declarations independent of the JSON file.
Both cases have focused regression coverage. On hosts with only BusyBox wget, the installer
obtains curl through its existing prerequisite step so it can validate redirects before
following them.
