/**
 * Phone-side re-export of the shared demo fixtures (POD-5277).
 *
 * The fixtures and the kernel seeding live in `@podium/client-core/demo` —
 * one home for both apps' demo mode — so the two surfaces cannot drift. This
 * module stays as the import site the phone's screens and tests already name.
 */
export * from '@podium/client-core/demo'
