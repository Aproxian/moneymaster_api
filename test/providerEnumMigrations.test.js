const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
const migrationsDir = path.join(repoRoot, "prisma", "migrations");

function readMarketDataProvidersFromSchema() {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const match = schema.match(/enum\s+MarketDataProvider\s+\{([\s\S]*?)\}/);
  assert.ok(match, "MarketDataProvider enum not found in prisma/schema.prisma");

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .map((line) => line.split(/\s+/)[0]);
}

function parseSqlEnumValues(enumBody) {
  return Array.from(enumBody.matchAll(/'([^']+)'/g), (match) => match[1]);
}

function readFinalProviderEnumFromMigrations(tableName) {
  let latestValues = null;
  const migrationDirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of migrationDirs) {
    const migrationPath = path.join(migrationsDir, dir, "migration.sql");
    if (!fs.existsSync(migrationPath)) continue;
    const sql = fs.readFileSync(migrationPath, "utf8");
    const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const createTableMatch = sql.match(
      new RegExp(
        `CREATE\\s+TABLE\\s+\`${escapedTable}\`\\s*\\([\\s\\S]*?\`provider\`\\s+ENUM\\(([^)]*)\\)`,
        "i"
      )
    );
    if (createTableMatch) {
      latestValues = parseSqlEnumValues(createTableMatch[1]);
    }

    const alterMatches = sql.matchAll(
      new RegExp(
        `ALTER\\s+TABLE\\s+\`${escapedTable}\`[\\s\\S]*?(?:MODIFY|CHANGE)\\s+(?:COLUMN\\s+)?\`provider\`(?:\\s+\`provider\`)?\\s+ENUM\\(([^)]*)\\)`,
        "gi"
      )
    );
    for (const match of alterMatches) {
      latestValues = parseSqlEnumValues(match[1]);
    }
  }

  assert.ok(latestValues, `provider enum not found in migrations for ${tableName}`);
  return latestValues;
}

test("provider enum migrations match the Prisma MarketDataProvider enum", () => {
  const schemaProviders = readMarketDataProvidersFromSchema();

  for (const tableName of ["Instrument", "QuoteCache"]) {
    assert.deepEqual(
      readFinalProviderEnumFromMigrations(tableName),
      schemaProviders,
      `${tableName}.provider migration enum must match schema.prisma`
    );
  }
});
