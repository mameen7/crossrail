import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import { numericString } from './numeric-string.transformer';

/**
 * Hard rule 1 enforced by metadata rather than by memory: every `numeric`
 * column on every entity under src/ must carry the numericString transformer.
 * Entities are discovered from disk so a new `*.entity.ts` file is covered
 * without this test being edited.
 */
describe('numeric entity columns', () => {
  const srcDir = join(__dirname, '..');
  const entityFiles = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.entity.ts'))
    .map((f) => join(srcDir, f));

  beforeAll(async () => {
    // Importing registers the decorators with TypeORM's metadata storage.
    await Promise.all(entityFiles.map((file) => import(file)));
  });

  it('discovers the entity files', () => {
    expect(entityFiles.length).toBeGreaterThanOrEqual(6);
  });

  it('declares every numeric column with the numericString transformer', () => {
    const numericColumns = getMetadataArgsStorage().columns.filter(
      (c) => c.options.type === 'numeric' || c.options.type === 'decimal',
    );
    expect(numericColumns.length).toBeGreaterThanOrEqual(6);

    const missing = numericColumns
      .filter((c) => c.options.transformer !== numericString)
      .map((c) => `${(c.target as { name?: string }).name ?? String(c.target)}.${c.propertyName}`);
    expect(missing).toEqual([]);
  });

  it('declares every numeric column with an explicit precision and scale', () => {
    const unsized = getMetadataArgsStorage()
      .columns.filter((c) => c.options.type === 'numeric' || c.options.type === 'decimal')
      .filter((c) => c.options.precision !== 38 || ![8, 18].includes(c.options.scale ?? -1))
      .map((c) => `${(c.target as { name?: string }).name ?? String(c.target)}.${c.propertyName}`);
    expect(unsized).toEqual([]);
  });
});
