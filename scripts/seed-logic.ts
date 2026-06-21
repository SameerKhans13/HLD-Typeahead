import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// List of realistic topics to build high-quality queries
const ADJECTIVES = [
  "best", "how to learn", "easy", "free", "cheap", "top 10", "latest", "online", 
  "complete", "for beginners", "advanced", "modern", "simple", "fast", "secure",
  "ultimate", "step by step", "professional", "quick", "clean", "premium"
];

const SUBJECTS = [
  "iphone 15", "iphone charger", "java", "javascript", "react", "typescript",
  "bun js", "elysia js", "node js", "python", "machine learning", "artificial intelligence", 
  "rust", "go lang", "c++", "html css", "sql database", "mongodb", "postgresql",
  "docker", "kubernetes", "aws cloud", "git github", "algorithms", "data structures",        
  "web development", "mobile app", "game dev", "cybersecurity", "ethical hacking",
  "chatgpt", "large language model", "neural network", "deep learning", "computer vision",   
  "data science", "pandas library", "numpy", "matplotlib", "scikit learn",
  "pizza", "sushi", "coffee shop", "vegan recipes", "gluten free", "meal prep",
  "laptop", "smartphone", "smartwatch", "wireless headphones", "mechanical keyboard",        
  "running shoes", "gym workout", "yoga poses", "protein powder", "home gym",
  "flights", "hotels", "weather forecast", "stock market", "cryptocurrency",
  "bitcoin price", "real estate", "rental apartments", "car insurance", "credit cards",      
  "online shopping", "fidget spinner", "gaming mouse", "ergonomic chair", "desk setup",      
  "funny memes", "action movies", "documentaries", "indie games", "board games",
  "smart tv", "bluetooth speaker", "tablet", "monitor", "graphic card", "motherboard",       
  "backpack", "sunglasses", "jacket", "hoodie", "jeans", "socks", "water bottle"
];

const SUFFIXES = [
  "tutorial", "guide", "documentation", "examples", "exercises", "course", "bootcamp",       
  "price", "specs", "reviews", "alternatives", "download", "jobs", "salary", "interview questions",
  "for absolute beginners", "vs comparison", "how it works", "best practices", "common mistakes",
  "setup", "configuration", "debugging", "performance tips", "deployment"
];

const YEARS = ["2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027", "2028"];      
const COLORS_OR_VERSIONS = ["black", "white", "blue", "red", "green", "gold", "silver", "pro", "max", "mini", "v2", "v3", "v4", "v5"];

export interface SeedRecord {
  query: string;
  count: number;
}

export async function runSeed(outputPath: string, count: number = 100500): Promise<SeedRecord[]> {   
  const uniqueQueries = new Set<string>();

  // Base core queries
  const coreQueries = [
    "iphone", "iphone 15", "iphone charger", "java tutorial", "javascript",
    "react", "typescript", "bun", "elysia", "node", "python", "rust"
  ];
  coreQueries.forEach(q => uniqueQueries.add(q));

  // Generate combinations until we hit the requested count
  let safetyCounter = 0;
  while (uniqueQueries.size < count && safetyCounter < 2000000) {
    safetyCounter++;
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const subj = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
    const suff = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
    const yr = YEARS[Math.floor(Math.random() * YEARS.length)];
    const opt = COLORS_OR_VERSIONS[Math.floor(Math.random() * COLORS_OR_VERSIONS.length)];   

    // Randomly combine items to keep length variations realistic
    const pattern = Math.random();
    let query = "";
    if (pattern < 0.15) {
      query = `${adj} ${subj}`;
    } else if (pattern < 0.3) {
      query = `${subj} ${suff}`;
    } else if (pattern < 0.45) {
      query = `${subj} ${opt}`;
    } else if (pattern < 0.6) {
      query = `${subj} ${yr}`;
    } else if (pattern < 0.8) {
      query = `${adj} ${subj} ${suff}`;
    } else {
      query = `${adj} ${subj} ${opt} ${yr} ${suff}`;
    }

    query = query.toLowerCase().trim();
    if (query.length > 2) {
      uniqueQueries.add(query);
    }
  }

  // Map to structured dataset format with random but logical popularity counts
  const dataset = Array.from(uniqueQueries).map((query, index) => {
    // Top historical queries get very large counts, others get decayed popularities
    let popularityCount = 10;
    if (index < 50) {
      popularityCount = Math.floor(Math.random() * 50000) + 50000; // 50k - 100k
    } else if (index < 1000) {
      popularityCount = Math.floor(Math.random() * 10000) + 1000;  // 1k - 11k
    } else {
      popularityCount = Math.floor(Math.random() * 950) + 10;      // 10 - 960
    }

    return { query, count: popularityCount };
  });

  // Ensure output directory exists
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write file out
  writeFileSync(outputPath, JSON.stringify(dataset, null, 2), "utf-8");

  return dataset;
}
export default runSeed;
