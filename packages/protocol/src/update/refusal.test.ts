import { describe, expect, it } from 'vitest'
import {
  CODE_FOR_UPDATE_FAILURE_TOKEN,
  classifyUpdateFailureDetail,
  matchUpdateFailureToken,
  UPDATE_FAILURE_EXAMPLES,
  UPDATE_FAILURE_TOKENS,
} from './refusal'

/**
 * THE TABLE'S OWN GATE (POD-2241).
 *
 * Ordering is the part of this table that is easy to get wrong and impossible
 * to see: a pattern added in the wrong place silently steals sentences from a
 * row below it. That is not hypothetical — the withdrawn-target detail wraps
 * the development publisher's prose, and a real one says "uncommitted", so
 * before it was anchored and moved first it was read as the MACHINE's dirty
 * working tree and the operator was sent to commit files on a machine that had
 * none.
 *
 * So every row's own example must come back as that row. Nothing else here can
 * catch an ordering mistake.
 */
describe('the shared refusal table', () => {
  it('classifies every row by its own example, in the order declared', () => {
    for (const token of UPDATE_FAILURE_TOKENS) {
      expect(matchUpdateFailureToken(UPDATE_FAILURE_EXAMPLES[token]), token).toBe(token)
    }
  })

  it('has one example and one code per token, and no duplicate tokens', () => {
    expect(new Set(UPDATE_FAILURE_TOKENS).size).toBe(UPDATE_FAILURE_TOKENS.length)
    for (const token of UPDATE_FAILURE_TOKENS) {
      expect(UPDATE_FAILURE_EXAMPLES[token], token).toBeTruthy()
      expect(CODE_FOR_UPDATE_FAILURE_TOKEN[token], token).toBeTruthy()
    }
  })

  /**
   * The default is the honest answer for ONE input — a machine that said
   * nothing — and a confident lie for anything that reported a local error.
   * Keeping it reachable matters as much as keeping it narrow: a table that
   * classified everything would have no way to say "this machine went quiet".
   */
  it('reserves unreachable for silence and preserves an unexpected reported failure', () => {
    expect(classifyUpdateFailureDetail(undefined)).toBe('machine-unreachable')
    expect(classifyUpdateFailureDetail('   ')).toBe('machine-unreachable')
    const detail = 'ENOENT: no such file or directory, open /state/runtime/pending-update.json.tmp'
    expect(matchUpdateFailureToken(detail)).toBeUndefined()
    expect(classifyUpdateFailureDetail(detail)).toBe('machine-update-failed')
  })

  /**
   * The specific collision that motivated the anchor. `update-withdrawn` is the
   * only row whose detail carries somebody else's whole sentence after it, so
   * it is the only row where a later pattern can be reached by accident.
   */
  it('does not let prose inside a withdrawal claim another row', () => {
    const withdrawn = 'update-withdrawn: The source checkout has 2 uncommitted changes.'
    expect(classifyUpdateFailureDetail(withdrawn)).toBe('update-withdrawn')
    // The same words WITHOUT the prefix are still the machine's own checkout.
    expect(classifyUpdateFailureDetail('The source checkout has 2 uncommitted changes.')).toBe(
      'machine-dirty-checkout',
    )
  })

  /**
   * The git steps must not be reachable through the network family, which is
   * broad by necessity (an errno can say almost anything). `fetch-failed` on
   * either side of the prefix is the sharpest case.
   */
  it('keeps a git step apart from a network error that spells it the same way', () => {
    expect(classifyUpdateFailureDetail('git delivery failed: fetch-failed')).toBe(
      'machine-delivery-failed',
    )
    expect(classifyUpdateFailureDetail('fetch failed')).toBe('download-failed')
  })

  /**
   * `schema-unreadable` carries the underlying read error verbatim, so an errno
   * inside it must not be re-read as a download problem by a later row.
   */
  it('classifies a schema refusal by its token, not by the errno it quotes', () => {
    expect(
      classifyUpdateFailureDetail(
        "cannot converge: schema-unreadable — this machine's database could not be read " +
          '(ETIMEDOUT while waiting for the lock)',
      ),
    ).toBe('machine-schema-unreadable')
  })
})
