/**
 * チャート主観アノテーションアプリ。
 *
 * charts.json (匿名化済みの正規化OHLC) を読み込み、ローソク足をSVGで描画してラベルを収集する。
 * ラベルはタップごとにlocalStorageへ同期保存するため、中断・リロードしても続きから再開できる。
 *
 * 問うことは2回変わっている。
 *
 * - v1〜v3: 「このチャートは良いか（買いたいか）」という価値判断
 * - v4: 「ユーザーが言語化した2つの形（alpha / beta）に当てはまるか」の2択
 * - **v5（2026-09-17）: 「上がり方がどちらの型か」の4択**
 *
 * v5の目的は**買いと売りのタイミングを型ごとに変えること**。ユーザーの言葉:
 *
 * > 買うタイミングと売るタイミングの定義が1種類じゃ不十分と思ったのでこの案を出した
 *
 * 4つの選択肢は R / S / どちらでも良い / どちらでもない。3つめ（どちらでも良い）を
 * 置いたのはユーザーの明示的な要望による。境目のチャートを無理に二分させると、
 * **ラベルの揺れが型の定義そのものを汚す**。「どちらでも良い」に逃がしておけば、
 * R・Sそれぞれの純度が保たれ、境界の位置はバックテスト側で決められる。
 *
 * 判定の観点を何度も切り替えずに済むよう、charts.json は機械がRと予測したものと
 * Sと予測したものを混ぜて並べる（ただし予測はユーザーに見せない。見せると引きずられる）。
 *
 * hl（網掛け範囲）は「条件の判定に使った区間」で、PDF版と同じ配色にしてある。
 * どこを見て機械が判定したかが分かるので、ズレている場合に指摘しやすい。
 */
'use strict';

// **サンプルの中身を差し替えた際はバージョンを上げること**(古いラベルが誤って混ざらないように)。
// id は毎回 s001 から採番し直すため、キーを据え置くと前回のラベルが新しいチャートに
// 紐付いてしまう。2026-09-01にサンプルをv4（alpha/betaの形の判定）へ差し替えたのでv6に上げ、
// 2026-09-04に「付けたラベルを一旦削除して」というユーザー要望でv7に上げ、
// 2026-09-17にv5サンプル（R/Sの型判定・4択）へ差し替えたのでv8に上げ、
// 2026-09-22にv6サンプル（検知の遅れで層化・歩留まり条件つき）へ差し替えたのでv9に上げた。
const STORAGE_KEY = 'annot:v9:labels';
const CURSOR_KEY = 'annot:v9:cursor';

// 古いバージョンのキーは端末に残しても使わないので、起動時に消しておく
// （容量を食うのと、開発中に「どのキーが生きているのか」が分からなくなるのを避ける）。
function purgeOldKeys() {
  try {
    const keep = new Set([STORAGE_KEY, CURSOR_KEY]);
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^annot:v\d+:(labels|cursor)$/.test(k) && !keep.has(k)) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch (e) {
    /* localStorageが使えない環境でも起動は妨げない */
  }
}

const state = {
  samples: [],
  labels: {},
  cursor: 0,
  // 自由記述コメント。入力は任意で、空のまま判定ボタンを押して構わない。
  note: '',
};

// 判定は4択。R と S は**迷いなく言い切れる場合だけ**に使う。
// 迷ったら「どちらでも」に逃がしてよい（そのためにこの選択肢がある）。
const LABEL_TEXT = {
  R: 'R（ランプ状）',
  S: 'S（階段状）',
  either: 'どちらでも',
  neither: 'どちらでもない',
};

// 4択の説明。画面下に常時出しておく（毎回思い出さなくて済むように）。
const CHOICE_DESC = [
  ['R', '上下の波がほとんど無く、ほぼ一直線に上がっている'],
  ['S', '「少し上げて少し下げる」を繰り返しながら、階段状に上がっている'],
  ['either', 'どちらとも言える／見分けがつかない（迷ったらこれ）'],
  ['neither', 'この形では買わない（上がり方が汚い・買う気にならない）'],
];

// v5 は形（alpha/beta）ではなく**上がり方の型**を問うので、kind による説明の出し分けは
// しない。ただし charts.json の kind は分析側で使うので、そのまま持ち回る。
const KIND_INFO = {};

// 網掛けの色（PDF版と同じ）
const HL_COLOR = { pre: '#243244', rise: '#2c4034' };

/* ---------- 永続化 ---------- */

function loadStored() {
  try {
    state.labels = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (e) {
    state.labels = {};
  }
  const c = parseInt(localStorage.getItem(CURSOR_KEY) || '0', 10);
  state.cursor = Number.isFinite(c) ? c : 0;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.labels));
    localStorage.setItem(CURSOR_KEY, String(state.cursor));
  } catch (e) {
    setStatus('保存に失敗しました（容量不足の可能性）');
  }
}

/* ---------- ローソク足の描画 ---------- */

function renderChart(sample) {
  const bars = sample.bars;
  const W = 1000;
  const H = 620;
  const padX = 12;
  const padY = 18;

  // 対数価格スケール（継続判定のβ定義と同じ空間で見せる）
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (b[2] < lo) lo = b[2];
    if (b[1] > hi) hi = b[1];
  }
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  const span = (logHi - logLo) || 1;

  const y = (v) => padY + (H - 2 * padY) * (1 - (Math.log(v) - logLo) / span);
  const step = (W - 2 * padX) / bars.length;
  const bodyW = Math.max(1, step * 0.68);
  const xAt = (i) => padX + step * i;

  const parts = [];

  // 判定に使った区間の網掛け（ローソク足より先に描いて背面に置く）。
  // 全面を覆う網掛けは「どこを見たか」の情報を持たないので描かない
  // （beta は判定区間60日 = 表示本数なので、この分岐に入る）。
  for (const [type, from, to] of (sample.hl || [])) {
    if (from <= 0 && to >= bars.length - 1) continue;
    const x0 = xAt(Math.max(0, from));
    const x1 = xAt(Math.min(bars.length, to + 1));
    parts.push(
      `<rect x="${x0.toFixed(1)}" y="0" width="${Math.max(0, x1 - x0).toFixed(1)}"`
      + ` height="${H}" fill="${HL_COLOR[type] || '#222'}"/>`
    );
  }

  for (let i = 0; i < bars.length; i++) {
    const [o, h, l, c] = bars[i];
    const cx = padX + step * (i + 0.5);
    // 日本の慣習に合わせ、陽線(上昇)を赤・陰線(下落)を緑にする
    const up = c >= o;
    const color = up ? '#ef5350' : '#26a69a';
    const yO = y(o);
    const yC = y(c);
    const top = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    parts.push(
      `<line x1="${cx.toFixed(1)}" y1="${y(h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(l).toFixed(1)}" stroke="${color}" stroke-width="1.4"/>`,
      `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}"/>`
    );
  }

  document.getElementById('chart-area').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${parts.join('')}</svg>`;
}

/* ---------- 画面更新 ---------- */

function labeledCount() {
  return Object.keys(state.labels).length;
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg || '';
}

function render() {
  if (state.cursor >= state.samples.length) {
    showDone();
    return;
  }
  document.getElementById('app').hidden = false;
  document.getElementById('done-screen').hidden = true;

  const sample = state.samples[state.cursor];
  renderChart(sample);

  // **機械がどちらと予測したかは表示しない**（表示すると判断が引きずられ、
  // 境界を引き直すという目的が果たせなくなる）。バッジは進捗だけを出す。
  document.getElementById('kind-badge').textContent = '上がり方の型';
  document.getElementById('kind-badge').dataset.kind = '';
  document.getElementById('hint').textContent = 'この上がり方はどちらの型ですか？';
  document.getElementById('kind-desc').innerHTML = CHOICE_DESC
    .map(([k, d]) => `<b>${LABEL_TEXT[k]}</b>: ${d}`).join('<br>');

  document.getElementById('counter').textContent =
    `${state.cursor + 1} / ${state.samples.length}`;

  document.getElementById('progress-bar').style.width =
    `${(labeledCount() / state.samples.length) * 100}%`;
  document.getElementById('back-btn').disabled = state.cursor === 0;

  const existing = state.labels[sample.id];
  // 消すものが無いときにボタンを押せると「押したのに何も起きない」になるので無効化する
  document.getElementById('clear-btn').disabled = !existing;
  document.getElementById('clear-all-btn').disabled = labeledCount() === 0;
  // 既に評価済みのチャートに戻ってきたらコメントを復元する。
  // 未評価ならクリアから始める(前のチャートの入力を引きずらない)。
  state.note = existing && typeof existing.note === 'string' ? existing.note : '';
  document.getElementById('note-input').value = state.note;

  setStatus(existing
    ? `記録済み: ${labelText(existing.label)}`
      + (existing.note ? `（${existing.note}）` : '') + ' 変更できます'
    : '');
}

function labelText(label) {
  return LABEL_TEXT[label] || label;
}

function showDone() {
  document.getElementById('app').hidden = true;
  const done = document.getElementById('done-screen');
  done.hidden = false;

  const counts = { R: 0, S: 0, either: 0, neither: 0 };
  let withNote = 0;
  for (const s of state.samples) {
    const v = state.labels[s.id];
    if (!v) continue;
    if (counts[v.label] !== undefined) counts[v.label]++;
    if (v.note) withNote++;
  }
  const lines = Object.entries(counts).map(
    ([k, c]) => `${LABEL_TEXT[k]}: ${c} 件`);
  document.getElementById('done-summary').innerHTML =
    `${labeledCount()} 件を評価しました<br>` +
    lines.join('<br>') + '<br>' +
    `コメントの記入 ${withNote} 件<br>` +
    `<br>下のボタンでJSONを保存して送ってください`;
}

/* ---------- 操作 ---------- */

function applyLabel(label) {
  const sample = state.samples[state.cursor];
  if (!sample) return;
  // 自由記述は入力欄から直接読む(1文字ごとにstateへ同期するより取りこぼしが無い)
  const note = document.getElementById('note-input').value.trim();
  state.labels[sample.id] = { label, note, ts: new Date().toISOString() };
  state.cursor++;
  persist();
  render();
}

function goBack() {
  if (state.cursor > 0) {
    state.cursor--;
    persist();
    render();
  }
}

/** いま表示しているチャートのラベルを消す（そのチャートに留まる）。 */
function clearCurrent() {
  const sample = state.samples[state.cursor];
  if (!sample || !state.labels[sample.id]) return;
  delete state.labels[sample.id];
  persist();
  render();
  setStatus('このチャートのラベルを消しました');
}

/** 付けたラベルを全部消して最初から。誤爆すると作業が丸ごと消えるので必ず確認する。 */
function clearAll() {
  const n = labeledCount();
  if (n === 0) {
    setStatus('消すラベルがありません');
    return;
  }
  if (!window.confirm(`付けたラベル ${n} 件をすべて消して最初からやり直します。よろしいですか？`)) {
    return;
  }
  state.labels = {};
  state.cursor = 0;
  persist();
  render();
  setStatus(`${n} 件のラベルを消しました`);
}

function download() {
  const payload = {
    version: 'v6',
    exported_at: new Date().toISOString(),
    n_labeled: labeledCount(),
    labels: state.labels,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `type_labels_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 起動 ---------- */

async function init() {
  purgeOldKeys();
  loadStored();

  let data;
  try {
    const res = await fetch('charts.json', { cache: 'no-cache' });
    data = await res.json();
  } catch (e) {
    document.getElementById('chart-area').innerHTML =
      '<p style="padding:20px;color:#ef5350">charts.json の読み込みに失敗しました</p>';
    return;
  }
  state.samples = data.samples || [];

  // 未評価の先頭へ自動復帰（保存済みcursorが範囲外の場合の保険も兼ねる）
  if (state.cursor >= state.samples.length || state.labels[state.samples[state.cursor]?.id]) {
    const firstUnlabeled = state.samples.findIndex((s) => !state.labels[s.id]);
    state.cursor = firstUnlabeled === -1 ? state.samples.length : firstUnlabeled;
  }

  document.querySelectorAll('.label-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyLabel(btn.dataset.label));
  });
  // 入力中にキーボードを閉じられるよう、Enterでフォーカスを外す
  document.getElementById('note-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });
  document.getElementById('back-btn').addEventListener('click', goBack);
  document.getElementById('clear-btn').addEventListener('click', clearCurrent);
  document.getElementById('clear-all-btn').addEventListener('click', clearAll);
  document.getElementById('clear-all-btn-2').addEventListener('click', clearAll);
  document.getElementById('download-btn').addEventListener('click', download);
  document.getElementById('download-btn-2').addEventListener('click', download);
  document.getElementById('review-btn').addEventListener('click', () => {
    state.cursor = 0;
    persist();
    render();
  });

  render();
}

init();
