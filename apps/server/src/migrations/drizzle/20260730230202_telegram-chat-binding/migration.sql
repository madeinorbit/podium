CREATE TABLE `telegram_chat_bindings` (
	`chat_id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`bound_at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`on_behalf_of` text
);
