# Podcast Editor

`audio/` 内の音声ファイルを Gemini で文字起こしし、原稿上で編集できるポッドキャスト音源エディタ。

## 起動

```sh
npm install
npm start        # http://localhost:3456
```

`.env` に `GEMINI_API_KEY_1`（複数あれば `_2`, `_3`… でローテーション）を置く。ffmpeg / ffprobe が必要。

## 使い方

1. 左の音源一覧で「文字起こし」（`gemini-3.5-transcribe`、話者分離＋単語タイムスタンプ）。30 分を超える音源は 20 分ごとに分割して並列処理し、重複部分で話者ラベルを揃える。
2. 「タイムラインに追加」でクリップを追加。複数の音源を並べて繋げられる。
3. 中央の原稿: クリックでジャンプ、ドラッグ / ⇧クリックで範囲選択 → 「選択範囲をカット」(Delete)。ダブルクリックで文字修正、話者ラベルクリックで話者切替。
4. 右のクリップ設定でフェードイン / アウト、次のクリップとのクロスフェード、トリム、並べ替え。
5. 「書き出し」で ffmpeg によりレンダリング（`exports/` に保存）。

## 構成

- `server.js` — Express。音源配信、文字起こしジョブ、ピーク波形、書き出し、プロジェクト保存
- `lib/gemini.js` — Gemini Files API + Interactions API（transcribe モデル）
- `lib/ffmpeg.js` — ffprobe / ピーク計算 / チャンク切り出し / filter_complex による書き出し
- `public/` — フロントエンド（Web Audio API でプレビュー再生、クロスフェードも再現）
- `data/transcripts/` — 文字起こし結果 (単語配列)、`data/project.json` — 編集状態（自動保存）
