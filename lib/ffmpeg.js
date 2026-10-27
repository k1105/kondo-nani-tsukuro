import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function run(cmd, args, { collectStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [];
    const err = [];
    if (collectStdout) p.stdout.on("data", (d) => out.push(d));
    else p.stdout.resume();
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-2000)}`));
    });
  });
}

export async function probeDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  const d = parseFloat(out.toString().trim());
  if (!Number.isFinite(d)) throw new Error("duration not found");
  return d;
}

// 1秒あたり PEAKS_PER_SEC 個の正規化ピーク値 (0..1) を返す
export const PEAKS_PER_SEC = 20;
export async function computePeaks(file) {
  const rate = 8000;
  const bin = rate / PEAKS_PER_SEC;
  const pcm = await run("ffmpeg", [
    "-v", "error", "-i", file,
    "-ac", "1", "-ar", String(rate), "-f", "s16le", "-",
  ]);
  const samples = pcm.length >> 1;
  const peaks = [];
  for (let i = 0; i < samples; i += bin) {
    let max = 0;
    const end = Math.min(samples, i + bin);
    for (let j = i; j < end; j++) {
      const v = Math.abs(pcm.readInt16LE(j * 2));
      if (v > max) max = v;
    }
    peaks.push(Math.round((max / 32768) * 100) / 100);
  }
  return peaks;
}

// Gemini に送るためのチャンク (mono 16kHz mp3) を切り出す
export async function extractChunk(file, start, length, outFile) {
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-ss", String(start), "-t", String(length),
    "-i", file,
    "-ac", "1", "-ar", "16000", "-b:a", "48k",
    outFile,
  ], { collectStdout: false });
  return outFile;
}

/**
 * clips: [{ file(absolute path), srcStart, srcEnd, fadeIn, fadeOut, crossfade }]
 * crossfade は「次のクリップとの」クロスフェード秒数
 */
export function buildExportArgs(clips, outFile, format) {
  const files = [...new Set(clips.map((c) => c.file))];
  const args = ["-v", "error", "-y"];
  for (const f of files) args.push("-i", f);

  const parts = [];
  const lens = clips.map((c) => c.srcEnd - c.srcStart);
  clips.forEach((c, i) => {
    const idx = files.indexOf(c.file);
    const len = lens[i];
    const chain = [
      `atrim=start=${c.srcStart.toFixed(3)}:end=${c.srcEnd.toFixed(3)}`,
      "asetpts=PTS-STARTPTS",
      "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    ];
    const fi = Math.min(c.fadeIn || 0, len);
    const fo = Math.min(c.fadeOut || 0, len);
    if (fi > 0) chain.push(`afade=t=in:st=0:d=${fi.toFixed(3)}`);
    if (fo > 0) chain.push(`afade=t=out:st=${(len - fo).toFixed(3)}:d=${fo.toFixed(3)}`);
    parts.push(`[${idx}:a]${chain.join(",")}[c${i}]`);
  });

  let acc = "[c0]";
  let accLen = lens[0];
  for (let i = 1; i < clips.length; i++) {
    const xfRaw = clips[i - 1].crossfade || 0;
    const xf = Math.min(xfRaw, accLen, lens[i]);
    const out = `[a${i}]`;
    if (xf > 0.01) {
      parts.push(`${acc}[c${i}]acrossfade=d=${xf.toFixed(3)}:c1=tri:c2=tri${out}`);
      accLen = accLen + lens[i] - xf;
    } else {
      parts.push(`${acc}[c${i}]concat=n=2:v=0:a=1${out}`);
      accLen = accLen + lens[i];
    }
    acc = out;
  }

  args.push("-filter_complex", parts.join(";"), "-map", acc);
  if (format === "wav") args.push("-c:a", "pcm_s16le");
  else if (format === "m4a") args.push("-c:a", "aac", "-b:a", "192k");
  else args.push("-c:a", "libmp3lame", "-b:a", "192k");
  args.push(outFile);
  return args;
}

export async function exportTimeline(clips, outFile, format) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const args = buildExportArgs(clips, outFile, format);
  await run("ffmpeg", args, { collectStdout: false });
  return outFile;
}
