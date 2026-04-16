-- AlterTable
ALTER TABLE `transaction` ADD COLUMN `instrumentId` VARCHAR(191) NULL,
    MODIFY `type` ENUM('INCOME', 'EXPENSE', 'INVESTMENT') NOT NULL;

-- CreateIndex
CREATE INDEX `Transaction_instrumentId_idx` ON `Transaction`(`instrumentId`);

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_instrumentId_fkey` FOREIGN KEY (`instrumentId`) REFERENCES `Instrument`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
