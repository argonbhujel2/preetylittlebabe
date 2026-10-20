import os, uuid, secrets, smtplib, mimetypes, json
from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from functools import wraps
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, send_from_directory, abort
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import check_password_hash
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent

def _is_vercel():
    return bool(os.getenv('VERCEL') or os.getenv('VERCEL_ENV'))

def _writable_base():
    """Vercel/serverless filesystem is read-only except /tmp."""
    if _is_vercel() or os.getenv('USE_TMP_STORAGE') == '1':
        return Path('/tmp') / 'gf_apology'
    return ROOT

def safe_mkdir(path: Path) -> Path:
    try:
        path.mkdir(parents=True, exist_ok=True)
        return path
    except OSError:
        fallback = Path('/tmp') / 'gf_apology' / path.name
        try:
            fallback.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        return fallback

BASE = _writable_base()
RECORDINGS = safe_mkdir(BASE / 'recordings')
DATA_DIR = safe_mkdir(BASE / 'data')
SETTINGS_PATH = DATA_DIR / 'settings.json'

app = Flask(__name__)

app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-change-before-deploy')
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024
socketio = SocketIO(app, cors_allowed_origins=os.getenv('CORS_ORIGINS', '*'), async_mode='threading')

ADMIN_USERNAME = os.getenv('ADMIN_USERNAME', 'argon')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'change-this-password')
ADMIN_PASSWORD_HASH = os.getenv('ADMIN_PASSWORD_HASH', '')
EMAIL_TO = os.getenv('NOTIFY_EMAIL_TO', '')
EMAIL_FROM = os.getenv('SMTP_FROM', '')
SMTP_HOST = os.getenv('SMTP_HOST', '')
SMTP_PORT = int(os.getenv('SMTP_PORT', '587'))
SMTP_USER = os.getenv('SMTP_USER', '')
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD', '')

active_sessions = {}
events = []

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def record_event(kind, sid=None, detail=None):
    event = {'id': str(uuid.uuid4()), 'type': kind, 'session_id': sid, 'time': now(), 'detail': detail or {}}
    events.insert(0, event)
    del events[300:]
    notify_email(event)
    return event

def notify_email(event):
    if not all([EMAIL_TO, EMAIL_FROM, SMTP_HOST, SMTP_USER, SMTP_PASSWORD]):
        return
    try:
        msg = EmailMessage()
        msg['Subject'] = f"Princess apology site: {event['type']}"
        msg['From'] = EMAIL_FROM
        msg['To'] = EMAIL_TO
        # Only event/session status is emailed. No location or personal data is collected by default.
        msg.set_content(f"Event: {event['type']}\nTime (UTC): {event['time']}\nSession: {event.get('session_id') or 'N/A'}\nDetails: {event.get('detail', {})}\n\nThis notification contains only disclosed, consent-based session status.")
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as smtp:
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(msg)
    except Exception as exc:
        app.logger.warning('Email notification failed: %s', exc)



def _db_url():
    return (os.getenv('DATABASE_URL') or os.getenv('NEON_DATABASE_URL') or '').strip()

def _pg_conn():
    url = _db_url()
    if not url:
        return None
    try:
        import psycopg2
        return psycopg2.connect(url, connect_timeout=8)
    except Exception as exc:
        app.logger.warning('Neon/Postgres connect failed: %s', exc)
        return None

def _ensure_db(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS live_sessions (
                id TEXT PRIMARY KEY,
                data JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS signal_queue (
                id BIGSERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS signal_queue_session_idx
                ON signal_queue (session_id, id);
            CREATE TABLE IF NOT EXISTS live_frames (
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                image TEXT NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (session_id, kind)
            );
        """)
    conn.commit()

def load_settings():
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM app_settings WHERE key = %s", ('youtube_url',))
                row = cur.fetchone()
            conn.close()
            return {'youtube_url': (row[0] if row else '') or ''}
        except Exception as exc:
            app.logger.warning('load_settings db error: %s', exc)
            try:
                conn.close()
            except Exception:
                pass
    try:
        if SETTINGS_PATH.is_file():
            return json.loads(SETTINGS_PATH.read_text(encoding='utf-8'))
    except Exception:
        pass
    return {'youtube_url': ''}

def save_settings(data):
    current = load_settings()
    current.update(data or {})
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO app_settings (key, value, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                    """,
                    ('youtube_url', current.get('youtube_url') or '')
                )
            conn.commit()
            conn.close()
            return current
        except Exception as exc:
            app.logger.warning('save_settings db error: %s', exc)
            try:
                conn.close()
            except Exception:
                pass
    safe_mkdir(SETTINGS_PATH.parent)
    try:
        SETTINGS_PATH.write_text(json.dumps(current, indent=2), encoding='utf-8')
    except OSError as exc:
        app.logger.warning('settings file write failed (use DATABASE_URL/Neon): %s', exc)
    return current

def _session_put(sid, data):
    active_sessions[sid] = data
    conn = _pg_conn()
    if conn is None:
        return
    try:
        _ensure_db(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO live_sessions (id, data, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
                """,
                (sid, json.dumps(data))
            )
        conn.commit()
        conn.close()
    except Exception as exc:
        app.logger.warning('session put failed: %s', exc)
        try:
            conn.close()
        except Exception:
            pass

def _session_get(sid):
    if sid in active_sessions:
        return active_sessions[sid]
    conn = _pg_conn()
    if conn is None:
        return None
    try:
        _ensure_db(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM live_sessions WHERE id = %s", (sid,))
            row = cur.fetchone()
        conn.close()
        if not row:
            return None
        data = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        active_sessions[sid] = data
        return data
    except Exception as exc:
        app.logger.warning('session get failed: %s', exc)
        try:
            conn.close()
        except Exception:
            pass
        return None

def _sessions_list(include_ended=False):
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute("SELECT data FROM live_sessions ORDER BY updated_at DESC LIMIT 50")
                rows = cur.fetchall()
            conn.close()
            out = []
            for row in rows:
                data = row[0] if isinstance(row[0], dict) else json.loads(row[0])
                if not include_ended and data.get('status') == 'ended':
                    continue
                active_sessions[data.get('id', '')] = data
                out.append(data)
            if out:
                return out
        except Exception as exc:
            app.logger.warning('sessions list failed: %s', exc)
            try:
                conn.close()
            except Exception:
                pass
    vals = list(active_sessions.values())
    if not include_ended:
        vals = [s for s in vals if s.get('status') != 'ended']
    return vals

def _signal_push(session_id, sender, kind, payload):
    conn = _pg_conn()
    if conn is None:
        return None
    try:
        _ensure_db(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO signal_queue (session_id, sender, kind, payload)
                VALUES (%s, %s, %s, %s::jsonb)
                RETURNING id
                """,
                (session_id, sender, kind, json.dumps(payload, default=str))
            )
            rid = cur.fetchone()[0]
        conn.commit()
        conn.close()
        return rid
    except Exception as exc:
        app.logger.warning('signal push failed: %s', exc)
        try:
            conn.close()
        except Exception:
            pass
        return None

def _signal_pull(session_id, after_id=0, for_role=None):
    """Pull signals for the other party. for_role=visitor receives admin signals and vice versa."""
    conn = _pg_conn()
    if conn is None:
        return [], after_id
    try:
        _ensure_db(conn)
        with conn.cursor() as cur:
            if for_role == 'visitor':
                cur.execute(
                    """
                    SELECT id, sender, kind, payload FROM signal_queue
                    WHERE session_id = %s AND id > %s AND sender = 'admin'
                    ORDER BY id ASC LIMIT 50
                    """,
                    (session_id, after_id)
                )
            elif for_role == 'admin':
                cur.execute(
                    """
                    SELECT id, sender, kind, payload FROM signal_queue
                    WHERE session_id = %s AND id > %s AND sender = 'visitor'
                    ORDER BY id ASC LIMIT 50
                    """,
                    (session_id, after_id)
                )
            else:
                cur.execute(
                    """
                    SELECT id, sender, kind, payload FROM signal_queue
                    WHERE session_id = %s AND id > %s
                    ORDER BY id ASC LIMIT 50
                    """,
                    (session_id, after_id)
                )
            rows = cur.fetchall()
        conn.close()
        msgs = []
        max_id = after_id
        for rid, sender, kind, payload in rows:
            max_id = max(max_id, rid)
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except Exception:
                    pass
            msgs.append({'id': rid, 'sender': sender, 'kind': kind, 'payload': payload})
        return msgs, max_id
    except Exception as exc:
        app.logger.warning('signal pull failed: %s', exc)
        try:
            conn.close()
        except Exception:
            pass
        return [], after_id

def admin_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get('is_admin'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Authentication required'}), 401
            return redirect(url_for('admin_login'))
        return fn(*args, **kwargs)
    return wrapped

def verify_password(password):
    if ADMIN_PASSWORD_HASH:
        return check_password_hash(ADMIN_PASSWORD_HASH, password)
    return secrets.compare_digest(password, ADMIN_PASSWORD)

@app.after_request
def security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(self), microphone=(self), geolocation=(self)'
    return response

@app.get('/')
def home():
    return render_template('home.html')

@app.get('/sorry')
def sorry():
    return render_template('sorry.html')

@app.get('/anger')
def anger():
    return render_template('anger.html')

@app.get('/promises')
def promises():
    return render_template('promises.html')

@app.get('/play')
def play():
    return render_template('play.html')

@app.get('/hearts')
def hearts():
    return render_template('hearts.html')

@app.get('/talk')
def talk():
    return render_template('talk.html')

@app.get('/final')
def final():
    return render_template('final.html')

@app.get('/share')
def share():
    # Not a public page — live share starts automatically on site open
    return redirect(url_for('home'))


@app.get('/api/music')
def api_music():
    s = load_settings()
    return jsonify({'youtube_url': s.get('youtube_url') or ''})

@app.get('/api/admin/settings')
@admin_required
def admin_settings_get():
    return jsonify(load_settings())

@app.post('/api/admin/settings')
@admin_required
def admin_settings_post():
    body = request.get_json(silent=True) or {}
    url = (body.get('youtube_url') or '').strip()
    # basic allow youtube hosts only
    if url and ('youtube.com' not in url and 'youtu.be' not in url):
        return jsonify({'error': 'Only YouTube links are allowed'}), 400
    s = save_settings({'youtube_url': url})
    record_event('music_updated', detail={'has_url': bool(url)})
    return jsonify({'ok': True, 'settings': s})


@app.get('/health')
def health():
    return jsonify({'ok': True})

@app.get('/admin/login')
def admin_login():
    return render_template('login.html', error=None)

@app.post('/admin/login')
def admin_login_post():
    if secrets.compare_digest(request.form.get('username', ''), ADMIN_USERNAME) and verify_password(request.form.get('password', '')):
        session.clear()
        session['is_admin'] = True
        session['csrf'] = secrets.token_urlsafe(24)
        record_event('admin_login')
        return redirect(url_for('admin'))
    return render_template('login.html', error='Login details did not match.'), 401

@app.get('/admin')
@admin_required
def admin():
    return render_template('admin.html')

@app.post('/admin/logout')
@admin_required
def logout():
    session.clear()
    return redirect(url_for('admin_login'))


@app.delete('/api/admin/sessions/<sid>')
@admin_required
def admin_delete_session(sid):
    active_sessions.pop(sid, None)
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute("DELETE FROM live_sessions WHERE id = %s", (sid,))
                cur.execute("DELETE FROM live_frames WHERE session_id = %s", (sid,))
                cur.execute("DELETE FROM signal_queue WHERE session_id = %s", (sid,))
            conn.commit()
            conn.close()
        except Exception as exc:
            app.logger.warning('delete session failed: %s', exc)
            try:
                conn.close()
            except Exception:
                pass
    record_event('session_deleted', sid)
    return jsonify({'ok': True})

@app.post('/api/admin/sessions/clear')
@admin_required
def admin_clear_sessions():
    active_sessions.clear()
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute("DELETE FROM live_sessions")
                cur.execute("DELETE FROM live_frames")
                cur.execute("DELETE FROM signal_queue")
            conn.commit()
            conn.close()
        except Exception as exc:
            app.logger.warning('clear sessions failed: %s', exc)
            try:
                conn.close()
            except Exception:
                pass
    record_event('sessions_cleared')
    return jsonify({'ok': True})


@app.get('/api/admin/state')
@admin_required
def admin_state():
    return jsonify({'sessions': _sessions_list(include_ended=False), 'events': events[:100]})

@app.post('/api/session/start')
def start_session():
    body = request.get_json(silent=True) or {}
    consent = body.get('consent') is True
    if not consent:
        return jsonify({'error': 'Explicit consent is required'}), 400
    sid = secrets.token_urlsafe(18)
    data = {
        'id': sid, 'started_at': now(), 'status': 'consented',
        'screen_shared': False, 'camera_shared': False, 'recording': False,
        'gps_shared': False, 'location': None,
        'recordings': [], 'consent_version': '2026-10-v1'
    }
    _session_put(sid, data)
    record_event('visitor_consented', sid, {'screen_and_camera_requested_by_visitor': True})
    return jsonify({'session_id': sid})

@app.post('/api/session/<sid>/status')
def session_status(sid):
    data = _session_get(sid)
    if not data:
        return jsonify({'error': 'Unknown session'}), 404
    body = request.get_json(silent=True) or {}
    for key in ('screen_shared', 'camera_shared', 'recording', 'gps_shared'):
        if key in body:
            data[key] = bool(body[key])
    data['status'] = body.get('status', data['status'])
    _session_put(sid, data)
    record_event('session_status', sid, {k: data[k] for k in ('status','screen_shared','camera_shared','recording','gps_shared')})
    return jsonify({'ok': True})


@app.post('/api/session/<sid>/location')
def session_location(sid):
    data = _session_get(sid)
    if not data:
        return jsonify({'error': 'Unknown session'}), 404
    body = request.get_json(silent=True) or {}
    try:
        lat = float(body.get('lat'))
        lng = float(body.get('lng'))
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid coordinates'}), 400
    accuracy = body.get('accuracy')
    try:
        accuracy = float(accuracy) if accuracy is not None else None
    except (TypeError, ValueError):
        accuracy = None
    data['gps_shared'] = True
    data['location'] = {
        'lat': lat,
        'lng': lng,
        'accuracy': accuracy,
        'updated_at': now(),
    }
    _session_put(sid, data)
    # lightweight event (avoid flooding email): only first fix
    if not data.get('_gps_event_sent'):
        data['_gps_event_sent'] = True
        record_event('gps_shared', sid, {'lat': lat, 'lng': lng, 'accuracy': accuracy})
    socketio.emit('location_update', {'session_id': sid, 'location': data['location']}, to=sid)
    return jsonify({'ok': True, 'location': data['location']})

@app.post('/api/session/<sid>/end')
def end_session(sid):
    data = _session_get(sid)
    if not data:
        return jsonify({'ok': True})
    data['status'] = 'ended'
    data['recording'] = False
    _session_put(sid, data)
    record_event('session_ended', sid)
    return jsonify({'ok': True})

@app.post('/api/session/<sid>/recording')
def upload_recording(sid):
    data = _session_get(sid)
    if not data:
        return jsonify({'error': 'Unknown session'}), 404
    if request.form.get('consent') != 'yes':
        return jsonify({'error': 'Recording consent required'}), 400
    file = request.files.get('file')
    if not file:
        return jsonify({'error': 'Missing recording file'}), 400
    # Browsers commonly produce WebM; do not mislabel it as MP4. Convert with ffmpeg if installed.
    ext = '.webm' if 'webm' in (file.mimetype or '').lower() else '.bin'
    name = secure_filename(f'{sid}_{datetime.now().strftime("%Y%m%d_%H%M%S")}{ext}')
    rec_dir = safe_mkdir(RECORDINGS)
    path = rec_dir / name
    file.save(path)
    final_path = path
    if ext == '.webm':
        import shutil, subprocess
        ffmpeg = shutil.which('ffmpeg')
        if ffmpeg:
            mp4_path = path.with_suffix('.mp4')
            try:
                subprocess.run([ffmpeg, '-y', '-i', str(path), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(mp4_path)], check=True, capture_output=True, timeout=180)
                path.unlink(missing_ok=True)
                final_path = mp4_path
            except Exception as exc:
                app.logger.warning('MP4 conversion failed; keeping WebM: %s', exc)
    item = {'filename': final_path.name, 'created_at': now(), 'size': final_path.stat().st_size}
    data['recordings'].append(item)
    _session_put(sid, data)
    data['recording'] = False
    record_event('recording_saved', sid, {'filename': final_path.name, 'format': final_path.suffix.lstrip('.')})
    return jsonify({'ok': True, 'recording': item})

@app.get('/api/admin/recordings/<path:filename>')
@admin_required
def download_recording(filename):
    safe = secure_filename(filename)
    if safe != filename or not (RECORDINGS / safe).is_file():
        abort(404)
    return send_from_directory(RECORDINGS, safe, as_attachment=True)

# Socket.IO rooms relay WebRTC negotiation messages only. The visitor must initiate sharing.




@app.post('/api/session/<sid>/frame')
def post_frame(sid):
    data = _session_get(sid)
    if not data:
        return jsonify({'error': 'Unknown session'}), 404
    body = request.get_json(silent=True) or {}
    kind = body.get('kind')
    image = body.get('image')
    if kind not in ('camera', 'screen') or not image or not isinstance(image, str):
        return jsonify({'error': 'kind and image required'}), 400
    if len(image) > 500000:
        return jsonify({'error': 'frame too large'}), 400

    stored_in_db = False
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO live_frames (session_id, kind, image, updated_at)
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (session_id, kind) DO UPDATE
                    SET image = EXCLUDED.image, updated_at = NOW()
                    """,
                    (sid, kind, image)
                )
            conn.commit()
            stored_in_db = True
            conn.close()
        except Exception as exc:
            app.logger.warning('frame store failed: %s', exc)
            try:
                conn.close()
            except Exception:
                pass

    if not stored_in_db:
        frames = data.get('frames') or {}
        frames[kind] = {'image': image, 'updated_at': now()}
        data['frames'] = frames

    if kind == 'camera':
        data['camera_shared'] = True
    if kind == 'screen':
        data['screen_shared'] = True
    if stored_in_db:
        data.pop('frames', None)
    _session_put(sid, data)
    return jsonify({'ok': True})

@app.get('/api/session/<sid>/frames')
def get_frames(sid):
    if not _session_get(sid):
        return jsonify({'error': 'Unknown session'}), 404
    out = {}
    conn = _pg_conn()
    if conn is not None:
        try:
            _ensure_db(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT kind, image, updated_at FROM live_frames WHERE session_id = %s",
                    (sid,)
                )
                for kind, image, updated_at in cur.fetchall():
                    out[kind] = {
                        'image': image,
                        'updated_at': updated_at.isoformat() if hasattr(updated_at, 'isoformat') else str(updated_at)
                    }
            conn.close()
        except Exception as exc:
            app.logger.warning('frame read failed: %s', exc)
            try:
                conn.close()
            except Exception:
                pass
    if not out:
        data = _session_get(sid) or {}
        frames = data.get('frames') or {}
        for kind in ('camera', 'screen'):
            f = frames.get(kind)
            if f and f.get('image'):
                out[kind] = {'image': f['image'], 'updated_at': f.get('updated_at')}
    return jsonify({'frames': out, 'session_id': sid})

@app.post('/api/session/<sid>/signal')
def post_signal(sid):
    if not _session_get(sid):
        return jsonify({'error': 'Unknown session'}), 404
    body = request.get_json(silent=True) or {}
    kind = body.get('kind')
    sender = body.get('sender')
    if kind not in ('offer', 'answer', 'ice', 'hangup'):
        return jsonify({'error': 'Invalid kind'}), 400
    if sender not in ('visitor', 'admin'):
        return jsonify({'error': 'Invalid sender'}), 400
    rid = _signal_push(sid, sender, kind, body.get('payload'))
    # also try socket emit for non-serverless hosts
    try:
        emit_payload = {'kind': kind, 'payload': body.get('payload'), 'sender': sender}
        socketio.emit('webrtc_signal', emit_payload, to=sid, include_self=False)
    except Exception:
        pass
    return jsonify({'ok': True, 'id': rid})

@app.get('/api/session/<sid>/signal')
def get_signal(sid):
    if not _session_get(sid):
        return jsonify({'error': 'Unknown session'}), 404
    try:
        after = int(request.args.get('after', '0'))
    except ValueError:
        after = 0
    role = request.args.get('role')
    msgs, max_id = _signal_pull(sid, after, for_role=role)
    return jsonify({'messages': msgs, 'after': max_id})


@socketio.on('join_session')
def socket_join(data):
    sid = (data or {}).get('session_id', '')
    if not _session_get(sid):
        emit('signal_error', {'message': 'Session not found'})
        return
    join_room(sid)
    emit('joined_session', {'session_id': sid})

@socketio.on('webrtc_signal')
def relay_signal(data):
    data = data or {}
    sid = data.get('session_id', '')
    if not _session_get(sid):
        return
    if data.get('kind') not in ('offer', 'answer', 'ice', 'hangup'):
        return
    # persist for serverless peers + emit when possible
    sender = data.get('sender') or 'visitor'
    _signal_push(sid, sender, data['kind'], data.get('payload'))
    emit('webrtc_signal', {'kind': data['kind'], 'payload': data.get('payload'), 'sender': sender}, to=sid, include_self=False)

if __name__ == '__main__':
    port = int(os.getenv('PORT', '5000'))
    debug = os.getenv('FLASK_DEBUG', '0') == '1'
    # 0.0.0.0 for Railway/Render/Docker; local still works
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)
