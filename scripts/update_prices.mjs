// Mengambil harga BTC/IDR, USD/IDR, dan QQQ lalu menyimpannya ke Supabase.
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, TWELVEDATA_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, TWELVEDATA_KEY })) {
  if (!v) { console.error("Secret hilang: " + k); process.exit(1); }
}

const base = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/prices";
const H = { apikey: SUPABASE_SERVICE_KEY, "Content-Type": "application/json" };
if (!SUPABASE_SERVICE_KEY.startsWith("sb_")) H.Authorization = "Bearer " + SUPABASE_SERVICE_KEY;

async function getJson(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error("HTTP " + r.status + " dari " + url.split("?")[0]);
  return r.json();
}

const sources = {
  BTCIDR: async () => {
    const d = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=idr");
    return { value: d.bitcoin.idr, currency: "IDR", type: "live", source: "CoinGecko simple/price", asOf: new Date() };
  },
  USDIDR: async () => {
    const d = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR");
    return { value: d.rates.IDR, currency: "IDR", type: "closing", source: "Frankfurter (ECB) " + d.date, asOf: new Date(d.date + "T15:00:00Z") };
  },
  QQQ: async () => {
    const d = await getJson("https://api.twelvedata.com/quote?symbol=QQQ&apikey=" + TWELVEDATA_KEY);
    if (d.status === "error" || !d.close) throw new Error("Twelve Data: " + (d.message || "tidak ada data"));
    return { value: Number(d.close), currency: "USD", type: d.is_market_open ? "delayed" : "closing",
             source: "Twelve Data quote " + d.datetime, asOf: new Date((d.timestamp || Date.now() / 1000) * 1000) };
  },
};

// Batas perubahan wajar dari harga tersimpan sebelumnya; di atas ini dianggap error data.
const maxMove = { BTCIDR: 0.4, USDIDR: 0.05, QQQ: 0.25 };

let failed = 0;
for (const [symbol, fetchPrice] of Object.entries(sources)) {
  try {
    const p = await fetchPrice();
    if (!Number.isFinite(p.value) || p.value <= 0) throw new Error("angka tidak valid");

    const last = await getJson(`${base}?symbol=eq.${symbol}&order=as_of.desc&limit=1&select=value`, { headers: H });
    if (last[0]) {
      const move = Math.abs(p.value / Number(last[0].value) - 1);
      if (move > maxMove[symbol]) throw new Error(`berubah ${(move * 100).toFixed(1)}% dari harga sebelumnya, ditolak`);
    }

    const r = await fetch(base, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ symbol, value: p.value, currency: p.currency, price_type: p.type, source: p.source, as_of: p.asOf.toISOString() }),
    });
    if (!r.ok) throw new Error("gagal menyimpan: " + r.status + " " + (await r.text()));
    console.log("OK", symbol, p.value, "|", p.source);
  } catch (e) {
    failed++;
    console.error("GAGAL", symbol, "-", e.message);
  }
}
process.exit(failed ? 1 : 0);
