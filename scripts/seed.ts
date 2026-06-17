import { runSeed } from "./seed-logic";

async function main() {
  console.log("Seeding synthetic search typeahead dataset (100k+ entries)...");
  const outputPath = "data/dataset.json";
  
  const start = performance.now();
  await runSeed(outputPath, 100500);
  const end = performance.now();
  
  console.log(`Seeding complete! File written to: ${outputPath}`);
  console.log(`Time taken: ${((end - start) / 1000).toFixed(2)} seconds`);
}

main().catch(console.error);
