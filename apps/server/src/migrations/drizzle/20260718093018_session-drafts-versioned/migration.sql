ALTER TABLE `session_drafts` ADD `rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_drafts` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `session_drafts` ADD `history` text;