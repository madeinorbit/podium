/**
 * The suite, against the instantiation CI runs (POD-373's first acceptance criterion).
 *
 * This file is deliberately three lines of substance. It is the template every later
 * hop copies: POD-307 (client storage), POD-308 (wire cutover), POD-309 (upstream
 * retirement), POD-374 (IndexedDB) and POD-375 (mobile SQLite) each add a file
 * exactly like this one with their own `SyncInstantiation`, and change nothing in
 * `suite.ts`. If a hop ever needs to edit the suite to pass, the parameterization
 * has failed and that is the bug.
 */
import { inMemoryInstantiation } from './in-memory'
import { describeSyncConformance } from './suite'

describeSyncConformance(inMemoryInstantiation)
