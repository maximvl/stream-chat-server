CREATE TABLE `tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server` text NOT NULL,
	`token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expires_in` integer NOT NULL
);
