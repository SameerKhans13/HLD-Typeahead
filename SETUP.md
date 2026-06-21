# Setup and Deployment Instructions

Follow these instructions to run the distributed autocomplete service locally or in a containerized environment.

---

## Prerequisites

- **Bun Runtime** (v1.x) installed locally (if running outside Docker).
- **Docker & Docker Compose** (if running the clustered setup).

---

## 1. Quick Start (Local Setup)

### Step 1: Install Dependencies
```bash
bun install
```

### Step 2: Seed the Fallback Database
Extracts 100,500 real user queries and creates the initial cache file:
```bash
bun run seed
```

### Step 3: Run the Development Server
Starts the API server at `http://localhost:3000`:
```bash
bun run dev
```

---

## 2. Clustered Setup (Docker Compose)

The clustered configuration spins up Nginx as a load balancer routing traffic across 3 App Instances, 3 Redis Cache Instances, and 1 PostgreSQL persistent database.

### Step 1: Launch Containers
Run the following command to build and start the entire cluster in the background:
```bash
docker compose up --build -d
```

### Step 2: Seed PostgreSQL Database (Automatic)
The application automatically seeds PostgreSQL from `data/dataset.json` upon its first boot.

### Step 3: Access UI
Open your browser and navigate to:
```
http://localhost
```

---

## 3. Environment Configurations

If custom ports or hosts are required, configure these variables in a `.env` file at the root:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Local service port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | *Optional* |
| `REDIS_NODES` | Comma-separated consistent hash targets | *Optional* |

---

## 4. Running Tests

Verify code functionality with the comprehensive unit test suite:
```bash
bun test
```
This runs 32 localized tests covering consistent hashing, Trie traversal, WAL, caching, and APIs.
