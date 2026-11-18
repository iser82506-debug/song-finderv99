"use strict";
/*
 * Taher Song Finder backend: audio -> FFmpeg decode -> Chromaprint (fpcalc) -> AcoustID -> MusicBrainz / Cover Art Archive.
 * No npm dependencies. Needs `ffmpeg`, `ffprobe` and `fpcalc` on PATH (see Dockerfile).
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PORT = process.env.PORT || 8080;
const MAX_BYTES = 60 * 1024 * 1024;
const MAX_FP_SECONDS = 120;          // Chromaprint's standard analysis length
const MIN_AUDIO_SECONDS = 3;
const CONFIRMED = 0.85;              // score >= this: shown as a confirmed match
const POSSIBLE = 0.5;                // score >= this: shown as "possible match"; below: discarded
const ALLOWED = (process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const UA = `TaherSongFinder/2.0 ( ${process.env.MB_CONTACT || "no-contact-configured"} )`;

/* ---------- rate limiting ---------- */
// Global spacing between outgoing calls: AcoustID max 3 req/s, MusicBrainz max 1 req/s.
function makeSpacer(ms) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + ms;
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  };
}
const waitAcoustId = makeSpacer(340);
const waitMusicBrainz = makeSpacer(1100);

// Per-visitor limit on this API itself.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60_000, max = Number(process.env.RATE_LIMIT_PER_MIN || 12);
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < win)) hits.delete(k);
  return arr.length > max;
}

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

function run(cmd, args, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", d => { out += d; if (out.length > 5e6) p.kill("SIGKILL"); });
    p.stderr.on("data", d => { err += d; if (err.length > 5e6) err = err.slice(-1e5); });
    p.on("error", e => { clearTimeout(t); reject(e); });
    p.on("close", code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

const have = {};
async function hasBin(name) {
  if (name in have) return have[name];
  try { const r = await run(name, [name === "fpcalc" ? "-version" : "-version"], { timeout: 10_000 }); have[name] = r.code === 0; }
  catch { have[name] = false; }
  return have[name];
}

function send(res, status, obj, origin) {
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (origin) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; }
  res.writeHead(status, h);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BYTES) return reject(new HttpError(413, "too_large", "File is larger than the 60 MB limit."));
    const chunks = []; let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BYTES) { reject(new HttpError(413, "too_large", "File is larger than the 60 MB limit.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ---------- audio -> fingerprint ---------- */
async function probeDuration(file) {
  const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeout: 30_000 });
  const d = parseFloat(r.out);
  return r.code === 0 && isFinite(d) && d > 0 ? d : null;
}

async function fingerprint(inputFile, dir) {
  // 1. Decode whatever we were given (mp3/wav/m4a/ogg/webm/mp4...) to mono 16-bit PCM WAV.
  const wav = path.join(dir, "decoded.wav");
  const dec = await run("ffmpeg", ["-v", "error", "-y", "-i", inputFile, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "44100",
    "-t", String(MAX_FP_SECONDS), "-c:a", "pcm_s16le", wav]);
  if (dec.code !== 0 || !fs.existsSync(wav) || fs.statSync(wav).size < 1000)
    throw new HttpError(415, "unsupported_audio", "This file could not be read as audio. Try MP3, WAV, M4A, OGG, WebM or MP4.");

  // Silence check (peak level below about -50 dB means there is nothing to identify).
  const vol = await run("ffmpeg", ["-v", "info", "-i", wav, "-af", "volumedetect", "-f", "null", "-"]);
  const mv = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(vol.err);
  if (mv && (mv[1] === "-inf" || parseFloat(mv[1]) < -50))
    throw new HttpError(422, "silence", "No sound was detected. Check your microphone and play the music louder.");

  // 2. Chromaprint fingerprint.
  let fp, fpDuration;
  if (await hasBin("fpcalc")) {
    const r = await run("fpcalc", ["-json", "-length", String(MAX_FP_SECONDS), wav]);
    if (r.code !== 0) throw new HttpError(422, "empty_fingerprint", "Could not generate a fingerprint from this audio.");
    try { const j = JSON.parse(r.out); fp = j.fingerprint; fpDuration = Number(j.duration); } catch { /* fallthrough */ }
  } else if (process.env.ALLOW_FFMPEG_CHROMAPRINT === "1") {
    // Dev-only fallback: FFmpeg's built-in chromaprint muxer produces the same fingerprint format.
    const r = await run("ffmpeg", ["-v", "error", "-i", wav, "-f", "chromaprint", "-fp_format", "base64", "-"]);
    if (r.code === 0) { fp = r.out.trim(); fpDuration = (await probeDuration(wav)) || 0; }
  } else {
    throw new HttpError(500, "server_misconfigured", "Server is missing the fpcalc (Chromaprint) binary.");
  }
  if (!fp || fp.length < 20) throw new HttpError(422, "empty_fingerprint", "No usable audio fingerprint (the clip may be silent or too short).");
  if (!(fpDuration >= MIN_AUDIO_SECONDS)) throw new HttpError(422, "too_short", "The audio is too short to identify.");

  // 3. Duration: use the real length of the original file when known (needed for full-track lookups);
  //    recorded clips often have no duration header, so fall back to the decoded length.
  const full = await probeDuration(inputFile);
  const duration = Math.round(full && full >= fpDuration ? full : fpDuration);
  return { fingerprint: fp, duration, analysed: Math.round(fpDuration) };
}

/* ---------- AcoustID ---------- */
async function acoustidLookup(fp, duration) {
  const key = process.env.ACOUSTID_CLIENT_KEY;
  if (!key) throw new HttpError(500, "server_misconfigured", "ACOUSTID_CLIENT_KEY is not set on the server.");
  await waitAcoustId();
  const body = zlib.gzipSync(new URLSearchParams({
    client: key, fingerprint: fp, duration: String(duration),
    meta: "recordings+releasegroups+releases+tracks+compress", format: "json"
  }).toString());
  let res;
  try {
    res = await fetch((process.env.ACOUSTID_URL || "https://api.acoustid.org/v2/lookup"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Encoding": "gzip", "User-Agent": UA },
      body, signal: AbortSignal.timeout(20_000)
    });
  } catch { throw new HttpError(502, "network", "Could not reach the AcoustID service."); }
  if (res.status === 429) throw new HttpError(429, "rate_limited", "AcoustID is busy. Please try again in a moment.");
  let j = null; try { j = await res.json(); } catch { /* ignore */ }
  if (!j || j.status !== "ok") {
    const msg = j?.error?.message || `AcoustID returned HTTP ${res.status}.`;
    throw new HttpError(res.status === 400 ? 400 : 502, "acoustid_error", "AcoustID error: " + msg);
  }
  return j;
}

function parseMatches(j) {
  const out = [];
  for (const r of j.results || []) {
    for (const rec of r.recordings || []) {
      if (!rec.title) continue;
      const rgs = rec.releasegroups || [];
      // Prefer an album release group; otherwise the first one.
      const rg = rgs.find(g => g.type === "Album" && !(g.secondarytypes || []).length) || rgs.find(g => g.type === "Album") || rgs[0];
      out.push({
        score: r.score, acoustid: r.id, mbid: rec.id,
        title: rec.title,
        artist: (rec.artists || []).map(a => a.name + (a.joinphrase || "")).join("").trim() || null,
        album: rg?.title || null,
        releaseGroupId: rg?.id || null,
        artworkUrl: rg?.id ? `https://coverartarchive.org/release-group/${rg.id}/front-500` : null
      });
    }
  }
  // sort by score, then prefer entries that have artist/album info
  out.sort((a, b) => b.score - a.score || (!!b.album - !!a.album));
  const seen = new Set();
  return out.filter(m => { const k = m.mbid; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ---------- MusicBrainz ---------- */
async function musicbrainz(mbid) {
  try {
    await waitMusicBrainz();
    const res = await fetch(`${process.env.MUSICBRAINZ_URL || "https://musicbrainz.org/ws/2"}/recording/${encodeURIComponent(mbid)}?inc=artists+releases+genres&fmt=json`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      url: `https://musicbrainz.org/recording/${mbid}`,
      releaseDate: j["first-release-date"] || null,
      length: j.length ? Math.round(j.length / 1000) : null,
      genres: (j.genres || []).sort((a, b) => b.count - a.count).slice(0, 4).map(g => g.name)
    };
  } catch { return null; }   // MusicBrainz is enrichment only; never fail a recognition because of it
}

/* ---------- request handler ---------- */
async function recognize(req, res, origin) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) throw new HttpError(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
  const body = await readBody(req);
  if (body.length < 1000) throw new HttpError(400, "no_audio", "No audio was received.");

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sf-"));
  try {
    const input = path.join(dir, "input.bin");
    await fs.promises.writeFile(input, body);
    const fp = await fingerprint(input, dir);
    const j = await acoustidLookup(fp.fingerprint, fp.duration);
    const all = parseMatches(j).filter(m => m.score >= POSSIBLE);
    if (!all.length) return send(res, 200, { status: "no_match", message: "No match found in the AcoustID database.", duration: fp.duration }, origin);

    const best = all[0];
    best.confirmed = best.score >= CONFIRMED;
    best.musicbrainz = await musicbrainz(best.mbid);
    const alternatives = all.slice(1, 5).map(m => ({ ...m, confirmed: false }));
    send(res, 200, {
      status: "ok", match: best, alternatives,
      multiple: alternatives.some(a => a.score >= best.score - 0.05),
      duration: fp.duration, analysedSeconds: fp.analysed
    }, origin);
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const reqOrigin = req.headers.origin;
  const originOk = !ALLOWED.length || ALLOWED.includes("*") || ALLOWED.includes(reqOrigin);
  const origin = originOk ? (ALLOWED.includes("*") || !ALLOWED.length ? "*" : reqOrigin) : null;
  const url = (req.url || "").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" });
    return res.end();
  }
  if (url === "/health") {
    return send(res, 200, { ok: true, fpcalc: await hasBin("fpcalc"), ffmpeg: await hasBin("ffmpeg"), ffprobe: await hasBin("ffprobe"),
      acoustidKeyConfigured: !!process.env.ACOUSTID_CLIENT_KEY }, origin);
  }
  if (url === "/recognize" && req.method === "POST") {
    if (!originOk) return send(res, 403, { status: "error", code: "forbidden", message: "Origin not allowed." }, null);
    try { await recognize(req, res, origin); }
    catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) return;
      const he = e instanceof HttpError ? e : new HttpError(500, "server_error", "Unexpected server error.");
      send(res, he.status, { status: "error", code: he.code, message: he.message }, origin);
    }
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {          // serve the website itself
    const rel = url === "/" ? "/index.html" : decodeURIComponent(url);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (file.startsWith(PUBLIC + path.sep)) {
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile()) { res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); return fs.createReadStream(file).pipe(res); }
      } catch { /* fall through to 404 */ }
    }
  }
  send(res, 404, { status: "error", code: "not_found", message: "Not found." }, origin);
});

if (require.main === module) server.listen(PORT, () => console.log("Taher Song Finder backend on :" + PORT));
module.exports = { server, parseMatches, fingerprint, CONFIRMED, POSSIBLE };
