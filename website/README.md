# Veloci-Buy Web Dashboard

A React + Vite single-page app for the [Veloci-Buy](../) Solana execution engine. It provides a
marketing landing page, Google sign-in (Firebase Auth), a documentation view, and a live trading
dashboard that streams engine state over WebSocket.

## Stack

- React 19 + TypeScript, built with Vite
- GSAP for animation (gated behind `prefers-reduced-motion`)
- Firebase Auth (Google sign-in)
- WebSocket client → the bot's API server (`src/services/api.service.ts`, default `ws://localhost:8080`)

## Getting started

```bash
npm install
cp .env.example .env   # optional — sensible defaults are baked in
npm run dev            # Vite dev server
npm run build          # tsc -b && vite build → dist/
npm run preview        # serve the production build
npm run lint           # eslint
```

To see live data in the dashboard, run the bot with its API server enabled so it listens on the
WebSocket port the dashboard points at.

## Configuration

All config is supplied via build-time Vite env vars (see [.env.example](.env.example)). Because
they are embedded in the bundle, **never put secrets here** — the Firebase web keys are public
project identifiers, not credentials.

| Variable          | Purpose                                                                           | Default                       |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| `VITE_WS_URL`     | WebSocket URL of the bot's API server. Use `wss://` over HTTPS.                   | `ws://localhost:8080`         |
| `VITE_WS_TOKEN`   | Shared token sent as `?token=` to authenticate; must match the bot's `API_TOKEN`. | _(empty)_                     |
| `VITE_FIREBASE_*` | Override the Firebase project (API key, auth domain, etc.).                       | built-in `veloci-buy` project |

> **Auth:** the bot rejects WebSocket connections whose `?token=` doesn't match its `API_TOKEN`, and
> refuses to enable LIVE trading from the dashboard when no token is configured. Set `API_TOKEN` on the
> bot and a matching `VITE_WS_TOKEN` here for any non-localhost deployment.

## Accessibility & motion

Animations are decorative and fully disabled when the OS "reduce motion" setting is on (handled
in `src/lib/motion.ts` plus a CSS fallback in `src/index.css`). Modals and the trade drawer can be
dismissed with `Escape`, expose `role="dialog"`, and interactive controls have visible focus rings.
