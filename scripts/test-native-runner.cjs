'use strict';
const { cargo } = require('./rust.cjs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
try {
  cargo(['build','--manifest-path','native/Cargo.toml','--features','test-driver','--locked']);
  const result=spawnSync(process.execPath,[path.join(__dirname,'test-native.cjs')],{stdio:'inherit',env:process.env});
  if(result.status !== 0) process.exitCode=result.status ?? 1;
  else {
    for(const script of ['test-features.cjs','test-performance.cjs','test-updates.cjs']) {
      const next=spawnSync(process.execPath,[path.join(__dirname,script)],{stdio:'inherit',env:process.env});
      if(next.status!==0){process.exitCode=next.status ?? 1;break;}
    }
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
