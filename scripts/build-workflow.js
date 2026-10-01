#!/usr/bin/env node
// Builds the "AI Inbox Triage" n8n workflow from source (this file + scripts/prompts/*.txt).
//
//   node scripts/build-workflow.js            -> build only, print node count
//   node scripts/build-workflow.js --deploy   -> build, import into the running n8n container,
//                                                publish, restart n8n, export the result to
//                                                workflows/inbox-triage.json (instance metadata removed)
//
// Every build gets a fresh versionId. Without one, n8n 2.x keeps the old versionId when a workflow
// with the same id is re-imported, and the published version would then still run the old nodes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { ROOT, setting, baseUrl } = require('./lib/env');
const WORKFLOW_ID = 'aiInboxTriage001';
const EXPORT_PATH = path.join(ROOT, 'workflows', 'inbox-triage.json');
// Node, condition and webhook ids are derived from a counter so that repeated builds produce the
// same export (no diff noise). Only versionId is random.
let idCounter = 0;
const uid = () => {
  const h = crypto.createHash('sha1').update(WORKFLOW_ID + ':' + idCounter++).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const readPrompt = (name) => fs.readFileSync(path.join(__dirname, 'prompts', name), 'utf8').trimEnd();

const SYSTEM_PROMPT = readPrompt('classify-system.txt');
const REPLY_PROMPT = readPrompt('reply-system.txt');

// Default pause between Gemini emails. Free tier Flash models allow about 10 requests/minute;
// 6.5 s keeps a dry run (one call per email) at ~9 requests/minute.
const GEMINI_DEFAULT_DELAY_MS = 6500;
const GEMINI_MAX_HTTP_RETRIES = 3;

// Categories, fields and types come from scripts/schema.json (its hash is part of every eval report).
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
const SCHEMA_FIELDS = Object.keys(SCHEMA.types);
const CATEGORIES = SCHEMA.categories;
const REVIEW = SCHEMA.needs_review;
const COLUMNS = ['id', 'provider', 'model', 'status', 'attempts', 'error', 'category', 'suggested_category', 'confidence', 'name', 'company', 'need', 'budget', 'timeline', 'customer', 'topic', 'urgency', 'vendor', 'invoice_number', 'amount', 'currency', 'due_date', 'reply_draft', 'notified', 'from_email', 'subject', 'review_text', 'latency_ms', 'processed_at'];

// ---------------------------------------------------------------- code nodes (JavaScript)
const CODE_SPLIT = `// Validates config once, then emits one item per email from the input file
// (data/emails.json, or eval/corrections/emails.json with {"input": "corrections"}).
const cfg = $('Config').first().json;
if (!['ollama', 'gemini'].includes(cfg.provider)) {
  throw new Error("provider must be 'ollama' or 'gemini', got: " + JSON.stringify(cfg.provider));
}
if (!cfg.model) {
  throw new Error(cfg.provider === 'gemini' ? 'GEMINI_MODEL is empty' : 'OLLAMA_MODEL is empty');
}
if (!Number.isFinite(cfg.gemini_delay_ms) || cfg.gemini_delay_ms < 0) {
  throw new Error('gemini_delay_ms must be a number >= 0');
}
if (!Number.isFinite(cfg.review_threshold) || cfg.review_threshold < 0 || cfg.review_threshold > 1) {
  throw new Error('${REVIEW.env} must be a number between 0 and 1');
}
const emails = $input.first().json.data;
if (!Array.isArray(emails)) throw new Error(cfg.input_file + ' must contain a JSON array');
const list = cfg.limit > 0 ? emails.slice(0, cfg.limit) : emails;
return list.map((e) => ({
  json: {
    id: String(e.id ?? ''),
    from_name: e.from_name ?? '',
    from_email: e.from_email ?? '',
    subject: e.subject ?? '',
    body: e.body ?? '',
    received_at: e.received_at ?? null,
  },
}));`;

const CODE_GMAIL = `// Maps Gmail Trigger (simple mode) messages to the same shape as emails.json.
return $('Gmail Trigger').all().map((m) => {
  const from = String(m.json.From ?? '');
  const addr = (from.match(/<([^>]+)>/) || [])[1] || from;
  return {
    json: {
      id: 'gmail-' + m.json.id,
      from_name: from.replace(/<[^>]*>/, '').replace(/"/g, '').trim(),
      from_email: addr.trim(),
      subject: m.json.Subject ?? '',
      body: m.json.snippet ?? '',
      received_at: new Date(Number(m.json.internalDate) || Date.now()).toISOString(),
    },
  };
});`;

const CODE_PREPARE = `// Builds the provider-specific classification request (Ollama /api/chat or Gemini generateContent).
const cfg = $('Config').first().json;
const email = $input.first().json;

const SYSTEM = ${JSON.stringify(SYSTEM_PROMPT)};
const clean = (s) => String(s ?? '').replace(/<\\/?email_body>/gi, '');
const userText = [
  'From: ' + clean(email.from_name) + ' <' + clean(email.from_email) + '>',
  'Received: ' + clean(email.received_at),
  'Subject: ' + clean(email.subject),
  '',
  '<email_body>',
  clean(email.body),
  '</email_body>',
].join('\\n');

const KEYS = ${JSON.stringify(SCHEMA_FIELDS)};
const CATEGORIES = ${JSON.stringify(CATEGORIES)};
const URGENCY = ${JSON.stringify(SCHEMA.urgency_values)};

let url, body;
if (cfg.provider === 'gemini') {
  const props = {};
  for (const k of KEYS) props[k] = { type: 'STRING', nullable: true };
  props.amount = { type: 'NUMBER', nullable: true };
  props.urgency = { type: 'STRING', enum: URGENCY, nullable: true };
  url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent';
  body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', enum: CATEGORIES },
          confidence: { type: 'NUMBER' },
          fields: { type: 'OBJECT', properties: props, required: KEYS, propertyOrdering: KEYS },
        },
        required: ['category', 'confidence', 'fields'],
        propertyOrdering: ['category', 'confidence', 'fields'],
      },
    },
  };
} else {
  const props = {};
  for (const k of KEYS) props[k] = { type: ['string', 'null'] };
  props.amount = { type: ['number', 'null'] };
  props.urgency = { type: ['string', 'null'], enum: [...URGENCY, null] };
  url = cfg.ollama_base_url + '/api/chat';
  body = {
    model: cfg.model,
    stream: false,
    think: false,
    options: { temperature: 0 },
    format: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORIES },
        confidence: { type: 'number' },
        fields: { type: 'object', properties: props, required: KEYS },
      },
      required: ['category', 'confidence', 'fields'],
    },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userText },
    ],
  };
}

return [{
  json: {
    email,
    provider: cfg.provider,
    model: cfg.model,
    started_at: Date.now(),
    attempt: 1,
    http_retry: 0,
    llm_url: url,
    llm_body: body,
  },
}];`;

const CODE_CHECK_RESPONSE = `// Gemini 429/5xx: wait with exponential backoff and call again (max ${GEMINI_MAX_HTTP_RETRIES} extra calls).
// This is separate from the schema retry ("attempts").
const ctx = $('Request Context').last().json;
const r = $input.first().json;
const status = Number(r.statusCode) || 0;
const retry = ctx.http_retry || 0;
if (ctx.provider === 'gemini' && (status === 429 || status >= 500) && retry < ${GEMINI_MAX_HTTP_RETRIES}) {
  let wait = 10 * 2 ** retry; // 10s, 20s, 40s
  const details = (r.body && r.body.error && r.body.error.details) || [];
  const hint = details.map((d) => d && d.retryDelay).find(Boolean);
  if (hint) wait = Math.max(wait, (parseFloat(hint) || 0) + 1);
  return [{ json: { ...ctx, http_retry: retry + 1, wait_seconds: Math.min(wait, 60), transient: true, last_status: status } }];
}
return [{ json: { ...r, transient: false } }];`;

const CODE_VALIDATE = `// Parses the LLM response and checks it against the schema. The model only classifies and
// extracts; n8n decides what is valid. Output: valid=true + result, or valid=false + error.
const ctx = $('Request Context').last().json;
const res = $input.first().json;

const FIELDS = ${JSON.stringify(SCHEMA.fields)};
const ALL_KEYS = ${JSON.stringify(SCHEMA_FIELDS)};
const TEXT_KEYS = ${JSON.stringify(SCHEMA_FIELDS.filter((k) => ['text', 'summary'].includes(SCHEMA.types[k])))};
const SUMMARY_KEYS = ${JSON.stringify(SCHEMA_FIELDS.filter((k) => SCHEMA.types[k] === 'summary'))};
const URGENCY = ${JSON.stringify(SCHEMA.urgency_values)};
// Business rule: below this confidence the email is not forced into a category ("${REVIEW.label}").
const REVIEW_THRESHOLD = $('Config').first().json.review_threshold;

function responseText(r) {
  if (r.error) {
    const msg = typeof r.error === 'string' ? r.error : (r.error.message || JSON.stringify(r.error));
    throw new Error('LLM request failed: ' + String(msg).slice(0, 300));
  }
  const status = Number(r.statusCode) || 0;
  const b = r.body;
  if (status >= 400) {
    const msg = (b && b.error && (b.error.message || b.error)) || JSON.stringify(b);
    throw new Error('LLM HTTP ' + status + ': ' + String(msg).slice(0, 300));
  }
  if (ctx.provider === 'gemini') {
    const c = b && b.candidates && b.candidates[0];
    const t = c && c.content && (c.content.parts || []).map((p) => p.text || '').join('');
    if (!t) throw new Error('Gemini returned no text (' + ((c && c.finishReason) || (b && b.promptFeedback && b.promptFeedback.blockReason) || 'unknown') + ')');
    return t;
  }
  const t = b && b.message && b.message.content;
  if (typeof t !== 'string' || !t.trim()) throw new Error('Ollama returned empty content');
  return t;
}

function validate(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('response is not valid JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('response is not a JSON object');
  const category = obj.category;
  if (!Object.prototype.hasOwnProperty.call(FIELDS, category)) throw new Error('invalid category: ' + JSON.stringify(category));
  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < ${SCHEMA.confidence.min} || confidence > ${SCHEMA.confidence.max}) {
    throw new Error('confidence must be a number between ${SCHEMA.confidence.min} and ${SCHEMA.confidence.max}: ' + JSON.stringify(confidence));
  }
  const raw = obj.fields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('fields must be an object');
  const unknown = Object.keys(raw).filter((k) => !ALL_KEYS.includes(k));
  if (unknown.length) throw new Error('unknown field keys: ' + unknown.join(', '));

  const fields = {};
  for (const k of FIELDS[category]) {
    if (!(k in raw)) throw new Error('missing field for ' + category + ': ' + k);
    let v = raw[k];
    if (TEXT_KEYS.includes(k)) {
      if (v !== null && typeof v !== 'string') throw new Error(k + ' must be a string or null');
      v = v === null ? null : v.trim() || null;
      // Business rule: need/topic are capped at ${SCHEMA.summary_max_words} words.
      if (v && SUMMARY_KEYS.includes(k)) v = v.split(/\\s+/).slice(0, ${SCHEMA.summary_max_words}).join(' ');
    } else if (k === 'amount') {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error('amount must be a number or null');
    } else if (k === 'currency') {
      if (v !== null) {
        if (typeof v !== 'string') throw new Error('currency must be a string or null');
        v = v.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(v)) throw new Error('currency must be an ISO 4217 code: ' + JSON.stringify(raw[k]));
      }
    } else if (k === 'due_date') {
      if (v !== null) {
        if (typeof v !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(v.trim())) throw new Error('due_date must be YYYY-MM-DD: ' + JSON.stringify(v));
        v = v.trim();
        const d = new Date(v + 'T00:00:00Z');
        if (isNaN(d) || d.toISOString().slice(0, 10) !== v) throw new Error('due_date is not a real date: ' + v);
      }
    } else if (k === 'urgency') {
      if (!URGENCY.includes(v)) throw new Error('urgency must be one of ' + URGENCY.join(', ') + ': ' + JSON.stringify(v));
    }
    fields[k] = v;
  }
  // Keys that belong to other categories are dropped (n8n keeps only the category's keys).
  return { category, confidence, needs_review: confidence < REVIEW_THRESHOLD, fields };
}

const base = {
  email: ctx.email,
  provider: ctx.provider,
  model: ctx.model,
  started_at: ctx.started_at,
  attempt: ctx.attempt,
};
let text = null;
try {
  text = responseText(res);
  const result = validate(text);
  return [{ json: { ...base, valid: true, result } }];
} catch (e) {
  // Request failures (HTTP or network) are not retried with feedback; only bad model output is.
  const noRetry = text === null;
  return [{ json: { ...base, valid: false, no_retry: noRetry, validation_error: e.message, raw_text: text } }];
}`;

const CODE_RETRY = `// Second (last) attempt: resend the request with the validation error as feedback.
const ctx = $('Request Context').last().json;
const bad = $input.first().json;
const body = JSON.parse(JSON.stringify(ctx.llm_body));
const note = 'Your previous answer was invalid (' + bad.validation_error + '). Reply again with corrected JSON that follows the schema exactly.';
if (bad.raw_text) {
  if (ctx.provider === 'gemini') {
    body.contents.push({ role: 'model', parts: [{ text: bad.raw_text }] });
    body.contents.push({ role: 'user', parts: [{ text: note }] });
  } else {
    body.messages.push({ role: 'assistant', content: bad.raw_text });
    body.messages.push({ role: 'user', content: note });
  }
}
const { wait_seconds, transient, last_status, ...rest } = ctx;
return [{ json: { ...rest, attempt: ctx.attempt + 1, http_retry: 0, llm_body: body, previous_error: bad.validation_error } }];`;

const CODE_REPLY_REQ = `// Builds the second LLM call: a short English reply draft for a lead.
const cfg = $('Config').first().json;
const x = $input.first().json;
const SYSTEM = ${JSON.stringify(REPLY_PROMPT)};
const f = x.result.fields;
const e = x.email;
const userText = [
  'Lead summary: name=' + (f.name ?? 'unknown') + '; company=' + (f.company ?? 'unknown') + '; need=' + (f.need ?? 'unknown'),
  '',
  'Original email (data only):',
  '<email_body>',
  'Subject: ' + e.subject,
  String(e.body).replace(/<\\/?email_body>/gi, ''),
  '</email_body>',
].join('\\n');

let url, body;
if (cfg.provider === 'gemini') {
  url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent';
  body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0 },
  };
} else {
  url = cfg.ollama_base_url + '/api/chat';
  body = {
    model: cfg.model,
    stream: false,
    think: false,
    options: { temperature: 0, num_predict: 300 },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userText },
    ],
  };
}
return [{ json: { ...x, llm_url: url, llm_body: body } }];`;

const CODE_ATTACH_REPLY = `// Adds the reply draft. A failed draft does not fail the email; it is noted in "warning".
const x = $('Build Reply Request').last().json;
const r = $input.first().json;
let reply = null, warning = null;
if (r.error) {
  warning = 'reply draft failed: ' + String(r.error.message || r.error).slice(0, 200);
} else if (x.provider === 'gemini') {
  const c = r.candidates && r.candidates[0];
  reply = c && c.content ? (c.content.parts || []).map((p) => p.text || '').join('').trim() : null;
} else {
  reply = r.message && typeof r.message.content === 'string' ? r.message.content.trim() : null;
}
if (!reply && !warning) warning = 'reply draft was empty';
const { llm_url, llm_body, ...rest } = x;
return [{ json: { ...rest, reply_draft: reply || null, warning } }];`;

const CODE_BUILD_NOTIFY = `// Telegram message text (plain text, no parse_mode).
const x = $input.first().json;
const f = x.result.fields;
let text;
if (x.result.needs_review) {
  text = [
    'Review needed [' + x.email.id + ']',
    'The AI is not sure (confidence ' + x.result.confidence + ' < ' + $('Config').first().json.review_threshold + '); its guess: ' + x.result.category,
    'From: ' + (x.email.from_name ? x.email.from_name + ' <' + x.email.from_email + '>' : x.email.from_email),
    'Subject: ' + x.email.subject,
    '',
    'Set the right category in the "${REVIEW.label}" tab of the sheet.',
  ].join('\\n');
} else if (x.result.category === 'lead') {
  text = [
    'New lead [' + x.email.id + ']',
    'From: ' + (f.name ?? x.email.from_name ?? '-') + (f.company ? ' (' + f.company + ')' : ''),
    'Need: ' + (f.need ?? '-'),
    'Budget: ' + (f.budget ?? '-') + ' | Timeline: ' + (f.timeline ?? '-'),
    '',
    'Reply draft:',
    x.reply_draft ?? '(none)',
  ].join('\\n');
} else {
  text = [
    'HIGH urgency support [' + x.email.id + ']',
    'Customer: ' + (f.customer ?? x.email.from_email ?? '-'),
    'Topic: ' + (f.topic ?? '-'),
    'Subject: ' + x.email.subject,
  ].join('\\n');
}
return [{ json: { ...x, telegram_text: text.slice(0, 4000) } }];`;

const CODE_MARK_NOTIFIED = `// Telegram result. Error details are not copied because they may contain the bot URL.
const x = $('Build Notification').last().json;
const r = $input.first().json;
const ok = r && r.ok === true;
const warn = ok ? x.warning : [x.warning, 'telegram send failed'].filter(Boolean).join('; ');
const { telegram_text, ...rest } = x;
return [{ json: { ...rest, notified: ok, warning: warn || null } }];`;

const CODE_RECORD = `// One CSV row per email, fixed column order. Missing values are empty strings.
const x = $input.first().json;
const ok = x.valid === true;
const f = ok ? x.result.fields : {};
const v = (k) => (f[k] === undefined || f[k] === null ? '' : f[k]);
const review = ok && x.result.needs_review === true;
const row = {
  id: x.email.id,
  provider: x.provider,
  model: x.model,
  status: ok ? 'ok' : 'error',
  attempts: Number(x.attempt) || 1,
  error: ok ? (x.warning || '') : (x.validation_error || 'unknown error'),
  // Low confidence: not forced into a category; the model's guess stays in suggested_category.
  category: ok ? (review ? '${REVIEW.label}' : x.result.category) : '',
  suggested_category: ok ? x.result.category : '',
  confidence: ok ? x.result.confidence : '',
  name: v('name'), company: v('company'), need: v('need'), budget: v('budget'), timeline: v('timeline'),
  customer: v('customer'), topic: v('topic'), urgency: v('urgency'),
  vendor: v('vendor'), invoice_number: v('invoice_number'), amount: v('amount'), currency: v('currency'), due_date: v('due_date'),
  reply_draft: x.reply_draft || '',
  notified: x.notified === true,
  from_email: x.email.from_email || '',
  subject: x.email.subject || '',
  // The email text is kept only for rows a person has to review.
  review_text: review ? String(x.email.body || '').slice(0, 1500) : '',
  latency_ms: Date.now() - x.started_at,
  processed_at: $now.toISO(),
};
return [{ json: row }];`;

const CODE_SHEET_ROWS = `// Rows for the "results" tab: every email except the ones that need a review.
return $('Loop Over Emails').all(0).filter((i) => i.json.category !== '${REVIEW.label}').map((i) => {
  const { review_text, ...row } = i.json;
  return { json: row };
});`;

const CODE_REVIEW_ROWS = `// Rows for the "${REVIEW.label}" tab. A person fills in correct_category;
// scripts/add-corrections.js turns the filled rows into eval test cases.
return $('Loop Over Emails').all(0).filter((i) => i.json.category === '${REVIEW.label}').map((i) => ({ json: {
  id: i.json.id,
  from_email: i.json.from_email,
  subject: i.json.subject,
  text: i.json.review_text,
  suggested_category: i.json.suggested_category,
  confidence: i.json.confidence,
  correct_category: '',
  processed_at: i.json.processed_at,
} }));`;

const CODE_SUMMARY = `// Final run summary (also the webhook response).
const cfg = $('Config').first().json;
const rows = $('Loop Over Emails').all(0).map((i) => i.json);
const ok = rows.filter((r) => r.status === 'ok');
const avg = (a) => (a.length ? Math.round(a.reduce((s, r) => s + Number(r.latency_ms || 0), 0) / a.length) : 0);
const byCategory = {};
for (const r of ok) byCategory[r.category] = (byCategory[r.category] || 0) + 1;

let sheets = 'skipped: GOOGLE_SHEET_ID is empty';
if (cfg.dry_run) sheets = 'skipped: dry_run';
else if (cfg.sheets_enabled) {
  let out = [];
  try { out = $('Append to Google Sheet').all(); } catch (e) { out = []; }
  let rev = [];
  try { rev = $('Append Needs Review').all(); } catch (e) { rev = []; }
  const err = [...out, ...rev].find((i) => i.json && i.json.error);
  sheets = err ? 'skipped: Google Sheets step failed (check the credential and that the "results" and "${REVIEW.label}" tabs exist)' : 'appended ' + out.length + ' rows to results, ' + rev.length + ' to ${REVIEW.label}';
}
let telegram = cfg.telegram_enabled ? 'enabled' : 'skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is empty';
if (cfg.dry_run) telegram = 'skipped: dry_run';
return [{
  json: {
    provider: cfg.provider,
    model: cfg.model,
    dry_run: cfg.dry_run,
    total: rows.length,
    ok: ok.length,
    error: rows.length - ok.length,
    retried: rows.filter((r) => Number(r.attempts) > 1).length,
    by_category: byCategory,
    needs_review: rows.filter((r) => r.category === '${REVIEW.label}').length,
    review_threshold: cfg.review_threshold,
    notified: rows.filter((r) => r.notified === true).length,
    avg_latency_ms: avg(rows),
    gemini_delay_ms: cfg.provider === 'gemini' ? cfg.gemini_delay_ms : null,
    input: cfg.input_file,
    csv: '/files/output/results.csv',
    telegram,
    sheets,
    started_at: cfg.run_started_at,
    finished_at: $now.toISO(),
  },
}];`;

// ---------------------------------------------------------------- build
function buildWorkflow() {
  idCounter = 0;
  const nodes = [];
  const add = (name, type, typeVersion, position, parameters, extra = {}) => {
    nodes.push({ parameters, id: uid(), name, type, typeVersion, position, ...extra });
    return name;
  };
  const code = (name, pos, jsCode) =>
    add(name, 'n8n-nodes-base.code', 2, pos, { language: 'javaScript', mode: 'runOnceForAllItems', jsCode });
  const cond = (leftValue, operator, rightValue = '') => ({ id: uid(), leftValue, rightValue, operator });
  const ifNode = (name, pos, c) =>
    add(name, 'n8n-nodes-base.if', 2.2, pos, {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [c],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    });
  const BOOL_TRUE = { type: 'boolean', operation: 'true', singleValue: true };
  const wait = (name, pos, amount) =>
    add(name, 'n8n-nodes-base.wait', 1.1, pos, { resume: 'timeInterval', amount, unit: 'seconds' }, { webhookId: uid() });
  const llmHttp = (name, pos, fullResponse) =>
    add(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
      method: 'POST',
      url: '={{ $json.llm_url }}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          // Only sent with a value for Gemini; the key is read from the environment at runtime.
          { name: 'x-goog-api-key', value: "={{ $json.provider === 'gemini' ? ($env.GEMINI_API_KEY || '') : '' }}" },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.llm_body) }}',
      options: fullResponse
        ? { timeout: 300000, response: { response: { fullResponse: true, neverError: true } } }
        : { timeout: 300000 },
    }, { onError: 'continueRegularOutput' });
  const body = (k) => `($json.body && $json.body.${k})`;

  // triggers
  add('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {});
  add('Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 200], {
    httpMethod: 'POST',
    path: 'inbox-triage',
    responseMode: 'lastNode',
    responseData: 'firstEntryJson',
    options: {},
  }, { webhookId: uid() });
  add('Gmail Trigger', 'n8n-nodes-base.gmailTrigger', 1.3, [0, 400], {
    pollTimes: { item: [{ mode: 'everyMinute' }] },
    simple: true,
    filters: { readStatus: 'unread' },
    options: {},
  }, { disabled: true });

  // config: webhook body (provider, dry_run, limit, gemini_delay_ms, input, review_threshold) overrides; secrets stay in $env
  add('Config', 'n8n-nodes-base.set', 3.4, [240, 200], {
    assignments: {
      assignments: [
        { id: uid(), name: 'provider', type: 'string', value: `={{ String(${body('provider')} || $env.AI_PROVIDER || 'ollama').trim().toLowerCase() }}` },
        { id: uid(), name: 'model', type: 'string', value: `={{ (String(${body('provider')} || $env.AI_PROVIDER || 'ollama').trim().toLowerCase() === 'gemini' ? $env.GEMINI_MODEL : $env.OLLAMA_MODEL) || '' }}` },
        { id: uid(), name: 'ollama_base_url', type: 'string', value: "={{ ($env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434').replace(/\\/+$/, '') }}" },
        { id: uid(), name: 'dry_run', type: 'boolean', value: `={{ ${body('dry_run')} === true || ${body('dry_run')} === 'true' }}` },
        { id: uid(), name: 'telegram_enabled', type: 'boolean', value: '={{ !!$env.TELEGRAM_BOT_TOKEN && !!$env.TELEGRAM_CHAT_ID }}' },
        { id: uid(), name: 'sheets_enabled', type: 'boolean', value: '={{ !!$env.GOOGLE_SHEET_ID }}' },
        { id: uid(), name: 'limit', type: 'number', value: `={{ Number(${body('limit')} || ($json.query && $json.query.limit) || 0) || 0 }}` },
        { id: uid(), name: 'gemini_delay_ms', type: 'number', value: `={{ ($json.body && $json.body.gemini_delay_ms !== undefined && $json.body.gemini_delay_ms !== '') ? Number($json.body.gemini_delay_ms) : (($env.GEMINI_DELAY_MS || '') !== '' ? Number($env.GEMINI_DELAY_MS) : ${GEMINI_DEFAULT_DELAY_MS}) }}` },
        { id: uid(), name: 'input_file', type: 'string', value: `={{ ${body('input')} === 'corrections' ? '/files/corrections/emails.json' : '/files/data/emails.json' }}` },
        { id: uid(), name: 'review_threshold', type: 'number', value: `={{ (${body('review_threshold')} !== undefined && ${body('review_threshold')} !== '' && ${body('review_threshold')} !== null) ? Number(${body('review_threshold')}) : ($env.${REVIEW.env} || '') !== '' ? Number($env.${REVIEW.env}) : ${REVIEW.default_threshold} }}` },
        { id: uid(), name: 'run_started_at', type: 'string', value: '={{ $now.toISO() }}' },
      ],
    },
    options: {},
  }, { executeOnce: true });

  ifNode('From Gmail?', [460, 200], cond("={{ $('Gmail Trigger').isExecuted }}", BOOL_TRUE));
  code('Map Gmail Message', [700, 400], CODE_GMAIL);
  add('Read emails.json', 'n8n-nodes-base.readWriteFile', 1.1, [700, 100], {
    operation: 'read',
    fileSelector: "={{ $('Config').first().json.input_file }}",
    options: {},
  });
  add('Parse JSON', 'n8n-nodes-base.extractFromFile', 1.1, [920, 100], { operation: 'fromJson', destinationKey: 'data', options: {} });
  code('Split Emails', [1140, 100], CODE_SPLIT);

  add('Loop Over Emails', 'n8n-nodes-base.splitInBatches', 3, [1380, 200], { batchSize: 1, options: {} });

  // per email: pace Gemini calls, classify, handle transient errors, validate, retry once
  ifNode('Pace Gemini?', [1600, 320], cond("={{ $('Config').first().json.provider === 'gemini' && $('Config').first().json.gemini_delay_ms > 0 }}", BOOL_TRUE));
  wait('Gemini Pace', [1820, 420], "={{ $('Config').first().json.gemini_delay_ms / 1000 }}");
  code('Prepare LLM Request', [2040, 320], CODE_PREPARE);
  add('Request Context', 'n8n-nodes-base.noOp', 1, [2260, 320], {});
  llmHttp('Classify (LLM)', [2480, 320], true);
  code('Check Response', [2700, 320], CODE_CHECK_RESPONSE);
  ifNode('Transient Error?', [2920, 320], cond('={{ $json.transient }}', BOOL_TRUE));
  wait('Backoff Wait', [3140, 520], '={{ $json.wait_seconds }}');
  code('Validate Output', [3140, 220], CODE_VALIDATE);
  ifNode('Valid?', [3360, 220], cond('={{ $json.valid }}', BOOL_TRUE));
  ifNode('Can Retry?', [3580, 420], cond('={{ $json.attempt < 2 && !$json.no_retry }}', BOOL_TRUE));
  code('Retry With Feedback', [3800, 520], CODE_RETRY);

  ifNode('Needs Review?', [3580, 20], cond('={{ $json.result.needs_review }}', BOOL_TRUE));
  add('Route by Category', 'n8n-nodes-base.switch', 3.2, [3800, 220], {
    rules: {
      values: CATEGORIES.map((c) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [cond('={{ $json.result.category }}', { type: 'string', operation: 'equals' }, c)],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: c,
      })),
    },
    options: {},
  });

  ifNode('Dry Run?', [3800, -100], cond("={{ $('Config').first().json.dry_run }}", BOOL_TRUE));
  code('Build Reply Request', [4020, -200], CODE_REPLY_REQ);
  llmHttp('Draft Reply (LLM)', [4240, -200], false);
  code('Attach Reply', [4460, -200], CODE_ATTACH_REPLY);
  ifNode('Urgent?', [3800, 120], cond('={{ $json.result.fields.urgency }}', { type: 'string', operation: 'equals' }, 'high'));
  code('Build Notification', [4680, -60], CODE_BUILD_NOTIFY);
  ifNode('Notify Enabled?', [4900, -60], cond("={{ $('Config').first().json.telegram_enabled && !$('Config').first().json.dry_run }}", BOOL_TRUE));
  add('Send Telegram', 'n8n-nodes-base.httpRequest', 4.2, [5120, -160], {
    method: 'POST',
    url: '=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ chat_id: $env.TELEGRAM_CHAT_ID, text: $json.telegram_text }) }}',
    options: { timeout: 15000 },
  }, { onError: 'continueRegularOutput' });
  code('Mark Notified', [5340, -160], CODE_MARK_NOTIFIED);

  code('Record Result', [5560, 220], CODE_RECORD);

  // after the loop: CSV, optional Sheets, summary
  add('Convert to CSV', 'n8n-nodes-base.convertToFile', 1.1, [1600, -100], {
    operation: 'csv',
    options: { fileName: 'results.csv', headerRow: true },
  });
  add('Write results.csv', 'n8n-nodes-base.readWriteFile', 1.1, [1820, -100], {
    operation: 'write',
    fileName: '/files/output/results.csv',
    dataPropertyName: 'data',
    options: { append: false },
  });
  ifNode('Sheets Enabled?', [2040, -200], cond("={{ $('Config').first().json.sheets_enabled && !$('Config').first().json.dry_run }}", BOOL_TRUE));
  ifNode('Any Results?', [2260, -300], cond(`={{ $('Loop Over Emails').all(0).some((i) => i.json.category !== '${REVIEW.label}') }}`, BOOL_TRUE));
  code('Rows for Sheet', [2480, -400], CODE_SHEET_ROWS);
  add('Append to Google Sheet', 'n8n-nodes-base.googleSheets', 4.7, [2700, -400], {
    authentication: 'oAuth2',
    resource: 'sheet',
    operation: 'append',
    documentId: { __rl: true, mode: 'id', value: '={{ $env.GOOGLE_SHEET_ID }}' },
    sheetName: { __rl: true, mode: 'name', value: 'results' },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  }, { onError: 'continueRegularOutput', alwaysOutputData: true });
  ifNode('Any Needs Review?', [2920, -300], cond(`={{ $('Loop Over Emails').all(0).some((i) => i.json.category === '${REVIEW.label}') }}`, BOOL_TRUE));
  code('Review Rows', [3140, -400], CODE_REVIEW_ROWS);
  add('Append Needs Review', 'n8n-nodes-base.googleSheets', 4.7, [3360, -400], {
    authentication: 'oAuth2',
    resource: 'sheet',
    operation: 'append',
    documentId: { __rl: true, mode: 'id', value: '={{ $env.GOOGLE_SHEET_ID }}' },
    sheetName: { __rl: true, mode: 'name', value: REVIEW.label },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  }, { onError: 'continueRegularOutput', alwaysOutputData: true });
  code('Run Summary', [3580, -200], CODE_SUMMARY);

  const connections = {};
  const link = (from, to, fromOutput = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= fromOutput) connections[from].main.push([]);
    connections[from].main[fromOutput].push({ node: to, type: 'main', index: 0 });
  };
  link('Manual Trigger', 'Config');
  link('Webhook', 'Config');
  link('Gmail Trigger', 'Config');
  link('Config', 'From Gmail?');
  link('From Gmail?', 'Map Gmail Message', 0);
  link('From Gmail?', 'Read emails.json', 1);
  link('Read emails.json', 'Parse JSON');
  link('Parse JSON', 'Split Emails');
  link('Split Emails', 'Loop Over Emails');
  link('Map Gmail Message', 'Loop Over Emails');

  link('Loop Over Emails', 'Convert to CSV', 0);   // done
  link('Loop Over Emails', 'Pace Gemini?', 1);     // loop
  link('Pace Gemini?', 'Gemini Pace', 0);
  link('Pace Gemini?', 'Prepare LLM Request', 1);
  link('Gemini Pace', 'Prepare LLM Request');
  link('Prepare LLM Request', 'Request Context');
  link('Request Context', 'Classify (LLM)');
  link('Classify (LLM)', 'Check Response');
  link('Check Response', 'Transient Error?');
  link('Transient Error?', 'Backoff Wait', 0);
  link('Transient Error?', 'Validate Output', 1);
  link('Backoff Wait', 'Request Context');
  link('Validate Output', 'Valid?');
  link('Valid?', 'Needs Review?', 0);
  link('Needs Review?', 'Build Notification', 0);  // low confidence -> "review needed" alert
  link('Needs Review?', 'Route by Category', 1);
  link('Valid?', 'Can Retry?', 1);
  link('Can Retry?', 'Retry With Feedback', 0);
  link('Can Retry?', 'Record Result', 1);           // still invalid -> status=error
  link('Retry With Feedback', 'Request Context');

  link('Route by Category', 'Dry Run?', 0);         // lead
  link('Route by Category', 'Urgent?', 1);          // support
  link('Route by Category', 'Record Result', 2);    // invoice
  link('Route by Category', 'Record Result', 3);    // spam
  link('Dry Run?', 'Record Result', 0);
  link('Dry Run?', 'Build Reply Request', 1);
  link('Build Reply Request', 'Draft Reply (LLM)');
  link('Draft Reply (LLM)', 'Attach Reply');
  link('Attach Reply', 'Build Notification');
  link('Urgent?', 'Build Notification', 0);
  link('Urgent?', 'Record Result', 1);
  link('Build Notification', 'Notify Enabled?');
  link('Notify Enabled?', 'Send Telegram', 0);
  link('Notify Enabled?', 'Record Result', 1);
  link('Send Telegram', 'Mark Notified');
  link('Mark Notified', 'Record Result');
  link('Record Result', 'Loop Over Emails');

  link('Convert to CSV', 'Write results.csv');
  link('Write results.csv', 'Sheets Enabled?');
  link('Sheets Enabled?', 'Any Results?', 0);
  link('Sheets Enabled?', 'Run Summary', 1);
  link('Any Results?', 'Rows for Sheet', 0);
  link('Any Results?', 'Any Needs Review?', 1);
  link('Rows for Sheet', 'Append to Google Sheet');
  link('Append to Google Sheet', 'Any Needs Review?');
  link('Any Needs Review?', 'Review Rows', 0);
  link('Any Needs Review?', 'Run Summary', 1);
  link('Review Rows', 'Append Needs Review');
  link('Append Needs Review', 'Run Summary');

  return {
    id: WORKFLOW_ID,
    versionId: crypto.randomUUID(),
    name: 'AI Inbox Triage',
    active: false,
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    pinData: {},
    tags: [],
  };
}

// Keeps only portable keys (no project/user ids, timestamps, version history or credentials).
// The Gmail Trigger is always exported disabled, as in the build.
function cleanExport(w) {
  const keep = ['id', 'name', 'nodes', 'connections', 'settings'];
  const out = {};
  for (const k of keep) if (k in w) out[k] = w[k];
  out.nodes = out.nodes.map((n) => {
    const { credentials, ...rest } = n;
    return n.name === 'Gmail Trigger' ? { ...rest, disabled: true } : rest;
  });
  return { ...out, active: false, pinData: {}, tags: [] };
}

// ---------------------------------------------------------------- deploy helpers
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}\n${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}
const compose = (...args) => run('docker', ['compose', ...args]);
const n8n = (...args) => compose('exec', '-T', 'n8n', 'n8n', ...args);
const catJson = (file) => JSON.parse(compose('exec', '-T', 'n8n', 'cat', file));

async function waitForHealth(timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(baseUrl() + '/healthz');
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`n8n did not become healthy on ${baseUrl()}`);
}

// Current workflow in n8n (or null if it has never been imported).
function currentWorkflow() {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'n8n', 'n8n', 'export:workflow', `--id=${WORKFLOW_ID}`, '--output=/tmp/wf-current.json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const w = catJson('/tmp/wf-current.json');
  compose('exec', '-T', 'n8n', 'rm', '-f', '/tmp/wf-current.json');
  return Array.isArray(w) ? w[0] : w;
}

// Looks up a credential's name and type by id. Only these two fields are read; the exported
// (encrypted) file is deleted right away.
function credentialInfo(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('N8N_SHEETS_CREDENTIAL_ID has an invalid format');
  try {
    n8n('export:credentials', `--id=${id}`, '--output=/tmp/cred-lookup.json');
    const c = [].concat(catJson('/tmp/cred-lookup.json'))[0];
    return { id: c.id, name: c.name, type: c.type };
  } catch (e) {
    throw new Error(`credential ${id} (N8N_SHEETS_CREDENTIAL_ID) was not found in n8n`);
  } finally {
    spawnSync('docker', ['compose', 'exec', '-T', 'n8n', 'rm', '-f', '/tmp/cred-lookup.json'], { cwd: ROOT });
  }
}

const SHEETS_NODES = ['Append to Google Sheet', 'Append Needs Review'];
const SHEETS_AUTH = { googleSheetsOAuth2Api: 'oAuth2', googleApi: 'serviceAccount' };

// Keeps credentials (and the Gmail Trigger on/off state) that were set up in the n8n UI, so a
// redeploy does not disconnect them. N8N_SHEETS_CREDENTIAL_ID, if set, wins for the Sheets node.
function applyCredentials(workflow, current) {
  const notes = [];
  const byName = new Map((current ? current.nodes : []).map((n) => [n.name, n]));
  for (const node of workflow.nodes) {
    const old = byName.get(node.name);
    if (old && old.credentials) {
      node.credentials = old.credentials;
      if (old.parameters && old.parameters.authentication) node.parameters.authentication = old.parameters.authentication;
      notes.push(`kept credential on "${node.name}"`);
    }
    if (old && node.name === 'Gmail Trigger' && old.disabled === false) {
      node.disabled = false;
      notes.push('kept Gmail Trigger enabled');
    }
  }
  // A Sheets node without a credential gets the one of the other Sheets node (same spreadsheet).
  const sheetsNodes = workflow.nodes.filter((n) => SHEETS_NODES.includes(n.name));
  const withCred = sheetsNodes.find((n) => n.credentials);
  for (const node of sheetsNodes) {
    if (!node.credentials && withCred) {
      node.credentials = withCred.credentials;
      node.parameters.authentication = withCred.parameters.authentication;
      notes.push(`copied the Sheets credential to "${node.name}"`);
    }
  }
  const credId = setting('N8N_SHEETS_CREDENTIAL_ID');
  if (credId) {
    const c = credentialInfo(credId);
    if (!SHEETS_AUTH[c.type]) throw new Error(`credential ${credId} has type ${c.type}, expected a Google Sheets OAuth2 or Google service account credential`);
    for (const node of workflow.nodes.filter((n) => SHEETS_NODES.includes(n.name))) {
      node.credentials = { [c.type]: { id: c.id, name: c.name } };
      node.parameters.authentication = SHEETS_AUTH[c.type];
      notes.push(`linked "${node.name}" to credential ${c.id} from N8N_SHEETS_CREDENTIAL_ID`);
    }
  }
  return notes;
}

async function deploy(workflow) {
  const running = compose('ps', '--status', 'running', '--services').split(/\r?\n/);
  if (!running.includes('n8n')) throw new Error('n8n service is not running. Start it with: docker compose up -d');

  for (const note of applyCredentials(workflow, currentWorkflow())) console.log('creds  :', note);

  const tmp = path.join(os.tmpdir(), `inbox-triage-import-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(workflow, null, 2));
  try {
    compose('cp', tmp, 'n8n:/tmp/wf-import.json');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  console.log('import :', n8n('import:workflow', '--input=/tmp/wf-import.json').split(/\r?\n/).pop());
  compose('exec', '-T', '-u', 'root', 'n8n', 'rm', '-f', '/tmp/wf-import.json');
  console.log('publish:', n8n('publish:workflow', `--id=${WORKFLOW_ID}`).split(/\r?\n/)[0]);
  console.log('restart: docker compose restart n8n');
  compose('restart', 'n8n');
  await waitForHealth();

  const w = currentWorkflow();
  // n8n assigns its own versionId on import; check that the published version is the current
  // draft and that the draft contains exactly the nodes we just built (including credentials).
  const sig = (wf) => JSON.stringify(wf.nodes.map((n) => [n.name, n.parameters && n.parameters.jsCode, n.credentials || null]));
  if (!w || w.activeVersionId !== w.versionId) {
    throw new Error(`published version ${w && w.activeVersionId} is not the imported version ${w && w.versionId}`);
  }
  if (sig(w) !== sig(workflow)) throw new Error('workflow in n8n does not match the build');
  fs.writeFileSync(EXPORT_PATH, JSON.stringify(cleanExport(w), null, 2) + '\n');
  console.log('export :', path.relative(ROOT, EXPORT_PATH), `(published version ${w.activeVersionId}, credentials removed)`);
  console.log('ready  :', baseUrl() + '/webhook/inbox-triage');
}

async function main() {
  const workflow = buildWorkflow();
  console.log(`built  : ${workflow.nodes.length} nodes, versionId ${workflow.versionId}`);
  if (process.argv.includes('--deploy')) await deploy(workflow);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('error:', e.message);
    process.exit(1);
  });
}

module.exports = { buildWorkflow, cleanExport, applyCredentials };
