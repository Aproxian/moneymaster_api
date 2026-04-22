-- AlterTable
ALTER TABLE `User`
    ADD COLUMN `firstDayOfWeek` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `appLockEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `appLockPasswordHash` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `PendingTransactionSchedule` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `kind` ENUM('DELAY_ONCE', 'RECURRING') NOT NULL,
    `status` ENUM('PENDING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `executeAt` DATETIME(3) NULL,
    `recurrenceUnit` ENUM('HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR') NULL,
    `intervalCount` INTEGER NOT NULL DEFAULT 1,
    `hourOfDay` INTEGER NULL,
    `nextRunAt` DATETIME(3) NOT NULL,
    `lastRunAt` DATETIME(3) NULL,
    `payload` JSON NOT NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PendingTransactionSchedule_accountId_status_nextRunAt_idx`(`accountId`, `status`, `nextRunAt`),
    INDEX `PendingTransactionSchedule_createdByUserId_idx`(`createdByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PendingTransactionSchedule` ADD CONSTRAINT `PendingTransactionSchedule_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PendingTransactionSchedule` ADD CONSTRAINT `PendingTransactionSchedule_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
