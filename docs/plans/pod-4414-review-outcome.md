## Verdict

**Yes: this is a clear improvement over the current structure, and I would proceed with it. But I would amend several rules before treating the spec as an implementation contract.**

The central idea is sound: **application code should express what it wants to do with a harness; the harness integration should own how that happens.** Co-locating harness knowledge, eliminating competing execution paths, and sharing transcript interpretation are the right changes.

The weakness is that the spec sometimes elevates useful defaults into absolute laws: exactly four mechanisms, exactly one reader per section, no calls between mechanisms, and every future harness requiring only a directory and a registry entry. Those rules are not all consequences of the underlying problem. Taken literally, some would make the implementation less elegant rather than more so.

My assessment:

| Dimension | Rating | Assessment |
|---|---:|---|
| Improvement over today | **9/10** | Addresses real fragmentation and duplication visible in the code. |
| Simplicity | **7/10** | A simpler mental model, but some prescribed boundaries and file divisions are unnecessarily rigid. |
| Elegance | **8/10** | Strong separation of harness-specific knowledge from shared machinery; less convincing where everything must fit the taxonomy. |
| Best-practice alignment | **8/10** | Good information hiding, dependency direction, explicit support declarations, and conformance testing. |
| First-principles correctness | **7/10 as written** | Fundamentally coherent, but capability semantics, wire representation, and composition need clarification. |

**Overall: roughly 8/10. Approve the direction; request targeted revisions, not a redesign.**

### What I reviewed

I read the attached September 20, rev 1 spec and inspected the repository’s `main` at **`692d8c8e8f5465112dadeff50df0f0be817e9e51`**, dated September 18. I followed the manifest and registry, driver contracts and selection, terminal injection, credential handling, transcript lake and indexer, discovery, composer, browser entry, and an end-to-end runtime test. This is a static architecture review; I did not execute the tests. Also, the spec’s “done” labels may refer to a newer integration branch—not the `main` snapshot reviewed here. 

## 1. The diagnosis is substantially correct—but some of the improvement already exists

The repository already has much of the desired architecture. The problem is that its boundaries are incomplete and inconsistently enforced.

For example, `AgentManifest` already describes itself as the single home for behavioral variance, requires explicit declarations, and distinguishes software facts from machine-specific availability. The proposed Adapter is therefore an evolution of an existing design, not a new architectural discovery. Keeping that type rather than introducing a rival is the correct decision.  

Here are the most consequential observations from the code:

| Area | What is present today | Assessment of the proposed change |
|---|---|---|
| **Runtime selection** | The daemon registry contains `opencodeDrivable`, `grokDrivable`, `codexDrivable`, Claude-specific environment interpretation, and explicit driver lists. | Moving vendor facts and admission rules behind the integration boundary is a real improvement. |
| **Credentials** | `control/credentials.ts` contains harness-specific path tables, validators, propagation lists, Claude state sanitization, and a macOS-specific Claude store branch. | Excellent candidate for consolidation, while retaining the existing generic storage safeguards. |
| **Browser metadata** | `browser.ts` maintains a capability table separately from manifests to avoid importing host dependencies. | Browser-safe definitions beside each harness would remove a genuine source-of-truth problem. |
| **Composer** | The composer package has its own harness registry and per-harness implementations. | Moving those implementations beside their harnesses is sensible; the existing pure interface is worth keeping. |
| **Transcript lake** | `lake.ts` already uses `transcriptRecordMapperFor()` and `fileChainSource()`. | Shared interpretation is partly implemented already. |
| **Transcript search indexing** | The indexer imports `claudeRecordToItems` directly and describes its input as Claude records. | This is a remaining harness-specific dependency the migration should explicitly cover. |

These findings come directly from the corresponding implementations.      

That distinction matters: **the task is to finish and consolidate the abstraction, not replace all the existing machinery.**

There is also a revealing pattern in the code’s comments. Several modules explain why they are the “only” home for a concern, while other modules retain related declarations or alternate paths. The new spec will succeed only if its boundaries are mechanically enforceable—not because it states the invariant more emphatically.

## 2. What I would preserve almost unchanged

### The application-facing contract

This is the strongest part of the architecture.

The existing `AgentSessionHandle` already offers intent-level operations: `send`, `interrupt`, `answer`, transcript history, observation, configuration, and lifecycle. It does not expose PTYs, sockets, or hooks. It also distinguishes acceptance evidence and typed refusals instead of pretending every mechanism behaves identically. 

That is what a useful abstraction should do:

> Hide how the operation is performed, while preserving differences that affect what the caller can safely assume.

This aligns with the original ports-and-adapters idea: the application communicates through a purposeful interface, and technology-specific implementations translate that conversation without leaking their internals into application logic. There is no architectural requirement that all implementations use the same internal structure. 

**Keep the existing semantic contract. Do not simplify it merely to make the new directory structure look uniform.**

### One authoritative home for harness integration knowledge

Credential layouts, launch arguments, transcript grammars, composer extraction, and hook payload interpretation belong with the harness whose changes cause them to change.

The proposed directory layout would make a question such as “What does Podium know about Codex?” substantially easier to answer. Moving composer and transcript implementations there also removes the current situation in which adding support requires remembering several separate registries.  

This is useful information hiding—not merely tidying folders—provided application code can no longer bypass the public contracts.

### Keeping process supervision separate from harness protocols

The spec is right to keep `@podium/process` separate and to distinguish the durable process, its terminal surface, and the harness driver. A terminal is not necessarily the owner of the underlying computation. The proposed ownership model also explicitly avoids transferring ownership during parking and attachment changes. 

The current OpenCode host illustrates why this separation helps: protocol-independent work such as process spawning, scope management, journaling, and readiness plumbing is mixed with OpenCode-specific details in the daemon. Extracting the shared process machinery while retaining protocol-specific integration is a sensible direction. 

### Explicit unsupported declarations

Keep `supported(value)` / `declined(reason)`.

The existing `Declared<T>` already captures an important distinction: an integration author consciously declined support, rather than forgot to implement a field. It also explicitly tells consumers not to substitute another harness’s behavior. 

However, that proves **declaration completeness**, not implementation correctness. The conformance tests remain essential.

## 3. The most important correction: distinguish adapter coverage from runtime capabilities

The spec says capabilities are derived from which sections are supported, and its acceptance criteria describe the section matrix as the source of served capability flags. **That is suitable for a support matrix, but insufficient as a general capability model.**  

There are three different questions:

| Question | Example | Source of truth |
|---|---|---|
| **Does this integration implement the feature?** | A transcript grammar exists. | Adapter declarations. |
| **Can this installation provide it?** | The installed binary/version/authentication supports a particular driver. | Machine inventory and admission/negotiation. |
| **What can this session actually do?** | It can configure the model from the next turn, but cannot prove an interrupt fence. | The selected driver and current session conditions. |

These are not interchangeable.

The existing code already recognizes this. `SelectionContext` includes authentication, platform, and available drivers. `DriverCapabilities` describes much more than feature presence: send-proof strength, attachment representation, configuration timing, resume-reference timing, interaction answerability, and process placement.   

For example, knowing that `runtime.ts` is supported does not answer whether `configure()` takes effect immediately or on the next turn. Knowing that a transcript section exists does not mean history is available while the relevant machine is offline.

Protocol negotiation reinforces this distinction: ACP initialization exchanges a protocol version and concrete agent capabilities, rather than treating the existence of an ACP integration as proof that every operation is supported. 

**Recommended amendment:**

> Adapter sections describe implemented integration support. Effective capabilities are resolved from those declarations, the selected driver, machine/protocol facts, and applicable session constraints. Callers receive capabilities at the scope relevant to their operation.

This does not require a large new subsystem. It requires preserving distinctions the code already makes.

## 4. Loosen the rules that confuse centralization with rigidity

### “One owning mechanism per section” should not mean “one permitted reader”

A single authoritative definition does not require a single consumer.

A credential convention can affect both login detection and launch environment preparation. Pure composer rules can legitimately serve both a daemon implementation and a bundled browser fallback. Sharing that definition does not duplicate knowledge.

The spec already needs exceptions for browser projections and runtime selection. That is a sign that **ownership and readership are different concepts**, not necessarily that the section boundaries need ever-finer subdivision.  

I would replace the rule with:

> Each concern has one authoritative definition and a clearly responsible implementation. Consumers depend on narrow interfaces or immutable projections; unrelated application code does not inspect adapter internals.

That achieves the intended encapsulation without treating a second legitimate reader as a defect.

I would also prefer passing a Driver its relevant, typed configuration rather than the entire sixteen-section Adapter. The spec currently hands the whole Adapter to the Driver while relying on a rule to prevent unrelated section reads. A narrower type would make that restriction more concrete. 

### “Mechanisms never call each other” is stronger than necessary

**Avoiding circular dependencies and hidden lifecycle ownership is good. Prohibiting every cross-mechanism call is not inherently good.**

There is an immediate example in today’s contract: the live handle has `transcript.history()`. Under the proposal, the Store is the single implementation of transcript reading. The spec needs to say how that history operation reaches the Store.  

An injected `TranscriptReader` port is a straightforward answer. Having `DaemonSession` compose the objects is also straightforward. But forcing every interaction through session-level forwarding methods merely to preserve “never call” risks turning `DaemonSession` into an oversized coordinator.

My preferred rule is:

> Mechanisms do not instantiate or own peer mechanisms. Dependencies are explicit, narrow, and acyclic. Application code owns lifecycle and workflow composition.

Your login example still fits this rule exactly: Inventory determines the login action, application code opens the terminal, and Inventory probes again afterwards. It does not require a universal ban on read-port delegation. 

### Pure functions are useful; a mandatory declarative language is not

The spec explicitly permits pure functions, which is good. The existing composer interface is already a good example: extraction and injection rules are pure functions over screen content and text. Those can move without being redesigned. 

But not every integration concern is just a file layout waiting to become a record. The current credential path includes platform-specific storage and guarded writes; OpenCode discovery queries a database and manages its lifetime.  

Those can be factored into shared I/O primitives plus harness-specific rules. The danger is taking that so far that the shared mechanism becomes a miniature interpreter for a complicated configuration language.

**My guardrail:** prefer data and pure strategies where they make the integration simpler. Permit a small, harness-local strategy implementation when forcing it into declarations would create more machinery than it removes.

The invariant worth defending is **“vendor behavior stays behind the boundary,”** not **“vendor behavior must always be represented in one particular programming style.”**

## 5. Fix the two places where “generic” does not automatically imply “correct”

### Browser-safe is not the same as wire-serializable

The spec combines browser-safe descriptor/catalog/composer sections with served descriptors and says composer rules ship in the Descriptor.  

But the current composer rules include executable functions such as `extract`, `injectable`, `clearSequence`, and `verify`. They are browser-safe TypeScript—not something an older client can receive as ordinary JSON and begin executing. 

The spec needs to distinguish:

**Bundled browser code:** pure implementations compiled into a particular client version.

**Wire descriptor:** serializable, versioned data that an older client understands.

My recommendation is to keep composer interpretation authoritative on the daemon and serve the resulting state and supported actions. Keep any bundled browser fallback explicitly limited to harnesses that client knows. Do not introduce a remote rule interpreter solely to preserve the “old clients support new harnesses” slogan.

An older client can render a new harness’s name, icon, model choices, generic conversation, and supported controls **within an already-supported presentation schema**. It cannot automatically acquire a novel interaction model.

The same distinction applies to the server: serving an unknown harness’s descriptor does not teach an older server how to parse that harness’s mirrored transcript. Define the unsupported/mixed-version behavior explicitly.

### Shared grammar does not by itself guarantee shared identity

Sharing one parser is absolutely right. But the spec overstates the result when it says live and mirrored reads mint identical IDs “by construction” because identity belongs to the grammar. 

The existing implementation demonstrates why: `stampCursors()` can replace synthesized item IDs using a cursor constructed from file identity, offset, record UUID, and sub-item index. Identity is therefore partly a function of source context, not only record grammar. 

The lake separately constructs file-chain identities from native IDs and incarnation sequences. 

The required invariant is something like:

> The same logical native record and sub-item receive the same identity regardless of whether the bytes are read live, mirrored, relocated, or replayed.

That requires agreement on the conversation namespace, logical file incarnation, record identity or position, and sub-item mapping—not just reuse of a parsing function.

The proposed live/mirror golden tests are exactly the right starting point. Extend them to cover truncation, archived incarnations, partial records, relocation, and reconnect/replay. Also explicitly include the search indexer in the migration; it should consume normalized items rather than continue interpreting one harness’s records itself.  

## 6. Make the lifecycle and extension promises precise

### The lifecycle ownership is promising, but the construction sequence is underspecified

The spec says the Driver receives an existing Terminal or engine address and owns nothing below itself. It also places launch, environment, and instrumentation under the Driver.  

Those statements can coexist, but the implementation needs an explicit sequence:

**Prepare launch and instrumentation → create/adopt durable process → bind protocol/terminal driver → observe → detach or terminate according to policy.**

For each step, identify who owns failure cleanup. In particular: what happens when instrumentation succeeds but spawn fails, spawn succeeds but protocol binding fails, or a surviving process is found without recoverable protocol state?

This is not a request for another abstraction layer. It is a request to specify the handoffs between the layers already proposed.

Also, **process survival is not the same as session recovery**. Recovery must restore or honestly invalidate pending operations, protocol subscriptions, interactions, and acceptance evidence. Today’s driver contract already treats adoption and causality as first-class, and the OpenCode host already persists binding-related information. Those guarantees should survive the consolidation.  

### “One directory and one registry entry” needs a qualification

That promise is realistic for a new harness that can use existing driver families, storage mechanisms, and client presentation concepts.

It is not realistic for an arbitrary harness with a genuinely new protocol or an interaction that the existing public contract cannot express.

The spec itself acknowledges separate protocol families and rejects a common EngineLink abstraction because the protocols do not meaningfully share more than process machinery. That is a good decision—and it implies that new protocols may require new implementations.  

I would state the promise this way:

> A harness using existing integration mechanisms requires only its adapter directory and registration. A new protocol or storage mechanism may require a new implementation inside the harness package, without changing application consumers unless it introduces genuinely new product semantics.

That is still a strong extensibility guarantee. It is also honest.

The fixture-harness test should exercise meaningful supported behavior, not pass because most sections say `declined`.

### Not every harness name is leaked vendor knowledge

The clearest counterexample is `packages/runtime/src/harness-defaults.ts`. It contains Podium’s preferred harness order for the superagent and explains that this reflects which combinations Podium has exercised. **That is product policy, not an intrinsic fact about a harness.** 

Moving that ranking into each adapter would make the adapter less conceptually clean. It would conflate “what this harness does” with “what Podium currently prefers.”

The lint should distinguish integration behavior from explicit policy/configuration references. It should also distinguish executable dependencies from comments, fixtures, and historical migrations.

The right objective is:

> No vendor-specific operational behavior outside the integration boundary.

Not:

> No occurrence of a vendor identifier outside one directory.

Otherwise, the implementation can optimize for passing a name scan while preserving the underlying coupling—or move legitimate application policy to the wrong place.

## 7. Answers to the spec’s five open questions

| Open question | My recommendation |
|---|---|
| **One owning mechanism per section? Split composer by daemon/browser?** | Keep one authoritative definition, but permit narrow shared readers/projections. Do not duplicate pure composer logic merely because it runs in two places. Separately distinguish bundled code from wire data. |
| **Exec family or fifth mechanism?** | **Do not add a fifth mechanism.** Treat one-shot execution as an execution operation, with a native exec implementation or ephemeral-session implementation behind it. Do not force a one-shot process to pretend it has a full interactive session interface. |
| **Descriptor: mechanism or projection?** | **Projection.** “Three behavioral subsystems plus a descriptor projection” is clearer than stretching the word mechanism to preserve a count of four. |
| **Families per protocol?** | **Yes.** Reuse ACP where semantics genuinely match; keep Codex app-server, OpenCode HTTP, and SDK-specific implementations distinct where they do not. Do not invent a universal protocol layer. |
| **One package?** | **Yes, reasonable here.** Use explicit exports and transitive dependency/bundle checks. The package boundary is organizational; the entry-point boundaries must enforce execution-environment safety. |

These correspond to the questions in section 9. 

For exec specifically, there is already a useful starting point: `DriverProcedureOverrides.oneShot` explicitly allows a native one-shot implementation instead of paying for a full session. Reuse that concept rather than creating another parallel execution API. 

For packaging, the current `browser.ts` documents a previous transitive import problem and maintains a separate table to avoid it. The new package should therefore have tested entry points—not merely a rule against directly importing `child_process`. Ensure the server’s grammar/Store imports cannot accidentally load process drivers, and test actual browser/mobile builds. 

One additional loose end: **assign `handoff.ts` explicitly.** It appears in the detailed Driver section list but is absent from the four-mechanism ownership table. Its at-rest format/placement knowledge fits naturally with Store; any quiesce-transfer-resume workflow belongs in application composition. It should not force the Driver to become a second storage implementation.  

## 8. What I would require before calling the migration successful

The migration ordering is broadly sensible: enforce boundaries early, eliminate the competing runtime path, preserve ownership during the move, then consolidate the remaining concerns. The spec’s existing conformance and live/mirror tests are good acceptance criteria. 

I would strengthen acceptance in four places:

1. **Preserved behavioral guarantees.** Exercise receipts, unsupported operations, configuration timing, attachment semantics, and capability resolution through the actual application-to-daemon route—not only directly against a driver.

2. **Recovery under failure.** Restart or disconnect at meaningful points: after delivery but before acknowledgment, during an interaction, while a native terminal has control, and during transcript mirroring. Assert honest recovery or explicit uncertainty, not just process liveness.

3. **Cross-version and unknown-harness behavior.** An older client renders a new descriptor within its supported schema, unsupported operations fail explicitly, and an older server does not silently use the wrong transcript grammar.

4. **Real removal of alternate knowledge paths.** The lake, indexer, discovery, credentials, composer, and runtime selection must consume the new boundaries. Passing a harness-name lint alone is not proof.

The repository already has an end-to-end runtime test whose purpose is precisely to distinguish direct-driver conformance from real server/daemon plumbing. It tests accepted versus unverified sends and uses a fixture harness rather than claiming to validate a real vendor CLI. That is a useful foundation to extend and preserve. 

I would **not** make “sixteen physical files per harness” a success criterion. Sixteen explicit typed sections can be useful; a separate file for each trivial declaration is optional organization. Likewise, a smaller package count is helpful only insofar as it produces fewer competing APIs and clearer dependency boundaries.

## Bottom line

**This is the right refactor. The existing code provides strong evidence that the consolidation is needed, and the proposed architecture would make future harness work substantially more local and understandable.**

The best version of the design is:

> One authoritative home for harness-specific behavior; narrow intent-level contracts for application code; shared mechanisms where behavior actually repeats; explicit capability and lifecycle semantics where it differs.

The amendments I consider most important are **separating static support from effective capabilities, distinguishing browser code from wire descriptors, and replacing absolute “one reader/no calls” rules with explicit, narrow composition**.

With those changes, I would be comfortable using this spec to guide implementation. Without them, it is still a good direction—but there is a real risk of replacing today’s scattered complexity with an overly rigid framework rather than removing it.
