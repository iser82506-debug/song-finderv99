# Taher Song Finder: one service on Render

Website + recognition backend in one Docker service (FFmpeg + Chromaprint `fpcalc` → AcoustID → MusicBrainz → Cover Art Archive).
No Netlify, no separate config.

## Deploy
1. Put these files in a GitHub repo (unzip, upload to a new repo; Render deploys from Git).
2. Render → New → **Blueprint** → pick the repo (it reads `render.yaml`). Or New → Web Service → Runtime **Docker**.
3. Set `ACOUSTID_CLIENT_KEY` (get one at https://acoustid.org/new-application) and `MB_CONTACT` (your email).
4. Open the `https://….onrender.com` URL. Check `/health`: everything should be `true`.

Free instances sleep when idle; the first request can take ~30 s.

Limits: score ≥ 0.85 = confirmed, 0.50–0.85 = possible, below = no match. AcoustID matches whole tracks, so short noisy
microphone clips often fail and many songs are not in its database; uploading a clean file works best.
Tests: `npm test` (offline, stubbed AcoustID). Live check: `ACOUSTID_CLIENT_KEY=... node test/live.js song.mp3`.
