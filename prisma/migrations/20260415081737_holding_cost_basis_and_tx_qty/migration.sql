-- AlterTable
ALTER TABLE `holding` ADD COLUMN `costBasisMinor` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `transaction` ADD COLUMN `investmentQuantity` DECIMAL(36, 18) NULL;

-- Backfill cost basis from non-revoked investment transactions (per account + instrument).
UPDATE `holding` h
INNER JOIN (
  SELECT `accountId`, `instrumentId`, SUM(`amountMinor`) AS costSum
  FROM `transaction`
  WHERE `type` = 'INVESTMENT'
    AND `deletedAt` IS NULL
    AND `revokedAt` IS NULL
    AND `instrumentId` IS NOT NULL
  GROUP BY `accountId`, `instrumentId`
) s ON s.`accountId` = h.`accountId` AND s.`instrumentId` = h.`instrumentId`
SET h.`costBasisMinor` = s.costSum
WHERE h.`deletedAt` IS NULL;
