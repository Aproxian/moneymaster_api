-- Premium access mirror (RevenueCat `full_access`), updated by POST /webhooks/revenuecat.
ALTER TABLE `User`
    ADD COLUMN `premiumActive` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `premiumProductId` VARCHAR(191) NULL,
    ADD COLUMN `premiumStore` VARCHAR(32) NULL,
    ADD COLUMN `premiumPeriodType` VARCHAR(32) NULL,
    ADD COLUMN `premiumExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `premiumWillRenew` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `premiumIsLifetime` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `premiumUpdatedAt` DATETIME(3) NULL,
    ADD COLUMN `revenueCatCustomerId` VARCHAR(191) NULL;

-- Idempotency log for RevenueCat webhook deliveries.
CREATE TABLE `RevenueCatEvent` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `type` VARCHAR(64) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RevenueCatEvent_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
