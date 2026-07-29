ALTER TABLE `tasks` ADD `subtask_index` integer;--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`,`subtask_index`);