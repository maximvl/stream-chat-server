CREATE TABLE `app_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server` text NOT NULL,
	`access_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_at_str` text NOT NULL,
	`expires_at` integer NOT NULL,
	`expires_at_str` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_server_unique` ON `app_tokens` (`server`);