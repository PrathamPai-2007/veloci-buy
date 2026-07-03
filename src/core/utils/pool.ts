import { sleep, yieldEventLoop } from './io.js';

export function normalizeConcurrency(value: unknown, fallback: number = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.max(1, Math.floor(numeric));
}

export interface TaskRecord<T = unknown> {
  index: number;
  item: T;
  status: 'fulfilled' | 'rejected';
  value?: unknown;
  reason?: unknown;
  durationMs: number;
}

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
      const value =
        timeoutMs > 0
          ? await Promise.race([
              taskPromise,
              sleep(timeoutMs).then(() => {
                throw new Error(`Task timed out after ${timeoutMs}ms`);
              }),
            ])
          : await taskPromise;
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
