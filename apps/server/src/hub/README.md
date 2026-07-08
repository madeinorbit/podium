# apps/server/src/hub/ — hub-only modules

The core/hub module boundary (docs/offline-sync-architecture.md §4,
docs/spec/node-hub-sync.md §2.4): code that only makes sense when this server
acts as a HUB — the rendezvous point other machines and nodes dial into
(inbound daemon pairing, fleet management, node provisioning) — lives here.
Everything else under `apps/server/src` is `core`: what a single-user node
needs, including DIALING an upstream hub (`upstream.ts` is core; *accepting*
new machines is hub).

**The rule: core never imports from `hub/`; nothing imports `cloud/`** (the
private SaaS module composes in at build time, never by path). Hub modules may
import core freely. The mapping and its exemptions — composition roots
(`server.ts`, `router.ts`, `index.ts`) and test files — are declared in
`../roles.ts`; this package's vitest suite (`import-boundary.ts` /
`import-boundary.test.ts`) enforces it.

Residents:

- `pairing.ts` — short-lived single-use pairing codes for new daemons. Core
  (`modules/machines/service.ts`) consumes it through the structural
  `PairingCodes` interface; server assembly injects a `PairingManager` only
  when the hub role is active.
- `machines-join.ts` — the copy-paste join command minted for a new machine.
