export const DECAY_HALF_LIFE_MINUTES = 5;
export const LAMBDA = Math.LN2 / DECAY_HALF_LIFE_MINUTES; // ~0.138629

export interface BucketEntry {
  bucketId: number;
  count: number;
}

export function calculateDecayScore(
  baselineCount: number,
  buckets: BucketEntry[],
  currentBucketId: number
): number {
  let recentScore = 0;
  for (const bucket of buckets) {
    const dt = currentBucketId - bucket.bucketId;
    if (dt >= 0) {
      recentScore += bucket.count * Math.exp(-LAMBDA * dt);
    }
  }
  // Blend historical baseline count with heavily-boosted recent decayed count
  return baselineCount + recentScore * 10000;
}
