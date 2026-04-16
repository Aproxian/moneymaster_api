-- AlterTable Account
ALTER TABLE `Account` ADD COLUMN `isBusiness` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `companyName` VARCHAR(200) NULL,
    ADD COLUMN `companyLegalName` VARCHAR(200) NULL,
    ADD COLUMN `companyTaxId` VARCHAR(80) NULL,
    ADD COLUMN `companyAddress` TEXT NULL,
    ADD COLUMN `companyNotes` TEXT NULL;

-- AlterTable User
ALTER TABLE `User` ADD COLUMN `personalAccountId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `User_personalAccountId_key` ON `User`(`personalAccountId`);

ALTER TABLE `User` ADD CONSTRAINT `User_personalAccountId_fkey` FOREIGN KEY (`personalAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: first owned account per user (by Account.createdAt)
UPDATE `User` u
SET `personalAccountId` = (
  SELECT a.`id`
  FROM `AccountMember` m
  INNER JOIN `Account` a ON a.`id` = m.`accountId` AND a.`deletedAt` IS NULL
  WHERE m.`userId` = u.`id` AND m.`role` = 'OWNER'
  ORDER BY a.`createdAt` ASC
  LIMIT 1
)
WHERE u.`personalAccountId` IS NULL;
