'use strict';
// Reads non-secret settings from .env (process env wins). Values are never printed by callers
// unless they are known to be non-secret (port, project name, credential id).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function readDotEnv() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function setting(name, fallback = '') {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  const v = readDotEnv()[name];
  return v !== undefined && v !== '' ? v : fallback;
}

const hostPort = () => Number(setting('N8N_HOST_PORT', '5678'));
const baseUrl = () => `http://localhost:${hostPort()}`;
const webhookUrl = () => `${baseUrl()}/webhook/inbox-triage`;

module.exports = { ROOT, readDotEnv, setting, hostPort, baseUrl, webhookUrl };
