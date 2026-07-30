# `ids/` — branded entity ids and the composite keys

The single definition site for both. A brand or a composite key defined anywhere else is a bug,
not a shortcut: `packages/model` is the L0 zero-dependency root, so a brand here is reachable
from every layer, and that reachability is the whole reason the entity schemas could not adopt
these until POD-361 moved them out of `@podium/protocol`.

- **`brands.ts`** — the brand set, and the reasoned list of what is *deliberately* not branded.
- **`keys.ts`** — the escaping core and the four key shapes.
- Old import paths still work: `@podium/protocol` keeps re-export shims at `ids.ts` (the seven
  original brands + the two legacy key helpers) and at `planes/principal.ts` (`UserId`).
  POD-362 / POD-363 delete them.

---

## 1. Brands — two schemas per brand, and which to use

| Use | Schema | Runtime behaviour |
|---|---|---|
| A string arriving from **outside** (wire, db, argv) that must be checked | `SessionId` | `z.string().min(1)` + brand |
| A field **inside an entity schema** | `SessionIdField` | brand only — accepts exactly what the bare `z.string()` accepted |
| A string that is **already trusted** (own store, parsed envelope) | `asSessionId(s)` | plain cast, no runtime work |

**Use `…Field` in a schema. Always.** Branding is a compile-time construct that must not change
what parses, and every id field in `entities/` was a bare `z.string()` — so each accepts the
empty string today, and at least one producer relies on it (`apps/server`'s
`sessions/service.ts` builds `{ kind: 'resume', conversationId: r.conversationId ?? '' }`).
Putting the `.min(1)` schema on a field turns a payload that parses today into a parse failure:
a behaviour change wearing a type change's clothes. `brands.test.ts` pins it per schema, with the
counterfactual (the same value under the `.min(1)` schema is rejected) so the test cannot pass
vacuously.

### The set

**Tier 1, ratified** — `SessionId`, `IssueId`, `MachineId`, `RepoId`, `ConversationId`,
`MutationId`, `ThreadId` ([spec:SP-3fe2]) and `UserId` (ADR 4 Amendment 1 D9.1).

**Tier 2, added by POD-361 and recorded for ratification** — `AutomationId`, `AutomationRunId`,
`ArtifactId`, `AccountId`. Each is named by a field in `entities/`, and ADR 4 D3.5 makes a raw
`z.string()` entity id an audit failure; adding them here rather than in the adoption sweeps is
what keeps POD-362/POD-363 from re-opening these schemas.

**Not branded, by decision** — native harness ids, external correlation ids,
`SessionMeta.controllerId` (a websocket **client** id, not a session id), and the attribution
*tags* that are not ids. `brands.ts`'s header carries the per-field reasons;
`docs/rearch-branded-id-flip.md` §3 carries the same table.

### `MachineId` is defined and adopted **nowhere**

ADR 1 Amendment 2 D16.2 is normative: `'local'` and `'__local__'` are invalid `MachineId`s, and
because the brand validates *length, not shape*, `MachineId.parse('local')` succeeds — branding a
sentinel launders it instead of flagging it. `'__local__'` is a column DEFAULT on three tables, so
the database manufactures it. Every machine-id field in `entities/` therefore uses
`machineIdBlockedOnPOD318`, a named marker that is the same `z.string()` at runtime.
`brands.test.ts` scans the entity sources by field-name *shape* (plus `MachineWire`'s own `id`)
and fails if any of them is bound to `MachineIdField` — so POD-318 flips the carve-out in one
place, and no later sweep can brand them quietly.

---

## 2. Composite keys — the API

Nothing concatenates a key by hand. Four shapes, each with its inverse:

```ts
userEntityKey(user: UserId, entity: EntityRef): string          // (userId, entityId) — POD-1076
parseUserEntityKey(key): { user: UserId; kind: EntityKind; id: string }

subjectResourceKey(subject: GrantSubject, resource: EntityRef): string   // ADR 9 D2's grant edge
parseSubjectResourceKey(key): { subject: {kind, id}; resource: {kind, id} }

machineScopedKey(machineId: MachineId, nativeId: string): string // legacy: mirror.ts's `m\nnative`
parseMachineScopedKey(key): { machineId: MachineId; nativeId: string }

resumeKey(kind: string, value: string): string                   // legacy: `kind:value`
parseResumeKey(key): { kind: string; value: string }
```

and the extension point every future shape is built from:

```ts
joinKeyParts(sep: string, parts: readonly string[]): string
splitKeyParts(sep: string, key: string, arity: number): string[]
```

### Properties you can rely on

1. **`parse ∘ join` is total over everything `join` accepts.** The separator and the escape
   character are escaped, so round-tripping holds for *every* input including hostile parts. The
   constructors and the parsers share one accepted domain — an empty part is refused on both
   sides rather than being buildable and unparseable.
2. **Injective.** Two distinct part tuples can never collide on one key. (An unescaped
   `${kind}:${id}` is not: `('a','b:c')` and `('a:b','c')` produce the same string. That is the
   defect POD-1134 records in `planes/routing.ts`.)
3. **Byte-identical to the legacy ad-hoc keys** whenever no part contains the separator or a
   backslash — which is why `mirror.ts`, `transcript-indexer.ts`, `search.ts` and
   `identity/session-identity.ts` can adopt these without invalidating a single existing
   in-memory key.
4. **Fails closed.** A malformed escape, the wrong arity, or an entity kind this build cannot
   construct all throw. An unrecognised kind is never returned as if it were known: the caller
   narrows on `kind` to choose a brand, so a lie there is a lie about which id space it is in.

### `EntityRef` — the kind is not decoration

```ts
type EntityRef =
  | { kind: 'session'; id: SessionId }
  | { kind: 'issue';   id: IssueId }
  | …
  | { kind: 'machine'; id: MachineId }   // representable; not mintable until POD-318
```

Ids are unique **per kind**, not globally, so a key built from the id alone would let one user's
`readAt` on a session collide with their `readAt` on an issue. `ENTITY_KINDS` is the runtime half;
`ENTITY_KINDS_MATCH_ENTITY_REF` makes a drift between the two a compile error, so the parser can
never accept a kind the constructor cannot build.

It is a **type, not a schema**, and never crosses the wire: `@podium/protocol`'s
`MetadataEntityKind` is the wire enum, and a second zod enum of entity kinds here would be exactly
the drift Phase 1 exists to delete. This union is a superset of that enum's five members (a key
may name an artifact; a `metadataDelta` may not).

### `(UserId, EntityId)` — the per-user state key

The home for POD-1076's family: `readAt`, snooze, pins, tab order, sidebar/tab layout, personal
preferences — one row per `(user, entity)` (readiness §3.3, ADR 4 Amendment 1 D10, ADR 9 D3.4).
This is the **first key in the system joining two branded types**; POD-360 warned that every
earlier helper was `(brand, raw)` and that POD-1076 would otherwise adopt one with a cast. Both
halves are branded, and both halves are escaped — `keys.test.ts` pins the hostile-user case
separately from the hostile-entity case, because escaping only one side is the plausible bug.

Per ADR 4 D10.1 a per-user value never rides the shared entity's broadcast projection, so this
string must never appear on the wire as an entity field.

### `(subject, resource)` — the grants-edge key

ADR 9 D2's grant edge is `(entityRef, granteeUserId, verb)`, and §3.1.4 M1's machine
`see` / `use` / `manage` verbs will be keyed by branded ids.

**The verb is deliberately not in this key.** ADR 3 D2 carries `read` / `write` / `manage`, and
`authz/issue-authz.ts` records that how M1's three verbs map onto those actions is POD-1079's
call — so choosing a verb vocabulary here would be inventing what another issue is assigned to
decide. A per-verb key is a *five*-part join (`[subject.kind, subject.id, resource.kind,
resource.id, verb]`) via `joinKeyParts`, **never** a verb concatenated onto this function's
output. `keys.test.ts` pins that: appending `:use` to a `subjectResourceKey` fails to parse.

`GrantSubject` is a discriminated union of one (`{ kind: 'user' }`) rather than a bare `UserId`,
because ADR 9 D2 says a group grantee is an additive change to the grantee column — as a union,
adding `{ kind: 'group' }` is a compile error at every match instead of a silent widening. Same
closed-set discipline as `authz/issue-authz.ts`'s `IssueScope`.

---

## 3. Adoption status — mechanism presence is not coverage

POD-361 moved and extended these helpers and **adopted none of them**. The eight `\n`-separated
machine-scoped sites POD-360 found (`packages/sync/src/mirror.ts`,
`transcript-indexer.ts` ×4, `search.ts`, and this package's two `session-identity.ts` sites) move
together or not at all — adopting one is a half-migration. That is POD-362 (server + daemon) and
POD-363 (clients + CLI, audit to zero).
