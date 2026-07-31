ALTER TABLE `contexts` ADD `file_access` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `contexts` ADD `extra_dirs_json` text DEFAULT '[]' NOT NULL;