'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(directory, item.name)) : [path.join(directory, item.name)]);
}
for (const file of [...walk('src'), ...walk('scripts'), ...walk('tests')].filter(file => /\.[cm]?js$/.test(file))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log('JavaScript syntax checks passed.');
