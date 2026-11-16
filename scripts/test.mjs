import { spawnSync } from 'node:child_process';

// Runtime tests need only the committed corpus, without acquisition archives.
const tests = [
  "test/cloudflare.test.mjs",
  "test/corpus.test.ts",
  "test/scaffold-tools.test.ts",
  "test/library.test.ts",
  "test/pruning.test.ts",
  "test/detemplatize.test.ts",
  "test/provider-http.test.ts",
  "test/clause-moves.test.ts",
  "test/hybrid-detemplatize.test.ts",
  "test/hybrid-movement.test.ts",
  "test/hybrid-spans.test.ts",
  "test/source-filter.test.ts",
  "test/stdio.test.ts",
  "test/http-bundle.test.ts",
  "test/html-app.test.ts"
];
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
