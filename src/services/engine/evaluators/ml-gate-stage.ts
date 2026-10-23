import { EvaluationResult } from '#types/index.js';
import { mlService } from '#ml/ml-service.js';
import { extractFeatures } from '#ml/features.js';

/**
 * Applies the ML scoring gate to an already rule-approved evaluation result.
 * In shadow mode the ML score is attached but never gates the trade.
 */
export function applyMlGate(result: EvaluationResult): EvaluationResult {
  const mlScore = mlService.getScore(result);
  if (!mlScore) return result;

  const features = extractFeatures(result);
  const mlFeaturesJson = JSON.stringify(Array.from(features));

  if (mlScore.blocked && !mlScore.shadowMode) {
    return {
      ...result,
      approved: false,
      blockers: [...result.blockers, 'ML model confidence below threshold'],
      rejectionReasons: [
        ...result.rejectionReasons,
        { code: 'ml-low-confidence', recheckEligible: true },
      ],
      mlScore,
      mlFeaturesJson,
    };
  }

  return {
    ...result,
    mlScore,
    mlFeaturesJson,
    tpProfileOverride: mlScore.shadowMode ? undefined : mlScore.tpProfile,
  };
}
