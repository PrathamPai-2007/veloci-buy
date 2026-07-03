/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the bot's API server (src/services/api.service.ts). */
  readonly VITE_WS_URL?: string;
  /** Shared token sent as ?token= to authenticate against the bot's API_TOKEN. */
  readonly VITE_WS_TOKEN?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
