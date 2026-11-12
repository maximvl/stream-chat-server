CREATE TABLE `banned_ips` (
	`ip` text PRIMARY KEY NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
