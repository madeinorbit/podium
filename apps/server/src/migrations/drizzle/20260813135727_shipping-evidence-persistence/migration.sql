ALTER TABLE `ship_orders` ADD `evidence_manifest_ref` text;--> statement-breakpoint
ALTER TABLE `ship_orders` ADD `current_integration_receipt` text;--> statement-breakpoint
DROP TRIGGER `ship_orders_frozen_fields`;--> statement-breakpoint
CREATE TRIGGER `ship_orders_frozen_fields` BEFORE UPDATE OF
  `issue_id`, `repo_id`, `target_branch`, `destination`, `approved_base_sha`,
  `approved_head_sha`, `descendant_manifest`, `delivery_depends_on`,
  `evidence_manifest_ref`, `current_integration_receipt`, `provider_ref`,
  `requested_by_actor_kind`, `requested_by_actor_id`, `requested_by_on_behalf_of`,
  `requested_at`, `policy_id`, `close_mode`
ON `ship_orders`
BEGIN
  SELECT RAISE(ABORT, 'ship order approval is immutable');
END;
