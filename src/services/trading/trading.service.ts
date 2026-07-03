export * from './wallet-manager.js';
export * from './fee-manager.js';
export * from './swap-executor.js';
export * from './paper-broker.js';

import {
  getWalletAddress,
  getWalletTokenBalance,
  getAllWalletTokenBalances,
  getSolBalance,
  closeAssociatedTokenAccount,
} from './wallet-manager.js';
import { fetchDynamicPriorityFee, getDynamicJitoTip } from './fee-manager.js';
import {
  fetchSwapOrder,
  executeSwapOrder,
  executeSwapOrderWithSmartRetry,
  confirmJitoBundle,
} from './swap-executor.js';
import {
  estimateSolUsdPrice,
  estimateSolUsdValue,
  buildPaperBuyQuote,
  buildPaperSellQuote,
} from './paper-broker.js';

export const tradingService = {
  getWalletAddress,
  getWalletTokenBalance,
  getAllWalletTokenBalances,
  fetchDynamicPriorityFee,
  fetchSwapOrder,
  executeSwapOrder,
  executeSwapOrderWithSmartRetry,
  estimateSolUsdPrice,
  estimateSolUsdValue,
  buildPaperBuyQuote,
  buildPaperSellQuote,
  getSolBalance,
  closeAssociatedTokenAccount,
  getDynamicJitoTip,
  confirmJitoBundle,
};
