CREATE TABLE `carried_sign_ins` (
	`old_token_hash` text PRIMARY KEY,
	`device_sign_in_id` text NOT NULL,
	`sealed` text NOT NULL,
	`expires_at` text NOT NULL,
	`member_id` text NOT NULL,
	`old_label` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_carried_sign_ins_expires` ON `carried_sign_ins` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_carried_sign_ins_member` ON `carried_sign_ins` (`member_id`);--> statement-breakpoint
CREATE INDEX `idx_carried_sign_ins_label` ON `carried_sign_ins` (`old_label`);