import { loadDotEnv } from './config-internals/env-loaders.js';

loadDotEnv();

export { ConfigBuilder, loadConfig } from './config-internals/builder.js';
export { validateStartupConfig } from './config-internals/validators.js';
export { NumberParser, numberParser } from './config-internals/env-loaders.js';
export * from './constants.js';
export * from './strategy-loader.js';
