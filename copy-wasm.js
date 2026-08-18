import { copyFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('@gbmul/gbmul-wasm/package.json');
const pkgDir = dirname(pkgPath);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const outDir = resolve('pkg');
mkdirSync(outDir, { recursive: true });

for (const file of pkg.files) {
  copyFileSync(resolve(pkgDir, file), resolve(outDir, file));
  console.log(`  copied ${file}`);
}
console.log('Done — WASM files copied to pkg/');