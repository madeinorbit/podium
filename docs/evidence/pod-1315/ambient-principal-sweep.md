# POD-1315 — the defaulted principal on `addComment`, and what the count could not see

## The defect

`apps/server/src/modules/issues/service/index.ts` declared:

```ts
addComment(
  id: string, author: string, body: string,
  principal: CommandPrincipal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin'),
)
```

A caller that omitted the argument acted as the instance administrator, silently.

**It was reachable from the authenticated transport, not only from a forgetful
future caller.** `modules/issues/registry.ts` passed `ctx.caller.principal`,
which is typed `CommandPrincipal | undefined` — `IssueCaller.principal` is
optional. When it was absent the argument was `undefined`, the default fired,
and the comment was attributed to the first admin. The type system never
complained because a defaulted parameter accepts `undefined` as readily as an
omitted argument. The brief's assessment that every production caller passes one
explicitly was true of the *call sites*; it was not true of the *values*.

## The fix

1. **`IssueCommentsMailModule.addComment` — `principal` is now required.** This is
   the load-bearing half. Removing only the facade's default would have changed
   nothing at the type level: `IssueService` is
   `IssueServiceRoot & IssueLegacySurface`, an INTERSECTION that includes the
   module's signature, so while the module's parameter stayed optional a
   three-argument call would still have compiled — it would merely have landed
   with no attribution instead of admin attribution.
2. **The facade override is deleted, not de-defaulted.** Its only content was the
   default; the forwarding it performed is already done by the legacy Proxy.
3. **Attribution is now unconditional.** The old body wrote `actor`/`onBehalfOf`
   only when a principal was present, so a comment could land anonymously. It
   cannot now.
4. **`registry.requirePrincipal()`** replaces `ctx.caller.principal` at the
   `addComment` handler: an absent principal is `UNAUTHORIZED`, not a substituted
   identity. The `create` handler's identical inline check now shares it.
5. **Six git-workflow sites name `systemPrincipal('stop'|'cleanup'|'integrate')`.**
   These are the automation comments already authored `system:*`.
   `IssueGitWorkflowModule` receives no principal at all — `cleanup(id)`,
   `integrate(id)` and `freeWorktreeKeepBranch` take an issue ref and nothing
   else — so there is no user here to thread, and inventing one would be the
   error this issue is about. `attributionOf` renders these as `system:<job>`
   with `onBehalfOf` null (ADR 3 Amendment 1 D21.2): visibly a job, never a
   person. Threading the real invoking human down to this plane is **POD-1344**.

## The guard

`apps/server/src/modules/issues/service/addComment-principal.test.ts` pins the
signature with three `@ts-expect-error` probes — omission at the flat-service
surface, omission at the capability-module surface, and an explicitly-passed
`undefined`. They are compile-time assertions: a restored default makes each
directive unused and fails `tsgo --noEmit` with TS2578 before the suite runs.

**Proved in both directions** (the instrument was shown able to say NO):

| Mutation | Expected | Observed |
|---|---|---|
| Default restored on the module signature | build fails | `TS2578: Unused '@ts-expect-error' directive` at all three probes |
| Directive deleted from the omission probe | build fails | `TS2554: Expected 4 arguments, but got 3` |
| Directive deleted from the `undefined` probe | build fails | `TS2345: Argument of type 'undefined' is not assignable to parameter of type 'CommandPrincipal'` |
| Neither | build passes | 22/22 typecheck tasks green |

Three runtime cases accompany them: a non-admin user principal is attributed to
*that* user (asserting it is not `FIRST_ADMIN_USER_ID`), a system principal lands
as `system:cleanup` with `onBehalfOf: null`, and attribution is never null.

## Ambient count

Occurrences of `FIRST_ADMIN_USER_ID` in `apps/server/src` production code
(`*.ts` excluding `*.test.ts`): **69 → 67**. Both removed occurrences are the
import and the default in `service/index.ts`.

The count moving by two is the least interesting fact here. **A defaulted
parameter and a prose mention are indistinguishable to that scan**, and roughly
nine of the remaining 67 are prose — `command-principal.ts:67`,
`device-grade-owner.ts:30`, `issues/service/core.ts:78`,
`issues/projection.ts:61`, `rename-target-path.ts:192`, `lifecycle.ts:2718`,
`settings/service.ts:293`, `superagent/service.ts:459`, `relay.ts:764` — several
of them comments explaining that the constant is *deliberately spelled out
rather than defaulted*, which is the exact opposite of the defect and scores
identically.

## Sweep: other defaulted / fallback principals in production code

Searched `apps/server/src` (excluding tests) for default parameter values, `??`
and `||` fallbacks producing a principal or an identity.

### Same family as the defect — a missing identity filled in with the first admin

**`modules/messages/service.ts:2468` `authorityOf(from)`.** When
`from.attribution` is absent it synthesizes one, and for the `operator`,
`superagent` and `agent` arms `onBehalfOf` is `FIRST_ADMIN_USER_ID` (the
`operator` arm sets `actor` to the admin too). Structurally identical to what was
just removed: the caller failed to say who was acting, and the answer supplied is
the administrator. Not fixed here — it is a different module with its own
callers, and the honest fix is the same shape as POD-1344 (thread the real
sender's attribution). **Recommend a dedicated issue.**

**`modules/sessions/view.ts:64` `defaultPrincipal()`**, consumed at lines 30 and
39 as `forPrincipal ?? this.defaultPrincipal()`. Mints a full admin
`SessionStatePrincipal` for a caller that named none. Read-side (session-state
projection) rather than command-side, and single-account today, so the blast
radius is smaller — but it is the same shape and the same invisibility to the
count.

### Explicit system principals — legitimate, and visibly not a user

- `service/index.ts:277` `boot(principal: SystemCommandPrincipal = systemPrincipal('boot-reconcile'))`
  — still a *defaulted* principal, but the type is `SystemCommandPrincipal`, so
  no default can smuggle in a human, and boot genuinely has no caller.
- `steward.ts:377` `deps.principal ?? systemPrincipal('steward')`.
- `modules/sessions/inbox.ts:206,223,428` and `lifecycle.ts:580`
  `input.principal ?? SYSTEM_INBOX_PRINCIPAL`.

These satisfy the rule: an in-process job with no human, saying so.

### Row-ownership defaults — a different question, worth separating

`session.ts:279`, `repository.ts:334`, `lifecycle.ts:1266/1424/2622`,
`oracle-support.ts:179`, `store/superagent.ts:22` default `ownerUserId` to
`FIRST_ADMIN_USER_ID`. These answer "whose row is this" on a single-account
instance, not "who is acting", so they are not authorization identity — but they
are the largest remaining group and they will each need an answer when accounts
become plural.

### Deliberate single-tenant reads

`issues/service/core.ts:84`, `sessions/view.ts:55`, `lifecycle.ts:2725`,
`relay.ts:819` (broadcast viewer / settings owner) — one account exists, so this
is the honest answer, and each is already commented as such.

### Authentication paths — where the constant belongs

`auth-route.ts:194,210` and `server.ts:368` (`!credentialsRequired()`) resolve the
instance's one account at the point authentication actually happens. This is the
constant doing its job.

### Test-only

`test-support/client-principal.ts`, `test-support/client-transport.ts`,
`gateway/feed-test-plumbing.ts`, `modules/messages/characterization-support.ts`.
They inflate the production count without being production; excluding
`test-support/` and `*-test-plumbing.ts` from the scan would sharpen it.

## Suggested change to the instrument

Counting a constant cannot separate a default from a mention. A scan that
flags **principal-typed default parameter values and `??`/`||` fallbacks whose
right-hand side produces a `UserCommandPrincipal`** would have caught this on the
commit that introduced it, and would today flag `authorityOf` and
`defaultPrincipal` — neither of which moves the current number at all.
