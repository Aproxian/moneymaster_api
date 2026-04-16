-- DropIndex
DROP INDEX `Category_accountId_name_key` ON `category`;

-- AlterTable
ALTER TABLE `category` ADD COLUMN `type` ENUM('INCOME', 'EXPENSE', 'INVESTMENT') NULL;

-- AlterTable
ALTER TABLE `holding` ADD COLUMN `categoryId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Category_accountId_type_name_key` ON `Category`(`accountId`, `type`, `name`);

-- CreateIndex
CREATE INDEX `Holding_categoryId_idx` ON `Holding`(`categoryId`);

-- AddForeignKey
ALTER TABLE `Holding` ADD CONSTRAINT `Holding_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
