'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cargo } = require('./rust.cjs');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const root = path.resolve(__dirname,'..');
async function main() {
  cargo(['build','--manifest-path','native/Cargo.toml','--release','--locked']);
  const version = fs.readFileSync(path.join(root,'native/Cargo.toml'),'utf8').match(/^version = "([\d.]+)"/m)[1];
  const release = path.join(root,'release','rust'); fs.mkdirSync(release,{recursive:true});
  const portable = path.join(release,`Foundry-Client-Rust-${version}-x64.exe`);
  const source=path.join(root,'native/target/release/foundry-client.exe');
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(!fs.existsSync(portable)||digest(portable)!==digest(source))fs.copyFileSync(source,portable);
  const notices = path.join(release,'THIRD_PARTY_NOTICES.txt');
  const registry = path.join(process.env.USERPROFILE || process.env.HOME,'.cargo','registry','src');
  const registries = fs.readdirSync(registry).map(name=>path.join(registry,name));
  const lock = fs.readFileSync(path.join(root,'native/Cargo.lock'),'utf8');
  const texts = ['Foundry Client native Rust dependencies\n\nIncludes license notices from the locked dependency set, including build-time and other-platform dependencies. Microsoft Edge WebView2 is installed and updated separately by Microsoft.\n'];
  for(const match of lock.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g)) {
    const directory=registries.map(r=>path.join(r,`${match[1]}-${match[2]}`)).find(p=>fs.existsSync(p));
    if(!directory)continue;
    const files=fs.readdirSync(directory).filter(name=>/^(licen[cs]e|copying|notice)([._-]|$)/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
    for(const file of files)texts.push(`\n=== ${match[1]} ${match[2]} / ${file} ===\n${fs.readFileSync(path.join(directory,file),'utf8')}\n`);
  }
  fs.writeFileSync(notices,texts.join('\n'));
  const setup=path.join(release,`Foundry-Client-Rust-Setup-${version}-x64.exe`);
  const tool=await getMakeNsisPath();
  const build=spawnSync(tool.path,[`/DVERSION=${version}`,`/DAPP_EXE=${portable}`,`/DOUT_FILE=${setup}`,`/DICON_FILE=${path.join(root,'src/ui/icon.ico')}`,`/DNOTICES_FILE=${notices}`,path.join(root,'scripts/installer-native.nsi')],{cwd:root,env:{...process.env,...tool.env},stdio:'inherit'});
  if(build.status!==0)throw new Error(`Installer build failed (${build.status}).`);
  const staging=path.join(release,'portable');fs.mkdirSync(staging,{recursive:true});
  fs.copyFileSync(portable,path.join(staging,'Foundry Client.exe'));fs.copyFileSync(notices,path.join(staging,'THIRD_PARTY_NOTICES.txt'));
  fs.writeFileSync(path.join(staging,'START HERE.txt'),'Run Foundry Client.exe and paste a Foundry VTT game join link.\r\n\r\nRequires Windows 10/11 x64 and Microsoft Edge WebView2 Runtime.\r\nWebView2 download: https://developer.microsoft.com/en-us/microsoft-edge/webview2/\r\n\r\nSaved sessions and preferences are imported once from the previous Electron client. Browser logins need a fresh sign-in.\r\n');
  const zip=path.join(release,`Foundry-Client-Rust-${version}-x64.zip`);
  const archive=spawnSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/zip-native.ps1'),'-SourceDirectory',staging,'-Destination',zip],{cwd:root,stdio:'inherit'});
  if(archive.status!==0)throw new Error('Could not create the portable archive.');
  const files=[portable,setup,zip];
  const hashes=files.map(file=>`${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`);
  fs.writeFileSync(path.join(release,'SHA256SUMS.txt'),hashes.join('\n')+'\n');
  console.log(JSON.stringify({version,files:files.map(file=>({file,bytes:fs.statSync(file).size}))},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
