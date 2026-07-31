CREATE TABLE `task_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`question` text NOT NULL,
	`kind` text NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`answer_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`asked_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `questions_task_idx` ON `task_questions` (`task_id`,`asked_at`);--> statement-breakpoint
CREATE INDEX `questions_status_idx` ON `task_questions` (`status`);--> statement-breakpoint
CREATE TABLE `task_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`text` text NOT NULL,
	`mode` text NOT NULL,
	`applied_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_task_idx` ON `task_reviews` (`task_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `contexts` ADD `questions_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_key` text;