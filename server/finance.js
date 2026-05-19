import {
  addMonths,
  eachWeekOfInterval,
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  max as maxDate,
  min as minDate,
  parseISO,
  startOfMonth,
  startOfYear
} from "date-fns";

export const VENMO_ZELLE_PATTERN = /\b(venmo|zelle|paypal instant transfer|cash app)\b/i;

export function currentMonthKey(date = new Date()) {
  return format(date, "yyyy-MM");
}

export function monthBounds(month = currentMonthKey()) {
  const start = startOfMonth(parseISO(`${month}-01`));
  const end = endOfMonth(start);
  return { start: format(start, "yyyy-MM-dd"), end: format(end, "yyyy-MM-dd") };
}

export function normalizeAccount(account) {
  return {
    id: account.account_id,
    name: account.name,
    officialName: account.official_name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    currentBalance: account.balances?.current ?? 0,
    availableBalance: account.balances?.available ?? null,
    limit: account.balances?.limit ?? null,
    isoCurrencyCode: account.balances?.iso_currency_code ?? "USD"
  };
}

export function normalizeTransaction(txn, existing = null, state) {
  const vendor = txn.merchant_name || txn.name || "Unknown";
  const plaidCategory = txn.personal_finance_category?.primary || txn.category?.[0] || null;
  const rule = ruleFromRules(vendor, txn.name, state.rules);
  const defaultCategory = inferDefaultCategory(vendor, txn.name, plaidCategory);
  const category = existing?.category || rule?.category || defaultCategory;
  const context = existing?.context || rule?.context || "";
  const hidden = existing?.hidden || Boolean(rule?.ignore);

  return {
    id: txn.transaction_id,
    accountId: txn.account_id,
    date: txn.date,
    authorizedDate: txn.authorized_date,
    name: txn.name,
    merchantName: txn.merchant_name,
    displayName: existing?.displayName || "",
    amount: Number(txn.amount || 0),
    isoCurrencyCode: txn.iso_currency_code || "USD",
    pending: Boolean(txn.pending),
    paymentChannel: txn.payment_channel,
    plaidCategory,
    category,
    context,
    notes: existing?.notes || "",
    recurring: existing?.recurring || false,
    aiSummary: existing?.aiSummary || "",
    reviewed: existing?.reviewed || false,
    hidden,
    raw: txn
  };
}

export function inferDefaultCategory(merchant, name, plaidCategory) {
  const label = `${merchant || ""} ${name || ""}`;
  if (VENMO_ZELLE_PATTERN.test(label)) return "Venmo / Zelle";

  const category = (plaidCategory || "").toUpperCase();
  if (category.includes("FOOD_AND_DRINK")) return "Dining";
  if (category.includes("GENERAL_MERCHANDISE")) return "Shopping";
  if (category.includes("TRANSPORTATION")) return "Transport";
  if (category.includes("TRAVEL")) return "Travel";
  if (category.includes("RENT") || category.includes("HOME")) return "Housing";
  if (category.includes("TRANSFER")) return "Transfers";
  if (category.includes("BANK_FEES")) return "Fees";
  if (category.includes("LOAN_PAYMENTS")) return "Debt Payments";
  if (category.includes("INCOME")) return "Income";
  if (category.includes("MEDICAL")) return "Health";
  if (category.includes("ENTERTAINMENT")) return "Entertainment";
  return "Uncategorized";
}

export function categoryFromRules(merchant, name, rules = []) {
  return ruleFromRules(merchant, name, rules)?.category || null;
}

export function ruleFromRules(merchant, name, rules = []) {
  const label = `${merchant || ""} ${name || ""}`.toLowerCase();
  const rule = rules.find((candidate) => {
    if (!candidate.active) return false;
    return label.includes(candidate.match.toLowerCase());
  });
  if (!rule) return null;
  return {
    ...rule,
    context: rule.context || rule.label || rule.labelOverride || "",
    ignore: Boolean(rule.ignore)
  };
}

export function transactionLabel(txn) {
  return txn.category || "Uncategorized";
}

export function publicTransaction(txn, state) {
  const account = state.accounts.find((item) => item.id === txn.accountId);
  return {
    id: txn.id,
    date: txn.date,
    authorizedDate: txn.authorizedDate,
    accountId: txn.accountId,
    accountName: account?.name || "",
    accountMask: account?.mask || "",
    accountType: account?.type || "",
    accountSubtype: account?.subtype || "",
    merchantName: txn.merchantName,
    name: txn.name,
    displayName: txn.displayName || "",
    amount: txn.amount,
    category: txn.category,
    context: txn.context || "",
    plaidCategory: txn.plaidCategory || "",
    label: transactionLabel(txn),
    notes: txn.notes || "",
    paymentChannel: txn.paymentChannel,
    pending: Boolean(txn.pending),
    reviewed: Boolean(txn.reviewed),
    hidden: Boolean(txn.hidden),
    aiSummary: txn.aiSummary || ""
  };
}

export function queryTransactions(state, filters = {}) {
  const query = String(filters.query || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const includeHidden = Boolean(filters.includeHidden);
  const ids = Array.isArray(filters.ids) ? new Set(filters.ids.map(String)) : null;
  const labels = toSet(filters.labels || filters.label);
  const categories = toSet(filters.categories || filters.category);
  const contexts = toSet(filters.contexts || filters.context);
  const accountIds = toSet(filters.accountIds || filters.accountId);
  const accountNames = toSet(filters.accountNames || filters.accountName);
  const accountMasks = toSet(filters.accountMasks || filters.accountMask);
  const accountTypes = toSet(filters.accountTypes || filters.accountType);
  const startDate = validDateLike(filters.startDate) ? filters.startDate : null;
  const endDate = validDateLike(filters.endDate) ? filters.endDate : null;
  const minAmount = filters.minAmount === null || filters.minAmount === undefined ? null : Number(filters.minAmount);
  const maxAmount = filters.maxAmount === null || filters.maxAmount === undefined ? null : Number(filters.maxAmount);
  const direction = filters.direction || null;

  const rows = state.transactions
    .filter((txn) => {
      const account = state.accounts.find((item) => item.id === txn.accountId);
      const label = transactionLabel(txn);
      const searchable = [
        txn.id,
        txn.date,
        txn.authorizedDate,
        txn.displayName,
        txn.merchantName,
        txn.name,
        txn.category,
        txn.context,
        label,
        txn.notes,
        txn.paymentChannel,
        txn.plaidCategory,
        account?.name,
        account?.officialName,
        account?.mask,
        account?.type,
        account?.subtype,
        String(txn.amount)
      ].filter(Boolean).join(" ").toLowerCase();

      if (!includeHidden && txn.hidden) return false;
      if (ids && !ids.has(txn.id)) return false;
      if (query && !searchable.includes(query)) return false;
      if (startDate && txn.date < startDate) return false;
      if (endDate && txn.date > endDate) return false;
      if (labels && !labels.has(label.toLowerCase())) return false;
      if (categories && !categories.has(String(txn.category || "").toLowerCase())) return false;
      if (contexts && !contexts.has(String(txn.context || "").toLowerCase())) return false;
      if (accountIds && !accountIds.has(String(txn.accountId || "").toLowerCase())) return false;
      if (accountNames && !accountNames.has(String(account?.name || "").toLowerCase()) && !accountNames.has(String(account?.officialName || "").toLowerCase())) return false;
      if (accountMasks && !accountMasks.has(String(account?.mask || "").toLowerCase())) return false;
      if (accountTypes && !accountTypes.has(String(account?.type || "").toLowerCase()) && !accountTypes.has(String(account?.subtype || "").toLowerCase())) return false;
      if (Number.isFinite(minAmount) && Math.abs(txn.amount) < minAmount) return false;
      if (Number.isFinite(maxAmount) && Math.abs(txn.amount) > maxAmount) return false;
      if (direction === "spending" && txn.amount <= 0) return false;
      if (direction === "income" && txn.amount >= 0) return false;
      if (filters.reviewed !== undefined && Boolean(txn.reviewed) !== Boolean(filters.reviewed)) return false;
      if (filters.pending !== undefined && Boolean(txn.pending) !== Boolean(filters.pending)) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map((txn) => publicTransaction(txn, state));

  return {
    count: rows.length,
    limit,
    filters: {
      query: filters.query || null,
      startDate,
      endDate,
      labels: labels ? Array.from(labels) : null,
      categories: categories ? Array.from(categories) : null,
      contexts: contexts ? Array.from(contexts) : null,
      accountIds: accountIds ? Array.from(accountIds) : null,
      accountMasks: accountMasks ? Array.from(accountMasks) : null,
      accountTypes: accountTypes ? Array.from(accountTypes) : null,
      direction,
      minAmount: Number.isFinite(minAmount) ? minAmount : null,
      maxAmount: Number.isFinite(maxAmount) ? maxAmount : null
    },
    transactions: rows
  };
}

export function upsertById(list, item) {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...list, item];
  const copy = [...list];
  copy[index] = { ...copy[index], ...item };
  return copy;
}

export function summarizeFinance(state, range = currentMonthKey()) {
  const period = normalizeRange(range);
  const periodTransactions = state.transactions.filter((txn) => {
    const { start, end } = period;
    return !txn.hidden && txn.date >= start && txn.date <= end;
  });
  const periodIncomeStatements = (state.incomeStatements || []).filter((statement) => {
    const date = statement.payDate || statement.periodEnd || statement.periodStart;
    const { start, end } = period;
    return date && date >= start && date <= end;
  });

  const spendingTransactions = periodTransactions.filter((txn) => txn.amount > 0);
  const incomeTransactions = periodTransactions.filter((txn) => txn.amount < 0);
  const totalSpend = round(spendingTransactions.reduce((sum, txn) => sum + txn.amount, 0));
  const totalIncome = round(Math.abs(incomeTransactions.reduce((sum, txn) => sum + txn.amount, 0)));
  const netCashflow = round(totalIncome - totalSpend);

  const fixedNames = new Set(state.categories.map((category) => category.name));
  const fixedRows = state.categories.map((category) => {
    const spent = round(
      spendingTransactions
        .filter((txn) => transactionLabel(txn) === category.name)
        .reduce((sum, txn) => sum + txn.amount, 0)
    );
    return {
      name: category.name,
      spent,
      budget: category.monthlyBudget,
      color: category.color,
      remaining: round((category.monthlyBudget || 0) - spent)
    };
  });
  const customRows = Array.from(
    spendingTransactions.reduce((totals, txn) => {
      const label = transactionLabel(txn);
      if (fixedNames.has(label)) return totals;
      totals.set(label, round((totals.get(label) || 0) + txn.amount));
      return totals;
    }, new Map())
  )
    .map(([name, spent]) => ({
      name,
      spent,
      budget: 0,
      color: colorForLabel(name),
      remaining: round(-spent),
      custom: true
    }))
    .sort((a, b) => b.spent - a.spent);

  const byCategory = [...fixedRows, ...customRows];

  const accountTotals = state.accounts.reduce(
    (totals, account) => {
      if (account.type === "credit") {
        totals.creditDebt += Math.max(account.currentBalance || 0, 0);
        totals.creditLimit += account.limit || 0;
      } else {
        totals.cash += account.currentBalance || 0;
      }
      return totals;
    },
    { cash: 0, creditDebt: 0, creditLimit: 0 }
  );

  const monthlyTrend = trendForRange(state, period);

  const recurring = detectRecurring(periodTransactions);
  const topMerchants = topByMerchant(spendingTransactions);
  const byContext = Array.from(
    spendingTransactions.reduce((totals, txn) => {
      const context = txn.context || "No context";
      totals.set(context, round((totals.get(context) || 0) + txn.amount));
      return totals;
    }, new Map())
  )
    .map(([name, spent]) => ({ name, spent, color: name === "No context" ? "#94a3b8" : colorForLabel(name) }))
    .sort((a, b) => b.spent - a.spent);

  const uncategorizedCount = periodTransactions.filter((txn) => txn.category === "Uncategorized").length;
  const incomeBreakdown = summarizeIncomeStatements(periodIncomeStatements);

  return {
    month: period.month,
    period,
    totalSpend,
    totalIncome,
    netCashflow,
    byCategory,
    byContext,
    incomeBreakdown,
    accountTotals: {
      cash: round(accountTotals.cash),
      creditDebt: round(accountTotals.creditDebt),
      creditLimit: round(accountTotals.creditLimit),
      utilization: accountTotals.creditLimit ? round((accountTotals.creditDebt / accountTotals.creditLimit) * 100) : 0
    },
    monthlyTrend,
    recurring,
    topMerchants,
    uncategorizedCount,
    transactionCount: periodTransactions.length,
    incomeStatementCount: periodIncomeStatements.length,
    connectedInstitutionCount: state.plaidItems.length,
    nextMonth: currentMonthKey(addMonths(parseISO(`${period.month}-01`), 1))
  };
}

function incomeStatementPayDate(statement) {
  return statement.payDate || statement.periodEnd || statement.periodStart || "";
}

function summarizeIncomeStatements(statements) {
  const totals = statements.reduce((sum, statement) => ({
    grossPay: sum.grossPay + Number(statement.grossPay || 0),
    taxes: sum.taxes + Number(statement.taxes || 0),
    retirement401k: sum.retirement401k + Number(statement.retirement401k || 0),
    benefits: sum.benefits + Number(statement.benefits || 0),
    takeHome: sum.takeHome + Number(statement.takeHome || 0)
  }), { grossPay: 0, taxes: 0, retirement401k: 0, benefits: 0, takeHome: 0 });

  const sources = Array.from(
    statements.reduce((groups, statement) => {
      const name = incomeSourceName(statement);
      const current = groups.get(name) || { name, grossPay: 0, count: 0 };
      current.grossPay += Number(statement.grossPay || 0);
      current.count += 1;
      groups.set(name, current);
      return groups;
    }, new Map()).values()
  )
    .map((source) => ({ ...source, grossPay: round(source.grossPay) }))
    .filter((source) => source.grossPay > 0)
    .sort((a, b) => b.grossPay - a.grossPay);

  return {
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])),
    count: statements.length,
    sources
  };
}

function incomeSourceName(statement) {
  const label = String(statement.employer || statement.fileName || "Income").trim();
  if (/amazon/i.test(label)) return "Amazon";
  if (/harvard/i.test(label)) return "Edtech";
  return label || "Income";
}

function normalizeRange(range) {
  if (typeof range === "string") {
    const bounds = monthBounds(range);
    return { mode: "month", month: range, year: range.slice(0, 4), start: bounds.start, end: bounds.end, label: format(parseISO(`${range}-01`), "MMMM yyyy") };
  }

  if (range?.mode === "custom" && validDateLike(range.start) && validDateLike(range.end)) {
    const start = range.start <= range.end ? range.start : range.end;
    const end = range.start <= range.end ? range.end : range.start;
    return {
      mode: "custom",
      month: end.slice(0, 7),
      year: end.slice(0, 4),
      start,
      end,
      label: `${format(parseISO(start), "MMM d, yyyy")} - ${format(parseISO(end), "MMM d, yyyy")}`
    };
  }

  const mode = range?.mode === "day" || range?.mode === "year" ? range.mode : "month";
  if (mode === "day" && range?.day) {
    const day = range.day;
    const month = day.slice(0, 7);
    return { mode, day, month, year: day.slice(0, 4), start: day, end: day, label: format(parseISO(day), "MMM d, yyyy") };
  }

  if (mode === "year" && range?.year) {
    const year = String(range.year);
    const start = startOfYear(parseISO(`${year}-01-01`));
    const end = endOfYear(start);
    return { mode, year, month: `${year}-01`, start: format(start, "yyyy-MM-dd"), end: format(end, "yyyy-MM-dd"), label: year };
  }

  const month = range?.month || currentMonthKey();
  const bounds = monthBounds(month);
  return { mode: "month", month, year: month.slice(0, 4), start: bounds.start, end: bounds.end, label: format(parseISO(`${month}-01`), "MMMM yyyy") };
}

function trendBuckets(period) {
  if (period.mode === "year") {
    return Array.from({ length: 12 }, (_, index) => {
      const key = `${period.year}-${String(index + 1).padStart(2, "0")}`;
      const bounds = monthBounds(key);
      return {
        key,
        start: bounds.start,
        end: bounds.end,
        label: format(parseISO(`${key}-01`), "MMM")
      };
    });
  }

  if (period.mode === "custom") {
    return monthsBetween(period.start, period.end).map((key) => {
      const bounds = monthBounds(key);
      return {
        key,
        start: bounds.start,
        end: bounds.end,
        label: format(parseISO(`${key}-01`), "MMM")
      };
    });
  }

  if (period.mode === "day") {
    return [{
      key: period.day,
      start: period.start,
      end: period.end,
      label: format(parseISO(period.day), "MMM d, yyyy")
    }];
  }

  return weeksInMonth(period.month);
}

function weeksInMonth(monthKey) {
  const bounds = monthBounds(monthKey);
  const monthStart = parseISO(bounds.start);
  const monthEnd = parseISO(bounds.end);

  return eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 0 }).map((weekStart) => {
    const rangeStart = maxDate([weekStart, monthStart]);
    const rangeEnd = minDate([endOfWeek(weekStart, { weekStartsOn: 0 }), monthEnd]);
    const start = format(rangeStart, "yyyy-MM-dd");
    const end = format(rangeEnd, "yyyy-MM-dd");
    const sameDay = start === end;
    return {
      key: start,
      start,
      end,
      label: sameDay ? format(rangeStart, "MMM d") : `${format(rangeStart, "MMM d")}–${format(rangeEnd, "d")}`
    };
  });
}

function trendForRange(state, period) {
  const statements = state.incomeStatements || [];

  return trendBuckets(period).map((bucket) => {
    const txns = state.transactions.filter(
      (txn) => !txn.hidden && txn.date >= bucket.start && txn.date <= bucket.end
    );
    const spend = round(txns.filter((txn) => txn.amount > 0).reduce((sum, txn) => sum + txn.amount, 0));
    const bucketStatements = statements.filter((statement) => {
      const date = incomeStatementPayDate(statement);
      return date && date >= bucket.start && date <= bucket.end;
    });
    const income = round(bucketStatements.reduce((sum, statement) => sum + Number(statement.takeHome || 0), 0));
    return { label: bucket.label, key: bucket.key, spend, income };
  });
}

function monthsBetween(start, end) {
  const startDate = startOfMonth(parseISO(start));
  const endDate = startOfMonth(parseISO(end));
  const months = [];
  let cursor = startDate;
  while (cursor <= endDate && months.length < 18) {
    months.push(format(cursor, "yyyy-MM"));
    cursor = addMonths(cursor, 1);
  }
  return months;
}

function detectRecurring(transactions) {
  const grouped = new Map();
  transactions
    .filter((txn) => txn.amount > 0)
    .forEach((txn) => {
      const key = (txn.merchantName || txn.name || "").toLowerCase();
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(txn);
    });

  return Array.from(grouped.entries())
    .map(([key, txns]) => ({
      merchant: txns[0].merchantName || txns[0].name,
      count: txns.length,
      averageAmount: round(txns.reduce((sum, txn) => sum + txn.amount, 0) / txns.length),
      category: txns[0].category || "Uncategorized",
      lastSeen: txns.map((txn) => txn.date).sort().at(-1)
    }))
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.averageAmount - a.averageAmount)
    .slice(0, 8);
}

function topByMerchant(transactions) {
  const totals = new Map();
  transactions.forEach((txn) => {
    const merchant = txn.merchantName || txn.name || "Unknown";
    totals.set(merchant, (totals.get(merchant) || 0) + txn.amount);
  });
  return Array.from(totals.entries())
    .map(([merchant, amount]) => ({ merchant, amount: round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
}

export function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function colorForLabel(label) {
  const colors = ["#0f766e", "#2563eb", "#be123c", "#7c3aed", "#ca8a04", "#0891b2", "#db2777", "#475569"];
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function toSet(value) {
  if (value === null || value === undefined || value === "") return null;
  const values = Array.isArray(value) ? value : [value];
  const cleaned = values.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  return cleaned.length ? new Set(cleaned) : null;
}

function validDateLike(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
