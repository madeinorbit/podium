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
 * ---------------------------------------------------------------------------
 * THE PROMOTION CLOSES OVER ITS VALUE, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * The registered step installs the value it was registered WITH, rather than
 * reading `staged` back at drain time. During the drain the outermost frame is
 * already closed, so `spanOpen()` answers false — and any other commit
 * application in the same batch that happens to READ this projection would
 * freshen the staged slot away before ours ran, silently losing the install.
 * Closing over the value makes the order of a drain irrelevant.
 */

import type { BaselineFoldPort } from './ports'

export class StagedProjection<S> {
  private staged: { token: number; value: S } | undefined
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
    this.staged = { token, value }
    this.fold.onCommit(() => {
      this.committed = value
      if (this.staged?.token === token) this.staged = undefined
    }, this.label)
  }

  /** Install a value derived from what a reader would see right now. */
  update(next: (current: S) => S): void {
    this.install(next(this.read()))
  }

  /** Drop what a rolled-back span left staged. See the asymmetry above. */
  private freshen(): void {
    if (this.staged && !this.fold?.spanOpen()) this.staged = undefined
  }
}
