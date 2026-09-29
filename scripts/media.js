#!/usr/bin/env node
// Prepares demo media in docs/ with ffmpeg:
//   - docs/demo-raw.mp4          -> docs/demo.mp4 (sped up / trimmed to the target length, no audio)
//   - docs/demo.mp4              -> docs/demo.gif (max 800 px wide, kept under ~8 MB)
//   - docs/screenshot-*.png|jpg  -> 1600x1200 PNG, aspect ratio kept, padded with the image's own
//                                   corner colour (the dark n8n background; #1f1f1f as fallback)
//
//   npm run media                                  (auto speed so the video fits in 30 s)
//   npm run media -- --speed 2 --max-seconds 30    (fixed 2x; anything past 30 s is cut)
//   npm run media -- <dir>                         (other folder than docs/)
//
// demo-raw.mp4 and demo.mp4 are git-ignored; only demo.gif goes into the repo.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./lib/env');

const GIF_MAX_BYTES = 8 * 1024 * 1024;
const GIF_ATTEMPTS = [[10, 800], [8, 720], [6, 640]]; // [fps, max width]
const SHOT_W = 1600, SHOT_H = 1200;
const PAD_FALLBACK = '0x1f1f1f';

function parseArgs(argv) {
  const a = { dir: 'docs', speed: null, maxSeconds: 30 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--speed') a.speed = Number(argv[++i]);
    else if (k === '--max-seconds') a.maxSeconds = Number(argv[++i]);
    else if (k.startsWith('--')) throw new Error('unknown option: ' + k);
    else a.dir = k;
  }
  if (a.speed !== null && !(a.speed >= 0.25 && a.speed <= 16)) throw new Error('--speed must be between 0.25 and 16');
  if (!(a.maxSeconds > 0)) throw new Error('--max-seconds must be a positive number');
  return a;
}

function tool(name, args) {
  const r = spawnSync(name, args, { encoding: 'utf8' });
  if (r.error) return null;
  if (r.status !== 0) throw new Error(`${name} failed:\n${(r.stderr || '').split('\n').slice(-6).join('\n')}`);
  return r.stdout;
}

function requireFfmpeg() {
  if (tool('ffmpeg', ['-hide_banner', '-version']) !== null && tool('ffprobe', ['-hide_banner', '-version']) !== null) return;
  console.error([
    'ffmpeg was not found on PATH. Install it, open a new terminal and run this again:',
    '  Windows: winget install --id Gyan.FFmpeg -e',
    '  macOS:   brew install ffmpeg',
    '  Linux:   sudo apt install ffmpeg   (or your distribution\'s package manager)',
  ].join('\n'));
  process.exit(1);
}

function probe(file) {
  const out = tool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out);
  return { w: j.streams[0].width, h: j.streams[0].height, duration: Number(j.format.duration) || 0 };
}

// Colour of the top-left pixel, used for the padding so it blends with the screenshot.
function cornerColor(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'crop=1:1:0:0,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) return PAD_FALLBACK;
  return '0x' + [...r.stdout.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
const sec = (s) => s.toFixed(1) + ' s';

// demo-raw.mp4 -> demo.mp4 at the target length.
function makeVideo(dir, args) {
  const src = path.join(dir, 'demo-raw.mp4');
  const out = path.join(dir, 'demo.mp4');
  if (!fs.existsSync(src)) {
    console.log(`video  : skipped, demo-raw.mp4 not found${fs.existsSync(out) ? ' (using existing demo.mp4 for the GIF)' : ''}`);
    return;
  }
  const raw = probe(src);
  const speed = args.speed ?? Math.max(1, raw.duration / args.maxSeconds);
  const sped = raw.duration / speed;
  const cut = sped > args.maxSeconds + 0.05;
  const tmp = out + '.tmp.mp4';
  tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-vf', `setpts=PTS/${speed},fps=30,scale='min(1920,iw)':-2:flags=lanczos,format=yuv420p`,
    '-t', String(args.maxSeconds), '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-movflags', '+faststart', tmp]);
  fs.renameSync(tmp, out);
  const v = probe(out);
  console.log(`video  : demo-raw.mp4 ${sec(raw.duration)} -> demo.mp4 ${sec(v.duration)} at ${speed.toFixed(2)}x, ${v.w}x${v.h}, ${mb(fs.statSync(out).size)}` +
    (cut ? `\n         warning: ${sec(sped)} after speed-up, cut to ${args.maxSeconds} s (use a higher --speed or omit it for auto)` : ''));
}

function makeGif(dir) {
  const src = path.join(dir, 'demo.mp4');
  const out = path.join(dir, 'demo.gif');
  if (!fs.existsSync(src)) { console.log('gif    : skipped, demo.mp4 not found'); return; }
  const tmp = out + '.tmp.gif';
  for (const [fps, width] of GIF_ATTEMPTS) {
    const filter = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-filter_complex', filter, '-loop', '0', '-f', 'gif', tmp]);
    const bytes = fs.statSync(tmp).size;
    if (bytes <= GIF_MAX_BYTES || fps === GIF_ATTEMPTS[GIF_ATTEMPTS.length - 1][0]) {
      fs.renameSync(tmp, out);
      const { w, h, duration } = probe(out);
      console.log(`gif    : demo.gif ${w}x${h}, ${fps} fps, ${sec(duration)}, ${mb(bytes)}${bytes > GIF_MAX_BYTES ? ' (still large: consider a shorter clip)' : ''}`);
      return;
    }
  }
}

function fixScreenshots(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^screenshot-.*\.(png|jpe?g)$/i.test(f) && !f.includes('.tmp.'));
  if (!files.length) { console.log('shots  : no screenshot-*.png|jpg found'); return; }
  for (const f of files) {
    const src = path.join(dir, f);
    const out = path.join(dir, f.replace(/\.(png|jpe?g)$/i, '.png'));
    if (src !== out && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
      console.log(`shots  : ${f} skipped, ${path.basename(out)} is newer`);
      continue;
    }
    const { w, h } = probe(src);
    if (/\.png$/i.test(f) && w === SHOT_W && h === SHOT_H) { console.log(`shots  : ${f} already ${SHOT_W}x${SHOT_H}`); continue; }
    const tmp = out + '.tmp.png';
    const pad = cornerColor(src);
    const filter = `scale=${SHOT_W}:${SHOT_H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${SHOT_W}:${SHOT_H}:(ow-iw)/2:(oh-ih)/2:color=${pad}`;
    tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', filter, '-frames:v', '1', tmp]);
    fs.renameSync(tmp, out);
    console.log(`shots  : ${f} ${w}x${h} -> ${path.basename(out)} ${SHOT_W}x${SHOT_H}, padding #${pad.slice(2)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireFfmpeg();
  const dir = path.resolve(ROOT, args.dir);
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
  makeVideo(dir, args);
  makeGif(dir);
  fixScreenshots(dir);
}

try { main(); } catch (e) { console.error('error:', e.message); process.exit(1); }
