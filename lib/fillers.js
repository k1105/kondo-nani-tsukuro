/**
 * フィラー・頷き（相槌）のラベル付けと、それらを省いたときの発話グルーピング。
 * 文字起こし直後の前処理として一度だけ実行し、結果は単語配列に書き込む。
 *
 *   w.f = "backchannel"  相槌だけのターン（「うん」「はいはい」「確かに」など）
 *   w.f = "filler"       発話の中・端にあるフィラー（「えー」「あの」「ま、」、ターン頭の「うん、」など）
 *   w.u = <整数>         ラベル無しの単語に付く発話 ID。フィラー・頷きを省いたときに
 *                        同じ話者が隣接していれば同じ ID になる（＝一つの発話にマージ）
 *
 * 辞書ベースのルール。調整したいときは下の *_UNITS と定数を編集する。
 */

// 相槌として扱う単位。これらだけを（繰り返しも含めて）並べたターンは「頷き」になる
const BACKCHANNEL_UNITS = [
  "うん", "ううん", "うーん", "んー", "ん", "んん", "うんうん",
  "はい", "はいはい", "はあ", "はー",
  "ええ", "えー", "え", "へー", "へえ", "へぇ", "ほー", "ほう", "ほお", "ふーん", "ふん", "ふむ",
  "なるほど", "なるほどね", "そう", "そうそう", "そうね", "そうだね", "そうだよね", "そうなんだ", "そうなんですね",
  "そうですね", "そうっすね", "そうすね", "っすね", "すね", "そっか", "そうか", "そういうこと", "そういうことか",
  "確かに", "確かにね", "確か", "たしかに", "そっかそっか",
  "あー", "ああ", "あ", "おー", "おお", "お", "おっ", "うわ", "わー", "わあ",
  "ね", "だね", "よね", "だよね", "ですね", "ですよね", "いいね", "いいですね",
  "おっけー", "おっけ", "ok", "了解",
  "いや", "いやいや", "いえ",
  "本当", "ほんと", "ほんとに", "本当に", "まじ", "まじで",
  "はは", "ははは", "あはは", "ふふ", "うふふ", "へへ", "笑",
];

// 文中のどこに出てきてもフィラーとして扱う単位
const FILLER_UNITS = ["えー", "えーと", "えっと", "ええと", "えと", "うーん", "んー", "んーと", "あのー", "あの", "ま", "まあ", "まー"];

// ターンの先頭・末尾にあってもフィラー扱いしない語（文末助詞など、発話の一部であることが多い）
const NOT_AT_EDGE = ["ね", "だね", "よね", "だよね", "ですね", "ですよね", "すね", "っすね", "ん", "んん", "お", "笑", "確か", "いいね", "いいですね"];

// 発話の区切り: フィラー・頷きを省いた上で、この秒数以上の無音があれば別発話にする
export const UTTERANCE_PAUSE_SEC = 2.0;
// 相槌ターンとみなす最大トークン数
const MAX_BACKCHANNEL_TOKENS = 12;
// 「そう」「っ」「す」「ね。」のように 1 単位が分割されているとき、連結して照合する最大トークン数
const MAX_UNIT_TOKENS = 4;
// 「次の語との間が空いている」とみなす秒数（「あの人」のように続く場合はフィラーにしない）
const FILLER_GAP_SEC = 0.25;

const ALL_UNITS = [...new Set([...BACKCHANNEL_UNITS, ...FILLER_UNITS])].sort((a, b) => b.length - a.length);
const ALL_SET = new Set(ALL_UNITS);
const FILLER_SET = new Set(FILLER_UNITS);
const EDGE_SET = new Set(ALL_UNITS.filter((u) => !NOT_AT_EDGE.includes(u)));
// 「そう」「っ」「す」「ね。」のように分割された相槌を連結して照合するための正規表現（2 文字以上の単位のみ）
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const JOINED_RE = new RegExp(`^(?:${ALL_UNITS.filter((u) => u.length >= 2).map(esc).join("|")})+$`);

const PUNCT_RE = /[、。．，！？!?…・「」『』（）()\[\]【】\s.,:;~〜]/g;
const TRAIL_PUNCT_RE = /[、。．，！？!?…\.,]$/;

/** 比較用に正規化: 句読点除去、カタカナ→ひらがな、長音の連続を 1 つに */
export function normalize(text) {
  return String(text)
    .replace(PUNCT_RE, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/ー+/g, "ー")
    .toLowerCase();
}

/**
 * words: [{t, s, e, spk}] (開始時刻順)。f / u を書き込んだ新しい配列を返す（元配列は変更しない）
 */
export function labelFillers(words, opts = {}) {
  const pause = opts.pause ?? UTTERANCE_PAUSE_SEC;
  const out = words.map(({ f, u, ...rest }) => rest);
  const hasPunct = (w) => TRAIL_PUNCT_RE.test(String(w.t).trim());
  const gapAfter = (i) => (out[i + 1] ? out[i + 1].s - out[i].e : Infinity);
  const gapBefore = (i) => (out[i - 1] ? out[i].s - out[i - 1].e : Infinity);

  // 話者ごとの連続区間（ターン）に分ける
  const turns = [];
  let cur = null;
  out.forEach((w, i) => {
    if (!cur || cur.spk !== w.spk) { cur = { spk: w.spk, idx: [] }; turns.push(cur); }
    cur.idx.push(i);
  });

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    if (turn.idx.every((i) => out[i].f)) continue;
    const toks = turn.idx.map((i) => ({ i, n: normalize(out[i].t) }));
    const joined = toks.map((t) => t.n).join("");
    // 1) ターン全体が相槌だけ → 頷き
    if (joined && turn.idx.length <= MAX_BACKCHANNEL_TOKENS) {
      const allUnits = toks.every((t) => t.n === "" || ALL_SET.has(t.n));
      if (allUnits || JOINED_RE.test(joined)) {
        for (const { i } of toks) out[i].f = "backchannel";
        // 「確か」+「に」のように末尾の 1〜2 語だけ別話者に割り当てられた場合、
        // 連結すると相槌になるなら続きの断片も頷きとして扱う
        const next = turns[ti + 1];
        if (next && next.idx.length <= 2) {
          const nj = next.idx.map((i) => normalize(out[i].t)).join("");
          if (nj && JOINED_RE.test(joined + nj)) for (const i of next.idx) out[i].f = "backchannel";
        }
        continue;
      }
    }
    // 2) ターンの先頭・末尾に並ぶ相槌/フィラー語 → フィラー（「うん、で…」「…だよね。うん。」）
    //    「確か」+「に。」のように複数トークンで 1 単位になるものも連結して照合する。
    //    ただし「そう」+「いう」のように次の語へ間なく続く場合は発話の一部とみなす
    let a = 0, b = toks.length - 1;
    const unitAt = (from, dir) => {
      // from から dir 方向に最大 MAX_UNIT_TOKENS トークンを連結して EDGE_SET に一致する最長のものを返す
      for (let len = MAX_UNIT_TOKENS; len >= 1; len--) {
        const lo = dir > 0 ? from : from - len + 1;
        const hi = dir > 0 ? from + len - 1 : from;
        if (lo < a || hi > b) continue;
        const group = toks.slice(lo, hi + 1);
        const n = group.map((t) => t.n).join("");
        if (n && EDGE_SET.has(n)) return { lo, hi, n };
      }
      return null;
    };
    while (a <= b) {
      if (toks[a].n === "") { a++; continue; }
      const g = unitAt(a, +1);
      if (!g) break;
      const last = toks[g.hi].i;
      const nextUnit = g.hi + 1 <= b && ALL_SET.has(toks[g.hi + 1].n);
      if (!(hasPunct(out[last]) || gapAfter(last) >= FILLER_GAP_SEC || /ー$/.test(g.n) || nextUnit)) break;
      for (let k = g.lo; k <= g.hi; k++) out[toks[k].i].f = "filler";
      a = g.hi + 1;
    }
    while (b >= a) {
      if (toks[b].n === "") { b--; continue; }
      const g = unitAt(b, -1);
      if (!g) break;
      const first = toks[g.lo].i;
      const prev = g.lo - 1 >= a ? out[toks[g.lo - 1].i] : null;
      const prevUnit = prev && ALL_SET.has(toks[g.lo - 1].n);
      if (prev && !(hasPunct(prev) || gapBefore(first) >= FILLER_GAP_SEC || prevUnit)) break;
      for (let k = g.lo; k <= g.hi; k++) out[toks[k].i].f = "filler";
      b = g.lo - 1;
    }
    // 3) 文中のフィラー
    for (let k = a; k <= b; k++) {
      const { i, n } = toks[k];
      if (!FILLER_SET.has(n)) continue;
      const nextFiller = k + 1 <= b && FILLER_SET.has(toks[k + 1].n);
      if (hasPunct(out[i]) || gapAfter(i) >= FILLER_GAP_SEC || /ー$/.test(n) || nextFiller) out[i].f = "filler";
    }
  }

  // 発話 ID: ラベル無しの語を時間順にたどり、同じ話者が続けば同じ発話。
  // 無音（相槌が占める時間は無音に含めない）が pause 秒以上空いたら別発話にする
  let uid = -1;
  let lastSpk = null;
  let lastEnd = -Infinity;
  for (const w of out) {
    if (!w.f) {
      if (lastSpk === null || w.spk !== lastSpk || w.s - lastEnd >= pause) uid++;
      w.u = uid;
      lastSpk = w.spk;
    }
    lastEnd = Math.max(lastEnd, w.e);
  }

  let filler = 0, backchannel = 0;
  for (const w of out) { if (w.f === "filler") filler++; else if (w.f === "backchannel") backchannel++; }
  return { words: out, meta: { at: new Date().toISOString(), filler, backchannel, utterances: uid + 1, pause } };
}
