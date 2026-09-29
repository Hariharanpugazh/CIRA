import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { buildExamples, buildSchema, EXAMPLES_DIR, PACKAGE_DIR, SCHEMA_FILE, serialize } from '../src/build';

mkdirSync(dirname(SCHEMA_FILE), { recursive: true });
writeFileSync(SCHEMA_FILE, serialize(buildSchema()));
console.log('wrote', relative(PACKAGE_DIR, SCHEMA_FILE));

mkdirSync(EXAMPLES_DIR, { recursive: true });
for (const { name, document } of buildExamples()) {
  writeFileSync(join(EXAMPLES_DIR, name), serialize(document));
  console.log('wrote', relative(PACKAGE_DIR, join(EXAMPLES_DIR, name)));
}
