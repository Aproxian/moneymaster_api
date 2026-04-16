/** System category internalKey values (per account). */
const CASH_OUT_INVESTMENT = "CASH_OUT_INVESTMENT";

/** Default investment wishlist buckets created when investing is enabled. */
const INVESTMENT_DEFAULT_INTERNAL_KEYS = [
  "INV_STOCKS",
  "INV_ETFS",
  "INV_INDICES",
  "INV_CRYPTO",
  "INV_FOREX",
  "INV_FUTURES",
  "INV_COMMODITIES",
  "INV_BONDS",
  "INV_FUNDS",
  "INV_OTHER",
];

const INVESTMENT_DEFAULT_ROWS = [
  { key: "INV_STOCKS", name: "Stocks", icon: "📈" },
  { key: "INV_ETFS", name: "ETFs", icon: "📊" },
  { key: "INV_INDICES", name: "Indices", icon: "📉" },
  { key: "INV_CRYPTO", name: "Crypto", icon: "₿" },
  { key: "INV_FOREX", name: "Forex", icon: "💱" },
  { key: "INV_FUTURES", name: "Futures", icon: "⚡" },
  { key: "INV_COMMODITIES", name: "Commodities", icon: "🛢️" },
  { key: "INV_BONDS", name: "Bonds", icon: "📜" },
  { key: "INV_FUNDS", name: "Funds", icon: "🏦" },
  { key: "INV_OTHER", name: "Other", icon: "✨" },
];

module.exports = {
  CASH_OUT_INVESTMENT,
  INVESTMENT_DEFAULT_INTERNAL_KEYS,
  INVESTMENT_DEFAULT_ROWS,
};
