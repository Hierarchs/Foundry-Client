'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeJoinUrl, partitionFor, isAllowedNavigation, Store } = require('../src/core.cjs');
const testRoot = path.resolve(__dirname, '../.test-data');
function tempDirectory(prefix, t) {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, prefix));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(`${testRoot}${path.sep}`));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('join links preserve invitations, paths, and hashes; bare domains default to HTTPS', () => {
  assert.equal(normalizeJoinUrl(' world.games.sqyre.app/game/join?invite=abc#seat '), 'https://world.games.sqyre.app/game/join?invite=abc#seat');
  assert.equal(normalizeJoinUrl('http://127.0.0.1:30000/join'), 'http://127.0.0.1:30000/join');
  assert.equal(normalizeJoinUrl('http://[::1]:30000'), 'http://[::1]:30000/');
});
test('non-web protocols, embedded credentials, and control characters are rejected', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows', 'data:text/html,hello', 'https://user:pass@host.com', 'http://user:pass@10.8.0.12', 'https://exa\nmple.com', '', 'https://example.com/a b', 'ftp://host', 'ws://host', 'wss://host']) assert.throws(() => normalizeJoinUrl(url), { name: 'Error' });
});
test('local, LAN, VPN, IP, and hosted HTTP/HTTPS links use the same compatibility matrix as Rust', t => {
  for (const [input, expected] of require('./fixtures/join-links.json')) assert.equal(normalizeJoinUrl(input), expected, input);
  const initial = 'http://10.8.0.12:30000/foundry/join';
  assert.ok(isAllowedNavigation('http://10.8.0.12:30000/foundry/game', initial));
  assert.ok(!isAllowedNavigation('http://10.8.0.13:30000/foundry/game', initial));
  assert.ok(!isAllowedNavigation('http://10.8.0.12:30001/foundry/game', initial));
  assert.notEqual(partitionFor(initial), partitionFor('https://10.8.0.12:30000/foundry/join'));
  const directory = tempDirectory('network-', t);
  new Store(directory).save({name:'VPN game', url:initial});
  assert.equal(new Store(directory).data.sessions[0].url, initial);
});
test('navigation trusts exact origins and Sqyre subdomains without trusting lookalikes', () => {
  const url = 'https://a.games.sqyre.app/join';
  assert.ok(isAllowedNavigation('https://www.sqyre.app/login', url));
  assert.ok(isAllowedNavigation('https://a.games.sqyre.app/game', url));
  assert.ok(!isAllowedNavigation('https://evil-sqyre.app', url));
  assert.ok(!isAllowedNavigation('https://sqyre.app.evil.com', url));
  assert.ok(!isAllowedNavigation('file:///test', url));
  assert.ok(!isAllowedNavigation('http://a.games.sqyre.app', url));
  assert.ok(isAllowedNavigation('https://auth.example.com', url, new Set(['https://auth.example.com'])));
});
test('persistent partitions share a server login and isolate different origins', () => {
  assert.equal(partitionFor('https://a.games.sqyre.app/join?token=secret'), partitionFor('https://a.games.sqyre.app/game'));
  assert.notEqual(partitionFor('https://a.games.sqyre.app'), partitionFor('https://b.games.sqyre.app'));
  assert.match(partitionFor('https://host.com'), /^persist:game-[a-f\d]{24}$/);
});
test('session edits, preference validation, and settings survive a restart', t => {
  const dir = tempDirectory('unit-', t);
  const store = new Store(dir);
  const a = store.save({ name: 'Friday', url: 'first.games.sqyre.app', profile: 'efficiency' });
  const b = store.save({ name: 'Saturday', url: 'https://other.example.com', profile: '__proto__' });
  store.save({ ...a, url: 'updated.games.sqyre.app' });
  store.preferences({ allowMedia: true, keepAwake: 'false', malicious: true });
  const reopened = new Store(dir);
  assert.equal(reopened.data.sessions.length, 2);
  assert.equal(reopened.data.sessions[0].url, 'https://updated.games.sqyre.app/');
  assert.equal(reopened.data.sessions[0].id, a.id);
  assert.equal(reopened.data.sessions[1].profile, 'balanced');
  assert.deepEqual(reopened.data.preferences, { allowMedia: true, backgroundThrottle: true, keepAwake: true, preferDedicatedGpu: true, autoCheckUpdates: true });
  reopened.remove(b.id);
  assert.equal(new Store(dir).data.sessions.length, 1);
});
test('corrupt settings are preserved in a recovery copy', t => {
  const dir = tempDirectory('recovery-', t);
  fs.writeFileSync(path.join(dir, 'client-settings.json'), '{broken');
  const store = new Store(dir);
  assert.match(store.warning, /recovery/);
  assert.equal(store.data.sessions.length, 0);
  assert.ok(fs.readdirSync(dir).some(name => name.includes('.recovery-')));
});
