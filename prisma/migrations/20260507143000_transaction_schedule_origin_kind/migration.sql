-- AlterTable
ALTER TABLE `Transaction` ADD COLUMN `scheduleOriginKind` ENUM('DELAY_ONCE', 'RECURRING') NULL;
