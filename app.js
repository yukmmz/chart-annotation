/**
 * チャート主観アノテーションアプリ。
 *
 * charts.json (匿名化済みの正規化OHLC) を読み込み、ローソク足をSVGで描画してラベルを収集する。
 * ラベルはタップごとにlocalStorageへ同期保存するため、中断・リロードしても続きから再開できる。
 *
 * v4（2026-09-01）から、問うことが変わった。
 * v1〜v3は「このチャートは良いか（買いたいか）」という価値判断を集めていたが、
 * v4は**ユーザーが自分で言語化した2つの形（alpha / beta）に当てはまるか**を集める。
 * 各サンプルは kind ("alpha" | "beta") を持ち、画面はその形の説明を出したうえで
 * 「この形だ / 違う」を尋ねる。判定の観点を何度も切り替えずに済むよう、
 * charts.json は alpha を全部並べてから beta を並べた順序になっている。
 *
 * hl（網掛け範囲）は「条件の判定に使った区間」で、PDF版と同じ配色にしてある。
 * どこを見て機械が判定したかが分かるので、ズレている場合に指摘しやすい。
 */
'use strict';

// **サンプルの中身を差し替えた際はバージョンを上げること**(古いラベルが誤って混ざらないように)。
// id は毎回 s001 から採番し直すため、キーを据え置くと前回のラベルが新しいチャートに
// 紐付いてしまう。2026-09-01にサンプルをv4（alpha/betaの形の判定）へ差し替えたのでv6に上げた。
const STORAGE_KEY = 'annot:v6:labels';
const CURSOR_KEY = 'annot:v6:cursor';

const state = {
  samples: [],
  labels: {},
  cursor: 0,
  // 自由記述コメント。入力は任意で、空のまま判定ボタンを押して構わない。
  note: '',
};

// 判定は2択。「この形だ」は迷いなく当てはまる場合だけに使う。
const LABEL_TEXT = {
  match: 'この形だ', no: '違う',
};

// 形ごとの説明。ユーザー本人の言葉をそのまま短くしたもの。
const KIND_INFO = {
  alpha: {
    name: 'alpha',
    desc: '前半は横ばい → 直近5〜20日をほぼ単調に上昇。'
      + '多くの日で前日高値を更新。直前2〜3日に異常な急騰なし。',
  },
  beta: {
    name: 'beta',
    desc: '60日間ほぼ単調・一定ペースで上がり続けている。'
      + '多くの日で前日高値を更新。直前2〜3日に異常な急騰なし。',
  },
};

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

  const info = KIND_INFO[sample.kind] || { name: sample.kind || '?', desc: '' };
  document.getElementById('kind-badge').textContent = info.name;
  document.getElementById('kind-badge').dataset.kind = sample.kind || '';
  document.getElementById('hint').textContent = `${info.name} の形ですか？`;
  document.getElementById('kind-desc').textContent = info.desc;

  // その形が何件目/全何件かを出す（残りの見通しが立つように）
  const sameKind = state.samples.filter((s) => s.kind === sample.kind);
  const idxInKind = sameKind.findIndex((s) => s.id === sample.id) + 1;
  document.getElementById('counter').textContent =
    `${info.name} ${idxInKind} / ${sameKind.length}　（全体 ${state.cursor + 1} / ${state.samples.length}）`;

  document.getElementById('progress-bar').style.width =
    `${(labeledCount() / state.samples.length) * 100}%`;
  document.getElementById('back-btn').disabled = state.cursor === 0;

  const existing = state.labels[sample.id];
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

  const byKind = {};
  let withNote = 0;
  for (const s of state.samples) {
    const v = state.labels[s.id];
    if (!v) continue;
    const k = s.kind || '?';
    byKind[k] = byKind[k] || { match: 0, no: 0 };
    if (byKind[k][v.label] !== undefined) byKind[k][v.label]++;
    if (v.note) withNote++;
  }
  const lines = Object.entries(byKind).map(
    ([k, c]) => `${k}: この形だ ${c.match} ／ 違う ${c.no}`);
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

function download() {
  const payload = {
    version: 'v4',
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
  a.download = `shape_labels_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 起動 ---------- */

async function init() {
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
