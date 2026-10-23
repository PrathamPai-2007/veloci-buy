export type { ParamSpec } from './optimizers/exit-param-tuner.js';

export {
  PARAM_SPECS,
  extractCurrentParams,
  replayNetPnl,
  estimateGradients,
  replayNetPnlFromSamples,
  estimateGradientsFromSamples,
  scoreExitParams,
  restoreParams,
  weightedAverageGradients,
  applyGradientStep,
} from './optimizers/exit-param-tuner.js';

export {
  ENTRY_PARAM_SPECS,
  extractCurrentEntryParams,
  decodeEntryFeatures,
  replayEntryNetPnl,
  estimateEntryGradients,
} from './optimizers/entry-param-tuner.js';
