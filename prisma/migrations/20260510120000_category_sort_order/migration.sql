-- AlterTable
ALTER TABLE `Category` ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX `Category_accountId_type_sortOrder_idx` ON `Category`(`accountId`, `type`, `sortOrder`);
