# Crossrail: Design

This document records the design decisions behind Crossrail, a stablecoin cross-border payment sandbox API, and the reasoning behind them. The [README](./README.md) covers what the system does, setup, and endpoint usage; this file explains why it is built the way it is.

## Design priorities

1. Correct money handling: no floats, no precision loss
2. Idempotency: the same request is never successfully processed twice
3. Concurrency safety: no negative balances under parallel load
4. FX failure handling: live rates with a working fallback
5. Reproducibility: `yarn test` passes and `docker compose up` works from a fresh clone
6. Focus: a small API with correct money handling is better than a large one with gaps. Anything left out is listed under [Out of scope](#out-of-scope) as a deliberate limitation.

## Stack decisions

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 24 LTS (24.9+) | Nest 12 ships ESM-only packages and runs CommonJS apps via `require(esm)`; Jest supports `require(esm)` only from Node 24.9, so that is the real floor for `yarn test`, declared in `engines` and `.nvmrc` |
| Language | TypeScript, `strict: true` | Also `noUncheckedIndexedAccess`; compiled output stays CommonJS, the Jest/ESLint-compatible path on Nest 12 (its ESM template switches to Vitest/oxlint, and ESLint is a project requirement) |
| Framework | NestJS | DI and feature modules keep the code organized; `class-validator` pipes handle request validation; `@nestjs/swagger` generates the OpenAPI spec from the same decorators that document the controllers; first-class Jest/Supertest support |
| Database | PostgreSQL 16 | ACID transactions plus `SELECT ... FOR UPDATE` row locks make atomic balance updates straightforward; `NUMERIC` stores exact decimals; `CHECK` and unique constraints enforce invariants in the schema itself. A document store would push transactions and these invariants into application code |
| ORM | TypeORM via `@nestjs/typeorm` | Native Nest integration, migration tooling, `pessimistic_write` lock mode; every numeric column carries a transformer that refuses JS numbers in both directions, and a metadata-driven test fails if any entity forgets it |
| Money math | `decimal.js` at precision 80 | Arbitrary-precision arithmetic; the default 20 significant digits could not multiply a 38-digit amount by an 18 dp rate exactly |
| Tests | Jest + Supertest | Nest defaults for CJS projects |
| Tooling | Yarn, ESLint, Prettier | Project requirements |
| Cache / queue | None | Nothing in scope is asynchronous. Postgres provides the locking (`FOR UPDATE`), the idempotency store (committed in the same transaction as its effects, which a Redis key cannot be), and rate persistence. Redis or BullMQ would add a second consistency model without a matching benefit |

## Data model

Six tables. Signed double-entry ledger rows are the audit trail; `balances` is the lockable, fast-read projection of them.

```sql
-- wallets: one per email or phone
wallets (
  id uuid PK DEFAULT gen_random_uuid(),
  email text NULL UNIQUE,            -- stored lowercased
  phone text NULL UNIQUE,            -- stored normalized (strip spaces/dashes)
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
)

-- balances: one row per (wallet, currency); the row that gets locked
balances (
  wallet_id uuid FK -> wallets,
  currency text CHECK (currency IN ('cNGN','cGHS','cXAF','USDx','EURx')),
  amount numeric(38,8) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (wallet_id, currency)
)

-- transactions: one row per business operation
transactions (
  id uuid PK,
  type text CHECK (type IN ('deposit','swap','transfer')),
  status text NOT NULL DEFAULT 'completed',   -- everything is synchronous; kept for extensibility
  wallet_id uuid NULL,               -- owner for deposit/swap
  sender_wallet_id uuid NULL,        -- transfer only
  receiver_wallet_id uuid NULL,      -- transfer only
  source_currency text NOT NULL,
  source_amount numeric(38,8) NOT NULL CHECK (source_amount > 0),
  destination_currency text NOT NULL,
  destination_amount numeric(38,8) NOT NULL CHECK (destination_amount > 0),
  fx_rate numeric(38,18) NOT NULL,   -- '1' for same-currency operations
  rate_source text NOT NULL,         -- 'live' | 'cached' | 'fallback' | 'none'
  created_at timestamptz NOT NULL DEFAULT now(),
  -- party shape: transfers set only sender/receiver, deposits and swaps only wallet_id
  CHECK (CASE type WHEN 'transfer'
           THEN wallet_id IS NULL AND sender_wallet_id IS NOT NULL AND receiver_wallet_id IS NOT NULL
           ELSE wallet_id IS NOT NULL AND sender_wallet_id IS NULL AND receiver_wallet_id IS NULL END),
  CHECK (sender_wallet_id <> receiver_wallet_id)
)
-- indexes: (wallet_id, created_at DESC), (sender_wallet_id, created_at DESC),
--          (receiver_wallet_id, created_at DESC)

-- ledger_entries: signed rows; negative = debit, positive = credit
ledger_entries (
  id uuid PK,
  transaction_id uuid FK -> transactions,
  wallet_id uuid NOT NULL,
  currency text NOT NULL,
  amount numeric(38,8) NOT NULL,
  created_at timestamptz NOT NULL
)

-- idempotency_keys: one row per successful keyed mutation (a failed attempt rolls its row back)
idempotency_keys (
  key text,
  endpoint text,                     -- e.g. 'POST /wallets/:id/swaps'
  request_hash text NOT NULL,        -- sha256 of the validated request (see Idempotency)
  response_status int NULL,
  response_body jsonb NULL,
  transaction_id uuid NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (key, endpoint)
)

-- fx_rates: persisted cache of live fetches (fallback rates are an in-code constant, never rows here)
fx_rates (
  base_currency text,
  quote_currency text,
  rate numeric(38,18) NOT NULL,
  source text NOT NULL,              -- always 'live' for stored rows
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (base_currency, quote_currency)
)
```

Ledger entries per transaction type: a deposit writes one credit; a swap writes one debit and one credit on the same wallet; a transfer writes a debit on the sender and a credit on the receiver.

**Invariant:** `SUM(ledger_entries.amount)` grouped by (wallet, currency) equals `balances.amount` for every row — in both directions: a balance with no ledger entries behind it is flagged exactly like a ledger sum with no balance row. The e2e suites that move money (deposits, swaps, transfers, history) assert this after every test.

Design choices worth naming:

- **Eager balance rows.** Wallet creation inserts all five balance rows at 0 in the same transaction as the wallet, so balance reads and `FOR UPDATE` locks never meet a missing row, and a transfer receiver always has a row to credit.
- **No foreign keys from `transactions` or `ledger_entries` to `wallets`.** The ledger is the audit trail; transaction rows are immutable records that must survive anything that happens to the wallets they reference. Wallet existence is still enforced at write time: every operation locks the wallet's balance rows, which do reference `wallets`, and a missing row is a 404 before anything is written.
- **Party rules live in the schema too.** A migration added two `CHECK`s on `transactions`: the party shape (transfers name only a sender and receiver, deposits and swaps only `wallet_id`) and `sender_wallet_id <> receiver_wallet_id`, the schema-level twin of the API's 422 `SELF_TRANSFER`. Together they make a wallet's three history roles disjoint.
- **The projection is lockable on purpose.** Summing ledger rows on every read would be correct but would make "lock the current balance" awkward; one row per (wallet, currency) gives `FOR UPDATE` a natural target and keeps reads O(1).

## Money precision

- Amounts are **strings** end to end: strings in JSON requests and responses, `numeric(38,8)` in Postgres, `decimal.js` in application code. `parseFloat`, `Number()` and float arithmetic are never used for amounts, and the column transformer throws if a JS number reaches the database boundary in either direction. Even the FX provider's JSON is parsed with a reviver that keeps each rate's source text, so no rate ever passes through a float.
- Request validation: an amount must match `^[0-9]{1,20}(\.[0-9]{1,8})?$` and be greater than zero. More than 8 decimal places, or an unsupported currency, returns 422.
- **Two rounding rules, each used once.** Amounts round **down** to 8 dp, so the platform never credits more than the rate supports. Rates are quantized **half-up** to 18 dp, matching how Postgres itself casts into `numeric(38,18)`, so the database can never silently re-round a rate behind the application's back.
- **The stored rate is the applied rate.** The cross rate is quantized to 18 dp first and stored as `fx_rate`; the destination amount is then derived from that stored string, `round_down(source_amount * fx_rate, 8 dp)`. The recorded rate and the recorded amounts can never disagree: a unit test at 1e11 cNGN→USDx, where the exact quotient (`67567567.56756756`) and the stored-rate product (`67567567.56756760`) genuinely diverge, pins that the stored rate wins.
- Rounding lives in one shared `Money` utility and nowhere else. If a conversion rounds down to zero at 8 dp, the request is rejected with 422 `AMOUNT_TOO_SMALL` — inside the idempotent transaction (see below for why).

## Idempotency

- Deposits, swaps and transfers **require** an `Idempotency-Key` header (up to 255 chars). A missing header returns 400 `IDEMPOTENCY_KEY_REQUIRED`. Wallet creation takes no key: its unique constraints (409 `WALLET_EXISTS`) already make retries safe.
- **Single-transaction design.** The key row is written at the start of the same database transaction that performs the operation, and the response is written to it at the end, so a key only ever becomes visible together with its effects:
  1. First statement of the transaction: `INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING`, then check the inserted row count (`DO NOTHING` so a conflict does not abort the transaction).
  2. Zero rows inserted means the key already exists. A concurrent duplicate blocks on the unique index until the first transaction finishes, then sees its committed row. Same `request_hash`: return the stored response with the header `Idempotent-Replay: true`. Different hash: 422 `IDEMPOTENCY_KEY_REUSED`.
  3. On success, `response_status` and `response_body` are written to the key row before commit.
- **No in-progress state, no stuck keys.** A crash or a business failure (insufficient funds, validation) rolls back the whole transaction, key row included, so the key is not consumed and the client can retry with it. The guarantee is **at-most-once success** per key: a key can never produce two successful operations, and a failed attempt leaves no trace.
- **The hash covers the validated request**, not the raw bytes: the whitelisted DTO plus path params, with canonically ordered keys, lowercased wallet ids, and the defaulted destination currency. A retry that differs only in JSON key order, unknown extra fields or id casing is the same request and replays. Amount strings are compared as sent, so `"10.5"` and `"10.50"` are different requests — the server does not guess at client serializer semantics.
- **Replays beat state-dependent checks.** Checks that depend only on the request body (unsupported currency, same-currency swap) may run before the key lookup: a same-body replay could never have passed them differently. The zero-destination check depends on the current FX rate, so it runs inside the transaction, after the key insert — otherwise a retry of an already-committed tiny conversion could be rejected after the rate moved, even though its balance changes are durable. A replay always returns the stored response.
- Two consequences worth knowing: replays are content-identical rather than byte-identical (`jsonb` canonicalizes key order), and every swap or cross-currency transfer prices through the FX chain before the key lookup, replays included — bounded by the FX cache (at most one provider timeout per 10 s per process when the provider is down), with a key-row peek as the known fast-path optimization.

## Concurrency

- Every mutation runs in **one Postgres transaction**. The default READ COMMITTED isolation is sufficient because every read that matters happens under a row lock.
- Balance rows are locked with `SELECT ... FOR UPDATE` **before** amounts are read, always in one global order, sorted byte-wise by `(wallet_id, currency)`. Crossing transfers (A to B and B to A in parallel) therefore cannot deadlock — tested with both directions running concurrently.
- Insufficient funds is checked after the lock, before any write. On failure the transaction rolls back with 422 `INSUFFICIENT_FUNDS`, nothing partial persists, and the idempotency key is not consumed.
- `CHECK (amount >= 0)` on `balances` is a last-resort backstop; correct application code never triggers it.
- The concurrency e2e fires ten parallel swaps whose total exceeds the balance and asserts the exact outcome the locks force: `floor(balance / amount)` succeed, every failure is `INSUFFICIENT_FUNDS`, no balance goes negative, and the ledger invariant holds. A second test forces two identical same-key requests to genuinely overlap (one blocked on a held row lock, one blocked on the key's unique index, observed via `pg_stat_activity`) and asserts exactly one transaction with one replay; the same overlap test runs for deposits and transfers. A third forces crossing transfers into the deadlock-prone interleaving, and ten interleaved crossing transfers must each end in 201 or a clean 422 with money conserved.

## FX rates and failure handling

- Stablecoins are priced 1:1 against their fiat: cNGN→NGN, cGHS→GHS, cXAF→XAF, USDx→USD, EURx→EUR.
- Live provider: `https://open.er-api.com/v6/latest/USD` (free, no API key). One USD-based table gives every cross rate: rate(A→B) = `rates[fiat(B)] / rates[fiat(A)]`, computed with decimal.js. The provider sits behind a single `FxProvider` class, so switching to another USD-base JSON API is a one-file change.
- **Whole-table snapshots.** Every successful fetch upserts the entire USD table into `fx_rates` in one transaction, and rates are always consumed as one snapshot, so every pair in a response — and every transaction — carries exactly one `rate_source`.
- Fallback chain, with a 3 s timeout on the live call (`FX_TIMEOUT_MS`, covering connect through body) and a 1 s timeout on each `fx_rates` read or write, so an unresponsive database cannot block a fallback that needs no database:
  1. Fresh live fetch — `rate_source = 'live'`
  2. Persisted `fx_rates` rows — `'cached'`
  3. `FALLBACK_RATES`, an in-code constant of approximate rates — `'fallback'`, which cannot fail
- Live snapshots are held in memory for 60 s; degraded (cached/fallback) snapshots for only 10 s, so a recovered provider is retried within seconds rather than serving stale rates for a minute. Concurrent callers share one in-flight resolution. The constant lives in code, never in `fx_rates`, so live upserts can never overwrite the last-resort tier.
- Rate-dependent endpoints never return 5xx because the provider is down. No FX or network I/O ever happens inside a database transaction: pricing completes before the transaction opens, and the rate that was computed is the rate that is stored and returned.
- A same-currency swap returns 422 `SAME_CURRENCY_SWAP`; a same-currency transfer uses rate `'1'` with `rate_source = 'none'` and takes no FX snapshot at all.

## Error design

One envelope everywhere — `{ "error": { "code", "message", "details"? } }` — including unhandled exceptions (500 `INTERNAL_ERROR`, generic message, nothing internal leaked). The full code table lives in the README; the rules behind it:

- **400 is reserved** for the missing `Idempotency-Key` header, and it is checked first: the interceptor runs before the pipes, so a missing key is 400 even when the body is also invalid. Validation failures return 422 (`ValidationPipe` is configured with `errorHttpStatusCode: 422`).
- **Request validity beats resource existence.** A doubly-invalid request reports the validation failure: an unsupported currency on an unknown wallet is 422 `UNSUPPORTED_CURRENCY`, consistently across endpoints. Among request checks, currency support comes before the rules on currencies and parties (`SAME_CURRENCY_SWAP`, `SELF_TRANSFER`).
- **Replay beats state-dependent checks**, as described under Idempotency.
- **Error details are keyed by code, not by endpoint.** A client switching on `error.code` reads the same `details` shape wherever that code appears; `AMOUNT_TOO_SMALL` describes the conversion (`from_currency`, `to_currency`, `amount`, `fx_rate`) for swaps and transfers alike.

## History pagination

- Keyset pagination over `(created_at DESC, id DESC)`, using the three per-role indexes; no `OFFSET`. The cursor is opaque base64url of the position at microsecond precision — millisecond precision would skip rows created in the same millisecond, and the id tiebreaker makes rows sharing a timestamp page without skips or duplicates.
- A wallet's history is the union of its three roles (owner, sender, receiver). The union branches mutually exclude by construction, so a row can match at most one branch whatever the data.
- The decoder validates strictly — malformed, tampered or impossible cursors are 422 `VALIDATION_ERROR`, never a 500 or a database error.
- Known limitation: a cursor is not bound to the wallet or filters that produced it, so reusing one against a different query returns rows from an arbitrary position rather than an error. Listed under [Out of scope](#out-of-scope).

## Testing strategy

`yarn test` runs unit and e2e suites; the README has the mechanics. The choices that matter:

- **The invariant is the referee.** The ledger-equals-balances check runs after every test in the money-moving e2e suites, in both directions, so any mutation that drifts the projection from the audit trail fails the suite that caused it.
- **No test touches the network.** The live provider is replaced by local stubs — including a black-hole server that accepts connections and never responds, which is what actually exercises the timeout path (an unroutable address can fail fast with a routing error instead). The FX e2e cases cover a hanging provider, an empty or incomplete `fx_rates` table, and a provider that serves live rates and then goes down, after which the persisted rows are served as cached.
- **Exact digits, independently recomputed.** FX tests run against a stub table with known cross rates; after a swap, the test re-reads the stored `fx_rate` and recomputes the destination with decimal.js, so the stored-rate-wins rule is verified from outside the implementation.
- **Concurrency is forced, not hoped for.** The overlap tests hold real row locks and wait for both contenders to appear as lock-waiters in `pg_stat_activity` before releasing, so the contention path is exercised deterministically.
- All wallets in mutation suites are funded through the real deposits endpoint, never by writing balances directly, so the invariant check stays meaningful.

## Out of scope

Deliberate cuts, not gaps:

- Authentication and KYC: wallets are identified only by unique email or phone; idempotency keys are consequently global, so unrelated clients could collide on a key
- Fees and spreads: all conversions happen at the mid-rate
- Async processing, webhooks, Redis or queues: nothing in scope needs them
- Multi-instance deployment: a single Postgres is the source of truth, and idempotency and locking assume it
- Phone normalization strips spaces and dashes only: `+234...` and `234...` are distinct wallets
- Destination overflow past `numeric(38,8)` is bounded for realistic rates but not enforced in code: a request amount has at most 20 integer digits and the column holds 30, so only a rate above about 10^10 overflows, surfacing as a 500
- History cursors are not bound to the wallet or filters that produced them (see [History pagination](#history-pagination)); binding the scope in was tried and reverted as not worth its cost here
- Rate limiting: per-IP limits are meaningless behind compose networking; the real version is a per-key token bucket at the gateway once auth exists, so it is deliberately absent rather than cosmetically present
- Soft deletes, admin endpoints

## With more time

- API-key authentication, with idempotency keys scoped per client and per-key rate limiting
- A fee engine: spreads and per-corridor fees, recorded as their own ledger entries
- Outbox pattern plus a queue to simulate async settlement (`pending` → `completed`; the `status` column is already there)
- A second FX provider behind the same `FxProvider` seam
- A scheduled reconciliation job asserting the ledger invariant in production, not only in tests
- A key-row peek before pricing, so replays skip the FX chain
- Binding history cursors to the query that produced them
- Property-based tests for money math, such as round-trip and monotonicity properties of `convert`
- Entity-metadata-driven row mapping for the history union query
- Consolidating wallet-existence checks behind one exported service method
