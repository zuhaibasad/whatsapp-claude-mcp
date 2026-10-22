// Pure pattern matching over OCR text of receipts / payment screenshots. No AI, no network.
// Output is untrusted data (it comes from an image someone sent).
import type { OcrFields } from '../core/types.js';

const CUR = String.raw`(PKR|Rs\.?|₨|USD|US\$|\$|AED|SAR|INR|EUR|€|GBP|£)`;
const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const CUR_FIRST = new RegExp(`${CUR}\\s?${NUM}`, 'gi');
const CUR_AFTER = new RegExp(`${NUM}\\s?(PKR|Rs\\.?|/-)`, 'gi');
const TOTAL_LINE = /\b(total|amount|paid|transferred|sent|net payable|grand total|bill)\b/i;

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATES = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  new RegExp(String.raw`\b\d{1,2}[\s-]${MONTH}[\s,-]+\d{4}\b`, 'i'),
  new RegExp(String.raw`\b${MONTH}\s+\d{1,2},?\s+\d{4}\b`, 'i'),
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/,
];

const REF = /\b(?:transaction|trx|txn|tran|ref(?:erence)?|tid|receipt|stan|rrn)\b\.?\s*(?:id|no|number|#)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{5,})/i;

const BANKS = [
  'JazzCash', 'Easypaisa', 'NayaPay', 'SadaPay', 'Raast', 'Meezan', 'HBL', 'UBL', 'MCB', 'Allied Bank', 'ABL',
  'Bank Alfalah', 'Alfalah', 'Faysal', 'Askari', 'Standard Chartered', 'BankIslami', 'Bank Islami', 'Habib Metro',
  'JS Bank', 'Dubai Islamic', 'National Bank', 'NBP', 'Al Baraka', 'Soneri', 'Bank of Punjab', 'BOP', 'Silkbank',
  'Summit', 'Samba', 'Payoneer', 'Wise', 'PayPal', 'Emirates NBD', 'ADCB', 'FAB', 'Mashreq',
];
const BANK_RE = BANKS.map((name) => ({ name, re: new RegExp(`\\b${name.replace(/ /g, '\\s?')}\\b`, 'i') }));

function normCurrency(c: string): string {
  const u = c.toUpperCase().replace(/\.$/, '');
  if (u === 'RS' || u === '₨' || u === '/-') return 'PKR';
  if (u === '$' || u === 'US$') return 'USD';
  if (u === '€') return 'EUR';
  if (u === '£') return 'GBP';
  return u;
}

const value = (s: string): number => Number(s.replace(/,/g, ''));

interface Hit { currency: string; num: string; line: number }

function amountsOf(lines: string[]): Hit[] {
  const hits: Hit[] = [];
  lines.forEach((ln, line) => {
    for (const m of ln.matchAll(CUR_FIRST)) if (m[1] && m[2]) hits.push({ currency: normCurrency(m[1]), num: m[2], line });
    for (const m of ln.matchAll(CUR_AFTER)) if (m[1] && m[2]) hits.push({ currency: normCurrency(m[2]), num: m[1], line });
  });
  return hits.filter((h) => value(h.num) > 0);
}

/** Extracts amount/currency/date/reference/bank. Fields that are not found are left out. */
export function extractOcrFields(text: string): OcrFields {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: OcrFields = {};

  const hits = amountsOf(lines);
  if (hits.length > 0) {
    const labelled = hits.find((h) => TOTAL_LINE.test(lines[h.line] ?? ''));
    const best = labelled ?? hits.reduce((a, b) => (value(b.num) > value(a.num) ? b : a));
    out.amount = `${best.currency} ${best.num}`;
    out.currency = best.currency;
    const all = [...new Set(hits.map((h) => `${h.currency} ${h.num}`))];
    if (all.length > 1) out.amounts = all.slice(0, 10);
  }

  for (const re of DATES) {
    const m = re.exec(text);
    if (m) { out.date = m[0]; break; }
  }

  const ref = REF.exec(text);
  if (ref?.[1] && /\d/.test(ref[1])) out.reference = ref[1];

  const bank = BANK_RE.find((x) => x.re.test(text));
  if (bank) out.bank = bank.name;
  return out;
}
