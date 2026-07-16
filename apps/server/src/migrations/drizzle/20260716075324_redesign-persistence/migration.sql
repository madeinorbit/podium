ALTER TABLE `issues` ADD `color` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `human_question_options` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `human_question_asked_by` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `human_question_asked_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `working_ms_total` integer;