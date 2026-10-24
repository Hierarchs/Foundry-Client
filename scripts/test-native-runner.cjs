'use strict';
const { cargo } = require('./rust.cjs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
try {
  cargo(['build','--manifest-path','native/Cargo.toml','--features','test-driver','--locked']);
  const result=spawnSync(process.execPath,[path.join(__dirname,'test-native.cjs')],{stdio:'inherit',env:process.env});
  process.exitCode=result.status ?? 1;
} catch(error) {console.error(error.message);process.exitCode=1;}
