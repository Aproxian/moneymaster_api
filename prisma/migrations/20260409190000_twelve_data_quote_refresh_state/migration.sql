-- Cursor for chunked Twelve Data quote refresh (one slice per cron tick).
CREATE TABLE `TwelveDataQuoteRefreshState` (
    `id` VARCHAR(191) NOT NULL,
    `nextOffset` INTEGER NOT NULL DEFAULT 0,
    `totalSnapshot` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
