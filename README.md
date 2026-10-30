# Crossrail

Crossrail is a sandbox API for stablecoin cross-border payments. A client creates a wallet keyed by email or phone, deposits simulated stablecoins (`cNGN`, `cGHS`, `cXAF`, `USDx`, `EURx`), swaps between them at live FX rates, and sends money to another wallet with the currency conversion done along the way. Every movement is recorded in a double-entry ledger. The work went into the parts that are hard to get right with money: amounts never pass through a float, a retried request is never processed twice, parallel requests cannot drive a balance negative, and an FX provider outage degrades pricing instead of failing requests. The name means payment rails that cross borders. I picked it for that meaning and don't claim to have coined it.

## Contents

1. [Tech stack and why](#tech-stack-and-why)
2. [Setup and run](#setup-and-run)
3. [Endpoint walkthrough](#endpoint-walkthrough)
4. [Data model](#data-model)
5. [The four hard problems](#the-four-hard-problems)
6. [Error handling](#error-handling)
7. [Assumptions and limitations](#assumptions-and-limitations)
8. [With more time](#with-more-time)

## Tech stack and why

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 24, 24.9 or later (`.nvmrc`) | Nest 12 ships ESM-only and runs a CommonJS app through `require(esm)`. Jest supports `require(esm)` only from Node 24.9, so that's the floor |
| Language | TypeScript, `strict` plus `noUncheckedIndexedAccess` | Type errors surface at compile time, and an indexed lookup can't silently produce `undefined` |
| Framework | NestJS 12, CommonJS output | Dependency injection and feature modules keep the code reviewable. `class-validator` pipes validate requests, and `@nestjs/swagger` generates the OpenAPI spec from decorators. The brief requires ESLint, and Nest's CommonJS template is the one that works with both Jest and ESLint |
| Database | PostgreSQL 16 | See below |
| ORM | TypeORM via `@nestjs/typeorm` | Native Nest integration, hand-written migrations and `pessimistic_write` locks. Decimal columns map to strings, never to JS numbers |
| Money math | `decimal.js` | Arbitrary-precision decimal arithmetic. JS `number` is never used for an amount |
| Tests | Jest and Supertest | E2e specs run against the real Nest app and a real Postgres |
| Tooling | Yarn 1, ESLint, Prettier | Required by the brief |
| Cache or queue | None | See below |

**Why Postgres.** Every invariant this API must keep can be stated to the database and checked by it. ACID transactions make a swap's debit and credit land together or not at all. `SELECT ... FOR UPDATE` row locks serialize concurrent writers on the same balance. `NUMERIC(38,8)` stores amounts exactly. `CHECK (amount >= 0)`, the one-wallet-per-email and one-wallet-per-phone unique constraints, and the idempotency key's primary key are enforced by the database itself. With a document store, each of these would become application code that has to be correct under concurrency on its own.

**Why no Redis and no queue.** Every operation in scope completes synchronously within one request. Postgres already provides what Redis would usually be added for:
- Locking: `FOR UPDATE` row locks.
- Idempotency storage: the key row commits in the same transaction as the money movement. That is a stronger guarantee than a Redis key, which can never commit atomically with a Postgres write.
- Rate persistence: the `fx_rates` table.

Async settlement would be the point to add a transactional outbox plus a queue (see [With more time](#with-more-time)).

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

Six tables, all created by migrations in [`src/database/migrations`](src/database/migrations).

| Table | Role | Key constraints |
| --- | --- | --- |
| `wallets` | One per email or phone | Unique `email` and unique `phone`. `CHECK (email IS NOT NULL OR phone IS NOT NULL)` |
| `balances` | One row per (wallet, currency), created eagerly at 0 for all five currencies. These are the rows that get locked | PK `(wallet_id, currency)`, FK to `wallets`, `amount numeric(38,8) CHECK (amount >= 0)`, currency in the supported set |
| `transactions` | One row per business operation: deposit, swap or transfer | `source_amount > 0` and `destination_amount > 0`. Party shape: deposits and swaps set only `wallet_id`, transfers set only `sender_wallet_id` and `receiver_wallet_id`, and the sender differs from the receiver. `fx_rate numeric(38,18)`. Records `rate_source` (`live`, `cached`, `fallback` or `none`) |
| `ledger_entries` | Signed movements: negative is a debit, positive is a credit | FK to `transactions`, `amount numeric(38,8)` |
| `idempotency_keys` | One row per successful keyed mutation, holding its stored response | PK `(key, endpoint)`, `request_hash`, `response_status`, `response_body jsonb` |
| `fx_rates` | Persisted copy of the last live USD-based table | PK `(base_currency, quote_currency)`. Only live fetches are written here |

**The ledger is the audit trail, and `balances` is its lockable projection.** A deposit writes one credit. A swap writes a debit and a credit on the same wallet. A transfer writes a debit on the sender and a credit on the receiver. Each balance update happens in the same database transaction as the ledger entries that justify it, so this invariant always holds:

```
SUM(ledger_entries.amount) GROUP BY (wallet_id, currency)  =  balances.amount
```

The e2e suites that move money (deposits, swaps, transfers, history) check it after every test. The check uses a `FULL JOIN`, so it also catches a ledger sum with no balance row and a non-zero balance with no ledger rows.

**There are deliberately no foreign keys from `transactions` or `ledger_entries` to `wallets`.** Wallet existence is already enforced at write time: every operation locks the wallet's balance rows, which do reference `wallets`, and a missing row is a 404 before anything is written. The ledger records history and doesn't depend on the wallets table. Balances are what reference wallets.

## The four hard problems

### Money precision

- Amounts are strings end to end: decimal strings in JSON, `numeric(38,8)` in Postgres, `decimal.js` in code. There is no `parseFloat`, no `Number()` and no float arithmetic on amounts. Even the FX provider's JSON is parsed with a reviver that keeps each rate's source text, so no rate ever passes through a float.
- Request amounts must match `^[0-9]{1,20}(\.[0-9]{1,8})?$` and be greater than zero. A ninth decimal place is a 422, not a silent rounding.
- `decimal.js` runs at precision 80, because its default of 20 significant digits can't multiply a 20-digit amount by an 18 dp rate exactly.
- Amounts are rounded **down** to 8 dp, in one utility ([`src/common/money.ts`](src/common/money.ts)) and nowhere else.
- Rates are quantized **half-up** to 18 dp. That is what Postgres does when it casts to `numeric(38,18)`, so a rate quantized in code is stored unchanged.
- The destination amount is derived from the **stored rate string**: `round_down(source × fx_rate, 8 dp)`. It is never computed from the unrounded cross rate, so the recorded rate and the recorded amounts always agree. A unit test pins the case where the two methods differ: converting 100,000,000,000 cNGN to USDx gives `67567567.56756760` from the stored rate but `67567567.56756756` from direct division.
- A conversion that rounds to zero is a 422 `AMOUNT_TOO_SMALL`, raised before any balance or ledger write.

### Idempotency

Deposits, swaps and transfers require an `Idempotency-Key` header of up to 255 characters.

- **Single transaction.** The first statement of the operation's transaction is `INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING`. The operation then runs in the same transaction, and its response is written onto the key row before commit. A key therefore only ever becomes visible together with its effects. There is no in-progress state, and a key can never be left stuck by a crash.
- **At-most-once success.** A failed attempt (insufficient funds, unknown wallet, a crash) rolls back everything, including the key row, so the key isn't consumed and a later retry with the same key can still succeed. What is guaranteed is that a request succeeds at most once, not that every attempt is recorded.
- **Concurrent duplicates.** A second request with the same key blocks on the unique index until the first transaction ends. It then either sees the committed row and replays it, or, if the first rolled back, inserts its own row and proceeds. Tested for deposits, swaps and transfers.
- **What the hash covers.** The hash is computed over the *validated* request: the whitelisted DTO (unknown properties stripped), lowercased wallet ids, path params, and for transfers the defaulted `destination_currency`. Two spellings of the same request therefore replay. Amounts are hashed as sent, so `"10.5"` and `"10.50"` are different requests. The same key with a different request is 422 `IDEMPOTENCY_KEY_REUSED`.
- **Replays match in content, not bytes.** The stored response lives in `jsonb`, which normalizes key order (visible in the walkthrough above). A replay carries `Idempotent-Replay: true` and the original status code.
- **Replays still take a rate snapshot.** Swaps and cross-currency transfers take their snapshot *before* the transaction opens, so no network I/O happens while balance rows are locked. That also means a replay goes through the FX chain before it reaches the key lookup. The cost is bounded: snapshots are memoized (60 s when live, 10 s when degraded) and concurrent callers share one in-flight resolution, so an outage costs at most one provider timeout per 10 s. The known optimization is to peek at the key row before pricing. See [With more time](#with-more-time).
- **Keys are global.** With no auth, two unrelated clients that pick the same key on the same endpoint collide. Listed under [limitations](#assumptions-and-limitations).

### Concurrency

- Each mutation is **one Postgres transaction** under the default READ COMMITTED isolation.
- Balance rows are locked with `SELECT ... FOR UPDATE` **before** they're read, always in globally sorted `(wallet_id, currency)` order. Two transfers that cross (A→B and B→A at once) take their locks in the same order and so can't deadlock. An e2e test forces the overlap by waiting until Postgres reports a backend blocked on the lock. A second test runs ten interleaved crossing transfers and checks that money is conserved.
- The code verifies funds after locking and before writing. Insufficient funds rolls back the whole transaction with a 422, and nothing partial persists.
- `CHECK (amount >= 0)` on `balances` is a last-resort backstop. Correct code never trips it.
- **Tested:** ten parallel 150 cNGN swaps against a balance of 1000 cNGN. Exactly `floor(1000 / 150) = 6` succeed and 4 return 422 `INSUFFICIENT_FUNDS`. The balance ends at exactly 100, nothing goes negative, and the ledger invariant holds.

### FX failure

- **Live provider:** `open.er-api.com/v6/latest/USD`, which is free and needs no key. Each stablecoin is priced 1:1 against its fiat currency, and any cross rate comes from the one USD table: `rate(A→B) = usd[fiat(B)] / usd[fiat(A)]`. Swapping in another provider means changing one file.
- **Fallback chain:** live → cached (the `fx_rates` table) → `FALLBACK_RATES`, a constant in code holding approximate late-2026 rates.
  - Every successful live fetch writes the whole table to `fx_rates` in one transaction.
  - The fallback constant is never stored in `fx_rates`, so no write can corrupt the last tier.
- **Timeouts:** the provider call has a 3 s timeout covering the whole exchange, from connect to body. The cached tier's database read has a 1 s timeout, so a database that isn't responding can't block a fallback that needs no database.
- **TTLs:** a live snapshot is memoized for 60 s. A cached or fallback snapshot is memoized for only 10 s, so a recovered provider is back in use within seconds, while an outage costs one timeout per 10 s rather than one per request.
- **Result:** endpoints that need rates (`/rates`, wallet totals, swaps, cross-currency transfers) never return 5xx because the provider is down. Rates are consumed as one snapshot, so every pair and every transaction carries exactly one source, and each transaction records its `rate_source` permanently. E2e tests cover a provider that hangs (to exercise the timeout), an empty or incomplete `fx_rates` table, and a provider that serves live rates, then goes down, after which the cached rows are served.

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

**Precedence rules**, applied in this order:

1. **A missing `Idempotency-Key` is checked first.** It is a 400 even when the body is also invalid.
2. **Request validity beats resource existence.** A request that is invalid on its face fails the same way regardless of database state. For example, an unsupported currency on an unknown wallet is 422, not 404:
   ```sh
   curl -s -X POST $API/wallets/00000000-0000-4000-8000-000000000000/deposits \
     -H 'content-type: application/json' -H 'Idempotency-Key: k1' -d '{"currency":"BTC","amount":"1"}'
   ```
   ```json
   HTTP/1.1 422 Unprocessable Entity

   { "error": { "code": "UNSUPPORTED_CURRENCY", "message": "Unsupported currency \"BTC\"", "details": { "field": "currency", "value": "BTC" } } }
   ```
   Among request checks, currency support comes before the business rules on currencies and parties (`SAME_CURRENCY_SWAP`, `SELF_TRANSFER`).
3. **A replay beats checks that depend on current state.** A committed request replays its stored response even if it would fail today. The `AMOUNT_TOO_SMALL` check runs inside the transaction, after the key insert, so a swap that committed when it converted to a non-zero amount still replays after rates move enough to round it to zero.

**Error details are keyed by code, not by endpoint.** Each code always carries the same `details` shape, so a client can switch on `error.code` alone. For example, `AMOUNT_TOO_SMALL` always carries `{ from_currency, to_currency, amount, fx_rate }` describing the conversion, on swaps and transfers alike.

## Assumptions and limitations

These are deliberate cuts, not oversights:

- **No authentication or KYC.** Anyone who knows a wallet id can move its money. The brief requires only unique email or phone.
- **Mid-rate pricing with no fees or spread.** Every conversion uses the mid rate.
- **Nothing is async.** There are no webhooks, no Redis and no queues. Every operation settles within its request.
- **A single Postgres is the source of truth.** Idempotency and locking both assume one database. Multi-region and multi-primary setups are out of scope.
- **Phone normalization only strips spaces and dashes.** `+2348012345678` and `2348012345678` are two different wallets. A real system would parse to E.164.
- **Destination overflow isn't enforced in code.** A request amount has at most 20 integer digits, and `numeric(38,8)` holds 30, so a conversion overflows only at a rate above about 10^10. No realistic rate between these five currencies comes close, but nothing in code rejects it. Postgres would refuse the write and the request would fail as a 500.
- **Idempotency keys are global.** With no client identity, a key is scoped only by endpoint, so two clients that choose the same key collide: the second gets `IDEMPOTENCY_KEY_REUSED` or, if its request is identical, the first client's response. With auth, keys would be scoped per client.
- **History cursors aren't bound to their query.** A `next_cursor` encodes a bare `(created_at, id)` position. Reusing it on another wallet or with different filters returns 200 from that position, not 422. Binding the scope into the cursor was tried and reverted because it cost more than it was worth here.
- **No rate limiting, soft deletes or admin endpoints.**

## With more time

- API-key authentication, with idempotency keys scoped per client.
- A fee engine: spreads and per-corridor fees, recorded as their own ledger entries.
- A transactional outbox plus a queue to simulate asynchronous settlement (`pending` → `completed`; the `status` column is already there).
- A second FX provider before the cached tier.
- A scheduled reconciliation job asserting the ledger invariant in production, not just in tests.
- A replay fast path that peeks at the key row before pricing, so a replay never touches the FX chain.
- Property-based tests for the money math, such as round-trip and monotonicity properties of `convert`.
- Rate limiting.

## License

[MIT](LICENSE)
