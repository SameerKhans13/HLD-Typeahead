import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

async function main() {
  console.log("==================================================");
  console.log("📥 DOWNLOADING ORIGINAL GOOGLE WEB CORPUS DATASET 📥");
  console.log("==================================================\n");

  const url = "https://norvig.com/ngrams/count_1w.txt";
  const outputPath = "data/dataset.json";

  console.log(`🌐 Downloading Peter Norvig's Google Trillion-Word Frequency list...`);
  console.log(`🔗 URL: ${url}`);

  try {
    const start = performance.now();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download: HTTP ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const endDownload = performance.now();
    console.log(`✅ Download complete! (Took ${((endDownload - start) / 1000).toFixed(2)} seconds)`);

    console.log("\n⚙️  Processing 333,333 raw words into structured 100k+ format...");
    const lines = text.trim().split("\n");
    const dataset = [];

    // Process first 100,500 high-frequency words
    const limit = Math.min(lines.length, 100500);
    for (let i = 0; i < limit; i++) {
      const line = lines[i].trim();
      const parts = line.split("\t");
      if (parts.length === 2) {
        const query = parts[0].toLowerCase().trim();
        const rawCount = parseInt(parts[1], 10);

        // Scale counts so they fit nicely in standard metrics/DB displays
        // Google Trillion-Word counts are in billions, so we scale them down by dividing by 10,000
        const count = Math.max(10, Math.round(rawCount / 10000));

        if (query && query.length >= 2 && !isNaN(count)) {
          dataset.push({ query, count });
        }
      }
    }

    const endProcess = performance.now();
    console.log(`✅ Processing complete! Parsed ${dataset.length} unique words with real frequencies.`);

    console.log(`\n💾 Writing dataset to disk at "${outputPath}"...`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(outputPath, JSON.stringify(dataset, null, 2), "utf-8");
    console.log(`✨ Successfully ingested original Google Web Corpus dataset into "${outputPath}"!`);
    console.log(`🚀 Ready to seed PostgreSQL or reload your Trie server.`);
    console.log("==================================================");
  } catch (err) {
    console.error("❌ Error downloading/processing original dataset:", err);
    console.log("💡 Falling back to keeping the synthetic dataset generator.");
  }
}

main().catch(console.error);
