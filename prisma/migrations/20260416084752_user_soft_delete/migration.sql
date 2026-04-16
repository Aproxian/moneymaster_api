-- AlterTable
ALTER TABLE `user` ADD COLUMN `deletedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `User_deletedAt_idx` ON `User`(`deletedAt`);
