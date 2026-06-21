import os
import sys
import json
import kagglehub
from collections import Counter

def main():
    print("==================================================")
    print("📥 AOL USER SESSION DATASET INGESTER 📥")
    print("==================================================\n")

    # 1. Download dataset using kagglehub
    try:
        print("📡 Triggering kagglehub dataset download...")
        path = kagglehub.dataset_download("dineshydv/aol-user-session-collection-500k")
        print(f"✅ Dataset successfully downloaded to: {path}")
    except Exception as e:
        print(f"❌ Failed to download dataset using kagglehub: {e}")
        sys.exit(1)

    # 2. Locate the user-ct-test-collection-02.txt file
    txt_file = None
    for root, dirs, files in os.walk(path):
        for f in files:
            if f.endswith(".txt") and "user-ct-test" in f:
                txt_file = os.path.join(root, f)
                break
        if txt_file:
            break

    if not txt_file:
        print("❌ Could not locate 'user-ct-test-collection-02.txt' file in the downloaded path.")
        sys.exit(1)

    print(f"📂 Found AOL query log file: {txt_file}")

    # 3. Parse and aggregate query frequencies
    print("\n⏳ Parsing query logs and aggregating frequencies (this might take a few seconds)...")
    query_counts = Counter()
    total_lines = 0
    parsed_lines = 0

    try:
        with open(txt_file, 'r', encoding='utf-8', errors='ignore') as f:
            # Read header: AnonID, Query, QueryTime, ItemRank, ClickURL
            header = f.readline()
            
            for line in f:
                total_lines += 1
                parts = line.split('\t')
                if len(parts) >= 2:
                    query = parts[1].strip().lower()
                    # Filter out empty queries, single character garbage, and literal headers
                    if query and len(query) > 1 and query != "query":
                        query_counts[query] += 1
                        parsed_lines += 1

                if total_lines % 5000000 == 0:
                    print(f"   Processed {total_lines} lines...")

    except Exception as e:
        print(f"❌ Error reading query logs: {e}")
        sys.exit(1)

    print(f"✅ Processed {total_lines} total lines from query logs.")
    print(f"✅ Found {len(query_counts)} unique queries.")

    # 4. Extract top 100,500 most popular queries
    target_count = 100500
    print(f"\n🏆 Extracting the top {target_count} most frequent real queries...")
    top_queries = query_counts.most_common(target_count)

    # 5. Format and write to data/dataset.json
    output_dir = "data"
    output_path = os.path.join(output_dir, "dataset.json")
    os.makedirs(output_dir, exist_ok=True)

    formatted_dataset = []
    for query, count in top_queries:
        formatted_dataset.append({
            "query": query,
            "count": count
        })

    try:
        print(f"✍️  Writing parsed actual dataset to: {output_path}...")
        with open(output_path, 'w', encoding='utf-8') as out_f:
            json.dump(formatted_dataset, out_f, indent=2, ensure_ascii=False)
        print(f"✅ File successfully written. Size: {os.path.getsize(output_path) / (1024*1024):.2f} MB")
    except Exception as e:
        print(f"❌ Failed to write dataset.json: {e}")
        sys.exit(1)

    # 6. Delete local db.json and wal.log to force reload of the new dataset
    local_db = os.path.join(output_dir, "db.json")
    local_wal = os.path.join(output_dir, "wal.log")
    
    print("\n🧹 Cleaning up local caches to force database hydration...")
    if os.path.exists(local_db):
        try:
            os.remove(local_db)
            print(f"✅ Deleted stale local DB file: {local_db}")
        except Exception as e:
            print(f"⚠️ Could not delete local DB file: {e}")

    if os.path.exists(local_wal):
        try:
            os.remove(local_wal)
            print(f"✅ Deleted stale local WAL log: {local_wal}")
        except Exception as e:
            print(f"⚠️ Could not delete local WAL log: {e}")

    print("\n==================================================")
    print("🎉 AOL DATASET INGESTION COMPLETED SUCCESSFULLY 🎉")
    print("==================================================")

if __name__ == "__main__":
    main()
