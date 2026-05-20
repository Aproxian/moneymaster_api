const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("category manual-lock migration uses MySQL identifier quoting", () => {
  const sql = fs.readFileSync(
    path.resolve(
      __dirname,
      "../prisma/migrations/20260512120000_category_locked_for_manual_entry/migration.sql"
    ),
    "utf8"
  );

  assert.match(sql, /ALTER TABLE `Category`/);
  assert.match(sql, /UPDATE `Category`/);
  assert.doesNotMatch(sql, /"Category"|"lockedForManualEntry"|"internalKey"/);
});
