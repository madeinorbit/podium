# @podium/server

Podium's API / web backend. **Hono + tRPC on a Node runtime.** Responsibilities: auth,
persistence, the cross-machine conversation index, and fanning requests out to machine
daemons. Exports the tRPC `AppRouter` *type*, which `apps/web` imports type-only.

Runs under Node (not Bun) so it shares a runtime with the PTY-touching daemon. Intended
runtime dependencies (added when implementation begins): `hono`, `@trpc/server`, `zod`,
plus a persistence layer (TBD as a product decision).
