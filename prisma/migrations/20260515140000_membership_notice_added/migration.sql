-- New notice when a user is added to a shared book (client polls /me/membership-notices).
ALTER TABLE `MembershipNotice` MODIFY COLUMN `kind` ENUM('REMOVED', 'ACCOUNT_DELETED', 'ADDED') NOT NULL;
