-- Cross-process visibility for TWELVEDATA background sweep (GET vs POST on different Node workers).
ALTER TABLE `TwelveDataQuoteRefreshState`
  ADD COLUMN `backgroundSweepSessionStartedAt` DATETIME(3) NULL,
  ADD COLUMN `backgroundSweepLastTickAt` DATETIME(3) NULL,
  ADD COLUMN `backgroundSweepStartedByUserId` VARCHAR(191) NULL,
  ADD COLUMN `backgroundSweepInstrumentsSnapshot` INT NULL,
  ADD COLUMN `backgroundSweepCancelRequested` BOOLEAN NOT NULL DEFAULT false;
