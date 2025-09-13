// server.js (CommonJS)
// FFmpeg encoder microservice for profanity muting/beeping.
// Exposes:
//  - GET  /health
//  - POST /encode      { sourceUrl|fileBase64, format, mode, segments[], returnInline }
//  - POST /jobs/clean  { input:{url}, output:{key}, format, profanityTimestamps[], callback }

const http = require('node:http');
const { spawn, exec } = require('node:child_process');
const { tmpdir } = require('node:os');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs').promises;
const fs = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const AWS = require('aws-sdk');

// ---- ENV ----
const ENCODER_TOKEN = process.env.ENCODER_TOKEN || '';
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_BUCKET   = process.env.R2_BUCKET || process.env.R2_BUCKET_NAME || '';
const R2_KEY      = process.env.R2_ACCESS_KEY || process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET   = process.env.R2_SECRET_KEY || process.env.R2_SECRET_ACCESS_KEY || '';

// Optional: add an admin token to include in callback requests back to the Worker
const CALLBACK_ADMIN_TOKEN = process.env.CALLBACK_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '';
// Optional: identify this encoder in callbacks/logs
const ENCODER_NAME = process.env.ENCODER_NAME || 'hetzner-cpx11';

// S3 client (optional, only used for /jobs/clean)
const s3 = (R2_ENDPOINT && R2_BUCKET && R2_KEY && R2_SECRET)
  ? new AWS.S3({
      endpoint: R2_ENDPOINT,
      accessKeyId: R2_KEY,
      secretAccessKey: R2_SECRET,
      s3ForcePathStyle: true,
      signatureVersion: 'v4',
      region: 'auto',
    })
  : null;

// Small fetch wrapper (Node 18+ has global fetch)
async function fetchToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
  });
  res.end(body);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-encoder-token, x-admin-api-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
}

function ffmpegExists() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function requireAuth(req) {
  if (!ENCODER_TOKEN) return true; // auth disabled
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const xTok = (req.headers['x-encoder-token'] || '').trim();
  const tok = auth || xTok;
  return tok && tok === ENCODER_TOKEN;
}

// Build an FFmpeg audio filter for muting or beeping between time ranges.
function buildAudioFilter(segments, mode) {
  if (!segments?.length) return null;

  // Normalize numeric times
  const ranges = segments
    .map(({ start, end }) => [Number(start), Number(end)])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);

  if (!ranges.length) return null;

  if (mode === 'beep') {
    const expr = ranges.map(([s, e]) => `between(t,${s},${e})`).join('+');
    const graph =
      `[0:a]anull[a0];` +
      `sine=f=1000:b=4:d=36000:sample_rate=48000,volume=0.5,` +
      `volume=enable='${expr}':volume=0.8[beepgated];` +
      `[a0][beepgated]amix=inputs=2:normalize=0[out]`;
    return { graph, map: '[out]' };
  }

  // Default mode: MUTE inside windows
  const expr = ranges.map(([s, e]) => `between(t,${s},${e})`).join('+');
  const graph = `volume=enable='${expr}':volume=0`;
  return { graph, map: null };
}

async function handleEncode(req, res) {
  if (!requireAuth(req)) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });

  try {
    // Parse JSON body
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    const {
      sourceUrl,           // http(s) URL to audio
      fileBase64,          // optional base64 audio if not using URL
      format = 'mp3',      // 'mp3' | 'wav' | 'aac' | etc.
      bitrate = '192k',    // used for mp3/aac
      mode = 'mute',       // 'mute' | 'beep'
      segments = [],       // [{start, end}, ...]
      returnInline = false // if true, Content-Type audio/* (no attachment)
    } = body || {};

    if (!await ffmpegExists()) {
      return sendJSON(res, 500, { ok: false, error: 'ffmpeg_not_found' });
    }

    if (!sourceUrl && !fileBase64) {
      return sendJSON(res, 400, { ok: false, error: 'Provide sourceUrl or fileBase64' });
    }
    if (!Array.isArray(segments)) {
      return sendJSON(res, 400, { ok: false, error: 'segments must be an array' });
    }

    // Temp workspace
    const work = await mkdtemp(join(tmpdir(), 'encode-'));
    const inPath  = join(work, 'in');
    const outPath = join(work, `out.${format}`);

    // Get input data
    const inputBuf = sourceUrl
      ? await fetchToBuffer(sourceUrl)
      : Buffer.from(fileBase64, 'base64');
    await writeFile(inPath, inputBuf);

    const filter = buildAudioFilter(segments, mode);
    const args = ['-y', '-i', inPath];

    if (filter) {
      if (filter.map) {
        args.push('-filter_complex', filter.graph, '-map', filter.map);
      } else {
        args.push('-af', filter.graph);
      }
    }

    if (format === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
    } else if (format === 'aac' || format === 'm4a') {
      args.push('-c:a', 'aac', '-b:a', bitrate);
    } else if (format === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    }

    args.push(outPath);

    const started = Date.now();
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args);
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('exit', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`)));
      p.on('error', reject);
    });

    const cleaned = await readFile(outPath);
    rm(work, { recursive: true, force: true }).catch(() => {});

    const filename = `cleaned_${randomUUID()}.${format}`;
    const type = format === 'wav' ? 'audio/wav'
               : format === 'mp3' ? 'audio/mpeg'
               : 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': returnInline ? type : 'application/octet-stream',
      'Content-Disposition': returnInline ? 'inline' : `attachment; filename="${filename}"`,
      'X-Encode-Duration-ms': String(Date.now() - started),
    });
    res.end(cleaned);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message || String(e) });
  }
}

async function handleJobClean(req, res) {
  if (!requireAuth(req)) return sendJSON(res, 401, { ok: false, error: 'unauthorized' });

  try {
    if (!s3) {
      return sendJSON(res, 400, { ok: false, error: 'R2/S3 not configured on encoder' });
    }

    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};

    // Normalize payload shape (supports both our Worker and earlier examples)
    const inputUrl = body.input?.url || body.inputUrl;
    const outputKey = body.output?.key || body.outputKey;
    const format = (body.format || 'wav').toLowerCase();
    const segments = Array.isArray(body.profanityTimestamps) ? body.profanityTimestamps : (body.segments || []);
    const callback = body.callback || body.callbackUrl;
    const processId = body.processId || body.jobId || null;

    if (!inputUrl || !outputKey) {
      return sendJSON(res, 400, { ok: false, error: 'missing input.url or output.key' });
    }

    // Temp workspace
    const work = await mkdtemp(join(tmpdir(), 'job-'));
    const inPath  = join(work, 'in');
    const outPath = join(work, `out.${format}`);

    const inputBuf = await fetchToBuffer(inputUrl);
    await writeFile(inPath, inputBuf);

    const filter = buildAudioFilter(segments, body.mode || 'mute');
    const args = ['-y', '-i', inPath];
    if (filter) {
      if (filter.map) {
        args.push('-filter_complex', filter.graph, '-map', filter.map);
      } else {
        args.push('-af', filter.graph);
      }
    }

    if (format === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '192k');
    } else if (format === 'aac' || format === 'm4a') {
      args.push('-c:a', 'aac', '-b:a', '192k');
    } else if (format === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    }

    args.push(outPath);

    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args);
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('exit', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`)));
      p.on('error', reject);
    });

    // Upload to R2
    const bodyStream = fs.createReadStream(outPath);
    await s3.upload({ Bucket: R2_BUCKET, Key: outputKey, Body: bodyStream }).promise();

    // Cleanup
    rm(work, { recursive: true, force: true }).catch(() => {});

    // Callback Worker if provided
    if (callback) {
      try {
        const cbHeaders = { 'Content-Type': 'application/json' };
        if (CALLBACK_ADMIN_TOKEN) cbHeaders['x-admin-api-token'] = CALLBACK_ADMIN_TOKEN;
        await fetch(callback, {
          method: 'POST',
          headers: cbHeaders,
          body: JSON.stringify({ ok: true, outputKey, encoder: ENCODER_NAME, processId: processId || undefined })
        });
      } catch (_) {}
    }

    return sendJSON(res, 200, { ok: true, outputKey });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message || String(e) });
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health
  if (req.method === 'GET' && req.url && req.url.startsWith('/health')) {
    const ff = await ffmpegExists().catch(() => false);
    return sendJSON(res, 200, { ok: true, ffmpeg: !!ff, s3: !!s3 });
  }

  // Synchronous encode (returns file bytes)
  if (req.method === 'POST' && req.url === '/encode') {
    return handleEncode(req, res);
  }

  // Async job: read input from URL, upload to R2, call back
  if (req.method === 'POST' && req.url === '/jobs/clean') {
    return handleJobClean(req, res);
  }

  sendJSON(res, 404, { error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Encoder listening on 0.0.0.0:${PORT}`));
