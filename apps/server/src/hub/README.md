# apps/server/src/hub/ — hub-only modules

The core/hub module boundary (docs/spec/node-hub-sync.md §2.4, the architecture's
"day one rule"): code that only makes sense when this server acts as a HUB for
other machines/nodes (pairing, fleet management, node provisioning) lives here.

**The rule: core (`apps/server/src/*` outside this folder) never imports from
`hub/`.** Hub modules may import core freely. Enforced by a unit test — see
`import-boundary.ts` / `import-boundary.test.ts` — not a linter plugin.

Status: `PairingManager` (`../pairing.ts`) is the natural first resident, but it
is currently constructed inside `relay.ts` (core — `SessionRegistry.pairing`,
used by `authenticateDaemon`), so moving the file today would itself create the
core→hub import this folder forbids. The move is a follow-on: inject the
pairing manager into the registry from server assembly, then relocate the file.
