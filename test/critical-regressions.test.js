const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("account-scoped accountsRouter routes are behind premium enforcement", () => {
  const source = readRepoFile("src/routes/accounts.js");

  assert.match(source, /require\("\.\.\/middleware\/requirePremium"\)/);
  assert.match(source, /accountsRouter\.use\("\/:accountId", requirePremium\);/);
});

test("quote-cache trim retains rows per instrument instead of globally newest rows", () => {
  const source = readRepoFile("src/routes/investments.js");

  assert.match(source, /ROW_NUMBER\(\) OVER/);
  assert.match(source, /PARTITION BY instrumentId/);
  assert.match(source, /WHERE rn <= \$\{keepMostRecentCount\}/);
  assert.doesNotMatch(source, /ORDER BY createdAt DESC, asOf DESC, id DESC LIMIT/);
});
