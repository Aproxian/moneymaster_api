-- Wishlist instruments per investment category
CREATE TABLE `CategoryWishlistItem` (
    `id` VARCHAR(191) NOT NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `instrumentId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CategoryWishlistItem_categoryId_idx`(`categoryId`),
    INDEX `CategoryWishlistItem_instrumentId_idx`(`instrumentId`),
    UNIQUE INDEX `CategoryWishlistItem_categoryId_instrumentId_key`(`categoryId`, `instrumentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CategoryWishlistItem` ADD CONSTRAINT `CategoryWishlistItem_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CategoryWishlistItem` ADD CONSTRAINT `CategoryWishlistItem_instrumentId_fkey` FOREIGN KEY (`instrumentId`) REFERENCES `Instrument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
