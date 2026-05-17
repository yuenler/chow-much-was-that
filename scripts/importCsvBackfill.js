import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataFile = path.join(root, ".data", "finance.json");
const dryRun = process.argv.includes("--dry-run");

const imports = [
  { path: "/Users/yuenler/Downloads/Checking_Chase1416_Activity_20260516.CSV", kind: "chase-checking", mask: "1416", source: "Chase Checking 1416" },
  { path: "/Users/yuenler/Downloads/Chase7398_Activity20250516_20260516_20260516.CSV", kind: "chase-card", mask: "7398", source: "Chase Credit 7398" },
  { path: "/Users/yuenler/Downloads/2026-05-16_360Checking...4658.csv", kind: "capitalone-checking", mask: "4658", source: "Capital One 360 Checking 4658" },
  { path: "/Users/yuenler/Downloads/quicksilver_2026-05-16_transaction_download.csv", kind: "capitalone-card", mask: "6025", source: "Capital One Quicksilver 6025" },
  { path: "/Users/yuenler/Downloads/savor_2026-05-16_transaction_download.csv", kind: "capitalone-card", mask: "0554", source: "Capital One Savor 0554" },
  { path: "/Users/yuenler/Downloads/venturex_2026-05-16_transaction_download.csv", kind: "capitalone-card", mask: "7336", source: "Capital One Venture X 7336" }
];

const state = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const accountsByMask = new Map((state.accounts || []).map((account) => [String(account.mask), account]));
const existingIds = new Set((state.transactions || []).map((txn) => txn.id));
const existingSignatureCounts = new Map();

for (const txn of state.transactions || []) {
  const key = signature(txn.accountId, txn.date, txn.amount);
  existingSignatureCounts.set(key, (existingSignatureCounts.get(key) || 0) + 1);
}

const allNewTransactions = [];
const stats = [];

for (const config of imports) {
  const account = accountsByMask.get(config.mask);
  if (!account) throw new Error(`No existing account found for mask ${config.mask}`);

  const rows = parseCsv(fs.readFileSync(config.path, "utf8"));
  const sourceStats = { source: config.source, rows: rows.length, imported: 0, duplicate: 0, skippedPayment: 0, skippedInvalid: 0 };

  rows.forEach((row, index) => {
    const parsed = parseRow(row, config, account, index);
    if (!parsed) {
      sourceStats.skippedInvalid += 1;
      return;
    }
    if (shouldSkipTransferOrCardPayment(parsed)) {
      sourceStats.skippedPayment += 1;
      return;
    }
    if (existingIds.has(parsed.id)) {
      sourceStats.duplicate += 1;
      return;
    }

    const sig = signature(parsed.accountId, parsed.date, parsed.amount);
    const remainingExisting = existingSignatureCounts.get(sig) || 0;
    if (remainingExisting > 0) {
      existingSignatureCounts.set(sig, remainingExisting - 1);
      sourceStats.duplicate += 1;
      return;
    }

    allNewTransactions.push(parsed);
    sourceStats.imported += 1;
  });

  stats.push(sourceStats);
}

const nextState = {
  ...state,
  transactions: [...(state.transactions || []), ...allNewTransactions]
    .sort((a, b) => b.date.localeCompare(a.date) || String(a.name || "").localeCompare(String(b.name || ""))),
  updatedAt: new Date().toISOString()
};

console.table(stats);
console.log(`New transactions: ${allNewTransactions.length}`);

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(root, ".data", `finance.backup-before-csv-${stamp}.json`);
  fs.copyFileSync(dataFile, backup);
  fs.writeFileSync(dataFile, `${JSON.stringify(nextState, null, 2)}\n`);
  console.log(`Backed up existing data to ${backup}`);
  console.log(`Wrote ${nextState.transactions.length} total transactions to ${dataFile}`);
}

function parseRow(row, config, account, index) {
  if (config.kind === "chase-checking") return parseChaseChecking(row, config, account, index);
  if (config.kind === "chase-card") return parseChaseCard(row, config, account, index);
  if (config.kind === "capitalone-checking") return parseCapitalOneChecking(row, config, account, index);
  if (config.kind === "capitalone-card") return parseCapitalOneCard(row, config, account, index);
  return null;
}

function parseChaseChecking(row, config, account, index) {
  const posted = normalizeUsDate(row["Posting Date"]);
  const rawAmount = numberValue(row.Amount);
  if (!posted || !Number.isFinite(rawAmount)) return null;
  const description = clean(row.Description);
  const amount = roundMoney(-rawAmount);
  return makeTransaction({ account, config, index, date: posted, name: description, amount, sourceCategory: clean(row.Type), raw: row });
}

function parseChaseCard(row, config, account, index) {
  const posted = normalizeUsDate(row["Post Date"]);
  const authorized = normalizeUsDate(row["Transaction Date"]);
  const rawAmount = numberValue(row.Amount);
  if (!posted || !Number.isFinite(rawAmount)) return null;
  const description = clean(row.Description);
  const amount = roundMoney(-rawAmount);
  return makeTransaction({ account, config, index, date: posted, authorizedDate: authorized, name: description, amount, sourceCategory: clean(row.Category || row.Type), raw: row });
}

function parseCapitalOneChecking(row, config, account, index) {
  const date = normalizeShortUsDate(row["Transaction Date"]);
  const rawAmount = numberValue(row["Transaction Amount"]);
  if (!date || !Number.isFinite(rawAmount)) return null;
  const description = clean(row["Transaction Description"]);
  const isCredit = clean(row["Transaction Type"]).toLowerCase() === "credit";
  const amount = roundMoney(isCredit ? -rawAmount : rawAmount);
  return makeTransaction({ account, config, index, date, name: description, amount, sourceCategory: clean(row["Transaction Type"]), raw: row });
}

function parseCapitalOneCard(row, config, account, index) {
  const posted = normalizeIsoDate(row["Posted Date"]);
  const authorized = normalizeIsoDate(row["Transaction Date"]);
  const debit = numberValue(row.Debit);
  const credit = numberValue(row.Credit);
  if (!posted || (!Number.isFinite(debit) && !Number.isFinite(credit))) return null;
  const description = clean(row.Description);
  const amount = roundMoney(Number.isFinite(debit) ? debit : -credit);
  return makeTransaction({ account, config, index, date: posted, authorizedDate: authorized, name: description, amount, sourceCategory: clean(row.Category), raw: row });
}

function makeTransaction({ account, config, index, date, authorizedDate = null, name, amount, sourceCategory, raw }) {
  const id = `csv_${hash(`${config.source}|${index}|${date}|${amount}|${name}`)}`;
  return {
    id,
    accountId: account.id,
    date,
    authorizedDate,
    name,
    merchantName: merchantFromDescription(name),
    displayName: "",
    amount,
    isoCurrencyCode: "USD",
    pending: false,
    paymentChannel: inferPaymentChannel(name),
    plaidCategory: sourceCategory || "",
    category: inferCategory(name, sourceCategory, amount),
    context: "",
    notes: "",
    recurring: false,
    aiSummary: "",
    reviewed: false,
    hidden: false,
    raw: {
      source: config.source,
      sourceKind: config.kind,
      sourceFile: path.basename(config.path),
      row: raw
    }
  };
}

function shouldSkipTransferOrCardPayment(txn) {
  const text = `${txn.name || ""} ${txn.plaidCategory || ""}`.toLowerCase();
  if (/payment thank|automatic payment|autopay|online pymt|online pmt|mobile pymt/.test(text)) return true;
  if (/crcardpmt|crc?ard ?pmt|credit crd autopay|card ending in|bppy?mt|card payment/.test(text)) return true;
  if (/returned ach card payment/.test(text)) return true;
  if (/capital one\s+transfer/.test(text)) return true;
  if (/preauthorized deposit from jpmorgan chase bank/.test(text)) return true;
  if (/capital one online pmt|capital one online pymt|capital one autopay pymt|capital one mobile pymt/.test(text)) return true;
  return false;
}

function inferCategory(name, sourceCategory, amount) {
  const text = `${name || ""} ${sourceCategory || ""}`.toLowerCase();
  if (/\b(payroll|deposit from amazon|harvard universi|interest paid)\b/.test(text) && amount < 0) return "Income";
  if (/\b(venmo|zelle|paypal|cash app)\b/.test(text)) return "Venmo / Zelle";
  if (/\b(bilt|rent|evolve seattle|equity residential|e?qr web pay)\b/.test(text)) return "Housing";
  if (/\b(uber\s+\*trip|lyft|mbta|orca|parking|transit|transport|gas|fuel|toll)\b/.test(text)) return "Transport";
  if (/\b(avis|hotel|airbnb|airlines?|flight|travel|lodging|other travel)\b/.test(text)) return "Travel";
  if (/\b(safeway|trader joe|h mart|wholefds|whole foods|grocery|groceries|supermarket|russell s convenience)\b/.test(text)) return "Groceries";
  if (/\b(dining|restaurant|cafe|coffee|doordash|ubereats|uber\s+\*eats|tst\*|food|drink|gelato)\b/.test(text)) return "Dining";
  if (/\b(apple\.com\/bill|spotify|netflix|hulu|entertainment)\b/.test(text)) return "Entertainment";
  if (/\b(openai|subscription|subscriptions|bills & utilities)\b/.test(text)) return "Subscriptions";
  if (/\b(fee|interest charge|fees & adjustments|late fee|past due fee)\b/.test(text)) return "Fees";
  if (/\b(medical|doctor|pharmacy|health)\b/.test(text)) return "Health";
  if (/\b(irs|tax)\b/.test(text)) return "Fees";
  if (/\b(merchandise|shopping|target|amazon|ikea|services|other)\b/.test(text)) return "Shopping";
  if (amount < 0) return "Income";
  return "Uncategorized";
}

function inferPaymentChannel(name) {
  const text = String(name || "").toLowerCase();
  if (/venmo|zelle|ach|web id|online|autopay|transfer|deposit|payroll/.test(text)) return "online";
  return "other";
}

function merchantFromDescription(name) {
  return clean(name)
    .replace(/\s{2,}.*/, "")
    .replace(/\b(PPD ID|WEB ID|JPM\d+).*/i, "")
    .trim() || null;
}

function signature(accountId, date, amount) {
  return `${accountId}|${date}|${Math.round(Number(amount || 0) * 100)}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function clean(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function numberValue(value) {
  const text = String(value ?? "").replace(/[$,]/g, "").trim();
  if (!text) return NaN;
  return Number(text);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeIsoDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeUsDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function normalizeShortUsDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!match) return null;
  const year = Number(match[3]) >= 70 ? `19${match[3]}` : `20${match[3]}`;
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      field += "\"";
      index += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((item) => item !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((item) => item !== "")) rows.push(row);
  }

  const [headers, ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])));
}
