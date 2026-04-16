-- Normalize NULL exchange so venue-aware uniqueness is well-defined.
UPDATE `Instrument` SET `exchange` = '' WHERE `exchange` IS NULL;

-- Drop old unique (provider + symbol only).
DROP INDEX `Instrument_provider_providerSymbol_key` ON `Instrument`;

-- Require exchange with empty-string default for "no venue".
ALTER TABLE `Instrument` MODIFY `exchange` VARCHAR(191) NOT NULL DEFAULT '';

-- New unique: same ticker allowed on different exchanges.
CREATE UNIQUE INDEX `Instrument_provider_providerSymbol_exchange_key` ON `Instrument`(`provider`, `providerSymbol`, `exchange`);
