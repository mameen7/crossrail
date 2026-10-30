import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * `yarn openapi`: writes the Swagger document to openapi.json at the repo
 * root. Preview mode builds the module graph without instantiating providers,
 * so no database is needed. test/openapi.e2e-spec.ts fails if the committed
 * file drifts from what the running app serves.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  const document = configureApp(app);
  await app.close();
  writeFileSync(join(__dirname, '..', 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
}

void main();
