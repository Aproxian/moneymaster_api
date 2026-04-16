-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `refreshTokenHash` VARCHAR(191) NOT NULL,
    `userAgent` VARCHAR(191) NULL,
    `ip` VARCHAR(191) NULL,
    `revokedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Account` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'EUR',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Account_createdAt_idx`(`createdAt`),
    INDEX `Account_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountMember` (
    `userId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AccountMember_accountId_idx`(`accountId`),
    PRIMARY KEY (`userId`, `accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Category` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `icon` VARCHAR(191) NULL,
    `color` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Category_accountId_idx`(`accountId`),
    INDEX `Category_deletedAt_idx`(`deletedAt`),
    UNIQUE INDEX `Category_accountId_name_key`(`accountId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransferGroup` (
    `id` VARCHAR(191) NOT NULL,
    `initiatedById` VARCHAR(191) NOT NULL,
    `fromAccountId` VARCHAR(191) NOT NULL,
    `toAccountId` VARCHAR(191) NOT NULL,
    `fxRate` DECIMAL(18, 8) NULL,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    INDEX `TransferGroup_fromAccountId_createdAt_idx`(`fromAccountId`, `createdAt`),
    INDEX `TransferGroup_toAccountId_createdAt_idx`(`toAccountId`, `createdAt`),
    INDEX `TransferGroup_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Transaction` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `type` ENUM('INCOME', 'EXPENSE') NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `note` VARCHAR(191) NULL,
    `categoryId` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `transferGroupId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Transaction_accountId_occurredAt_idx`(`accountId`, `occurredAt`),
    INDEX `Transaction_categoryId_idx`(`categoryId`),
    INDEX `Transaction_createdByUserId_idx`(`createdByUserId`),
    INDEX `Transaction_transferGroupId_idx`(`transferGroupId`),
    INDEX `Transaction_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountCurrencyChange` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `changedById` VARCHAR(191) NOT NULL,
    `oldCurrency` VARCHAR(191) NOT NULL,
    `newCurrency` VARCHAR(191) NOT NULL,
    `fxRate` DECIMAL(18, 8) NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AccountCurrencyChange_accountId_changedAt_idx`(`accountId`, `changedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `action` ENUM('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'CURRENCY_CHANGE', 'TRANSFER_CREATE', 'MEMBER_ADD', 'MEMBER_REMOVE', 'LOGIN', 'LOGOUT') NOT NULL,
    `entity` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `AuditLog_entity_entityId_idx`(`entity`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Instrument` (
    `id` VARCHAR(191) NOT NULL,
    `provider` ENUM('TWELVEDATA', 'FINNHUB', 'POLYGON', 'ALPHAVANTAGE', 'OTHER') NOT NULL,
    `providerSymbol` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('STOCK', 'ETF', 'INDEX', 'CRYPTO', 'FOREX', 'FUTURE', 'COMMODITY', 'BOND', 'FUND', 'OTHER') NOT NULL,
    `currency` VARCHAR(191) NULL,
    `exchange` VARCHAR(191) NULL,
    `country` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Instrument_type_idx`(`type`),
    INDEX `Instrument_isActive_idx`(`isActive`),
    UNIQUE INDEX `Instrument_provider_providerSymbol_key`(`provider`, `providerSymbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Holding` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `instrumentId` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(36, 18) NOT NULL,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Holding_accountId_idx`(`accountId`),
    INDEX `Holding_instrumentId_idx`(`instrumentId`),
    INDEX `Holding_deletedAt_idx`(`deletedAt`),
    UNIQUE INDEX `Holding_accountId_instrumentId_key`(`accountId`, `instrumentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuoteCache` (
    `id` VARCHAR(191) NOT NULL,
    `instrumentId` VARCHAR(191) NOT NULL,
    `provider` ENUM('TWELVEDATA', 'FINNHUB', 'POLYGON', 'ALPHAVANTAGE', 'OTHER') NOT NULL,
    `price` DECIMAL(18, 8) NOT NULL,
    `currency` VARCHAR(191) NULL,
    `asOf` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QuoteCache_instrumentId_asOf_idx`(`instrumentId`, `asOf`),
    INDEX `QuoteCache_provider_asOf_idx`(`provider`, `asOf`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountMember` ADD CONSTRAINT `AccountMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountMember` ADD CONSTRAINT `AccountMember_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Category` ADD CONSTRAINT `Category_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferGroup` ADD CONSTRAINT `TransferGroup_initiatedById_fkey` FOREIGN KEY (`initiatedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferGroup` ADD CONSTRAINT `TransferGroup_fromAccountId_fkey` FOREIGN KEY (`fromAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferGroup` ADD CONSTRAINT `TransferGroup_toAccountId_fkey` FOREIGN KEY (`toAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transaction` ADD CONSTRAINT `Transaction_transferGroupId_fkey` FOREIGN KEY (`transferGroupId`) REFERENCES `TransferGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountCurrencyChange` ADD CONSTRAINT `AccountCurrencyChange_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountCurrencyChange` ADD CONSTRAINT `AccountCurrencyChange_changedById_fkey` FOREIGN KEY (`changedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Holding` ADD CONSTRAINT `Holding_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Holding` ADD CONSTRAINT `Holding_instrumentId_fkey` FOREIGN KEY (`instrumentId`) REFERENCES `Instrument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuoteCache` ADD CONSTRAINT `QuoteCache_instrumentId_fkey` FOREIGN KEY (`instrumentId`) REFERENCES `Instrument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
