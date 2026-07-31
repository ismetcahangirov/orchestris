CREATE TABLE `context_mcp_servers` (
	`context_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	PRIMARY KEY(`context_id`, `mcp_server_id`),
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `context_plugins` (
	`context_id` text NOT NULL,
	`plugin_source_id` text NOT NULL,
	PRIMARY KEY(`context_id`, `plugin_source_id`),
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plugin_source_id`) REFERENCES `plugin_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args_json` text DEFAULT '[]' NOT NULL,
	`env_json` text DEFAULT '{}' NOT NULL,
	`secret_env_json` text DEFAULT '[]' NOT NULL,
	`url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `plugin_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `contexts` ADD `builtin_skills_enabled` integer DEFAULT false NOT NULL;