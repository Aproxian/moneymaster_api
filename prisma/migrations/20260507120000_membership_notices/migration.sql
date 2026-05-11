-- CreateTable
CREATE TABLE `MembershipNotice` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `kind` ENUM('REMOVED', 'ACCOUNT_DELETED') NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `accountName` VARCHAR(200) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `MembershipNotice_userId_idx` ON `MembershipNotice`(`userId`);

-- AddForeignKey
ALTER TABLE `MembershipNotice` ADD CONSTRAINT `MembershipNotice_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
