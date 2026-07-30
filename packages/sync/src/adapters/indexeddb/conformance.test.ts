// @vitest-environment happy-dom
/**
 * The cross-hop conformance suite, against a REAL IndexedDB engine (POD-374).
 *
 * Three lines of substance, which is the template `conformance/in-memory.test.ts`
 * set and the proof that the parameterization holds: nothing in `suite.ts` was
 * edited to admit this hop.
 *
 * UNDER happy-dom, which is POD-374's acceptance criterion — and which changes
 * which DOM globals surround the adapter, not which engine it talks to, because
 * happy-dom ships no IndexedDB. `environment.test.ts` measures that and fails the
 * day it stops being true.
 */
import { describeSyncConformance } from '../../conformance/suite'
import { indexedDbInstantiation } from './conformance'

describeSyncConformance(indexedDbInstantiation)
