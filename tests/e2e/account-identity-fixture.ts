/**
 * Seeded native-login identity for the settings browser suite (POD-4730).
 *
 * The suite's identity-label test must run identically on hosts with no native
 * logins (ludovico), hosts with short ones, and hosts with long ones
 * (flatblock) — so it reads no host state at all. serve-harness always records
 * this login for an isolated second machine, and the spec asserts on exactly
 * this address. ~99 characters, so the badge exercises the multi-line wrap
 * path that was red on flatblock.
 */

/** The seeded login's email — also the identity the Accounts hub renders. */
export const E2E_LONG_IDENTITY_EMAIL =
  'alexander.maximilian.mustermann+podium-settings-wrap@research.northwind-longcompanyname.example.com'

/** Isolated second machine carrying the seeded login (no daemon reports for it). */
export const E2E_IDENTITY_MACHINE_ID = 'e2e-identity'

/** Catalog fingerprint for the seeded login (never a real credential). */
export const E2E_IDENTITY_FINGERPRINT = 'e2e-account-identity-fixture'
