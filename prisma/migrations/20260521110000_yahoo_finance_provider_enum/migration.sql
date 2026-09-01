-- Allow persisted instruments and quote cache rows to use the Yahoo Finance provider
-- added to the Prisma MarketDataProvider enum.
ALTER TABLE `Instrument`
  MODIFY `provider` ENUM('TWELVEDATA', 'FINNHUB', 'POLYGON', 'ALPHAVANTAGE', 'YAHOOFINANCE', 'OTHER') NOT NULL;

ALTER TABLE `QuoteCache`
  MODIFY `provider` ENUM('TWELVEDATA', 'FINNHUB', 'POLYGON', 'ALPHAVANTAGE', 'YAHOOFINANCE', 'OTHER') NOT NULL;
