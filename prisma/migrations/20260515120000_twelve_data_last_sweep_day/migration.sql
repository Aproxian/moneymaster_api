-- Track last calendar day (Europe/Sofia) a full background quote sweep completed.
ALTER TABLE `TwelveDataQuoteRefreshState` ADD COLUMN `lastBackgroundSweepCompletedDate` VARCHAR(10) NULL;
