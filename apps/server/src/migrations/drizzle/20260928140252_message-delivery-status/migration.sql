-- POD-4765: the forward-only delivery lifecycle gets its own column. Expand-only:
-- the column CHECK rides on ADD COLUMN, so no table rebuild, and the legacy
-- `status` column stays as written for a one-release rollback.
ALTER TABLE `messages` ADD `delivery_status` text DEFAULT 'stored' NOT NULL CONSTRAINT `messages_delivery_status` CHECK(delivery_status IN ('stored','dispatched','reached-machine','typing','typed','confirmed','cancelled','failed','expired','unknown'));
--> statement-breakpoint
-- The hidden sub-state becomes a status: a queued row that carries `injected_at`
-- was handed on (dispatched); one without it is still held (stored). `read`
-- folds into `confirmed` (read_at already records the read).
UPDATE `messages` SET `delivery_status` = CASE
  WHEN `status` = 'queued' AND `injected_at` IS NOT NULL THEN 'dispatched'
  WHEN `status` = 'queued' THEN 'stored'
  WHEN `status` IN ('delivered', 'read') THEN 'confirmed'
  WHEN `status` = 'dead_letter' THEN 'failed'
  ELSE `status`
END;
--> statement-breakpoint
CREATE INDEX `idx_messages_recipient_delivery` ON `messages` (`to_kind`,`to_id`,`delivery_status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_delivery_order` ON `messages` (`delivery_status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_delivery_expiry_explicit` ON `messages` (`delivery_status`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_delivery_expiry_implicit` ON `messages` (`delivery_status`,`lifecycle`,`expires_at`,`created_at`,`id`);
