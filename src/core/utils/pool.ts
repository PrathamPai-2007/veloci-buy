import { yieldEventLoop } from './io.js';

/**
 * Normalizes a concurrency value to a valid positive integer.
 * @param value - Candidate concurrency value.
 * @param fallback - Fallback concurrency if invalid (default: 1).
 * @returns Valid concurrency integer >= 1.
 */
export function normalizeConcurrency(value: unknown, fallback: number = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.max(1, Math.floor(numeric));
}

/**
 * Task execution record detailing task index, status, output/error, and duration.
 */
export interface TaskRecord<T = unknown> {
  index: number;
  item: T;
  status: 'fulfilled' | 'rejected';
  value?: unknown;
  reason?: unknown;
  durationMs: number;
}

/**
 * Executes a list of asynchronous items concurrently using a bounded pool.
 * @param items - Array of items to process.
 * @param worker - Worker function processing each item.
 * @param options - Pool configuration (concurrency, timeout, lifecycle hooks).
 * @returns Array of TaskRecord results preserving original item order.
 */
export async function runBoundedPool<T = unknown>(
  items: T[],
  worker: (item: T, index: number) => Promise<unknown>,
  options: {
    concurrency?: number;
    timeoutMs?: number;
    onTaskStart?: (info: { item: T; index: number }) => void;
    onTaskComplete?: (record: TaskRecord<T>) => void;
    onTaskError?: (record: TaskRecord<T>) => void;
  } = {}
): Promise<TaskRecord<T>[]> {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const concurrency = normalizeConcurrency(options.concurrency, 1);
  const timeoutMs = Number(options.timeoutMs || 0);
  const results = new Array<TaskRecord<T>>(list.length);
  let nextIndex = 0;

  const executeTask = async (item: T, index: number): Promise<void> => {
    const startedAt = Date.now();
    options.onTaskStart?.({ item, index });
    try {
      const taskPromise = Promise.resolve().then(() => worker(item, index));
      taskPromise.catch(() => {});
      let value: unknown;
      if (timeoutMs > 0) {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Task timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        try {
          value = await Promise.race([taskPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      } else {
        value = await taskPromise;
      }
      const record: TaskRecord<T> = {
        index,
        item,
        status: 'fulfilled',
        value,
        durationMs: Date.now() - startedAt,
      };
      results[index] = record;
      options.onTaskComplete?.(record);
    } catch (reason) {
      const record: TaskRecord<T> = {
        index,
        item,
        status: 'rejected',
        reason,
        durationMs: Date.now() - startedAt,
      };
      results[index] = record;
      options.onTaskError?.(record);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    let processedSinceYield = 0;
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      await executeTask(list[index]!, index);

      processedSinceYield++;
      if (processedSinceYield >= 50) {
        processedSinceYield = 0;
        await yieldEventLoop();
      }
    }
  });

  await Promise.all(workers);
  return results;
}
