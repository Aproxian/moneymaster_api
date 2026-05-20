-- AlterTable
ALTER TABLE `Category` ADD COLUMN `lockedForManualEntry` BOOLEAN NOT NULL DEFAULT false;

-- Transfer categories are reserved for transfer flows only
UPDATE `Category`
SET `lockedForManualEntry` = true
WHERE `internalKey` IN ('TRANSFER_SEND', 'TRANSFER_RECEIVE');
