import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './typeorm.config';

/** DataSource used by the TypeORM CLI for migration:generate / migration:run. */
export default new DataSource(buildDataSourceOptions());
