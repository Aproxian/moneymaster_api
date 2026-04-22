-- AlterTable
ALTER TABLE `Account` ADD COLUMN `walletsEnabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `AccountWallet` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `emoji` VARCHAR(16) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `internalKey` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `AccountWallet_accountId_idx`(`accountId`),
    INDEX `AccountWallet_accountId_deletedAt_idx`(`accountId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AccountWallet` ADD CONSTRAINT `AccountWallet_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE `Transaction` ADD COLUMN `transferPairId` VARCHAR(191) NULL,
    ADD COLUMN `walletId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Transaction_transferPairId_idx` ON `Transaction`(`transferPairId`);
CREATE INDEX `Transaction_walletId_idx` ON `Transaction`(`walletId`);

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `AccountWallet`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
