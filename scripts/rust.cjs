'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function cargo(args, options = {}) {
  const rustBin = path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin');
  const executable = path.join(rustBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const result = spawnSync(fs.existsSync(executable) ? executable : 'cargo', args, {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
    env: { ...process.env, PATH: `${rustBin}${path.delimiter}${process.env.PATH || ''}`, ...options.env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo exited with code ${result.status}`);
}
if (require.main === module) { try { cargo(process.argv.slice(2)); } catch(error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { cargo };
