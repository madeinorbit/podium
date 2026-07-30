/**
 * The Outbox role of the sync kernel — ADR 3 D9's lifecycle, ADR 6 D4.3's
 * durability class, ADR 2 D7's "keep the outbox" rule, and the multi-user
 * consequences the ADR 3 amendment (POD-1073) attaches to all three.
 *
 * L2 and infrastructure-neutral: ports only, injected. Nothing here imports a
 * storage engine or a transport.
 */
export * from './outbox'
export * from './ports'
export * from './reasons'
export * from './records'
export * from './states'

/** In-memory port implementations for tests and the POD-373 conformance suite.
 *  Exported from the package because the conformance suite is parameterised by
 *  instantiation and the in-memory instantiation is the one CI runs. */
export * from './test-doubles'
