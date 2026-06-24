ALTER TABLE `Transaction`
  ADD COLUMN `investmentCostBasisMinor` INTEGER NULL;

UPDATE `Transaction`
SET `investmentCostBasisMinor` = `amountMinor`
WHERE `type` = 'INVESTMENT'
  AND `instrumentId` IS NOT NULL
  AND `investmentQuantity` IS NOT NULL
  AND `investmentCostBasisMinor` IS NULL;
