import { StateStore } from '#core/store.js';
import { TrainMetrics } from '../model-bucket.js';

export function recordRetrainMetrics(
  store: StateStore | null,
  metrics: TrainMetrics,
  maxRetrainHistory: number
): void {
  if (!store) return;
  store.upsertKV('ml:lastRetrainMetrics', JSON.stringify(metrics));

  let history: Array<TrainMetrics & { at: string }> = [];
  try {
    const raw = store.getKV('ml:retrainHistory');
    if (raw) history = JSON.parse(raw) as Array<TrainMetrics & { at: string }>;
  } catch {
    history = [];
  }
  history.push({ ...metrics, at: new Date().toISOString() });
  if (history.length > maxRetrainHistory) {
    history = history.slice(history.length - maxRetrainHistory);
  }
  store.upsertKV('ml:retrainHistory', JSON.stringify(history));
}
