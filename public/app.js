/* Podcast Editor - frontend */
"use strict";

const $ = (sel) => document.querySelector(sel);
const SRC_COLORS = ["#5aa9ff", "#ff8f5a", "#7bd88f", "#f06292", "#ffd54f", "#4dd0e1", "#b39ddb", "#a1887f"];
const EPS = 0.005;

const fmt = (t, frac = true) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = frac ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
};
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- state
const state = {
  files: [],
  sources: {}, // name -> { name, duration, words, peaks, color }
  project: { name: "podcast", speakers: ["話者A", "話者B"], clips: [] },
  selectedClipId: null,
  selection: null, // { start, end } timeline seconds
  anchorWord: null,
  undo: [],
  redo: [],
  index: { tlWords: [], segments: [], total: 0 },
};

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle("error", isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

// ---------------------------------------------------------------- sources
function sourceColor(name) {
  const i = state.files.findIndex((f) => f.name === name);
  return SRC_COLORS[(i < 0 ? 0 : i) % SRC_COLORS.length];
}

async function loadFiles() {
  state.files = await api("/api/files");
  for (const f of state.files) {
    const s = (state.sources[f.name] ||= { name: f.name, duration: f.duration, words: null, peaks: null });
    s.duration = f.duration;
    s.color = sourceColor(f.name);
    s.hasTranscript = f.hasTranscript;
    s.job = f.job;
  }
  renderFiles();
}

async function ensureSourceData(name) {
  const s = state.sources[name];
  if (!s) return;
  const tasks = [];
  if (!s.peaks) {
    tasks.push(api(`/api/peaks/${encodeURIComponent(name)}`).then((p) => { s.peaks = p.peaks; s.peaksPerSec = p.perSec; drawTimeline(); }).catch(() => {}));
  }
  if (!s.words && s.hasTranscript) {
    tasks.push(api(`/api/transcript/${encodeURIComponent(name)}`).then((t) => { s.words = t.words; }).catch(() => {}));
  }
  await Promise.all(tasks);
}

const saveTranscriptDebounced = debounce(async (name) => {
  const s = state.sources[name];
  try {
    await api(`/api/transcript/${encodeURIComponent(name)}`, { method: "PUT", body: { file: name, duration: s.duration, words: s.words } });
  } catch (e) { toast("文字起こしの保存に失敗: " + e.message, true); }
}, 600);

function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = () => { clearTimeout(t); };
  return d;
}

// ---------------------------------------------------------------- project
const saveProjectDebounced = debounce(async () => {
  try {
    await api("/api/project", { method: "PUT", body: state.project });
    $("#saveState").textContent = "保存済み";
  } catch (e) {
    $("#saveState").textContent = "保存失敗";
    toast("プロジェクトの保存に失敗: " + e.message, true);
  }
}, 500);
function markDirty() {
  $("#saveState").textContent = "保存中…";
  saveProjectDebounced();
}

function pushUndo() {
  state.undo.push(JSON.stringify(state.project.clips));
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  updateUndoButtons();
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.project.clips));
  state.project.clips = JSON.parse(state.undo.pop());
  afterClipsChanged();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.project.clips));
  state.project.clips = JSON.parse(state.redo.pop());
  afterClipsChanged();
}
function updateUndoButtons() {
  $("#undoBtn").disabled = !state.undo.length;
  $("#redoBtn").disabled = !state.redo.length;
}

// ---------------------------------------------------------------- layout / index
function clips() { return state.project.clips; }

function layout() {
  let t = 0;
  const cs = clips();
  cs.forEach((c, i) => {
    c.len = Math.max(0, c.srcEnd - c.srcStart);
    if (i > 0) {
      const prev = cs[i - 1];
      const xf = Math.min(prev.crossfade || 0, prev.len, c.len);
      t = prev.tlEnd - xf;
    }
    c.tlStart = t;
    c.tlEnd = t + c.len;
  });
  state.index.total = cs.length ? cs[cs.length - 1].tlEnd : 0;
}

function buildIndex() {
  layout();
  const tlWords = [];
  const segments = [];
  for (const clip of clips()) {
    const src = state.sources[clip.sourceId];
    segments.push({ type: "clip", clip, noTranscript: !src || !src.words });
    if (!src || !src.words) continue;
    let cur = null;
    for (const w of src.words) {
      const mid = (w.s + w.e) / 2;
      if (mid < clip.srcStart || mid >= clip.srcEnd) continue;
      const tw = { t: w.t, s: clip.tlStart + (w.s - clip.srcStart), e: clip.tlStart + (w.e - clip.srcStart), spk: w.spk, clip, ref: w, src };
      tlWords.push(tw);
      if (!cur || cur.spk !== w.spk || tw.s - cur.e > 1.2 || tw.e - cur.s > 25) {
        cur = { type: "seg", spk: w.spk, s: tw.s, e: tw.e, words: [], clip };
        segments.push(cur);
      }
      cur.words.push(tw);
      cur.e = tw.e;
    }
  }
  tlWords.sort((a, b) => a.s - b.s);
  state.index.tlWords = tlWords;
  state.index.segments = segments;
}

function clipAt(t) {
  const cs = clips();
  for (const c of cs) if (t >= c.tlStart - EPS && t < c.tlEnd) return c;
  return cs.length && t >= state.index.total - EPS ? cs[cs.length - 1] : null;
}

function afterClipsChanged(opts = {}) {
  const t = engine.getTime();
  buildIndex();
  if (!clips().some((c) => c.id === state.selectedClipId)) state.selectedClipId = null;
  if (state.selection) {
    state.selection.start = clamp(state.selection.start, 0, state.index.total);
    state.selection.end = clamp(state.selection.end, 0, state.index.total);
    if (state.selection.end - state.selection.start < EPS) state.selection = null;
  }
  renderTranscript();
  renderClipList();
  renderInspector();
  drawTimeline();
  updateUndoButtons();
  engine.reload(opts.seekTo !== undefined ? opts.seekTo : t);
  markDirty();
}

// ---------------------------------------------------------------- clip ops
function newClip(sourceId, srcStart, srcEnd, base = {}) {
  return { id: uid(), sourceId, srcStart, srcEnd, fadeIn: 0, fadeOut: 0, crossfade: 0, ...base, id: uid() };
}

function addClipFromSource(name) {
  const s = state.sources[name];
  if (!s) return;
  pushUndo();
  clips().push(newClip(name, 0, s.duration));
  ensureSourceData(name).then(() => afterClipsChanged());
  afterClipsChanged();
  toast(`${name} をタイムラインに追加しました`);
}

// クリップを t(タイムライン秒) で分割。分割できたら true
function splitAtInternal(t) {
  const cs = clips();
  const i = cs.findIndex((c) => t > c.tlStart + EPS && t < c.tlEnd - EPS);
  if (i < 0) return false;
  const c = cs[i];
  const srcCut = c.srcStart + (t - c.tlStart);
  const a = { ...c, srcEnd: srcCut, fadeOut: 0, crossfade: 0 };
  const b = { ...c, id: uid(), srcStart: srcCut, fadeIn: 0 };
  cs.splice(i, 1, a, b);
  layout();
  return true;
}
function splitAt(t) {
  pushUndo();
  if (!splitAtInternal(t)) { state.undo.pop(); toast("ここでは分割できません"); return; }
  afterClipsChanged();
}

function cutRange(start, end) {
  if (!(end - start > EPS)) return;
  pushUndo();
  splitAtInternal(end);
  splitAtInternal(start);
  const cs = clips();
  const keep = cs.filter((c) => !(c.tlStart >= start - EPS && c.tlEnd <= end + EPS));
  if (keep.length === cs.length) { state.undo.pop(); toast("カット対象がありません"); return; }
  state.project.clips = keep;
  state.selection = null;
  afterClipsChanged({ seekTo: start });
  toast(`${fmt(end - start)} をカットしました`);
}

function deleteClip(id) {
  const cs = clips();
  const i = cs.findIndex((c) => c.id === id);
  if (i < 0) return;
  pushUndo();
  const t = cs[i].tlStart;
  cs.splice(i, 1);
  afterClipsChanged({ seekTo: t });
}

function moveClip(id, dir) {
  const cs = clips();
  const i = cs.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cs.length) return;
  pushUndo();
  [cs[i], cs[j]] = [cs[j], cs[i]];
  afterClipsChanged();
}

function updateClip(id, patch) {
  const c = clips().find((x) => x.id === id);
  if (!c) return;
  pushUndo();
  Object.assign(c, patch);
  const src = state.sources[c.sourceId];
  c.srcStart = clamp(c.srcStart, 0, (src ? src.duration : c.srcEnd) - 0.05);
  c.srcEnd = clamp(c.srcEnd, c.srcStart + 0.05, src ? src.duration : c.srcEnd);
  c.fadeIn = clamp(c.fadeIn || 0, 0, c.srcEnd - c.srcStart);
  c.fadeOut = clamp(c.fadeOut || 0, 0, c.srcEnd - c.srcStart);
  c.crossfade = Math.max(0, c.crossfade || 0);
  afterClipsChanged();
}

function swapSpeakersInRange(start, end) {
  const touched = new Set();
  for (const tw of state.index.tlWords) {
    const mid = (tw.s + tw.e) / 2;
    if (mid >= start && mid < end) { tw.ref.spk = tw.ref.spk === 0 ? 1 : 0; touched.add(tw.src.name); }
  }
  if (!touched.size) return toast("選択範囲に文字がありません");
  for (const n of touched) saveTranscriptDebounced(n);
  buildIndex();
  renderTranscript();
}

// ---------------------------------------------------------------- playback engine
class Engine {
  constructor() {
    this.ctx = null;
    this.pools = new Map();
    this.playing = false;
    this.pausedAt = 0;
    this.active = null; // { clip, node }
    this.fading = new Set();
    this.timer = null;
    this.onEnded = null;
  }
  init() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 40);
  }
  makeNode(sourceId) {
    const el = new Audio(`/audio/${encodeURIComponent(sourceId)}`);
    el.preload = "auto";
    const src = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.ctx.destination);
    return { el, gain, src, sourceId, busy: false };
  }
  acquire(sourceId) {
    let pool = this.pools.get(sourceId);
    if (!pool) { pool = []; this.pools.set(sourceId, pool); }
    let node = pool.find((n) => !n.busy);
    if (!node) {
      if (pool.length < 2) { node = this.makeNode(sourceId); pool.push(node); }
      else { node = pool[0]; this.releaseNode(node); }
    }
    node.busy = true;
    return node;
  }
  releaseNode(node) {
    clearTimeout(node.releaseTimer);
    node.el.pause();
    const g = node.gain.gain;
    g.cancelScheduledValues(0);
    g.value = 1;
    node.busy = false;
    this.fading.delete(node);
  }
  stopAll() {
    if (this.active) { this.releaseNode(this.active.node); this.active = null; }
    for (const n of [...this.fading]) this.releaseNode(n);
  }
  startClip(clip, offset, viaTransition = false) {
    const cs = clips();
    const i = cs.indexOf(clip);
    const node = this.acquire(clip.sourceId);
    const now = this.ctx.currentTime;
    const g = node.gain.gain;
    g.cancelScheduledValues(now);
    const len = clip.len;
    const remaining = Math.max(0, len - offset);
    const xfPrev = viaTransition && i > 0 ? Math.min(cs[i - 1].crossfade || 0, cs[i - 1].len, len) : 0;
    const rampIn = xfPrev > 0 ? xfPrev : clip.fadeIn || 0;
    let v = 1;
    let tIn = now;
    if (rampIn > 0 && offset < rampIn) { v = offset / rampIn; tIn = now + (rampIn - offset); }
    g.setValueAtTime(v, now);
    if (tIn > now) g.linearRampToValueAtTime(1, tIn);
    const fo = clip.fadeOut || 0;
    if (fo > 0) {
      const foStart = len - fo;
      if (offset < foStart) {
        g.setValueAtTime(1, Math.max(tIn, now + (foStart - offset)));
        g.linearRampToValueAtTime(0, now + remaining);
      } else {
        g.cancelScheduledValues(now);
        g.setValueAtTime(clamp(remaining / fo, 0, 1), now);
        g.linearRampToValueAtTime(0, now + remaining);
      }
    }
    node.el.currentTime = clip.srcStart + offset;
    node.el.play().catch((e) => { if (e.name !== "AbortError") toast("再生できません: " + e.message, true); });
    this.active = { clip, node, preloaded: false };
  }
  play() {
    this.init();
    if (!clips().length) return;
    if (this.pausedAt >= state.index.total - EPS) this.pausedAt = 0;
    const clip = clipAt(this.pausedAt);
    if (!clip) return;
    this.playing = true;
    this.startClip(clip, this.pausedAt - clip.tlStart);
  }
  pause() {
    if (!this.playing) return;
    this.pausedAt = this.getTime();
    this.playing = false;
    this.stopAll();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    t = clamp(t, 0, state.index.total);
    const was = this.playing;
    this.playing = false;
    this.stopAll();
    this.pausedAt = t;
    if (was) this.play();
  }
  reload(t) {
    const was = this.playing;
    this.playing = false;
    this.stopAll();
    this.pausedAt = clamp(t, 0, state.index.total);
    if (was && clips().length) this.play();
  }
  getTime() {
    if (this.playing && this.active) {
      const { clip, node } = this.active;
      return clamp(clip.tlStart + (node.el.currentTime - clip.srcStart), clip.tlStart, clip.tlEnd);
    }
    return this.pausedAt;
  }
  tick() {
    if (!this.playing || !this.active) return;
    const { clip, node } = this.active;
    const cs = clips();
    const i = cs.indexOf(clip);
    if (i < 0) return;
    const pos = node.el.currentTime - clip.srcStart;
    const next = cs[i + 1];
    const xf = next ? Math.min(clip.crossfade || 0, clip.len, next.len) : 0;
    if (pos >= clip.len - xf - 0.03 || node.el.ended) {
      if (next) this.transition(next, xf);
      else {
        this.playing = false;
        this.pausedAt = state.index.total;
        this.stopAll();
        if (this.onEnded) this.onEnded();
      }
      return;
    }
    if (next && !this.active.preloaded && clip.len - pos < 4) {
      this.active.preloaded = true;
      const pool = this.pools.get(next.sourceId) || [];
      let n = pool.find((x) => !x.busy);
      if (!n && pool.length < 2) { n = this.makeNode(next.sourceId); pool.push(n); this.pools.set(next.sourceId, pool); }
      if (n && Math.abs(n.el.currentTime - next.srcStart) > 0.5) n.el.currentTime = next.srcStart;
    }
  }
  transition(next, xf) {
    const old = this.active;
    this.active = null;
    this.startClip(next, 0, true);
    if (xf > 0.01) {
      const now = this.ctx.currentTime;
      const g = old.node.gain.gain;
      const v = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(v, now);
      g.linearRampToValueAtTime(0, now + xf);
      this.fading.add(old.node);
      old.node.releaseTimer = setTimeout(() => this.releaseNode(old.node), xf * 1000 + 60);
    } else {
      this.releaseNode(old.node);
    }
  }
  dispose() {
    this.playing = false;
    this.stopAll();
    clearInterval(this.timer);
    this.timer = null;
    for (const pool of this.pools.values()) {
      for (const n of pool) {
        n.el.pause();
        n.el.removeAttribute("src");
        n.el.load();
        n.src.disconnect();
        n.gain.disconnect();
      }
    }
    this.pools.clear();
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
const engine = new Engine();
engine.onEnded = () => updatePlayButton();

// ---------------------------------------------------------------- rendering: files
let pollTimer = null;
function renderFiles() {
  const root = $("#fileList");
  root.innerHTML = "";
  let anyRunning = false;
  for (const f of state.files) {
    const s = state.sources[f.name];
    const div = document.createElement("div");
    div.className = "file";
    const job = s.job;
    const running = job && job.state === "running";
    if (running) anyRunning = true;
    div.innerHTML = `
      <div class="name"><span class="src-dot" style="background:${s.color}"></span><span>${esc(f.name)}</span></div>
      <div class="meta">${fmt(f.duration, false)} ・ ${s.hasTranscript ? "文字起こし済み" : "文字起こしなし"}</div>
      <div class="actions">
        <button class="small add">＋ タイムラインに追加</button>
        <button class="small tr" ${running ? "disabled" : ""}>${s.hasTranscript ? "再文字起こし" : "文字起こし"}</button>
      </div>
      ${running ? `<div class="progress"><div style="width:${Math.round((job.progress || 0) * 100)}%"></div></div><div class="job-msg">${esc(job.message || "")}</div>` : ""}
      ${job && job.state === "error" ? `<div class="job-msg error">エラー: ${esc(job.error || "")}</div>` : ""}
    `;
    div.querySelector(".add").onclick = () => addClipFromSource(f.name);
    div.querySelector(".tr").onclick = async () => {
      if (s.hasTranscript && !confirm("既存の文字起こしを置き換えます。よろしいですか？")) return;
      try {
        s.job = await api(`/api/transcribe/${encodeURIComponent(f.name)}`, { method: "POST" });
        renderFiles();
      } catch (e) { toast("文字起こし開始に失敗: " + e.message, true); }
    };
    root.appendChild(div);
  }
  clearTimeout(pollTimer);
  if (anyRunning) pollTimer = setTimeout(pollJobs, 2000);
}

async function pollJobs() {
  let changed = false;
  for (const f of state.files) {
    const s = state.sources[f.name];
    if (!s.job || s.job.state !== "running") continue;
    try {
      const job = await api(`/api/transcribe/${encodeURIComponent(f.name)}/status`);
      s.job = job;
      if (job.state === "done") {
        s.hasTranscript = true;
        s.words = null;
        changed = true;
        toast(`${f.name} の文字起こしが完了しました`);
        await ensureSourceData(f.name);
      } else if (job.state === "error") {
        toast(`文字起こしエラー: ${job.error}`, true);
      }
    } catch {}
  }
  renderFiles();
  if (changed) afterClipsChanged();
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------------------------------------------------------------- rendering: transcript
let wordEls = []; // parallel to state.index.tlWords
let curWordIdx = -1;

function renderTranscript() {
  const root = $("#transcript");
  const scrollTop = root.scrollTop;
  root.innerHTML = "";
  wordEls = new Array(state.index.tlWords.length);
  curWordIdx = -1;
  const idxOf = new Map(state.index.tlWords.map((w, i) => [w, i]));
  const frag = document.createDocumentFragment();
  if (!clips().length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "左の音源一覧から「タイムラインに追加」してください。";
    frag.appendChild(p);
  }
  for (const seg of state.index.segments) {
    if (seg.type === "clip") {
      const c = seg.clip;
      const src = state.sources[c.sourceId];
      const d = document.createElement("div");
      d.className = "clipmark" + (c.id === state.selectedClipId ? " selected" : "");
      d.style.setProperty("--src-color", src ? src.color : "#888");
      const fx = [];
      if (c.fadeIn) fx.push(`FI ${c.fadeIn}s`);
      if (c.fadeOut) fx.push(`FO ${c.fadeOut}s`);
      if (c.crossfade) fx.push(`XF ${c.crossfade}s`);
      d.innerHTML = `<span class="src">${esc(c.sourceId)}</span><span>${fmt(c.srcStart)} – ${fmt(c.srcEnd)}</span><span>(TL ${fmt(c.tlStart)})</span><span class="fx">${fx.join(" ")}</span>`;
      d.onclick = () => { selectClip(c.id); engine.seek(c.tlStart); refreshTime(true); };
      frag.appendChild(d);
      if (seg.noTranscript) {
        const n = document.createElement("div");
        n.className = "nots";
        n.textContent = src && src.job && src.job.state === "running" ? "文字起こし中…" : "（文字起こしなし）";
        frag.appendChild(n);
      }
      continue;
    }
    const d = document.createElement("div");
    d.className = "seg";
    d.dataset.spk = seg.spk;
    const head = document.createElement("div");
    head.className = "seg-head";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmt(seg.s);
    time.onclick = () => { engine.seek(seg.s); refreshTime(true); };
    const spk = document.createElement("button");
    spk.className = "spk";
    spk.textContent = state.project.speakers[seg.spk] || `話者${seg.spk + 1}`;
    spk.title = "クリックで話者を切替";
    spk.onclick = () => {
      for (const tw of seg.words) tw.ref.spk = seg.spk === 0 ? 1 : 0;
      saveTranscriptDebounced(seg.words[0].src.name);
      buildIndex();
      renderTranscript();
    };
    head.append(time, spk);
    const text = document.createElement("div");
    text.className = "seg-text";
    for (const tw of seg.words) {
      const i = idxOf.get(tw);
      const sp = document.createElement("span");
      sp.className = "w";
      sp.textContent = tw.t;
      sp.dataset.i = i;
      wordEls[i] = sp;
      text.appendChild(sp);
    }
    d.append(head, text);
    frag.appendChild(d);
  }
  root.appendChild(frag);
  root.scrollTop = scrollTop;
  applySelectionHighlight();
  applySearch();
}

// word interactions (delegated)
(function setupTranscriptInteractions() {
  const root = $("#transcript");
  let dragAnchor = null;
  let dragging = false;
  const wordFromEvent = (e) => {
    const el = e.target.closest(".w");
    return el ? Number(el.dataset.i) : null;
  };
  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const i = wordFromEvent(e);
    if (i === null) return;
    dragAnchor = i;
    dragging = false;
  });
  root.addEventListener("mousemove", (e) => {
    if (dragAnchor === null || !(e.buttons & 1)) return;
    const i = wordFromEvent(e);
    if (i === null || i === dragAnchor && !dragging) return;
    dragging = true;
    setWordSelection(dragAnchor, i);
  });
  root.addEventListener("mouseup", (e) => {
    const i = wordFromEvent(e);
    if (dragAnchor === null) return;
    if (!dragging && i !== null) {
      if (e.shiftKey && state.anchorWord !== null) {
        setWordSelection(state.anchorWord, i);
      } else {
        state.anchorWord = i;
        const tw = state.index.tlWords[i];
        engine.seek(tw.s + 0.001);
        refreshTime(false);
      }
    } else if (dragging) {
      state.anchorWord = dragAnchor;
    }
    dragAnchor = null;
    dragging = false;
  });
  root.addEventListener("dblclick", (e) => {
    const i = wordFromEvent(e);
    if (i === null) return;
    editWord(i);
  });
})();

function setWordSelection(a, b) {
  const [i, j] = a <= b ? [a, b] : [b, a];
  const ws = state.index.tlWords;
  state.selection = { start: ws[i].s, end: ws[j].e };
  applySelectionHighlight();
  drawTimeline();
}

function applySelectionHighlight() {
  const sel = state.selection;
  const ws = state.index.tlWords;
  for (let i = 0; i < ws.length; i++) {
    const el = wordEls[i];
    if (!el) continue;
    const mid = (ws[i].s + ws[i].e) / 2;
    el.classList.toggle("sel", !!sel && mid >= sel.start && mid < sel.end);
  }
  $("#selInfo").textContent = sel ? `${fmt(sel.start)} – ${fmt(sel.end)} (${fmt(sel.end - sel.start)})` : "";
  $("#cutBtn").disabled = !sel;
  $("#swapSpkBtn").disabled = !sel;
}

function setSelectionBound(which) {
  const t = engine.getTime();
  const sel = state.selection || { start: t, end: t };
  if (which === "start") { sel.start = t; if (sel.end < t) sel.end = t; }
  else { sel.end = t; if (sel.start > t) sel.start = t; }
  state.selection = sel.end - sel.start > EPS ? sel : { start: sel.start, end: sel.end };
  applySelectionHighlight();
  drawTimeline();
}

function clearSelection() {
  state.selection = null;
  applySelectionHighlight();
  drawTimeline();
}

function editWord(i) {
  const tw = state.index.tlWords[i];
  const el = wordEls[i];
  if (!tw || !el) return;
  const input = document.createElement("input");
  input.className = "w-edit";
  input.value = tw.t;
  input.style.width = Math.max(40, tw.t.length * 18 + 20) + "px";
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value !== tw.t) {
      tw.ref.t = input.value;
      saveTranscriptDebounced(tw.src.name);
    }
    buildIndex();
    renderTranscript();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

function applySearch() {
  const q = $("#search").value.trim();
  const ws = state.index.tlWords;
  let first = -1;
  for (let i = 0; i < ws.length; i++) {
    const hit = q && ws[i].t.includes(q);
    if (wordEls[i]) wordEls[i].classList.toggle("hit", !!hit);
    if (hit && first < 0) first = i;
  }
  return first;
}

function updateCurrentWord(t) {
  const ws = state.index.tlWords;
  // 最後の s <= t の単語
  let lo = 0, hi = ws.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ws[mid].s <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx !== curWordIdx) {
    if (curWordIdx >= 0 && wordEls[curWordIdx]) wordEls[curWordIdx].classList.remove("cur");
    curWordIdx = idx;
    if (idx >= 0 && wordEls[idx]) {
      wordEls[idx].classList.add("cur");
      if ($("#follow").checked) scrollWordIntoView(wordEls[idx]);
    }
  }
}

function scrollWordIntoView(el) {
  const root = $("#transcript");
  const r = el.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  if (r.top < rr.top + 40 || r.bottom > rr.bottom - 80) {
    root.scrollTo({ top: root.scrollTop + (r.top - rr.top) - rr.height * 0.35, behavior: "smooth" });
  }
}

// ---------------------------------------------------------------- rendering: clip list + inspector
function selectClip(id) {
  state.selectedClipId = id;
  renderClipList();
  renderInspector();
  drawTimeline();
  document.querySelectorAll(".clipmark").forEach((el) => el.classList.remove("selected"));
}

function renderClipList() {
  const root = $("#clipList");
  root.innerHTML = "";
  if (!clips().length) root.innerHTML = '<p class="muted">クリップがありません</p>';
  clips().forEach((c, i) => {
    const src = state.sources[c.sourceId];
    const d = document.createElement("div");
    d.className = "clip-item" + (c.id === state.selectedClipId ? " selected" : "");
    d.innerHTML = `<div class="bar" style="background:${src ? src.color : "#888"}"></div>
      <div><div class="n">${i + 1}. ${esc(c.sourceId)}</div><div class="t">${fmt(c.tlStart)} → ${fmt(c.tlEnd)} (${fmt(c.len)})</div></div>
      <div class="t">${c.crossfade ? "XF" : ""}</div>`;
    d.onclick = () => { selectClip(c.id); engine.seek(c.tlStart); refreshTime(true); };
    root.appendChild(d);
  });
}

function renderInspector() {
  const root = $("#inspectorBody");
  const c = clips().find((x) => x.id === state.selectedClipId);
  if (!c) { root.innerHTML = '<p class="muted">タイムライン上のクリップを選択してください</p>'; return; }
  const i = clips().indexOf(c);
  const hasNext = i < clips().length - 1;
  const num = (label, key, step = 0.1, min = 0) => `
    <div class="row"><label>${label}</label><input type="number" data-key="${key}" step="${step}" min="${min}" value="${(+c[key] || 0).toFixed(2)}"></div>`;
  root.innerHTML = `
    <div class="src-name" style="color:${state.sources[c.sourceId]?.color || "#fff"}">${i + 1}. ${esc(c.sourceId)}</div>
    <div class="muted" style="font-size:12px">タイムライン ${fmt(c.tlStart)} → ${fmt(c.tlEnd)}（長さ ${fmt(c.len)}）</div>
    ${num("元音源の開始 (秒)", "srcStart", 0.1)}
    ${num("元音源の終了 (秒)", "srcEnd", 0.1)}
    ${num("フェードイン (秒)", "fadeIn", 0.1)}
    ${num("フェードアウト (秒)", "fadeOut", 0.1)}
    ${hasNext ? num("次とのクロスフェード (秒)", "crossfade", 0.1) : '<div class="muted" style="font-size:12px">（最後のクリップ: クロスフェードなし）</div>'}
    <div class="btns">
      <button class="small" data-act="split">再生位置で分割</button>
      <button class="small" data-act="up" ${i === 0 ? "disabled" : ""}>◀ 前へ</button>
      <button class="small" data-act="down" ${hasNext ? "" : "disabled"}>後ろへ ▶</button>
      <button class="small danger" data-act="del">削除</button>
    </div>`;
  root.querySelectorAll("input[type=number]").forEach((inp) => {
    inp.onchange = () => updateClip(c.id, { [inp.dataset.key]: parseFloat(inp.value) || 0 });
    inp.onkeydown = (e) => e.stopPropagation();
  });
  root.querySelector('[data-act="split"]').onclick = () => splitAt(engine.getTime());
  root.querySelector('[data-act="up"]').onclick = () => moveClip(c.id, -1);
  root.querySelector('[data-act="down"]').onclick = () => moveClip(c.id, 1);
  root.querySelector('[data-act="del"]').onclick = () => deleteClip(c.id);
}

// ---------------------------------------------------------------- timeline canvas
const canvas = $("#timeline");
const ctx2d = canvas.getContext("2d");
const TL = { rulerH: 18, top: 24, clipH: 72 };

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const g = ctx2d;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#15171c";
  g.fillRect(0, 0, W, H);
  const total = Math.max(state.index.total, 1);
  const x = (t) => (t / total) * W;

  // ruler
  const step = pickStep(total / W);
  g.fillStyle = "#8b93a5";
  g.font = "10px ui-monospace, monospace";
  g.textBaseline = "top";
  for (let t = 0; t <= total; t += step) {
    const px = x(t);
    g.fillRect(px, TL.rulerH - 5, 1, 5);
    g.fillText(fmt(t, false), px + 3, 2);
  }

  // clips
  for (const c of clips()) {
    const src = state.sources[c.sourceId];
    const x0 = x(c.tlStart), x1 = x(c.tlEnd);
    const color = src ? src.color : "#888";
    g.fillStyle = hexA(color, 0.18);
    g.fillRect(x0, TL.top, x1 - x0, TL.clipH);
    if (src && src.peaks) {
      g.fillStyle = hexA(color, 0.85);
      const mid = TL.top + TL.clipH / 2;
      const perSec = src.peaksPerSec || 20;
      for (let px = Math.floor(x0); px < x1; px++) {
        const t0 = c.srcStart + ((px - x0) / (x1 - x0)) * c.len;
        const t1 = c.srcStart + ((px + 1 - x0) / (x1 - x0)) * c.len;
        let peak = 0;
        for (let k = Math.floor(t0 * perSec); k <= Math.floor(t1 * perSec) && k < src.peaks.length; k++) peak = Math.max(peak, src.peaks[k]);
        const h = Math.max(1, peak * (TL.clipH / 2 - 4));
        g.fillRect(px, mid - h, 1, h * 2);
      }
    }
    // fades
    g.strokeStyle = "#ffb454";
    g.lineWidth = 1.5;
    if (c.fadeIn) { g.beginPath(); g.moveTo(x0, TL.top + TL.clipH); g.lineTo(x0 + (c.fadeIn / c.len) * (x1 - x0), TL.top); g.stroke(); }
    if (c.fadeOut) { g.beginPath(); g.moveTo(x1, TL.top + TL.clipH); g.lineTo(x1 - (c.fadeOut / c.len) * (x1 - x0), TL.top); g.stroke(); }
    // border
    g.strokeStyle = c.id === state.selectedClipId ? "#ffffff" : hexA(color, 0.9);
    g.lineWidth = c.id === state.selectedClipId ? 2 : 1;
    g.strokeRect(x0 + 0.5, TL.top + 0.5, x1 - x0 - 1, TL.clipH - 1);
  }
  // crossfade regions
  const cs = clips();
  for (let i = 0; i < cs.length - 1; i++) {
    const a = cs[i], b = cs[i + 1];
    if (b.tlStart < a.tlEnd - EPS) {
      g.fillStyle = "rgba(255,180,84,0.35)";
      g.fillRect(x(b.tlStart), TL.top, x(a.tlEnd) - x(b.tlStart), TL.clipH);
    }
  }
  // selection
  if (state.selection) {
    g.fillStyle = "rgba(255,205,80,0.25)";
    g.fillRect(x(state.selection.start), TL.rulerH, x(state.selection.end) - x(state.selection.start), H - TL.rulerH);
    g.fillStyle = "#ffcd50";
    g.fillRect(x(state.selection.start), TL.rulerH, 1, H - TL.rulerH);
    g.fillRect(x(state.selection.end) - 1, TL.rulerH, 1, H - TL.rulerH);
  }
  // playhead
  const px = x(engine.getTime());
  g.fillStyle = "#ff5a5a";
  g.fillRect(px - 0.5, 0, 1.5, H);
  g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill();
}
function pickStep(secPerPx) {
  const target = secPerPx * 90;
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]) if (s >= target) return s;
  return 3600;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

(function setupTimelineInteractions() {
  let scrubbing = false;
  const tAt = (e) => clamp((e.offsetX / canvas.clientWidth) * state.index.total, 0, state.index.total);
  canvas.addEventListener("mousedown", (e) => {
    const t = tAt(e);
    const c = clipAt(t);
    if (c) selectClip(c.id);
    scrubbing = true;
    engine.seek(t);
    refreshTime(true);
  });
  window.addEventListener("mousemove", (e) => {
    if (!scrubbing) return;
    const rect = canvas.getBoundingClientRect();
    const t = clamp(((e.clientX - rect.left) / rect.width) * state.index.total, 0, state.index.total);
    if (!engine.playing) { engine.pausedAt = t; refreshTime(true); }
  });
  window.addEventListener("mouseup", (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    const rect = canvas.getBoundingClientRect();
    const t = clamp(((e.clientX - rect.left) / rect.width) * state.index.total, 0, state.index.total);
    if (engine.playing) engine.seek(t);
    refreshTime(true);
  });
  new ResizeObserver(() => drawTimeline()).observe(canvas);
})();

// ---------------------------------------------------------------- transport / loop
function updatePlayButton() { $("#playBtn").textContent = engine.playing ? "⏸" : "▶"; }

function refreshTime(force) {
  const t = engine.getTime();
  $("#timeNow").textContent = fmt(t);
  $("#timeTotal").textContent = fmt(state.index.total);
  updateCurrentWord(t);
  if (force || engine.playing) drawTimeline();
}
(function loop() {
  if (engine.playing) refreshTime(false);
  updatePlayButton();
  requestAnimationFrame(loop);
})();

// ---------------------------------------------------------------- export
async function doExport() {
  if (!clips().length) return toast("クリップがありません", true);
  const btn = $("#exportBtn");
  btn.disabled = true;
  btn.textContent = "書き出し中…";
  $("#exportLink").hidden = true;
  try {
    const res = await api("/api/export", {
      method: "POST",
      body: { clips: clips().map(({ sourceId, srcStart, srcEnd, fadeIn, fadeOut, crossfade }) => ({ sourceId, srcStart, srcEnd, fadeIn, fadeOut, crossfade })), format: $("#exportFormat").value, name: state.project.name },
    });
    const a = $("#exportLink");
    a.href = res.url;
    a.download = res.fileName;
    a.textContent = `⬇ ${res.fileName}`;
    a.hidden = false;
    toast(`書き出し完了 (${(res.ms / 1000).toFixed(1)}s): exports/${res.fileName}`);
  } catch (e) {
    toast("書き出し失敗: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "書き出し";
  }
}

// ---------------------------------------------------------------- keyboard & buttons
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}
window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  switch (e.key) {
    case " ": e.preventDefault(); engine.toggle(); refreshTime(true); break;
    case "ArrowLeft": e.preventDefault(); engine.seek(engine.getTime() - (e.shiftKey ? 1 : 5)); refreshTime(true); break;
    case "ArrowRight": e.preventDefault(); engine.seek(engine.getTime() + (e.shiftKey ? 1 : 5)); refreshTime(true); break;
    case "i": case "I": setSelectionBound("start"); break;
    case "o": case "O": setSelectionBound("end"); break;
    case "s": case "S": splitAt(engine.getTime()); break;
    case "Delete": case "Backspace": e.preventDefault(); if (state.selection) cutRange(state.selection.start, state.selection.end); break;
    case "Escape": clearSelection(); break;
    case "Home": engine.seek(0); refreshTime(true); break;
  }
});

$("#playBtn").onclick = () => { engine.toggle(); refreshTime(true); };
$("#toStart").onclick = () => { engine.seek(0); refreshTime(true); };
$("#splitBtn").onclick = () => splitAt(engine.getTime());
$("#cutBtn").onclick = () => state.selection && cutRange(state.selection.start, state.selection.end);
$("#inBtn").onclick = () => setSelectionBound("start");
$("#outBtn").onclick = () => setSelectionBound("end");
$("#clearSelBtn").onclick = clearSelection;
$("#swapSpkBtn").onclick = () => state.selection && swapSpeakersInRange(state.selection.start, state.selection.end);
$("#undoBtn").onclick = undo;
$("#redoBtn").onclick = redo;
$("#exportBtn").onclick = doExport;
$("#reloadFiles").onclick = () => loadFiles();
$("#search").oninput = () => {
  const first = applySearch();
  if (first >= 0 && wordEls[first]) scrollWordIntoView(wordEls[first]);
};
$("#search").onkeydown = (e) => { if (e.key === "Enter") { const first = applySearch(); if (first >= 0) { engine.seek(state.index.tlWords[first].s); refreshTime(true); } } };
$("#projectName").onchange = (e) => { state.project.name = e.target.value || "podcast"; markDirty(); };
for (const k of [0, 1]) {
  $(`#spkName${k}`).oninput = (e) => {
    state.project.speakers[k] = e.target.value;
    document.querySelectorAll(`.seg[data-spk="${k}"] .spk`).forEach((b) => (b.textContent = e.target.value));
    markDirty();
  };
}
window.addEventListener("beforeunload", () => engine.dispose());

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    await loadFiles();
    const proj = await api("/api/project");
    if (proj && Array.isArray(proj.clips)) {
      state.project = { name: "podcast", speakers: ["話者A", "話者B"], ...proj };
      state.project.clips = state.project.clips.filter((c) => state.sources[c.sourceId]);
    } else if (state.files.length) {
      state.project.clips.push(newClip(state.files[0].name, 0, state.files[0].duration));
    }
    $("#projectName").value = state.project.name;
    $("#spkName0").value = state.project.speakers[0] || "話者A";
    $("#spkName1").value = state.project.speakers[1] || "話者B";
    buildIndex();
    renderTranscript();
    renderClipList();
    drawTimeline();
    refreshTime(true);
    const names = [...new Set(clips().map((c) => c.sourceId))];
    await Promise.all(names.map(ensureSourceData));
    buildIndex();
    renderTranscript();
    renderClipList();
    drawTimeline();
    refreshTime(true);
    updateUndoButtons();
    if (state.files.some((f) => f.job && f.job.state === "running")) renderFiles();
  } catch (e) {
    toast("初期化エラー: " + e.message, true);
    console.error(e);
  }
})();
