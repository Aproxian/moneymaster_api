-- AlterTable
ALTER TABLE `Transaction` ADD COLUMN `revokedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Transaction_accountId_revokedAt_idx` ON `Transaction`(`accountId`, `revokedAt`);
