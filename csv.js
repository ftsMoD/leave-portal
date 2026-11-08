// CSV builder. Text cells starting with = + - @ are prefixed with ' so Excel
// never evaluates them as formulas (CSV injection).

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Leading BOM so Excel opens UTF-8 correctly.
const toCsv = (headers, rows) => `﻿${[headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

module.exports = { toCsv };
