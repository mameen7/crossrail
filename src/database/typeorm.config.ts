import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';

/**
 * Single source of TypeORM options, shared by the Nest module (runtime), the
 * TypeORM CLI (migrations) and the e2e global setup. Values come from the
 * environment; docker compose and .env.example document every variable.
 *
 * `synchronize` is always off: the schema is owned by migrations.
 */
export function buildDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST ?? 'localhost',
    port: parseInt(env.DB_PORT ?? '5432', 10),
    username: env.DB_USER ?? 'crossrail',
    password: env.DB_PASSWORD ?? 'crossrail',
    database: env.DB_NAME ?? 'crossrail',
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'migrations',
    synchronize: false,
    logging: false,
  };
}
