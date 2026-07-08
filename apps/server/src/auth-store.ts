// Moved to @podium/core (Phase 3 step 4): the client-access password store is
// shared by the server (auth-route) and the CLI setup flow. Re-exported here so
// apps/server import sites stay stable.
export * from '@podium/core/auth-store'
