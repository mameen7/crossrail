# crossrail
A stablecoin cross-border payments sandbox: multi-currency wallets, FX swaps and transfers. NestJS + TypeScript + PostgreSQL.

## Requirements

- Node 22+ (22.12 or later; see `.nvmrc`), Yarn 1.x, Docker with Compose v2

## Setup and run

```sh
docker compose up
```

Postgres and the API start together. The API container waits for the database healthcheck, runs migrations, then serves on `http://localhost:3000` (Swagger UI at `/docs`).

If port 5432 is already taken on your machine, override the host port that Postgres is published on:

```sh
POSTGRES_PORT=5433 docker compose up
```

The same variable is read by the e2e test harness, so `POSTGRES_PORT=5433 yarn test` connects to the overridden port too. The API container is unaffected; it talks to Postgres over the compose network on 5432.

## Tests

```sh
docker compose up -d postgres   # e2e specs need a reachable Postgres
yarn test                       # unit + e2e
```

The e2e global setup creates a dedicated `crossrail_test` database and runs migrations against it; the development database is never touched.
