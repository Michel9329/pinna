/**
 * Pinna - deleting R2 blobs.
 *
 * Calling R2.delete() with every key at once (it accepts at most 1,000 per
 * call) and swallowing the error with .catch, AFTER the D1 rows are already
 * gone, would leave blobs without a row: invisible, never deleted again, but
 * still on R2 (cost and personal data). So keys are deleted in batches of
 * 1,000 and the caller removes the D1 rows of each batch ONLY after R2 has
 * confirmed it: if R2 fails, the rows stay and the next attempt (cron or user)
 * retries.
 */

/** Maximum number of keys per R2Bucket.delete() call. */
export const R2_DELETE_BATCH = 1000;

/**
 * Deletes `keys` in batches; after each successful batch it calls `afterBatch`
 * (to remove that batch's D1 rows). It stops at the first failed batch.
 * Returns how many keys were deleted and whether something failed.
 */
export async function deleteR2InBatches(
  bucket: R2Bucket,
  keys: string[],
  afterBatch?: (batch: string[]) => Promise<void>,
): Promise<{ deleted: number; failed: boolean }> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    const batch = keys.slice(i, i + R2_DELETE_BATCH);
    try {
      await bucket.delete(batch);
    } catch (e) {
      console.error('[pinna] R2 delete failed, D1 rows kept for a retry:', (e as Error).message);
      return { deleted, failed: true };
    }
    if (afterBatch) await afterBatch(batch);
    deleted += batch.length;
  }
  return { deleted, failed: false };
}
