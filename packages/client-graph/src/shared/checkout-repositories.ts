/**
 * The registered repositories, derived from `checkout` records (POD-6644). The
 * derivation is the model's (`repositoriesFromCheckouts`), shared with the
 * client store's navigation reactions.
 */
export {
  type CheckoutRepository,
  checkoutRepositoryId,
  repositoriesFromCheckouts,
} from '@podium/model'
