/* =====================================================================
   SK AnonMp4 - application logic
   Database layout (existing paths untouched, new paths added beside them):
     SK-AnonMP4/users/{alias}            -> { hash, created }          (existing)
     SK-AnonMP4/videos/{key}             -> video meta                 (existing)
     SK-AnonMP4/likes/{key}/{alias}      -> true                       (new)
     SK-AnonMP4/comments/{key}/{id}      -> { user, text, timestamp }  (new)
     SK-AnonMP4/stats/{key}              -> { likes, comments, views } (new counters)
   ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
    getDatabase, ref, set, get, child, push, onValue, remove, update,
    runTransaction, query, limitToLast
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";

/* ------------------------------ Config ------------------------------ */
const ROOT = 'SK-AnonMP4';
const UPLOAD_URL = 'https://anonmp4api.xyz/upload';
const PROXY_URL = 'https://corsproxy.io/?' + encodeURIComponent(UPLOAD_URL);
const PROXY_MAX_BYTES = 50 * 1024 * 1024;   // the CORS proxy is only a fallback for small files
const MAX_UPLOAD_BYTES = 0;                 // 0 = no limit enforced by the app (the upload server decides)
const PAGE_SIZE = 24;
const COMMENT_MAX = 500;
const PLACEHOLDER_THUMB = 'https://placehold.co/640x360/0b0f19/6366f1?text=Void';
const NO_THUMB = 'https://placehold.co/640x360/0b0f19/6366f1?text=No+Thumb';
const VIDEO_EXT = /\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|mpg|mpeg|3gp|ts|ogv)$/i;

const firebaseConfig = {
    apiKey: "AIzaSyDpCAXfhldRc1nCZDWlWNRbcMFjqAh8uPc",
    authDomain: "cloud-db-studio.firebaseapp.com",
    databaseURL: "https://cloud-db-studio-default-rtdb.firebaseio.com",
    projectId: "cloud-db-studio",
    storageBucket: "cloud-db-studio.firebasestorage.app",
    messagingSenderId: "343326148662",
    appId: "1:343326148662:web:987738ccc8f9d6a8253097"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* ----------------------------- Helpers ------------------------------ */
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const safeUrl = (u) => {
    try {
        const x = new URL(String(u), location.href);
        return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : '';
    } catch { return ''; }
};

const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const fmtCount = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
};

const fmtBytes = (b) => {
    b = Number(b) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return '--';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
};

const timeAgo = (ts) => {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60) || 1}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
};

const path = {
    user: (u) => `${ROOT}/users/${u}`,
    videos: `${ROOT}/videos`,
    video: (k) => `${ROOT}/videos/${k}`,
    like: (k, u) => `${ROOT}/likes/${k}/${u}`,
    likes: (k) => `${ROOT}/likes/${k}`,
    comments: (k) => `${ROOT}/comments/${k}`,
    comment: (k, id) => `${ROOT}/comments/${k}/${id}`,
    stats: `${ROOT}/stats`,
    stat: (k, f) => `${ROOT}/stats/${k}/${f}`,
    statsOf: (k) => `${ROOT}/stats/${k}`
};

const bump = (p, delta) => runTransaction(ref(db, p), (n) => Math.max(0, (Number(n) || 0) + delta));

/* ------------------------------ State ------------------------------- */
const defaultSettings = { theme: 'glass', accent: '#6366f1', sound: true, haptic: true };
let savedSettings = {};
try { savedSettings = JSON.parse(store.get('sk_settings')) || {}; } catch { savedSettings = {}; }

const state = {
    user: store.get('sk_user') || null,
    settings: { ...defaultSettings, ...savedSettings },
    authMode: 'login',
    authBusy: false,
    uploadFile: null,
    uploading: false,
    activeToast: null,
    toastTimer: null,
    videos: undefined,      // undefined = loading, array afterwards
    stats: {},
    statsLoaded: false,
    filter: 'all',
    sort: 'new',
    query: '',
    limit: PAGE_SIZE,
    watching: null,
    liked: false,
    likeBusy: false,
    commentBusy: false,
    lastComment: 0,
    watchUnsubs: []
};
if (!['glass', 'neu'].includes(state.settings.theme)) state.settings.theme = 'glass';

const videoIndex = new Map();

/* ---------------------- Sound & haptic feedback --------------------- */
let audioCtx = null;
const getAudio = () => {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
    }
    return audioCtx;
};

function playTone(type = 'click') {
    if (!state.settings.sound) return;
    const ctx = getAudio();
    if (!ctx) return;
    try {
        if (ctx.state === 'suspended') ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;
        if (type === 'click') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, now);
            osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.start(now); osc.stop(now + 0.1);
        } else if (type === 'success') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(400, now);
            osc.frequency.setValueAtTime(800, now + 0.1);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.4);
            osc.start(now); osc.stop(now + 0.4);
        } else if (type === 'error') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, now);
            osc.frequency.linearRampToValueAtTime(100, now + 0.3);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.3);
            osc.start(now); osc.stop(now + 0.3);
        }
    } catch { /* audio is optional */ }
}

function triggerHaptic(pattern = 20) {
    try { if (state.settings.haptic && navigator.vibrate) navigator.vibrate(pattern); } catch { /* optional */ }
}

function interact(type = 'click') {
    playTone(type);
    triggerHaptic(type === 'error' ? [50, 50, 50] : (type === 'success' ? [30, 40, 30] : 20));
}

document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sk-btn, .color-orb, .video-card, .chip')) interact('click');
});

/* ------------------------ Keyboard accessibility -------------------- */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const open = Array.from(document.querySelectorAll('.modal-backdrop.active')).pop();
        if (open) { closeModal(open.id); return; }
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (t && t.matches && t.matches('[role="button"]')) {
        e.preventDefault();
        t.click();
    }
});

function makeAccessible(root = document) {
    root.querySelectorAll('.sk-btn:not([role]), .chip:not([role])').forEach((el) => {
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
    });
}

/* ------------------------------ Toasts ------------------------------ */
function showToast(message, type = 'info') {
    const root = $('toast-root');
    if (state.activeToast) { state.activeToast.remove(); state.activeToast = null; }
    clearTimeout(state.toastTimer);

    const toast = document.createElement('div');
    toast.className = 'sk-toast';
    toast.setAttribute('role', 'status');

    let icon = 'fa-info-circle toast-info';
    if (type === 'success') { icon = 'fa-check-circle toast-ok'; interact('success'); }
    else if (type === 'error') { icon = 'fa-triangle-exclamation toast-err'; interact('error'); }

    const i = document.createElement('i');
    i.className = `fa-solid ${icon}`;
    const span = document.createElement('span');
    span.textContent = message;
    toast.append(i, span);

    root.appendChild(toast);
    state.activeToast = toast;

    state.toastTimer = setTimeout(() => {
        if (state.activeToast === toast) {
            toast.classList.add('leaving');
            setTimeout(() => { if (state.activeToast === toast) { toast.remove(); state.activeToast = null; } }, 300);
        }
    }, 3000);
}

/* ----------------------------- Settings ----------------------------- */
function applySettings() {
    document.body.classList.remove('theme-glass', 'theme-neu');
    document.body.classList.add(`theme-${state.settings.theme}`);
    document.documentElement.style.setProperty('--accent', state.settings.accent);

    $('btn-theme-glass').classList.toggle('sk-btn-primary', state.settings.theme === 'glass');
    $('btn-theme-neu').classList.toggle('sk-btn-primary', state.settings.theme === 'neu');

    document.querySelectorAll('.color-orb').forEach((orb) => {
        orb.classList.toggle('active', orb.dataset.color === state.settings.accent);
    });

    $('btn-toggle-sound').innerText = state.settings.sound ? 'ON' : 'OFF';
    $('btn-toggle-sound').classList.toggle('sk-btn-primary', state.settings.sound);
    $('btn-toggle-haptic').innerText = state.settings.haptic ? 'ON' : 'OFF';
    $('btn-toggle-haptic').classList.toggle('sk-btn-primary', state.settings.haptic);

    store.set('sk_settings', JSON.stringify(state.settings));
}

/* ------------------------------ Modals ------------------------------ */
let confirmResolve = null;

function openModal(id) { $(id).classList.add('active'); }

function closeModal(id) {
    if (id === 'modal-player') { closePlayer(); return; }
    if (id === 'modal-confirm' && confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
    $(id).classList.remove('active');
}

function askConfirm(title, text) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    openModal('modal-confirm');
    return new Promise((resolve) => { confirmResolve = resolve; });
}

$('btn-confirm-yes').addEventListener('click', () => {
    const r = confirmResolve; confirmResolve = null;
    $('modal-confirm').classList.remove('active');
    if (r) r(true);
});
$('btn-confirm-no').addEventListener('click', () => closeModal('modal-confirm'));

document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', (e) => closeModal(e.target.closest('.modal-backdrop').id));
});

document.querySelectorAll('.modal-backdrop').forEach((mod) => {
    mod.addEventListener('click', (e) => {
        // The player never closes on an outside tap, to avoid accidentally stopping a video
        if (e.target === mod && mod.id !== 'modal-player') closeModal(mod.id);
    });
});

/* ---------------------------- Cryptography -------------------------- */
// Pure-JS SHA-256, used only when crypto.subtle is unavailable (non-HTTPS contexts).
// Output is identical to the Web Crypto digest, so existing accounts keep working.
function sha256Fallback(bytes) {
    const K = [], H = [];
    for (let c = 2, n = 0; n < 64; c++) {
        let prime = true;
        for (let d = 2; d * d <= c; d++) { if (c % d === 0) { prime = false; break; } }
        if (!prime) continue;
        if (n < 8) H[n] = Math.floor((Math.sqrt(c) % 1) * 4294967296) >>> 0;
        K[n++] = Math.floor((Math.cbrt(c) % 1) * 4294967296) >>> 0;
    }
    const len = bytes.length;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor((len * 8) / 4294967296));
    dv.setUint32(total - 4, (len * 8) >>> 0);

    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const w = new Uint32Array(64);
    const hash = H.slice();

    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        const v = [a, b, c, d, e, f, g, h];
        for (let i = 0; i < 8; i++) hash[i] = (hash[i] + v[i]) >>> 0;
    }
    return hash.map((x) => x.toString(16).padStart(8, '0')).join('');
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256Fallback(msgBuffer);
}

/* ------------------------------- Auth ------------------------------- */
function updateAuthUI() {
    const container = $('auth-container');
    document.body.dataset.auth = state.user ? 'in' : 'out';

    if (state.user) {
        container.innerHTML = `
            <div class="sk-btn sk-btn-logout" id="btn-logout">
                <i class="fa-solid fa-power-off"></i> <span class="auth-label">${esc(state.user)}</span>
            </div>`;
        $('btn-logout').addEventListener('click', () => {
            state.user = null;
            store.remove('sk_user');
            if (state.filter === 'mine') setFilter('all');
            updateAuthUI();
            switchView('feed');
            showToast('Entity disconnected.', 'info');
        });
    } else {
        container.innerHTML = `
            <div class="sk-btn sk-btn-primary" id="btn-login-trigger">
                <i class="fa-solid fa-fingerprint"></i> <span class="auth-label auth-label-light">Identify</span>
            </div>`;
        $('btn-login-trigger').addEventListener('click', () => openModal('modal-auth'));
    }

    makeAccessible(container);
    renderFeed();           // delete buttons depend on who is signed in
    refreshWatchAuth();     // like / comment / delete controls depend on it too
}

$('btn-auth-toggle').addEventListener('click', () => {
    state.authMode = state.authMode === 'login' ? 'signup' : 'login';
    $('auth-title').innerText = state.authMode === 'login' ? 'Identify' : 'Create Identity';
    $('btn-auth-toggle').innerText = state.authMode === 'login' ? 'New Entity? Create Identity' : 'Existing Entity? Identify';
});

async function submitAuth() {
    if (state.authBusy) return;
    const user = $('auth-user').value.trim();
    const pass = $('auth-pass').value;

    if (!user || !pass) { showToast('Credentials required.', 'error'); return; }

    const btn = $('btn-auth-submit');
    state.authBusy = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    btn.classList.add('is-busy');

    try {
        // Firebase keys cannot contain these characters
        if (/[.#$\[\]\/\u0000-\u001f\u007f]/.test(user)) throw new Error('Invalid credentials.');
        if (state.authMode === 'signup') {
            if (user.length < 3 || user.length > 24) throw new Error('Alias must be 3-24 characters.');
            if (pass.length < 6) throw new Error('Passphrase must be at least 6 characters.');
        }

        const hash = await sha256(pass);
        const snap = await get(child(ref(db), path.user(user)));

        if (state.authMode === 'signup') {
            if (snap.exists()) throw new Error('Alias already in use.');
            await set(ref(db, path.user(user)), { hash, created: Date.now() });
            showToast('Identity established.', 'success');
        } else {
            if (!snap.exists() || snap.val().hash !== hash) throw new Error('Invalid credentials.');
            showToast('Access granted.', 'success');
        }

        state.user = user;
        store.set('sk_user', user);
        updateAuthUI();
        closeModal('modal-auth');
        $('auth-user').value = '';
        $('auth-pass').value = '';
    } catch (err) {
        showToast(err && err.message ? err.message : 'Invalid credentials.', 'error');
    } finally {
        state.authBusy = false;
        btn.innerHTML = `<i class="fa-solid fa-fingerprint"></i> Authenticate`;
        btn.classList.remove('is-busy');
    }
}

$('btn-auth-submit').addEventListener('click', submitAuth);
['auth-user', 'auth-pass'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
});

function requireLogin() {
    if (state.user) return true;
    showToast('Authentication required.', 'error');
    openModal('modal-auth');
    return false;
}

/* ------------------------------- Views ------------------------------ */
function switchView(view) {
    $('view-feed').classList.toggle('is-hidden', view !== 'feed');
    $('view-upload').classList.toggle('is-hidden', view !== 'upload');
    $(view === 'feed' ? 'view-feed' : 'view-upload').scrollTop = 0;
}

/* ------------------------------- Feed ------------------------------- */
const grid = $('video-grid');
const empty = $('empty-state');
let feedTimer = null;
let feedUnsubs = [];
let io = null;
let searchTimer = null;

const statOf = (k) => state.stats[k] || {};

function visibleVideos() {
    let list = state.videos || [];
    if (state.filter === 'mine') list = list.filter((v) => state.user && v.uploader === state.user);
    const q = state.query.trim().toLowerCase();
    if (q) list = list.filter((v) => `${v.title || ''} ${v.uploader || ''}`.toLowerCase().includes(q));

    const sorted = list.slice();
    if (state.sort === 'popular') {
        const score = (v) => { const s = statOf(v.key); return (s.likes || 0) * 5 + (s.comments || 0) * 3 + (s.views || 0); };
        sorted.sort((a, b) => score(b) - score(a) || (b.timestamp || 0) - (a.timestamp || 0));
    } else {
        sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    return sorted;
}

function renderFeed() {
    if (state.videos === undefined) return; // still loading - keep the loader

    const list = visibleVideos();
    grid.innerHTML = '';
    if (io) { io.disconnect(); io = null; }

    if (!list.length) { empty.classList.remove('is-hidden'); return; }
    empty.classList.add('is-hidden');

    const slice = list.slice(0, state.limit);
    const frag = document.createDocumentFragment();

    slice.forEach((v) => {
        const card = document.createElement('div');
        card.className = 'sk-surface video-card';
        card.dataset.play = v.key;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');

        const isOwner = state.user && state.user === v.uploader;
        const delBtn = isOwner ? `
            <div class="sk-btn sk-btn-danger btn-block card-del" data-del="${esc(v.key)}" role="button" tabindex="0">
                <i class="fa-solid fa-trash-can"></i> Erase Data
            </div>` : '';

        const thumb = safeUrl(v.thumbnail) || PLACEHOLDER_THUMB;
        const date = v.timestamp ? new Date(v.timestamp).toLocaleDateString() : '';
        const s = statOf(v.key);

        card.innerHTML = `
            <div class="thumb-wrapper">
                <img src="${esc(thumb)}" class="thumb-img" alt="" loading="lazy" decoding="async">
                <div class="play-overlay"><div class="play-btn"><i class="fa-solid fa-play"></i></div></div>
            </div>
            <div class="card-body">
                <div>
                    <h3 class="card-title">${esc(v.title)}</h3>
                    <div class="card-meta">
                        <span class="truncate"><i class="fa-solid fa-user-astronaut accent"></i> ${esc(v.uploader)}</span>
                        <span class="nowrap">${esc(date)}</span>
                    </div>
                    <div class="card-stats">
                        <span><i class="fa-solid fa-heart"></i> <b class="s-likes">${fmtCount(s.likes)}</b></span>
                        <span><i class="fa-solid fa-comment"></i> <b class="s-comments">${fmtCount(s.comments)}</b></span>
                        <span><i class="fa-solid fa-eye"></i> <b class="s-views">${fmtCount(s.views)}</b></span>
                    </div>
                </div>
                ${delBtn}
            </div>`;

        const img = card.querySelector('.thumb-img');
        img.addEventListener('error', () => { img.onerror = null; img.src = PLACEHOLDER_THUMB; }, { once: true });
        frag.appendChild(card);
    });

    if (list.length > slice.length) {
        const sentinel = document.createElement('div');
        sentinel.className = 'span-all load-more';
        sentinel.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
        frag.appendChild(sentinel);
        grid.appendChild(frag);
        io = new IntersectionObserver((entries) => {
            if (entries.some((en) => en.isIntersecting)) { state.limit += PAGE_SIZE; renderFeed(); }
        }, { root: $('view-feed'), rootMargin: '600px' });
        io.observe(sentinel);
    } else {
        grid.appendChild(frag);
    }

    makeAccessible(grid);
}

function patchCardStats() {
    grid.querySelectorAll('.video-card').forEach((card) => {
        const s = statOf(card.dataset.play);
        const set = (sel, val) => { const el = card.querySelector(sel); if (el) el.textContent = fmtCount(val); };
        set('.s-likes', s.likes); set('.s-comments', s.comments); set('.s-views', s.views);
    });
}

function renderFeedError() {
    empty.classList.add('is-hidden');
    grid.innerHTML = `
        <div class="span-all empty-state empty-compact">
            <i class="fa-solid fa-triangle-exclamation empty-icon"></i>
            <p class="muted mb-lg">Unable to reach the network.</p>
            <div class="sk-btn" id="btn-retry-feed" role="button" tabindex="0"><i class="fa-solid fa-rotate-right"></i> Retry</div>
        </div>`;
    $('btn-retry-feed').addEventListener('click', startFeed);
}

function startFeed() {
    feedUnsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
    feedUnsubs = [];
    clearTimeout(feedTimer);
    state.videos = undefined;
    empty.classList.add('is-hidden');
    grid.innerHTML = `<div class="span-all loader-wrap"><i class="fa-solid fa-circle-notch fa-spin loader-icon"></i></div>`;

    // If nothing arrives for a while, offer a retry instead of an endless spinner
    feedTimer = setTimeout(() => { if (state.videos === undefined) renderFeedError(); }, 15000);

    feedUnsubs.push(onValue(ref(db, path.videos), (snap) => {
        clearTimeout(feedTimer);
        const data = snap.val();
        videoIndex.clear();
        const list = [];
        if (data && typeof data === 'object') {
            Object.entries(data).forEach(([key, val]) => {
                if (val && typeof val === 'object') {
                    const v = { key, ...val };
                    videoIndex.set(key, v);
                    list.push(v);
                }
            });
        }
        state.videos = list;
        renderFeed();
        handleHash();
        if (state.watching) syncWatchMeta();
    }, (err) => {
        console.error(err);
        clearTimeout(feedTimer);
        renderFeedError();
    }));

    // One subscription for all counters (likes / comments / views)
    feedUnsubs.push(onValue(ref(db, path.stats), (snap) => {
        state.stats = snap.val() || {};
        if (!state.statsLoaded) {
            state.statsLoaded = true;
            if (state.sort === 'popular') renderFeed();
        }
        patchCardStats();
        updateWatchStats();
    }, () => { /* counters are optional - the feed still works without them */ }));
}

function setFilter(f) {
    state.filter = f;
    state.limit = PAGE_SIZE;
    document.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('active', c.dataset.filter === f));
    renderFeed();
}

function setSort(s) {
    state.sort = s;
    state.limit = PAGE_SIZE;
    document.querySelectorAll('[data-sort]').forEach((c) => c.classList.toggle('active', c.dataset.sort === s));
    renderFeed();
}

document.querySelector('.toolbar').addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { setFilter(f.dataset.filter); return; }
    const s = e.target.closest('[data-sort]');
    if (s) setSort(s.dataset.sort);
});

$('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; state.limit = PAGE_SIZE; renderFeed(); }, 150);
});

grid.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) { e.stopPropagation(); deleteVideo(delBtn.dataset.del); return; }
    const card = e.target.closest('[data-play]');
    if (card) openFromCard(card.dataset.play);
});

/* ------------------------------ Player ------------------------------ */
function handleHash() {
    const m = /^#v=(.+)$/.exec(location.hash);
    if (m) {
        let key = m[1];
        try { key = decodeURIComponent(key); } catch { /* keep raw */ }
        if (state.watching !== key && state.videos !== undefined) openPlayerByKey(key);
    } else if (state.watching) {
        teardownPlayer();
    }
}
window.addEventListener('hashchange', handleHash);

function openFromCard(key) {
    const h = '#v=' + encodeURIComponent(key);
    if (location.hash === h) openPlayerByKey(key);
    else location.hash = h;   // hashchange opens the player and gives Back-button support
}

function unsubWatch() {
    state.watchUnsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
    state.watchUnsubs = [];
}

function stopFrame() {
    const frame = $('player-frame');
    frame.onload = null;
    frame.classList.remove('ready');
    frame.src = 'about:blank';
    $('player-loader').classList.remove('is-hidden');
    clearTimeout(stopFrame.timer);
}

function teardownPlayer() {
    unsubWatch();
    state.watching = null;
    state.liked = false;
    stopFrame();
    $('modal-player').classList.remove('active');
    $('comment-list').innerHTML = '';
    $('comment-input').value = '';
}

function closePlayer() {
    if (/^#v=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    teardownPlayer();
}

function openPlayerByKey(key) {
    const v = videoIndex.get(key);
    if (!v) return false;
    const src = safeUrl(v.embed_url);
    if (!src) { showToast('Transmission failed.', 'error'); return false; }

    unsubWatch();
    state.watching = key;
    state.liked = false;
    openModal('modal-player');

    $('player-title').textContent = v.title || '';
    $('player-meta').innerHTML = `<i class="fa-solid fa-shield-halved ok-icon"></i> Owner: ${esc(v.uploader)}`;
    $('stat-date').textContent = v.timestamp ? new Date(v.timestamp).toLocaleDateString() : '';

    const frame = $('player-frame');
    const loader = $('player-loader');
    frame.classList.remove('ready');
    loader.classList.remove('is-hidden');
    const reveal = () => { loader.classList.add('is-hidden'); frame.classList.add('ready'); };
    frame.onload = reveal;
    clearTimeout(stopFrame.timer);
    stopFrame.timer = setTimeout(reveal, 10000); // never leave the loader spinning forever
    frame.src = src;

    updateWatchStats();
    refreshWatchAuth();
    subscribeLikes(key);
    subscribeComments(key);
    countView(key);
    return true;
}

function syncWatchMeta() {
    // Called when the video list changes while the player is open (e.g. it was deleted elsewhere)
    if (!state.watching) return;
    if (!videoIndex.has(state.watching)) { closePlayer(); showToast('Entity purged.', 'info'); return; }
    refreshWatchAuth();
}

function countView(key) {
    const k = 'sk_v_' + key;
    try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* count anyway */ }
    bump(path.stat(key, 'views'), 1).catch(() => {});
}

function updateWatchStats() {
    if (!state.watching) return;
    const s = statOf(state.watching);
    $('like-count').textContent = fmtCount(s.likes);
    $('stat-views').innerHTML = `<i class="fa-solid fa-eye"></i> ${fmtCount(s.views)} views`;
}

function refreshWatchAuth() {
    if (!state.watching) return;
    const v = videoIndex.get(state.watching);
    const owner = !!(v && state.user && v.uploader === state.user);
    $('btn-delete-video').classList.toggle('is-hidden', !owner);
    subscribeLikes(state.watching, true);
    renderComments(lastCommentSnapshot);
}

/* --- Likes --- */
let likeUnsub = null;
function subscribeLikes(key, resubscribe = false) {
    if (likeUnsub) { try { likeUnsub(); } catch { /* ignore */ } state.watchUnsubs = state.watchUnsubs.filter((u) => u !== likeUnsub); likeUnsub = null; }
    if (!state.user) { setLikedUI(false); return; }
    if (resubscribe && !state.watching) return;
    likeUnsub = onValue(ref(db, path.like(key, state.user)), (snap) => setLikedUI(snap.val() === true), () => setLikedUI(false));
    state.watchUnsubs.push(likeUnsub);
}

function setLikedUI(liked) {
    state.liked = liked;
    const btn = $('btn-like');
    btn.classList.toggle('liked', liked);
    btn.querySelector('i').className = liked ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
}

async function toggleLike() {
    if (!requireLogin() || state.likeBusy || !state.watching) return;
    const key = state.watching;
    const wasLiked = state.liked;
    state.likeBusy = true;
    setLikedUI(!wasLiked); // optimistic
    try {
        if (wasLiked) {
            await remove(ref(db, path.like(key, state.user)));
            await bump(path.stat(key, 'likes'), -1);
        } else {
            await set(ref(db, path.like(key, state.user)), true);
            await bump(path.stat(key, 'likes'), 1);
        }
    } catch (err) {
        console.error(err);
        setLikedUI(wasLiked);
        showToast('Transmission failed.', 'error');
    } finally {
        state.likeBusy = false;
    }
}
$('btn-like').addEventListener('click', toggleLike);

/* --- Share --- */
$('btn-share').addEventListener('click', async () => {
    if (!state.watching) return;
    const url = `${location.origin}${location.pathname}#v=${encodeURIComponent(state.watching)}`;
    const v = videoIndex.get(state.watching);
    try {
        if (navigator.share) { await navigator.share({ title: v?.title || 'SK AnonMp4', url }); return; }
    } catch (err) { if (err && err.name === 'AbortError') return; }
    try {
        await navigator.clipboard.writeText(url);
        showToast('Link copied.', 'success');
    } catch {
        window.prompt('Copy this link', url);
    }
});

/* --- Comments --- */
let lastCommentSnapshot = null;

function subscribeComments(key) {
    lastCommentSnapshot = null;
    const q = query(ref(db, path.comments(key)), limitToLast(200));
    const unsub = onValue(q, (snap) => {
        lastCommentSnapshot = snap.val() || {};
        renderComments(lastCommentSnapshot);
    }, () => renderComments({}));
    state.watchUnsubs.push(unsub);
}

function renderComments(data) {
    const list = $('comment-list');
    if (!state.watching) return;
    if (data === null) { list.innerHTML = ''; return; }

    const v = videoIndex.get(state.watching);
    const entries = Object.entries(data || {})
        .filter(([, c]) => c && typeof c === 'object' && c.text)
        .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

    $('comment-count').textContent = fmtCount(Math.max(entries.length, Number(statOf(state.watching).comments) || 0));

    if (!entries.length) {
        list.innerHTML = '<p class="muted comment-empty">No comments yet.</p>';
        return;
    }

    const frag = document.createDocumentFragment();
    entries.forEach(([id, c]) => {
        const canDelete = state.user && (state.user === c.user || (v && state.user === v.uploader));
        const row = document.createElement('div');
        row.className = 'comment';
        row.innerHTML = `
            <div class="avatar">${esc(String(c.user || '?').charAt(0).toUpperCase())}</div>
            <div class="c-body">
                <div class="c-head"><span class="c-user">${esc(c.user)}</span><span class="c-time">${esc(timeAgo(c.timestamp))}</span></div>
                <div class="c-text">${esc(c.text)}</div>
            </div>
            ${canDelete ? `<div class="c-del" data-cdel="${esc(id)}" role="button" tabindex="0" aria-label="Delete comment"><i class="fa-solid fa-trash-can"></i></div>` : ''}`;
        frag.appendChild(row);
    });
    list.innerHTML = '';
    list.appendChild(frag);
}

$('comment-list').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-cdel]');
    if (!del || !state.watching || !state.user) return;
    const key = state.watching;
    try {
        await remove(ref(db, path.comment(key, del.dataset.cdel)));
        await bump(path.stat(key, 'comments'), -1);
    } catch (err) {
        console.error(err);
        showToast('Erasure failed.', 'error');
    }
});

async function postComment() {
    if (!requireLogin() || state.commentBusy || !state.watching) return;
    const input = $('comment-input');
    const text = input.value.trim().slice(0, COMMENT_MAX);
    if (!text) return;
    if (Date.now() - state.lastComment < 2000) return; // gentle anti-spam

    const key = state.watching;
    state.commentBusy = true;
    $('btn-comment-send').classList.add('is-busy');
    try {
        await push(ref(db, path.comments(key)), { user: state.user, text, timestamp: Date.now() });
        await bump(path.stat(key, 'comments'), 1);
        input.value = '';
        state.lastComment = Date.now();
    } catch (err) {
        console.error(err);
        showToast('Transmission failed.', 'error');
    } finally {
        state.commentBusy = false;
        $('btn-comment-send').classList.remove('is-busy');
    }
}

$('btn-comment-send').addEventListener('click', postComment);
$('comment-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(); }
});
$('btn-comment-login').addEventListener('click', () => openModal('modal-auth'));

/* ------------------------- Delete (uploader only) ------------------- */
async function deleteVideo(key) {
    const v = videoIndex.get(key);
    // Only the uploader can erase a video - enforced here and by the UI
    if (!v || !state.user || v.uploader !== state.user) { showToast('Authentication required.', 'error'); return; }
    if (!(await askConfirm('Erase Data', 'Erase this entity from the void?'))) return;

    try {
        showToast('Executing erasure...', 'info');
        const url = safeUrl(v.delete_url);
        if (url) fetch(url, { mode: 'no-cors' }).catch(() => {});
        // One atomic multi-path delete: the video plus everything attached to it
        await update(ref(db), {
            [path.video(key)]: null,
            [path.likes(key)]: null,
            [path.comments(key)]: null,
            [path.statsOf(key)]: null
        });
        if (state.watching === key) closePlayer();
        showToast('Entity purged.', 'success');
    } catch (e) {
        console.error(e);
        showToast('Erasure failed.', 'error');
    }
}
$('btn-delete-video').addEventListener('click', () => { if (state.watching) deleteVideo(state.watching); });

/* ------------------------------ Upload ------------------------------ */
const fInput = $('file-input');
const dropArea = $('drop-area');
const uploadHolder = { xhr: null };
let wakeLock = null;

async function holdScreen() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
}
function releaseScreen() {
    try { if (wakeLock) wakeLock.release(); } catch { /* optional */ }
    wakeLock = null;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.uploading) holdScreen(); });

function setProgress(fraction, visible = true) {
    $('upload-progress').classList.toggle('is-hidden', !visible);
    $('upload-progress-bar').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function resetUploadUI() {
    state.uploadFile = null;
    fInput.value = '';
    $('upload-title').value = '';
    $('drop-ui-default').classList.remove('is-hidden');
    $('drop-ui-selected').classList.add('is-hidden');
    $('upload-stats').classList.add('is-hidden');
    setProgress(0, false);
}

const isVideoFile = (f) => (f.type && f.type.startsWith('video/')) || VIDEO_EXT.test(f.name || '');

fInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!isVideoFile(file) || (MAX_UPLOAD_BYTES && file.size > MAX_UPLOAD_BYTES)) {
        fInput.value = '';
        showToast('No data packet selected.', 'error');
        return;
    }
    state.uploadFile = file;
    $('drop-ui-default').classList.add('is-hidden');
    $('drop-ui-selected').classList.remove('is-hidden');
    $('selected-name').innerText = file.name;
    $('selected-meta').innerText = `Ready for encryption \u00b7 ${fmtBytes(file.size)}`;
});

['dragenter', 'dragover'].forEach((ev) => dropArea.addEventListener(ev, () => dropArea.classList.add('dragover')));
['dragleave', 'drop'].forEach((ev) => dropArea.addEventListener(ev, () => dropArea.classList.remove('dragover')));

function sendForm(url, fd, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        uploadHolder.xhr = xhr;
        xhr.open('POST', url);
        xhr.responseType = 'text';
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
        xhr.onload = () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch { data = null; }
            resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, data });
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.onabort = () => { const err = new Error('Upload cancelled.'); err.cancelled = true; reject(err); };
        xhr.send(fd);
    });
}

async function transmit(fd, size, onProgress) {
    // Layer 1: direct upload (no custom headers, so no preflight)
    let res = null;
    try {
        res = await sendForm(UPLOAD_URL, fd, onProgress);
    } catch (err) {
        if (err.cancelled) throw err;
        console.warn('Direct upload blocked (CORS/Network).', err);
    }

    // A clear answer from the API (success or a client-side rejection) is final - never upload twice
    if (res && res.data && (res.ok || (res.status < 500 && res.status !== 403))) return res.data;

    // Layer 2: CORS proxy fallback (small files only - a proxy cannot carry multi-GB bodies)
    if (size > PROXY_MAX_BYTES) throw new Error('Transmission failed.');
    showToast('Direct link blocked, routing via proxy...', 'info');
    onProgress(0, size);
    const proxied = await sendForm(PROXY_URL, fd, onProgress);
    if (!proxied.data) throw new Error('Transmission failed.');
    return proxied.data;
}

$('btn-cancel-upload').addEventListener('click', () => { if (uploadHolder.xhr) uploadHolder.xhr.abort(); });

$('btn-submit-upload').addEventListener('click', async () => {
    if (state.uploading) return;
    if (!state.uploadFile) { showToast('No data packet selected.', 'error'); return; }
    if (!state.user) { requireLogin(); return; }

    const btn = $('btn-submit-upload');
    const ogHtml = btn.innerHTML;
    const statsEl = $('upload-stats');
    state.uploading = true;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> <span id="upload-label">Transmitting...</span>`;
    btn.classList.add('is-busy');
    $('btn-cancel-upload').classList.remove('is-hidden');
    statsEl.classList.remove('is-hidden');
    statsEl.textContent = '';
    setProgress(0, true);
    holdScreen();

    const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);

    let lastT = performance.now(), lastLoaded = 0, speed = 0;
    const onProgress = (loaded, total) => {
        const now = performance.now();
        if (now - lastT >= 500) {
            const inst = ((loaded - lastLoaded) / (now - lastT)) * 1000;
            speed = speed ? speed * 0.7 + inst * 0.3 : inst;
            lastT = now; lastLoaded = loaded;
        }
        const frac = total ? loaded / total : 0;
        setProgress(frac, true);
        const label = $('upload-label');
        if (label) label.textContent = `Transmitting... ${Math.floor(frac * 100)}%`;
        statsEl.textContent = loaded >= total
            ? 'Finalizing on the network...'
            : `${fmtBytes(loaded)} of ${fmtBytes(total)} \u00b7 ${fmtBytes(speed)}/s \u00b7 ${fmtTime((total - loaded) / (speed || 1))} left`;
    };

    try {
        showToast('Uploading to secure node...', 'info');
        const fd = new FormData();
        fd.append('file', state.uploadFile);

        const apiData = await transmit(fd, state.uploadFile.size, onProgress);
        if (!apiData.success) throw new Error(apiData.error?.message || 'Transmission failed.');

        showToast('Syncing block to ledger...', 'info');

        const customTitle = $('upload-title').value.trim();
        const meta = {
            id: apiData.video_id,
            title: customTitle || apiData.title || state.uploadFile.name,
            uploader: state.user,
            thumbnail: apiData.thumbnail || NO_THUMB,
            watch_url: apiData.watch_url,
            embed_url: apiData.embed_url,
            delete_url: apiData.delete_url,
            timestamp: Date.now()
        };
        // Firebase rejects undefined values; drop them so a missing optional field can't abort the sync
        Object.keys(meta).forEach((k) => { if (meta[k] === undefined) delete meta[k]; });

        await push(ref(db, path.videos), meta);

        showToast('Broadcast successful.', 'success');
        resetUploadUI();
        switchView('feed');
    } catch (err) {
        console.error(err);
        if (err && err.cancelled) showToast('Upload cancelled.', 'info');
        else showToast(err && err.message ? err.message : 'Transmission failed.', 'error');
    } finally {
        window.removeEventListener('beforeunload', guard);
        releaseScreen();
        uploadHolder.xhr = null;
        state.uploading = false;
        btn.innerHTML = ogHtml;
        btn.classList.remove('is-busy');
        $('btn-cancel-upload').classList.add('is-hidden');
        statsEl.classList.add('is-hidden');
        setProgress(0, false);
    }
});

/* --------------------------- Event wiring --------------------------- */
$('nav-logo').addEventListener('click', () => switchView('feed'));
$('btn-upload-nav').addEventListener('click', () => switchView('upload'));
$('btn-upload-mobile').addEventListener('click', () => switchView('upload'));
$('btn-close-upload').addEventListener('click', () => { if (!state.uploading) switchView('feed'); });
$('btn-settings').addEventListener('click', () => openModal('modal-settings'));

$('btn-hard-refresh').addEventListener('click', async () => {
    try {
        if ('caches' in window) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); }
        if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.update())); }
    } catch { /* reload anyway */ }
    window.location.reload();
});

$('btn-theme-glass').addEventListener('click', () => { state.settings.theme = 'glass'; applySettings(); });
$('btn-theme-neu').addEventListener('click', () => { state.settings.theme = 'neu'; applySettings(); });
document.querySelectorAll('.color-orb').forEach((orb) => {
    orb.addEventListener('click', (e) => { state.settings.accent = e.currentTarget.dataset.color; applySettings(); });
});
$('btn-toggle-sound').addEventListener('click', () => { state.settings.sound = !state.settings.sound; applySettings(); });
$('btn-toggle-haptic').addEventListener('click', () => { state.settings.haptic = !state.settings.haptic; applySettings(); });

$('btn-reset-app').addEventListener('click', async () => {
    if (await askConfirm('Reset All Settings', 'Factory reset all settings?')) {
        store.remove('sk_settings');
        window.location.reload();
    }
});

/* ------------------------------- Boot ------------------------------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

makeAccessible();
applySettings();
updateAuthUI();
switchView('feed');
startFeed();