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

## Publishing (off)

Both headless and desktop publication call `scripts/release-mirror.ts` after GitHub succeeds.
The helper does nothing unless **`PODIUM_PUBLISH_RELEASE_MIRROR=1`**. No workflow enables it.
Do not enable it until the bucket, custom domain, permissions and release inventory are ready.
This issue never runs an upload.

CI will need an R2 S3 API token restricted to object read/write on the release bucket, supplied
as secret `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, plus `PODIUM_RELEASE_R2_ENDPOINT`
(`https://<account-id>.r2.cloudflarestorage.com`) and `PODIUM_RELEASE_R2_BUCKET`. Install the
AWS CLI on the publishing runner before enabling the switch. These values belong in CI
configuration/secrets, never repository files or Podium's synced records.

Files are uploaded beneath the same tag paths, then stable files are copied to `latest/`.
Only artifact URL fields in mirror manifests are rebound to the mirror; signed payload bytes,
detached signatures, digests and notes are preserved. The mirror checksum inventory is
regenerated for those manifest copies. Discovery documents are uploaded after payloads.
The two publishers never delete each other's files. Retained desktop references must exist
on the mirror too before publishing a headless manifest that carries them forward.

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
