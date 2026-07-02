-- IANA timezone for the user (drives personal account + default for new accounts).
ALTER TABLE `User`
    ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC';

-- IANA timezone for each account (past-dated transactions anchor to noon in this zone).
ALTER TABLE `Account`
    ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC';
