# Crossrail

Crossrail is a sandbox API for stablecoin cross-border payments. A client creates a wallet keyed by email or phone, deposits simulated stablecoins (`cNGN`, `cGHS`, `cXAF`, `USDx`, `EURx`), swaps between them at live FX rates, and sends money to another wallet with the currency conversion done along the way. Every movement is recorded in a double-entry ledger. The work went into the parts that are hard to get right with money: amounts never pass through a float, a retried request is never processed twice, parallel requests cannot drive a balance negative, and an FX provider outage degrades pricing instead of failing requests. The name means payment rails that cross borders. I picked it for that meaning and don't claim to have coined it.

**Why it is built this way:** see [DESIGN.md](DESIGN.md) for the design decisions and the reasoning behind them.

## Contents

1. [Tech stack](#tech-stack)
2. [Setup and run](#setup-and-run)
3. [Endpoint walkthrough](#endpoint-walkthrough)
4. [Data model](#data-model)
5. [The four hard problems](#the-four-hard-problems)
6. [Error handling](#error-handling)
7. [Assumptions and limitations](#assumptions-and-limitations)
8. [With more time](#with-more-time)

## Tech stack

Node.js 24.9+ (`.nvmrc`), TypeScript (`strict` plus `noUncheckedIndexedAccess`), NestJS 12 with CommonJS output, PostgreSQL 16, TypeORM, `decimal.js`, Jest and Supertest, Yarn 1, ESLint and Prettier. No Redis and no queue: Postgres provides the locking, the idempotency store and rate persistence. The reasoning behind each choice is in [DESIGN.md: Stack decisions](DESIGN.md#stack-decisions).

## Setup and run

Requirements: Docker with Compose v2. For running tests outside Docker you also need Node 24.9 or later and Yarn 1.x.

```sh
docker compose up
```

That one command does the following:
1. Starts `postgres:16-alpine` and waits for its healthcheck.
2. Builds the API image (multi-stage: compile, then a slim runtime).
3. Runs pending migrations in the API container's entrypoint. Migrations create the schema only; there are no seed rows.
4. Serves the API on `http://localhost:3000/api/v1`.

Swagger UI is at `http://localhost:3000/docs` and the raw spec at `/docs-json`. The same document is committed as [`openapi.json`](openapi.json).

If port 5432 is already taken on your machine, change the host port Postgres is published on. The API container is unaffected because it reaches Postgres over the compose network:

```sh
POSTGRES_PORT=5433 docker compose up
```

[`.env.example`](.env.example) documents every variable: database connection, `PORT`, `POSTGRES_PORT`, `FX_PROVIDER_URL` and `FX_TIMEOUT_MS`. Compose supplies working values for all of them, so you only need a `.env` to run the API outside Docker (`yarn start:dev`) or to override a default.

### Tests

```sh
yarn install
docker compose up -d postgres   # e2e specs need a reachable Postgres
yarn test                       # unit, then e2e
```

If you published Postgres on another port, pass the same variable: `POSTGRES_PORT=5433 yarn test`.

- Unit tests need nothing running.
- The e2e global setup creates a dedicated `crossrail_test` database if it doesn't exist and migrates it. Every e2e worker is pinned to that database, so the development database is never touched.
- No e2e test reaches the real FX provider. The provider URL defaults to a blocked loopback port, and suites that need a live or hanging provider start a local stub HTTP server.
- Suites truncate their tables before running. The mutation suites assert the ledger invariant (see [Data model](#data-model)) after every test.

Other scripts:
- `yarn lint`: ESLint and Prettier check.
- `yarn openapi`: regenerates `openapi.json` without needing a database. An e2e test fails if the committed file differs from what the running app serves.
- `yarn migration:run`: runs migrations by hand.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `yarn lint` and `yarn test` on every push against a `postgres:16` service container.

## Endpoint walkthrough

Every response below is real output, recorded against `docker compose up` with the live FX provider reachable. Response headers are trimmed to the status line and `Idempotent-Replay`. To follow along, set `A` and `B` to the ids your own wallet creations return.

```sh
API=http://localhost:3000/api/v1
```

### `GET /health`

Liveness, including a database round trip. Returns 503 with the same body shape when the database is unreachable.

```sh
curl -s $API/health
```
```json
HTTP/1.1 200 OK

{ "status": "ok", "checks": { "database": "up" }, "timestamp": "2026-10-30T16:22:20.735Z" }
```

### `GET /rates`

All 20 ordered pairs. Every pair carries the source and timestamp of the single snapshot it was priced from. Rates are strings at 18 dp.

```sh
curl -s $API/rates
```
```json
HTTP/1.1 200 OK

{
  "rates": [
    { "from": "cNGN", "to": "cGHS", "rate": "0.008659828923559318", "source": "live", "fetched_at": "2026-10-30T16:22:21.638Z" },
    { "from": "cNGN", "to": "cXAF", "rate": "0.436545441374201562", "source": "live", "fetched_at": "2026-10-30T16:22:21.638Z" },
    { "from": "cNGN", "to": "USDx", "rate": "0.000742818529070110", "source": "live", "fetched_at": "2026-10-30T16:22:21.638Z" },
    …
    { "from": "EURx", "to": "USDx", "rate": "1.116153645246190010", "source": "live", "fetched_at": "2026-10-30T16:22:21.638Z" }
  ]
}
```
(16 pairs elided.)

### `POST /wallets`

Takes `email`, `phone` or both. The email is lowercased and spaces and dashes are stripped from the phone before the unique check. Creating a wallet also creates all five balance rows at zero. Wallet creation takes no `Idempotency-Key`, because the unique constraints already make a retry safe: the retry gets a 409.

```sh
curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d '{"email":"Readme-Check@example.com","phone":"+234 801-234-5678"}'
```
```json
HTTP/1.1 201 Created

{
  "id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0",
  "email": "readme-check@example.com",
  "phone": "+2348012345678",
  "created_at": "2026-10-30T16:22:21.726Z"
}
```

A second wallet, `B`, email only:

```sh
curl -s -X POST $API/wallets -H 'content-type: application/json' -d '{"email":"readme-check-2@example.com"}'
```
```json
HTTP/1.1 201 Created

{
  "id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee",
  "email": "readme-check-2@example.com",
  "phone": null,
  "created_at": "2026-10-30T16:22:22.101Z"
}
```

The same phone in another spelling is a duplicate:

```sh
curl -s -X POST $API/wallets -H 'content-type: application/json' -d '{"phone":"+2348012345678"}'
```
```json
HTTP/1.1 409 Conflict

{ "error": { "code": "WALLET_EXISTS", "message": "A wallet with this phone already exists", "details": { "field": "phone" } } }
```

### `POST /wallets/:id/deposits`

Simulated on-ramp. Requires `Idempotency-Key`. Returns the canonical transaction DTO, the shape every endpoint that writes or reads a transaction returns. A deposit has no source wallet, rate 1 and `rate_source: "none"`.

```sh
A=39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0
B=88151bf9-2ced-459a-9a6b-e68f4cc626ee

curl -s -X POST $API/wallets/$A/deposits -H 'content-type: application/json' \
  -H 'Idempotency-Key: readme-check-dep-1' -d '{"currency":"cNGN","amount":"250000"}'
```
```json
HTTP/1.1 201 Created

{
  "id": "a291f0ad-9dd1-4421-92f6-9c4497ae21e3",
  "type": "deposit",
  "status": "completed",
  "source": { "wallet_id": null, "currency": "cNGN", "amount": "250000.00000000" },
  "destination": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "amount": "250000.00000000" },
  "fx_rate": "1.000000000000000000",
  "rate_source": "none",
  "created_at": "2026-10-30T16:22:22.286Z"
}
```

Sending the identical request again replays the stored response and credits nothing. The key order differs from the first response because the stored body went through `jsonb`, so a replay matches the original's content but not its bytes:

```json
HTTP/1.1 201 Created
Idempotent-Replay: true

{
  "id": "a291f0ad-9dd1-4421-92f6-9c4497ae21e3",
  "type": "deposit",
  "source": { "amount": "250000.00000000", "currency": "cNGN", "wallet_id": null },
  "status": "completed",
  "fx_rate": "1.000000000000000000",
  "created_at": "2026-10-30T16:22:22.286Z",
  "destination": { "amount": "250000.00000000", "currency": "cNGN", "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0" },
  "rate_source": "none"
}
```

The same key with a different body (`"amount":"999"`), and then no key at all:

```json
HTTP/1.1 422 Unprocessable Entity

{
  "error": {
    "code": "IDEMPOTENCY_KEY_REUSED",
    "message": "This Idempotency-Key was already used for a different request on this endpoint",
    "details": { "key": "readme-check-dep-1", "endpoint": "POST /wallets/:id/deposits" }
  }
}
```
```json
HTTP/1.1 400 Bad Request

{ "error": { "code": "IDEMPOTENCY_KEY_REQUIRED", "message": "The Idempotency-Key header is required for this endpoint" } }
```

### `POST /wallets/:id/swaps`

Converts between two currencies inside one wallet. The stored `fx_rate` is the cross rate quantized to 18 dp, and the destination is `round_down(150000 × 0.000742818529070110, 8 dp)`.

```sh
curl -s -X POST $API/wallets/$A/swaps -H 'content-type: application/json' \
  -H 'Idempotency-Key: readme-check-swap-1' \
  -d '{"from_currency":"cNGN","to_currency":"USDx","amount":"150000"}'
```
```json
HTTP/1.1 201 Created

{
  "id": "4ba9cc2b-55f2-4575-a818-a50f72199b54",
  "type": "swap",
  "status": "completed",
  "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "amount": "150000.00000000" },
  "destination": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "USDx", "amount": "111.42277936" },
  "fx_rate": "0.000742818529070110",
  "rate_source": "live",
  "created_at": "2026-10-30T16:22:22.351Z"
}
```

More than the balance (`"amount":"500000"`), and an amount that converts to less than 1e-8 (`"amount":"0.00000001"`). Neither failure consumes its key:

```json
HTTP/1.1 422 Unprocessable Entity

{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient cNGN balance in wallet 39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0",
    "details": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "available": "100000.00000000", "requested": "500000.00000000" }
  }
}
```
```json
HTTP/1.1 422 Unprocessable Entity

{
  "error": {
    "code": "AMOUNT_TOO_SMALL",
    "message": "0.00000001 cNGN converts to less than 0.00000001 USDx",
    "details": { "from_currency": "cNGN", "to_currency": "USDx", "amount": "0.00000001", "fx_rate": "0.000742818529070110" }
  }
}
```

### `POST /transfers`

Wallet to wallet. When `destination_currency` differs from `source_currency`, the transfer converts exactly like a swap. When `destination_currency` is omitted, it defaults to the source currency, and the amount moves unchanged at rate 1 with `rate_source: "none"`.

```sh
curl -s -X POST $API/transfers -H 'content-type: application/json' \
  -H 'Idempotency-Key: readme-check-xfer-1' \
  -d "{\"sender_wallet_id\":\"$A\",\"receiver_wallet_id\":\"$B\",\"source_currency\":\"USDx\",\"source_amount\":\"40\",\"destination_currency\":\"EURx\"}"
```
```json
HTTP/1.1 201 Created

{
  "id": "1f5fafdc-5176-4b0d-bd73-b200a1391151",
  "type": "transfer",
  "status": "completed",
  "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "USDx", "amount": "40.00000000" },
  "destination": { "wallet_id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee", "currency": "EURx", "amount": "35.83736000" },
  "fx_rate": "0.895934000000000000",
  "rate_source": "live",
  "created_at": "2026-10-30T16:22:22.392Z"
}
```

```sh
curl -s -X POST $API/transfers -H 'content-type: application/json' \
  -H 'Idempotency-Key: readme-check-xfer-2' \
  -d "{\"sender_wallet_id\":\"$A\",\"receiver_wallet_id\":\"$B\",\"source_currency\":\"cNGN\",\"source_amount\":\"10000\"}"
```
```json
HTTP/1.1 201 Created

{
  "id": "f9e63b92-e47c-4311-82ec-662edd4c5969",
  "type": "transfer",
  "status": "completed",
  "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "amount": "10000.00000000" },
  "destination": { "wallet_id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee", "currency": "cNGN", "amount": "10000.00000000" },
  "fx_rate": "1.000000000000000000",
  "rate_source": "none",
  "created_at": "2026-10-30T16:22:22.407Z"
}
```

### `GET /wallets/:id`

All five balances, plus a USD total valued from one rate snapshot. The response says which source priced the total and when that snapshot was fetched.

```sh
curl -s $API/wallets/$A
```
```json
HTTP/1.1 200 OK

{
  "id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0",
  "email": "readme-check@example.com",
  "phone": "+2348012345678",
  "created_at": "2026-10-30T16:22:21.726Z",
  "balances": { "cNGN": "90000.00000000", "cGHS": "0.00000000", "cXAF": "0.00000000", "USDx": "71.42277936", "EURx": "0.00000000" },
  "total_usd_equivalent": "138.27644697",
  "rate_source": "live",
  "rates_refreshed_at": "2026-10-30T16:22:21.638Z"
}
```

Wallet `B` after receiving both transfers:

```json
HTTP/1.1 200 OK

{
  "id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee",
  "email": "readme-check-2@example.com",
  "phone": null,
  "created_at": "2026-10-30T16:22:22.101Z",
  "balances": { "cNGN": "10000.00000000", "cGHS": "0.00000000", "cXAF": "0.00000000", "USDx": "0.00000000", "EURx": "35.83736000" },
  "total_usd_equivalent": "47.42818529",
  "rate_source": "live",
  "rates_refreshed_at": "2026-10-30T16:22:21.638Z"
}
```

### `GET /wallets/:id/transactions`

History, newest first, as deposits, swaps and transfers in either direction. The optional filters are:
- `type`: `deposit`, `swap` or `transfer`.
- `currency`: matches the source side or the destination side.
- `limit`: default 20, max 100.
- `cursor`: the `next_cursor` from the previous page. `next_cursor` is `null` on the last page.

```sh
curl -s "$API/wallets/$A/transactions?limit=2"
```
```json
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "f9e63b92-e47c-4311-82ec-662edd4c5969",
      "type": "transfer",
      "status": "completed",
      "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "amount": "10000.00000000" },
      "destination": { "wallet_id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee", "currency": "cNGN", "amount": "10000.00000000" },
      "fx_rate": "1.000000000000000000",
      "rate_source": "none",
      "created_at": "2026-10-30T16:22:22.407Z"
    },
    {
      "id": "1f5fafdc-5176-4b0d-bd73-b200a1391151",
      "type": "transfer",
      "status": "completed",
      "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "USDx", "amount": "40.00000000" },
      "destination": { "wallet_id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee", "currency": "EURx", "amount": "35.83736000" },
      "fx_rate": "0.895934000000000000",
      "rate_source": "live",
      "created_at": "2026-10-30T16:22:22.392Z"
    }
  ],
  "next_cursor": "MjAyNi0xMC0zMFQxNjoyMjoyMi4zOTI2NjNaXzFmNWZhZmRjLTUxNzYtNGIwZC1iZDczLWIyMDBhMTM5MTE1MQ"
}
```

```sh
curl -s "$API/wallets/$A/transactions?limit=2&cursor=MjAyNi0xMC0zMFQxNjoyMjoyMi4zOTI2NjNaXzFmNWZhZmRjLTUxNzYtNGIwZC1iZDczLWIyMDBhMTM5MTE1MQ"
```
```json
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "4ba9cc2b-55f2-4575-a818-a50f72199b54",
      "type": "swap",
      "status": "completed",
      "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "amount": "150000.00000000" },
      "destination": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "USDx", "amount": "111.42277936" },
      "fx_rate": "0.000742818529070110",
      "rate_source": "live",
      "created_at": "2026-10-30T16:22:22.351Z"
    },
    {
      "id": "a291f0ad-9dd1-4421-92f6-9c4497ae21e3",
      "type": "deposit",
      "status": "completed",
      "source": { "wallet_id": null, "currency": "cNGN", "amount": "250000.00000000" },
      "destination": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "cNGN", "amount": "250000.00000000" },
      "fx_rate": "1.000000000000000000",
      "rate_source": "none",
      "created_at": "2026-10-30T16:22:22.286Z"
    }
  ],
  "next_cursor": null
}
```

Filtered. The `EURx` filter matches this transfer by its destination side:

```sh
curl -s "$API/wallets/$A/transactions?type=transfer&currency=EURx"
```
```json
HTTP/1.1 200 OK

{
  "items": [
    {
      "id": "1f5fafdc-5176-4b0d-bd73-b200a1391151",
      "type": "transfer",
      "status": "completed",
      "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "USDx", "amount": "40.00000000" },
      "destination": { "wallet_id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee", "currency": "EURx", "amount": "35.83736000" },
      "fx_rate": "0.895934000000000000",
      "rate_source": "live",
      "created_at": "2026-10-30T16:22:22.392Z"
    }
  ],
  "next_cursor": null
}
```

### `GET /transactions/:id`

```sh
curl -s $API/transactions/1f5fafdc-5176-4b0d-bd73-b200a1391151
```
```json
HTTP/1.1 200 OK

{
  "id": "1f5fafdc-5176-4b0d-bd73-b200a1391151",
  "type": "transfer",
  "status": "completed",
  "source": { "wallet_id": "39aa62e6-b7e3-43e6-94ac-2b9a7f6582e0", "currency": "USDx", "amount": "40.00000000" },
  "destination": { "wallet_id": "88151bf9-2ced-459a-9a6b-e68f4cc626ee", "currency": "EURx", "amount": "35.83736000" },
  "fx_rate": "0.895934000000000000",
  "rate_source": "live",
  "created_at": "2026-10-30T16:22:22.392Z"
}
```

```sh
curl -s $API/transactions/00000000-0000-4000-8000-000000000000
```
```json
HTTP/1.1 404 Not Found

{
  "error": {
    "code": "TRANSACTION_NOT_FOUND",
    "message": "Transaction 00000000-0000-4000-8000-000000000000 not found",
    "details": { "id": "00000000-0000-4000-8000-000000000000" }
  }
}
```

## Data model

Six tables, all created by migrations in [`src/database/migrations`](src/database/migrations): `wallets`, `balances`, `transactions`, `ledger_entries`, `idempotency_keys` and `fx_rates`. The ledger is the audit trail, and `balances` is its lockable projection: one row per (wallet, currency), created at 0 for all five currencies when the wallet is. Each balance update commits with the ledger entries that justify it, so this invariant always holds, and the e2e suites that move money check it after every test:

```
SUM(ledger_entries.amount) GROUP BY (wallet_id, currency)  =  balances.amount
```

Full schema, constraints and the reasoning behind them: [DESIGN.md: Data model](DESIGN.md#data-model).

## The four hard problems

Each is covered in depth in DESIGN.md; in brief:

- **[Money precision](DESIGN.md#money-precision).** Amounts are decimal strings in JSON, `numeric(38,8)` in Postgres and `decimal.js` in code, never a float. They round **down** to 8 dp in one utility ([`src/common/money.ts`](src/common/money.ts)). The destination amount is derived from the stored 18 dp rate, so the recorded rate and the recorded amounts always agree. A conversion that rounds to zero is a 422 `AMOUNT_TOO_SMALL`.
- **[Idempotency](DESIGN.md#idempotency).** Deposits, swaps and transfers require an `Idempotency-Key` header (up to 255 characters). The key row is inserted at the start of the operation's own transaction and its response written at the end, so a key becomes visible only together with its effects. A failure rolls the key back with everything else: a request succeeds at most once, and a failed attempt leaves the key usable. Replays return the stored response with `Idempotent-Replay: true`.
- **[Concurrency](DESIGN.md#concurrency).** Every mutation is one Postgres transaction that locks its balance rows with `SELECT ... FOR UPDATE` in sorted `(wallet_id, currency)` order, then checks funds before writing. Crossing transfers can't deadlock, and ten parallel swaps against a balance that covers six yield exactly six successes.
- **[FX failure](DESIGN.md#fx-rates-and-failure-handling).** Rates come from `open.er-api.com` with a 3 s timeout and fall back live → cached (`fx_rates`) → the in-code `FALLBACK_RATES`. Live snapshots are held for 60 s and degraded ones for 10 s. A provider outage never surfaces as a 5xx, and every transaction records the `rate_source` it was priced from.

## Error handling

Every error, including unknown routes, malformed JSON and unhandled exceptions, uses one envelope:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Insufficient cNGN balance in wallet …", "details": { … } } }
```

| Status | Codes |
| --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` (the only 400 in the API) |
| 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` (unknown route) |
| 409 | `WALLET_EXISTS` |
| 422 | `VALIDATION_ERROR`, `UNSUPPORTED_CURRENCY`, `SAME_CURRENCY_SWAP`, `SELF_TRANSFER`, `INSUFFICIENT_FUNDS`, `AMOUNT_TOO_SMALL`, `IDEMPOTENCY_KEY_REUSED` |
| 500 | `INTERNAL_ERROR`, for unhandled exceptions only, with no internals in the body |

`VALIDATION_ERROR` details are a list of `{ field, messages }`. Oversized and malformed JSON bodies are also 422 `VALIDATION_ERROR`, not a bare 413 or 400.

When a request fails more than one check, a missing `Idempotency-Key` wins, then request validity beats resource existence (an unsupported currency on an unknown wallet is 422, not 404), and a replay of a committed request beats checks that depend on current state. Each code always carries the same `details` shape, whichever endpoint returns it. The reasoning is in [DESIGN.md: Error design](DESIGN.md#error-design).

## Assumptions and limitations

Deliberate cuts, each explained in [DESIGN.md: Out of scope](DESIGN.md#out-of-scope):

- No authentication or KYC, so idempotency keys are global rather than per client.
- Mid-rate pricing with no fees or spread.
- Nothing is async: no webhooks, Redis or queues.
- A single Postgres is the source of truth.
- Phone normalization only strips spaces and dashes: `+2348012345678` and `2348012345678` are two wallets.
- Destination overflow past `numeric(38,8)` isn't rejected in code; no realistic rate comes close.
- History cursors aren't bound to the wallet or filters that produced them.
- No rate limiting, soft deletes or admin endpoints.

## With more time

See [DESIGN.md: With more time](DESIGN.md#with-more-time).

## License

[MIT](LICENSE)
