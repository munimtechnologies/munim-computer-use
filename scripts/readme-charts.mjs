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
    munim: "#2a78d6", other: "#eb6834", partial: "#86b6ef", before: "#c3c2b7",
  },
  dark: {
    surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781",
    grid: "#2c2c2a", axis: "#383835",
    munim: "#3987e5", other: "#d95926", partial: "#1c5cab", before: "#52514e",
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

// --- 1. One look at an app: munim-computer-use vs Windows-MCP ---------------

const LOOK_ROWS = [
  { label: "munim get_app_state", who: "munim", seconds: 0.31, tokens: 1879 },
  { label: "munim get_app_state + screenshot", who: "munim", seconds: 0.40, tokens: 2907 },
  { label: "Windows-MCP Snapshot", who: "other", seconds: 0.95, tokens: 3825 },
  { label: "Windows-MCP Snapshot + vision", who: "other", seconds: 11.2, tokens: 5191 },
];

function lookChart(t) {
  const W = 820, labelW = 236, panelW = 262, gap = 40, top = 92, rowH = 40, barH = 20;
  const H = top + LOOK_ROWS.length * rowH + 44;
  const panels = [
    // Vision mode would flatten every other bar on a 12 s axis, so it runs off
    // the end with a break and its value.
    { title: "Time per look (s, lower is better)", key: "seconds", max: 2, ticks: [0, 0.5, 1, 1.5, 2], fmt: (v) => `${v} s` },
    { title: "Tokens per look (≈, lower is better)", key: "tokens", max: 6000, ticks: [0, 2000, 4000, 6000], fmt: (v) => `${(v / 1000).toFixed(1)}K` },
  ];
  let body = text(20, 30, "Reading one app on Windows 11", { fill: t.ink, size: 16, weight: 600 });
  body += text(20, 50, "File Explorer on C:\\Windows\\System32 (4,837 items), same PC, warm calls. Median of 10 calls (3 with vision); the 11.2 s bar is cut short.", { fill: t.ink2, size: 12 });
  body += swatch(20, 74, t.munim, "munim-computer-use 0.7.3", t) + swatch(200, 74, t.other, "Windows-MCP 0.8.5", t);
  panels.forEach((p, i) => {
    const x0 = labelW + i * (panelW + gap);
    const scale = (v) => (v / p.max) * (panelW - 50);
    body += text(x0, top - 2, p.title, { fill: t.ink2, size: 12, weight: 600 });
    for (const tick of p.ticks) {
      const x = x0 + scale(tick);
      body += `<line x1="${x}" x2="${x}" y1="${top + 8}" y2="${top + LOOK_ROWS.length * rowH + 4}" stroke="${tick ? t.grid : t.axis}" stroke-width="1"/>`;
      body += text(x, top + LOOK_ROWS.length * rowH + 22, p.key === "tokens" ? `${tick / 1000}K` : `${tick} s`, { fill: t.muted, size: 11, anchor: "middle" });
    }
    LOOK_ROWS.forEach((r, j) => {
      const y = top + 8 + j * rowH + (rowH - barH) / 2;
      const clipped = r[p.key] > p.max;
      const w = clipped ? panelW - 50 + 14 : scale(r[p.key]);
      body += bar(x0, y, w, barH, t[r.who]);
      if (clipped) {
        const bx = x0 + scale(p.max) - 4;
        body += `<path d="M${bx},${y + barH + 2}l6,${-barH - 4}m4,0l-6,${barH + 4}" stroke="${t.surface}" stroke-width="3"/>`;
      }
      body += text(x0 + w + 6, y + 15, p.fmt(r[p.key]), { fill: t.ink, size: 12 });
    });
  });
  LOOK_ROWS.forEach((r, j) => {
    const y = top + 8 + j * rowH + rowH / 2 + 4;
    body += text(20, y, r.label, { fill: t.ink, size: 13, weight: r.who === "munim" ? 600 : 400 });
  });
  const desc = LOOK_ROWS.map((r) => `${r.label}: ${r.seconds} s, about ${r.tokens} tokens`).join("; ");
  return svg(W, H, "Reading one app on Windows 11: munim-computer-use vs Windows-MCP", desc, t, body);
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

// --- 3. Release-over-release speedups ----------------------------------------

const SPEEDUPS = [
  { label: "macOS Finder, 2,000 files", before: 2.2, now: 0.165 },
  { label: "Windows list, 3,000 rows", before: 2.3, now: 0.85 },
  { label: "Settle after a field edit", before: 0.35, now: 0.23 },
];

function speedupChart(t) {
  const W = 820, labelW = 210, plotW = 470, top = 92, groupH = 56, barH = 18;
  const H = top + SPEEDUPS.length * groupH + 40;
  const max = 2.5, scale = (v) => (v / max) * plotW;
  const fmt = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v} s`);
  let body = text(20, 30, "Faster with each release", { fill: t.ink, size: 16, weight: 600 });
  body += text(20, 50, "get_app_state read time and return_state settle time, before and after the changes described under Why it works well.", { fill: t.ink2, size: 12 });
  body += swatch(20, 74, t.before, "Before", t) + swatch(90, 74, t.munim, "Now", t);
  for (const tick of [0, 0.5, 1, 1.5, 2, 2.5]) {
    const x = labelW + scale(tick);
    body += `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + SPEEDUPS.length * groupH}" stroke="${tick ? t.grid : t.axis}" stroke-width="1"/>`;
    body += text(x, top + SPEEDUPS.length * groupH + 18, `${tick} s`, { fill: t.muted, size: 11, anchor: "middle" });
  }
  SPEEDUPS.forEach((s, j) => {
    const y = top + j * groupH + 8;
    body += text(20, y + 24, s.label, { fill: t.ink, size: 13 });
    body += bar(labelW, y, scale(s.before), barH, t.before);
    body += text(labelW + scale(s.before) + 6, y + 14, fmt(s.before), { fill: t.ink2, size: 12 });
    body += bar(labelW, y + barH + 2, scale(s.now), barH, t.munim);
    const factor = (s.before / s.now).toFixed(1).replace(/\.0$/, "");
    body += text(labelW + scale(s.now) + 6, y + barH + 16, `${fmt(s.now)}  (${factor}× faster)`, { fill: t.ink, size: 12, weight: 600 });
  });
  const desc = SPEEDUPS.map((s) => `${s.label}: ${s.before} s before, ${s.now} s now`).join("; ");
  return svg(W, H, "munim-computer-use speedups release over release", desc, t, body);
}

for (const [mode, t] of Object.entries(THEMES)) {
  writeFileSync(join(out, `chart-look-${mode}.svg`), lookChart(t));
  writeFileSync(join(out, `chart-coverage-${mode}.svg`), coverageChart(t));
  writeFileSync(join(out, `chart-speed-${mode}.svg`), speedupChart(t));
}
console.log(readMatrix().map((c) => `${c.name}: ${c.yes} yes, ${c.partial} partly, ${c.applicable} applicable`).join("\n"));
