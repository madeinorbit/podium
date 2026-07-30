/**
 * The cross-hop conformance suite, against a REAL IndexedDB engine (POD-374).
 *
 * Three lines of substance, which is the template `conformance/in-memory.test.ts`
 * set and the proof that the parameterization holds: nothing in `suite.ts` was
 * edited to admit this hop.
 */
import { describeSyncConformance } from '../../conformance/suite'
import { indexedDbInstantiation } from './conformance'

describeSyncConformance(indexedDbInstantiation)
