'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROFILES = Object.freeze({
  efficiency: { name: 'Efficiency', description: 'Lighter rendering for laptops and busy scenes.', settings: { performanceMode: 0, maxFPS: 30, pixelRatioResolutionScaling: false } },
  balanced: { name: 'Balanced', description: 'A smooth tabletop with moderate visual detail.', settings: { performanceMode: 1, maxFPS: 60, pixelRatioResolutionScaling: false } },
  quality: { name: 'Quality', description: 'More visual detail for a capable dedicated GPU.', settings: { performanceMode: 2, maxFPS: 60, pixelRatioResolutionScaling: true } }
});

function normalizeJoinUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Enter a valid game join link.');
  const input = value.trim();
  if (!input || /[\u0000-\u0020\u007f]/.test(input)) throw new Error('Enter a join link without spaces or control characters.');
  let url;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`); }
  catch { throw new Error('That join link is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS game join link.');
  if (!url.hostname || url.username || url.password) throw new Error('Use a join link without an embedded username or password.');
  return url.href;
}

function isSqyre(value) {
  try { const h = new URL(value).hostname; return h === 'sqyre.app' || h.endsWith('.sqyre.app'); }
  catch { return false; }
}

function isAllowedNavigation(target, initial, extraOrigins = new Set()) {
  try {
    const normalized = normalizeJoinUrl(target);
    const origin = new URL(normalized).origin;
    return origin === new URL(initial).origin || extraOrigins.has(origin) ||
      (normalized.startsWith('https://') && initial.startsWith('https://') && isSqyre(normalized) && isSqyre(initial));
  } catch { return false; }
}

function partitionFor(url) {
  return `persist:game-${createHash('sha256').update(new URL(url).origin).digest('hex').slice(0, 24)}`;
}

function cleanSession(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('Invalid session.');
  const url = normalizeJoinUrl(input.url);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  const profile = Object.hasOwn(PROFILES, input.profile) ? input.profile : 'balanced';
  return { id: existing?.id || randomUUID(), name: name || new URL(url).hostname, url, profile, lastJoined: existing?.lastJoined || null };
}

const DEFAULTS = Object.freeze({ backgroundThrottle: true, keepAwake: true, allowMedia: false, preferDedicatedGpu: true });

class Store {
  constructor(directory) {
    this.file = path.join(directory, 'client-settings.json');
    this.data = { sessions: [], preferences: { ...DEFAULTS }, backups: {} };
    this.warning = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const seen = new Set();
      this.data.sessions = (Array.isArray(saved.sessions) ? saved.sessions : []).slice(0, 100).flatMap(s => {
        try {
          if (typeof s.id !== 'string' || !/^[\w-]{1,80}$/.test(s.id) || seen.has(s.id)) return [];
          seen.add(s.id);
          return [{ ...cleanSession(s, { id: s.id, lastJoined: typeof s.lastJoined === 'string' && Number.isFinite(Date.parse(s.lastJoined)) ? s.lastJoined : null }) }];
        } catch { return []; }
      });
      for (const key of Object.keys(DEFAULTS)) if (typeof saved.preferences?.[key] === 'boolean') this.data.preferences[key] = saved.preferences[key];
      if (saved.backups && typeof saved.backups === 'object' && !Array.isArray(saved.backups)) this.data.backups = saved.backups;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.warning = 'Saved settings could not be read. A recovery copy was kept when possible.';
        try { fs.copyFileSync(this.file, `${this.file}.recovery-${Date.now()}`); } catch { /* Preserve the original if copying is unavailable. */ }
      }
    }
  }
  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  save(input) {
    const existing = this.data.sessions.find(s => s.id === input?.id);
    const item = cleanSession(input, existing);
    if (existing) this.data.sessions[this.data.sessions.indexOf(existing)] = item;
    else {
      if (this.data.sessions.length >= 100) throw new Error('You can save up to 100 sessions.');
      this.data.sessions.push(item);
    }
    this.write();
    return item;
  }
  remove(id) { this.data.sessions = this.data.sessions.filter(s => s.id !== id); this.write(); }
  preferences(input) {
    for (const key of Object.keys(DEFAULTS)) if (typeof input?.[key] === 'boolean') this.data.preferences[key] = input[key];
    this.write();
  }
}

module.exports = { PROFILES, DEFAULTS, normalizeJoinUrl, isSqyre, isAllowedNavigation, partitionFor, cleanSession, Store };
