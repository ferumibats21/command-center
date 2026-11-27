// Riwayat harga + nilai portofolio harian.
// Pemakaian: node scripts/history.mjs backfill   (sekali, isi riwayat dari transaksi pertama)
//            node scripts/history.mjs daily      (harian, segarkan 7 hari terakhir lalu hitung ulang)
const MS_DAY = 864e5;
const day = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => day(new Date(Date.parse(s + "T00:00:00Z") + n * MS_DAY));

/* ---------- perhitungan murni (bisa diuji tanpa jaringan) ---------- */
export function computeDaily(txs, hist, today) {
  const out = [];
  const sorted = {};
  for (const s of ["BTCIDR", "QQQ", "USDIDR"]) sorted[s] = Object.keys(hist[s] || {}).sort();
  for (const u of [...new Set(txs.map((t) => t.user_id))]) {
    const mine = txs.filter((t) => t.user_id === u).sort((a, b) => (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : 0));
    if (!mine.length) continue;
    const P = { BTC: { q: 0, ci: 0, c: 0, miss: 0, est: 0 }, QQQ: { q: 0, ci: 0, c: 0, miss: 0, est: 0 } };
    const ptr = { BTCIDR: 0, QQQ: 0, USDIDR: 0 }, lastVal = {}, lastDay = {};
    let i = 0;
    for (let d = mine[0].tx_date; d <= today; d = addDays(d, 1)) {
      let flow = 0;
      while (i < mine.length && mine[i].tx_date <= d) {
        const t = mine[i++], p = P[t.asset], q = +t.qty, fee = +t.fee || 0;
        const id = t.idr_value == null ? null : +t.idr_value;
        if (t.type === "Buy") {
          p.q += q; p.c += +t.amount + fee;
          if (id == null) p.miss = 1; else { p.ci += id; flow += id; }
          if (t.idr_estimate) p.est = 1;
        } else {
          const f = p.q > 0 ? Math.min(1, q / p.q) : 0;
          if (id != null) flow -= id;
          p.c -= p.c * f; p.ci -= p.ci * f; p.q = Math.max(0, p.q - q);
        }
      }
      for (const s of ["BTCIDR", "QQQ", "USDIDR"]) {
        while (ptr[s] < sorted[s].length && sorted[s][ptr[s]] <= d) {
          lastVal[s] = hist[s][sorted[s][ptr[s]]]; lastDay[s] = sorted[s][ptr[s]]; ptr[s]++;
        }
      }
      const btcP = lastVal.BTCIDR ?? null, qqqP = lastVal.QQQ ?? null, fx = lastVal.USDIDR ?? null;
      const flags = [];
      if (P.BTC.q > 0 && lastDay.BTCIDR !== d) flags.push("btc_carried");
      if (P.QQQ.q > 0 && lastDay.QQQ !== d) flags.push("qqq_carried");
      if (P.QQQ.q > 0 && lastDay.USDIDR !== d) flags.push("fx_carried");
      if (P.QQQ.est) flags.push("qqq_idr_cost_estimate");
      if (P.QQQ.miss) flags.push("qqq_idr_cost_missing");
      const btcV = P.BTC.q === 0 ? 0 : btcP == null ? null : P.BTC.q * btcP;
      const qqqV = P.QQQ.q === 0 ? 0 : qqqP == null || fx == null ? null : P.QQQ.q * qqqP * fx;
      if (btcV == null || qqqV == null) flags.push("price_missing");
      out.push({
        user_id: u, day: d, btc_qty: P.BTC.q, qqq_qty: P.QQQ.q, btc_price: btcP, qqq_price: qqqP, fx,
        btc_value: btcV, qqq_value: qqqV, total_value: btcV == null || qqqV == null ? null : btcV + qqqV,
        cost_basis_idr: P.BTC.ci + P.QQQ.ci, cash_flow_idr: flow, flags,
      });
    }
  }
  return out;
}

/* ---------- sumber harga historis ---------- */
async function getJson(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error("HTTP " + r.status + " dari " + url.split("?")[0]);
  return r.json();
}
const sources = (from, key) => ({
  BTCIDR: async () => {
    const f = Math.floor(Date.parse(from + "T00:00:00Z") / 1000), t = Math.floor(Date.now() / 1000) + 86400;
    const d = await getJson(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=idr&from=${f}&to=${t}`);
    const m = new Map(); // ambil titik paling awal tiap hari UTC (sekitar 00:00 UTC)
    for (const [ms, v] of d.prices) { const k = day(new Date(ms)); if (!m.has(k) || ms < m.get(k).ms) m.set(k, { ms, v }); }
    return [...m].map(([k, x]) => ({ symbol: "BTCIDR", day: k, value: x.v, currency: "IDR", source: "CoinGecko market_chart (00:00 UTC)", carried: false }));
  },
  USDIDR: async () => {
    const d = await getJson(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=IDR`);
    return Object.entries(d.rates).map(([k, x]) => ({ symbol: "USDIDR", day: k, value: x.IDR, currency: "IDR", source: "Frankfurter (ECB)", carried: false }));
  },
  QQQ: async () => {
    const d = await getJson(`https://api.twelvedata.com/time_series?symbol=QQQ&interval=1day&start_date=${from}&outputsize=5000&apikey=${key}`);
    if (d.status === "error" || !d.values) throw new Error("Twelve Data: " + (d.message || "tidak ada data"));
    return d.values.map((v) => ({ symbol: "QQQ", day: v.datetime.slice(0, 10), value: Number(v.close), currency: "USD", source: "Twelve Data time_series (close)", carried: false }));
  },
});

/* ---------- Supabase REST ---------- */
async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, TWELVEDATA_KEY } = process.env;
  for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, TWELVEDATA_KEY })) {
    if (!v) { console.error("Secret hilang: " + k); process.exit(1); }
  }
  const mode = process.argv[2] || "daily";
  const rest = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/";
  const H = { apikey: SUPABASE_SERVICE_KEY, "Content-Type": "application/json" };
  if (!SUPABASE_SERVICE_KEY.startsWith("sb_")) H.Authorization = "Bearer " + SUPABASE_SERVICE_KEY;

  async function getAll(path) {
    let all = [], off = 0;
    for (;;) {
      const r = await fetch(rest + path + (path.includes("?") ? "&" : "?") + `limit=1000&offset=${off}`, { headers: H });
      if (!r.ok) throw new Error("gagal baca " + path.split("?")[0] + ": " + r.status);
      const a = await r.json(); all = all.concat(a);
      if (a.length < 1000) break; off += 1000;
    }
    return all;
  }
  async function upsert(table, rows, conflict) {
    for (let i = 0; i < rows.length; i += 500) {
      const r = await fetch(`${rest}${table}?on_conflict=${conflict}`, {
        method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)),
      });
      if (!r.ok) throw new Error(`gagal simpan ${table}: ${r.status} ${await r.text()}`);
    }
  }

  const txs = await getAll("transactions?select=user_id,asset,type,tx_date,qty,price,amount,fee,idr_value,idr_estimate&order=tx_date.asc");
  if (!txs.length) { console.log("Belum ada transaksi."); return; }
  const first = txs.map((t) => t.tx_date).sort()[0], today = day(new Date());
  const from = mode === "backfill" ? addDays(first, -10) : addDays(today, -7);
  console.log(`Mode ${mode}: mengambil harga dari ${from}`);

  let failed = 0; const rows = [];
  for (const [sym, f] of Object.entries(sources(from, TWELVEDATA_KEY))) {
    try { const r = await f(); rows.push(...r); console.log("OK", sym, r.length, "titik harga"); }
    catch (e) { failed++; console.error("GAGAL", sym, "-", e.message); }
  }
  if (rows.length) await upsert("price_history", rows, "symbol,day");

  const hist = { BTCIDR: {}, QQQ: {}, USDIDR: {} };
  for (const r of await getAll("price_history?select=symbol,day,value&order=day.asc")) hist[r.symbol][r.day] = Number(r.value);

  // uji silang: harga eksekusi aslimu vs harga historis hari itu
  const before = (s, d) => { const k = Object.keys(s).filter((x) => x <= d).sort(); return k.length ? s[k[k.length - 1]] : null; };
  for (const t of txs) {
    if (t.type !== "Buy" || !(+t.price > 0)) continue;
    const sym = t.asset === "BTC" ? "BTCIDR" : "QQQ", h = before(hist[sym], t.tx_date);
    if (h == null) { console.warn(`PERIKSA ${t.asset} ${t.tx_date}: belum ada harga historis`); continue; }
    const diff = Math.abs(h / +t.price - 1), lim = t.asset === "BTC" ? 0.08 : 0.05;
    console.log(`${diff > lim ? "PERIKSA" : "cocok  "} ${t.asset} ${t.tx_date}: eksekusi ${(+t.price).toFixed(2)} vs historis ${h.toFixed(2)} (${(diff * 100).toFixed(1)}%)`);
  }

  const daily = computeDaily(txs, hist, today);
  await upsert("portfolio_daily", daily, "user_id,day");
  console.log(`Tersimpan ${daily.length} baris portfolio_daily.`);
  const eom = {}; for (const r of daily) eom[r.day.slice(0, 7)] = r;
  for (const [m, r] of Object.entries(eom)) console.log(`${m}  modal ${Math.round(r.cost_basis_idr).toLocaleString("id-ID")}  nilai ${r.total_value == null ? "-" : Math.round(r.total_value).toLocaleString("id-ID")}`);
  if (failed) process.exit(1);
}
if (!process.env.HISTORY_TEST) await main();
