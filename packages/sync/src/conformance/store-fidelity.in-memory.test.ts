/**
 * Store-fidelity probes and the collection obligations against the in-memory
 * instantiation (POD-1130, POD-7086).
 */
import { describeCollectionStore } from './collections'
import { inMemoryInstantiation } from './in-memory'
import { describeStoreFidelity } from './store-fidelity'

describeStoreFidelity(inMemoryInstantiation)

describeCollectionStore(inMemoryInstantiation)
