# Testing a stable release

What we test before tagging a stable release, who tests it, and what blocks the release.
How to cut the release itself is in [desktop-releases.md § Cut a release](desktop-releases.md#cut-a-release).

## What this covers, and what it does not

The operator and Till use the current build all day, so day-to-day features are well covered.
This procedure tests what daily use never touches: **setting Podium up from scratch** and
**updating from the previous stable release**.

| Platform | Tested here |
| --- | --- |
| Linux server (VPS) | Yes |
| macOS desktop app | Yes |
| iPhone app | Yes, on a physical phone, by the operator |
| Web app in a browser | Yes |
| Windows and Linux desktop apps | No |

## Roles

| Who | Does |
| --- | --- |
| Operator | Approves the plan, runs the phone checks, decides release or no release, pushes the stable tag. |
| Release coordinator (an agent) | Files the test issues, starts the testers, collects evidence, reports blockers. |
| Setup testers (agents) | Run the setup tests on the VPS lab, one tester per lab machine. |
| Upgrade tester (an agent) | Fills a previous-stable install with data and runs the update tests. |
| Click testers (agents) | Walk the release's headline features in the web app and in the macOS app. |

## Step 1. Prepare the candidate

1. The release notes are written under `## [Unreleased]` in `CHANGELOG.md` and approved by the
   operator.
2. `main` holds the candidate. Cut an **edge** build from it:
   `bun run release:cut X.Y.0-edge.1 --dry-run`, then without `--dry-run`. Wait until both release
   workflows are green.
3. Run the automated release checks once on the candidate commit, one at a time
   ([testing.md](agents/testing.md)):
   - `bun run test` (the lean gate)
   - `bun run test:full -- --full-because="release candidate X.Y.0-edge.1"`
4. File one issue for the release, with one sub-issue per test group below. Every result,
   screenshot and log goes onto the matching sub-issue as an artifact.

All tests below run against this edge build. An install of the previous stable release can switch
to it with `podium channel edge`, so every test runs on real published builds before the stable
tag exists.

## Step 2. Test data: a filled previous-stable install

No long-lived install stays on the previous stable release, so the upgrade tester builds one.
Select and claim a disposable box through the [VPS lab guide](../tools/vps-lab/README.md)
([testing guide](agents/testing.md#disposable-vps-lab)); preserve it for the update tests.

1. On a fresh lab machine, install the current stable release: `install.sh` installs stable by
   default.
2. Use it the way a real user would, until it holds at least:
   - two repositories, with tasks in several stages, phases, blockers and sub-tasks;
   - long sessions with several agents (Claude and Codex at least), including tool runs, mail
     between agents, compactions and attachments;
   - data that the new release migrates. Read the release's `Upgrading from` section and the new
     migrations (`git diff --name-status vPREV..candidate -- apps/server/src/migrations/drizzle`) and
     create rows that each one touches.
3. Record what was created (counts and a few named examples). The update tests compare against it.

## Step 3. Setup tests (VPS lab)

Each test starts from a clean lab machine and a Mac with no Podium installed. The VPS lab is the
set of disposable lab VPSs the operator names for the release (`vps1` and up); record the machines
used on the release issue.

The reusable startup scripts and prerequisites are in [`tools/vps-lab/`](../tools/vps-lab/README.md).
Run the lab on a Linux Docker host; obtain shared-host access and slot assignments from the
release issue. From a checkout on that host, run `tools/vps-lab/lab status`, claim `lab:vpsN`,
then use only your assigned slot. `lab up` recreates the fleet and `reset N` replaces a box;
do not use them over preserved test data. The
[testing guide](agents/testing.md#disposable-vps-lab) explains
when to choose this rig. Use this release's selected build, rather than the historical
`walk` runner's dev-channel defaults. Cloudflare quick tunnels need no separate credentials.

| ID | Test | Passes when |
| --- | --- | --- |
| S1 | **Linux server first, then the macOS app.** Install with `install.sh` on a clean VPS, expose it through cloudflared, download the DMG through a browser, open the app and connect to the server. | The app connects over HTTPS, sign-in works, the VPS shows as a machine, and an agent session answers a prompt. |
| S2 | **macOS first, then a VPS from onboarding.** Install the macOS app and choose to work on a VPS during onboarding. | Onboarding ends with a working server on the VPS, without manual steps it did not explain. |
| S3 | **Second machine joins.** Run the one-line join command on a fresh VPS against the S1 server. | The machine appears online and its first agent session reaches a real reply. Watch for agent first-run screens (theme, login, trust) silently blocking it. |
| S4 | **First agent run on a fresh machine.** Sign in to Claude and Codex. | Credentials carry over where Podium promises it, and each agent answers. |
| S5 | **Phone connects** to the S1 server through its cloudflared address. | The phone signs in and shows the same board. |
| S6 | **Setup goes wrong.** Interrupt setup halfway, run `install.sh` again over an existing install, enter a wrong server address. | Each case ends in a clear message or a working install, never a loop back to the welcome screen or a required restart. |

## Step 4. Update tests

Start from the filled install of Step 2, with a server on a VPS, the macOS app and a second
machine, all on the previous stable release. Keep two agents working while the update runs.

| ID | Test | Passes when |
| --- | --- | --- |
| U1 | **Whole fleet updates** from the update panel to the candidate. | A database backup file is written; every migration from Step 2 shows the expected result; every client reloads once; the working agents keep working; the update panel shows the release notes. |
| U2 | **macOS app updates itself** from the previous stable app to the candidate's app. | The installed app finds the update, installs it and restarts into the new version. CI's stable bridge check is switched off (`.github/workflows/release.yml`), so this manual test is the only proof. |
| U3 | **A machine is offline during the update** and comes back later. | It catches up on its own. |
| U4 | **The download is cut off mid-update.** | The update continues or rolls back cleanly, and the panel says which. |
| U5 | **Roll back** by restoring the backup, following the release's `Upgrading from` section. | The previous version runs on the restored data. |
| U6 | **Settings survive the update**, including usage reporting switched off. | Nothing the user switched off is switched back on. |

## Step 5. Click tests (web and macOS app)

A click tester walks every headline item of the release notes, once in a browser
([driving-podium.md](agents/driving-podium.md)) and once in the installed macOS app on the Mac
runner ([driving-desktop.md](agents/driving-desktop.md)). For each item it records a screenshot and
one line: works, or what is wrong. It also opens the update panel, Settings and the onboarding
screens in both light and dark.

## Step 6. Agent CLIs

Run `bun run test:smoke:agents` once on the candidate. It starts and resumes a real turn per
installed agent CLI and spends real credentials, so it runs only with the operator's yes. Add one
real task each for Claude and Codex in the S1 setup.

## Step 7. Phone (operator)

The operator installs the candidate's phone build and checks sign-in, the board, answering an
agent's question and starting a task. Packaging and device rules are in
[parity-release-proof.md](parity-release-proof.md) and [mobile-ios-release.md](mobile-ios-release.md).

## Step 8. Decide, release, confirm

1. Any failed setup or update test blocks the release. A failed click test blocks it only when the
   operator says so. Fixes land on `main` and the affected tests run again on a new edge build.
2. When everything passes and the operator approves, cut the stable release with
   `bun run release:cut X.Y.0`. It pushes the tag, which publishes the release, so it runs only
   on the operator's explicit go-ahead.
3. After the stable release is published, update one lab install of the previous stable release
   through the normal stable channel. This confirms the real stable path end to end.
