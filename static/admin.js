function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = id => document.getElementById(id);

let socket = null, peer = null, selectedSession = '';
let adminSignalAfter = 0;
let autoConnecting = false;
let pollStarted = false;
let videoSlot = 0;
/** Keep last good frames so UI does not go black between polls (camera only) */
let lastFrames = { camera: null, screen: null };

function sdpPayload(desc) {
  if (!desc) return null;
  return { type: desc.type, sdp: desc.sdp };
}
function icePayload(cand) {
  if (!cand) return null;
  return typeof cand.toJSON === 'function' ? cand.toJSON() : cand;
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

function updateLocationUI(session) {
  const el = $('adminLocation');
  const link = $('adminMapLink');
  if (!el) return;
  const loc = session && session.location;
  if (!loc || loc.lat == null || loc.lng == null) {
    el.textContent = session && session.gps_shared ? 'GPS on, waiting for fix…' : 'No location yet.';
    if (link) link.style.display = 'none';
    return;
  }
  const acc = loc.accuracy != null ? ` ±${Math.round(loc.accuracy)}m` : '';
  const when = loc.updated_at ? ` · ${loc.updated_at}` : '';
  el.textContent = `${Number(loc.lat).toFixed(6)}, ${Number(loc.lng).toFixed(6)}${acc}${when}`;
  if (link) {
    link.href = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
    link.style.display = 'inline-flex';
  }
}

function ensureFrameImgs() {
  // Camera only — no screen share UI
  [
    ['adminCamera', 'adminCameraFrame']
  ].forEach(([vidId, imgId]) => {
    const vid = document.getElementById(vidId);
    if (!vid || document.getElementById(imgId)) return;
    const img = document.createElement('img');
    img.id = imgId;
    img.alt = vidId;
    img.style.cssText = 'width:100%;min-height:180px;border-radius:16px;background:#1a1014;object-fit:cover;display:block';
    vid.style.display = 'none';
    vid.parentNode.insertBefore(img, vid);
  });
}

function paintFrame(kind, dataUrl) {
  if (!dataUrl || kind !== 'camera') return;
  ensureFrameImgs();
  const img = document.getElementById('adminCameraFrame');
  const vid = document.getElementById('adminCamera');
  if (!img) return;
  // Always keep JPEG frames visible (reliable while tab open).
  // WebRTC video is optional overlay — if it dies after 2–3s, frames stay.
  if (img.dataset.frame !== dataUrl.slice(0, 80) + String(dataUrl.length)) {
    img.dataset.frame = dataUrl.slice(0, 80) + String(dataUrl.length);
    img.src = dataUrl;
  }
  img.style.display = 'block';
  if (vid) {
    const live = vid.srcObject && [...vid.srcObject.getVideoTracks()].some(t => t.readyState === 'live');
    // Prefer showing frames under/instead of flaky WebRTC
    if (live) {
      // Keep both: video on top only if actually producing frames
      try {
        // If video is black/frozen, still show img underneath
        vid.style.display = 'block';
        vid.style.position = 'absolute';
        vid.style.opacity = '0.01'; // nearly invisible — frames are source of truth
        vid.style.pointerEvents = 'none';
      } catch (e) {}
    } else {
      vid.style.display = 'none';
    }
  }
}

function showSessionFrames(session) {
  const frames = (session && session.frames) || {};
  if (frames.camera && frames.camera.image) {
    lastFrames.camera = frames.camera.image;
  }
  // Camera only
  if (lastFrames.camera) paintFrame('camera', lastFrames.camera);
}

async function httpAdminSignalSend(kind, payload) {
  if (!selectedSession) return;
  try {
    await fetch(`/api/session/${selectedSession}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, payload, sender: 'admin' })
    });
  } catch (e) {}
}

function assignVideoTrack(track, stream) {
  const cam = $('adminCamera');
  if (!cam) return;
  const media = stream || new MediaStream([track]);
  cam.srcObject = media;
  cam.play?.().catch(() => {});
  // Do NOT hide JPEG frame image — frames remain the continuous live view
  const img = $('adminCameraFrame');
  if (img) img.style.display = 'block';
  cam.style.display = 'block';
  cam.style.opacity = '0.01';
  if ($('liveStatus')) $('liveStatus').textContent = 'Live camera connected (frames + WebRTC).';
}

function makePeer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    const payload = icePayload(e.candidate);
    if (socket) {
      socket.emit('webrtc_signal', { session_id: selectedSession, kind: 'ice', payload, sender: 'admin' });
    }
    httpAdminSignalSend('ice', payload);
  };
  pc.ontrack = ev => {
    if (ev.track && ev.track.kind === 'video') assignVideoTrack(ev.track, ev.streams && ev.streams[0]);
  };
  return pc;
}

async function handleAdminSignal(msg) {
  if (!msg || !msg.kind) return;
  try {
    if (msg.kind === 'offer' && msg.payload) {
      if (peer) { try { peer.close(); } catch (e) {} }
      peer = makePeer();
      videoSlot = 0;
      await peer.setRemoteDescription(msg.payload);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const payload = sdpPayload(peer.localDescription);
      if (socket) {
        socket.emit('webrtc_signal', { session_id: selectedSession, kind: 'answer', payload, sender: 'admin' });
      }
      await httpAdminSignalSend('answer', payload);
      if ($('liveStatus')) $('liveStatus').textContent = 'Linked — waiting for video tracks…';
    } else if (msg.kind === 'answer') {
      return;
    } else if (msg.kind === 'ice' && msg.payload && peer) {
      try { await peer.addIceCandidate(msg.payload); } catch (e) {}
    } else if (msg.kind === 'hangup') {
      peer?.close();
      peer = null;
      if ($('liveStatus')) $('liveStatus').textContent = 'Visitor ended sharing.';
    }
  } catch (e) {
    if ($('liveStatus')) $('liveStatus').textContent = 'Signal error: ' + e.message;
  }
}

function startAdminSignalPoll() {
  if (pollStarted) return;
  pollStarted = true;
  setInterval(async () => {
    if (!selectedSession) return;
    try {
      const r = await fetch(`/api/session/${selectedSession}/signal?role=admin&after=${adminSignalAfter}`);
      if (!r.ok) return;
      const d = await r.json();
      adminSignalAfter = d.after || adminSignalAfter;
      for (const msg of d.messages || []) await handleAdminSignal(msg);
    } catch (e) {}
  }, 1500);
}

async function connectToSession(sessionId, { manual = false } = {}) {
  if (!sessionId) {
    if ($('liveStatus')) $('liveStatus').textContent = 'Choose a session first.';
    return;
  }
  // Don't tear down if already connected to same session
  if (selectedSession === sessionId && peer && !manual) {
    startAdminSignalPoll();
    return;
  }
  selectedSession = sessionId;
  adminSignalAfter = 0;
  videoSlot = 0;
  if (socket) { try { socket.disconnect(); } catch (e) {} }
  peer?.close();
  peer = null;
  // Do NOT clear frame images — keep last snapshot visible

  startAdminSignalPoll();
  peer = makePeer();
  try {
    if (window.io) {
      socket = io({ transports: ['websocket', 'polling'] });
      socket.emit('join_session', { session_id: selectedSession });
      socket.on('webrtc_signal', msg => handleAdminSignal(msg));
    }
  } catch (e) {}
  if ($('liveStatus')) {
    $('liveStatus').textContent = manual
      ? 'Waiting for visitor video offer…'
      : 'Watching session — frames + WebRTC…';
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/admin/state');
    if (!r.ok) throw new Error('Please sign in again.');
    const d = await r.json();
    const select = $('sessionSelect');
    const current = select ? select.value : selectedSession;
    if (select) {
      select.innerHTML = '<option value="">Choose a session</option>';
      (d.sessions || []).filter(s => s.status !== 'ended').forEach(s => {
        const o = document.createElement('option');
        o.value = s.id;
        const tags = [];
        if (s.camera_shared) tags.push('CAM');
        if (s.gps_shared) tags.push('GPS');
        o.textContent = `${s.id.slice(0, 10)}… · ${s.status}${tags.length ? ' · ' + tags.join('+') : ''}`;
        select.appendChild(o);
      });
      if (current && [...select.options].some(o => o.value === current)) select.value = current;
      else if (selectedSession && [...select.options].some(o => o.value === selectedSession)) select.value = selectedSession;
    }

    const all = [];
    (d.sessions || []).forEach(s => (s.recordings || []).forEach(rec => all.push({ ...rec, session_id: s.id })));
    if ($('recordingsList')) {
      $('recordingsList').innerHTML = all.length
        ? all.map(rec => `<div class="event-item"><b>${escapeHtml(rec.filename)}</b><small>${escapeHtml(rec.created_at)} · ${Math.round((rec.size || 0) / 1024)} KB</small><a href="/api/admin/recordings/${encodeURIComponent(rec.filename)}">Download</a></div>`).join('')
        : 'No recordings yet.';
    }
    if ($('eventsList')) {
      $('eventsList').innerHTML = (d.events || []).length
        ? d.events.map(e => `<div class="event-item"><b>${escapeHtml(e.type)}</b><small>${escapeHtml(e.time)} · ${escapeHtml(e.session_id || 'no session')}</small></div>`).join('')
        : 'No events yet.';
    }

    const pick =
      (d.sessions || []).find(s => s.id === (select && select.value)) ||
      (d.sessions || []).find(s => s.status !== 'ended' && (s.camera_shared || s.gps_shared)) ||
      (d.sessions || []).find(s => s.status !== 'ended');

    updateLocationUI(pick);
    if (pick) {
      if (!selectedSession) selectedSession = pick.id;
      // frames come from dedicated poll; still merge if present on session
      if (pick.frames) showSessionFrames(pick);
    }
    if ($('liveStatus')) {
      if (!pick) $('liveStatus').textContent = 'Waiting for a visitor to start a session.';
      else {
        const flags = [];
        if (pick.camera_shared) flags.push('camera');
        if (pick.gps_shared) flags.push('gps');
        if (lastFrames.camera) {
          $('liveStatus').textContent = (flags.length ? `Sharing: ${flags.join(', ')}` : 'Session active') + ' · last frame kept';
        } else {
          $('liveStatus').textContent = flags.length ? `Sharing: ${flags.join(', ')}` : 'Session active — waiting for frames…';
        }
      }
    }

    // Auto-connect once per session id (camera only)
    if (pick && pick.camera_shared) {
      if (selectedSession !== pick.id) {
        if (!autoConnecting) {
          autoConnecting = true;
          try { await connectToSession(pick.id); } finally { autoConnecting = false; }
        }
      } else if (!pollStarted) {
        startAdminSignalPoll();
      }
    }
  } catch (e) {
    if ($('liveStatus')) $('liveStatus').textContent = e.message;
  }
}

async function pollFramesForActiveSession() {
  const id = selectedSession || ($('sessionSelect') && $('sessionSelect').value);
  if (!id) return;
  try {
    const r = await fetch(`/api/session/${id}/frames`);
    if (!r.ok) return;
    const d = await r.json();
    const frames = d.frames || {};
    // Only update when we have images; never wipe lastFrames
    if (frames.camera && frames.camera.image) lastFrames.camera = frames.camera.image;
    showSessionFrames({ frames: {
      camera: lastFrames.camera ? { image: lastFrames.camera } : null
    }});
  } catch (e) {}
}

$('connectBtn')?.addEventListener('click', async () => {
  const id = $('sessionSelect')?.value;
  await connectToSession(id, { manual: true });
});

$('sessionSelect')?.addEventListener('change', async () => {
  const id = $('sessionSelect')?.value;
  if (!id) return;
  lastFrames = { camera: null, screen: null };
  selectedSession = id;
  await connectToSession(id, { manual: true });
  pollFramesForActiveSession();
});

$('deleteSessionBtn')?.addEventListener('click', async () => {
  const id = $('sessionSelect')?.value || selectedSession;
  if (!id) {
    alert('Select a session first');
    return;
  }
  if (!confirm('Delete this session?')) return;
  try {
    const r = await fetch(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Delete failed');
    if (selectedSession === id) {
      selectedSession = '';
      peer?.close(); peer = null;
      lastFrames = { camera: null, screen: null };
      const cam = $('adminCameraFrame');
      if (cam) { cam.removeAttribute('src'); cam.dataset.frame = ''; }
      const vid = $('adminCamera');
      if (vid) { vid.srcObject = null; }
    }
    await refresh();
  } catch (e) {
    alert(e.message || 'Delete failed');
  }
});

$('clearSessionsBtn')?.addEventListener('click', async () => {
  if (!confirm('Delete ALL old sessions?')) return;
  try {
    const r = await fetch('/api/admin/sessions/clear', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Clear failed');
    selectedSession = '';
    peer?.close(); peer = null;
    lastFrames = { camera: null, screen: null };
    await refresh();
  } catch (e) {
    alert(e.message || 'Clear failed');
  }
});

async function loadMusicSettings() {
  try {
    const r = await fetch('/api/admin/settings');
    if (!r.ok) return;
    const d = await r.json();
    const input = document.getElementById('youtubeUrl');
    if (input) input.value = d.youtube_url || '';
  } catch (e) {}
}

document.getElementById('saveMusicBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('youtubeUrl');
  const status = document.getElementById('musicSaveStatus');
  try {
    const r = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtube_url: (input?.value || '').trim() })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    if (status) status.textContent = 'Music link saved.';
  } catch (e) {
    if (status) status.textContent = e.message || 'Could not save';
  }
});

document.getElementById('clearMusicBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('youtubeUrl');
  if (input) input.value = '';
  const status = document.getElementById('musicSaveStatus');
  try {
    const r = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtube_url: '' })
    });
    if (!r.ok) throw new Error('Clear failed');
    if (status) status.textContent = 'Music link cleared.';
  } catch (e) {
    if (status) status.textContent = e.message || 'Could not clear';
  }
});

loadMusicSettings();
refresh();
setInterval(refresh, 2500);
// Poll camera frames often so live view stays continuous while visitor tab is open
setInterval(pollFramesForActiveSession, 600);
