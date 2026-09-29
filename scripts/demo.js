#!/usr/bin/env node
// Demo run: triggers the workflow for the first N emails with all actions on (reply drafts,
// Telegram, Sheets if configured), then prints what happened.
//
//   npm run demo                 (first 17 emails: includes leads and e017, the first high-urgency support email)
//   npm run demo -- --limit 5    (fewer emails)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ROOT, webhookUrl } = require('./lib/env');
const { parseCsv } = require('./eval');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(buf)) : reject(new Error(`webhook HTTP ${res.statusCode}: ${buf.slice(0, 300)}`))));
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const limit = Number(arg('--limit', 17));
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');

  // Pre-check against the dataset labels (only this helper reads labels.json, never the workflow).
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'labels.json'), 'utf8')).slice(0, limit);
  const leads = labels.filter((l) => l.category === 'lead').length;
  const urgent = labels.filter((l) => l.category === 'support' && l.fields.urgency === 'high').length;
  console.log(`first ${limit} emails: ${leads} lead, ${urgent} high-urgency support (by dataset labels)`);
  if (!leads || !urgent) {
    const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'labels.json'), 'utf8'));
    const need = Math.max(
      all.findIndex((l) => l.category === 'lead') + 1,
      all.findIndex((l) => l.category === 'support' && l.fields.urgency === 'high') + 1,
    );
    console.log(`note: use --limit ${need} to include at least one lead and one high-urgency support email`);
  }

  console.log(`POST ${webhookUrl()} {"limit": ${limit}} ...`);
  const t0 = Date.now();
  const summary = await post(webhookUrl(), { limit });
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s\n`);
  console.log(JSON.stringify(summary, null, 2));

  const rows = parseCsv(fs.readFileSync(path.join(ROOT, 'output', 'results.csv'), 'utf8'));
  console.log('\nid    category  status  detail');
  for (const r of rows) {
    const detail = r.category === 'lead' ? `${r.name || '-'} / ${r.company || '-'} · reply draft: ${r.reply_draft ? 'yes' : 'no'}`
      : r.category === 'support' ? `${r.customer || '-'} · urgency ${r.urgency}`
      : r.category === 'invoice' ? `${r.vendor || '-'} · ${r.amount} ${r.currency} due ${r.due_date || '-'}`
      : r.status === 'ok' ? '(no action)' : r.error;
    console.log(`${r.id}  ${(r.category || '-').padEnd(8)}  ${r.status.padEnd(6)}  ${detail}${r.notified === 'TRUE' || r.notified === 'true' ? ' · Telegram sent' : ''}`);
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
