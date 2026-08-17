# First-run onboarding overhaul

## Delivery contract

This issue is the integration epic for Podium's complete first-run experience. Its branch and
worktree are the single review target: child work may be developed in isolated worktrees, but the
feature is not complete until every required lane is integrated and testable here.

The activation target is the first successful agent task, not merely saving server configuration or
registering a repository.

## Product decision

> **Superseded by POD-1174.** The revealed shell is gone: until setup finishes, setup is the only
> thing in the window — no sidebars, no dock, no rail, no status strip, and a command bar holding
> nothing but its drag region and the platform window buttons. There is no **Explore Podium** and no
> resume affordance, because every instrument in the shell reports on work that cannot exist yet and
> the escape hatch delivered people into an empty product they read as broken. Drafts and the exact
> step still survive a reload. Concept: `docs/design/POD-1174-onboarding-flow.html`.

~~Use a revealed-shell activation experience. Keep the real Podium navigation, work sidebar,
Settings, Help, connection health, and any existing work visible while onboarding occupies the
main empty stage. A persistent **Explore Podium** action leaves onboarding without marking it
complete, preserves progress and drafts, and exposes a clear resume affordance.~~

Reserve blocking setup for genuine safety or runtime prerequisites. Optional topology,
integrations, telemetry, and education must not stand between a normal local user and useful work.

## Complete journey

### Local macOS and source installs

For a normal all-in-one launch, infer the safe local mode and enter activation directly. Do not ask
the user to choose among server, daemon, client, or all-in-one topology before they understand the
product. Keep explicit advanced and headless server paths for users who need them, including their
reachability and authentication requirements.

The primary activation sequence is:

1. **Project** — ranked local suggestions, folder selection, optional GitHub CLI clone, and an
   advanced scan route.
2. **Agent** — show actual installation and authentication readiness; provide a focused recovery
   action when the chosen harness is not ready.
3. **First task** — use the production composer contract with project, agent, model, supported
   effort, context, and safe execution defaults. Complete activation only when the real task starts.

### Existing Podium

Offer a secondary route to connect this client or machine to an installation the user already runs.
Keep the flow inside activation, explain URL, authentication, and machine-role consequences, and
preserve the local project and task draft when users go back.

### Always-on VPS

Offer the benefit before the infrastructure: agents can continue when the laptop sleeps and Podium
can remain available from another device. On first-run onboarding, treat the fresh VPS as a new
all-in-one Podium authority rather than as a machine joining or replacing an already-configured
local server. Give the user one SSH command that installs Podium and supported agents, guides
reachability, login protection, and persistence, then verify its printed URL before changing the
desktop into a client. Server transfer remains a separate Settings workflow for established
installations.

### Mobile safety boundary

Mobile clients must not enter the normal operator data plane while a server is unconfigured or
activation is pending. The server, desktop web, mobile web, and native client must share an explicit
readiness contract such as `unconfigured`, `activation_pending`, `ready`, and `degraded`, with a
non-secret reason. Before readiness, expose only the narrow status/bootstrap surface and direct the
user to finish setup on the host; client-only gating is not a security boundary.

## GitHub decision

Use the existing GitHub CLI before considering a Podium-owned GitHub App. Detect whether `gh` is
installed and authenticated, list accessible repositories, choose a destination, clone locally, and
return to activation without Podium storing GitHub tokens.

Keep **Clone from GitHub** visible in missing and logged-out states. A missing-tool control should be
focusable with `aria-disabled`, explain the dependency, link to installation guidance, offer
**Check again**, refresh when the window regains focus, and preserve every onboarding selection and
draft throughout detection and authentication.

## Workstream map

- POD-865: activation shell and guided VPS lane, including shared machine setup primitives.
- POD-880: local-first setup inference and advanced/headless escape paths.
- POD-881: GitHub CLI project intake.
- POD-882: agent readiness and first-task composer.
- POD-883: existing-Podium connection route.
- POD-884: server-enforced mobile readiness boundary.
- POD-878: separate tracker safeguard preventing orphaned coordinators and outside-worktree artifacts.

## Acceptance

- A clean supported local install reaches Project, Agent, and First task without premature topology
  or remote-access configuration.
- A reload preserves the exact setup step and every draft (POD-1174 retired Explore Podium).
- Agent availability is truthful and recovery actions do not discard the prompt.
- The first task uses production catalogs and starts real work.
- GitHub CLI missing, logged-out, ready, refresh, and clone states are recoverable and accessible.
- Existing-Podium and VPS choices remain guided onboarding routes with a reliable return to local
  activation.
- VPS continuation survives restart and server-origin transfer without optimistic-write data loss.
- Mobile clients fail safely until server readiness is established.
- The integrated epic branch passes the repository-selected validation gates and is the artifact and
  runtime review target.

## Integrated review evidence

The complete product is integrated in this issue worktree as one test target. The implemented
journey now includes trusted local all-in-one defaults, the revealed and resumable activation
shell, local and GitHub CLI project intake, truthful agent readiness, the production model and
effort controls, duplicate-safe tracked-task creation followed by idempotent agent start,
existing-Podium client and joined-machine routes, direct fresh-VPS activation, and server-enforced
mobile readiness gating.

The final coordinator audit also exercised the seams between those workstreams rather than
accepting child completion reports independently. It closed the integration gaps found there:

- GitHub CLI recovery now refreshes automatically when the app regains focus, with missing,
  logged-out, ready, and draft-preserving recovery states.
- Remote desktop client/daemon mode consumes the public readiness fact without exposing remote
  setup mutations, so blocked servers direct users back to the host instead of opening an empty
  operator shell.
- Existing-Podium machine setup accepts the actual one-line pairing command, persists URL and join
  drafts, and retires the old activation URL before restart.
- Local project discovery restores the selected machine, repository source, browsed folder, scan
  results, and checkbox selection; successful repository registration clears that checkpoint.
- Fresh VPS activation is a direct two-step setup rather than a transfer: one inspectable command
  installs and configures a new authority, then the desktop verifies its readiness and connects as
  a client. No machine pairing number is involved.
- First-task activation creates one tracked issue, stores its identity, and retries an idempotent
  start command against that same issue. A partial launch failure therefore cannot create a second
  onboarding task.
- The activation presentation now gives the first-run stage the available width, starts new
  Flight Decks folded, uses structured action rows instead of squeezed cards, and keeps VPS
  recovery explicit with saved-pairing copy and an Explore path.
- The final polish uses the normal workspace sheet without a nested page surface, keeps Explore
  close to each route's content, preserves bottom breathing room while scrolling, and removes
  ordinary workspace controls from the focused agent-login terminal.

The final combined `bun run test` gate passed after the coordinator audit on 2026-08-15: 24 of 24
workspace typecheck tasks and 73 of 73 configured smoke tests passed. The required multi-instance
lane was also attempted by the local and mobile boundary workstreams. It reached independent
runtimes but then failed at
unrelated runner infrastructure points (a Bun 1.3.14/node-pty panic and non-deterministic lifecycle
request resets), tracked separately as POD-893 and POD-894; no workaround or weakened readiness
boundary was folded into this feature.

No browser-driving pass was added: the changed UI is ordinary component behavior covered by
hermetic tests, while the server, transfer, and lifecycle boundaries have focused contract tests.
This follows the repository rule that browser driving is reserved for effects only a real external
interaction can establish.
