import { localMarketState, LocalMarketStateStore } from './local-market-state.js';
import { priceHistoryEngine, PriceHistoryEngine } from './price-history-engine.js';
import { liquidityEngine, LiquidityEngine } from './liquidity-engine.js';
import {
  tokenAccountIndex,
  TokenAccountIndexService,
} from '../account-index/token-account-index.js';
import { marketTapeManager, MarketTapeManager } from './market-tape-manager.js';
import {
  PricePoint,
  LocalMarketSnapshot,
  MarketStateStatus,
  MarketPriceDetails,
} from './market-state.types.js';

export class UnifiedMarketDataProvider {
  constructor(
    private readonly stateStore: LocalMarketStateStore = localMarketState,
    private readonly priceHistory: PriceHistoryEngine = priceHistoryEngine,
    private readonly liquidityEngineRef: LiquidityEngine = liquidityEngine,
    private readonly accountIndex: TokenAccountIndexService = tokenAccountIndex,
    private readonly tape: MarketTapeManager = marketTapeManager
  ) {}

  getLiquidityEngine(): LiquidityEngine {
    return this.liquidityEngineRef;
  }

  getPrice(mint: string): number | null {
    return this.stateStore.getPrice(mint);
  }

  getLiquidity(mint: string): number | null {
    return this.stateStore.getLiquidity(mint);
  }

  getFDV(mint: string): number | null {
    return this.stateStore.getFDV(mint);
  }

  getSnapshot(mint: string): LocalMarketSnapshot | null {
    return this.stateStore.getSnapshot(mint);
  }

  getStateStatus(mint: string): MarketStateStatus {
    return this.stateStore.getStateStatus(mint);
  }

  getMarketPriceDetails(mint: string, maxAgeMs = 10_000): MarketPriceDetails {
    return this.stateStore.getMarketPriceDetails(mint, maxAgeMs);
  }

  isProvisional(mint: string): boolean {
    return this.stateStore.isProvisional(mint);
  }

  isAuthoritative(mint: string): boolean {
    return this.stateStore.isAuthoritative(mint);
  }

  getPriceHistory(mint: string): PricePoint[] {
    return this.priceHistory.getPriceHistory(mint);
  }

  getMomentum(mint: string, windowMs = 60_000): number {
    return this.priceHistory.getMomentum(mint, windowMs);
  }

  getVolatility(mint: string, windowMs = 60_000): number {
    return this.priceHistory.getVolatility(mint, windowMs);
  }

  getTop5Concentration(mint: string): number | null {
    const conc = this.accountIndex.getConcentration(mint);
    return conc ? conc.top5ConcentrationPct : null;
  }

  getSwapVolume(
    mint: string,
    windowMs = 60_000
  ): { buyVolumeSol: number; sellVolumeSol: number; tradeCount: number } {
    return this.tape.getSwapVolume(mint, windowMs);
  }
}

export const marketDataProvider = new UnifiedMarketDataProvider();
