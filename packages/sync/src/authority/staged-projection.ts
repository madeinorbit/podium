/**
 * A PROCESS-OWNED PROJECTION THAT WAITS FOR THE OUTERMOST COMMIT [POD-3366].
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE `Ledger.commit`'s `apply` ARM AND NOT INSTEAD OF IT
 * ---------------------------------------------------------------------------
 *
 * The arm defers a caller's post-commit work to the outermost commit, which is
 * the right answer when NOTHING reads the projection in between. POD-3328 and
 * POD-3361 each found that something did — `Authority.stage`'s dedup at one
 * site, `persist`'s catch arm at the other — and each hand-rolled the same
 * three-part answer: stage the new value where in-window readers can see it,
 * promote it into the committed slot from a commit application, and drop what
 * a rolled-back span left staged on the way IN.
 *
 * A third and fourth hand-roll is the failure this issue exists to stop. Three
 * copies of "when is this durable" is the rule living in three comments again,
 * and the copies would diverge the first time one was fixed. So the answer is
 * written ONCE, here, and a site that owns a projection holds one of these
 * instead of a bare field.
 *
 * ---------------------------------------------------------------------------
 * THE ASYMMETRY, WHICH IS THE WHOLE REASON IT HOLDS
 * ---------------------------------------------------------------------------
 *
 * There is NO abort hook and there will not be one. A staged value reaches the
 * committed slot through its commit application and nowhere else, so a value
 * still staged when NO span is open belongs to a unit of work that ended
 * without committing — and {@link StagedProjection.read} drops it on the way
 * in rather than waiting to be told. Nothing has to REMEMBER to report a
 * rollback, which is why this holds under a crash and not merely under a
 * caught exception. A version that reintroduced a must-not-forget obligation
 * would be worse than the bug it fixes.
 *
 * THE RULE HAS TWO HALVES, AND THE SECOND ONE IS WHY POD-3364 EXISTS. "No span
 * is open" is TOP-LEVEL granularity, and it leaves a gap one frame down: a
 * MIDDLE span that rolls back inside a committing outer one never makes
 * `spanOpen()` answer false, so what it staged used to survive in the pending
 * layer and shadow every read for the rest of the outer span. Nothing incorrect
 * was ever made durable — the promotion died with the inner registry — but a
 * dedup reading in that window decided against rows the database had thrown
 * away.
 *
 * So a staged entry also carries its `CommitRegistration`, and freshen drops it
 * when that registration is dead. This is the SAME asymmetry at frame
 * granularity, not a fourth mechanism: the handle is killed by the same
 * `discard()` that already throws the step away, on an unwind path that cannot
 * be skipped, and the reader ASKS rather than being told. Nothing new has to
 * remember anything.
 *
 * WHY NOT FRAME IDENTITY, which is the obvious shape and the one to reach for
 * first: a savepoint that RELEASES closes its frame exactly as one that rolls
 * back does, and its staged work is still legitimately pending in the parent's
 * registry. "Which frame staged this" cannot separate the two. "Is my
 * registration still going to run" can, because release MOVES it and rollback
 * DROPS it — which is why `PostCommitRegistry.mergeInto` must not go through
 * `discard`. The test "still shows a read what a RELEASED nested span staged"
 * is that half, and it is the only thing standing between this and a fix that
 * trades one bug for a lost update.
 *
 * ---------------------------------------------------------------------------
 * THE PROMOTION CLOSES OVER ITS VALUE. THIS IS THE RULE, NOT A DETAIL.
 * ---------------------------------------------------------------------------
 *
 * A registered step installs the value it was registered WITH. It must never
 * read the staged slot back at drain time, and the reason is not hypothetical:
 * during the drain the outermost frame is already CLOSED, so `spanOpen()`
 * answers false. Any other commit application in the same batch that merely
 * READS a staged projection therefore freshens the staged slot away — and a
 * promotion that then went looking for its own entry would find nothing, return
 * quietly, and lose the install with no error anywhere.
 *
 * Both hand-rolled layers this class replaced had exactly that shape:
 * `ChangeBaseline.promotePending` (POD-3328) and
 * `SessionRepository.promoteDurableBaseline` (POD-3361) each did a `findIndex`
 * over an array their own freshen path empties. The coordinator confirmed no
 * live ordering reaches it today, so it was LATENT rather than active — but
 * "latent" and "unreachable" are different claims and only one of them survives
 * a new caller, which is why it is fixed by construction here instead of being
 * left as a note.
 *
 * The test that holds this rule is named for it: "a promotion is immune to
 * another commit application freshening first". Mutation M5 — the promotion
 * reading `staged` back instead of closing over its value — kills that test and
 * ONLY that test, with "expected 'before' to be 'after'": the install silently
 * lost. Do not delete it as redundant; it is the only thing standing between
 * this class and the bug it was written to end.
 *
 * POD-3364 DID NOT CHANGE WHAT M5 PINS. The promotion still closes over its
 * value; the registration is read at FRESHEN time, never at drain time, so the
 * drain-order argument above is untouched. The staged entry gained a field and
 * the registration is taken BEFORE the entry is stored, which is the only
 * ordering the new field imposes.
 *
 * The frame-granular half has its own mutants, and each kills one named test:
 * dropping `registration.live()` from `StagedProjection.freshen` reds only
 * "does not shadow a read with a value a MIDDLE span rolled back"
 * ("expected 'after' to be 'before'"); dropping it from
 * {@link StagedOverlay.freshen} reds the three keyed cases and the memo case;
 * and omitting the `version_` bump on a drop reds ONLY
 * "moves the version when a dead entry is dropped, so a memo rebuilds"
 * ("expected [ 'a' ] to deeply equal []"), because a holder that memoises would
 * otherwise keep serving the dropped row.
 */

import type { BaselineFoldPort, CommitRegistration } from './ports'

export class StagedProjection<S> {
  private staged: { token: number; value: S; registration: CommitRegistration } | undefined
  private nextToken = 0

  /**
   * @param committed the value before anything is installed.
   * @param fold where a deferred install waits for the outermost commit.
   *   UNSET means every install is immediate, which is what a unit test with a
   *   pass-through `transact` wants and what an adapter with no notion of a
   *   commit boundary gets.
   * @param label names this projection in the post-commit registry.
   */
  constructor(
    private committed: S,
    private readonly fold: BaselineFoldPort | undefined,
    private readonly label = 'staged-projection',
  ) {}

  /**
   * What a reader should see: the value this span installed if it installed
   * one, else the committed value.
   *
   * IN-WINDOW READS ARE THE POINT. A caller that installs and then reads back
   * inside one enclosing span — a second write that needs the first one's
   * fields, a dedup that asks whether an id is present — must see its own
   * work, or deferring the install turns a correct sequence into a lost update.
   */
  read(): S {
    this.freshen()
    return this.staged ? this.staged.value : this.committed
  }

  /**
   * What the last COMMIT installed, ignoring anything still staged.
   *
   * Narrow, and separate from {@link read} because the two answer different
   * questions: this one is "what would survive a rollback right now", which is
   * what a diagnostic — or a rollback path — wants, and it is never the right
   * answer for a caller that is about to write.
   */
  durable(): S {
    this.freshen()
    return this.committed
  }

  /**
   * Install `value` as the projection, AS OF THE OUTERMOST COMMIT.
   *
   * With no span open this commit IS the outermost commit and the install
   * happens at once, which is where it happens today. Inside one, the
   * surrounding `ledger.commit` was a savepoint release and its rows are not
   * durable yet, so the value is staged for {@link read} and promoted by the
   * commit application.
   */
  install(value: S): void {
    this.freshen()
    if (!this.fold?.spanOpen()) {
      this.committed = value
      this.staged = undefined
      return
    }
    const token = ++this.nextToken
    // Registered FIRST, because the entry holds the handle its own liveness is
    // read through [POD-3364].
    const registration = this.fold.onCommit(() => {
      this.committed = value
      if (this.staged?.token === token) this.staged = undefined
    }, this.label)
    this.staged = { token, value, registration }
  }

  /** Install a value derived from what a reader would see right now. */
  update(next: (current: S) => S): void {
    this.install(next(this.read()))
  }

  /** Drop what a rolled-back span left staged. See {@link StagedOverlay.freshen}
   *  for both halves of the rule and for what each one alone cannot see. */
  private freshen(): void {
    if (!this.staged) return
    if (!this.fold?.spanOpen() || !this.staged.registration.live()) this.staged = undefined
  }
}

/**
 * A KEYED STAGED OVERLAY — the same rules, for a projection that is a MAP
 * rather than a single value [POD-3366].
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO CLASSES HERE AND NOT ONE, OR FOUR
 * ---------------------------------------------------------------------------
 *
 * {@link StagedProjection} replaces a whole value, which is right for a list
 * served as one thing. Every other projection this issue touched is keyed, and
 * expressing a keyed map as a whole value costs a full copy on EVERY install —
 * including the top-level installs that are the common path and were free
 * before. So the keyed case gets its own class rather than a worse version of
 * the value case.
 *
 * What it does NOT do is own the committed store. Three layers were hand-rolled
 * before this existed — `ChangeBaseline`'s pending batches (POD-3328),
 * `SessionRepository`'s staged baselines (POD-3361) and `IssueStore`'s staged
 * rows (POD-3366) — and each keeps its committed state in a shape of its own:
 * two parallel maps keyed by a composite, a map of snapshots, a map of rows
 * with its own memo. A shared class that insisted on holding that state would
 * have fitted none of them. So this owns the STAGED half and the promotion, and
 * the holder keeps asking its own committed store when nothing is staged. That
 * is the half all three copies got subtly differently, and the half where the
 * bug was.
 *
 * The rules are {@link StagedProjection}'s, unchanged and stated once there:
 * read-through so in-window readers see their own span's work, promotion only
 * through a commit application, no abort hook, and a promotion that CLOSES OVER
 * its entries rather than reading them back at drain time.
 */
export class StagedOverlay<K, V> {
  private staged:
    | Map<K, { token: number; value: V | undefined; registration: CommitRegistration }>
    | undefined
  private nextToken = 0
  private version_ = 0

  /**
   * @param fold where a staged entry waits for the outermost commit. UNSET
   *   means every write is immediate — the holder's `commit` callback runs at
   *   once and nothing is ever staged.
   * @param commit makes ONE entry durable: write it into whatever the holder
   *   uses as its committed store. `undefined` means the key was removed.
   * @param label names this overlay in the post-commit registry.
   */
  constructor(
    private readonly fold: BaselineFoldPort | undefined,
    private readonly commit: (key: K, value: V | undefined) => void,
    private readonly label = 'staged-overlay',
  ) {}

  /** Is anything staged? False is the common path, and the holder's fast one. */
  get empty(): boolean {
    this.freshen()
    return this.staged === undefined
  }

  /**
   * A counter that moves on every stage, promotion and drop.
   *
   * For a holder that memoises a composed view: compare this rather than
   * rebuilding, and rebuild when it moves. Exposed because composing is the
   * holder's job — it is the only one that knows what its committed store looks
   * like.
   */
  get version(): number {
    this.freshen()
    return this.version_
  }

  /**
   * What this span staged for `key`, as `{ value }`, or `undefined` if it
   * staged nothing. A staged REMOVAL is `{ value: undefined }`, which is why
   * the answer is wrapped: "staged as absent" and "not staged" are different
   * answers and a bare `undefined` cannot tell them apart.
   */
  peek(key: K): { value: V | undefined } | undefined {
    this.freshen()
    const entry = this.staged?.get(key)
    return entry ? { value: entry.value } : undefined
  }

  /** Every staged entry, for a holder composing a view. */
  entries(): Iterable<readonly [K, V | undefined]> {
    this.freshen()
    const staged = this.staged
    if (!staged) return []
    return [...staged].map(([key, entry]) => [key, entry.value] as const)
  }

  /** Stage one write (or, with `undefined`, one removal). */
  set(key: K, value: V | undefined): void {
    this.stage([[key, value]])
  }

  /**
   * Stage several writes under ONE token — the batch case
   * `ChangeBaseline.stagePending` needs, where a single commit's rows must
   * promote together or not at all.
   *
   * With no span open this IS the outermost commit, so every entry is made
   * durable at once, which is where it happens today.
   */
  stage(entries: Iterable<readonly [K, V | undefined]>): void {
    this.freshen()
    const batch = [...entries]
    if (batch.length === 0) return
    if (!this.fold?.spanOpen()) {
      for (const [key, value] of batch) this.commit(key, value)
      this.version_++
      return
    }
    const token = ++this.nextToken
    // Registered FIRST, because every entry in the batch holds the handle its
    // own liveness is read through [POD-3364]. One batch, one registration: the
    // rows of a single commit promote together or not at all, so they die
    // together too.
    //
    // CLOSES OVER `batch`. See the rule in this module's header: reading the
    // staged slot back here is the lost-write both hand-rolled layers had.
    const registration = this.fold.onCommit(() => {
      for (const [key, value] of batch) {
        this.commit(key, value)
        const entry = this.staged?.get(key)
        if (entry?.token === token) this.staged?.delete(key)
      }
      if (this.staged?.size === 0) this.staged = undefined
      this.version_++
    }, this.label)
    const staged = (this.staged ??= new Map())
    for (const [key, value] of batch) staged.set(key, { token, value, registration })
    this.version_++
  }

  /**
   * Drop what a rolled-back span left staged. See the asymmetry above, BOTH
   * halves: no span open at all, and — one frame down — a registration whose
   * own unit of work rolled back while an outer span carries on [POD-3364].
   *
   * PUBLIC, because a holder may want to ask on the way IN rather than lazily.
   * It used to be the caller's job to get that timing right and it no longer
   * is, which is worth stating because the reasoning is recorded above it:
   *
   * `spanOpen()` alone answers "is ANY write span open", not "is the span that
   * staged this still open", so a caller whose own next act was to OPEN a span
   * had to ask BEFORE it did. Read lazily from inside that new span the answer
   * was `true` and the orphans survived, which was a stale overlay serving rows
   * a rollback threw away. POD-3366 learned that by deleting
   * `Authority.freshen()` during its retrofit and watching POD-3328's own test
   * fail — "leaves a baseline that still dedups correctly after the rollback",
   * `expected [] to deeply equal [ { id: 'c-rolled-back' } ]`.
   *
   * A dead registration is dead in ANY span, so that orphan now goes on the
   * next read wherever it happens, and the pre-span call is defence in depth
   * rather than the only thing holding the invariant. The test
   * "drops an orphan read lazily from inside a LATER span (the POD-3366
   * hazard)" pins it; it fails on the pre-POD-3364 tree.
   *
   * POD-3366 ALSO BUILT A SPAN IDENTITY ON THE PORT for this and took it back
   * out, because with the identity disabled every test still passed: both
   * holders happen to read their map BEFORE opening a span, so the boolean was
   * never asked at the dangerous moment, and an unexercised mechanism in a
   * kernel port looks like coverage and is not. That judgement was right for
   * what it had. What POD-3364 adds is not identity but LIVENESS, and it is
   * exercised — remove either half and a named test reds.
   */
  freshen(): void {
    if (!this.staged) return
    if (!this.fold?.spanOpen()) {
      this.staged = undefined
      this.version_++
      return
    }
    // FRAME GRANULARITY [POD-3364]. A span IS open, so the top-level rule above
    // has nothing to say — but it may be an OUTER span that is still going to
    // commit while the middle span that staged these entries rolled back. Only
    // the registration knows that, and it is asked, never told.
    let dropped = false
    for (const [key, entry] of this.staged) {
      if (entry.registration.live()) continue
      this.staged.delete(key)
      dropped = true
    }
    if (!dropped) return
    if (this.staged.size === 0) this.staged = undefined
    this.version_++
  }
}
