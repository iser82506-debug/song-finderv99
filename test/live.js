// Real end-to-end check against the live AcoustID + MusicBrainz services (needs internet, fpcalc and a key).
// Usage: ACOUSTID_CLIENT_KEY=xxx node test/live.js path/to/song.mp3
const fs = require("fs");
const { server } = require("../server.js");
const f = process.argv[2];
if (!f) { console.error("Usage: node test/live.js <audio file>"); process.exit(1); }
server.listen(0, async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/recognize`, { method: "POST", body: fs.readFileSync(f) });
  console.log(r.status, JSON.stringify(await r.json(), null, 2)); server.close();
});
