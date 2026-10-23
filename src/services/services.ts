import {
  fetchRecentLaunches,
  fetchTrendingLaunches,
  fetchDirectMarketData,
  fetchPrices,
  fetchPricesBestEffort,
} from './market-data.js';

import { buyCandidate } from './buy.js';

import { monitorPositions, closeAllOpenPositions, mergeLoopRequest } from './monitor-utils.js';

import {
  evaluateCandidate as engineEvaluateCandidate,
  getLaunchpadProfile as engineGetLaunchpadProfile,
  looksLikeMemecoin as engineLooksLikeMemecoin,
} from './engine/engine.service.js';

import { getMoodAdjustments as monitorGetMoodAdjustments } from './monitor/monitor.service.js';

/**
 * Application service container exposing discovery, engine scoring, market data,
 * paper/live buying, and position monitoring functions.
 */
export const evaluateCandidate = engineEvaluateCandidate;
export const getLaunchpadProfile = engineGetLaunchpadProfile;
export const looksLikeMemecoin = engineLooksLikeMemecoin;
export const getMoodAdjustments = monitorGetMoodAdjustments;

export {
  fetchRecentLaunches,
  fetchTrendingLaunches,
  fetchDirectMarketData,
  fetchPrices,
  fetchPricesBestEffort,
  buyCandidate,
  monitorPositions,
  closeAllOpenPositions,
  mergeLoopRequest,
};

/**
 * Unified application service instance for component injection and testing.
 */
export const appService = {
  fetchRecentLaunches,
  fetchTrendingLaunches,
  fetchDirectMarketData,
  fetchPrices,
  fetchPricesBestEffort,
  evaluateCandidate,
  getLaunchpadProfile,
  looksLikeMemecoin,
  buyCandidate,
  monitorPositions,
  closeAllOpenPositions,
  getMoodAdjustments,
  mergeLoopRequest,
};
