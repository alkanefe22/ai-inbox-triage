#!/usr/bin/env node
// Evaluates the n8n inbox triage workflow against data/labels.json.
//
//   npm run eval -- --provider ollama|gemini|all --runs 3 [--label baseline] [--url http://...]
//   npm run eval -- --report-only      (rebuild report + README block from eval/results)
//
// Each run triggers the webhook with {"dry_run": true, "provider": "..."} (no Telegram, Sheets or
// reply drafts), copies output/results.csv to eval/runs/<provider>-run<N>.csv and scores it.
// Writes eval/results/<provider>.json, eval/report.md and the EVAL block in README.md.
// No external dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { webhookUrl } = require('./lib/env');

const ROOT = path.resolve(__dirname, '..');
const DATA_BASE_COMMIT = 'dd597e4'; // data/ must match this commit
const P = (...p) => path.join(ROOT, ...p);
const PROVIDERS = ['ollama', 'gemini'];
const BENCHMARKED = ['ollama'];
const NOT_BENCHMARKED = { gemini: 'Gemini path implemented (AI_PROVIDER=gemini) but not benchmarked.' };
const CATEGORIES = ['lead', 'support', 'invoice', 'spam'];
const TAGS = ['ambiguous', 'missing_info', 'prompt_injection', 'mixed_language'];
const FIELDS = {
  lead: ['name', 'company', 'need', 'budget', 'timeline'],
  support: ['customer', 'topic', 'urgency'],
  invoice: ['vendor', 'invoice_number', 'amount', 'currency', 'due_date'],
  spam: [],
};
const EXACT_FIELDS = ['name', 'company', 'customer', 'vendor', 'invoice_number', 'currency', 'urgency', 'due_date', 'amount'];
const FLEX_FIELDS = ['need', 'topic', 'budget', 'timeline'];
const STOPWORDS = new Set(('a an and are as at be by for from has have i in into is it its of on or our the their them this to we with ' +
  'you your my me us can could would should will do does please need needs want wants about via per').split(' '));

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { provider: 'all', runs: 3, url: webhookUrl(), label: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--provider') { a.provider = v; i++; }
    else if (k === '--runs') { a.runs = Number(v); i++; }
    else if (k === '--url') { a.url = v; i++; }
    else if (k === '--label') { a.label = v; i++; }
    else if (k === '--report-only') { a.reportOnly = true; }
    else if (k === '--help' || k === '-h') { a.help = true; }
    else throw new Error('unknown argument: ' + k);
  }
  if (!['all', ...PROVIDERS].includes(a.provider)) throw new Error('--provider must be ollama, gemini or all');
  if (!Number.isInteger(a.runs) || a.runs < 1) throw new Error('--runs must be a positive integer');
  if (a.label && !/^[a-z0-9._-]+$/i.test(a.label)) throw new Error('--label may only contain letters, digits, dot, dash, underscore');
  return a;
}

// ---------------------------------------------------------------- helpers
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); };
const pct = (c, n) => (n ? Math.round((c / n) * 1000) / 10 : null);
const fmtPct = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(1) + '%');
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

function envIsSet(name) {
  // Only reports whether a value is present; the value itself is never printed or stored.
  try {
    const line = fs.readFileSync(P('.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith(name + '='));
    return !!(line && line.slice(name.length + 1).trim());
  } catch { return false; }
}

// Minimal RFC 4180 CSV parser (handles quotes, escaped quotes, newlines in fields, BOM).
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.length > 1 || r[0] !== '');
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.setTimeout(0); // a Gemini run with pacing can take several minutes
    req.on('error', reject);
    req.end(data);
  });
}

// ---------------------------------------------------------------- scoring rules
const isNull = (v) => v === null || v === undefined || String(v).trim() === '';
const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, ' ');

function tokens(v) {
  return new Set(norm(v).split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOPWORDS.has(t)));
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return norm(a) === norm(b) ? 1 : 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function numberSet(v) {
  const out = new Set();
  for (const m of String(v).matchAll(/(\d+(?:[.,]\d+)*)(\s*k\b)?/gi)) {
    let s = m[1];
    s = /^\d{1,3}([.,]\d{3})+$/.test(s) ? s.replace(/[.,]/g, '') : s.replace(',', '.');
    let n = parseFloat(s);
    if (m[2]) n *= 1000;
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Returns true/false for one field. Both null -> correct, exactly one null -> wrong.
function fieldCorrect(field, expected, predicted) {
  if (isNull(expected) && isNull(predicted)) return true;
  if (isNull(expected) || isNull(predicted)) return false;
  if (field === 'amount') return Math.abs(Number(expected) - Number(predicted)) <= 0.01;
  if (field === 'need' || field === 'topic') return jaccard(expected, predicted) >= 0.5;
  if (field === 'budget' || field === 'timeline') {
    if (norm(expected) === norm(predicted)) return true;
    const a = numberSet(expected), b = numberSet(predicted);
    return a.size > 0 && sameSet(a, b);
  }
  return norm(expected) === norm(predicted);
}

// ---------------------------------------------------------------- one run
function scoreRun(rows, labels) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = labels.map((l) => {
    const r = byId.get(l.id);
    const predicted = !r ? 'missing' : r.status === 'ok' ? r.category : 'error';
    const categoryOk = predicted === l.category;
    const fields = {};
    if (categoryOk) {
      for (const f of FIELDS[l.category]) fields[f] = { expected: l.fields[f], predicted: r[f] === '' ? null : r[f], ok: fieldCorrect(f, l.fields[f], r[f]) };
    }
    return {
      id: l.id, expected: l.category, predicted, categoryOk, tags: l.tags, fields,
      status: r ? r.status : 'missing', attempts: r ? Number(r.attempts) || 1 : null,
      latency_ms: r ? Number(r.latency_ms) || 0 : null, error: r ? r.error : 'row missing',
    };
  });
  const correct = items.filter((i) => i.categoryOk).length;
  return { items, correct, total: items.length, accuracy: pct(correct, items.length) };
}

// ---------------------------------------------------------------- aggregate
function aggregate(provider, model, runs, labels) {
  const done = runs.filter((r) => r.completed);
  const accs = done.map((r) => r.score.accuracy);
  const allItems = done.flatMap((r) => r.score.items);

  const cols = [...CATEGORIES];
  if (allItems.some((i) => !CATEGORIES.includes(i.predicted))) cols.push('error');
  const confusion = Object.fromEntries(CATEGORIES.map((e) => [e, Object.fromEntries(cols.map((p) => [p, 0]))]));
  for (const i of allItems) confusion[i.expected][CATEGORIES.includes(i.predicted) ? i.predicted : 'error']++;

  const perField = {};
  for (const i of allItems) for (const [f, v] of Object.entries(i.fields)) {
    perField[f] ??= { correct: 0, n: 0 };
    perField[f].n++; if (v.ok) perField[f].correct++;
  }
  for (const v of Object.values(perField)) v.accuracy = pct(v.correct, v.n);
  const sumGroup = (names) => {
    const c = names.reduce((s, f) => s + (perField[f]?.correct || 0), 0);
    const n = names.reduce((s, f) => s + (perField[f]?.n || 0), 0);
    return { correct: c, n, accuracy: pct(c, n) };
  };
  const categoryCorrectEmails = allItems.filter((i) => i.categoryOk).length;

  const tagGroups = {};
  for (const t of [...TAGS, 'untagged']) {
    const g = allItems.filter((i) => (t === 'untagged' ? i.tags.length === 0 : i.tags.includes(t)));
    const c = g.filter((i) => i.categoryOk).length;
    tagGroups[t] = { emails: labels.filter((l) => (t === 'untagged' ? l.tags.length === 0 : l.tags.includes(t))).length, correct: c, n: g.length, accuracy: pct(c, g.length) };
  }

  const injection = labels.filter((l) => l.tags.includes('prompt_injection')).map((l) => {
    const perRun = done.map((r) => {
      const i = r.score.items.find((x) => x.id === l.id);
      const fieldsOk = i.categoryOk && Object.values(i.fields).every((f) => f.ok);
      return {
        run: r.run, predicted: i.predicted, categoryOk: i.categoryOk,
        fieldsOk: i.categoryOk ? fieldsOk : null,
        wrongFields: Object.entries(i.fields).filter(([, f]) => !f.ok).map(([k]) => k),
        pass: i.categoryOk && fieldsOk,
      };
    });
    return { id: l.id, expected: l.category, runs: perRun, passed: perRun.filter((x) => x.pass).length };
  });
  const injPassed = injection.reduce((s, x) => s + x.passed, 0);

  // Emails with the most mistakes (category + field) across completed runs.
  const mistakes = labels.map((l) => {
    const its = done.map((r) => r.score.items.find((x) => x.id === l.id));
    const catWrong = its.filter((i) => !i.categoryOk);
    const fieldWrong = its.flatMap((i) => Object.entries(i.fields).filter(([, f]) => !f.ok).map(([k, f]) => ({ field: k, expected: f.expected, predicted: f.predicted })));
    return {
      id: l.id, expected: l.category, tags: l.tags,
      category_errors: catWrong.length, predicted: [...new Set(catWrong.map((i) => i.predicted))],
      field_errors: fieldWrong.length, wrong_fields: fieldWrong,
      total: catWrong.length + fieldWrong.length,
    };
  }).filter((m) => m.total > 0).sort((a, b) => b.category_errors - a.category_errors || b.total - a.total);

  const lat = allItems.map((i) => i.latency_ms).filter((x) => x !== null);
  return {
    provider, model, status: done.length ? 'done' : 'incomplete',
    evaluated_at: new Date().toISOString(),
    runs_requested: runs.length, runs_completed: done.length,
    runs: runs.map((r) => ({
      run: r.run, completed: r.completed, reason: r.reason || null, csv: r.csv || null,
      accuracy: r.completed ? r.score.accuracy : null, correct: r.completed ? r.score.correct : null,
      total: r.completed ? r.score.total : null,
      errors: r.completed ? r.score.items.filter((i) => i.status !== 'ok').length : null,
      retried: r.completed ? r.score.items.filter((i) => i.attempts > 1).length : null,
      avg_latency_ms: r.completed ? Math.round(mean(r.score.items.map((i) => i.latency_ms))) : null,
      duration_s: r.duration_s ?? null,
    })),
    category_accuracy: { mean: round1(mean(accs)), min: accs.length ? Math.min(...accs) : null, max: accs.length ? Math.max(...accs) : null, per_run: accs },
    confusion_matrix: { rows: 'expected', columns: 'predicted', runs_summed: done.length, matrix: confusion },
    field_accuracy: {
      scored_on: 'emails whose category was predicted correctly',
      emails_scored: categoryCorrectEmails,
      exact: sumGroup(EXACT_FIELDS), flexible: sumGroup(FLEX_FIELDS),
      overall: sumGroup([...EXACT_FIELDS, ...FLEX_FIELDS]),
      per_field: perField,
    },
    tag_breakdown: tagGroups,
    prompt_injection: { passed: injPassed, total: injection.length * done.length, emails: injection },
    operations: {
      status_error: allItems.filter((i) => i.status !== 'ok').length,
      attempts_2: allItems.filter((i) => i.attempts > 1).length,
      avg_latency_ms: lat.length ? Math.round(mean(lat)) : null,
      rows_scored: allItems.length,
    },
    top_mistakes: mistakes.slice(0, 10),
  };
}

// ---------------------------------------------------------------- run a provider
async function evalProvider(provider, args, labels) {
  const runs = [];
  let model = null;
  for (let n = 1; n <= args.runs; n++) {
    const t0 = Date.now();
    process.stdout.write(`[${provider}] run ${n}/${args.runs} ... `);
    const run = { run: n, completed: false };
    try {
      const res = await postJson(args.url, { dry_run: true, provider });
      run.duration_s = Math.round((Date.now() - t0) / 1000);
      if (res.status !== 200) throw new Error(`webhook HTTP ${res.status}: ${res.body.slice(0, 300)}`);
      const summary = JSON.parse(res.body);
      model = summary.model || model;
      if (summary.provider !== provider) throw new Error(`workflow ran provider ${summary.provider}, expected ${provider}`);
      const csvText = fs.readFileSync(P('output', 'results.csv'), 'utf8');
      const rows = parseCsv(csvText);
      if (rows.length !== labels.length) throw new Error(`results.csv has ${rows.length} rows, expected ${labels.length}`);
      if (rows.some((r) => r.provider !== provider)) throw new Error('results.csv contains rows from another provider');
      if (rows.some((r) => Date.parse(r.processed_at) < t0 - 5000)) throw new Error('results.csv is older than this run');
      const quota = rows.filter((r) => r.status !== 'ok' && /HTTP 429|RESOURCE_EXHAUSTED|quota/i.test(r.error));
      const csvRel = path.join('eval', 'runs', `${provider}-run${n}.csv`);
      fs.mkdirSync(P('eval', 'runs'), { recursive: true });
      fs.writeFileSync(P(csvRel), csvText);
      run.csv = csvRel.split(path.sep).join('/');
      if (quota.length) throw new Error(`${quota.length} rows failed with a rate limit / quota error`);
      run.score = scoreRun(rows, labels);
      run.completed = true;
      console.log(`${run.score.accuracy}% category accuracy, ${run.duration_s}s`);
    } catch (e) {
      run.reason = e.message;
      console.log('NOT COMPLETED: ' + e.message);
    }
    runs.push(run);
  }
  return aggregate(provider, model, runs, labels);
}

// ---------------------------------------------------------------- report
function mdTable(header, rows) {
  return ['| ' + header.join(' | ') + ' |', '|' + header.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');
}
const accCell = (r) => (r.status === 'done' ? `${fmtPct(r.category_accuracy.mean)} (${fmtPct(r.category_accuracy.min)}–${fmtPct(r.category_accuracy.max)})` : '–');
const FLEX_SENTENCE = 'Flexible match: need/topic count as correct when their word sets (stopwords removed) overlap by Jaccard ≥ 0.5; budget/timeline when the normalized text or the set of numbers in it is equal.';

function summaryRow(r) {
  if (r.status === 'not_benchmarked') return [r.provider, '–', r.reason, '–', '–', '–', '–', '–'];
  if (r.status !== 'done') return [r.provider, r.model || '–', 'not completed', '–', '–', '–', '–', r.evaluated_at.slice(0, 10)];
  return [
    r.provider, '`' + r.model + '`', accCell(r),
    fmtPct(r.field_accuracy.exact.accuracy), fmtPct(r.field_accuracy.flexible.accuracy),
    `${r.prompt_injection.passed}/${r.prompt_injection.total}`,
    r.operations.avg_latency_ms + ' ms', r.evaluated_at.slice(0, 10),
  ];
}
const SUMMARY_HEADER = ['Provider', 'Model', 'Category accuracy, mean (min–max)', 'Exact fields', 'Flexible fields', 'Prompt injection passed', 'Avg latency', 'Eval date'];

function providerSection(r) {
  const out = [`## ${r.provider}`];
  if (r.status === 'not_benchmarked') { out.push(r.reason); return out.join('\n\n'); }
  out.push(`Model: \`${r.model}\` · runs completed: ${r.runs_completed}/${r.runs_requested} · evaluated: ${r.evaluated_at}`);
  out.push('### Runs\n\n' + mdTable(['Run', 'Status', 'Category accuracy', 'status=error', 'attempts=2', 'Avg latency', 'Duration'],
    r.runs.map((x) => [x.run, x.completed ? 'completed' : `not completed: ${x.reason}`, fmtPct(x.accuracy), x.errors ?? '–', x.retried ?? '–', x.avg_latency_ms ? x.avg_latency_ms + ' ms' : '–', x.duration_s ? x.duration_s + ' s' : '–'])));
  if (r.status !== 'done') return out.join('\n\n');
  const a = r.category_accuracy;
  out.push(`### Category accuracy\n\nMean **${fmtPct(a.mean)}**, min ${fmtPct(a.min)}, max ${fmtPct(a.max)} (per run: ${a.per_run.map(fmtPct).join(', ')}).`);
  const cm = r.confusion_matrix.matrix; const cols = Object.keys(cm.lead);
  out.push(`### Confusion matrix (${r.confusion_matrix.runs_summed} runs summed; rows = expected, columns = predicted)\n\n` +
    mdTable(['expected \\ predicted', ...cols], CATEGORIES.map((e) => ['**' + e + '**', ...cols.map((p) => (e === p ? `**${cm[e][p]}**` : String(cm[e][p])))])));
  const fa = r.field_accuracy;
  out.push(`### Field accuracy\n\nScored only on emails whose category was correct (${fa.emails_scored} email-runs). Both null = correct, one null = wrong.\n\n` +
    mdTable(['Field', 'Type', 'Correct / n', 'Accuracy'], [
      ...EXACT_FIELDS.filter((f) => fa.per_field[f]).map((f) => [f, 'exact', `${fa.per_field[f].correct}/${fa.per_field[f].n}`, fmtPct(fa.per_field[f].accuracy)]),
      ...FLEX_FIELDS.filter((f) => fa.per_field[f]).map((f) => [f, 'flexible', `${fa.per_field[f].correct}/${fa.per_field[f].n}`, fmtPct(fa.per_field[f].accuracy)]),
      ['**exact total**', '', `${fa.exact.correct}/${fa.exact.n}`, `**${fmtPct(fa.exact.accuracy)}**`],
      ['**flexible total**', '', `${fa.flexible.correct}/${fa.flexible.n}`, `**${fmtPct(fa.flexible.accuracy)}**`],
      ['**all fields**', '', `${fa.overall.correct}/${fa.overall.n}`, `**${fmtPct(fa.overall.accuracy)}**`],
    ]) + '\n\n' + FLEX_SENTENCE);
  out.push('### Category accuracy by tag\n\n' + mdTable(['Tag', 'Emails', 'Correct / n', 'Accuracy'],
    Object.entries(r.tag_breakdown).map(([t, g]) => [t, g.emails, `${g.correct}/${g.n}`, fmtPct(g.accuracy)])));
  out.push(`### Prompt injection (${r.prompt_injection.passed}/${r.prompt_injection.total} email-runs passed)\n\nPass = category correct and all fields correct.\n\n` +
    mdTable(['Email', 'Expected', 'Predicted (per run)', 'Fields correct (per run)', 'Passed'],
      r.prompt_injection.emails.map((e) => [e.id, e.expected, e.runs.map((x) => x.predicted).join(', '),
        e.runs.map((x) => (x.fieldsOk === null ? '–' : x.fieldsOk ? 'yes' : 'no (' + x.wrongFields.join(', ') + ')')).join('; '),
        `${e.passed}/${e.runs.length}`])));
  const o = r.operations;
  out.push(`### Operations\n\nstatus=error: ${o.status_error} · attempts=2: ${o.attempts_2} · average latency: ${o.avg_latency_ms} ms (${o.rows_scored} rows).`);
  if (r.top_mistakes.length) {
    out.push('### Emails with the most mistakes\n\n' + mdTable(['Email', 'Expected', 'Tags', 'Category errors', 'Field errors'],
      r.top_mistakes.slice(0, 5).map((m) => [m.id, m.expected, m.tags.join(', ') || '–',
        m.category_errors ? `${m.category_errors}× → ${m.predicted.join('/')}` : '0',
        m.field_errors ? [...new Set(m.wrong_fields.map((f) => `${f.field} (expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.predicted)})`))].join('; ') : '0'])));
  }
  return out.join('\n\n');
}

function historySection() {
  const dir = P('eval', 'history');
  if (!fs.existsSync(dir)) return null;
  const labels = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  const rows = [];
  for (const l of labels) for (const p of PROVIDERS) {
    const f = path.join(dir, l, p + '.json');
    if (!fs.existsSync(f)) continue;
    const r = readJson(f);
    if (r.status !== 'done') continue;
    rows.push({ at: r.evaluated_at, cells: [l, p, '`' + r.model + '`', accCell(r), fmtPct(r.field_accuracy.exact.accuracy), fmtPct(r.field_accuracy.flexible.accuracy), `${r.prompt_injection.passed}/${r.prompt_injection.total}`, r.evaluated_at.slice(0, 16).replace('T', ' ')] });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return '## Prompt iterations\n\n' + mdTable(['Label', 'Provider', 'Model', 'Category accuracy', 'Exact fields', 'Flexible fields', 'Injection', 'Evaluated (UTC)'], rows.map((r) => r.cells));
}

function writeReport(results) {
  const parts = [
    '# Evaluation report',
    `Generated by \`npm run eval\` on ${new Date().toISOString()}. Dataset: 60 synthetic emails (15 lead, 15 support, 15 invoice, 15 spam), \`data/labels.json\` as ground truth. Every run is a dry run (no Telegram, Sheets or reply drafts). Runs that did not complete are excluded from averages.`,
    '## Summary\n\n' + mdTable(SUMMARY_HEADER, results.map(summaryRow)) + '\n\n' + FLEX_SENTENCE,
  ];
  const hist = historySection();
  if (hist) parts.push(hist);
  const changes = P('eval', 'prompt-changes.md');
  if (fs.existsSync(changes)) parts.push(fs.readFileSync(changes, 'utf8').trim());
  else {
    const done = results.filter((r) => r.status === 'done');
    if (done.length && done.every((r) => r.category_accuracy.mean >= 90)) {
      parts.push('## Prompt changes\n\nThe target (≥ 90% mean category accuracy) was met with the original prompt (`scripts/prompts/classify-system.txt`), so the prompt was not changed.');
    }
  }
  for (const r of results) parts.push(providerSection(r));
  fs.writeFileSync(P('eval', 'report.md'), parts.join('\n\n') + '\n');
}

function updateReadme(results) {
  const START = '<!-- EVAL:START -->', END = '<!-- EVAL:END -->';
  const block = [START,
    '### Evaluation results',
    '',
    mdTable(SUMMARY_HEADER, results.map(summaryRow)),
    '',
    FLEX_SENTENCE + ' Full report: [eval/report.md](eval/report.md).',
    END].join('\n');
  const f = P('README.md');
  let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s !== -1 && e > s) text = text.slice(0, s) + block + text.slice(e + END.length);
  else text = text.replace(/\s*$/, '') + '\n\n' + block + '\n';
  fs.writeFileSync(f, text);
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 10).join('\n')); return; }

  const diff = spawnSync('git', ['diff', '--quiet', DATA_BASE_COMMIT, '--', 'data/'], { cwd: ROOT });
  if (diff.status !== 0) throw new Error(`data/ differs from commit ${DATA_BASE_COMMIT} (or git failed); refusing to evaluate`);

  const labels = readJson(P('data', 'labels.json'));
  // Gemini is implemented in the workflow but not part of the benchmark: "all" runs Ollama only.
  // An explicit --provider gemini still works and needs GEMINI_API_KEY in .env.
  const providers = args.reportOnly ? [] : args.provider === 'all' ? BENCHMARKED : [args.provider];
  for (const provider of providers) {
    if (provider === 'gemini' && !envIsSet('GEMINI_API_KEY')) throw new Error('GEMINI_API_KEY is empty in .env');
    const result = await evalProvider(provider, args, labels);
    writeJson(P('eval', 'results', provider + '.json'), result);
    if (args.label) writeJson(P('eval', 'history', args.label, provider + '.json'), result);
  }

  // The report covers both providers; results from earlier invocations are kept.
  const all = PROVIDERS.map((p) => {
    const f = P('eval', 'results', p + '.json');
    if (fs.existsSync(f)) return readJson(f);
    return { provider: p, model: null, status: 'not_benchmarked', reason: NOT_BENCHMARKED[p] || 'not evaluated yet', evaluated_at: new Date().toISOString() };
  });
  writeReport(all);
  updateReadme(all);
  for (const r of all) {
    if (r.status === 'done') console.log(`${r.provider}: category accuracy mean ${fmtPct(r.category_accuracy.mean)} (${fmtPct(r.category_accuracy.min)}–${fmtPct(r.category_accuracy.max)}), runs ${r.runs_completed}/${r.runs_requested}`);
    else console.log(`${r.provider}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`);
  }
  console.log('wrote eval/results/*.json, eval/report.md, README.md (EVAL block)');
}

if (require.main === module) {
  main().catch((e) => { console.error('error:', e.message); process.exit(1); });
}

module.exports = { parseCsv, fieldCorrect, jaccard, numberSet, scoreRun };
