import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { parseUsdRateTable, UsdRateTable } from './fiat';

export const DEFAULT_FX_PROVIDER_URL = 'https://open.er-api.com/v6/latest/USD';
export const DEFAULT_FX_TIMEOUT_MS = 3000;

/**
 * The live tier: one HTTP call to a free, keyless, USD-based JSON rates API
 * (`{ "rates": { "NGN": 1480.5, ... } }`). Swapping providers means editing
 * this file only; everything downstream consumes a `UsdRateTable`.
 *
 * URL and timeout come from `FX_PROVIDER_URL` / `FX_TIMEOUT_MS` so tests can
 * point it somewhere that fails. The timeout covers the whole exchange,
 * connect through body.
 */
@Injectable()
export class FxProvider {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.url = config.get<string>('FX_PROVIDER_URL') || DEFAULT_FX_PROVIDER_URL;
    this.timeoutMs = parseTimeoutMs(config.get<string>('FX_TIMEOUT_MS'));
  }

  /** Throws on timeout, network error, non-2xx, or a body that is not a full USD table. */
  async fetchTable(): Promise<UsdRateTable> {
    const res = await fetch(this.url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      // Release the pooled connection now rather than at garbage collection.
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`FX provider responded ${res.status}`);
    }
    return parseProviderBody(await res.text());
  }
}

/**
 * Parses the provider body without letting any rate pass through a JS
 * number: the reviver swaps every numeric literal for its exact source text.
 * A table missing any of the five fiat codes, or not based on USD, is
 * rejected as a whole.
 */
export function parseProviderBody(text: string): UsdRateTable {
  const body: unknown = JSON.parse(text, keepNumberSource);
  if (!isRecord(body) || !isRecord(body.rates)) {
    throw new TypeError('FX provider response has no rates object');
  }
  const table = parseUsdRateTable(body.rates);
  if (!new Decimal(table.USD).equals(1)) {
    throw new TypeError(`FX provider table is not USD-based (USD = ${table.USD})`);
  }
  return table;
}

/**
 * `JSON.parse` reviver using the source-text-access context (Node 21+). If the
 * context is ever missing, the number is left as a number and the table
 * parser rejects it rather than trusting a float.
 */
function keepNumberSource(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' && context?.source !== undefined ? context.source : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_FX_TIMEOUT_MS;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`FX_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parseInt(raw, 10);
}
