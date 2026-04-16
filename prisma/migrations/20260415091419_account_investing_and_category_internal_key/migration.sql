-- AlterTable
ALTER TABLE `account` ADD COLUMN `investingEnabled` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `category` ADD COLUMN `internalKey` VARCHAR(64) NULL;

-- Backfill internalKey for default investment wishlist names (legacy rows).
UPDATE `category` SET `internalKey` = 'INV_STOCKS' WHERE `type` = 'INVESTMENT' AND `name` = 'Stocks' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_ETFS' WHERE `type` = 'INVESTMENT' AND `name` = 'ETFs' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_INDICES' WHERE `type` = 'INVESTMENT' AND `name` = 'Indices' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_CRYPTO' WHERE `type` = 'INVESTMENT' AND `name` = 'Crypto' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_FOREX' WHERE `type` = 'INVESTMENT' AND `name` = 'Forex' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_FUTURES' WHERE `type` = 'INVESTMENT' AND `name` = 'Futures' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_COMMODITIES' WHERE `type` = 'INVESTMENT' AND `name` = 'Commodities' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_BONDS' WHERE `type` = 'INVESTMENT' AND `name` = 'Bonds' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_FUNDS' WHERE `type` = 'INVESTMENT' AND `name` = 'Funds' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'INV_OTHER' WHERE `type` = 'INVESTMENT' AND `name` = 'Other' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
UPDATE `category` SET `internalKey` = 'CASH_OUT_INVESTMENT' WHERE `type` = 'INCOME' AND `name` = 'Cash Out Investment' AND `internalKey` IS NULL AND `deletedAt` IS NULL;
