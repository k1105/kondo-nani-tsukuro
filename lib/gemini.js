import fs from "node:fs/promises";
import path from "node:path";
import { extractChunk } from "./ffmpeg.js";

const BASE = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-3.5-transcribe";
// 話者分離＋単語タイムスタンプ有効時の上限は 30 分。余裕をみて 20 分で分割する
const CHUNK_SEC = 1200;
const OVERLAP_SEC = 15;

function apiKeys() {
  const keys = [];
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  if (process.env.GOOGLE_API_KEY) keys.push(process.env.GOOGLE_API_KEY);
  if (keys.length === 0) throw new Error("GEMINI_API_KEY_* が .env にありません");
  return keys;
}
let keyCursor = 0;
function nextKey() {
  const keys = apiKeys();
  const k = keys[keyCursor % keys.length];
  keyCursor++;
  return k;
}

async function uploadFile(filePath, apiKey, mimeType = "audio/mp3") {
  const data = await fs.readFile(filePath);
  const start = await fetch(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(data.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: path.basename(filePath) } }),
  });
  if (!start.ok) throw new Error(`upload start failed: ${start.status} ${await start.text()}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("x-goog-upload-url がありません");
  const fin = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(data.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: data,
  });
  if (!fin.ok) throw new Error(`upload failed: ${fin.status} ${await fin.text()}`);
  const info = await fin.json();
  let file = info.file;
  // 大きいファイルは PROCESSING になることがあるので ACTIVE になるまで待つ
  for (let i = 0; i < 60 && file.state && file.state !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BASE}/v1beta/${file.name}`, { headers: { "x-goog-api-key": apiKey } });
    file = await res.json();
    if (file.state === "FAILED") throw new Error("file processing failed");
  }
  return file;
}

function parseOffset(s) {
  if (s == null) return 0;
  return parseFloat(String(s).replace(/s$/, "")) || 0;
}
function parseSpeaker(s) {
  const m = String(s || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function transcribeChunk(chunkPath, apiKey) {
  const file = await uploadFile(chunkPath, apiKey);
  const body = {
    model: MODEL,
    input: [{ type: "audio", uri: file.uri, mime_type: "audio/mp3" }],
    generation_config: {
      transcription_config: {
        language_codes: ["ja-JP"],
        mode: {
          type: "verbatim",
          diarization_mode: "speaker",
          timestamp_granularities: ["word"],
        },
      },
    },
  };
  const res = await fetch(`${BASE}/v1beta/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) {
    const err = new Error(`interactions failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (json.status !== "completed") throw new Error(`status=${json.status}`);
  const words = [];
  for (const step of json.steps || []) {
    for (const c of step.content || []) {
      for (const a of c.annotations || []) {
        if (a.type !== "word_info") continue;
        words.push({
          t: a.text,
          s: parseOffset(a.start_offset),
          e: parseOffset(a.end_offset),
          spk: parseSpeaker(a.speaker),
        });
      }
    }
  }
  // 削除は任意だが、48 時間で自動削除されるので失敗しても無視
  fetch(`${BASE}/v1beta/${file.name}`, { method: "DELETE", headers: { "x-goog-api-key": apiKey } }).catch(() => {});
  return words;
}

async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(nextKey());
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * チャンク境界の重複部分を使って、新チャンクの話者ラベルを前チャンクに揃える。
 * 返り値: 新チャンクの spk → 前チャンク基準の spk へのマップ
 */
function alignSpeakers(prevWords, nextWords, overlapStart, overlapEnd) {
  const votes = new Map(); // "next->prev" : count
  const prevIn = prevWords.filter((w) => w.s >= overlapStart && w.e <= overlapEnd);
  const nextIn = nextWords.filter((w) => w.s >= overlapStart && w.e <= overlapEnd);
  for (const nw of nextIn) {
    const mid = (nw.s + nw.e) / 2;
    let best = null;
    let bestD = 0.4;
    for (const pw of prevIn) {
      const d = Math.abs((pw.s + pw.e) / 2 - mid);
      if (d < bestD) { bestD = d; best = pw; }
    }
    if (best) {
      const k = `${nw.spk}->${best.spk}`;
      votes.set(k, (votes.get(k) || 0) + 1);
    }
  }
  const map = {};
  const used = new Set();
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k] of sorted) {
    const [n, p] = k.split("->").map(Number);
    if (map[n] !== undefined || used.has(p)) continue;
    map[n] = p;
    used.add(p);
  }
  return map;
}

/**
 * 音声ファイル全体を文字起こしして単語配列を返す
 * onProgress(message, ratio)
 */
export async function transcribeFile(filePath, duration, workDir, onProgress = () => {}) {
  await fs.mkdir(workDir, { recursive: true });
  const chunks = [];
  if (duration <= CHUNK_SEC + OVERLAP_SEC) {
    chunks.push({ start: 0, len: duration });
  } else {
    let start = 0;
    while (start < duration) {
      const len = Math.min(CHUNK_SEC, duration - start);
      chunks.push({ start, len });
      if (start + len >= duration) break;
      start += CHUNK_SEC - OVERLAP_SEC;
    }
  }
  onProgress(`${chunks.length} チャンクに分割して処理します`, 0.02);

  const base = path.basename(filePath).replace(/[^\w.-]+/g, "_");
  let done = 0;
  const results = await Promise.all(
    chunks.map(async (c, i) => {
      const chunkPath = path.join(workDir, `${base}.${i}.mp3`);
      await extractChunk(filePath, c.start, c.len, chunkPath);
      onProgress(`チャンク ${i + 1}/${chunks.length} を送信中`, 0.05 + (done / chunks.length) * 0.9);
      const words = await withRetry((key) => transcribeChunk(chunkPath, key));
      done++;
      onProgress(`チャンク ${i + 1}/${chunks.length} 完了`, 0.05 + (done / chunks.length) * 0.9);
      await fs.rm(chunkPath, { force: true });
      return words.map((w) => ({ ...w, s: w.s + c.start, e: w.e + c.start }));
    })
  );

  // マージ: 重複部の中央で切り替え、話者ラベルを揃える
  let merged = results[0];
  for (let i = 1; i < results.length; i++) {
    const prevEnd = chunks[i - 1].start + chunks[i - 1].len;
    const overlapStart = chunks[i].start;
    const cut = (overlapStart + prevEnd) / 2;
    const map = alignSpeakers(merged, results[i], overlapStart, prevEnd);
    const next = results[i]
      .filter((w) => (w.s + w.e) / 2 >= cut)
      .map((w) => ({ ...w, spk: map[w.spk] !== undefined ? map[w.spk] : w.spk }));
    merged = merged.filter((w) => (w.s + w.e) / 2 < cut).concat(next);
  }
  merged.sort((a, b) => a.s - b.s);
  onProgress("完了", 1);
  return { model: MODEL, words: merged };
}
