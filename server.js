import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeDuration, computePeaks, exportTimeline } from "./lib/ffmpeg.js";
import { transcribeFile } from "./lib/gemini.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(ROOT, "audio");
const DATA_DIR = path.join(ROOT, "data");
const TRANSCRIPT_DIR = path.join(DATA_DIR, "transcripts");
const PEAKS_DIR = path.join(DATA_DIR, "peaks");
const CHUNK_DIR = path.join(DATA_DIR, "chunks");
const EXPORT_DIR = path.join(ROOT, "exports");
const PROJECT_FILE = path.join(DATA_DIR, "project.json");
const PORT = process.env.PORT || 3456;

// .env 読み込み (依存なし)
try {
  const env = await fs.readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

for (const d of [TRANSCRIPT_DIR, PEAKS_DIR, CHUNK_DIR, EXPORT_DIR]) await fs.mkdir(d, { recursive: true });

const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".aiff", ".aif", ".mp4"]);
const safeName = (name) => {
  const base = path.basename(name);
  if (base !== name || name.includes("..")) throw Object.assign(new Error("invalid name"), { status: 400 });
  return base;
};
const audioPath = (name) => path.join(AUDIO_DIR, safeName(name));
const transcriptPath = (name) => path.join(TRANSCRIPT_DIR, safeName(name) + ".json");
const exists = (p) => fs.access(p).then(() => true, () => false);

const durationCache = new Map();
async function getDuration(name) {
  if (!durationCache.has(name)) durationCache.set(name, await probeDuration(audioPath(name)));
  return durationCache.get(name);
}

const jobs = new Map(); // name -> {state, message, progress, error}

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/audio", express.static(AUDIO_DIR, { acceptRanges: true }));
app.use("/exports", express.static(EXPORT_DIR));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});

app.get("/api/files", wrap(async (req, res) => {
  const entries = await fs.readdir(AUDIO_DIR);
  const files = [];
  for (const name of entries.sort()) {
    if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
    let duration = null;
    try { duration = await getDuration(name); } catch { continue; }
    files.push({
      name,
      duration,
      hasTranscript: await exists(transcriptPath(name)),
      job: jobs.get(name) || null,
    });
  }
  res.json(files);
}));

app.get("/api/peaks/:name", wrap(async (req, res) => {
  const name = safeName(req.params.name);
  const cache = path.join(PEAKS_DIR, name + ".json");
  if (await exists(cache)) return res.type("json").send(await fs.readFile(cache));
  const peaks = await computePeaks(audioPath(name));
  const body = JSON.stringify({ perSec: 20, peaks });
  await fs.writeFile(cache, body);
  res.type("json").send(body);
}));

app.get("/api/transcript/:name", wrap(async (req, res) => {
  const p = transcriptPath(req.params.name);
  if (!(await exists(p))) return res.status(404).json({ error: "not transcribed" });
  res.type("json").send(await fs.readFile(p));
}));

app.put("/api/transcript/:name", wrap(async (req, res) => {
  const p = transcriptPath(req.params.name);
  const body = req.body;
  if (!body || !Array.isArray(body.words)) throw Object.assign(new Error("words required"), { status: 400 });
  await fs.writeFile(p, JSON.stringify(body));
  res.json({ ok: true });
}));

app.post("/api/transcribe/:name", wrap(async (req, res) => {
  const name = safeName(req.params.name);
  if (!(await exists(audioPath(name)))) return res.status(404).json({ error: "file not found" });
  const current = jobs.get(name);
  if (current && current.state === "running") return res.json(current);
  const job = { state: "running", message: "開始", progress: 0, error: null, startedAt: Date.now() };
  jobs.set(name, job);
  res.json(job);
  (async () => {
    try {
      const duration = await getDuration(name);
      const result = await transcribeFile(audioPath(name), duration, CHUNK_DIR, (message, progress) => {
        job.message = message;
        job.progress = progress;
      });
      await fs.writeFile(transcriptPath(name), JSON.stringify({ file: name, duration, ...result }));
      job.state = "done";
      job.progress = 1;
    } catch (e) {
      console.error("transcribe failed", e);
      job.state = "error";
      job.error = e.message;
    }
  })();
}));

app.get("/api/transcribe/:name/status", wrap(async (req, res) => {
  res.json(jobs.get(safeName(req.params.name)) || { state: "idle" });
}));

app.get("/api/project", wrap(async (req, res) => {
  if (!(await exists(PROJECT_FILE))) return res.json(null);
  res.type("json").send(await fs.readFile(PROJECT_FILE));
}));

app.put("/api/project", wrap(async (req, res) => {
  await fs.writeFile(PROJECT_FILE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
}));

app.post("/api/export", wrap(async (req, res) => {
  const { clips, format = "mp3", name = "export" } = req.body || {};
  if (!Array.isArray(clips) || clips.length === 0) throw Object.assign(new Error("clips required"), { status: 400 });
  const fmt = ["mp3", "wav", "m4a"].includes(format) ? format : "mp3";
  const resolved = clips.map((c) => ({
    file: audioPath(c.sourceId),
    srcStart: Number(c.srcStart),
    srcEnd: Number(c.srcEnd),
    fadeIn: Number(c.fadeIn) || 0,
    fadeOut: Number(c.fadeOut) || 0,
    crossfade: Number(c.crossfade) || 0,
  }));
  for (const c of resolved) {
    if (!(c.srcEnd > c.srcStart)) throw Object.assign(new Error("invalid clip range"), { status: 400 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `${String(name).replace(/[\\/:*?"<>|]+/g, "_")}_${stamp}.${fmt}`;
  const outFile = path.join(EXPORT_DIR, fileName);
  const t0 = Date.now();
  await exportTimeline(resolved, outFile, fmt);
  res.json({ url: `/exports/${encodeURIComponent(fileName)}`, fileName, ms: Date.now() - t0 });
}));

app.listen(PORT, () => {
  console.log(`Podcast editor: http://localhost:${PORT}`);
});
