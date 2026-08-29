/**
 * チャート主観アノテーションアプリ。
 *
 * charts.json (匿名化済みの正規化OHLC) を読み込み、ローソク足をSVGで描画して
 * good / bad / unclear のラベルを収集する。ラベルはタップごとにlocalStorageへ
 * 同期保存するため、中断・リロードしても続きから再開できる。
 */
'use strict';

// サンプルの中身を差し替えた際はバージョンを上げる(古いラベルが誤って混ざらないように)
const STORAGE_KEY = 'annot:v2:labels';
const CURSOR_KEY = 'annot:v2:cursor';

const state = {
  samples: [],
  labels: {},
  cursor: 0,
};

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

  const parts = [];
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

  const done = labeledCount();
  document.getElementById('counter').textContent =
    `${state.cursor + 1} / ${state.samples.length}`;
  document.getElementById('progress-bar').style.width =
    `${(done / state.samples.length) * 100}%`;
  document.getElementById('back-btn').disabled = state.cursor === 0;

  const existing = state.labels[sample.id];
  setStatus(existing ? `記録済み: ${labelText(existing.label)}（変更できます）` : '');
}

function labelText(label) {
  return { good: '良い', bad: '微妙', unclear: 'わからない' }[label] || label;
}

function showDone() {
  document.getElementById('app').hidden = true;
  const done = document.getElementById('done-screen');
  done.hidden = false;

  const counts = { good: 0, bad: 0, unclear: 0 };
  for (const v of Object.values(state.labels)) {
    if (counts[v.label] !== undefined) counts[v.label]++;
  }
  document.getElementById('done-summary').innerHTML =
    `${labeledCount()} 件を評価しました<br>` +
    `良い ${counts.good} ／ 微妙 ${counts.bad} ／ わからない ${counts.unclear}<br>` +
    `<br>下のボタンでJSONを保存して送ってください`;
}

/* ---------- 操作 ---------- */

function applyLabel(label) {
  const sample = state.samples[state.cursor];
  if (!sample) return;
  state.labels[sample.id] = { label, ts: new Date().toISOString() };
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
    version: 'v1',
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
  a.download = `chart_labels_${stamp}.json`;
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
