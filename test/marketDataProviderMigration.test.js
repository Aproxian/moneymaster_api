const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function readSchemaProviderValues() {
  const schema = fs.readFileSync(path.join(repoRoot, "prisma", "schema.prisma"), "utf8");
  const match = schema.match(/enum\s+MarketDataProvider\s*\{([\s\S]*?)\}/);
  assert.ok(match, "MarketDataProvider enum is present in schema.prisma");
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
}

function parseSqlEnumValues(raw) {
  return [...raw.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function providerEnumChangesForTable(sql, tableName) {
  const matches = [];

  const alterRe = new RegExp(
    String.raw`ALTER\s+TABLE\s+\`${tableName}\`\s+MODIFY\s+\`provider\`\s+ENUM\(([^)]*)\)`,
    "gi"
  );
  for (const match of sql.matchAll(alterRe)) {
    matches.push({ index: match.index, values: parseSqlEnumValues(match[1]) });
  }

  const createRe = new RegExp(
    String.raw`CREATE\s+TABLE\s+\`${tableName}\`\s*\(([\s\S]*?)\)\s+DEFAULT`,
    "gi"
  );
  for (const match of sql.matchAll(createRe)) {
    const provider = match[1].match(/`provider`\s+ENUM\(([^)]*)\)/i);
    if (provider) {
      matches.push({ index: match.index, values: parseSqlEnumValues(provider[1]) });
    }
  }

  return matches.sort((a, b) => a.index - b.index);
}

function latestMigratedProviderValues(tableName) {
  const migrationsDir = path.join(repoRoot, "prisma", "migrations");
  const migrationDirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let latest = null;
  for (const migrationDir of migrationDirs) {
    const migrationPath = path.join(migrationsDir, migrationDir, "migration.sql");
    if (!fs.existsSync(migrationPath)) continue;
    const sql = fs.readFileSync(migrationPath, "utf8");
    for (const change of providerEnumChangesForTable(sql, tableName)) {
      latest = change.values;
    }
  }

  return latest;
}

test("MarketDataProvider migration enum matches schema for persisted provider columns", () => {
  const schemaValues = readSchemaProviderValues();

  for (const tableName of ["Instrument", "QuoteCache"]) {
    assert.deepEqual(
      latestMigratedProviderValues(tableName),
      schemaValues,
      `${tableName}.provider migration enum should match schema.prisma MarketDataProvider`
    );
  }
});
