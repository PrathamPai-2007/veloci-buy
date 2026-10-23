'use strict';

/**
 * Fault injection helpers for testing resilience against network failures, RPC dropouts, and rate limits.
 */

export function createNetworkFailureFetch(status = 503, statusText = 'Service Unavailable') {
  return async (_input: any, _init?: any): Promise<Response> => {
    return new Response(JSON.stringify({ error: statusText }), {
      status,
      statusText,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

export function createTimeoutFetch(delayMs = 5000) {
  return async (_input: any, _init?: any): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw new Error('Network request timed out');
  };
}

export function createFlakyFetch(failCount = 1, successResponse = { status: 'ok' }) {
  let attempts = 0;
  return async (_input: any, _init?: any): Promise<Response> => {
    attempts += 1;
    if (attempts <= failCount) {
      return new Response(JSON.stringify({ error: 'Temporary failure' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(successResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
