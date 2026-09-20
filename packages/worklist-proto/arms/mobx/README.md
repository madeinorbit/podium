# arms/mobx/ — owned by the MobX arm (POD-4447)

Tracked object graph (methodology §5.3): domain models as classes with
observable fields and computed getters, relations through the graph
(`issue.parent/children/sessions`), one `runInAction` per publication,
enforcement on, no `keepAlive`, `observer` rows, windowed list.

No imports from legacy view-model / slice / mission / presentation /
replica-view code (H4 shape review gate, methodology §6.1).
