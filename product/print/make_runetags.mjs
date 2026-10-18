// Printable RuneTag sheets for the floor (ids 0-3), the same drawing the detector expects (dashboard/public/runetag.js).
// Run: node product/print/make_runetags.mjs   -> product/print/runetags_A3.pdf (one A3 page per id, vector, no dependencies)
// Print at 100% ("actual size", no fit-to-page), check the 100 mm bar, cut on the crop marks: each sheet is 250 mm square.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUNE, RUNE_IDS, runePrims } from '../dashboard/public/runetag.js';

const PT = 72 / 25.4, PAGE = [297, 420];             // A3 portrait, mm
const SIDE = RUNE.sheet * 1000, X0 = (PAGE[0] - SIDE) / 2, Y0 = 100; // sheet's lower-left corner on the page (mm from the bottom-left)
const f = v => (+v.toFixed(3)).toString();
const P = (x, y) => `${f(x * PT)} ${f(y * PT)}`;       // mm -> PDF user space
const M = ([x, y]) => [X0 + SIDE / 2 + x * 1000, Y0 + SIDE / 2 + y * 1000]; // marker frame (m, y up) -> page mm
const K = .5523;
const circlePath = (c, r) => { // four Béziers, mm
  const [x, y] = c, k = K * r;
  return `${P(x + r, y)} m ${P(x + r, y + k)} ${P(x + k, y + r)} ${P(x, y + r)} c ${P(x - k, y + r)} ${P(x - r, y + k)} ${P(x - r, y)} c `
    + `${P(x - r, y - k)} ${P(x - k, y - r)} ${P(x, y - r)} c ${P(x + k, y - r)} ${P(x + r, y - k)} ${P(x + r, y)} c h`;
};
const text = (x, y, size, s) => `BT /F1 ${size} Tf ${P(x, y)} Td (${s.replace(/[\\()]/g, '\\$&')}) Tj ET`;

function page(id) {
  const o = ['1 J 1 j 0 g 0 G'];
  for (const p of runePrims(id)) {
    if (p.t === 'disc') o.push(`${circlePath(M(p.c), p.r * 1000)} f`);
    else if (p.t === 'circle') o.push(`${f(p.w * 1000 * PT)} w ${circlePath(M(p.c), p.r * 1000)} S`);
    else o.push(`${f(p.w * 1000 * PT)} w ${p.p.map((q, i) => `${P(...M(q))} ${i ? 'l' : 'm'}`).join(' ')}${p.closed ? ' h' : ''} S`);
  }
  // cutting guides: a light dashed line on the cut, crop marks outside each corner
  o.push(`0.6 G ${f(.2 * PT)} w [${f(2 * PT)} ${f(2 * PT)}] 0 d ${P(X0, Y0)} ${f(SIDE * PT)} ${f(SIDE * PT)} re S [] 0 d 0 G`);
  o.push(`${f(.25 * PT)} w`);
  for (const [cx, cy, sx, sy] of [[X0, Y0, -1, -1], [X0 + SIDE, Y0, 1, -1], [X0 + SIDE, Y0 + SIDE, 1, 1], [X0, Y0 + SIDE, -1, 1]])
    o.push(`${P(cx + 3 * sx, cy)} m ${P(cx + 15 * sx, cy)} l S ${P(cx, cy + 3 * sy)} m ${P(cx, cy + 15 * sy)} l S`);
  // header
  const top = PAGE[1] - 22;
  o.push(text(X0, top, 26, `RuneTag  ID ${id}`));
  o.push(text(X0, top - 10, 10, 'Floor sheet for the RuneTag marker mode (dashboard: Connect > marker = RuneTag).'));
  o.push(text(X0, top - 16, 10, `Cut on the crop marks: ${SIDE} x ${SIDE} mm. Print at 100% / actual size on A3, no fit-to-page.`));
  o.push(text(X0, top - 22, 10, 'The seal with the arrow marks the TOP edge. Keep the dots clean and the sheet flat.'));
  // the layout: four sheets edge to edge, seen from above, top edges away from the camera (world.js map4)
  const bx = X0, by = 22, s = 14, at = { 0: [0, 1], 1: [1, 1], 2: [1, 0], 3: [0, 0] };
  o.push(text(bx, by + 2 * s + 9, 9, 'Layout on the floor, seen from above:'));
  for (const [i, [cx, cy]] of Object.entries(at)) {
    const x = bx + cx * s, y = by + cy * s;
    o.push(`${+i === id ? '0.75 g' : '1 g'} ${P(x, y)} ${f(s * PT)} ${f(s * PT)} re f 0 g ${f(.3 * PT)} w ${P(x, y)} ${f(s * PT)} ${f(s * PT)} re S`);
    o.push(text(x + s / 2 - 1.6, y + s / 2 - 1.8, 10, i));
  }
  o.push(text(bx + 2 * s + 5, by + 2 * s - 4, 9, 'far side (top edges point this way)'));
  o.push(text(bx + 2 * s + 5, by + 2, 9, 'camera (phone C) side'));
  o.push(text(bx + 2 * s + 5, by + s - 1, 9, `edge to edge: centres ${SIDE} mm apart`));
  // 100 mm scale bar
  const sx = X0 + SIDE - 100, sy = 34;
  o.push(`${P(sx, sy)} ${f(100 * PT)} ${f(2 * PT)} re f`);
  for (let i = 0; i <= 10; i++) o.push(`${f(.25 * PT)} w ${P(sx + 10 * i, sy + 2)} m ${P(sx + 10 * i, sy + (i % 5 ? 4 : 6))} l S`);
  o.push(text(sx, sy - 6, 9, '100 mm: if this bar is not 100 mm, the printer scaled the page'));
  return o.join('\n');
}

const objs = [];
const obj = s => (objs.push(s), objs.length);
const font = obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const pagesId = objs.length + 1 + RUNE_IDS.length * 2 + 1; // reserved below
const kids = RUNE_IDS.map(id => {
  const s = page(id), c = obj(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`);
  return obj(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(PAGE[0] * PT)} ${f(PAGE[1] * PT)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`);
});
const catalog = obj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
if (obj(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`) !== pagesId) throw new Error('object numbering');
let pdf = '%PDF-1.4\n', offs = [];
objs.forEach((s, i) => { offs.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${s}\nendobj\n`; });
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const out = fileURLToPath(new URL('./runetags_A3.pdf', import.meta.url));
writeFileSync(out, pdf, 'latin1');
console.log('wrote', out);
