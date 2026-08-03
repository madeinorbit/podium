/**
 * Store-fidelity probes against the in-memory instantiation (POD-1130).
 * Three lines of substance, like `in-memory.test.ts`.
 */
import { inMemoryInstantiation } from './in-memory'
import { describeStoreFidelity } from './store-fidelity'

describeStoreFidelity(inMemoryInstantiation)
