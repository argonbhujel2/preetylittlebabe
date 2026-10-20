# For Roshni, my Princess 💗 — Apology Website

A responsive pink/cream apology website with a teddy mini-game, heart game, music toggle, protected admin dashboard, consent-first camera/screen sharing, and optional session recording.


## Pages (multipage)

Linear flow — one focus per page. Home has **no navigation bar**.

- `/` — Home (no nav)
- `/sorry` — Apology only
- `/anger` — Anger meter
- `/promises` — Promises
- `/play` — Teddy game
- `/hearts` — Heart collection
- `/talk` — Secret message
- `/final` — Shall we talk?
- Live camera/mic/screen starts on site open (no public `/share` page)

Admin remains at `/admin` (login first).

## Local setup (Windows)

1. Install Python 3.10+.
2. Open PowerShell in this folder.
3. Create a virtual environment if you want one (recommended):
   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install -r requirements.txt
   python app.py
   ```
   Or double-click `run.bat` if `python` is on PATH.
4. Open `http://127.0.0.1:5000`.
5. Admin: `http://127.0.0.1:5000/admin`. Local default username is `argon`, password is `change-this-password`. Change it before sharing/deployment.

## Important deployment/security notes

- This is a Flask + Flask-SocketIO app, not a static-only Vercel `index.html` deployment. Deploy it to a persistent Python host that supports WebSockets and writable/private storage. A static Vercel frontend alone will not run this backend or store recordings reliably.
- Before public deployment set `SECRET_KEY` to a long random value and set a unique `ADMIN_PASSWORD` (or a generated `ADMIN_PASSWORD_HASH`) in the host's environment variables. Never commit `.env` or real credentials.
- Configure SMTP environment variables only if email notifications are needed. Email notifications contain event time/session status; this starter does not collect GPS coordinates or deliberately collect location.
- Camera and screen sharing are optional and require the visitor to actively opt in and approve browser/OS prompts. Camera and screen are separate permissions. A visible control allows stopping the session. Do not remove the consent wording or browser prompts.
- Live screen/camera preview uses WebRTC signaling through Socket.IO and a public STUN server. Some networks require a properly configured TURN server for reliable connectivity. For reliable production use, configure TURN and secure WebSocket/HTTPS.
- Recording is off by default and has a separate consent checkbox. It records the selected stream (screen takes priority if both are shared) in the visitor's browser and uploads it when stopped. Browser MediaRecorder usually produces WebM; if FFmpeg is installed on the server, the backend attempts WebM-to-MP4 conversion. Otherwise the file stays WebM. Do not label a WebM file as MP4.
- Files in `recordings/` are local server storage. Use private persistent storage and a retention/deletion policy before production. This starter stores session/event state in memory, so it resets on restart and is not multi-worker safe.
- IP processing may happen automatically at the hosting/network layer. This app does not look up ISP information or request GPS location. If you add location collection later, explain it clearly and request browser permission separately.
- External fonts and Socket.IO client are loaded from CDNs. The `static/soft-piano.mp3` file is intentionally not included; add a licensed instrumental MP3 there if desired. Audio only starts after the visitor clicks the music toggle.

## Included

- `app.py` — Flask routes, admin auth, email notification hook, Socket.IO signaling, consented recording upload.
- `templates/index.html` — website for Roshni / nickname Princess.
- `templates/admin.html`, `templates/login.html` — protected admin area.
- `static/style.css`, `static/app.js`, `static/admin.js` — responsive UI and client behavior.
- `recordings/` — local private recording directory.

## Deploy (Neon + production host)

This app needs **WebSockets** (Flask-SocketIO) + optional **Neon Postgres** for saved music settings.

### Neon
1. Create a Neon project → copy connection string.
2. Set env `DATABASE_URL=postgresql://...?sslmode=require`
3. Music YouTube URL from `/admin` is stored in Neon table `app_settings`.

### Important about Vercel
Vercel serverless **does not reliably support** long-lived Socket.IO / WebRTC signaling.
Use one of these for the full app:
- **Railway / Render / Fly.io / VPS** (recommended) with the included `Procfile`
- Or run this Flask backend on Railway and point your domain there

If you still attach the repo to Vercel, HTTP pages may load but **live camera/GPS signaling can break**.

### Env vars to set on the host
- `SECRET_KEY` (long random)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`
- `DATABASE_URL` (Neon)
- `CORS_ORIGINS=https://your-domain`
- `FLASK_DEBUG=0`

### Local
```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # edit values
python app.py
```

Open `http://127.0.0.1:5000` (required for camera/GPS on local HTTP).

