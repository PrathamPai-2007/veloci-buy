export const readmeContent = `
# Built for the speed of Solana.

Veloci-Buy is an automated trading engine that finds, evaluates, and trades new Solana tokens — faster and more precisely than any manual process could.

---

> **Risk Disclosure**
> Trading digital assets carries significant financial risk. You may lose all of your capital. Veloci-Buy is not financial advice, and past performance does not predict future results. Only trade with what you can afford to lose entirely.

---

## Catch launches before the crowd

Veloci-Buy listens directly to raw blockchain events — not explorers, not APIs with lag. New token launches are detected within seconds of hitting the chain, before most traders even know they exist.

## Five gates between you and a rug

Every candidate token passes through a layered evaluation pipeline before a single dollar is committed:

- **Survival delay** — waits out the "instant dump" window where creators immediately sell
- **Security audit** — checks mint authority, token ownership, and top wallet concentrations
- **Valuation check** — rejects pools with unbalanced liquidity or inflated market caps
- **Anti-FOMO guard** — skips tokens already in a parabolic vertical pump
- **ML confidence gate** — once trained, the model blocks low-confidence setups automatically

Tokens that pass all five proceed to execution.

## MEV-protected execution

Orders are routed through validator bundle networks to prevent front-running and sandwich attacks. You don't buy at the price you see — you buy at the price you intended.

## Machine learning, trained on real outcomes

Veloci-Buy runs "ghost positions" — zero-capital shadow trades that track real price movement to generate ground-truth training data. The ML model trains on what actually happened, not simulations. Once it has seen enough real results, it begins filtering entries autonomously.

## Exits that protect profits and cut losses fast

Position monitoring runs a full layered exit stack in real time:

- Trailing stop that rises with price and never falls back
- Partial take-profits at configurable price tiers
- Moon-bag runner that holds a tranche on a wider stop for larger moves
- Rug-exit guard that detects sudden collapse and exits with maximum urgency
- Loss-streak breaker that pauses entries after consecutive losses

## Multiple strategies, one engine

**Burst Mode** is a short-duration scalp strategy for fast-moving opportunities — tighter parameters, shorter holds, higher urgency. Toggle it from the dashboard without restarting.

**Swing Bot** targets tokens that have completed their bonding curve and entered standard pools. It holds for minutes to hours, entering on double-dip and volume-accumulation signals.

## A live dashboard, always in sync

The web dashboard connects directly to the trading engine over a secure real-time connection. View active signals, open positions, session P&L, ML model health, and a live activity log — all updating as events happen.

---

*Veloci-Buy is an independent project. Not affiliated with Solana Foundation, Raydium, or any other protocol.*
`;
