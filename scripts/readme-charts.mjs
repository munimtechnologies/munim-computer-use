#!/usr/bin/env node
// Draws the README's comparison charts as static SVGs, one light and one dark
// file each, into .github/resources/. GitHub strips scripts from README
// images, so every value a reader needs is printed on the chart, and the
// README's tables carry the same numbers.
//
//   node scripts/readme-charts.mjs
//
// Capability coverage is counted from the README's capability matrix, so the
// chart cannot drift from the table. The benchmark numbers are the ones under
// "Benchmarks" in the README; change both together.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".github", "resources");

const THEMES = {
  light: {
    surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781",
    grid: "#e1e0d9", axis: "#c3c2b7",
    munim: "#2a78d6", other: "#eb6834", partial: "#86b6ef",
  },
  dark: {
    surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781",
    grid: "#2c2c2a", axis: "#383835",
    munim: "#3987e5", other: "#d95926", partial: "#1c5cab",
  },
};

const FONT = `system-ui, -apple-system, 'Segoe UI', sans-serif`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A horizontal bar: square at the baseline, 4px rounded data end.
function bar(x, y, w, h, fill) {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z" fill="${fill}"/>`;
}
const text = (x, y, s, { fill, size = 13, weight = 400, anchor = "start" }) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;
const swatch = (x, y, fill, label, t) =>
  `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${fill}"/>` + text(x + 16, y, label, { fill: t.ink2, size: 12 });

function svg(width, height, title, desc, t, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<rect width="${width}" height="${height}" rx="8" fill="${t.surface}"/>
${body}
</svg>
`;
}

// --- 1. Five servers reading a growing folder --------------------------------

// Each server's own "read this window" tool on File Explorer showing a folder of
// N files, text only where the server allows it. Median of 10 warm calls (two
// rounds of 5). Tokens are characters / 4, plus the screenshot open-computer-use
// always attaches (Anthropic's w*h/750). Measured 27 October 2026.
const SIZES = [100, 1000, 5000, 20000];
const SCALE = [
  { name: "munim-computer-use 0.7.3", short: "munim", ms: [235, 225, 237, 237], tokens: [2008, 2012, 2012, 2015] },
  { name: "Cua Driver 0.38.0", short: "Cua Driver", ms: [169, 174, 185, 176], tokens: [3898, 3901, 3901, 3904] },
  { name: "Windows-MCP 0.8.5", short: "Windows-MCP", ms: [790, 689, 771, 756], tokens: [3855, 3857, 3858, 3860] },
  { name: "computer-use-mcp 7.8.0 (zavora)", short: "zavora", ms: [431, 487, 442, 421], tokens: [9346, 9346, 9348, 9351] },
  { name: "open-computer-use 1.1.2", short: "open-computer-use", ms: [3427, 3735, 3513, 3202], tokens: [5858, 5849, 5861, 5864] },
];
// Fixed slots, in series order (validated: scripts' palette check, both modes).
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
};

function scaleChart(t, mode) {
  const W = 820, left = 64, right = 190, plotH = 220, gapH = 84, top = 150;
  const plotW = W - left - right;
  const colors = SERIES[mode];
  const lx = Math.log10(SIZES[0]), rx = Math.log10(SIZES[SIZES.length - 1]);
  const x = (n) => left + ((Math.log10(n) - lx) / (rx - lx)) * plotW;
  const panels = [
    {
      title: "Time per read (log scale, lower is better)", key: "ms",
      // Latencies span 0.17 s to 3.7 s, so a log axis keeps the fast ones apart.
      y: (v, y0) => y0 + plotH - ((Math.log10(v) - Math.log10(100)) / (Math.log10(5000) - Math.log10(100))) * plotH,
      ticks: [100, 200, 500, 1000, 2000, 5000], tick: (v) => (v < 1000 ? `${v / 1000} s` : `${v / 1000} s`),
      fmt: (v) => `${(v / 1000).toFixed(2)} s`,
    },
    {
      title: "Tokens per read (≈, lower is better)", key: "tokens",
      y: (v, y0) => y0 + plotH - (v / 10000) * plotH,
      ticks: [0, 2500, 5000, 7500, 10000], tick: (v) => (v ? `${v / 1000}K` : "0"),
      fmt: (v) => `${(v / 1000).toFixed(1)}K`,
    },
  ];
  const H = top + panels.length * plotH + gapH + 40;
  let body = text(20, 30, "Reading a window as the folder grows, five servers on Windows 11", { fill: t.ink, size: 16, weight: 600 });
  body += text(20, 50, "Each server's read tool on File Explorer showing 100 to 20,000 files, same PC, median of 10 warm calls.", { fill: t.ink2, size: 12 });
  body += text(20, 66, "Every server reads only the rows on screen, so folder size barely matters; what differs is the level.", { fill: t.ink2, size: 12 });
  SCALE.forEach((s, i) => {
    const lx0 = 20 + (i % 3) * 250, ly = 92 + Math.floor(i / 3) * 20;
    body += `<line x1="${lx0}" x2="${lx0 + 14}" y1="${ly - 4}" y2="${ly - 4}" stroke="${colors[i]}" stroke-width="2"/>`;
    body += `<circle cx="${lx0 + 7}" cy="${ly - 4}" r="3" fill="${colors[i]}"/>`;
    body += text(lx0 + 20, ly, s.name, { fill: t.ink2, size: 12, weight: i === 0 ? 600 : 400 });
  });
  panels.forEach((p, n) => {
    const y0 = top + n * (plotH + gapH);
    body += text(left, y0 - 12, p.title, { fill: t.ink2, size: 12, weight: 600 });
    for (const tick of p.ticks) {
      const y = p.y(tick, y0);
      body += `<line x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}" stroke="${tick === p.ticks[0] ? t.axis : t.grid}" stroke-width="1"/>`;
      body += text(left - 8, y + 4, p.tick(tick), { fill: t.muted, size: 11, anchor: "end" });
    }
    for (const size of SIZES) {
      body += text(x(size), y0 + plotH + 18, `${size.toLocaleString("en-US")} files`, { fill: t.muted, size: 11, anchor: "middle" });
    }
    // munim is drawn last so it sits on top where lines cross.
    const order = SCALE.map((_, i) => i).reverse();
    for (const i of order) {
      const s = SCALE[i];
      const points = SIZES.map((size, j) => `${x(size).toFixed(1)},${p.y(s[p.key][j], y0).toFixed(1)}`).join(" ");
      body += `<polyline points="${points}" fill="none" stroke="${colors[i]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      SIZES.forEach((size, j) => {
        body += `<circle cx="${x(size)}" cy="${p.y(s[p.key][j], y0)}" r="4" fill="${colors[i]}" stroke="${t.surface}" stroke-width="2"/>`;
      });
    }
    // End labels; lines that end within a label's height share one label.
    const ends = SCALE.map((s, i) => ({ i, y: p.y(s[p.key][SIZES.length - 1], y0), value: s[p.key][SIZES.length - 1] }))
      .sort((a, b) => a.y - b.y);
    const groups = [];
    for (const end of ends) {
      const last = groups[groups.length - 1];
      if (last && end.y - last[last.length - 1].y < 15) last.push(end);
      else groups.push([end]);
    }
    for (const group of groups) {
      const y = group.reduce((sum, e) => sum + e.y, 0) / group.length;
      const values = group.map((e) => p.fmt(e.value));
      const label = values.every((v) => v === values[0])
        ? group.map((e) => SCALE[e.i].short).join(", ") + ` ${values[0]}`
        : group.map((e, k) => `${SCALE[e.i].short} ${values[k]}`).join(", ");
      body += text(left + plotW + 10, y + 4, label, { fill: group.some((e) => e.i === 0) ? t.ink : t.ink2, size: 12, weight: group.some((e) => e.i === 0) ? 600 : 400 });
    }
  });
  const desc = SCALE.map((s) => `${s.name}: ${s.ms.map((v) => `${v} ms`).join(", ")}; ${s.tokens.map((v) => `${v} tokens`).join(", ")}`).join(". ")
    + ` (for ${SIZES.join(", ")} files)`;
  return svg(W, H, "Five computer-use servers reading File Explorer as the folder grows", desc, t, body);
}

// --- 2. Capability coverage, counted from the README matrix -----------------

function readMatrix() {
  const lines = readFileSync(join(root, "README.md"), "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("| Capability"));
  const rows = [];
  for (let i = start; lines[i]?.startsWith("|"); i++) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
  const [header, , ...cells] = rows;
  return header.slice(1, -1).map((name, c) => {
    const col = cells.map((r) => r[c + 1]);
    return {
      name: name.replace(/\*/g, ""),
      yes: col.filter((v) => v.includes("✅")).length,
      partial: col.filter((v) => v.includes("⚠️")).length,
      applicable: col.filter((v) => !v.startsWith("n/a")).length,
    };
  });
}

function coverageChart(t) {
  const cols = readMatrix().sort((a, b) => b.yes + b.partial / 2 - (a.yes + a.partial / 2));
  const total = Math.max(...cols.map((c) => c.applicable));
  const W = 820, labelW = 210, plotW = 470, top = 108, rowH = 30, barH = 18;
  const H = top + cols.length * rowH + 40;
  const unit = plotW / total;
  let body = text(20, 30, "Capability coverage", { fill: t.ink, size: 16, weight: 600 });
  body += text(20, 50, `How many of the ${total} rows in the capability matrix each project has; rows marked n/a are left out of its track.`, { fill: t.ink2, size: 12 });
  body += text(20, 66, "We picked the rows, so read this as a map of features, not a neutral benchmark.", { fill: t.ink2, size: 12 });
  body += swatch(20, 90, t.munim, "Has it", t) + swatch(100, 90, t.partial, "Partly", t) + swatch(170, 90, t.grid, "Absent or not documented", t);
  for (const tick of [0, 5, 10, 15, total].filter((v, i, a) => a.indexOf(v) === i)) {
    const x = labelW + tick * unit;
    body += `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + cols.length * rowH}" stroke="${tick ? t.grid : t.axis}" stroke-width="1"/>`;
    body += text(x, top + cols.length * rowH + 18, tick, { fill: t.muted, size: 11, anchor: "middle" });
  }
  cols.forEach((c, j) => {
    const y = top + j * rowH + (rowH - barH) / 2;
    const isMunim = c.name === "Munim Computer Use";
    body += text(20, y + 14, c.name, { fill: t.ink, size: 13, weight: isMunim ? 600 : 400 });
    // The track shows the applicable rows; the gap between segments is 2px of surface.
    body += `<rect x="${labelW}" y="${y}" width="${c.applicable * unit}" height="${barH}" rx="4" fill="${t.grid}"/>`;
    const yesW = c.yes * unit;
    body += bar(labelW, y, yesW - (c.partial ? 1 : 0), barH, t.munim);
    if (c.partial) body += bar(labelW + yesW + 1, y, c.partial * unit - 1, barH, t.partial);
    const label = `${c.yes}${c.partial ? ` + ${c.partial} partly` : ""} of ${c.applicable}`;
    body += text(labelW + plotW + 12, y + 14, label, { fill: t.ink, size: 12, weight: isMunim ? 600 : 400 });
  });
  const desc = cols.map((c) => `${c.name}: ${c.yes} yes, ${c.partial} partly, of ${c.applicable} applicable`).join("; ");
  return svg(W, H, "Capability coverage across computer-use servers", desc, t, body);
}

// --- 3. Every Windows release on the same window -----------------------------

// get_app_state on File Explorer at C:\Windows\System32, median of 10 warm calls
// per release (two rounds of 5), and Windows-MCP 0.8.5's Snapshot in the same
// rounds. Tokens are characters / 4.
const HISTORY = [
  ["0.2.0", 0.402, 9860], ["0.3.0", 0.43, 9860], ["0.3.1", 0.384, 9860], ["0.4.0", 0.384, 9860],
  ["0.4.1", 0.378, 9860], ["0.4.2", 0.391, 9860], ["0.4.3", 0.404, 9860], ["0.4.4", 0.379, 9860],
  ["0.5.0", 0.376, 9860], ["0.5.1", 0.372, 9860], ["0.5.2", 0.428, 9860], ["0.6.0", 0.374, 9860],
  ["0.6.1", 0.413, 9860], ["0.7.0", 0.233, 7499], ["0.7.1", 0.285, 7499], ["0.7.2", 0.248, 7520],
  ["0.7.3", 0.251, 7520],
].map(([version, seconds, chars]) => ({ version, seconds, tokens: Math.round(chars / 4) }));
const HISTORY_REFERENCE = { label: "Windows-MCP 0.8.5", seconds: 0.753, tokens: Math.round(14929 / 4) };

function historyChart(t) {
  const W = 820, left = 64, right = 150, plotH = 150, gapH = 74;
  const plotW = W - left - right;
  const panels = [
    { title: "Read time (s, lower is better)", key: "seconds", max: 0.8, ticks: [0, 0.2, 0.4, 0.6, 0.8], fmt: (v) => `${v.toFixed(2)} s`, tick: (v) => `${v} s` },
    { title: "Tokens per read (≈, lower is better)", key: "tokens", max: 4000, ticks: [0, 1000, 2000, 3000, 4000], fmt: (v) => `${(v / 1000).toFixed(1)}K`, tick: (v) => (v ? `${v / 1000}K` : "0") },
  ];
  const top = 128;
  const H = top + panels.length * plotH + (panels.length - 1) * gapH + 44;
  const x = (i) => left + (i / (HISTORY.length - 1)) * plotW;
  let body = text(20, 30, "get_app_state in every Windows release", { fill: t.ink, size: 16, weight: 600 });
  body += text(20, 50, "The same File Explorer window (C:\\Windows\\System32, 4,837 items) read by each release, median of 10 warm calls.", { fill: t.ink2, size: 12 });
  body += text(20, 66, "0.7.0 started reading only what is on screen, with each element's attributes in one request.", { fill: t.ink2, size: 12 });
  body += `<line x1="20" x2="34" y1="85" y2="85" stroke="${t.munim}" stroke-width="2"/>` + text(40, 89, "munim-computer-use", { fill: t.ink2, size: 12 });
  body += `<line x1="170" x2="184" y1="85" y2="85" stroke="${t.other}" stroke-width="2"/>` + text(190, 89, HISTORY_REFERENCE.label + ", same rounds", { fill: t.ink2, size: 12 });
  panels.forEach((p, n) => {
    const y0 = top + n * (plotH + gapH);
    const y = (v) => y0 + plotH - (v / p.max) * plotH;
    body += text(left, y0 - 10, p.title, { fill: t.ink2, size: 12, weight: 600 });
    for (const tick of p.ticks) {
      body += `<line x1="${left}" x2="${left + plotW}" y1="${y(tick)}" y2="${y(tick)}" stroke="${tick ? t.grid : t.axis}" stroke-width="1"/>`;
      body += text(left - 8, y(tick) + 4, p.tick(tick), { fill: t.muted, size: 11, anchor: "end" });
    }
    const marked = HISTORY.findIndex((h) => h.version === "0.7.0");
    body += `<line x1="${x(marked)}" x2="${x(marked)}" y1="${y0}" y2="${y0 + plotH}" stroke="${t.axis}" stroke-width="1"/>`;
    // The reference is one measurement, not a series over our releases: a flat line labelled at its end.
    const ref = y(HISTORY_REFERENCE[p.key]);
    body += `<line x1="${left}" x2="${left + plotW}" y1="${ref}" y2="${ref}" stroke="${t.other}" stroke-width="2" stroke-linecap="round"/>`;
    body += text(left + plotW + 10, ref + 4, `${p.fmt(HISTORY_REFERENCE[p.key])} Windows-MCP`, { fill: t.ink2, size: 12 });
    const points = HISTORY.map((h, i) => `${x(i).toFixed(1)},${y(h[p.key]).toFixed(1)}`).join(" ");
    body += `<polyline points="${points}" fill="none" stroke="${t.munim}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    HISTORY.forEach((h, i) => {
      body += `<circle cx="${x(i)}" cy="${y(h[p.key])}" r="4" fill="${t.munim}" stroke="${t.surface}" stroke-width="2"/>`;
    });
    const last = HISTORY[HISTORY.length - 1], first = HISTORY[0];
    body += text(left + plotW + 10, y(last[p.key]) + 4, `${p.fmt(last[p.key])} in ${last.version}`, { fill: t.ink, size: 12, weight: 600 });
    body += text(x(0) + 8, y(first[p.key]) - 10, `${p.fmt(first[p.key])} in ${first.version}`, { fill: t.ink2, size: 12 });
    HISTORY.forEach((h, i) => {
      body += text(x(i), y0 + plotH + 18, h.version, { fill: h.version === "0.7.0" ? t.ink : t.muted, size: 10, weight: h.version === "0.7.0" ? 600 : 400, anchor: "middle" });
    });
  });
  const desc = HISTORY.map((h) => `${h.version}: ${h.seconds} s, about ${h.tokens} tokens`).join("; ")
    + `; ${HISTORY_REFERENCE.label}: ${HISTORY_REFERENCE.seconds} s, about ${HISTORY_REFERENCE.tokens} tokens`;
  return svg(W, H, "get_app_state read time and size in every Windows release", desc, t, body);
}

for (const [mode, t] of Object.entries(THEMES)) {
  writeFileSync(join(out, `chart-scale-${mode}.svg`), scaleChart(t, mode));
  writeFileSync(join(out, `chart-coverage-${mode}.svg`), coverageChart(t));
  writeFileSync(join(out, `chart-history-${mode}.svg`), historyChart(t));
}
console.log(readMatrix().map((c) => `${c.name}: ${c.yes} yes, ${c.partial} partly, ${c.applicable} applicable`).join("\n"));
