import { existsSync, unlinkSync, readFileSync } from "fs";
import { runSeed } from "./seed-logic";
import postgres from "postgres";

async function main() {
  console.log("==================================================");
  console.log("🌱 STARTING DATABASE SEEDING ENGINE 🌱");
  console.log("==================================================\n");

  const outputPath = "data/dataset.json";
  const localDbPath = "data/db.json";
  const localWalPath = "data/wal.log";

  // 1. Clean up local filesystem database cache to ensure clean reload
  console.log("🧹 Cleaning up stale local caches...");
  if (existsSync(localDbPath)) {
    try {
      unlinkSync(localDbPath);
      console.log(`✅ Deleted stale local DB file: ${localDbPath}`);
    } catch (err) {
      console.warn(`⚠️ Could not delete local DB file: ${err}`);
    }
  }
  if (existsSync(localWalPath)) {
    try {
      unlinkSync(localWalPath);
      console.log(`✅ Deleted stale local WAL log: ${localWalPath}`);
    } catch (err) {
      console.warn(`⚠️ Could not delete local WAL log: ${err}`);
    }
  }

  // 2. Ingest the actual AOL query log dataset
  console.log("\n📦 Ingesting real-world AOL User Session Collection (100,500 entries)...");
  const startGen = performance.now();
  try {
    const { execSync } = require("child_process");
    execSync("python scripts/download_and_parse_aol.py", { stdio: "inherit" });
  } catch (err) {
    console.error("❌ Failed to execute python AOL ingester:", err);
    process.exit(1);
  }
  const endGen = performance.now();
  console.log(`⏱️ AOL Ingestion completed in ${((endGen - startGen) / 1000).toFixed(2)} seconds.`);

  // Load the real AOL dataset written to dataset.json
  if (!existsSync(outputPath)) {
    console.error(`❌ Expected parsed dataset file at ${outputPath} is missing!`);
    process.exit(1);
  }
  const datasetContent = readFileSync(outputPath, "utf-8");
  const dataset: { query: string; count: number }[] = JSON.parse(datasetContent);

  // 3. Optional: Seed PostgreSQL if DATABASE_URL is present
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    console.log(`\n📡 DATABASE_URL detected. Seeding PostgreSQL database...`);
    console.log(`🔗 Target: ${dbUrl.replace(/:[^:]+@/, ':****@')}`);

    const sql = postgres(dbUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10
    });

    try {
      // Create PostgreSQL tables if not exists
      console.log("⚙️  Initializing PostgreSQL tables...");
      await sql.begin(async (tx) => {
        await tx`
          CREATE TABLE IF NOT EXISTS search_queries (
            query VARCHAR(255) PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `;
        await tx`
          CREATE TABLE IF NOT EXISTS time_buckets (
            query VARCHAR(255) NOT NULL,
            bucket_id INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (query, bucket_id)
          )
        `;
      });
      console.log("✅ PostgreSQL tables are ready.");

      // Clear existing records to ensure a fresh, consistent seed
      console.log("🗑️  Truncating old PostgreSQL queries...");
      await sql`TRUNCATE TABLE search_queries CASCADE`;
      await sql`TRUNCATE TABLE time_buckets CASCADE`;

      // Bulk insertion using fast chunked batches (5,000 records per batch)
      const batchSize = 5000;
      console.log(`🚀 Bulk importing ${dataset.length} records into Postgres (batch size: ${batchSize})...`);
      const startImport = performance.now();

      for (let i = 0; i < dataset.length; i += batchSize) {
        const batch = dataset.slice(i, i + batchSize);
        const rows = batch.map(item => ({
          query: item.query,
          count: item.count,
          updated_at: new Date()
        }));

        await sql`
          INSERT INTO search_queries (query, count, updated_at)
          VALUES ${sql(rows, 'query', 'count', 'updated_at')}
          ON CONFLICT (query) DO UPDATE SET
            count = EXCLUDED.count,
            updated_at = NOW()
        `;
        
        const progress = Math.min(i + batchSize, dataset.length);
        console.log(`⏳ Imported ${progress}/${dataset.length} (${((progress / dataset.length) * 100).toFixed(0)}%)`);
      }

      const endImport = performance.now();
      console.log(`✅ Bulk import complete!`);
      console.log(`⏱️ Import time: ${((endImport - startImport) / 1000).toFixed(2)} seconds`);

    } catch (err) {
      console.error("❌ Failed to seed PostgreSQL database:", err);
    } finally {
      await sql.end();
    }
  } else {
    console.log("\n💡 DATABASE_URL not detected. PostgreSQL seeding skipped.");
    console.log("👉 The local file-system fallback database will load the real AOL search query logs on next startup.");
  }

  console.log("\n==================================================");
  console.log("🎉 DATABASE SEEDING PROCESS COMPLETED SUCCESSFULLY 🎉");
  console.log("==================================================");
}

main().catch(err => {
  console.error("💥 Critical seeder failure:", err);
  process.exit(1);
});
