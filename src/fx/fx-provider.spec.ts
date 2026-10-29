import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_FX_PROVIDER_URL,
  DEFAULT_FX_TIMEOUT_MS,
  FxProvider,
  parseProviderBody,
} from './fx-provider';

const config = (env: Record<string, string>): ConfigService =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

/** Shaped like open.er-api.com, including codes we do not price. */
const ER_API_BODY =
  '{"result":"success","base_code":"USD","rates":' +
  '{"USD":1,"EUR":0.86,"NGN":1480.123456789012345678,"GHS":11.2,"XAF":564.12,"JPY":150.5}}';

describe('parseProviderBody', () => {
  it('keeps every rate exactly as written, digits beyond float precision included', () => {
    expect(parseProviderBody(ER_API_BODY)).toEqual({
      USD: '1.000000000000000000',
      EUR: '0.860000000000000000',
      NGN: '1480.123456789012345678', // a JS number would give 1480.1234567890124
      GHS: '11.200000000000000000',
      XAF: '564.120000000000000000',
    });
  });

  it('accepts exponent literals and quantizes them to 18 dp', () => {
    const table = parseProviderBody(
      '{"rates":{"USD":1,"EUR":8.6e-1,"NGN":1.48E3,"GHS":11.2,"XAF":564.12}}',
    );
    expect(table.EUR).toBe('0.860000000000000000');
    expect(table.NGN).toBe('1480.000000000000000000');
  });

  it.each([
    ['a missing fiat code', '{"rates":{"USD":1,"EUR":0.86,"NGN":1480,"GHS":11.2}}'],
    ['a zero rate', '{"rates":{"USD":1,"EUR":0,"NGN":1480,"GHS":11.2,"XAF":564.12}}'],
    ['a negative rate', '{"rates":{"USD":1,"EUR":-0.86,"NGN":1480,"GHS":11.2,"XAF":564.12}}'],
    ['a rate below 18 dp', '{"rates":{"USD":1,"EUR":1e-19,"NGN":1480,"GHS":11.2,"XAF":564.12}}'],
    ['a rate too big for numeric(38,18)', '{"rates":{"USD":1,"EUR":1e21,"NGN":1,"GHS":1,"XAF":1}}'],
    ['a non-numeric rate', '{"rates":{"USD":1,"EUR":"abc","NGN":1480,"GHS":11.2,"XAF":564.12}}'],
    ['a hex string rate', '{"rates":{"USD":1,"EUR":0.86,"NGN":"0x5C8","GHS":11.2,"XAF":564.12}}'],
    ['a binary string rate', '{"rates":{"USD":1,"EUR":0.86,"NGN":1480,"GHS":"0b101","XAF":1}}'],
    ['a huge exponent', '{"rates":{"USD":1,"EUR":0.86,"NGN":1e999999999,"GHS":11.2,"XAF":1}}'],
    [
      'entries that fit alone but imply a cross rate past numeric(38,18)',
      '{"rates":{"USD":1,"EUR":0.000000000000000001,"NGN":99999999999999999999,"GHS":1,"XAF":1}}',
    ],
    [
      'entries whose smallest cross rate rounds to zero at 18 dp',
      // NGN/EUR = 1e19 fits; EUR/NGN = 1e-19 does not survive 18 dp.
      '{"rates":{"USD":1,"EUR":0.000000001,"NGN":10000000000,"GHS":1,"XAF":1}}',
    ],
    ['a null rate', '{"rates":{"USD":1,"EUR":null,"NGN":1480,"GHS":11.2,"XAF":564.12}}'],
    ['a non-USD base', '{"rates":{"USD":1.16,"EUR":1,"NGN":1716,"GHS":13,"XAF":655.957}}'],
    ['no rates object', '{"result":"error","error-type":"unsupported-code"}'],
    ['rates as an array', '{"rates":[1,2,3]}'],
    ['a non-object body', '[]'],
    ['malformed JSON', '{"rates":'],
  ])('rejects %s', (_label, body) => {
    expect(() => parseProviderBody(body)).toThrow();
  });
});

describe('FxProvider', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to the spec provider URL and a 3s timeout', () => {
    const provider = new FxProvider(config({}));
    expect(provider.url).toBe(DEFAULT_FX_PROVIDER_URL);
    expect(DEFAULT_FX_PROVIDER_URL).toBe('https://open.er-api.com/v6/latest/USD');
    expect(provider.timeoutMs).toBe(DEFAULT_FX_TIMEOUT_MS);
    expect(DEFAULT_FX_TIMEOUT_MS).toBe(3000);
  });

  it('reads FX_PROVIDER_URL and FX_TIMEOUT_MS from config', () => {
    const provider = new FxProvider(
      config({ FX_PROVIDER_URL: 'http://rates.test/usd', FX_TIMEOUT_MS: '250' }),
    );
    expect(provider.url).toBe('http://rates.test/usd');
    expect(provider.timeoutMs).toBe(250);
  });

  it.each(['abc', '0', '-1', '1.5', '3s'])('refuses FX_TIMEOUT_MS=%s at startup', (value) => {
    expect(() => new FxProvider(config({ FX_TIMEOUT_MS: value }))).toThrow(/FX_TIMEOUT_MS/);
  });

  it('fetches the configured URL with a timeout signal and parses the table', async () => {
    fetchMock.mockResolvedValue(new Response(ER_API_BODY));
    const provider = new FxProvider(config({ FX_PROVIDER_URL: 'http://rates.test/usd' }));

    const table = await provider.fetchTable();

    expect(table.NGN).toBe('1480.123456789012345678');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://rates.test/usd');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-2xx response, cancelling the unread body', async () => {
    const res = new Response(ER_API_BODY, { status: 503 });
    fetchMock.mockResolvedValue(res);
    await expect(new FxProvider(config({})).fetchTable()).rejects.toThrow(/503/);
    expect(res.bodyUsed).toBe(true);
  });
});
