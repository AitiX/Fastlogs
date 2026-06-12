'use strict';

// Test runner: executes all *.test.js files under this directory using node:test.
// Usage: node test/run.js  (or: npm test)

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const testDir = __dirname;
const testFiles = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(testDir, f))
  .sort();

if (testFiles.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

console.log(`Running ${testFiles.length} test file(s)...\n`);

const result = spawnSync(
  process.execPath,
  ['--test', ...testFiles],
  {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { NODE_ENV: 'test' }),
  },
);

process.exit(result.status ?? 1);
