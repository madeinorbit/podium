# Credential Management Implementation Plan

> **For agentic workers:** this epic runs as Podium sub-issues, one session per task. This
> document fixes what tasks share: names, signatures, files, order, and what each task must
> show to be accepted. Each session reads the spec and its own task block, then writes its own
> step-by-step plan (superpowers:writing-plans) before touching code.

**Goal:** One place where Podium holds a person's access to AI providers and hands it to
sessions and direct model calls, with several subscriptions per harness per machine, sign-in
with ChatGPT, credential switching, sharing, and a per-person notification inbox.

**Architecture:** A credential is a record with a type. Harness adapters and direct-inference
routes declare which types they accept and how each is delivered. One resolver on the server
turns (consumer, credential, acting person, machine) into a delivery plan or a refusal. Secrets
held by Podium are encrypted at rest and cross to a daemon only over an encrypted connection; subscription
logins stay in a per-login harness home on the machine.

**Tech stack:** Bun, TypeScript, zod models (`packages/model`), Drizzle on SQLite
(`apps/server/src/store`), command contracts (`packages/commands`), daemon control messages
(`packages/protocol`), harness adapters (`packages/harness`), React + MobX web, Expo mobile.

**Spec:** `docs/superpowers/specs/2026-11-12-credential-management-design.md`. Section numbers
below (§) refer to it.

## Global constraints

- Every use of a credential goes through the resolver (§3 R1). No task adds a second way to
  read a secret.
- A secret never appears in a client-visible record, a log line, a daemon journal, a queued
  command, an event, or a test fixture committed to the repo.
- Podium-held secrets are written to the database only through `Vault.seal`.
- A vault secret reaches a daemon only in the `access` field of a message that starts a
  process, only when the server itself classified that daemon's connection as `encrypted`,
  `local` or `trusted` (§8), and only when the daemon advertised `sessionAccess`. An older
  daemon or a plain connection gets a refusal, never a launch on a different login.
- The server decides what kind of connection a daemon is on. Nothing a daemon says about its
  own connection is used.
- A vault secret is delivered, and a home is created, only on machines the credential's owner
  holds custody of or has sent that credential to (§8).
- The resolver's result never contains a secret. Only `attachAccess` and `withSecret` read one
  from the vault.
- Commands that add, renew, remove or share a credential are refused for agent principals.
- A chosen credential that cannot be used is refused. No path falls back to another login.
- A subscription login lives in one home per machine. No task reads a login file out of a
  home. The only exception is the existing propagation path, which is not changed.
- Refusals are the closed list in `ACCESS_REFUSAL_MESSAGES`. A task that needs a new one adds
  it there with its sentence.
- Server reads and writes follow `docs/agents/server-data.md`; client data follows
  `docs/agents/frontend-data.md`.
- **Tests do not run on the host where the sessions run** (operator order, 2026-11-12). Run
  lanes with `remote-lane <host> <issue> run <cmd>` on one of the test hosts named in the
  task brief.
- New server test files go into the shard manifest by regenerating it. Generated files
  (protocol golden fixtures, Drizzle snapshots, the shard manifest) are regenerated after every
  rebase, never merged by hand.
- Anything a person will see in the UI is driven by its implementer on a real instance before
  it is offered for review, with screenshots attached to the task.
- Real provider logins: never sign out of, replace or rotate the operator's existing logins.
  Sign-ins for measurements and drives happen in new homes, by the operator.

## Code with a removal date

Compatibility code in this epic carries the repository's marker on the line above it, in this
exact form: `// LEGACY(remove-after: YYYY-MM): <what it is for; what removing it drops>`
(AGENTS.md, "Legacy code with a removal date"). There are three kinds and no others. A task
that believes it needs a fourth mails the coordinator first.

| Code | Task | Marker | Header text |
|---|---|---|---|
| Accepting a plain `ws` daemon connection from another computer | 23 | `2027-02` | `accepts a plain ws daemon connection from another computer so local-network installs survive the upgrade; removing it refuses such a daemon at connect` |
| `credentialIdFromLegacy`, and reading the old `accountId` field on sessions, settings and the wire | 3, 12 | `2027-02` | `reads account ids written before credentials existed; removing it stops old spellings from resolving` |
| The one-time move of old keys into the vault, the destruction of the old values, and the emptied `accounts` table | 2, 4, 21 | `2027-05` | `moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table` |

Each marked piece is written so that removal is deleting it: the behaviour that remains
afterwards exists and is tested now.

## How a task is accepted

Every task block ends with a numbered **Acceptance** list. A task is accepted when:

1. Every numbered item has evidence: a named test that passes on a remote lane, or an attached
   artifact (screenshot, transcript, report). "It works" without one is not evidence.
2. The lean gate (`bun run test`) is green on a remote lane on the branch rebased onto the tip
   of the integration branch, together with the specialised lane the task names. Measurement
   and review tasks (6, 7, 19, 20) change no product code and skip this.
3. `bunx biome check` is clean on the files the task changed.
4. A test that searches for a planted secret uses an obviously fake value and first proves the
   search can find it (a canary), so that an empty result means something.
5. A name under "Shared names" that the task had to change is changed here in the same commit.
6. The report mailed to POD-6857 lists each acceptance number with its evidence.

The coordinator checks each number against the evidence, then closes the task or mails back
the numbers that are not met.

## Review focus

Conditions the spec implies and no single task's tests would otherwise cover. Each is pinned
by the acceptance item named with it.

1. **A daemon older than this epic receives a Podium-held credential.** It must refuse with
   `daemon-too-old`; the session must not start on the machine's own login. Task 5, item 1.
2. **A credential is removed or loses its grant while sessions run on it.** Running sessions
   are flagged; the next launch, revival or call refuses with the reason; nothing crashes.
   Task 13, item 6; Task 4, item 3.
3. **Two renewals of one ChatGPT sign-in start at once** (two requests, or a restart
   mid-renew). Exactly one token set is stored; the other caller reads it. Task 14, item 6.
4. **Old values after upgrade**: `''`, `native:claude-code`, `native:codex:<fingerprint>`,
   `managed:anthropic`, `managed:claude-oauth` in settings and on stored sessions resolve to
   the same login or key they meant before. Task 3, item 3.
5. **The person signs in to a home with a different account than the credential names.** The
   home is bound to the identity that was actually signed in, and the mismatch is shown, not
   hidden. Task 9, item 3.
6. **The key that protects stored secrets is missing** (restored database, lost file). The
   server starts; affected credentials read "needs attention"; nothing else fails; no new key
   silently replaces the old one. Task 2, item 5.
7. **A person runs their own credential on a machine someone else holds custody of.** Refused with
   `machine-not-allowed` until the owner allows that machine for that credential. Task 3,
   item 6.
8. **The server moves to another machine.** Stored credentials open on the new server, the old
   server keeps no way into the vault, and the key is in no journal or staging file. Task 22,
   items 1 and 3.
9. **Podium's own upgrade snapshot still holds an old key.** After the upgrade no retained
   snapshot in the state directory contains it and each is still a sound database. Task 21,
   item 3.

## How the epic runs

- **Integration branch:** `issue/6857-inference-credential-management`, cut from `dev/mw`.
  Every task is created with `--parent-branch` set to it. A task that is ready rebases onto
  its tip; the coordinator fast-forwards it in. The epic lands on `dev/mw` once, at the end.
- **Coordinator:** the session on POD-6857. Tasks report by issue mail to POD-6857.
- **Agents:** tasks start on Claude Code with Opus 5.5 at effort high. The security review
  (Task 20) runs on Pi with `opencode-go/deepseek-v4.1-flash`. Operator, 2026-11-12.
- **Lanes:** every session runs on one host; at most three implementer sessions at once, two
  when memory there is high. Tests run only on the remote test hosts.
- **Base tag:** `credential-epic-base` marks the commit every task branch must contain.
- **Order:** three phases. Inside a phase, tasks start as soon as the tasks they wait on are
  closed (table at the end).

## Shared names

Tasks use these exactly. A task that must change one changes it here in the same commit.

```ts
// packages/model/src/ids — CredentialId, asCredentialId, CredentialIdField ('cred_<uuid>')

// packages/model/src/credentials/types.ts
type CredentialTypeId =
  | 'anthropic.api-key' | 'anthropic.claude-login' | 'anthropic.claude-token'
  | 'openai.api-key' | 'openai.chatgpt-login' | 'openai.chatgpt-plan'
  | 'openrouter.api-key'
interface CredentialTypeSpec {
  id: CredentialTypeId; provider: string; title: string
  store: 'vault' | 'home'
  renewal?: 'none' | 'expires' | 'podium'      // vault types only
  obtain: readonly ('paste' | 'harness-sign-in' | 'found-on-machine' | 'oauth' | 'issued')[]
  sharing: 'free' | 'warn'
  revocation: 'none' | 'sign-out' | 'provider-call'   // what removal does at the provider
}
const CREDENTIAL_TYPES: Readonly<Record<CredentialTypeId, CredentialTypeSpec>>

// packages/model/src/credentials/accepts.ts
type Delivery = { kind: 'env'; variable: string } | { kind: 'home' }
interface AcceptedCredential { type: CredentialTypeId; deliver: Delivery; drivers?: readonly string[] }
type InferenceRoute =
  | { kind: 'http'; api: 'anthropic-messages' | 'openai-chat' | 'openai-responses'; base?: 'openrouter' }
  | { kind: 'on-machine'; api: 'openai-responses' }
  | { kind: 'harness-one-shot'; harness: HarnessAgent }
const INFERENCE_ROUTES: Readonly<Partial<Record<CredentialTypeId, InferenceRoute>>>

// packages/model/src/entities/credential.ts — CredentialView (what a client sees)
//   id, ownerUserId, label, type, identity{fingerprint?,email?,plan?,organisation?},
//   status 'ok'|'attention'|'revoked', statusReason?, limitReachedUntil?, expiresAt?,
//   verifiedAt?, homes[{machineId,homeId,state 'in'|'out'|'unknown'}], allowedMachines[],
//   sessionCount, access 'owner'|'manage'|'use'; timestamps are ISO strings; type is an open string

// packages/harness — HarnessInventory.accepts: readonly AcceptedCredential[]
//   harnessAccepts(kind), harnessHideFromCommands(kind) from '@podium/harness/metadata'
//   HarnessInventory.hideFromCommands?: HideFromCommands { env?: Record<string,string>; args?: string[] }
//   HarnessDescriptorWire.accepts: HarnessDescriptorAcceptWire[] (open strings: type, deliver.kind,
//     deliver.variable?, drivers?); absent on the wire parses as []
// packages/model/src/credentials — also CREDENTIAL_TYPE_IDS, isCredentialTypeId,
//   acceptsProblems({ types, routes, consumers }) (the matching check)

// packages/runtime/src/vault-key.ts — usable by the server and by a daemon in a transfer
resolveVaultKeyPath(env: NodeJS.ProcessEnv, instance: string): string
//   $PODIUM_VAULT_KEY_FILE, else $XDG_CONFIG_HOME/podium/vault-<instance>.key,
//   else ~/.config/podium/vault-<instance>.key
interface KeyProvider { readonly keyId: string; wrap(k: Buffer): Promise<Buffer>; unwrap(w: Buffer): Promise<Buffer> }
fileKeyProvider(path: string): Promise<KeyProvider>           // creates the file 0600 on first use
readWrappedDataKey(db: SqlDatabase): { keyId: string; wrapped: Buffer } | null
writeWrappedDataKey(db: SqlDatabase, provider: KeyProvider, dataKey: Buffer): Promise<void>
vaultCheckValue(dataKey: Buffer, transferId: string): string  // HMAC-SHA256, hex

// apps/server/src/modules/credentials/vault.ts — the store's vault is `store.vault`
type SecretBinding = { credentialId: string; type: string; version: number }
type SealedSecret = { ciphertext: Buffer; nonce: Buffer; keyId: string }   // keyId: the data key's id
class Vault { seal(bound: SecretBinding, plaintext: Buffer): Promise<SealedSecret>  // async: the first seal creates the data key
              open(bound: SecretBinding, sealed: SealedSecret): Buffer
              state(): 'ready' | 'empty' | 'locked'             // locked: a data key exists and cannot be opened
              status(): { keyPath; keyId: string | null; state; problem: string | null }
              canOpen(dataKeyId: string): boolean
              reset(): Promise<CredentialId[]>                  // vault.reset; returns the credentials now 'attention'
              exportDataKey(): Buffer | null }                  // Task 22 only
// deps: { credentials: CredentialsRepository; vault: Vault } — a SessionStore satisfies it
withSecret<T>(deps, credentialId: CredentialId, use: (secret: string) => Promise<T>): Promise<T>
//   rejects with SecretUnavailableError { reason: 'not-found' | 'revoked' | 'no-secret' | 'needs-attention' }
sealCredentialSecret(deps, credential: { id; type }, plaintext: string, expectedVersion: number):
  Promise<number | 'conflict'>                                  // seals as expectedVersion + 1, then putSecret
// admin-only: query vault.status, command vault.reset { confirm: true }; CLI `podium vault status|reset --confirm`

// apps/server/src/store/credentials.ts — CredentialsRepository
//   insert, get, listVisibleTo(userId), rename, setStatus, findByIdentity,
//   findByLegacyId(accountsId), findByLegacyKey(ownerUserId, key),
//   remove(id)            // deletes the secrets, leaves the record as 'revoked', hidden from lists
//   putSecret(id, sealed, expectedVersion) → version | 'conflict'   (expectedVersion 0: no secret yet)
//   latestSecret(id) → { version, sealed, openable } | null       (openable false: vault locked or reset)
//   insert({ id?, ownerUserId, label, type, identity?, expiresAt?, legacyId?, legacyKey? }) → CredentialRecord
//   findByIdentity({ ownerUserId, type, fingerprint }), listVisibleTo(userId): own, not revoked
//   recordPlacement, listPlacements, setPlacementState,
//   allowMachine, disallowMachine, isMachineAllowed
// apps/server/src/modules/credentials/events.ts
// writes `settings_audit_events` (command `credentials.<kind>`); deps: { settingsAudit } — a SessionStore
recordCredentialEvent(deps, i: { kind: 'add' | 'rename' | 'renew' | 'remove' | 'share' | 'unshare'
  | 'deliver' | 'switch' | 'refuse' | 'attention'; credentialId: CredentialId | null
  actorUserId: UserId; sessionId?: SessionId; machineId?: MachineId; detail?: string }): Promise<void>

// apps/server/src/modules/credentials/may-use.ts
mayUse(userId: UserId, credential: { id: CredentialId; ownerUserId: UserId }):
  Promise<'owner' | 'manage' | 'use' | null>

// apps/server/src/modules/credentials/access.ts
type AccessRefusal = 'not-found' | 'not-yours' | 'wrong-type' | 'not-on-this-machine'
  | 'machine-not-allowed' | 'own-credential-required' | 'needs-attention' | 'revoked'
  | 'daemon-too-old' | 'connection-not-encrypted'
const ACCESS_REFUSAL_MESSAGES: Record<AccessRefusal, string> = {
  'not-found': 'This credential no longer exists.',
  'not-yours': 'You do not have use of this credential. Ask its owner to share it.',
  'wrong-type': 'This kind of credential cannot be used here.',
  'not-on-this-machine': 'This login is not signed in on this machine. Sign in there, or pick another machine.',
  'machine-not-allowed': "This credential's owner has not sent it to this machine.",
  'own-credential-required': "The logins on this machine belong to the person who looks after it. Pick one of your own credentials.",
  'needs-attention': 'This credential needs attention before it can be used. Renew it or pick another.',
  'revoked': 'This credential was removed.',
  'daemon-too-old': 'Podium on this machine is too old to receive credentials. Update it.',
  'connection-not-encrypted': "This machine's connection to the server is not encrypted, so credentials are not sent to it. Connect it over wss or declare its network trusted.",
}
type SessionAccess =
  | { ok: true; credentialId: CredentialId | null
      delivery: { kind: 'env'; variable: string } | { kind: 'home'; homeId: string } }
  | { ok: false; refusal: AccessRefusal; message: string }
resolveSessionAccess(i: { harness: AgentKind; driverId?: string; credentialId: CredentialId | null
  actingUserId: UserId; machineId: MachineId }): Promise<SessionAccess>
resolveInferenceAccess(i: { credentialId: CredentialId; actingUserId: UserId }): Promise<
  | { ok: true; credentialId: CredentialId; route: InferenceRoute; machineId?: MachineId }
  | { ok: false; refusal: AccessRefusal; message: string }>
// homeId 'default' is the harness's own directory. credentialId null resolves to
// { ok: true, credentialId: null, delivery: { kind: 'home', homeId: 'default' } }.
// apps/server/src/modules/credentials/legacy-ids.ts
credentialIdFromLegacy(accountId: string, ownerUserId: UserId): Promise<CredentialId | null>
// "custody": the machine grant with verb 'manage' and custody=1 (multi-user design §2.4).
// Admin rights over a machine are not custody.

// apps/server/src/gateway/daemon-link-kind.ts
type DaemonLinkKind = 'encrypted' | 'local' | 'trusted' | 'plain'
classifyDaemonLink(i: { url: string; forwardedProto?: string; hasProxyHeaders: boolean
  clientAddress: string | undefined; trustedProxyHops: number; trustedNetworks: readonly string[] }): DaemonLinkKind
// per server, on the registry (a module-level function would share state between servers):
registry.daemonLinks.daemonLinkKind(machineId: MachineId): DaemonLinkKind | undefined  // undefined: not connected
// instance setting daemonLink.trustedNetworks: string[] (CIDR ranges, admin person only, never an agent)
// client-visible: linkKind?: DaemonLinkKind on the machine.condition topic payload
//   (MachineConditionPayload; connection state, like `online`), read as MachineModel.linkKind
// packages/model: parseCidr, cidrContains, CidrRange, CIDR_RANGE_MESSAGE

// apps/server/src/modules/credentials/attach-access.ts
attachAccess(plan: SessionAccess, to: { machineId: MachineId; sessionId: SessionId }): Promise<
  | { ok: true; access?: AccessField } | { ok: false; refusal: AccessRefusal; message: string }>

// packages/protocol
//   AccessField = { credentialId: string
//     delivery: { kind: 'env'; variable: string; secret: string } | { kind: 'home'; homeId: string } }
//   carried as `access?: AccessField` on SpawnMessage, the headless turn request and engine start,
//   and in sessionAccessRefresh { sessionId, access } (server → daemon after a reconnect);
//   every message type that can carry it is excluded from logging by type
//   daemon capability sessionAccess: 1
//   AgentInventory.logins?: { homeId: string; state; identity?; freshness? }[]
//   homeEnsureRequest/Result, homeRemoveRequest/Result, oauthLoopbackRequest/Result
//   server transfer promote request: vaultDataKey?: string | null ; promote result: vaultCheck?: string

// packages/commands/src/credentials/contracts.ts
//   credentials.add | rename | renew | remove | share | unshare | allowMachine | disallowMachine
//   credentials.signInStart({ type, machineId, label }) → { credentialId, terminalSessionId }
//   credentials.chatgptSignInStart | chatgptSignInComplete ; query credentials.list
// packages/commands/src/sessions
//   sessions.switchCredential({ sessionId, credentialId | null, whenBusy: 'wait' | 'interrupt' })
//     → { continuedAs: 'resume' | 'handoff' | 'next-wake' }
// session record: credentialId, effectiveAuth { method: 'api-key' | 'subscription' | 'token'
//   | 'unknown'; fingerprint? }, credentialMismatch?
// personal setting credentialDefaults: Partial<Record<HarnessAgent, CredentialId>>
// CLI: --credential <label | id | none> on `podium agent spawn`, `podium issue start`,
//   `podium issue add-session`

// apps/server/src/modules/credentials/placements.ts
removePlacement(placement: { credentialId; machineId; kind: 'home' | 'propagated-file' }): Promise<'removed' | 'pending'>

// apps/server/src/modules/inference/complete.ts
complete(deps, i: { credentialId?: CredentialId; role?: RoleName; model?: string
  messages: LlmMessage[]; tools?: LlmTool[]; actingUserId: UserId }):
  Promise<{ text: string; toolCalls: ToolCall[]; servedBy: CredentialId; label: string }>

// apps/server/src/modules/notices/emit.ts
emitNotice(i: { recipientUserId: UserId; kind: NoticeKind
  subject: { kind: EntityKind; id: string; anchor?: string }
  title: string; body?: string; dedupeKey: string }): Promise<void>
resolveNotices(dedupeKey: string): Promise<void>
type NoticeKind = 'mention' | 'credential-attention' | 'credential-shared'
```

The seven types (§5):

| Type | Provider | Store | Renewal | Obtain | Sharing | Revocation |
|---|---|---|---|---|---|---|
| `anthropic.api-key` | anthropic | vault | none | paste | free | none |
| `anthropic.claude-token` | anthropic | vault | expires | paste | warn | none |
| `anthropic.claude-login` | anthropic | home | | harness-sign-in, found-on-machine | warn | sign-out |
| `openai.api-key` | openai | vault | none | paste | free | none |
| `openai.chatgpt-login` | openai | home | | harness-sign-in, found-on-machine | warn | sign-out |
| `openai.chatgpt-plan` | openai | vault | podium | oauth | warn | provider-call |
| `openrouter.api-key` | openrouter | vault | none | paste | free | none |

Direct-inference routes (§5): `anthropic.api-key` → http `anthropic-messages`;
`openai.api-key` → http `openai-chat`; `openrouter.api-key` → http `openai-chat`, base
`openrouter`; `openai.chatgpt-login` → on-machine `openai-responses`; `openai.chatgpt-plan` →
http `openai-responses`; `anthropic.claude-login` → harness-one-shot `claude-code`, declared by
Task 12 only if measurement S5 passed.

---

## Phase 1: Foundation

### Task 1: Credential types and matching

**Issue:** POD-6888. **Spec:** §4, §5.

**Goal:** One registry of credential types, and on every harness adapter the list of types it
accepts and how each is delivered. Nothing behaves differently after this task; it gives every
later task one vocabulary.

**Owns:** `packages/model/src/credentials/` (new), `packages/model/src/ids` (CredentialId),
`packages/model/src/entities/credential.ts` (new), `packages/harness/src/manifest.ts`
(`accepts`, `hideFromCommands`), every `packages/harness/src/adapters/*/index.ts`,
`packages/harness/src/metadata.ts`, `HarnessDescriptorWire` in `packages/protocol`.

**Delivers:**
- `CredentialId`, `CREDENTIAL_TYPES` with exactly the seven rows of the type table above,
  `Delivery`, `AcceptedCredential`, `InferenceRoute`, `INFERENCE_ROUTES` with the five routes
  that do not depend on S5, and the `CredentialView` zod model.
- `accepts` on each adapter:
  - Claude Code: `anthropic.api-key` → env `ANTHROPIC_API_KEY`; `anthropic.claude-token` → env
    `CLAUDE_CODE_OAUTH_TOKEN`; `anthropic.claude-login` → home.
  - Codex: `openai.api-key` → env `OPENAI_API_KEY`; `openai.chatgpt-login` → home;
    `openai.chatgpt-plan` → env `ACCESS_TOKEN`, with `drivers` limited to the Codex server
    driver's id.
  - Every other adapter: one line for each of the seven types it can already run on today
    (for example an OpenRouter or Anthropic key it reads from an environment variable). A
    harness's own login that is none of the seven types gets no line and stays "no
    credential". This task adds no type id beyond the seven.
- `hideFromCommands` where the harness documents a switch that keeps credentials out of the
  commands it runs: Claude Code `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`; Codex its shell
  environment policy, if a documented setting exists.
- `harnessAccepts(kind)` and `accepts` on the descriptor wire; golden fixtures regenerated.

**Acceptance:**
1. A test asserts `CREDENTIAL_TYPES` has exactly the seven ids and, for each, the store,
   renewal, obtain, sharing and revocation values of the type table. No `home` type has a
   `renewal`; every `vault` type has one.
2. A matrix test, derived from the registry and every bundled adapter (no hand-written list of
   pairs), fails when: a type is accepted by no adapter and has no inference route; an adapter
   accepts a type id that is not in the registry; one adapter accepts the same type twice for
   overlapping drivers. Each of the three failures is shown to fire by a probe in the test.
3. For the pairs `credentialEnv()` knows today, the declarations name the same environment
   variable. (This comparison is deleted with `credentialEnv()` in Task 21.)
4. `harnessAccepts('claude-code')` and `harnessAccepts('codex')` return exactly the lines
   listed above. A descriptor received without `accepts` parses as an empty list.
5. `hideFromCommands` for Claude Code is asserted by a test. For Codex the report states the
   documented setting that was used, or that none exists.
6. No production code reads `accepts` yet: session launch behaves as before, shown by the
   existing launch tests passing unchanged.

**Not in this task:** storage, the resolver, any command or UI.

### Task 2: Credential store and vault

**Issue:** POD-6889. **Spec:** §4, §7.

**Goal:** Encrypted storage for credentials, the key that protects it, and the one-time move
of the keys Podium already stores into it.

**Owns:** one migration under `apps/server/src/migrations/` and the matching entries in
`schema.ts`; `apps/server/src/store/credentials.ts` (new);
`apps/server/src/modules/credentials/{vault,events,legacy-import}.ts` (new);
`packages/runtime/src/vault-key.ts` (new); the read and write path of
`apps/server/src/store/server-secrets.ts` for two keys; `vault.status` and `vault.reset` with
their CLI; the key paragraphs of `docs/configuration.md` and `docs/data-and-upgrades.md`.

**Consumes:** `CredentialId` and the type ids from Task 1.

**Delivers:**
- Tables `credentials`, `credential_secrets`, `credential_placements`, `credential_machines`
  as in §4, with `credentials.legacy_id` (the `accounts.id`, nullable, unique) and
  `credentials.legacy_key` (the id sessions and settings recorded: `account_key`, else `ref`,
  else `id`; nullable, unique per owner) added, and `vault_key` (one row:
  `key_id`, `wrapped_data_key`, `created_at`).
- `packages/runtime/src/vault-key.ts` as under "Shared names". The key file and its directory
  are created with owner-only permissions on first use. The key is never read from an
  environment value.
- `Vault`: AES-256-GCM, a fresh random 12-byte nonce per seal, the binding (credential id,
  type, version) as authenticated data. One data key, created at the first seal and stored
  wrapped by the outside key. `Vault.state()` is `locked` when a wrapped data key exists and
  the outside key is missing or does not open it; a locked vault refuses to seal and to open,
  and never creates a new key by itself.
- `vault.status` (key path, key id, state) and `vault.reset` (deletes the wrapped data key and
  every stored secret, moves the affected credentials to `attention`), both for an admin
  person only, as `podium vault status` and `podium vault reset --confirm`. This is the way
  out when the outside key is lost for good.
- `CredentialsRepository` and `withSecret` as under "Shared names".
- `recordCredentialEvent`, writing to the existing event log. It takes no secret.
- The legacy import, at server start, under the `2027-05` header. The base already made
  connections personal (POD-6300, POD-6360): `accounts` has `owner_user_id`, `account_key`,
  `ref`, `shared_with` and `account_machine_sends`. Every `accounts` row that holds a secret,
  and each `apiKeys.*` server secret still present, becomes a credential with a sealed secret,
  `legacy_id` and `legacy_key`. Type by provider and kind: `api-key` on anthropic, openai or
  openrouter becomes `<provider>.api-key`; `oauth` on anthropic becomes
  `anthropic.claude-token`; anything else is skipped and logged. Each row keeps its owner; a
  row with no live owner, and the `apiKeys.*` secrets, go to the first admin. The same secret
  for the same owner becomes one credential. `account_machine_sends` rows become
  `credential_machines` rows (`allowed_by` = the owner). `shared_with` is left as it is for
  Task 4. The old values are left in place (Task 21 destroys them).
- `integrations.linearApiKey` and `notifications.telegramBotToken` are stored sealed by the
  same vault: an existing plain value is sealed in place at start, and reads return the
  plaintext to the callers that had it before.
- Documentation: where the key file is, `PODIUM_VAULT_KEY_FILE`, its permissions, that it must
  be backed up separately from the state directory, and what a restore without it looks like.

**Acceptance:**
1. Round trip: a sealed secret opens to the same bytes. The raw rows of `credential_secrets`,
   read with plain SQL, do not contain the planted secret.
2. A ciphertext copied to another credential id, to another type, or to another version fails
   to open (three cases).
3. `putSecret` with a stale `expectedVersion` returns `'conflict'` and leaves the stored
   secret unchanged.
4. Key file: created with mode `0600` in a `0700` directory at the resolved path;
   `PODIUM_VAULT_KEY_FILE` and `$XDG_CONFIG_HOME` are honoured; a key file readable by group
   or others is refused with a message that names the file, and the server still starts.
5. Key missing (review focus 6): with stored secrets and the key file removed, the server
   starts, `Vault.state()` is `locked`, `latestSecret` reports the secret as undecryptable,
   `withSecret` rejects, a new seal is refused with a message that names the expected path,
   and no new key file appears. After `vault.reset` a new credential can be added and the old
   ones read "needs attention". `vault.reset` is refused for a member who is not an admin and
   for an agent principal.
6. Legacy import: starting on a database with API-key and Claude-token rows of two owners,
   one row with no owner, one `account_machine_sends` row, an unsupported row, and `apiKeys.*`
   secrets of which one repeats an `accounts` key of the first admin, yields the credentials
   with the mapped types and owners, `legacy_id` and `legacy_key` set, the repeat merged, the
   send as a `credential_machines` row, and the unsupported row skipped with a log line. Each
   opens to its original value. A second start creates nothing. The old values are still
   present.
7. The two server secrets: after start their raw rows contain no plaintext; reading them
   through the store returns the original values; the existing Linear and Telegram tests pass.
8. `recordCredentialEvent` writes an event that a test reads back, and its serialized form
   cannot contain a secret (the function has no parameter that takes one).
9. The two documentation paragraphs exist and match the behaviour above.
10. Lanes: the store shard and the lean gate, on a remote lane.

**Not in this task:** grants (Task 4), the resolver (Task 3), destroying the old values
(Task 21), the transfer (Task 22), the desktop keychain and a key service.

### Task 23: Encrypted daemon connections

**Issue:** POD-6922. **Spec:** §8 "What crosses the wire".

**Goal:** The server knows, for every connected daemon, whether its connection is safe for a
secret; a person can see it; and unencrypted connections have a dated way out.

**Owns:** `apps/server/src/gateway/daemon-link-kind.ts` (new); the daemon accept path in
`apps/server/src/gateway/ws-server.ts`; `linkKind` on the `machine.condition` topic payload; the
instance setting `daemonLink.trustedNetworks` and its field in the machines settings; the
warning on a machine's row in `apps/web/src/features/settings/machine-list.tsx`; the daemon's start-up
warning where it resolves its server address; the connection paragraphs of
`docs/adding-a-machine.md` and `docs/configuration.md`.

**Delivers:**
- `classifyDaemonLink`, called once when a daemon's connection is accepted, from facts the
  server holds: `encrypted` when the server's existing `isSecureRequest` check holds
  (`apps/server/src/auth-route.ts`, including the configured trusted proxy hops); else `local`
  when the client address is loopback and the request carries none of the proxy headers
  (`apps/server/src/readiness-boundary.ts` lists them); else `trusted` when the client address
  (resolved with `clientAddressForRequest`) is inside one of `daemonLink.trustedNetworks`;
  else `plain`. Nothing the daemon sends takes part.
- `registry.daemonLinks.daemonLinkKind(machineId)` for Tasks 5 and 22, and `linkKind` on the
  `machine.condition` topic payload (connection state, like `online`).
- `daemonLink.trustedNetworks`: a list of IPv4 and IPv6 CIDR ranges, written by an admin
  person only, validated. A change applies to daemons that are already connected.
- A warning on the machine's row when its kind is `plain`, saying that credentials are not
  sent to it and how to fix that, and a warning line in the daemon's log at start when its
  server address is `ws://` to another computer.
- The branch that still accepts a `plain` connection carries the `2027-02` header from "Code
  with a removal date". The refusal that will replace it is implemented now behind one
  constant, with a message that names `wss` and the trusted-network setting.

**Acceptance:**
1. A table test for `classifyDaemonLink`: an `https` request is `encrypted`;
   `x-forwarded-proto: https` is `encrypted` with one trusted proxy hop and not with zero; a
   loopback client with no proxy header is `local`; a loopback peer with a proxy header and
   zero trusted hops is `plain`; an address inside a trusted range is `trusted`, for IPv4 and
   IPv6; anything else is `plain`.
2. A value a daemon supplies (a header of its own or a field of its hello) cannot change the
   result: a test sends a daemon that claims an encrypted connection over a plain one and
   reads `plain`.
3. With a connected daemon classified `plain`, adding its network to
   `daemonLink.trustedNetworks` makes `registry.daemonLinks.daemonLinkKind` return `trusted` without a reconnect,
   and removing it returns `plain`.
4. The setting refuses a write by a member who is not an admin, a write by an agent principal,
   and a value that is not a CIDR range.
5. `git grep -n "LEGACY(remove-after: 2027-02)"` shows the plain-connection branch with the
   header text from this plan. With the constant switched, a test shows a `plain` daemon is
   refused at connect with the message.
6. Driven live on a test instance with a daemon on another computer over `ws`: a screenshot
   of the machines panel showing the warning on that machine and none on a local one, and the
   daemon's log line.
7. The two documentation paragraphs say that a daemon on another computer needs `wss` or a
   trusted network, and give the removal date.
8. Lanes: the lean gate and the daemon integration lane, on a remote lane.

**Not in this task:** sending or refusing a credential (Task 5), the transfer (Task 22).

### Task 3: Credential resolver

**Issue:** POD-6890. **Spec:** §9 "The resolver", "Choosing for a session", §8 "Which
machines may receive a credential", §18.

**Goal:** One function decides which credential a session or a model call uses and whether it
may. Session start and revival go through it, and the old launch-time account functions are
gone.

**Owns:** `apps/server/src/modules/credentials/{access,legacy-ids}.ts` (new);
`apps/server/src/modules/sessions/{session-start,session-revival,launch-config,session-wiring,account-env,harness-account}.ts`;
the calls to the deleted functions in `apps/server/src/modules/superagent/service.ts`,
`apps/server/src/modules/machines/service.ts` and `apps/server/src/relay.ts`;
`packages/model/src/entities/session.ts`; `packages/model/src/settings/preferences.ts`; one
migration adding `sessions.credential_id`. `may-use.ts` is shared with Task 4: whichever of
the two lands first creates it with the signature under "Shared names" and the owner case; the
other rebases onto it.

**Consumes:** the declarations of Task 1; the repository, `withSecret` and
`recordCredentialEvent` of Task 2.

**Delivers:**
- `resolveSessionAccess`, `resolveInferenceAccess` and `ACCESS_REFUSAL_MESSAGES` with the
  ten sentences under "Shared names". The checks run in this order and stop at the first
  failure: with no credential, the acting person holds custody of the machine
  (`own-credential-required`), and that is the whole check; otherwise the credential exists
  (`not-found`) and is not `revoked` (`revoked`); `mayUse` is not null (`not-yours`); the
  harness and driver accept its type (`wrong-type`); for a `home` type, the machine's
  inventory reports that identity (`not-on-this-machine`); the owner holds custody of the
  machine or sent it there (`machine-not-allowed`); its status is `ok` (`needs-attention`).
  The resolver replaces the rules the multi-user work put into `harness-account.ts` and
  `account-env.ts`: a run never uses another person's connection or a custodian's login. `daemon-too-old` and `connection-not-encrypted` are raised by Task 5.
- Every refusal records a `refuse` event.
- `credentialIdFromLegacy(accountId, ownerUserId)` under the `2027-02` header: `''` and
  `native:<harness>` give no credential; `native:<harness>:<fingerprint>` gives the credential
  with that identity when one exists, otherwise none; any other value is looked up with
  `findByLegacyKey(ownerUserId, value)`, then `findByLegacyId(value)`. The owner is the
  session's owner or the person whose settings hold the value.
- `session.credentialId` on the record and the wire. A stored session or setting that still
  holds an old id is read through `credentialIdFromLegacy`; new writes store `credentialId`.
- The personal setting `credentialDefaults`. Selection at launch: the credential the launch
  named, then the default for that harness, then none.
- Session start and revival call the resolver. A refusal ends the launch with its sentence.
  Revival uses the credential stored on the session.
- Until Task 5 lands, an `env` delivery is put into `SpawnMessage.env` by `withSecret` as the
  last step before sending.
- Deleted: `account-env.ts`, `harness-account.ts`, `resolveAccountEnv`,
  `selectHarnessAccountId`, `nativeAccountIdForMachine`, and every server caller of them.

**Acceptance:**
1. A resolver table test with one row for each refusal this task raises (`not-found`,
   `revoked`, `not-yours`, `wrong-type`, `not-on-this-machine`, `machine-not-allowed`,
   `own-credential-required`, `needs-attention`) and one for each delivery (`env` with the declared variable for every
   accepted vault type; the default home; no credential). For every row the serialized result
   does not contain the planted secret.
2. `ACCESS_REFUSAL_MESSAGES` has the ten sentences; leaving one out fails to compile.
3. Legacy ids (review focus 4): `''`, `native:claude-code`, `native:codex:<fingerprint>`,
   `managed:anthropic`, `managed:claude-oauth` and `managed:anthropic:earlier-workspace` each
   resolve as specified, once from a stored session and once from settings; the same
   `managed:anthropic` for two different owners resolves to each owner's own credential.
4. Revival: a session stored on credential A revives on A after the person's default became B.
5. No fallback: a launch whose credential is in `attention` sends no spawn message at all
   (asserted on the daemon port) and records a `refuse` event.
6. Machine rule (review focus 7): the owner's own credential on a machine where the owner
   only holds `use` is refused with `machine-not-allowed`; after `allowMachine` it resolves;
   on a machine the owner holds custody of it resolves without one; an admin without custody
   is treated like a `use` holder.
7. No credential: the custodian resolves to the default home; another person on that machine
   is refused with `own-credential-required`, and no spawn is sent.
8. Selection order: named beats default beats none, three cases.
9. `git grep -w` for each deleted name finds nothing under `apps/server`.
10. Lanes: the store shard (the migration) and the lean gate, on a remote lane.

**Not in this task:** grants beyond the owner (Task 4), the `access` field (Task 5), launch
inputs in the CLI and UI (Task 10), direct-inference callers (Task 12), destroying old values
(Task 21).

### Task 4: Credential commands and sharing

**Issue:** POD-6891. **Spec:** §6, §12 "People", §8 "Which machines may receive a credential".

**Goal:** People manage their own credentials through commands and can give others the use of
one.

**Owns:** `packages/commands/src/credentials/contracts.ts` (new);
`apps/server/src/modules/credentials/{commands,queries,trpc}.ts` (new);
`packages/model/src/ids/keys.ts` (the `credential` entity kind); the grant grantee "all
members"; the credentials row of `packages/model/src/annotations/matrix.ts`; the
`CredentialView` model in `packages/client-graph`; `may-use.ts` (shared with Task 3, see
there); the step in `legacy-import.ts` that turns `accounts.shared_with` into grants (that
function only); the key-sharing server code it replaces (`sharedWith` readers in
`apps/server/src/accounts.ts` and the accounts repository).

**Consumes:** Tasks 1 and 2.

**Delivers:**
- Commands: `credentials.add({ type, label, secret })` for types whose `obtain` includes
  `paste`; `rename`; `renew({ credentialId, secret })`, which stores the next version under
  the same id; `remove`; `share({ credentialId, grantee: { userId } | 'all-members', verb:
  'use' | 'manage', acknowledgeDisclosure, acknowledgeWarning? })`; `unshare`;
  `allowMachine({ credentialId, machineId, acknowledgeDisclosure })`; `disallowMachine`.
  Query `credentials.list`, returning `CredentialView[]` the caller owns or was granted.
- The owner or a holder of `manage` may write. Only a person may: every write command refuses
  an agent principal. Being an admin gives no access to another person's credential.
- `add` stores the fingerprint and a masked form as the identity (with the existing
  secret-fingerprint helper). Provider verification is Task 13.
- Grants on the existing grant record: `credential` as a resource kind, the verbs `use` and
  `manage`, and "all members" as a grantee. `mayUse` reads them at every call; nothing is
  cached or copied.
- Existing shares carry over, once, under the `2027-05` header: for each imported credential,
  `shared_with` `"*"` becomes one `use` grant to all members and each user id in it one `use`
  grant to that person (read through `legacy_id`). A user id that no longer exists is skipped
  and logged.
- Every contract is `online-sensitive` (never queued) and redacts `secret`.
- An event for each of add, rename, renew, remove, share and unshare.

**Acceptance:**
1. An authorization table test: the owner can run every command; a member with `manage` can
   rename, renew, remove and share; a member with `use` sees the credential in
   `credentials.list` with `access: 'use'` and is refused every write; a member with no grant
   does not see it and gets not-found on every command; an admin who is not the owner is
   treated like any other member; an agent principal acting for the owner is refused on each
   of the eight write commands.
2. `share` is refused without `acknowledgeDisclosure: true` for every type, and for a type
   with `sharing: 'warn'` also without `acknowledgeWarning: true`. A grant to all members
   makes the credential usable by a second member.
3. Grants are read at use (review focus 2): after `unshare`, `resolveSessionAccess` for the
   former grantee returns `not-yours` on the next call.
4. No secret leaves: for `add` and `renew`, the command result, the emitted event, the
   command journal entry and the record on the sync stream do not contain the planted secret;
   neither does the output of `credentials.list`.
5. Never queued: an `add` submitted while the client is offline is rejected, not stored for
   later.
6. `allowMachine` requires the acknowledgement, an owner or `manage` caller, and an enrolled
   machine.
7. Imported shares: a row shared with `"*"`, one shared with one person, and one not shared
   give an all-members grant, a grant to that person, and none; after a second start the grants
   are unchanged. A second member can use exactly what was shared with them before.
8. Lanes: the lean gate, and the store shard if this task adds a migration, on a remote lane.

**Not in this task:** the page (Task 17), provider verification and removal everywhere
(Task 13), home sign-in (Task 9), ChatGPT sign-in (Task 14).

### Task 5: Credential delivery to daemons

**Issue:** POD-6892. **Spec:** §8 "What crosses the wire", §9 "Launching".

**Goal:** A secret goes from the server to a daemon in one dedicated field, only when the
connection and the daemon qualify, and exists there only in memory.

**Owns:** `AccessField`, `access?` on `SpawnMessage`, the headless turn request and engine
start, `sessionAccessRefresh` and the `sessionAccess` capability in `packages/protocol`;
`apps/server/src/modules/credentials/attach-access.ts` (new); the server code that builds
those messages; `apps/daemon/src/control/access.ts` (new);
`apps/daemon/src/control/{session,session-env}.ts`; the daemon's headless turn environment;
the message logging filter; every daemon journal or log writer measurement S4 finds.

**Consumes:** `SessionAccess` (Task 3), `withSecret` (Task 2),
`registry.daemonLinks.daemonLinkKind` (Task 23).

**Delivers:**
- `attachAccess`. For a vault credential it refuses `daemon-too-old` when the daemon did not
  advertise `sessionAccess` and `connection-not-encrypted` when `registry.daemonLinks.daemonLinkKind` is `plain`,
  both before the vault is read, and otherwise returns the `access` field with the secret.
  For a home other than `default` it needs `sessionAccess` and no secret is read. For no
  credential it returns no field, so a launch on the harness's own login is unchanged on any
  daemon and any connection.
- The daemon keeps a session's secret in memory for the life of the session and applies it
  each time it starts a process for that session: the terminal spawn, every headless turn,
  the engine start. It applies `hideFromCommands`. It never writes the secret to a journal, a
  log or its state directory, and drops it when the session ends.
- After a daemon reconnects, the server sends `sessionAccessRefresh` for that machine's live
  sessions that run on a vault credential. A turn that starts before the refresh arrived
  waits for it and fails with a readable error after a bounded wait; it never runs without
  the credential.
- Every message type that can carry `access` is excluded from wire logging by type.
- A `deliver` event for each delivery.
- Measurement S4: the list of every daemon journal and log that wrote spawn environment
  before this task, and what was changed in each.
- `SpawnMessage.env` carries no credential on any path; the interim step of Task 3 is removed.

**Acceptance:**
1. Older daemon (review focus 1): for a daemon without `sessionAccess` and a vault
   credential, the result is `daemon-too-old`, no spawn message is sent, the session does not
   start, and the vault was not opened (asserted with a spy).
2. Plain connection: with `registry.daemonLinks.daemonLinkKind` `plain` the result is `connection-not-encrypted`,
   nothing is sent and the vault is not opened; the same machine with `trusted` receives the
   credential.
3. No credential: a launch with `credentialId: null` works unchanged on a daemon without
   `sessionAccess` and on a `plain` connection.
4. A home other than `default` on a daemon without `sessionAccess` is refused with
   `daemon-too-old`.
5. The variable is present in the process environment of a terminal session, of the second
   turn of a per-turn driver, and of an engine start (three integration cases with the
   fixture harness).
6. Daemon restart: after a restart and reconnect the next turn of a live session has the
   credential again, and a turn started before the refresh does not run without it.
7. Nothing on disk: after a launch with a planted secret, a recursive search of the daemon's
   state directory, its journals and logs, and the server's logs and command journal finds no
   occurrence, plain or base64. The same search finds a deliberately logged canary.
8. A Claude Code launch with an `env` credential has `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.
9. For every accepted vault type, the built spawn message's `env` does not contain the
   variable. Golden fixtures are regenerated.
10. The S4 list is attached to the task.
11. Lanes: the lean gate and the daemon integration lane, on a remote lane.

**Not in this task:** homes on the daemon (Task 8), reading back what the harness
authenticated with (Task 10), the connection classification (Task 23).

### Task 6: Home and switch measurements

**Issue:** POD-6893. **Spec:** §10, §19 (S1, S2, S3, S5, S7).

**Goal:** Measured answers to the questions that decide how homes, switching and one-shot
inference are built. Throwaway work: the result is a report, and updates to the spec.

**Needs the operator** for browser sign-ins, in new homes only.

**Acceptance:** the report attached to the task has one section per item, each with the
commands that were run, an excerpt of what was observed, the answer, and the decision it
implies.
1. S1: the vendor's sign-in completed inside a Podium-made home, for Claude Code and for
   Codex, on Linux. The same on macOS on the Mac runner if it is reachable; if not, the
   report says it was not measured.
2. S2: a table of what a second home needs (settings, instructions, skills, plugins, MCP
   configuration, hooks), each marked "link is safe", "copy at launch" or "not needed", with
   the observation behind it; and whether a server driver runs with its home variable set.
3. S3: a grid of each driver (Claude Code terminal, Codex terminal, Codex server) against:
   same home with a different credential; conversation copied to another home; for Codex, the
   copy with reasoning items removed. Each cell says whether the session answered a question
   about an earlier turn, or gives the error.
4. S5: twenty one-shot calls of Claude Code with a title-sized prompt and tools off: median
   and 95th-percentile time, and tokens used compared with the same prompt through the API.
   Verdict against the bar: median five seconds or less.
5. S7: whether a second Claude home can be signed in from an existing login without a
   browser, and whether the first home is still signed in an hour later.
6. The login status of every default home, recorded before and after, is unchanged.
7. §10 and §19 of the spec are updated where an answer changes them, in a commit on the task
   branch, and the report lists which of Tasks 8, 9, 11 and 12 each answer affects.
8. Every throwaway home and token is deleted, and the report lists them.

### Task 7: ChatGPT sign-in measurements

**Issue:** POD-6894. **Spec:** §11, §19 (S6).

**Goal:** Sign in with ChatGPT observed working end to end from a self-hosted server, step by
step, or the failing step named. Throwaway work.

**Needs the operator** for one browser sign-in with a Plus or Pro account.

**Acceptance:** the report attached to the task has one section per step with the request
that was sent (tokens removed), the answer, and "works" or the error.
1. Registration from this server with `client_id=dynamic_agent_client`, an app name and a
   host id.
2. The code exchange with PKCE, returning an access token and a renewal token; their
   lifetimes as observed.
3. A `POST /v1/responses` call with `store: false` and `stream: true`, and a model list.
4. A renewal, showing that the renewal token is replaced.
5. `codex app-server` started with OpenAI's documented provider settings and the token in its
   environment, answering one turn, on a home with no Codex login.
6. The same process restarted with a replaced token, resuming its thread and answering a
   question about the earlier turn.
7. What a plan-limit answer and a revoked grant look like, if either can be produced; if not,
   stated.
8. The tokens were kept only in an owner-only file outside the repository; at the end the
   grant is revoked through OpenAI's revocation endpoint and the file deleted.
9. §11 of the spec is updated where an observation differs from it, and the report lists what
   Tasks 14 and 15 must change.

---

## Phase 2: Features

### Task 8: Harness homes on the daemon

**Issue:** POD-6895. **Spec:** §10 "Homes".

**Goal:** A machine can hold several subscription logins for one harness, each in its own
directory, and run sessions on them at the same time.

**Owns:** `apps/daemon/src/homes/` (new: `registry.ts`, `share.ts`);
`apps/daemon/src/control/homes.ts` (new);
`apps/daemon/src/{host-runtime,harness-runtime,harness-management}.ts`;
`apps/daemon/src/control/{context,inventory}.ts`; discovery
(`apps/daemon/src/discovery-*.ts`); the inventory and home messages in `packages/protocol`.

**Consumes:** `access` with `{ kind: 'home'; homeId }` (Task 5); Task 6's answer on how a home
shares settings.

**Delivers:**
- `HomeRegistry { ensure(credentialId, harness), get(homeId), list(), remove(homeId) }`, with
  homes under `<state>/homes/<credentialId>/<harness>/`, owner-only.
- `homeEnsure*` and `homeRemove*` control messages.
- Launch with the harness's directory variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) set from
  the home; hooks installed in that home; discovery over every home;
  `AgentInventory.logins` with one entry per home (`default` for the harness's own
  directory); one server-driver engine per home in use; quota and model probes per home.
- A home shares the person's settings, instructions, skills and plugins the way Task 6 found
  safe.

**Acceptance:**
1. `ensure` twice for the same credential and harness returns the same home; the directory
   has mode `0700` at the path above.
2. Two homes for one harness on one daemon, two sessions at once: each process has its own
   home in its directory variable and neither has the other's.
3. Hooks are installed in each home at launch, and a hook event from a session in a
   non-default home reaches the daemon.
4. Discovery finds a transcript in each home and attributes each to its session.
5. The inventory reports one `logins` entry per home, with `default` for the harness's own
   directory.
6. Two sessions in one home share one server-driver engine; sessions in two homes get two.
7. Quota and model probes report per home.
8. `homeRemove` deletes the directory and stops its engine; removing `default` is refused.
9. A marker placed in the person's settings is visible to a session in a second home.
10. A session whose access names no home behaves as before: the existing daemon tests pass
    unchanged.
11. Driven live on a remote machine: for Claude Code and for Codex, sessions started in two
    homes, with the harness's own status output showing each home's directory. A signed-in
    state is not needed for this (sign-in is Task 9).
12. Lanes: the lean gate and the daemon integration lane, on a remote lane.

**Not in this task:** signing in to a home and credential rows (Task 9), copying a
conversation between homes (Task 11).

### Task 9: Home sign-in and found logins

**Issue:** POD-6896. **Spec:** §6 (ways 2 and 3), §8 "What Podium leaves on machines", §10.

**Goal:** A person adds a subscription by picking a machine and signing in once, and logins
they already made on a machine appear by themselves.

**Owns:** `apps/server/src/modules/credentials/sign-in.ts` (new); the `credentials.signInStart`
handler; `apps/server/src/modules/accounts/native-login.ts` (moves here); the server side of
"found on a machine" rows; `removePlacement` for kind `home`; the placement row written by
propagation; `apps/web/src/features/credentials/add-subscription/` (new).

**Consumes:** homes (Task 8); rows, list and `allowMachine` (Task 4); the page's "add" menu
(Task 17).

**Delivers:**
- `credentials.signInStart`: on a machine the person holds custody of or has sent it to, Podium ensures a
  home and opens the vendor's own sign-in in a terminal there. When the home reports a login,
  the credential is bound to the identity that signed in and a `credential_placements` row
  (`home`, `present`) is written.
- A login reported from a harness's default home becomes one credential the first time it is
  seen, owned by the machine's custodian. The same identity on a second machine
  is the same credential with a second home.
- Removing a home placement: the vendor's sign-out runs in the home, then the home is
  deleted. A login in a default home is never signed out or deleted by Podium.
- Propagation writes a `credential_placements` row (`propagated-file`) when it copies.
- "Add subscription" in the page's add menu.

**Acceptance:**
1. `signInStart` on a machine the person holds custody of ensures a home and opens a terminal
   running the vendor's sign-in in it; on another machine that the credential was not sent to,
   it is refused with `machine-not-allowed`; an agent principal is refused.
2. When the home reports a login, the credential shows the identity that signed in, status
   `ok`, and a placement row `home` / `present`.
3. Different account (review focus 5): signing in as account B where the credential was
   started for A attaches the home to the existing credential for B if there is one, and
   otherwise gives this credential B's identity. In both cases the result shown to the person
   names the account that actually signed in.
4. Found logins: a login in a default home creates exactly one credential, owned by the
   machine's custodian; the same identity on two machines is one credential with
   two homes; a repeated report creates nothing. A harness that cannot report an identity
   creates no row.
5. A sign-in that is cancelled or abandoned leaves no credential and no empty home.
6. Removing a home placement runs the vendor's sign-out, deletes the home and marks the
   placement `removed`. For a login in a default home nothing on the machine is touched.
7. Propagation records one `propagated-file` placement per copy.
8. Component tests for the add-subscription states: waiting for sign-in, signed in as a named
   account, failed.
9. Driven live with the operator: a second Claude subscription and a second ChatGPT
   subscription added on one machine through the page, a session running on each at the same
   time, screenshots attached. The login status of the default homes is the same before and
   after.
10. Lanes: the lean gate and the web tests, on a remote lane.

**Not in this task:** homes on the daemon (Task 8), remove-everywhere as a whole (Task 13).

### Task 10: Session credential choice

**Issue:** POD-6897. **Spec:** §9 "Choosing for a session", "Launching".

**Goal:** Every way of starting a session can name its credential, and the session reports
what its harness actually authenticated with.

**Owns:** the launch inputs (`sessions.create`, the issue start and add-session paths in
`apps/server/src/modules/issues/service/`,
`apps/server/src/modules/messages/handlers/spawn-agent.ts`); `apps/cli/src/agent-cli.ts` and
the issue CLI (`--credential`); `effectiveAuth` and `credentialMismatch` on the session
record, with their migration; the daemon's spawn result.

**Consumes:** Tasks 3 and 5.

**Delivers:**
- A `credentialId` input on each of the four launch paths, and `--credential <label | id |
  none>` on `podium agent spawn`, `podium issue start` and `podium issue add-session`. A label
  is matched, ignoring case, among the credentials the acting person can use.
- `effectiveAuth` reported by the daemon after the harness started, from the harness's own
  answer where it gives one.
- `credentialMismatch` on the session when the harness reports another identity than the one
  chosen.

**Acceptance:**
1. Each of the four launch paths stores the chosen credential on the session (four tests).
2. An unknown label or id is refused before anything is created: no session row and no
   worktree. A label that matches two credentials is refused and names both.
3. An agent may name a credential its person can use; one its person cannot use is refused.
4. With nothing named the person's default for the harness is used; `--credential none`
   starts on the harness's own login even when a default is set.
5. `effectiveAuth` is reported for a Claude Code launch and a Codex launch, with method and
   fingerprint where the harness gives them, and `unknown` otherwise.
6. A competing key planted in the daemon's environment does not change which credential the
   harness uses: `effectiveAuth` matches the chosen one.
7. When the harness reports another identity, the session carries `credentialMismatch` with
   both identities, and loses it after a restart on which they match.
8. The CLI help documents the flag. Driven on a test instance: `podium agent spawn
   --credential <label>` starts on that credential; the transcript is attached.
9. Lanes: the store shard (the migration) and the lean gate, on a remote lane.

**Not in this task:** the picker and the label in the UI (Task 18), switching (Task 11).

### Task 11: Credential switch on sessions

**Issue:** POD-6898. **Spec:** §9 "Switching a session to another credential".

**Goal:** A running or stopped session moves to another credential and continues the same
conversation.

**Owns:** `packages/commands/src/sessions/switch-credential.ts` (new);
`apps/server/src/modules/sessions/switch-credential.ts` (new);
`apps/daemon/src/homes/conversation.ts` (new); the adapter declarations of where a
conversation's files are.

**Consumes:** the choice (Task 10), homes (Task 8), what survives a switch (Task 6).

**Delivers:** `sessions.switchCredential` as under "Shared names": resolve, record, then for a
running session stop at a turn boundary and start again through revival with resume. Across
homes the daemon first copies the conversation into the target home. For Codex across
accounts it resumes from a copy without reasoning items. Where resume is not possible it
opens a new session with a handoff summary and says so. A `switch` event each time.

**Acceptance:**
1. An idle running session switches, revives with resume on the new credential and answers a
   question about an earlier turn: one test per driver with the fixture harness.
2. During a turn: `whenBusy: 'wait'` applies the switch at the next turn boundary and the
   turn completes; `whenBusy: 'interrupt'` stops the turn and switches. No turn is dropped
   without one of the two having been chosen.
3. A stopped or hibernated session only changes its record (`continuedAs: 'next-wake'`); the
   next wake uses the new credential.
4. Refusals: a credential not on the session's machine gives `not-on-this-machine`; a type
   the harness does not accept gives `wrong-type`. After a refusal the session still has its
   old credential and is still running.
5. Across homes the conversation file is copied into the target home before the resume, and
   the original stays where it was.
6. Codex across accounts resumes from a copy with the reasoning items removed, as Task 6
   found; the original is untouched.
7. Where resume fails, a new session opens with a handoff summary, the old one is stopped,
   and the result is `continuedAs: 'handoff'`.
8. Switching to no credential (the harness's own login) works.
9. A `switch` event names who switched, from which credential and to which.
10. Driven live: a Claude Code session and a Codex session each move between two
    subscriptions on one machine and continue; transcripts attached.
11. Lanes: the lean gate and the daemon integration lane, on a remote lane.

**Not in this task:** the switch action in the UI (Task 18), automatic fallback (not in this
epic).

### Task 12: Direct inference through credentials

**Issue:** POD-6899. **Spec:** §9 "Direct inference", §5 routes.

**Goal:** Model calls Podium makes itself use the same credentials and the same choice as
sessions.

**Owns:** `apps/server/src/modules/inference/complete.ts` (new);
`apps/server/src/{llm,llm-roles}.ts`; the callers of `completeForRole`; role settings
(`RoleBackend.credentialId`).

**Consumes:** `resolveInferenceAccess` and `withSecret` (Tasks 3 and 2); Task 6's answer on
one-shot mode (S5).

**Delivers:**
- `complete(...)` as under "Shared names", with the routes `http` (the three key types),
  `on-machine` (the existing Codex transport, now chosen by credential) and, only if S5
  passed, `harness-one-shot` for `anthropic.claude-login`, which this task then adds to
  `INFERENCE_ROUTES`.
- A role names a credential. A role setting from before this epic (an `accountId`, or a
  provider that relied on an `apiKeys.*` secret) is read as the imported credential, under
  the `2027-02` header.
- `servedBy` and the credential's label on every result, and `servedBy` on the cost record.
- `roleApiBackend` and the `apiKey(provider)` callback are deleted.

**Acceptance:**
1. `http`: for each of the three APIs, the request a fake provider receives carries the
   secret of the chosen credential and not that of a second credential of the same provider.
2. `on-machine`: the existing transport tests pass with the login chosen by credential.
3. `harness-one-shot`: if S5 passed, Claude Code is invoked in the home that holds the login
   with its tools off (asserted on the arguments). If S5 failed, the route is not declared
   and a role that names a Claude login is refused with `wrong-type`. The report says which.
4. A role that names a credential without a route is refused with `wrong-type`. A role with
   no credential behaves as a role without a backend does today.
5. After the upgrade, title generation works on an instance whose role settings were not
   touched (the old setting resolves to the imported credential).
6. Every result carries `servedBy` and `label`, and the cost record carries the credential id.
7. A role that names a credential the acting person may not use is refused with `not-yours`.
8. `git grep -w` for `roleApiBackend` and for the `apiKey` callback finds nothing under
   `apps/server`, and no reader of an `apiKeys.*` secret is left in the inference path.
9. The server's log output during a call does not contain the planted key.
10. Driven live: title generation and the issue assistant answer on a second Anthropic key
    chosen through the settings command; the cost record showing `servedBy` is attached.
11. Lanes: the lean gate, on a remote lane.

**Not in this task:** the role pickers in the UI (Task 17), the ChatGPT plan route's adapter
(Task 14).

### Task 13: Credential health and renewal

**Issue:** POD-6900. **Spec:** §7 "Health and renewal", §8 "cleanup".

**Goal:** Podium notices a credential that stopped working, tells its owner, restarts what
used it after renewal, and removes every copy when it is removed.

**Owns:** `apps/server/src/modules/credentials/{health,placements}.ts` (new); the hook into
the harness-error classifier (the callers of
`apps/server/src/modules/superagent/harness-error.ts`); the handlers behind
`credentials.renew` and `credentials.remove`; member removal's credential step.

**Consumes:** Task 4; the page (Task 17); `emitNotice` and `resolveNotices` (Task 16; a port
that does nothing until it lands).

**Delivers:**
- Provider verification on add and renew for each pasted type: one cheap call for the three
  key types, a format check for the Claude token, whose expiry is recorded as one year from
  when it was added.
- A notice two weeks before a recorded expiry, and `attention` at expiry.
- `attention` with a reason when a launch or a call is rejected for the credential, one
  `credential-attention` notice per credential, resolved by renewal. A plan or rate limit sets
  `limitReachedUntil` and is not `attention`.
- Renew: the same id, the next version; sessions that hold the old secret restart with resume
  at their next turn boundary.
- Remove everywhere: the secrets are deleted and the record becomes `revoked`; each placement
  is removed through `removePlacement` (this task implements `propagated-file`), with
  `removal-pending` for a machine that is offline until it confirms; running sessions on it
  are flagged and stopped at their next turn boundary.
- Removing a member removes their credentials everywhere and ends the grants they gave.
- A `credential-shared` notice to the person a grant is made to. An `attention` event.

**Acceptance:**
1. Adding a key the fake provider rejects is refused with the provider's reason and stores
   nothing; adding a valid one sets `verifiedAt`.
2. A rejected launch or call moves the credential to `attention` with the reason and raises
   exactly one notice; a second rejection raises none; other credentials are unaffected.
3. A plan-limit or rate-limit answer does not move it to `attention`.
4. Expiry: thirteen days ahead raises one notice, fifteen days ahead none, and an expired
   credential is `attention`.
5. Renew keeps the id, raises the version, resolves the notice and returns the status to
   `ok`; two sessions that hold the old secret restart with resume at their next turn
   boundary, and a turn in progress is not interrupted.
6. Removal with running sessions (review focus 2): both sessions are flagged and stop at
   their next turn boundary, the next revival is refused with `revoked`, and nothing crashes.
7. A placement on an offline machine stays `removal-pending`, visibly, and becomes `removed`
   when the machine reconnects.
8. Removing a member removes all their credentials everywhere; a session of another member
   that ran on one of them is flagged.
9. Sharing raises one `credential-shared` notice for the grantee.
10. The `attention`, `renew` and `remove` events name the actor and contain no secret.
11. Driven live: a rejected key shown as needing attention on the page and on its session,
    renewed, and the session restarted; screenshots attached.
12. Lanes: the lean gate, on a remote lane.

**Not in this task:** removing a home placement (Task 9), the ChatGPT keeper's renewal
(Task 14).

### Task 14: ChatGPT sign-in and keeper

**Issue:** POD-6901. **Spec:** §11.

**Goal:** A person signs in to Podium with their ChatGPT plan once; Podium keeps that sign-in
fresh and uses the plan for its own model calls.

**Owns:** `apps/server/src/modules/credentials/chatgpt-plan/` (new: `authorize.ts`,
`keeper.ts`, `host-id.ts`); the `oauthLoopback*` messages and
`apps/daemon/src/control/oauth-loopback.ts` (new); the `openai-responses` adapter in
`apps/server/src/llm.ts`; `apps/web/src/features/credentials/add-chatgpt/` (new).

**Consumes:** Tasks 2 and 4; `complete` (Task 12); the findings of Task 7; the page's "add"
menu (Task 17).

**Delivers:**
- `credentials.chatgptSignInStart` → `{ attemptId, authorizeUrl }`, with the PKCE verifier
  kept on the server. The first sign-in sends `client_id=dynamic_agent_client`, the app name
  and the server's host id; later ones the stored client id.
- A daemon or the desktop app listens on `127.0.0.1` and relays `code` and `state`, or the
  person pastes the address their browser ended on. `chatgptSignInComplete` exchanges the
  code on the server and stores the token set sealed.
- `ChatgptPlanKeeper.accessToken(credentialId)`: a token valid for at least five minutes,
  renewed under a per-credential lock with the version check of `putSecret`.
- The `openai-responses` adapter with `store: false`, `stream: true` and no system-role
  message. A plan-limit answer sets `limitReachedUntil`.
- Removal calls OpenAI's revocation endpoint.

**Acceptance:**
1. The authorize address has an S256 challenge, the scopes and `resource` of §11 exactly, a
   loopback return address `http://127.0.0.1:<port>/auth/callback`, and a `state` bound to
   the attempt. The verifier is not in the command's result.
2. Completion through the relay: a wrong `state` is refused, an attempt older than ten
   minutes is refused, and an attempt cannot be completed twice.
3. Completion through a pasted address passes the same three checks.
4. The token set never passes through a daemon: the loopback messages carry `code` and
   `state` only (asserted on their schema) and the exchange runs on the server.
5. The raw stored rows do not contain a token; the credential shows the account's email and
   plan.
6. The keeper (review focus 3): `accessToken` returns a token with at least five minutes
   left; two renewals started at once make one renewal request and store one token set; a
   renewal that loses the version check reads the winner's tokens.
7. Each renewal error OpenAI lists as final moves the credential to `attention` and raises a
   notice; a passing error is retried and does not.
8. A Responses request has `store: false`, `stream: true` and no system-role message. A
   plan-limit answer sets `limitReachedUntil`, does not set `attention`, and no other
   credential is tried.
9. Removal calls the revocation endpoint; when that call fails the credential is still
   removed locally and the person is told.
10. An agent principal cannot start a sign-in. Signing in again with the same ChatGPT account
    updates the existing credential.
11. Component tests for the states: waiting, paste instead, signed in as a named account,
    failed.
12. Driven live with the operator: the sign-in completes and title generation answers on
    that plan (`servedBy`); screenshot attached.
13. Lanes: the lean gate and the web tests, on a remote lane.

**Not in this task:** Codex on the plan (Task 15).

### Task 15: Codex on a ChatGPT plan

**Issue:** POD-6902. **Spec:** §11 "Codex".

**Goal:** Codex sessions run on a ChatGPT plan that was signed in to Podium, on any allowed
machine, with no Codex login there.

**Owns:** `packages/harness/src/driver/families/codex/` (provider arguments, engine start,
resume); the daemon's Codex engine host.

**Consumes:** `openai.chatgpt-plan` in Codex's `accepts` (Task 1); the keeper (Task 14); the
`access` field and `sessionAccessRefresh` (Task 5); engines per home (Task 8).

**Delivers:** the Codex server driver started with OpenAI's documented provider settings and
the token from the `access` field in `ACCESS_TOKEN`. Before the token expires, at a turn
boundary, the server sends new access, the engine restarts and resumes its thread. A session
on this type uses the server driver.

**Acceptance:**
1. The engine start has the documented provider settings; the token is in the environment
   and not in the arguments.
2. The terminal driver with this type is refused with `wrong-type`; a launch that names this
   credential and no driver gets the server driver.
3. With a fake provider endpoint and a controlled clock: before expiry, at a turn boundary,
   new access arrives, the engine restarts, the thread resumes and the next turn answers with
   its context. The endpoint receives no request with an expired token.
4. A token that expires during a long turn: the turn finishes or fails with a readable error,
   the next turn uses a fresh token, and the session is not lost.
5. It runs in a home with no Codex login (integration test).
6. Two sessions on one plan on one machine both survive a token replacement.
7. Driven live: a Codex session runs for more than an hour on a ChatGPT plan on a machine
   with no Codex login; the transcript shows a turn before and a turn after the first token
   replacement.
8. Lanes: the lean gate and the daemon integration lane, on a remote lane.

### Task 16: Per-person notification inbox

**Issue:** POD-6881. **Spec:** §13.

**Goal:** Each person has one inbox that any feature can put a message into, with mentions in
issue comments as its first use besides credentials.

**Owns:** `apps/server/src/modules/notices/` (new); `apps/server/src/store/notices.ts` (new)
and its migration; `packages/model/src/entities/notice.ts` (new);
`packages/commands/src/notices/` (new); mention handling in
`apps/server/src/modules/issues/service/mail.ts` and the `issues.addComment` contract;
`apps/web/src/features/notices/` (new); the comment box's name completion;
`apps/mobile/src/screens/InboxScreen.tsx`; per-kind push preferences and
`apps/server/src/modules/notify/`.

**Delivers:** `emitNotice`, `resolveNotices`, `notices.list`, `notices.markRead`,
`notices.markAllRead`; mentions stored on the comment when it is written; a tray with a count
in the web and desktop header; notices on the phone's inbox screen; push by kind.

**Acceptance:**
1. A one-page design of the notice record, the tray and the phone screen is attached to the
   task and mailed to the coordinator before building starts.
2. The same `dedupeKey` twice while unresolved gives one notice; after `resolveNotices` a new
   emit gives a new one, and resolving removes it from the count.
3. Privacy: `notices.list` returns only the caller's notices; another member, an admin
   included, can neither read nor mark one; the sync stream delivers a notice only to its
   recipient.
4. Mentions: a mention raises exactly one notice for each mentioned member who can see the
   issue, none for the author, none for a member who cannot see the issue, and none for a
   name that is not a member. Editing a comment to add a mention raises one for the added
   name only.
5. The comment box completes the names of members who can see the issue.
6. The tray shows the unread count; opening a notice goes to its subject and marks it read;
   "mark all read" clears the count.
7. The phone's inbox screen lists notices, and tapping one opens its subject.
8. Push is sent only for kinds the person has switched on (mention and credential-attention
   on by default), through the existing channels, and carries no secret.
9. Driven live with a second member: a mention in an issue comment appears in the operator's
   tray and on the phone; screenshots of both attached.
10. Lanes: the store shard, the lean gate and the web tests, on a remote lane.

### Task 17: Credentials page

**Issue:** POD-6903. **Spec:** §16 item 1, §12 "People", §8.

**Goal:** The settings page where a person sees, adds, names, shares and removes credentials
and sets a default for each harness. It replaces "Accounts & Keys".

**Owns:** `apps/web/src/features/credentials/` (new: the page and its dialogs); removal of
`apps/web/src/features/settings/sections/{accounts,key-sharing}.tsx` (the personal AI
accounts and key-sharing sections; `use-on-my-machines.tsx`, the D11 checkbox, stays and moves
onto the page); the role editors in
`apps/web/src/features/settings/sections/{shared,sessions,superagent,workllm}.tsx`.

**Consumes:** Task 4; `CREDENTIAL_TYPES` and `INFERENCE_ROUTES` (Task 1).

**Delivers:** the page; an "add" menu with a registration function that Tasks 9 and 14 use
for their entries; the role editors' credential picker.

**Acceptance:**
1. Component tests for the list states: ok; needs attention, with its reason; limit reached;
   expiring soon; granted to me, with the owner's name and no write actions; removal pending
   on a machine. A `revoked` credential is not listed.
2. Adding by paste works for each type whose `obtain` includes `paste`; after submitting, the
   secret is not shown again and the masked identity is.
3. Rename, renew and remove work; the removal dialog says, from the type's `revocation`,
   what is and is not withdrawn at the provider.
4. The share dialog requires the disclosure acknowledgement for every type and shows the
   further warning for a type with `sharing: 'warn'`; the grantee is a member or everyone;
   unshare works.
5. "Send to a machine" lists only machines the person can use and does not hold custody of,
   and requires the acknowledgement.
6. The default per harness can be set and cleared, and offers only credentials that harness
   accepts.
7. The role editors offer the credentials that have a direct-inference route.
8. The old accounts and key-sharing sections are gone and nothing links to them; the D11
   checkbox is on the page for each subscription login and still works.
9. A member who is not an admin can do all of the above for their own credentials.
10. Driven live: a member adds two Anthropic keys, names them, shares one with a second
    member, who sees it as granted, and sets a default. Screenshots at desktop and at phone
    width attached.
11. Lanes: the lean gate and the web tests, on a remote lane.

**Not in this task:** the add-subscription and ChatGPT entries (Tasks 9 and 14), anything on
a session (Task 18).

### Task 18: Credential controls on sessions

**Issue:** POD-6904. **Spec:** §9 "Choosing for a session", §7 "Health and renewal".

**Goal:** A person picks the credential when starting a session, sees it on every session,
and can switch it there.

**Owns:** the credential choice in the web composer and the new-session menu; the credential
on the session header; the switch action; the needs-attention and mismatch notices on a
session; the read-only label in `apps/mobile`.

**Consumes:** Tasks 10 and 11; `CredentialView`.

**Acceptance:**
1. The picker lists only credentials whose type the chosen harness accepts and that can
   reach the chosen machine, follows a change of harness or machine, starts on the person's
   default, and always offers the harness's own login (component test).
2. Every session shows its credential's label and kind (subscription, API key, token, or the
   harness's own login) on the web, and the label on the phone.
3. "Switch credential" lists the eligible credentials, asks "wait or interrupt" when a turn
   is running, and shows the outcome, including a handoff.
4. A session with `credentialMismatch` shows the warning (component test); a session whose
   credential needs attention shows why, with "renew" and "switch".
5. Driven live: the operator starts a session on one subscription and switches to another
   from the session; screenshots of the web and of the phone label attached.
6. Lanes: the lean gate and the web tests, on a remote lane.

### Task 22: Vault key in server transfer

**Issue:** POD-6923. **Spec:** §7 "Moving the server, and backups".

**Goal:** When the server moves to another machine, the ability to open the vault moves with
it, and stays behind nowhere.

**Owns:** the promote request and result in
`packages/protocol/src/messages/server-transfer.ts`;
`apps/server/src/modules/server-transfer/{service,types,journal}.ts`;
`apps/daemon/src/server-transfer.ts`; the transfer paragraph of `docs/data-and-upgrades.md`.

**Consumes:** `packages/runtime/src/vault-key.ts` and `Vault.exportDataKey` (Task 2);
`registry.daemonLinks.daemonLinkKind` (Task 23).

**Delivers:**
- A transfer whose target is on a `plain` connection is refused before the snapshot is made.
  A target that does not understand the key hand-over is refused in the same place when the
  vault holds a data key.
- The promote request carries `vaultDataKey` (or null when the vault has none). The target
  wraps it with its own key provider and writes it into the database it installed
  (`writeWrappedDataKey`). The field is excluded from logging, and neither side writes it to
  a journal, a staging file or the persisted promote input.
- The promote result carries `vaultCheck = vaultCheckValue(dataKey, transferId)`. The source
  verifies it before it finalizes; a mismatch fails the transfer the way a bad proof does.
- When the source finalizes, it deletes its own key file. A key file it cannot delete (a
  mounted secret) is reported and does not fail the transfer.
- A failed or rolled-back transfer leaves the target without the data key and without a key
  file it created for this transfer, and leaves the source unchanged.

**Acceptance:**
1. Moved (review focus 8): after a transfer between two state directories with real files, a
   credential sealed on the source opens on the target; the target's `vault_key.key_id` is its
   own provider's; its key file exists with mode `0600`; the source's key file is gone.
2. A target on a `plain` connection is refused and nothing was copied or staged.
3. Not written down (review focus 8): a search of the source's transfer journal, the target's
   staging and state files, and both logs finds the data key in no encoding (raw, hex,
   base64). The same search finds a deliberately written canary.
4. A target given a corrupted key returns a wrong check value: the transfer fails, the source
   is still the writable server with its key, and the target is cleaned.
5. A failure after the hand-over and before promotion completes rolls the target back: no
   wrapped key from this transfer and no new key file.
6. Promote sent twice gives the same result and one wrapped key.
7. An empty vault transfers; the target creates its own data key at its first seal.
8. A target without the capability is refused before the snapshot when the vault holds a
   data key.
9. The existing transfer tests pass; golden fixtures regenerated; the documentation paragraph
   describes the hand-over and a move by hand.
10. Lanes: the lean gate, and the integration or multi-instance lane that
    `docs/agents/testing.md` names for server transfer, on a remote lane.

**Not in this task:** switching the transfer offer on in the UI (POD-5969), the desktop
keychain.

---

## Phase 3: Acceptance

### Task 19: Live drive of the credential journeys

**Issue:** POD-6905. **Spec:** §16.

**Goal:** Every credential journey walked on a real instance built from the integration
branch, with two members, and each one evidenced.

**Needs the operator** for provider sign-ins.

**Acceptance:** each item has a screenshot or a transcript attached; every failure is filed
as a task under the acceptance phase and mailed to the coordinator.
1. The instance runs the tip of the integration branch (the commit is shown), on its own
   ports and state directory.
2. Upgrade: started from a copy of a state directory from before this epic that holds keys,
   the keys appear as credentials and sessions and title generation work without touching a
   setting.
3. A member adds a key and names it.
4. Two subscriptions for one harness on one machine, with a session running on each at the
   same time (Claude Code, then Codex).
5. Sign in with ChatGPT, then a Codex session on that plan.
6. A running session switched to another credential, continuing its conversation.
7. Direct inference on each route that exists.
8. A subscription shared with the second member (the warning is shown) and a key shared;
   the second member runs on both.
9. A credential that fails: the notice arrives in the tray and on the phone, the credential
   is renewed, and its session restarts.
10. A credential removed: a search of the machine shows nothing left, and its sessions
    stopped.
11. A daemon on another computer over `ws`: the warning on its row, and
    `connection-not-encrypted` when a credential is sent there.
12. Refusals read as written: one screenshot each for `not-yours`, `wrong-type` and
    `machine-not-allowed`.
13. The event log shows add, renew, remove, share, deliver, switch, refuse and attention
    events from the journeys above, none containing a secret.

### Task 20: Security review of credential handling

**Issue:** POD-6906. **Spec:** §14, and the sections each area names.

**Goal:** An independent review of how secrets are stored, moved, shared and renewed, on a
different model from the implementers, before the work lands. The reviewer reads and tests;
it does not change product code.

**Areas**, each with the question to answer:
- The vault (§7): can a stored secret be read without the outside key, moved to another row,
  or opened after a reset? Is a nonce ever reused? Is the key file ever readable by others?
- The connection rule (§8): can a daemon, a header or a proxy make the server classify a
  plain connection as safe?
- Delivery (§8): can a secret reach a log, a journal, a crash report, a queued command or a
  client-visible record? Does any refusal path start a session on another login?
- Who may use what (§12): is the grant checked at every launch, revival, switch and direct
  call? Can an agent principal add, renew, remove or share? Can a member or an admin reach
  another person's credential or notice?
- Homes (§10): can one session read another home's login through Podium? Is anything left
  after removal?
- Sign in with ChatGPT (§11): `state`, PKCE, the loopback relay, the pasted address, token
  storage, two renewals at once.
- The transfer (§7): the data key in journals or staging files, the check value, rollback.
- The legacy import and the destruction of old values, including Podium's upgrade snapshots.
- What a taken-over daemon can ask the server for.

**Acceptance:**
1. A report is attached to the task with one section per area: the commit reviewed, the
   files read, what was tried, and each finding with severity, the steps to reproduce it and
   a suggested fix, or "no finding".
2. Every finding is filed as a task under the acceptance phase, or has a written reason why
   it stands, agreed with the coordinator by mail.
3. A second, short pass covers Task 21's destruction step once that has landed; the report
   is updated. The task closes after both passes.
4. No product code was changed by the reviewer.

### Task 21: Legacy account code removal

**Issue:** POD-6907. **Spec:** §7 "Old plaintext is destroyed", §18.

**Goal:** The old account code is gone, and the keys that were stored in plain text exist
nowhere Podium controls.

**Owns:** the destruction step in `apps/server/src/modules/credentials/legacy-import.ts`;
the `accounts` repository; `apps/server/src/accounts.ts`; `packages/commands/src/accounts/`;
`apps/server/src/modules/accounts/` except `native-login.ts` (moved by Task 9);
`account_machine_sends` readers;
the three `apiKeys.*` secret keys; `AccountView`; `apps/web/src/lib/accounts.ts`;
`managed-harness-pairing.ts`; `credentialEnv` and `decodeAccount`; the documents that
describe the old model; the upgrade note in `docs/data-and-upgrades.md`.

**Delivers:**
- The destruction step, at server start after the import, under the `2027-05` header: an old
  value (the secret of an `accounts` row, an `apiKeys.*` secret) is overwritten only after the
  credential made from it opens from the vault to the same value; then the database is
  compacted with `secure_delete` on.
- The same for each upgrade snapshot Podium keeps in the state directory
  (`podium.db.backup-*`): the old values, and the plain values of the two sealed server
  secrets, are removed from a copy, the copy is checked with SQLite's integrity check, and it
  replaces the snapshot atomically. Partial and unreadable snapshots are left and reported.
- The `accounts` table is emptied and stays until the import is removed (a direct upgrade
  must still be able to read it). Everything else under "Owns" is deleted.

**Acceptance:**
1. An old value is destroyed only after its credential opens to the same value; a value whose
   import failed is left in place and reported in the log.
2. After the step, the bytes of `podium.db` and of its sidecar files do not contain any of
   the planted old values: the `accounts` key, the Claude token, the three `apiKeys.*`
   secrets, the Linear key and the Telegram token.
3. Snapshots (review focus 9): after the step no retained snapshot contains a planted value;
   each passes the integrity check and opens with its original schema; a crash in the middle
   leaves the old or the new file and never a broken one; a `.partial-` file is untouched.
4. A second start does nothing.
5. `git grep -w` for each deleted name finds nothing outside the marked legacy readers and
   `docs/superpowers/`.
6. `git grep -n "LEGACY(remove-after:"` shows exactly the three kinds of "Code with a removal
   date", each with its header text.
7. The upgrade note says: backups made before the upgrade still hold the keys; restoring one
   of Podium's snapshots with the previous version means adding keys again; and to replace a
   key at its provider when an old backup cannot be trusted.
8. `scripts/rehearse-upgrade.ts` passes against a copy of a state directory from before this
   epic that holds keys, on a remote lane.
9. Lanes: the store shard and the lean gate, on a remote lane.

---

## Order

| Task | Waits on |
|---|---|
| 1, 2, 6, 7, 16, 23 | nothing |
| 3 | 1, 2 |
| 4 | 1, 2 |
| 5 | 3, 23 |
| 22 | 2, 23 |
| 17 | 4 |
| 12 | 3 |
| 10 | 5 |
| 8 | 5, 6 |
| 13 | 4, 17 |
| 9 | 8, 4, 17 |
| 14 | 4, 7, 12, 17 |
| 11 | 10, 8, 6 |
| 15 | 14, 5, 8 |
| 18 | 10, 11 |
| 19 | 9, 11, 12, 13, 15, 16, 18 |
| 20 | 5, 9, 13, 14, 15, 22 |
| 21 | 19 |

Files more than one task edits, and who goes first:

- `session-start.ts`, `session-revival.ts`, `launch-config.ts`: 3, then 5, then 10, then 11.
- `apps/server/src/modules/credentials/may-use.ts`: 3 and 4; the first to land creates it.
- `packages/model/src/ids/keys.ts` (`credential` in `EntityKind`): 16 adds it, 4 rebases onto it.
- `apps/server/src/modules/credentials/legacy-import.ts`: 2, then 4 (one function), then 21.
- `apps/server/src/gateway/ws-server.ts`: 23, then 5.
- `apps/daemon/src/control/session.ts`, `host-runtime.ts`: 5, then 8, then 15.
- `packages/protocol` messages and golden fixtures: 1, 5, 8, 10, 14, 22. Regenerate after
  rebase.
- Drizzle migrations: 2, 3, 10, 16, and 4 if it needs one. One migration each; regenerate the
  snapshot after rebase.
- `docs/configuration.md`, `docs/data-and-upgrades.md`: 2, 23, 22, 21, one paragraph each.
- `apps/web/src/features/credentials/`: 17 owns the page; 9 and 14 add their own
  subdirectories and one line in the "add" menu.
