-- AlterTable
ALTER TABLE `Account` ADD COLUMN `walletMigrationPending` BOOLEAN NOT NULL DEFAULT false;
