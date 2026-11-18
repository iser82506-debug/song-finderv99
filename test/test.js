"use strict";
// Offline pipeline tests. Real FFmpeg decoding + real Chromaprint fingerprints; AcoustID/MusicBrainz are
// replaced by a local stub ONLY here (ACOUSTID_URL / MUSICBRAINZ_URL are test hooks, unset in production).
// Verifying real AcoustID answers needs internet: run `node test/live.js file.mp3` (see README).
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { execFileSync } = require("child_process");
process.env.ACOUSTID_CLIENT_KEY = "test-key";
process.env.RATE_LIMIT_PER_MIN = "1000";
process.env.ALLOW_FFMPEG_CHROMAPRINT = process.env.ALLOW_FFMPEG_CHROMAPRINT || "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sf-test-"));
let lastReq = null, mode = "match";

const stub = http.createServer((req, res) => {
  const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
    if (req.url.startsWith("/mb/recording/")) { res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ "first-release-date": "1999-01-01", length: 200000, genres: [{ name: "pop", count: 2 }] })); }
    let raw = Buffer.concat(chunks); if (req.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw);
    lastReq = Object.fromEntries(new URLSearchParams(raw.toString()));
    if (mode === "ratelimit") { res.statusCode = 429; return res.end("{}"); }
    res.setHeader("Content-Type", "application/json");
    if (mode === "none") return res.end(JSON.stringify({ status: "ok", results: [] }));
    if (mode === "weak") return res.end(JSON.stringify({ status: "ok", results: [{ id: "a", score: 0.3, recordings: [{ id: "r", title: "Weak" }] }] }));
    if (mode === "possible") return res.end(JSON.stringify({ status: "ok", results: [{ id: "a", score: 0.6, recordings: [{ id: "r", title: "Maybe", artists: [{ name: "X" }] }] }] }));
    res.end(JSON.stringify({ status: "ok", results: [
      { id: "b", score: 0.7, recordings: [{ id: "r2", title: "Lower", artists: [{ name: "Z" }] }] },
      { id: "a", score: 0.97, recordings: [{ id: "r1", title: "Song", artists: [{ name: "Art", joinphrase: " & " }, { name: "Ist" }],
        releasegroups: [{ id: "rg1", title: "Album", type: "Album" }] }] }] }));
  });
});

const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + extra)); };

(async () => {
  await new Promise(r => stub.listen(0, r));
  process.env.ACOUSTID_URL = `http://127.0.0.1:${stub.address().port}/lookup`;
  process.env.MUSICBRAINZ_URL = `http://127.0.0.1:${stub.address().port}/mb`;
  const { server } = require("../server.js");
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (buf, type = "application/octet-stream") => {
    const r = await fetch(base + "/recognize", { method: "POST", headers: { "Content-Type": type }, body: buf });
    return { status: r.status, j: await r.json() };
  };

  const music = ["-f", "lavfi", "-i", "aevalsrc=0.4*sin(2*PI*(200+80*sin(2*PI*0.5*t))*t)+0.3*sin(2*PI*(440+150*sin(2*PI*0.3*t))*t):s=44100:d=25"];
  const files = { mp3: "a.mp3", wav: "a.wav", m4a: "a.m4a", ogg: "a.ogg", webm: "a.webm" };
  ff(...music, path.join(tmp, "a.mp3")); ff(...music, path.join(tmp, "a.wav")); ff(...music, "-c:a", "aac", path.join(tmp, "a.m4a"));
  ff(...music, "-c:a", "libvorbis", path.join(tmp, "a.ogg")); ff(...music, "-c:a", "libopus", path.join(tmp, "a.webm"));
  ff(...music, "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=25", "-c:a", "aac", "-c:v", "libx264", "-shortest", path.join(tmp, "a.mp4"));

  mode = "match";
  for (const [k, f] of [["mp3","a.mp3"],["wav","a.wav"],["m4a","a.m4a"],["ogg","a.ogg"],["webm (mic format)","a.webm"],["mp4 with video","a.mp4"]]) {
    const { status, j } = await post(fs.readFileSync(path.join(tmp, f)));
    ok(`${k}: fingerprint + lookup + parse`, status === 200 && j.status === "ok" && j.match.title === "Song" && j.match.artist === "Art & Ist"
      && j.match.confirmed && j.match.artworkUrl.includes("rg1") && j.match.musicbrainz.releaseDate === "1999-01-01", JSON.stringify(j));
    ok(`${k}: sent client/duration/meta/fingerprint`, lastReq.client === "test-key" && Number(lastReq.duration) >= 24 && Number(lastReq.duration) <= 26
      && lastReq.meta === "recordings+releasegroups+releases+tracks+compress" && lastReq.fingerprint.length > 100, JSON.stringify(lastReq).slice(0, 200));
  }
  { const { j } = await post(fs.readFileSync(path.join(tmp, "a.mp3")));
    ok("sorted by score, weaker one is an alternative", j.match.score === 0.97 && j.alternatives[0].title === "Lower"); }
  mode = "possible"; { const { j } = await post(fs.readFileSync(path.join(tmp, "a.wav")));
    ok("0.6 score = possible, not confirmed", j.status === "ok" && j.match.confirmed === false); }
  mode = "weak"; { const { j } = await post(fs.readFileSync(path.join(tmp, "a.wav")));
    ok("weak (0.3) match not shown", j.status === "no_match"); }
  mode = "none"; { const { j } = await post(fs.readFileSync(path.join(tmp, "a.wav")));
    ok("unknown song -> no_match", j.status === "no_match"); }
  mode = "ratelimit"; { const { status, j } = await post(fs.readFileSync(path.join(tmp, "a.wav")));
    ok("AcoustID 429 -> rate_limited", status === 429 && j.code === "rate_limited"); }
  mode = "match";
  ff("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "10", path.join(tmp, "s.wav"));
  { const { status, j } = await post(fs.readFileSync(path.join(tmp, "s.wav")));
    console.log("  (silence ->", status, j.status, j.code || "", ")");
    ok("silence -> silence error, no lookup", status === 422 && j.code === "silence", JSON.stringify(j)); }
  { const { status, j } = await post(Buffer.alloc(50000, 7));
    ok("invalid audio -> unsupported_audio", status === 415 && j.code === "unsupported_audio", JSON.stringify(j)); }
  { const { status, j } = await post(Buffer.alloc(10));
    ok("empty upload -> no_audio", status === 400 && j.code === "no_audio"); }
  ff(...music.slice(0, 2), "-f", "lavfi", "-i", "anullsrc", "-t", "1", path.join(tmp, "short.wav"));
  { const { status, j } = await post(fs.readFileSync(path.join(tmp, "short.wav")));
    ok("too-short audio rejected", status >= 400 && j.status === "error", JSON.stringify(j)); }
  process.env.ACOUSTID_URL = "http://127.0.0.1:1/x";
  { const { status, j } = await post(fs.readFileSync(path.join(tmp, "a.wav")));
    ok("network failure -> network error", status === 502 && j.code === "network", JSON.stringify(j)); }
  { const r = await fetch(base + "/health"); const j = await r.json(); console.log("  health:", JSON.stringify(j)); ok("health endpoint", j.ok && j.ffmpeg); }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); stub.close(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
