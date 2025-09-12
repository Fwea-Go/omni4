// server.js
// Minimal FFmpeg encoder service for profanity muting/beeping.
// Node 20+, ffmpeg installed in the container.

import http from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Small fetch wrapper (Node 20 has global fetch)
async function fetchToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
}

function ffmpegExists() {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

// Build an FFmpeg audio filter for muting or beeping between time ranges.
function buildAudioFilter(segments, mode) {
  if (!segments?.length) return null;

  // Normalize numeric times
  const ranges = segments
    .map(({ start, end }) => [Number(start), Number(end)])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);

  if (!ranges.length) return null;

  if (mode === "beep") {
    // Generate sine beep and duck original between windows, then mix.
    // 1) Generate tone: asine produces a 1kHz tone at -6dB
    // 2) Use volume enable to only pass tone during ranges, otherwise silence
    // 3) Sidechaincompress to duck original when tone present (or just mix over it)
    // We'll gate the tone with 'aselect' on time ranges and amix.
    const expr = ranges.map(([s, e]) => `between(t,${s},${e})`).join("+");
    // Filtergraph:
    // [0:a]anull[a0]; sine -> [beep]; [beep]volume=enable='expr':1:volume=0.5[beepgated];
    // [a0][beepgated]amix=inputs=2:normalize=0[out]
    const graph =
      `[0:a]anull[a0];` +
      `sine=f=1000:b=4:d=36000:sample_rate=48000,volume=0.5,` +
      `volume=enable='${expr}':volume=0.8[beepgated];` +
      `[a0][beepgated]amix=inputs=2:normalize=0[out]`;
    return { graph, map: "[out]" };
  }

  // Default mode: MUTE (set volume to 0 only within windows)
  // volume=enable='between(t,s1,e1)+between(t,s2,e2)':volume=0
  const expr = ranges.map(([s, e]) => `between(t,${s},${e})`).join("+");
  const graph = `volume=enable='${expr}':volume=0`;
  return { graph, map: null };
}

async function handleEncode(req, res) {
  try {
    // Parse JSON body
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    const {
      sourceUrl,           // http(s) URL to audio
      fileBase64,          // optional base64 audio if not using URL
      format = "mp3",      // "mp3" | "wav" | "aac" | etc.
      mode = "mute",       // "mute" | "beep"
      segments = [],       // [{start: number, end: number}, ...]
      returnInline = false // if true, Content-Type audio/* (no attachment)
    } = body || {};

    if (!await ffmpegExists()) {
      return sendJSON(res, 500, { ok: false, error: "ffmpeg_not_found" });
    }

    if (!sourceUrl && !fileBase64) {
      return sendJSON(res, 400, { ok: false, error: "Provide sourceUrl or fileBase64" });
    }
    if (!Array.isArray(segments)) {
      return sendJSON(res, 400, { ok: false, error: "segments must be an array" });
    }

    // Temp workspace
    const work = await mkdtemp(join(tmpdir(), "encode-"));
    const inPath  = join(work, "in");
    const outPath = join(work, `out.${format}`);

    // Get input data
    const inputBuf = sourceUrl
      ? await fetchToBuffer(sourceUrl)
      : Buffer.from(fileBase64, "base64");
    await writeFile(inPath, inputBuf);

    const filter = buildAudioFilter(segments, mode);
    const args = ["-y", "-i", inPath];

    if (filter) {
      // If we created a complex graph with labeled output, use -filter_complex and -map
      if (filter.map) {
        args.push("-filter_complex", filter.graph, "-map", filter.map);
      } else {
        args.push("-af", filter.graph);
      }
    }

    // Reasonable defaults for mp3
    if (format === "mp3") {
      args.push("-c:a", "libmp3lame", "-b:a", "192k");
    } else if (format === "aac" || format === "m4a") {
      args.push("-c:a", "aac", "-b:a", "192k");
    } else if (format === "wav") {
      args.push("-c:a", "pcm_s16le");
    }

    args.push(outPath);

    const started = Date.now();
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args);
      let err = "";
      p.stderr.on("data", d => { err += d.toString(); });
      p.on("exit", code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`)));
      p.on("error", reject);
    });

    const cleaned = await readFile(outPath);
    // Clean up async (no await so response is fast)
    rm(work, { recursive: true, force: true }).catch(() => {});

    const filename = `cleaned_${randomUUID()}.${format}`;
    const type = format === "wav" ? "audio/wav"
               : format === "mp3" ? "audio/mpeg"
               : "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": returnInline ? type : "application/octet-stream",
      "Content-Disposition": returnInline ? "inline" : `attachment; filename="${filename}"`,
      "X-Encode-Duration-ms": String(Date.now() - started),
    });
    res.end(cleaned);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message || String(e) });
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204); return res.end();
  }

  if (req.method === "GET" && req.url?.startsWith("/health")) {
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/encode") {
    return handleEncode(req, res);
  }

  sendJSON(res, 404, { error: "not_found" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Encoder listening on :${PORT}`));
