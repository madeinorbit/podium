# Credential management — design

Issue: POD-6857. Base branch: `dev/mw`.

This document says how Podium should hold a person's access to AI providers (API keys,
subscriptions, later Podium's own inference) and hand it to whatever needs it. It ends with the
set of features to ship first and the things to measure before building.

Words used here, each with one meaning:

- **Credential**: one piece of access a person gave Podium. "My work Claude Max", "the team's
  Anthropic API key".
- **Harness**: an agent program Podium runs (Claude Code, Codex, Grok, opencode, Pi, Cursor).
- **Direct inference**: Podium calling a model itself, without a harness (titles, summaries, the
  issue assistant, later transcription).
- **Machine**: a computer running a Podium daemon.

---

## 1. The problem

A person has several ways to pay for model usage: API keys billed by the token, subscriptions
that only work inside one vendor's own program, and soon inference bought from Podium. They
have several machines. They run many sessions at once. Podium has to answer four questions for
every session and every model call:

1. Which access should this use?
2. Is that access allowed to be used here? (A Claude subscription may run Claude Code. It may
   not be put into another vendor's tool.)
3. How does the secret get to the process that needs it, without leaving copies behind?
4. Is the access still good, and who has to act when it is not?

Today each of these is answered in a different place, by a different rule, and some are not
answered at all.

## 2. What exists today

Read from `dev/mw` on 2026-11-13. The multi-user work (POD-6300, POD-6360,
`docs/design/multi-user-instance.md` §2.4–2.5) already made provider connections personal.
This design keeps its rules and replaces its storage and plumbing.

| Area | What is there | What is wrong with it |
|---|---|---|
| Stored credentials | Table `accounts`, one row per owner and connection (`owner_user_id`, `account_key` such as `managed:anthropic`, `managed:claude-oauth`, `managed:anthropic:earlier-workspace`). Sharing by a list on the row (`shared_with`, `"*"` for everyone). A member sends a connection to a machine they only use (`account_machine_sends`). The old `apiKeys.*` server secrets were moved into it. | Not encrypted. One key per provider and person (the key is the provider name). Sharing is a list on the row instead of the grant record machines use. Ids still mix mechanism and provider. |
| Rules already decided | A run uses the initiating member's own selected connection and never falls back to someone else's. Native logins on a machine belong to its custodian and are never used for anyone else. Running on someone else's machine needs the runner's own connection, sent there, with a warning. The D11 checkbox lets a person use a native login on all machines they hold custody of. | These stay. This design builds them on the credential record, the grant record and the resolver. |
| Logins made in a harness | Each daemon reports who its harnesses are logged in as. The server groups them by identity (`login-catalog.ts`) and can copy a login to another machine of the same owner that is logged out (`login-propagation.ts`). | Only one login per harness per machine. Copying a self-renewing login to a second machine makes two copies that can log each other out. |
| Choosing | Per-role default in personal settings (`roles.<role>.accountId`). A session stores the id it launched with and gets the same one when revived. | No choice per session. No way to change a session's credential. The id is a made-up string (`native:claude-code:<fingerprint>`, `managed:anthropic`) that mixes mechanism, harness and identity. |
| Handing over | Stored credentials become environment variables on the spawn message (`resolveAccountEnv`, `credentialEnv`). The daemon removes competing variables it inherited (`foreignCredentialEnv`). | The secret rides in a plain message field. Nothing records where a secret was sent. The map from credential to environment variable is one hard-coded function. |
| Direct inference | `llm.ts` for API keys; Codex-subscription calls run on the machine that holds the login (POD-4750). | Resolves credentials through a different path (`roleApiBackend`, `apiKey(provider)`) than sessions do. A selected Claude subscription cannot serve it. |
| Health | Login state per machine; quota panels per harness. | No expiry, no "this credential stopped working", no renewal path that keeps the selections pointing at it. |

Two earlier documents shaped this design and stay valid where they are not replaced here:
`docs/design/managed-accounts-and-environments.md` (the refresh-rotation problem, the cost of
moving a harness's home) and `docs/2026-08-04-cross-machine-login-catalog.md` (identity
fingerprints, use the real home, propagation).

## 3. The design on one page

Four things, and nothing else:

1. **Credential** — a record: who owns it, what type it is, where its secret lives, whether it
   is healthy. The secret is never part of the record a client sees.
2. **Credential type** — code, not data. It says what a kind of credential *is*: an Anthropic
   API key, a Claude subscription token, a ChatGPT login. It knows how one is obtained, whether
   it expires or renews itself, and whether it may be shared.
3. **Consumer** — anything that uses access: a harness, direct inference, later a proxy or a
   sandbox. Each consumer declares which credential types it accepts and how it wants each one
   delivered.
4. **Resolver** — one function. Given a consumer, a credential and the person acting, it either
   returns a plan for handing the secret over or a refusal with a reason a person can read.

Five rules hold everything together:

- **R1. One path.** Every use of a credential — session launch, revival, switching, direct
  inference, model listing, quota checks — goes through the resolver. There is no second way to
  get a secret.
- **R2. Types say what they are; consumers say what they accept.** Whether a credential can be
  used somewhere is the match between the two. Nobody maintains a compatibility table, and a
  pairing no consumer declared cannot be selected at all.
- **R3. One keeper per login.** A login that renews itself lives in exactly one place. Sessions
  receive tokens derived from it, or run where it lives. They never get a second copy that can
  renew.
- **R4. Podium knows where it put things.** A secret leaves the server only for a named
  session, to one machine its owner allowed, over an encrypted connection. Whatever Podium creates on a machine that
  outlives a process is recorded, so it can be removed.
- **R5. Launch proves what it used.** Competing sources are removed before the harness starts,
  and where the harness can say who it is logged in as, Podium compares that with the choice.
  A chosen credential that cannot be used is refused. A session never falls back to another
  login silently.

The rest of this document is these four things and five rules applied to the four parts of the
request: giving access, keeping it, moving it, using it.

```
 person ──adds──▶ Credential ──typed by──▶ Credential type
                      │                          │ "what I am"
                      │ chosen for               ▼
                      ▼                    ┌──────────┐      plan: env or home, or a route for a model call
              session or model call ─────▶ │ Resolver │ ───▶ or refusal: wrong type, not yours,
                      ▲                    └──────────┘      needs attention, not on this machine
                      │ "what I accept"          ▲
                  Consumer ──────────────────────┘
```

## 4. The credential record

```
credentials
  id             cred_<uuid>            minted by the server; means nothing by itself
  owner_user_id                         the person it belongs to
  label                                 the name the person gave it
  type                                  a key into the type registry, e.g. anthropic.claude-token
  identity       json, no secrets       provider account fingerprint, email, plan, organisation
  status         ok | attention | revoked
  status_reason, expires_at, verified_at, created_at, updated_at

credential_secrets                      only for types stored in the vault
  credential_id, version, ciphertext, nonce, key_id, created_at

credential_placements                   what Podium created on machines (rule R4)
  credential_id, machine_id, kind (home | propagated-file),
  state (present | removal-pending | removed), created_at, removed_at

credential_machines                     machines the owner allowed beyond their own (section 8)
  credential_id, machine_id, allowed_by, created_at
```

Notes:

- **Any number per provider.** Two Claude subscriptions and three Anthropic keys are five rows.
- **Who else may use it is not a field.** It is a grant, the same record that already shares
  machines between people (section 12).
- **A login found on a machine is also a credential.** When a daemon reports a harness login
  with an identity, the server creates one row for that identity the first time it sees it,
  owned by the machine's custodian. Which machines hold it is not copied into the row; it is read from the machine
  inventory the daemons already report, which stays the only source for that fact.
- **"No credential" is a real choice.** A session with no credential set uses whatever its
  harness is logged into on its machine. This is today's default and stays the default, so
  nothing changes for someone who never opens the credentials page. It is also the only option
  for harnesses that cannot report an identity.
- **The reference replaces `accountId`.** Sessions and role settings point at `credentials.id`.
  Existing values are migrated (section 18).

## 5. Credential types and consumers

A type is declared once, in code:

```ts
interface CredentialType {
  id: string                     // 'anthropic.claude-token'
  provider: string               // 'anthropic'
  title: string                  // 'Claude subscription token'
  store: 'vault' | 'home'        // encrypted on the server, or a login in a harness home
  renewal?: 'none' | 'expires' | 'podium'   // vault types only; a home login is renewed by its harness
  obtain: Array<'paste' | 'harness-sign-in' | 'found-on-machine' | 'oauth' | 'issued'>
  sharing: 'free' | 'warn'       // 'warn': an additional warning before sharing it (section 12)
  identify(secret): Identity     // non-secret facts for display and matching
  verify(secret): Promise<Health>// one cheap call that says whether it works
}
```

A consumer declares what it takes. A harness does it in its adapter, next to the credential
knowledge that already lives there:

```ts
// Claude Code adapter
accepts: [
  { type: 'anthropic.api-key',      deliver: { env: 'ANTHROPIC_API_KEY' } },
  { type: 'anthropic.claude-token', deliver: { env: 'CLAUDE_CODE_OAUTH_TOKEN' } },
  { type: 'anthropic.claude-login', deliver: 'home' },
],
hideFromCommands: { env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } },
```

`hideFromCommands` is what the adapter sets so that the commands the agent runs do not inherit
the credential, where the harness has such a switch (Claude Code's subprocess scrub, Codex's
shell environment policy). It prevents accidents. It is not a barrier (section 14).

Direct inference declares routes the same way:

```ts
{ type: 'anthropic.api-key',     route: { http: 'anthropic-messages' } }
{ type: 'openai.api-key',        route: { http: 'openai-chat' } }
{ type: 'openrouter.api-key',    route: { http: 'openai-chat', base: 'openrouter' } }
{ type: 'openai.chatgpt-login',  route: { onMachine: 'openai-responses' } }   // exists today
{ type: 'openai.chatgpt-plan',   route: { http: 'openai-responses' } }        // section 11
{ type: 'anthropic.claude-login',route: { harnessOneShot: 'claude-code' } }   // section 19, S5
```

A secret reaches a harness in one of a closed list of ways. The first two are built in this
epic; the last two are named so later work has a place to go.

| Delivery | What happens | Good for |
|---|---|---|
| `env` | Set as an environment variable when the process starts. Never written to disk. | API keys, tokens. |
| `home` | Nothing is moved. The harness starts with its configuration directory pointed at the home that holds the login: its default one, or one Podium created for that login (section 10). | Subscription logins, any number per harness per machine. |
| `helper` (later) | The harness asks Podium for a fresh token whenever it needs one. | Tokens that live minutes or hours. |
| `endpoint` (later) | The harness is pointed at a local Podium address with a per-session token; Podium attaches the real secret outside the agent's reach. | Podium inference, running one harness on another provider, keeping the secret from the agent. |

A direct model call takes one of three routes:

| Route | What happens | Good for |
|---|---|---|
| `http` | The server calls the provider with the decrypted secret. | Keys, and a ChatGPT plan. |
| `on-machine` | The call runs on the machine whose home holds the login; only the answer comes back. | A Codex login. |
| `harness-one-shot` | The harness itself answers once, with its tools switched off, in the home that holds the login. | A Claude subscription, which may only be used inside Claude Code. |

Copying a login file to a logged-out machine (propagation) is not a delivery. The resolver
never chooses it. It is an existing background mechanism that this design leaves as it is and
records (section 8).

The types in this epic:

| Type | What it is | Stored | Renewal | Accepted by |
|---|---|---|---|---|
| `anthropic.api-key` | Anthropic API key | vault | none | Claude Code; direct inference |
| `anthropic.claude-login` | A Claude subscription signed in through Claude Code | home | by Claude Code | Claude Code on that machine; direct inference through Claude Code's one-shot mode on that machine |
| `anthropic.claude-token` | Token from `claude setup-token` (one year, model requests only) | vault | expires | Claude Code on any allowed machine |
| `openai.api-key` | OpenAI API key | vault | none | Codex; direct inference |
| `openai.chatgpt-login` | A ChatGPT subscription signed in through Codex | home | by Codex | Codex on that machine; direct inference through that machine |
| `openai.chatgpt-plan` | A ChatGPT plan signed in to Podium itself (section 11) | vault | by Podium | direct inference; Codex's server driver on any allowed machine |
| `openrouter.api-key` | OpenRouter key | vault | none | direct inference; any harness whose adapter accepts it |
| other harness logins and keys | Grok, opencode, Pi, Cursor | as each adapter declares | | that harness |

Adding a provider, a harness or a new kind of access is a new type or a new `accepts` line. No
table, picker or resolver changes.

## 6. Giving access

Four ways a credential comes into being. Each type lists which apply.

1. **Paste.** For API keys and for the Claude subscription token. The server verifies it with
   one cheap call, stores it, and shows only a masked form afterwards. For the token the person
   runs `claude setup-token` in a terminal of their own and pastes the result. Podium does not
   run that command in one of its terminals, because the token would be printed into terminal
   output that Podium stores.
2. **Run the vendor's own sign-in.** For subscriptions. Podium opens a terminal on a machine the
   person picks and runs the harness's own sign-in inside a home made for that login (section
   10). The person completes the browser step. The login stays in that home; Podium never reads
   it out. The login-terminal machinery for this exists (`accounts.login`).
3. **Found on a machine.** A login the person already made in a harness appears by itself,
   marked with the machines it is on. Nothing is copied.
4. **Sign in through the provider.** Where a provider has an official way for a product like
   Podium to get access, Podium is the registered application and holds the grant itself. This
   is a type with `obtain: ['oauth']` and `renewal: 'podium'`. OpenAI's "Sign in with
   ChatGPT" is in this epic (section 11); OpenRouter's key flow is the other one that exists.

Podium Cloud access is a fifth way, `issued`: linking a Podium account creates the credential.

Podium does not imitate a vendor's sign-in. It runs the vendor's program or uses the vendor's
published flow.

## 7. Keeping it

### Where a secret lives

Two places, chosen by the type:

- **In the vault.** The secret is in the server's database, encrypted. It can be used on the
  machines its owner allows (section 8). API keys and tokens.
- **In a home on a machine.** The secret stays in the harness's own files on the machine where
  the login was made. Podium keeps the record and the identity, not the secret. This is the
  choice for someone who does not want a secret to leave their computer, it is the only correct
  place for a login the harness renews itself (rule R3), and it is the form of Claude
  subscription that Anthropic's page describes for products (section 12).

### Encryption

- Each stored secret is encrypted with AES-256-GCM under a random data key. The credential's
  id, type and version are bound into the encryption, so a ciphertext cannot be moved to
  another row or passed off as another type.
- There is one data key. It is stored in the database encrypted by an **outside key**, which
  comes from outside the database, behind one small interface with three sources:
  - **Self-hosted server:** a file with owner-only permissions at
    `~/.config/podium/vault-<instance>.key` (under `$XDG_CONFIG_HOME` when set). The state
    directory is `~/.podium`, and it is what gets copied, backed up and moved to another
    server, so the key is deliberately not in it. `PODIUM_VAULT_KEY_FILE` points at another
    path, which is how a container or a service manager hands in a mounted secret. The key is
    never passed as an environment value.
  - **Desktop app:** the operating system's keychain. No file.
  - **Podium Cloud:** a key service.
- On one computer under one user this separation protects copies of the state directory and of
  the database. It does not stop someone who can read that user's files.
- The server decrypts a secret at the moment of use and does not keep the plaintext.
- **Old plaintext is destroyed.** When the existing keys move into the vault, their old values
  are overwritten and the database is compacted, because SQLite otherwise keeps deleted values
  in unused pages. This happens only after each moved secret has been read back from the vault.
- **Podium's own upgrade snapshots are cleaned too.** Before a schema change the server copies
  the database into the state directory and keeps the newest three copies. Those copies hold
  the old keys, so the same step removes the old key values from each of them and checks that
  the copy is still a sound database. The cost: someone who restores such a copy with the
  previous version has to add their keys again. Backups the operator made themselves are out of
  Podium's reach, and the upgrade notes say so.
- What this does and does not protect against is in section 14.
- Losing the outside key means credentials have to be added again. Nothing else is lost.

### Moving the server, and backups

The outside key is kept apart from the state directory, so anything that moves the server has
to move the ability to open the vault as well.

- **Server transfer.** Podium's own transfer copies the database to the target machine. The
  data key goes with it:
  - It travels in the transfer's promotion step in a field of its own, not as a file in the
    copied package, and only over a connection that meets the rule in section 8. A target on a
    connection that is not encrypted is refused before anything is copied.
  - The promotion goes only to a daemon connected when it is sent, over such a connection. It
    is never queued for a target that went offline: nothing is sent, and the transfer aborts.
    Otherwise a delayed promotion could deliver the key, and commit, after the transfer had
    given up.
  - The target encrypts the data key under its own outside key (its own key file or keychain)
    and writes the result into the database it has just received. The outside key itself never
    leaves the machine it was made on.
  - The target proves it can open the vault before the source gives up the server role. When
    the source finalizes the transfer it deletes its own key file, so the old server keeps no
    way into the vault.
  - If the transfer fails or is rolled back, the target removes what it received and the source
    is unchanged.
  - The data key is never written to the transfer's journals or staging files on either side.
- **Moving or restoring by hand.** Someone who copies the state directory to another computer
  copies the key file as well; the documentation names the file. A database restored without
  its key starts normally and shows every stored credential as "needs attention".
- **Backups.** Back up the key file separately from the state directory. A backup that holds
  both is as sensitive as the keys themselves.
- The same primitive covers two other server secrets (the Linear key and the Telegram token).

### Health and renewal

Every credential has a status a person can read: **ok**, **needs attention** (with the reason),
**revoked**.

| Kind | How Podium keeps it healthy | When the person must act |
|---|---|---|
| vault, no renewal | Verified when added and when a call is rejected. | The provider rejects it. |
| vault, expires | Expiry is recorded when added. A warning goes out two weeks before. | Before expiry: run the same command again. |
| a login in a home | Nothing. The harness renews its own files. Podium reads the login state the daemon reports. | The harness reports logged out. |
| vault, renewed by Podium | The server renews on schedule, as the only renewer. | The provider withdraws the grant. |

When a session or a call fails because the credential was rejected (the error classifier for
"not logged in / token expired" exists), the credential moves to **needs attention** and every
session using it shows why it stopped with two actions: renew, or switch to another credential.

The owner is told through the notification inbox (section 13).

**Renewing keeps the id.** Renewal replaces the secret under the same record, so every default
and every session that pointed at it keeps working. Sessions that received the old secret by
`env` are restarted with resume once the new one is in.

## 8. Moving it

### What crosses the wire

A message that starts a process for a session (a spawn, a turn of a server-run driver, an
engine start) stops carrying credentials mixed into its plain environment values. It carries
an **access** field: the credential id, the delivery the resolver chose and, for `env`, the
secret.

- **Only over an encrypted connection.** A daemon reaches the server over `wss`, or over a
  connection that never leaves the computer. Podium already requires `https` for its public
  address unless it is loopback; the daemon's connection gets the same rule. There is no second
  layer of encryption around the secret: if the connection could not be trusted, the session's
  content and the daemon's own sign-in would be exposed too, so the connection is what has to
  be secure.
- **The server judges the connection.** When a daemon connects, the server works out what
  kind of connection it is from how the request reached it (the same check it already applies
  to sign-in tokens, including a proxy it was told to trust). It does not take the daemon's
  word for it.
- **Plain connections stop carrying credentials at once and are retired.** A daemon that is
  connected over plain `ws` to another computer keeps working until the removal date with a
  warning on the machine's row and in the daemon's log, but a credential is refused for it
  (`connection-not-encrypted`). An operator whose machines talk over a private encrypted
  network (a VPN such as Tailscale) can declare that network trusted, which lifts the refusal
  for it.
- **The retirement has a date in the code.** The code that still accepts a plain connection
  carries the repository's removal marker, `LEGACY(remove-after: 2027-02)`. After that date it
  is deleted, and a daemon connects over `wss`, a same-computer connection or a trusted
  network, or not at all. The other compatibility code in this epic is marked the same way
  (section 18).
- **Memory only.** The daemon keeps the secret in memory for as long as that session lives,
  because some drivers start a new process for every turn. It never writes it to a journal, a
  log or its state directory. When the daemon restarts the secret is gone; the server sends it
  again when the daemon reconnects, for the sessions that are still alive, and on every
  revival.
- **Never queued.** A credential command that cannot run now does not run. The command
  contracts already have this class (`online-sensitive`).
- **Never logged.** Messages that carry an access field are excluded from logging by type, not
  by a list of field names.
- **Not for older daemons.** A daemon that does not announce support is refused. It is never
  started on the machine's own login instead.
- **A copied login file follows the same rule.** Propagation is not a delivery, but the file it
  copies is a whole sign-in. It is exported only from a daemon whose connection is encrypted or
  stays on the computer, and installed only on such a daemon; a plain connection, or one the
  server has not judged, copies nothing and the refusal is logged. Neither request is queued
  for a machine that is offline, and both are named by type only in a log (POD-6906 S2).

### Which machines may receive a credential

On a machine, a secret in a process's environment and a login in a home can be read by whoever
controls that machine, and by any other agent running there under the same operating-system
user. So where a credential goes decides who can obtain it.

- By default a vault secret is delivered, and a home is created, only on machines the
  credential's owner holds custody of (the machine grant with `custody`). Admin rights over a
  machine do not count.
- Any other machine needs the owner's explicit yes for that credential and that machine
  ("send it there"), given next to the plain statement that everyone running on that machine's
  operating-system account will be able to read it. This is the existing
  `account_machine_sends` rule, now `credential_machines`.
- **No credential** means the harness's own login on the machine, and that login belongs to
  the machine's custodian. So "no credential" is only valid for the custodian; anyone else
  running there must choose one of their own (`own-credential-required`).
- Pairing a machine grants it nothing.
- A direct model call made on the server (`http`) discloses nothing to any machine.

### What Podium leaves on machines, and cleanup

| What | Recorded as | Removed when |
|---|---|---|
| A secret in a session's processes | The session itself (it names its credential and its machine). | The session's processes end. Nothing is on disk. |
| A home Podium created for a login | A row in `credential_placements`. | The credential is removed: Podium runs the vendor's sign-out in the home, then deletes it. Also when the machine is unpaired. |
| A login file copied by propagation | A row in `credential_placements`. | The credential is removed, or the machine is unpaired. |
| A login the person made in a harness's default home | Not Podium's. Shown, never deleted by Podium. | The person signs out there. |

**Remove everywhere** is one action on a credential:

- the stored secret is deleted;
- every machine with a placement is told to remove it, and a machine that is offline keeps the
  placement as "removal pending", visibly, until it confirms;
- sessions still running on it are flagged and stopped at their next turn boundary;
- who did it is written to the event log.

**Removing is not always revoking.** Where the provider offers it, removal also withdraws the
access at the provider: the vendor's sign-out for a home, OpenAI's revocation call for a
ChatGPT plan. An API key or a Claude token stays valid at the provider until the person revokes
it there, and the dialog says so.

When a member is removed from the instance, their credentials are removed everywhere and the
access they shared ends with them.

## 9. Using it

### The resolver

```
resolveAccess({ consumer, credentialId | none, actingUser, machine? })
  → plan     { delivery }                    // or { route } for direct inference; never the secret
  → refusal  not-found | not-yours | wrong-type | not-on-this-machine | machine-not-allowed
             | own-credential-required | needs-attention | revoked | daemon-too-old
             | connection-not-encrypted | machine-offline
```

It checks, in order: the credential exists and is not revoked; the acting person owns it or has
been given use of it; the consumer accepts its type; it can reach the machine in question and
its owner allows that machine; it is healthy. The refusal reasons are a closed list and each
has one sentence a person sees. `machine-offline` is raised only when no daemon is connected at
the moment a secret would be sent (a race after the launch's own online check, a revival, a turn
or a refresh); a launch on a machine that is offline is refused earlier with the launch's own
sentence.

The plan never contains the secret. Only the step that sends it to a daemon, and the provider
call itself, read it from the vault. A refusal is final for that launch: a session is never
started on the machine's own login because the credential it was given could not be used.

It replaces `resolveAccountEnv`, `credentialEnv`, `selectHarnessAccountId`,
`nativeAccountIdForMachine`, `decodeAccount`, `roleApiBackend` and the `apiKey(provider)`
callback.

### Choosing for a session

Order: what the launch asked for, then the person's default for that harness, then none (the
harness's own login on the machine).

- **Default per harness** is a personal setting. It replaces today's rule where one account on
  the coding role is silently swapped out when the session uses a different harness.
- **At launch** the composer shows the credential next to model and effort, filled with the
  default. It lists only credentials the harness accepts and that can reach the chosen machine.
  The CLI takes `--credential <label or id>` on `podium agent spawn`, `podium issue start` and
  `podium issue add-session`.
- **On the session** the credential's label and type are visible, so a person can see at a
  glance whether a session spends a subscription or bills by the token.
- **Agents choose, people manage.** An agent that starts a session may name any credential the
  person it acts for can use, by its label. Adding, renewing, removing and sharing credentials
  are for people only.

### Launching

```
server                                             daemon
  resolve(harness, credential, person, machine)
  ── spawn { …, access } ────────────────────────▶ keep it in memory
                                                    remove competing variables (exists today)
                                                    apply delivery (set env / point the harness at its home)
                                                    start the harness
  ◀── started { how it authenticated, identity } ── read back what the harness says, where it can
  compare with the choice; flag a mismatch
```

The read-back matters because a harness picks its own credential from several places, and a
wrong pick still produces a working session that bills someone else. The daemon already removes
inherited keys (POD-2296); the Codex server driver already asks the harness which login it
chose. This epic reports what was delivered for every launch and the harness's own
answer where one exists.

### Switching a session to another credential

One command, `sessions.switchCredential({ sessionId, credentialId })`:

1. Resolve the new credential for the session's harness and machine. Refuse with the reason if
   it does not fit.
2. Record it on the session.
3. If the session is running: stop the harness at a safe point (idle, or after the person
   confirms interrupting the turn) and start it again through the existing revival path, which
   resumes the same conversation and now receives the new credential.
4. If the session is stopped or hibernated: nothing more. The next wake uses the new one.

**What carries over.** A conversation is a file the harness keeps on the machine. It is not
stored at the provider and it does not belong to an account, so the visible conversation
(messages, tool calls, results) can continue on another credential. Two things do not carry
over freely, and the switch handles both:

- **The model's hidden reasoning is tied to the account that produced it.** Anthropic's API
  drops earlier thinking blocks from another account without an error, so a Claude session
  continues and only loses the reasoning behind earlier turns. OpenAI's encrypted reasoning
  items are rejected when another account sends them (reported by users, not documented), so
  for Codex the switch resumes from a copy of the conversation with those items removed. If a
  harness cannot resume that way, the switch falls back to a new session opened with a handoff
  summary, and says so.
- **A different home has a different conversation store.** When the new credential lives in
  another home, Podium copies the conversation file into that home before resuming.

Switching to a different harness is a different operation (the existing session handoff) and
is not part of this.

### Direct inference

One entry point for every feature that calls a model without a harness:

```
complete({ credentialId | role, model, messages, tools? }) → { text, toolCalls, servedBy }
```

- A role (background work, superagent) names a credential and a model in personal settings. The
  picker offers every credential that has a direct-inference route, which now includes any
  number of keys per provider.
- The route decides where the call runs: on the server with the decrypted key, on the machine
  that holds a login, or through a harness's one-shot mode, with its tools switched off, for a
  subscription that may only be used inside its vendor's program.
- `servedBy` records which credential answered, so cost and quota are attributed to it.
- The three legacy `apiKeys.*` secrets become ordinary credentials and that store loses them.

## 10. Subscription logins: one keeper, and a home for each

This is the one hard constraint, so it gets its own section.

### The constraint

A subscription login made in a harness holds a renewal token that is replaced each time it is
used. Two copies that both renew invalidate each other, and one side ends up logged out.
OpenAI's developer documentation says the same of its own sign-in tokens: serialise renewals so
that concurrent processes do not race on a rotating token.

Claude Code's documented way to sign in a directory without a browser,
`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, does not copy a login either; it moves it. When a home was
signed in from another home's renewal token, the other home's next request failed ("OAuth
session expired and could not be refreshed"). Its status still read "logged in" until that
request, and then Claude Code removed its tokens (S7). Podium therefore never signs a home in
from an existing login, and judges a login's state by its last request, not by the status
command alone.

Rule R3 removes the problem instead of managing it: **the login has one keeper. Everything else
runs where the keeper is, or gets something that cannot renew.**

### Homes

Both vendors tie a subscription login to the harness's configuration directory, and both
describe one directory per account as the way to stay signed in to several accounts on one
computer: `CLAUDE_CONFIG_DIR` for Claude Code (Anthropic's authentication page, "Log in with
multiple accounts"; on macOS the Keychain entry is keyed to the directory too) and `CODEX_HOME`
for Codex.

A **home** is that directory, managed by Podium:

- One home per subscription login per machine, under Podium's state directory. The harness's
  default directory is the home Podium did not create; a login found there is used where it is.
- The person signs in once per home, through the vendor's own sign-in, run in a Podium
  terminal. The login stays in the home and the harness renews it there. The home is the
  keeper. Measured on Linux (S1): `claude auth login` prints a link and takes the code pasted
  back. Codex runs as `codex login --device-auth`, a link and a one-time code, because its
  default sign-in calls back to `localhost` on the machine it runs on, which a browser on
  another computer cannot reach. ChatGPT may ask the person to allow device codes in its
  security settings first.
- A session on that credential starts with the harness's directory variable pointed at the
  home. Podium's hooks reach it at launch, never as a file in the home (S2):
  - Claude Code takes them per session through `--settings`, as today.
  - Codex runs a handler only if it is trusted, and keys trust by the absolute path of the file
    that declares it, so a `hooks.json` in a new home is untrusted and silent. Podium therefore
    passes its handlers as `-c hooks.<Event>=[…]` and their trust as
    `-c hooks.state={"/<session-flags>/config.toml:<event>:<group>:<handler>"={trusted_hash=…}}`.
    Nothing is written to disk. The hash is Codex's own; the daemon reads it as `currentHash`
    from `hooks/list` once per Codex version and caches it. **Exception to POD-4076:** Podium
    supplies trust only for its own handlers, only at launch, and only in homes Podium
    created; in the person's default directory it still detects and reports, and never trusts.
- A home shares the person's harness settings, instructions, skills and plugins with the
  default directory by linking, so a second account does not behave like a fresh install.
  Both harnesses read through the links and write through them without replacing them
  (measured, S2). Linked from the default directory:
  - Claude Code: `settings.json`, `CLAUDE.md`, `skills/`, `agents/`, `commands/`, and
    `plugins/` as a whole (its records hold absolute paths into the default directory, so a
    copy would point back there anyway).
  - Codex: `config.toml` (which also carries MCP servers and project trust), `AGENTS.md` and
    `skills/`.

  Not linked:
  - Logins (`.credentials.json`, `auth.json`): they are what the home is for.
  - Conversations and harness state.
  - Claude Code's `.claude.json`. It holds the signed-in identity as well as onboarding state,
    folder trust and the person's user-scope MCP servers. Podium seeds a new home's copy with
    onboarding done and the folder trusted, which is otherwise a theme picker and trust prompt
    in front of the first turn. At each launch Podium copies the person's `mcpServers` into
    it.
- Conversations live in the home that ran them. Podium reads transcripts from every home and
  copies a conversation into the target home when a session switches (section 9).
- Each home reports its own login state, identity, quota and model list. A refused request
  counts as signed out even while the harness's status command still says signed in (S7).

So Podium does end up managing several Codex homes, and several Claude Code homes. There is no
other supported way to hold two subscription logins for one harness on one machine.

What it takes in the daemon, which today assumes one home (86 references in 17 files):

| Today | Needed |
|---|---|
| One harness home per daemon (`homeDir`, `credentialHome`, `accountHome`). | A set of homes, each belonging to one credential. Every use takes the home as an argument. The functions that turn a home into the harness's environment exist (`harnessInstanceHomeEnv`, `harnessLoginReadEnv`). |
| Inventory reports one login per harness. | One login per home. |
| The sign-in terminal runs in the daemon's home. | It runs in a chosen home. |
| Hooks are installed in one directory. | Installed per home at launch. The install already takes the directory. |
| Transcript discovery scans one home. | It scans every home. |
| One engine per session, run in the daemon's one home. | One engine per session, run in its session's home; removing a home stops them and Codex's managed daemon. |
| Quota and model probes read one home. | They read per home. |

### Who keeps what

| Situation | Keeper | What sessions get |
|---|---|---|
| A subscription used on the machine where the person signed in | The home on that machine. | The home. |
| The same subscription wanted on a second machine | A second home, signed in once on that machine. Each home is its own sign-in, so the two never collide. | The home on that machine. |
| A Claude subscription the person would rather not sign in to per machine | Nobody. `claude setup-token` yields a one-year token with no renewal, which Podium stores. | The token by `env`, on any machine. It can only make model requests, so features that need the full login (claude.ai connectors) are absent. |
| A ChatGPT plan signed in to Podium itself (section 11) | Podium's server, as the registered application. | A one-hour token, by `env`, replaced by restart-and-resume. |
| Existing propagation: a login file copied to a logged-out machine | Still the first machine. | A copy that can collide with the original. Kept as it is; OpenAI documents copying its login file to a headless machine. Signing in on the second machine is the better path once homes exist. |
| Podium Cloud inference (later) | Podium Cloud. | Short-lived tokens, by `endpoint`. |

## 11. Sign in with ChatGPT

OpenAI lets a product use a person's ChatGPT plan when the person signs in to that product.
For an open-source product no approval is needed: the product registers itself the first time
a person signs in. Podium is Apache-2.0. This is in the first release because it gives OpenAI
subscriptions two things homes cannot: direct inference through OpenAI's public API, and
Codex sessions on any machine without a login file there.

Facts, from OpenAI's developer documentation (read 2026-11-12, again 2026-11-13):

- Plans: Plus and Pro. The person can cap what each product may spend, in ChatGPT's settings.
- Sign-in is a browser flow that returns to `http://127.0.0.1:<port>/auth/callback`. No other
  return address is described, and there is no device-code variant.
- The product gets its own client id on first sign-in (it sends `dynamic_agent_client`, an app
  name and a stable host id), then an access token that lasts one hour and a renewal token that
  lasts 30 days and is replaced on every use.
- With the token a product may call `POST https://api.openai.com/v1/responses` (with `store:
  false` and `stream: true`) and list models. Chat Completions, file upload and transcription
  are not offered.
- Codex is driven through `codex app-server`, started with a provider that reads the token
  from an environment variable. A running process cannot take a new token: the documented way
  is to restart it with the new token and resume the thread.
- OpenAI does not tell the product when the person disconnects it. The product finds out when
  a call or a renewal fails.

Measured end to end from a self-hosted server on 2026-11-16 (Task 7): every step above works
as documented, Codex included. What the measurement added:

- A disconnect takes effect at once, for the unexpired access token as well. The disconnect
  is in ChatGPT Settings > Security and login > Login connections > Sign in with ChatGPT >
  the app > Manage connection > Disconnect. After it, `/v1/responses` and `/v1/models` answer
  `401` with `error.code` `token_revoked`. Renewal answers `400` with `invalid_grant` and
  `error_reason` `refresh_token_invalidated`. Codex retries five times and then fails the turn
  with a message that names `token_revoked`.
- Revocation through the discovered `revocation_endpoint` answers an empty `200`, also for a
  token that was already invalid. What it does to a live grant was not observed: the grant
  had already been disconnected.
- A plan-limit answer was not produced.

How it fits the model:

- **Type** `openai.chatgpt-plan`: stored in the vault, renewed by Podium, obtained by
  `oauth`. One credential per ChatGPT account; each has its own client id and tokens.
- **Sign-in.** The return address is the person's own computer, so the browser step runs where
  a Podium daemon or the desktop app can listen on that address, and hands the returned code
  to the server. Where nothing can listen (a phone, a browser with no local Podium), the person
  pastes the address their browser ended on. The server exchanges the code; the token set
  never passes through a daemon. The pasted address worked in the measurement, with the code
  exchanged seconds after the browser step. The attempt itself does not expire: state, nonce
  and verifier are Podium's own and were still valid days after the link was made. OpenAI's
  sign-in page is behind a browser check, so nothing but a browser can test the link in
  advance.
- **Host id.** Derived from the server's installation identity, the one host that renews.
  OpenAI accepts only `urn:ietf:params:oauth:jwk-thumbprint:…`, `urn:uuid:…` or `did:key:…`,
  so the installation id itself (`pdm_…`) cannot be sent. The host id is the RFC 9278
  thumbprint URI of the installation's Ed25519 public key,
  `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>`. It moves with the server
  because the key does.
- **Registration and later sign-ins.** The first sign-in returns the issued client id
  (`oaiapp_…`) and the granted scopes on the return address, next to `code` and `state`. A
  callback without a client id is an incomplete registration. Later sign-ins send the stored
  client id, no app name, and the retained ID token as `id_token_hint`. A callback that names
  a different client id is refused. The credential is usable for inference only if the granted
  scopes include `chatgpt.tokens.use.direct`; without it the sign-in is kept and the plan is
  marked not enabled.
- **What the credential can show.** The ID token gives the account's email, name and subject.
  It does not give the plan (Plus or Pro), and nothing else in this flow does: Codex's rate
  limit report on this provider has no plan type, no usage windows and no credits. The
  credential shows the email and "ChatGPT plan", and links to ChatGPT's usage settings for the
  rest.
- **Keeper.** The server renews ahead of expiry, one renewal at a time per credential, and
  stores each new token set as the next version. The token response carries
  `earliest_refresh_at` (six minutes before expiry). OpenAI does not enforce it: a renewal four
  minutes after issue succeeded. The keeper renews when fewer than five minutes are left, which
  falls after that time. A renewal that fails for a reason OpenAI lists as final moves the
  credential to **needs attention**. The final reasons are `invalid_grant`,
  `invalid_refresh_token`, `token_expired`, `refresh_token_expired`,
  `refresh_token_invalidated`, `refresh_token_reused` and `invalid_client`.
- **Direct inference.** A route for `openai-responses` on the server, with the restrictions
  above. The request carries `store: false`, `stream: true`, the whole conversation in `input`,
  and any system text in `instructions`. OpenAI refuses a system-role item, `stream: false` and
  `store: true` before the stream opens, with a 400 and a `{"detail": "…"}` body rather than
  OpenAI's usual error object. It also lists unsupported fields, among them
  `max_output_tokens`, `temperature`, `top_p`, `metadata`, `user` and `previous_response_id`.
  The stream is not labelled `text/event-stream`, so the adapter reads it as a stream because
  it asked for one. Success is `response.completed` and nothing less. A plan-limit answer
  (`subscription_sharing_usage_limit_exceeded`, 429, possibly as `response.failed` after the
  stream opened) is shown as "limit reached" with a link to ChatGPT's usage settings. OpenAI
  gives no reset time with it, so Podium does not invent one. It is not treated as a broken
  credential, and no other credential is tried silently.
- **Codex.** The Codex server driver accepts this type: the engine starts with OpenAI's
  documented provider settings and a token in its environment. Before the token expires, at a
  turn boundary, Podium restarts the engine with a fresh token and resumes the thread, the
  same stop-and-resume path a credential switch uses. The Codex terminal driver does not
  accept this type, so a session on it uses the server driver. Measured: a home with no Codex
  login answers a turn, and a new process with a replaced token resumes the thread and
  remembers the earlier turn. Neither process wrote a token or an `auth.json` into the home.
  The engine's `initialize` sends `clientInfo.name` equal to the app name used at
  registration. Codex 0.169 calls full-history resume deprecated, so resume passes
  `excludeTurns: true`.
- **Hosted Podium.** OpenAI's open registration is for open-source and locally run products;
  a paid or hosted product applies through OpenAI's form. That application is a business step
  outside this design.

Homes stay necessary alongside it: for Claude subscriptions, for the Codex terminal driver,
and for ChatGPT plans other than Plus and Pro.

## 12. Who may use what

### People

- A credential belongs to the person who added it. Members add, renew and remove their own.
- **Sharing is a grant**, the same record that already shares machines between people
  (`resource, grantee, verb`). `credential` becomes a kind of resource with two verbs: `use`
  (run sessions and model calls on it) and `manage` (rename, renew, remove, share).
- The owner can give `use` to another member or to all members. "All members" is the group
  grantee the grants design already names as a planned addition; connections shared with
  everyone today (`shared_with` `"*"`) need it on the first day.
- Like every grant it is checked at each use, not copied: take the grant away, or remove the
  person who gave it, and the access is gone at the next launch or call. A session may use a
  credential only if the person it acts for owns it or holds `use` on it.
- **Use means the other person can obtain it.** Until a broker keeps secrets out of processes
  (section 15), someone who runs a session on a shared key or token on their own machine can
  read it there. The share dialog says so for every type.
- **Sharing a subscription shows an additional warning, and is allowed.** Both vendors sell a subscription
  to one person, so the owner is told, before the grant is made, that sharing it may break the
  provider's terms and puts their account at risk. API keys share without a warning.
- Usage is attributed to the credential. That settles the open question in the multi-user
  notes about who is billed when Podium supplies a credential: its owner, who chose to share.

### Provider rules

Read from the providers' own pages on 2026-11-12.

**Anthropic** (Claude Code "Legal and compliance" and "Authentication"):

- A product may run the unmodified Claude Code program for its users. Each user signs in with
  their own subscription, API key or cloud-provider credential. The product may not modify the
  program, remove a sign-in method, or pay for, resell or sit between the user and their Claude
  usage.
- A product may not offer Claude.ai sign-in inside its own application, route requests through
  a user's plan credentials, or collect, store or pass along Claude.ai credentials or session
  tokens. Sign-in must complete through Anthropic's own flow.
- Products built on the Agent SDK should use API keys.
- `claude setup-token` is for CI and scripts: a one-year token the user sets wherever they
  want to authenticate.

**OpenAI** (Codex "Authentication"; "Sign in with ChatGPT"): see section 11. Codex's own login
is a file under `CODEX_HOME`, and the documentation describes copying it to a headless
machine. The environment access token (`CODEX_ACCESS_TOKEN`) is for ChatGPT Enterprise
workspaces whose admin allows it, and is not a general route.

**Operator decision, 2026-11-12.** Podium stores a person's Claude `setup-token` token and
copies logins between that person's machines on hosted instances as well as self-hosted ones,
as other products in this market do. This goes further than Anthropic's wording above allows a
product. It is written down here so the choice is visible and can be revisited in one place:
the type entries for `anthropic.claude-token` and for propagation.

What follows for this design:

| Element | Consequence |
|---|---|
| A Claude subscription as a login in a home, signed in through Claude Code | The shape Anthropic's page describes. |
| A Claude subscription token stored by Podium; propagation | Offered everywhere, by the decision above. |
| Direct inference on a Claude subscription | Only by running Claude Code itself in one-shot mode. Never by calling the API with the login. |
| Inference paid by Podium driving Claude Code | Anthropic's page does not allow it without an agreement. Podium-paid inference can serve direct inference and other harnesses. |
| The existing Claude SDK driver on a subscription | Governed by `docs/architecture/claude-subscription-oauth-policy.md`. This design does not depend on that driver. |
| A ChatGPT subscription | Signed in to Podium (section 11), or in a home through Codex's own sign-in. |
| API keys | Anything that accepts them. |

Which credential may go where is not a setting. It is which consumers declare the type.

## 13. The notification inbox

POD-6881, part of this epic. A credential that stops working needs to reach its owner, and
today nothing in Podium can tell one person something: a mention in an issue comment from
another member reaches nobody. Rather than a surface for credentials alone, each person gets
one inbox.

What exists: push channels for sessions that need attention (ntfy, Telegram, web push), unread
marks in the sidebar, offers under a chat, a mobile inbox screen for questions an agent is
waiting on, and the steward's notifications to agents. None of them is a place a feature can
put a message for a person.

- **Notice**: one record for one person. It has a kind, the thing it is about (an issue
  comment, a credential, a session), a title and a line of text, optional action buttons, when
  it was read, and when it was resolved.
- **It resolves by itself.** A notice about a condition (a credential that needs attention)
  closes when the condition clears, so the inbox shows what still needs the person, not a log.
- **One way in.** Features call one function to raise a notice for a person, with a key that
  stops the same condition producing two.
- **Kinds in this epic**: a mention in an issue comment; a credential of yours that needs
  attention or is about to expire; someone gave you use of a credential.
- **Mentions.** `@name` in an issue comment is matched against the member list when the
  comment is written and stored with the comment. The comment box offers the names. A comment
  written by an agent can mention a person the same way.
- **Where a person sees it**: a tray with a count in the web and desktop header; the existing
  inbox screen on the phone; and the push channels that exist, with a per-kind choice in
  personal settings.
- A notice is private to its recipient. A mention raises one only for a member who can see
  the issue.

Not part of it: email digests, team channels, and replacing offers or the steward.

## 14. What this protects against, and what it does not

| Someone who… | Protected? | Why, and what remains |
|---|---|---|
| gets a copy of the database, the state directory or a replica | Yes | Secrets are encrypted with a key kept elsewhere. The old plaintext is destroyed, in the database and in Podium's own upgrade snapshots. Backups the operator made before the upgrade are not protected, and neither is a backup that also holds the key file. |
| can read or change traffic between the server and a daemon | Yes | The connection is encrypted, or never leaves the computer, and a credential is refused over anything else. A proxy the operator puts in front of the server sees what the server sees. |
| is another member of the instance | Yes, unless given use | A credential is private to its owner. A person given use of one can obtain the secret on their own machine. |
| controls a machine, or its operating-system user | Only by not sending it there | They can read every secret delivered there and every home on it. Hence the default: the owner's machines only. |
| is an agent in a session, or content that has taken one over | No | It can reach the credential its own session runs on, and the others present on that machine under the same user. The harness's switch keeps the credential out of the commands it runs, which stops accidents, not intent. The broker (section 15) is what takes the secret off the machine. |
| takes over a daemon | Limited | A daemon cannot ask for a credential. It only receives what the server sends for sessions a permitted person started there. |
| controls the running server | No | It can decrypt the vault. Logins in homes stay on their machines, out of its reach except through sessions it starts there. |

Removing a credential in Podium does not revoke a key at its provider (section 8).

## 15. How later features fit

Each row adds a type, a delivery or a consumer. None changes the record, the resolver, how
sessions choose, or what is recorded on machines.

| Later feature | What is added |
|---|---|
| OpenRouter sign-in | A type obtained by `oauth`, like the ChatGPT one. Turns "paste a key" into one click. |
| Inference bought from Podium, by the token or by subscription | Type `podium.cloud` (`issued`, renewed by Podium), delivery `endpoint`. How it is billed is a property of the Podium account and invisible here. |
| Running one harness on another provider's access | Delivery `endpoint` plus a translator between the two wire formats in the local broker. The harness adapter declares which format it speaks. |
| Keeping the secret out of the agent's reach | The same broker: the agent holds a per-session placeholder and the broker attaches the real secret. |
| Falling back to another credential when a quota runs out | A policy that calls `switchCredential`. A pool is a list of credentials on that policy. |
| Git hosting, package registries, MCP server logins, sandbox providers, transcription | New types, and new consumers that accept them. A session then has more than one credential, each for a different purpose; this epic has the one for inference. |
| Spending limits per credential | Read through the resolver, keyed by credential id. |

## 16. What ships in this epic

One release, because each item is weak without the others:

1. **Credentials page** (replaces "Accounts & Keys"). Any number of named credentials per
   provider. Add an API key by pasting. Add a subscription by signing in, in a Podium terminal,
   to a home made for it, or for Claude by pasting a `setup-token` token. Add a ChatGPT plan by
   signing in to Podium. Logins found on machines appear by themselves. Each row shows type,
   identity, where it lives, status, expiry and how many sessions use it. Rename, renew, remove.
2. **Several subscriptions for one harness on one machine**, through homes, for Claude Code and
   Codex.
3. **Sign in with ChatGPT**: the plan used for direct inference and for Codex's server driver.
4. **Encrypted storage**, with the existing rows and the three legacy keys migrated without
   anyone doing anything.
5. **Default credential per harness**, and a **credential choice at launch** in the composer
   and the CLI.
6. **The credential shown on every session.**
7. **Switch credential** on a running or stopped session, keeping the conversation.
8. **Direct inference through the same choice**: any credential with a route, any number of
   keys, a ChatGPT plan, a ChatGPT login through its machine as today, and a Claude login
   through Claude Code's one-shot mode if S5 passes.
9. **Sharing by grant**: give another member, or everyone, use of a credential you own. The
   dialog says the other person can obtain it, with a further warning for subscriptions.
10. **Needs attention**: a rejected or expiring credential is flagged on the credential and on
    its sessions, its owner gets a notice, and renewing restarts the affected sessions.
11. **Remove everywhere**, and events for add, renew, remove, share, deliver, switch and refuse.
12. **The notification inbox**, with mentions in issue comments as its first other use.
13. **Own machines by default**: a credential goes only to machines its owner holds custody of, and to
    another machine only after the owner allows it.

## 17. Not in this epic

Each of these has a place in the design and is left out on purpose.

- OpenRouter sign-in.
- Automatic fallback and pools. Switching by hand comes first; the policy is small once that
  exists.
- The local broker (`endpoint`), `helper` delivery, Podium Cloud inference.
- Credentials for anything other than inference.
- Per-credential budgets.
- Changing how propagation works. It stays, and what it copies is recorded.
- Applying to OpenAI for hosted Podium.
- Encrypting the server's other stored secrets (its installation key, its update-signing key).
  They stay as they are; the vault and the transfer hand-over are built so they can join later.
- The desktop keychain and the Podium Cloud key service as sources of the outside key. The
  interface is there; this epic ships the key file.

## 18. What changes in the code

| Today | Becomes |
|---|---|
| `accounts` table, ids `managed:<provider>` | `credentials` + `credential_secrets`. Each row keeps its owner (the first admin where it has none), and its old ids are kept on the credential so old sessions and settings still resolve. The old plaintext values are overwritten once moved. |
| `accounts.shared_with` (`"*"` or user ids) | `use` grants, to all members or to each person. |
| `account_machine_sends` | `credential_machines`. |
| D11 checkbox (use a native login on all my custody machines) | Unchanged; it drives propagation, which records what it copies. |
| `apiKeys.*` in server secrets | Credentials. The secret-key list loses those three. |
| `native:<harness>` in settings and sessions | No credential (the harness's login in its default home). |
| `native:<harness>:<fingerprint>` | The credential row for that identity. |
| `session.accountId`, `roles.<role>.accountId` | `credentialId`. The old wire field is read until the removal date, under a `LEGACY(remove-after: 2027-02)` header. |
| `credentialEnv()` | `accepts` lines in each harness adapter. |
| `resolveAccountEnv`, `selectHarnessAccountId`, `nativeAccountIdForMachine`, `decodeAccount`, `roleApiBackend`, `apiKey(provider)` | The resolver. |
| `SpawnMessage.env` carrying secrets | An `access` field on every message that starts a process, sent only over an encrypted connection. `env` stays for non-secret values. |
| `accounts.*` contracts and the key-sharing commands | `credentials.add / renew / remove`, by the owner or a holder of `manage`; grant commands for sharing; `sessions.switchCredential`. |
| The visibility matrix row `managed-credentials` (no owner, no grants) | Owned by a person, with `use` and `manage` grants. `credential` joins the entity kinds a grant can name, and "all members" joins the grantees. |
| One harness home per daemon; one login per harness in the inventory | A set of homes; one login per home (section 10). |
| The Codex-subscription detour for direct inference (POD-4750) | Stays for `openai.chatgpt-login`. A ChatGPT plan signed in to Podium calls OpenAI's public API from the server. |
| Nothing for person-to-person messages | `notices`, the tray, and mentions on issue comments (section 13). |
| Login catalog, keychain transfer | Unchanged. The catalog feeds the "found on a machine" rows. |
| Propagation | Unchanged, except that a login file crosses only an encrypted or same-computer connection (section 8). Records what it copies in `credential_placements`. |
| Server transfer copies the database | It also hands the vault's data key to the target in the promotion step, and refuses a target whose connection is not encrypted. |
| A daemon may connect over plain `ws` to another computer | Refused credentials at once; the connection itself is refused after the removal date. |

Compatibility code in this epic, each under a `LEGACY(remove-after:)` header:

| Code | Kept for | Marker | Removing it |
|---|---|---|---|
| Accepting a plain `ws` daemon connection from another computer | Local-network installs that have not switched to `wss` yet. | `2027-02` | Such a daemon can no longer connect. |
| Reading the old `accountId` field and the old id spellings | Clients, daemons and stored settings from before this release. | `2027-02` | Old spellings stop resolving. |
| The one-time move of old keys into the vault | Upgrading directly from a version before this release. | `2027-05` | Such an upgrade needs an intermediate version. |

## 19. Measure before building

Each answers one question and decides one thing. None blocks the foundation work.

| | Question | Decides |
|---|---|---|
| S1 | Does the vendor's sign-in run reliably in a Podium terminal inside a Podium-made home, for Claude Code and Codex, on Linux and macOS? | Whether adding a subscription is one flow everywhere. |
| S2 | With a second home, what do the person's harness settings, Podium's hooks, transcript discovery and the server drivers need? Is linking the settings safe, or must they be copied at launch? | How homes share settings, and the size of the daemon work in section 10. |
| S3 | Does a switch keep the conversation: same home with a different credential, a conversation copied to another home, Codex with its reasoning items removed, on each driver? | Whether switching is uniform or some pairings fall back to a handoff. |
| S4 | Does any daemon journal or log write the spawn environment today? | How much has to change to meet "nothing left on disk". |
| S5 | Is Claude Code's one-shot mode fast and cheap enough for background features? | Whether a Claude subscription is offered for direct inference. |
| S6 | Does Sign in with ChatGPT work end to end as documented: registration from a self-hosted server, a Responses call, Codex's server driver on the token, and restart-and-resume when the token is replaced? | Whether the Codex half ships as designed or only direct inference does. **Answered 2026-11-16: yes, every step works; the Codex half ships as designed, with the changes recorded in §11.** |
| S7 | Can a second Claude home be signed in from an existing login without a browser, through Claude Code's documented `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` provisioning, and does the first home stay signed in? | Whether "sign in once, use on every machine" is possible for Claude logins. A possible improvement, not needed for this epic. |

### Answers (POD-6893, measured 2026-11-13 and 2026-11-16 on Linux)

The report with the commands and observations is attached to POD-6893.

- **S1.** Yes on Linux, for both harnesses, with no change to the vendor flow. Codex runs as
  `codex login --device-auth` (section 10). macOS was not measured: the Mac runner was
  offline.
- **S2.** Linking is safe for everything shareable. Two things cannot be linked: Claude Code's
  `.claude.json`, which is seeded and has the person's MCP servers copied in, and Codex hook
  trust, which is passed at launch. Both server drivers run with the directory variable set
  and read that home (section 10).
- **S3.** A copy of the one conversation file is enough to resume in another home, on every
  driver; Codex needs no SQLite rows.
  - Claude Code answered after a change of credential in the same home and after a copy to
    another home. A thinking block with a foreign signature reached the API and caused no
    error.
  - Codex, on both drivers, fails with `400 invalid_encrypted_content` while the history holds
    reasoning items the account cannot decrypt, and answers once they are removed.
  - Codex refuses a thread recorded under a provider that is not configured, and the home's
    thread index wins over the file. A switch has to handle both.
  - No pairing needs a handoff. Not measured: two real accounts of one vendor (one of each was
    available).
- **S5.** Passes. Twenty one-shot calls (`claude -p --tools ""`, Haiku, a title prompt) took a
  median of 3.45 s and 4.56 s at the 95th percentile. Claude Code sends about 3,700 input
  tokens of its own per call, mostly cache reads, against an estimated 60 for the prompt
  sent directly. `--system-prompt` with `--setting-sources ""` cuts that to about 620.
- **S7.** It works without a browser, but it moves the login: the first home was signed out on
  its next request. "Sign in once, use on every machine" is not possible this way, and Podium
  never provisions from an existing login (section 10).

## 20. Calls made in this document

Listed so they can be overturned one at a time. "Operator" marks a decision the operator made.

1. The word is "credential" everywhere, including the settings page; "account" is retired from
   this area.
2. Credentials belong to a person and members manage their own. Operator.
3. Ids are opaque. The made-up id strings go away; the old spellings are read until a removal
   date marked in the code.
4. No credential set means "the harness's login in its default home", and stays the default.
5. A subscription login lives in a home. Homes are in this epic, for Claude Code and Codex.
   Operator.
6. Sign in with ChatGPT is in this epic. Operator.
7. The Claude `setup-token` token and propagation are offered on hosted instances too.
   Operator.
8. Sharing is a grant, like machines. Sharing a subscription warns and is allowed. Operator.
9. The notification inbox is part of this epic. Operator.
10. Credentials travel only over an encrypted connection (`wss`, or one that stays on the
    computer). There is no second layer of encryption. Plain `ws` to another computer is
    refused credentials at once and retired on a date marked in the code. Operator.
11. The server can decrypt what it stores. A credential that must not leave a computer is kept
    in a home.
12. Default credential is per harness, not per role.
13. Switching is stop-and-resume for every driver. Hidden reasoning from the old account is
    dropped; a handoff is the fallback.
14. A ChatGPT plan's sign-in code is exchanged by the server; a daemon only relays the code.
15. A credential goes only to machines its owner holds custody of unless the owner sends it to
    another one. "No credential" is valid only for the machine's custodian. Both follow the
    multi-user design.
16. The Claude token is pasted. Podium does not capture it from one of its own terminals.
17. People manage credentials. Agents only choose among the ones their person can use.
18. Removing a credential stops the sessions running on it.
19. The vault's data key moves with a server transfer and is re-encrypted under the target's
    own outside key. Operator asked for the hand-over; the form is my call.
20. Podium's own upgrade snapshots are cleaned of the old keys, at the cost that restoring one
    with the previous version means adding keys again.
21. The server decides what kind of connection a daemon is on. The daemon is not asked.
22. Removal dates: `2027-02` for the plain connection and the old id spellings, `2027-05` for
    the one-time move of old keys.
