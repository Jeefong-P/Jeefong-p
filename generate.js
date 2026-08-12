#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GITHUB_TOKEN;
const USER = process.env.GITHUB_USER;
const OUTPUT = process.env.OUTPUT || 'dist/bossfight.svg';
const PALETTE_NAME = process.env.PALETTE || 'dark';

const QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

function graphql(query, variables) {
  const body = JSON.stringify({ query, variables });
  const options = {
    hostname: 'api.github.com',
    path: '/graphql',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `bearer ${TOKEN}`,
      'User-Agent': 'github-bossfight'
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) return reject(new Error(JSON.stringify(json.errors)));
          resolve(json.data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Build fake-but-realistic weeks data so the renderer can be tested without
// a token or network access.
function mockWeeks() {
  const weeks = [];
  for (let w = 0; w < 20; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const r = Math.random();
      const count = r < 0.35 ? 0 : Math.floor(Math.random() * 12);
      days.push({ date: `2026-01-${((w * 7 + d) % 28) + 1}`, contributionCount: count });
    }
    weeks.push({ contributionDays: days });
  }
  return weeks;
}

// Walk the grid column by column, alternating direction each column, so the
// hero moves through physically adjacent cells instead of teleporting.
function buildPath(weeks) {
  const cells = [];
  weeks.forEach((week, col) => {
    const days = week.contributionDays;
    const ordered = col % 2 === 0 ? days : [...days].slice().reverse();
    ordered.forEach((day, i) => {
      const row = col % 2 === 0 ? i : 6 - i;
      cells.push({ col, row, date: day.date, count: day.contributionCount });
    });
  });
  return cells;
}

const PALETTES = {
  dark: {
    bg: '#0d1117',
    empty: '#161b22',
    levels: ['#0e4429', '#006d32', '#26a641', '#39d353'],
    hero: '#ffcc00',
    heroStroke: '#7a5c00',
    bossBar: '#ff4d4d',
    bossBarBg: '#3a1414',
    text: '#c9d1d9'
  },
  light: {
    bg: '#ffffff',
    empty: '#ebedf0',
    levels: ['#9be9a8', '#40c463', '#30a14e', '#216e39'],
    hero: '#c98a00',
    heroStroke: '#8a5f00',
    bossBar: '#e5484d',
    bossBarBg: '#f6d9d9',
    text: '#24292f'
  }
};

function levelColor(count, palette) {
  if (count === 0) return palette.empty;
  if (count < 3) return palette.levels[0];
  if (count < 6) return palette.levels[1];
  if (count < 10) return palette.levels[2];
  return palette.levels[3];
}

function buildSVG(cells, paletteName) {
  const palette = PALETTES[paletteName] || PALETTES.dark;
  const CELL = 11;
  const GAP = 3;
  const STEP = CELL + GAP;
  const MARGIN = 20;
  const TOP_OFFSET = 40; // space reserved for the boss bar + label
  const cols = Math.max(...cells.map((c) => c.col)) + 1;
  const rows = 7;
  const width = MARGIN * 2 + cols * STEP;
  const height = MARGIN + TOP_OFFSET + rows * STEP + MARGIN;

  // Each cell deals damage proportional to its contribution count, with a
  // floor of 1 so zero-contribution days still register as a small hit
  // (otherwise the boss bar would stall on quiet weeks).
  const totalWeight = cells.reduce((s, c) => s + Math.max(c.count, 1), 0);
  const perCellDamage = cells.map((c) => Math.max(c.count, 1) / totalWeight);

  const FRAME_DUR = 0.16; // seconds of "hang time" the hero spends per cell
  const totalDuration = +(cells.length * FRAME_DUR).toFixed(2);

  // HP keyframes for the boss bar.
  let hpRemaining = 1;
  const hpKeyTimes = ['0'];
  const hpValues = ['100.00'];
  cells.forEach((c, i) => {
    hpRemaining = Math.max(0, hpRemaining - perCellDamage[i]);
    const t = ((i + 1) * FRAME_DUR) / totalDuration;
    hpKeyTimes.push(Math.min(1, t).toFixed(4));
    hpValues.push((hpRemaining * 100).toFixed(2));
  });

  const bossBarWidth = width - MARGIN * 2;
  const hpWidths = hpValues.map((v) => ((bossBarWidth * parseFloat(v)) / 100).toFixed(2));

  // Cells fade: original color -> hero-hit flash -> cleared, timed to when
  // the hero reaches that cell.
  const cellEls = cells
    .map((c, i) => {
      const x = MARGIN + c.col * STEP;
      const y = MARGIN + TOP_OFFSET + c.row * STEP;
      const original = levelColor(c.count, palette);
      const beginT = (i * FRAME_DUR).toFixed(3);
      return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${original}"><animate attributeName="fill" values="${original};${palette.hero};${palette.empty}" keyTimes="0;0.5;1" dur="${(FRAME_DUR * 2).toFixed(3)}s" begin="${beginT}s" fill="freeze"/></rect>`;
    })
    .join('\n  ');

  // Hero motion path through cell centers.
  const motionPoints = cells.map((c) => {
    const x = MARGIN + c.col * STEP + CELL / 2;
    const y = MARGIN + TOP_OFFSET + c.row * STEP + CELL / 2;
    return `${x},${y}`;
  });
  const pathD = 'M' + motionPoints.join(' L');
  const heroKeyTimes = cells.map((_, i) => (cells.length > 1 ? i / (cells.length - 1) : 0).toFixed(4)).join(';');

  const clearedLabel = `<text x="${width - MARGIN}" y="20" fill="${palette.text}" font-size="11" text-anchor="end" opacity="0"><animate attributeName="opacity" values="0;0;1" keyTimes="0;0.98;1" dur="${totalDuration}s" begin="0s" fill="freeze"/>DEFEATED</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${palette.bg}"/>
  <text x="${MARGIN}" y="20" fill="${palette.text}" font-size="11" font-weight="600">BOSS</text>
  ${clearedLabel}
  <rect x="${MARGIN}" y="24" width="${bossBarWidth}" height="8" rx="4" fill="${palette.bossBarBg}"/>
  <rect x="${MARGIN}" y="24" width="${hpWidths[0]}" height="8" rx="4" fill="${palette.bossBar}"><animate attributeName="width" keyTimes="${hpKeyTimes.join(';')}" values="${hpWidths.join(';')}" dur="${totalDuration}s" begin="0s" fill="freeze" calcMode="linear"/></rect>
  ${cellEls}
  <circle cx="${MARGIN + cells[0].col * STEP + CELL / 2}" cy="${MARGIN + TOP_OFFSET + cells[0].row * STEP + CELL / 2}" r="5" fill="${palette.hero}" stroke="${palette.heroStroke}" stroke-width="1.5"><animateMotion path="${pathD}" keyTimes="${heroKeyTimes}" dur="${totalDuration}s" begin="0s" fill="freeze" calcMode="linear"/></circle>
</svg>`;
}

async function main() {
  let weeks;
  if (process.env.MOCK === '1') {
    weeks = mockWeeks();
  } else {
    if (!TOKEN || !USER) {
      console.error('GITHUB_TOKEN and GITHUB_USER are required (or set MOCK=1 to test locally).');
      process.exit(1);
    }
    const data = await graphql(QUERY, { login: USER });
    weeks = data.user.contributionsCollection.contributionCalendar.weeks;
  }

  const cells = buildPath(weeks);
  const svg = buildSVG(cells, PALETTE_NAME);
  const outPath = path.resolve(OUTPUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, 'utf8');
  console.log(`Wrote ${outPath} (${cells.length} cells, palette=${PALETTE_NAME})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
