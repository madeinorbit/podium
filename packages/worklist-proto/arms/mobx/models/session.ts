/**
 * POD-4447 — session leaf model. Sessions are leaves in the tracked graph:
 * no computeds of their own, just the borrowed row behind an `observable.ref`
 * box. Issue computeds read `model.value` fields directly, so a session
 * change invalidates exactly the issues that read that session.
 */

import { makeObservable, observableRef } from 'mobx'
import type { SliceSession } from '../../../shared/src/slice-types'

export class SessionModel {
  /** Borrowed immutable stream object; replaced, never mutated. */
  value: SliceSession

  constructor(value: SliceSession) {
    this.value = value
    makeObservable(this, {
      value: observableRef,
    })
  }
}
