// @vitest-environment happy-dom
/**
 * Store-fidelity probes against a REAL IndexedDB engine (POD-1130 work item 3).
 *
 * The point of running them here and not only in memory: anything the in-memory
 * double permits that a real transaction forbids is a false green for the whole
 * conformance suite, and the double is what CI runs on every commit.
 */
import { describeStoreFidelity } from '../../conformance/store-fidelity'
import { indexedDbInstantiation } from './conformance'

describeStoreFidelity(indexedDbInstantiation)
