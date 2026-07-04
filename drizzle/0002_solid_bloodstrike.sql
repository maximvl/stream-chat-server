ALTER TABLE `tokens` RENAME COLUMN "token" TO "access_token";--> statement-breakpoint
ALTER TABLE `tokens` ADD `created_at_str` text NOT NULL;