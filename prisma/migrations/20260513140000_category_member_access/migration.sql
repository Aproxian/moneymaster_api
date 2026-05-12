-- Category creator + per-member manual-entry ACL for shared accounts
ALTER TABLE `Category` ADD COLUMN `createdByUserId` VARCHAR(191) NULL,
    ADD COLUMN `memberAccessRestricted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `newMembersLockedByDefault` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `Category_createdByUserId_idx` ON `Category`(`createdByUserId`);

ALTER TABLE `Category` ADD CONSTRAINT `Category_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `CategoryMemberAccess` (
    `categoryId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`categoryId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `CategoryMemberAccess_userId_idx` ON `CategoryMemberAccess`(`userId`);

ALTER TABLE `CategoryMemberAccess` ADD CONSTRAINT `CategoryMemberAccess_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CategoryMemberAccess` ADD CONSTRAINT `CategoryMemberAccess_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
