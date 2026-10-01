#!/usr/bin/env node
// Turns human corrections of "needs_review" emails into eval test cases.
//
//   npm run corrections -- <file.csv>
//       CSV downloaded from the "needs_review" sheet tab (File > Download > CSV), or output/results.csv.
//       Rows with a valid category in "correct_category" become test cases.
//   npm run corrections -- --id e123 --category lead --subject "..." --text "..." [--from someone@example.com]
//       Adds one case by hand.
//   npm run corrections -- --list
//
// Cases are written to eval/corrections/emails.json and eval/corrections/labels.json (same format as
// data/, which never changes). `npm run eval` then scores them as a separate "corrections" set.
// These files can contain real emails, so they are git-ignored; commit them only if they are synthetic.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./eval');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'eval', 'corrections');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
const EMAILS = path.join(DIR, 'emails.json');
const LABELS = path.join(DIR, 'labels.json');
const readList = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);

function parseArgs(argv) {
  const a = { file: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--list') a.list = true;
    else if (['--id', '--category', '--subject', '--text', '--from'].includes(k)) { a[k.slice(2)] = argv[++i]; }
    else if (k === '--help' || k === '-h') a.help = true;
    else if (!k.startsWith('--') && !a.file) a.file = k;
    else throw new Error('unknown argument: ' + k);
  }
  return a;
}

// Accepts the needs_review tab (text, correct_category) and results.csv (review_text; correct_category added by hand).
function casesFromCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const out = [], skipped = [];
  for (const r of rows) {
    const category = String(r.correct_category || '').trim().toLowerCase();
    const text = r.text ?? r.review_text ?? '';
    if (!category) { skipped.push(`${r.id}: no correct_category`); continue; }
    if (!SCHEMA.categories.includes(category)) { skipped.push(`${r.id}: unknown category "${category}"`); continue; }
    if (!String(text).trim() && !String(r.subject || '').trim()) { skipped.push(`${r.id}: no subject or text`); continue; }
    out.push({ source_id: r.id, category, subject: r.subject || '', text, from_email: r.from_email || '', suggested: r.suggested_category || null, confidence: r.confidence === '' || r.confidence === undefined ? null : Number(r.confidence) });
  }
  return { out, skipped };
}

function save(cases) {
  const emails = readList(EMAILS);
  const labels = readList(LABELS);
  let added = 0, updated = 0;
  for (const c of cases) {
    const id = 'c-' + String(c.source_id).replace(/[^A-Za-z0-9._-]/g, '_');
    const email = { id, from_name: '', from_email: c.from_email, subject: c.subject, body: c.text, received_at: null };
    const label = { id, category: c.category, tags: ['human_correction'], fields: null, source_id: c.source_id, model_suggested: c.suggested, model_confidence: c.confidence, added_at: new Date().toISOString() };
    const i = labels.findIndex((l) => l.id === id);
    if (i === -1) { emails.push(email); labels.push(label); added++; }
    else { emails[emails.findIndex((e) => e.id === id)] = email; labels[i] = label; updated++; }
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(EMAILS, JSON.stringify(emails, null, 2) + '\n');
  fs.writeFileSync(LABELS, JSON.stringify(labels, null, 2) + '\n');
  return { added, updated, total: labels.length };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 15).join('\n')); return; }
  if (a.list) {
    const labels = readList(LABELS);
    if (!labels.length) { console.log('no corrections yet'); return; }
    for (const l of labels) console.log(`${l.id}\t${l.category}\t(model said ${l.model_suggested ?? '?'}, confidence ${l.model_confidence ?? '?'})`);
    return;
  }
  let cases = [], skipped = [];
  if (a.file) ({ out: cases, skipped } = casesFromCsv(path.resolve(a.file)));
  else if (a.id && a.category) {
    if (!SCHEMA.categories.includes(a.category)) throw new Error('--category must be one of ' + SCHEMA.categories.join(', '));
    cases = [{ source_id: a.id, category: a.category, subject: a.subject || '', text: a.text || '', from_email: a.from || '', suggested: null, confidence: null }];
  } else throw new Error('give a CSV file, or --id and --category (see --help)');
  for (const s of skipped) console.log('skipped', s);
  if (!cases.length) { console.log('nothing to add'); return; }
  const r = save(cases);
  console.log(`corrections: ${r.added} added, ${r.updated} updated, ${r.total} in eval/corrections/labels.json`);
}

try { main(); } catch (e) { console.error('error:', e.message); process.exit(1); }
