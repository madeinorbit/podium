/**
 * Store-fidelity probes against a REAL SQLite engine (POD-1130 work item 3).
 * See the sibling IndexedDB file for why the in-memory run alone is not enough.
 */
import { describePersonalRowCompleteness } from '../../conformance/personal-row-completeness'
import { describeStoreFidelity } from '../../conformance/store-fidelity'
import { sqliteInstantiation } from './conformance'

describeStoreFidelity(sqliteInstantiation)

describePersonalRowCompleteness(sqliteInstantiation)
