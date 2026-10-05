import { configure } from 'mobx'

/** App startup opts in once; production leaves MobX defaults untouched. */
export function configureDevelopmentChecks(development: boolean): void {
  if (!development) return
  configure({
    enforceActions: 'always',
    computedRequiresReaction: true,
    reactionRequiresObservable: true,
    // Event handlers normally read observables outside a reaction.
    observableRequiresReaction: false,
  })
}
