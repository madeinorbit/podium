# Plan — POD-1707 Login identity catalog (phase B)

Parent: POD-1659. Design: `docs/2026-08-04-cross-machine-login-catalog.md` §5, §6.2-6.3, §10. Depends on POD-1706.

## Problem

Settings shows harness logins for one machine and labels them "this machine" — because `accountViews()` calls `detectNative(homedir(), …)` against the server's own home (`apps/server/src/accounts.ts:89-93`). Meanwhile every daemon already ships its login state to the server in machine inventory (`packages/harness/src/inventory/build-inventory.ts:37`). The data crosses the wire; nothing aggregates it.

This phase builds the catalog. It changes no spawn behaviour — it is pure observability plus the schema that later phases need.

## 1. Declared login capabilities

Use the existing progressive-enhancement mechanism (`packages/harness/src/manifest.ts:40-80`). `Declared<T>` plus registry totality forces every harness to declare a capability or say `unsupported(reason)` out loud; the reason surfaces in `podium doctor` and degraded UI. Do not model these as optional fields — the header at :44-56 explains why that fails.

Add to `HarnessInventory` (`manifest.ts:170-180`), alongside the existing mandatory `detectLogin`:

```ts
loginIdentity: Declared<(homeDir: string) => LoginIdentity | undefined>
portableCredential: Declared<{
  files: readonly string[]
  compareFreshness(a: string, b: string): -1 | 0 | 1 | null
}>
```

`portableCredential` is declared here but **consumed only by POD-1708** — declaring it now keeps the manifest churn in one place.

Expected declarations: codex and claude-code supported; grok supported for identity if its credential carries one (check `manifests/grok.ts:93`), otherwise `unsupported`; cursor and opencode `unsupported` in one line each (their `detectLogin` already returns `'unknown'`).

## 2. Identity and freshness on HarnessLogin

Extend `HarnessLogin` (`manifest.ts:165`):

```ts
export interface HarnessLogin {
  state: 'in' | 'out' | 'unknown'
  account?: string                  // display string, unchanged
  identity?: LoginIdentity
  freshness?: number                // ordering only
}

export interface LoginIdentity {
  fingerprint: string               // NON-SECRET: sha256 of provider account id, else email
  email?: string
  providerAccountId?: string
  workspaceAccountId?: string
}
```

**This shape rides the inventory path to clients.** Nothing secret may go in it — no tokens, no raw JWTs. The fingerprint is a hash, and it exists so two machines holding the same account produce the same key.

Reference implementation for extraction: Orca's `src/main/codex-accounts/codex-auth-identity.ts`.

- `readIdentityFromAuthContents` — parses `tokens.id_token` as a JWT (base64url payload, no verification needed) and reads `email`, `chatgpt_account_id` / `tokens.account_id`, `workspace_account_id` from the `https://api.openai.com/auth` and `/profile` claim namespaces.
- `readFreshnessFromAuthContents` — `tokens.expires_at` → `exp` → `iat`, first one present wins.

Podium already has a small version of the JWT decode in `apps/server/src/codex-auth.ts:80-90` (`jwtExpMs`) — reuse or extend rather than adding a third copy.

claude-code reads `oauthAccount.emailAddress` from `~/.claude.json`, which `manifests/claude-code.ts:70-76` already parses for its display string.

## 3. Server-side catalog

Aggregate per-machine logins into a catalog **keyed by identity fingerprint, not by machine**. One entry per identity, listing the machines that hold it with each placement's state and freshness.

This keying is not cosmetic: it is what makes multi-account additive later (§10 of the design). A machine-keyed catalog would need a migration to support two logins per harness.

Then repoint `accountViews()` (`apps/server/src/accounts.ts:76-153`) at the catalog instead of `detectNative(homedir())`, so Settings shows "on vmi3407763, macbook". Keep the managed-account rows exactly as they are — this phase does not touch them.

## 4. Machine flag

Add `podiumManaged: boolean` to the machine record, plus the onboarding toggle beside the copy-paste join command (rewriting it as `--managed` / `--shared`). Default: managed for copy-paste onboarding, not-managed for the desktop app. Show a plain-language badge on the machine row.

Nothing consumes this until POD-1708 (propagation consent). It lands here because it rides the replicated machine record and adding it later is a migration.

## 5. Cheap-now, painful-later

Two more items in the same category — do not skip them:

- **Native account ids must be able to carry a fingerprint.** `native:codex` today, `native:codex:<fingerprint>` when a machine has two logins. `AccountIdField` (`packages/model/src/settings/preferences.ts:83`) is brand-only and already tolerates the longer form, and `''` already means "role default", so single-login setups are unaffected. Just do not write code that assumes the id has exactly two segments.
- **Record which identity a session used.** One field on the session. It is the only thing here that genuinely cannot be backfilled, and every future selection or quota policy needs the history.

## Secrets discipline

Credential bytes must never enter the replicated store or the settings blob — `apps/server/src/accounts.ts:72` already warns that settings round-trip to every client wholesale. This phase should not move credential bytes anywhere at all; it only reads them locally on each daemon to derive a non-secret identity.

## Tests

- Identity extraction: table-driven over auth-file fixtures — full ChatGPT login, API-key-only file (no identity claims, must yield `undefined` not a crash), missing `id_token`, corrupt JSON, and a claim-namespace variant.
- Freshness: `expires_at` present, only `exp`, only `iat`, none (must be `undefined`).
- Fingerprint stability: the same account on two machines produces the same fingerprint; different accounts differ.
- Catalog aggregation: two machines with one shared identity collapse to one entry with two placements; two distinct identities stay separate.
- Registry totality: the existing test at `packages/harness/src/registry.test.ts:79` pattern should be extended so every manifest declares the new capabilities.
- `accountViews()` reflects catalog machines rather than the local home.

Use the hermetic env helpers already used by `apps/server/src/accounts.test.ts` (it sets `CODEX_HOME` and a temp home) — do not read the real `~/.codex` in tests. `bun run typecheck` (trust cache hits) and `bun run test`.

## Definition of done

- Every harness manifest declares the new capabilities; cursor/opencode explicitly unsupported.
- Settings lists logins with the machines that hold them, not "this machine".
- Catalog is fingerprint-keyed and collapses one account across machines into one entry.
- `podiumManaged` on the machine record, settable at onboarding, visible on the machine row.
- Session records the identity it used; native account ids tolerate a fingerprint suffix.
- No spawn behaviour changed. No credential bytes moved.

## Out of scope

Propagation (POD-1708), managed homes, `CODEX_HOME` redirection, selection policy, harness install/update.
