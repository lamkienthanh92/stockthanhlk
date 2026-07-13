// ============================================================
// VN STOCK CMT × HURST — MỘT APP DUY NHẤT
//
// Trang mặc định = BỘ LỌC (Screener) rổ VN30, xếp hạng bằng TÍN HIỆU
// CMT: cán cân bằng chứng 5 lớp × xác suất analog lịch sử × tỷ lệ đạt
// target của quy tắc breakout × khoảng cách tới trigger × đồng thuận
// đa khung. Cột Hurst đứng bên cạnh như thông tin tham chiếu.
//
// Bấm một mã → hai tab phân tích sâu, dùng chung dữ liệu:
//   • CMT   — trình tự top-down 7 bước (xu hướng → kế hoạch nếu-thì)
//   • Hurst — walk-forward 40+ chỉ báo (có Volume), chiến lược
//             Pullback / Range-Fade, mô phỏng tài khoản theo vốn thật
//
// Dữ liệu thật từ backend FastAPI + vnstock: giá OHLCV thật (có Volume,
// khác forex OTC không có volume). Không dùng DXY/COT/session/lịch
// kinh tế liên ngân hàng — những phần đó chỉ áp dụng cho forex.
//
// Công cụ nghiên cứu — không phải khuyến nghị đầu tư.
// ============================================================

import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  ComposedChart,
  Bar,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
  ReferenceArea,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  LineChart,
  Cell,
} from "recharts";

/* ============================================================
   0. KẾT NỐI BACKEND
   ============================================================ */

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const HISTORY_START = "2016-01-01"; // càng xa越 tốt cho backtest; nguồn KBS có thể trả ít hơn
const todayISO = () => new Date().toISOString().slice(0, 10);

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchVN30() {
  const j = await fetchJSON(`${API_URL}/api/vn30`);
  return j.symbols || [];
}

// Lấy lịch sử NHIỀU mã trong 1 lần gọi (endpoint /api/batch của backend).
async function fetchBatchHistory(symbols, start, end) {
  const j = await fetchJSON(`${API_URL}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols, start, end, interval: "1D" }),
  });
  return j; // { SYMBOL: { ok, data | error } }
}

async function fetchOneHistory(symbol, start, end) {
  const url = `${API_URL}/api/stock/${symbol}?start=${start}&end=${end}&interval=1D`;
  return fetchJSON(url);
}

// Chuẩn hoá bản ghi vnstock (time/date, open/high/low/close/volume) → mảng song song.
function normalizeRows(rows) {
  const dates = [],
    closes = [],
    opens = [],
    highs = [],
    lows = [],
    volumes = [];
  // vnstock trả giá theo đơn vị "nghìn đồng" (VD: HPG ra 22.95 nghĩa là
  // 22.950đ thật) — nhân 1000 ngay tại đây để toàn bộ app (giá hiển thị,
  // ATR, SL/TP, lãi lỗ theo VND, quy mô vị thế) tính bằng VND thật. Các chỉ
  // số theo tỷ lệ (%, R-multiple, Sharpe) không đổi vì đơn vị tự triệt tiêu,
  // chỉ những con số tiền tuyệt đối trước đây bị hiển thị nhỏ hơn 1000 lần.
  const SCALE = 1000;
  for (const r of rows || []) {
    const d = (r.time || r.date || r.tradingDate || "").toString().slice(0, 10);
    if (!d || r.close == null) continue;
    dates.push(d);
    closes.push(+r.close * SCALE);
    opens.push((r.open != null ? +r.open : +r.close) * SCALE);
    highs.push((r.high != null ? +r.high : +r.close) * SCALE);
    lows.push((r.low != null ? +r.low : +r.close) * SCALE);
    volumes.push(r.volume != null ? +r.volume : 0);
  }
  return { dates, closes, opens, highs, lows, volumes };
}

/* ============================================================
   1. TOÁN NỀN (indicator, pivot, thống kê) — dùng chung CMT & Hurst
   ============================================================ */

function mstd(arr) {
  const n = arr.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN };
  const m = arr.reduce((s, x) => s + x, 0) / n;
  const v = n > 1 ? arr.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) : 0;
  return { n, mean: m, sd: Math.sqrt(v) };
}
function linreg(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n,
    my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return { slope: sxx > 0 ? sxy / sxx : 0 };
}
function sma(arr, w) {
  const out = Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= w) sum -= arr[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}
function ema(arr, p) {
  const k = 2 / (p + 1);
  let e = null;
  return arr.map((v, i) => (e = i === 0 ? v : v * k + e * (1 - k)));
}
function wma(arr, w) {
  const n = arr.length,
    out = Array(n).fill(null),
    wsum = (w * (w + 1)) / 2;
  for (let i = w - 1; i < n; i++) {
    let s = 0;
    for (let k = 0; k < w; k++) s += arr[i - w + 1 + k] * (k + 1);
    out[i] = s / wsum;
  }
  return out;
}
function rsi(closes, p = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0,
    l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0),
      dn = Math.max(-d, 0);
    if (i <= p) {
      g += up;
      l += dn;
      if (i === p) {
        g /= p;
        l /= p;
        out[i] = 100 - 100 / (1 + g / (l || 1e-9));
      }
    } else {
      g = (g * (p - 1) + up) / p;
      l = (l * (p - 1) + dn) / p;
      out[i] = 100 - 100 / (1 + g / (l || 1e-9));
    }
  }
  return out;
}
function macd(closes) {
  const e12 = ema(closes, 12),
    e26 = ema(closes, 26);
  const m = closes.map((_, i) => e12[i] - e26[i]);
  const sig = ema(m, 9);
  return m.map((v, i) => ({ macd: v, signal: sig[i], hist: v - sig[i] }));
}
function macdCalc(closes, fast, slow, sig) {
  const eF = ema(closes, fast),
    eS = ema(closes, slow);
  const m = closes.map((_, i) => eF[i] - eS[i]);
  return { macd: m, signal: ema(m, sig) };
}
function stochClose(closes, p = 14) {
  return closes.map((c, i) => {
    if (i < p - 1) return null;
    const w = closes.slice(i - p + 1, i + 1);
    const hh = Math.max(...w),
      ll = Math.min(...w);
    return ((c - ll) / (hh - ll || 1e-9)) * 100;
  });
}
function volProxy(closes, p = 14) {
  return ema(
    closes.map((c, i) => (i ? Math.abs(c - closes[i - 1]) : 0)),
    p
  );
}
function closeATR(closes, period) {
  const n = closes.length,
    out = Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let s = 0;
    for (let k = i - period + 1; k <= i; k++)
      s += Math.abs(closes[k] - closes[k - 1]);
    out[i] = s / period;
  }
  return out;
}
// ATR thật (Wilder) dùng High/Low/Close — chính xác hơn closeATR vì tính đủ
// biên độ trong phiên (gap, râu nến), không chỉ khoảng cách giữa 2 giá đóng cửa.
function trueRangeSeries(highs, lows, closes) {
  const n = closes.length,
    tr = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = highs[i] - lows[i];
      continue;
    }
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  return tr;
}
function atrTrue(highs, lows, closes, period) {
  const tr = trueRangeSeries(highs, lows, closes);
  const n = closes.length,
    out = Array(n).fill(null);
  if (n <= period) return out;
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  out[period] = s / period;
  for (let i = period + 1; i < n; i++)
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(-n),
    y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n,
    my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy || 1e-12);
}
const returns = (cl) => cl.slice(1).map((c, i) => c / cl[i] - 1);

// Đỉnh/đáy swing. Nếu có highs/lows thật (chuẩn CMT: đỉnh lấy từ dãy High,
// đáy lấy từ dãy Low) thì dùng đúng giá cao/thấp trong phiên — chính xác hơn
// so với chỉ dùng giá đóng cửa (vốn có thể bỏ lỡ râu nến). Không truyền
// highs/lows thì tự động rơi về hành vi cũ (dùng closes cho cả hai loại).
function pivots(closes, k, highs, lows) {
  const H = highs || closes,
    L = lows || closes;
  const out = [];
  for (let i = k; i < closes.length - k; i++) {
    const segH = H.slice(i - k, i + k + 1);
    const segL = L.slice(i - k, i + k + 1);
    const isH = H[i] >= Math.max(...segH);
    const isL = L[i] <= Math.min(...segL);
    if (isH && !isL) out.push({ i, price: H[i], type: "H" });
    else if (isL && !isH) out.push({ i, price: L[i], type: "L" });
    else if (isH && isL) {
      // hiếm khi cả hai cùng đúng (nến rất hẹp) — ưu tiên theo hướng nến
      out.push({
        i,
        price: closes[i] >= closes[Math.max(0, i - 1)] ? H[i] : L[i],
        type: closes[i] >= closes[Math.max(0, i - 1)] ? "H" : "L",
      });
    }
  }
  const f = [];
  out.forEach((p) => {
    const last = f[f.length - 1];
    if (last && last.type === p.type) {
      if (
        (p.type === "H" && p.price > last.price) ||
        (p.type === "L" && p.price < last.price)
      )
        f[f.length - 1] = p;
    } else f.push(p);
  });
  return f;
}
// Gộp High/Low theo tuần & tháng (High tuần = max các High trong tuần, Low
// tuần = min các Low trong tuần) — để tính swing đa khung bằng dữ liệu H/L
// thật, không chỉ suy từ giá đóng cửa cuối kỳ.
function aggWeeklyHL(highs, lows, dates) {
  const oh = [],
    ol = [],
    wd = [];
  let cur = null;
  highs.forEach((h, i) => {
    const dt = new Date(dates[i] + "T00:00:00Z");
    const day = (dt.getUTCDay() + 6) % 7;
    const mon = new Date(dt);
    mon.setUTCDate(dt.getUTCDate() - day);
    const key = mon.toISOString().slice(0, 10);
    if (key !== cur) {
      oh.push(h);
      ol.push(lows[i]);
      wd.push(key);
      cur = key;
    } else {
      oh[oh.length - 1] = Math.max(oh[oh.length - 1], h);
      ol[ol.length - 1] = Math.min(ol[ol.length - 1], lows[i]);
    }
  });
  return { highs: oh, lows: ol, dates: wd };
}
// Tổng khối lượng khớp lệnh trong tuần — cần cho 2 chỉ báo Volume trong bộ
// 22 chỉ báo Trend khi tính đồng thuận ở khung tuần.
function aggWeeklyVolume(volumes, dates) {
  const ov = [];
  let cur = null;
  volumes.forEach((v, i) => {
    const dt = new Date(dates[i] + "T00:00:00Z");
    const day = (dt.getUTCDay() + 6) % 7;
    const mon = new Date(dt);
    mon.setUTCDate(dt.getUTCDate() - day);
    const key = mon.toISOString().slice(0, 10);
    if (key !== cur) {
      ov.push(v);
      cur = key;
    } else {
      ov[ov.length - 1] += v;
    }
  });
  return ov;
}
function aggMonthlyHL(highs, lows, dates) {
  const oh = [],
    ol = [],
    md = [];
  let cur = null;
  highs.forEach((h, i) => {
    const key = dates[i].slice(0, 7);
    if (key !== cur) {
      oh.push(h);
      ol.push(lows[i]);
      md.push(key + "-01");
      cur = key;
    } else {
      oh[oh.length - 1] = Math.max(oh[oh.length - 1], h);
      ol[ol.length - 1] = Math.min(ol[ol.length - 1], lows[i]);
    }
  });
  return { highs: oh, lows: ol, dates: md };
}
function dowTrend(piv) {
  const H = piv.filter((p) => p.type === "H").slice(-2);
  const L = piv.filter((p) => p.type === "L").slice(-2);
  if (H.length < 2 || L.length < 2)
    return { trend: "side", detail: "Chưa đủ đỉnh/đáy" };
  const hh = H[1].price > H[0].price,
    hl = L[1].price > L[0].price;
  if (hh && hl) return { trend: "up", detail: "Đỉnh cao hơn + đáy cao hơn" };
  if (!hh && !hl)
    return { trend: "down", detail: "Đỉnh thấp hơn + đáy thấp hơn" };
  return { trend: "side", detail: "Đỉnh/đáy không đồng nhất" };
}
function aggWeekly(closes, dates) {
  const out = [],
    wd = [];
  let cur = null;
  closes.forEach((c, i) => {
    const dt = new Date(dates[i] + "T00:00:00Z");
    const day = (dt.getUTCDay() + 6) % 7;
    const mon = new Date(dt);
    mon.setUTCDate(dt.getUTCDate() - day);
    const key = mon.toISOString().slice(0, 10);
    if (key !== cur) {
      out.push(c);
      wd.push(key);
      cur = key;
    } else out[out.length - 1] = c;
  });
  return { closes: out, dates: wd };
}
function aggMonthly(closes, dates) {
  const out = [],
    md = [];
  let cur = null;
  closes.forEach((c, i) => {
    const key = dates[i].slice(0, 7);
    if (key !== cur) {
      out.push(c);
      md.push(key + "-01");
      cur = key;
    } else out[out.length - 1] = c;
  });
  return { closes: out, dates: md };
}
function stepDownCascade(dCloses, dDates, dHighs, dLows) {
  const wk = aggWeekly(dCloses, dDates);
  const mo = aggMonthly(dCloses, dDates);
  const wkHL = dHighs ? aggWeeklyHL(dHighs, dLows, dDates) : null;
  const moHL = dHighs ? aggMonthlyHL(dHighs, dLows, dDates) : null;
  const med = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const swingsOf = (closes, k, highs, lows) => {
    const piv = pivots(closes, k, highs, lows);
    const amps = [],
      durs = [];
    for (let i = 1; i < piv.length; i++) {
      const a = piv[i - 1],
        b = piv[i];
      if (a.type === b.type) continue;
      amps.push((Math.abs(b.price - a.price) / a.price) * 100);
      durs.push(b.i - a.i);
    }
    return { medAmpl: med(amps), medDur: med(durs), n: amps.length };
  };
  const M = swingsOf(mo.closes, 2, moHL && moHL.highs, moHL && moHL.lows),
    W = swingsOf(wk.closes, 2, wkHL && wkHL.highs, wkHL && wkHL.lows),
    D = swingsOf(dCloses, 4, dHighs, dLows);
  const rMW = M.medAmpl && W.medAmpl ? M.medAmpl / W.medAmpl : null;
  const rWD = W.medAmpl && D.medAmpl ? W.medAmpl / D.medAmpl : null;
  const consistent =
    rMW && rWD ? Math.abs(rMW - rWD) / ((rMW + rWD) / 2) < 0.5 : false;
  const projRatio =
    rMW && rWD ? (consistent ? (rMW + rWD) / 2 : rWD) : rWD || rMW;
  const proj4H =
    projRatio && D.medAmpl
      ? {
          medAmpl: D.medAmpl / projRatio,
          medDurBars: D.medDur
            ? Math.max(1, Math.round((D.medDur / projRatio) * 6))
            : null,
        }
      : null;
  return { M, W, D, rMW, rWD, projRatio, consistent, proj4H, wk, mo };
}
function trendStrength(closes, n = 40) {
  const y = closes.slice(-n),
    m = y.length;
  const xm = (m - 1) / 2,
    ym = y.reduce((s, v) => s + v, 0) / m;
  let num = 0,
    den = 0,
    ssTot = 0;
  y.forEach((v, i) => {
    num += (i - xm) * (v - ym);
    den += (i - xm) ** 2;
    ssTot += (v - ym) ** 2;
  });
  const slope = num / den;
  let ssRes = 0;
  y.forEach((v, i) => {
    const f = ym + slope * (i - xm);
    ssRes += (v - f) ** 2;
  });
  const vp = volProxy(closes);
  return {
    slopePerDayInVol: slope / (vp[vp.length - 1] || 1e-9),
    r2: Math.max(0, ssTot ? 1 - ssRes / ssTot : 0),
  };
}
function rsiDivergence(closes, rsiArr, piv) {
  const H = piv.filter((p) => p.type === "H").slice(-2);
  const L = piv.filter((p) => p.type === "L").slice(-2);
  if (H.length === 2 && rsiArr[H[0].i] != null && rsiArr[H[1].i] != null)
    if (H[1].price > H[0].price && rsiArr[H[1].i] < rsiArr[H[0].i] - 1)
      return {
        type: "bearish",
        txt: "Phân kỳ giảm: giá lập đỉnh cao hơn nhưng RSI đỉnh thấp hơn",
      };
  if (L.length === 2 && rsiArr[L[0].i] != null && rsiArr[L[1].i] != null)
    if (L[1].price < L[0].price && rsiArr[L[1].i] > rsiArr[L[0].i] + 1)
      return {
        type: "bullish",
        txt: "Phân kỳ tăng: giá lập đáy thấp hơn nhưng RSI đáy cao hơn",
      };
  return { type: null, txt: "Không có phân kỳ RSI–giá tại swing gần nhất" };
}
function majorSwing(piv) {
  const seq = piv.slice(-8);
  let best = null;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1],
      b = seq[i];
    if (a.type === b.type) continue;
    const range = Math.abs(b.price - a.price);
    if (!best || range > best.range) best = { from: a, to: b, range };
  }
  return best;
}
function fibLevels(swing) {
  if (!swing) return [];
  const d = swing.to.price - swing.from.price;
  return [0.382, 0.5, 0.618].map((f) => ({ f, y: swing.to.price - d * f }));
}
// Volume trung bình 20 phiên + tỉ lệ volume hôm nay / trung bình (dùng xác nhận breakout)
function volumeStats(volumes) {
  const vma20 = sma(volumes, 20);
  const ratio = volumes.map((v, i) =>
    vma20[i] ? v / vma20[i] : null
  );
  return { vma20, ratio };
}
// OBV (On-Balance Volume) — xác nhận xu hướng bằng dòng tiền
function obvSeries(closes, volumes) {
  const out = Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
    out[i] = out[i - 1] + d * (volumes[i] || 0);
  }
  return out;
}

/* ============================================================
   2. CMT — MẪU HÌNH, SÓNG, TRẠNG THÁI, KIỂM CHỨNG
   ============================================================ */

function detectPatterns(closes, piv, av, digits) {
  const res = [];
  const last = closes[closes.length - 1];
  for (const t of ["H", "L"]) {
    const same = piv.filter((p) => p.type === t).slice(-3);
    if (same.length >= 2) {
      const [a, b] = same.slice(-2);
      if (Math.abs(a.price - b.price) < av * 1.2 && b.i - a.i > 8) {
        const between = piv.filter(
          (p) => p.i > a.i && p.i < b.i && p.type !== t
        );
        if (between.length) {
          const neck = between[0].price;
          const height = Math.abs((a.price + b.price) / 2 - neck);
          const target = t === "H" ? neck - height : neck + height;
          const broke = t === "H" ? last < neck : last > neck;
          res.push({
            name:
              t === "H" ? "Hai đỉnh (Double Top)" : "Hai đáy (Double Bottom)",
            dir: t === "H" ? "giảm" : "tăng",
            neck,
            target,
            status: broke
              ? "Đã phá neckline"
              : "Đang hình thành — chờ phá neckline",
          });
        }
      }
    }
  }
  const H = piv.filter((p) => p.type === "H").slice(-3);
  const L = piv.filter((p) => p.type === "L").slice(-3);
  if (H.length >= 2 && L.length >= 2) {
    const sH =
      (H[H.length - 1].price - H[0].price) / (H[H.length - 1].i - H[0].i || 1);
    const sL =
      (L[L.length - 1].price - L[0].price) / (L[L.length - 1].i - L[0].i || 1);
    const eps = av * 0.03;
    let name = null;
    if (sH < -eps && sL > eps) name = "Tam giác cân (Symmetrical)";
    else if (Math.abs(sH) <= eps && sL > eps)
      name = "Tam giác tăng (Ascending)";
    else if (sH < -eps && Math.abs(sL) <= eps)
      name = "Tam giác giảm (Descending)";
    if (name) {
      const height = Math.abs(H[0].price - L[0].price);
      res.push({
        name,
        dir: "theo hướng phá vỡ",
        neck: null,
        target: null,
        heightTxt: `Target = chiều cao mở tam giác (≈ ${height.toFixed(
          digits
        )}) cộng/trừ từ điểm breakout`,
        status: "Đang hội tụ — chờ breakout kèm xác nhận lớp 3",
      });
    }
  }
  return res;
}

function elliottScenarios(piv, digits) {
  const scen = [];
  const seq = piv.slice(-7);
  if (seq.length < 5) return scen;
  const last6 = seq.slice(-6);
  if (last6.length === 6) {
    const [p0, p1, p2, p3, p4, p5] = last6;
    const up = p5.price > p0.price;
    const w1 = Math.abs(p1.price - p0.price);
    const w3 = Math.abs(p3.price - p2.price);
    const w5 = Math.abs(p5.price - p4.price);
    const r1 = up ? p2.price > p0.price : p2.price < p0.price;
    const r2 = !(w3 < w1 && w3 < w5);
    const r3 = up ? p4.price > p1.price : p4.price < p1.price;
    const ok = [r1, r2, r3].filter(Boolean).length;
    if (ok >= 2) {
      const ext = up ? p4.price + w1 : p4.price - w1;
      const ext2 = up ? p4.price + 1.618 * w1 : p4.price - 1.618 * w1;
      scen.push({
        name: up
          ? "Sóng đẩy tăng, đang ở sóng 5"
          : "Sóng đẩy giảm, đang ở sóng 5",
        dir: up ? "up" : "down",
        weight: ok === 3 ? 3 : 1.5,
        labels: last6.map((p, i) => ({ ...p, tag: i === 0 ? "0" : String(i) })),
        rules: [
          { txt: "Sóng 2 không phá gốc sóng 1", ok: r1 },
          { txt: "Sóng 3 không phải sóng ngắn nhất", ok: r2 },
          { txt: "Sóng 4 không chồng lấn vùng sóng 1", ok: r3 },
        ],
        target: `Mở rộng Fib: ${ext.toFixed(digits)} (1.0×W1) → ${ext2.toFixed(
          digits
        )} (1.618×W1)`,
      });
    }
  }
  const l4 = seq.slice(-4);
  if (l4.length === 4) {
    const [q0, qa, qb, qc] = l4;
    const corrDir = qc.price < q0.price ? "giảm" : "tăng";
    const retr =
      Math.abs(qc.price - qb.price) / (Math.abs(qa.price - q0.price) || 1e-9);
    scen.push({
      name: `Điều chỉnh A-B-C (${corrDir}) sau xu hướng trước đó`,
      dir: corrDir === "tăng" ? "up" : "down",
      weight: 1.5,
      labels: [
        { ...qa, tag: "A" },
        { ...qb, tag: "B" },
        { ...qc, tag: "C" },
      ],
      rules: [
        {
          txt: `Sóng C ≈ ${retr.toFixed(2)}× sóng A (thường 1.0–1.618)`,
          ok: retr > 0.6 && retr < 2,
        },
      ],
      target: `Nếu đúng ABC: kết thúc điều chỉnh quanh ${qc.price.toFixed(
        digits
      )}, quay lại xu hướng lớn`,
    });
  }
  const l5 = seq.slice(-5);
  if (l5.length === 5) {
    const up2 = l5[l5.length - 1].price > l5[0].price;
    scen.push({
      name: up2
        ? "Đang điều chỉnh sóng 4, chờ sóng 5 tăng"
        : "Đang hồi sóng 4, chờ sóng 5 giảm",
      dir: up2 ? "up" : "down",
      weight: 1,
      labels: l5.map((p, i) => ({ ...p, tag: i === 0 ? "0" : String(i) })),
      rules: [
        {
          txt: "Kịch bản thay thế — theo dõi vùng chồng lấn sóng 1 để loại trừ",
          ok: true,
        },
      ],
      target: "Chưa xác định — chờ pivot xác nhận kết thúc sóng 4",
    });
  }
  const total = scen.reduce((s, x) => s + x.weight, 0);
  scen.forEach((x) => (x.prob = Math.round((x.weight / total) * 100)));
  scen.sort((a, b) => b.prob - a.prob);
  return scen;
}

function scanPatternHistory(closes, dates, highs, lows) {
  const piv = pivots(closes, 4, highs, lows);
  const vp = volProxy(closes);
  const events = [];
  const outcome = (startI, dir, target, invalid) => {
    for (
      let j = startI + 1;
      j <= Math.min(startI + 40, closes.length - 1);
      j++
    ) {
      const c = closes[j];
      if (dir === "up" ? c >= target : c <= target)
        return { res: "hit", bars: j - startI };
      if (dir === "up" ? c <= invalid : c >= invalid)
        return { res: "fail", bars: j - startI };
    }
    return { res: "open", bars: null };
  };
  for (let k = 2; k < piv.length; k++) {
    const a = piv[k - 2],
      m = piv[k - 1],
      b = piv[k];
    if (a.type !== b.type || m.type === a.type) continue;
    const tol = (vp[Math.min(b.i, vp.length - 1)] || 1e-9) * 3.0;
    if (Math.abs(a.price - b.price) >= tol || b.i - a.i <= 8) continue;
    const isTop = a.type === "H";
    const neck = m.price;
    const height = Math.abs((a.price + b.price) / 2 - neck);
    const target = isTop ? neck - height : neck + height;
    const invalid = (a.price + b.price) / 2;
    let bo = -1;
    for (let j = b.i + 1; j < Math.min(b.i + 30, closes.length); j++) {
      if (isTop ? closes[j] < neck : closes[j] > neck) {
        bo = j;
        break;
      }
    }
    if (bo < 0) continue;
    events.push({
      i: bo,
      date: dates[bo],
      name: isTop ? "Hai đỉnh" : "Hai đáy",
      dir: isTop ? "giảm" : "tăng",
      entry: closes[bo],
      target,
      ...outcome(bo, isTop ? "down" : "up", target, invalid),
    });
  }
  for (let k = 4; k < piv.length; k++) {
    const w5 = piv.slice(k - 4, k + 1);
    const types = w5.map((p) => p.type).join("");
    if (types !== "HLHLH" && types !== "LHLHL") continue;
    const invHS = types === "LHLHL";
    const [s1, n1, hd, n2, s2] = w5;
    const dom = (x, y) => (invHS ? x < y : x > y);
    const tol = (vp[Math.min(s2.i, vp.length - 1)] || 1e-9) * 4.0;
    if (!dom(hd.price, s1.price) || !dom(hd.price, s2.price)) continue;
    if (Math.abs(s1.price - s2.price) >= tol) continue;
    const neck = (n1.price + n2.price) / 2;
    const height = Math.abs(hd.price - neck);
    const target = invHS ? neck + height : neck - height;
    let bo = -1;
    for (let j = s2.i + 1; j < Math.min(s2.i + 30, closes.length); j++) {
      if (invHS ? closes[j] > neck : closes[j] < neck) {
        bo = j;
        break;
      }
    }
    if (bo < 0) continue;
    events.push({
      i: bo,
      date: dates[bo],
      name: invHS ? "Vai-Đầu-Vai ngược" : "Vai-Đầu-Vai",
      dir: invHS ? "tăng" : "giảm",
      entry: closes[bo],
      target,
      ...outcome(bo, invHS ? "up" : "down", target, hd.price),
    });
  }
  const seen = new Set();
  const uniq = events.filter((e) => {
    const key = e.i + "|" + e.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  uniq.sort((x, y) => x.i - y.i);
  return uniq;
}

function scanBreakoutRule(closes, highs, lows) {
  const H_ = highs || closes,
    L_ = lows || closes;
  const mk = () => ({ n: 0, hit: 0, fail: 0, open: 0 });
  const st = { up: mk(), down: mk() };
  let skipTo = -1;
  for (let i = 45; i < closes.length - 1; i++) {
    if (i < skipTo) continue;
    const winH = H_.slice(i - 40, i),
      winL = L_.slice(i - 40, i);
    const R = Math.max(...winH),
      S = Math.min(...winL);
    const range = R - S;
    if (range <= 0) continue;
    let dir = null;
    if (closes[i] > R && closes[i - 1] <= R) dir = "up";
    else if (closes[i] < S && closes[i - 1] >= S) dir = "down";
    if (!dir) continue;
    const t1 = dir === "up" ? R + 0.618 * range : S - 0.618 * range;
    const inv = dir === "up" ? R : S;
    let res = "open";
    for (let j = i + 1; j <= Math.min(i + 30, closes.length - 1); j++) {
      const c = closes[j];
      if (dir === "up" ? c >= t1 : c <= t1) {
        res = "hit";
        break;
      }
      if (dir === "up" ? c < inv : c > inv) {
        res = "fail";
        break;
      }
    }
    st[dir].n++;
    st[dir][res]++;
    skipTo = i + 5;
  }
  const rate = (x) =>
    x.hit + x.fail ? Math.round((x.hit / (x.hit + x.fail)) * 100) : null;
  return {
    up: { ...st.up, rate: rate(st.up) },
    down: { ...st.down, rate: rate(st.down) },
  };
}

function backtestConfluenceRolling(closes, highs, lows) {
  const rsiArr = rsi(closes),
    vp = volProxy(closes),
    piv = pivots(closes, 4, highs, lows);
  const trades = [];
  let pi = 0;
  const H = [],
    L = [];
  for (let i = 60; i < closes.length - 12; i++) {
    while (pi < piv.length && piv[pi].i + 4 <= i) {
      (piv[pi].type === "H" ? H : L).push(piv[pi]);
      pi++;
    }
    if (H.length < 2 || L.length < 2) continue;
    const hh = H[H.length - 1].price > H[H.length - 2].price;
    const hl = L[L.length - 1].price > L[L.length - 2].price;
    const trend = hh && hl ? "up" : !hh && !hl ? "down" : "side";
    const cu = rsiArr[i - 1] !== null && rsiArr[i - 1] < 40 && rsiArr[i] >= 40;
    const cd = rsiArr[i - 1] !== null && rsiArr[i - 1] > 60 && rsiArr[i] <= 60;
    if (trend === "up" && cu)
      trades.push((closes[i + 12] - closes[i]) / (vp[i] || 1e-9));
    else if (trend === "down" && cd)
      trades.push((closes[i] - closes[i + 12]) / (vp[i] || 1e-9));
  }
  if (!trades.length) return null;
  const wins = trades.filter((r) => r > 0).length;
  return {
    n: trades.length,
    winRate: Math.round((wins / trades.length) * 100),
    avgR: (trades.reduce((s, r) => s + r, 0) / trades.length).toFixed(2),
  };
}

function buildStates(closes, highs, lows) {
  const H_ = highs || closes,
    L_ = lows || closes;
  const ma50 = sma(closes, 50);
  const rsiArr = rsi(closes),
    mac = macd(closes),
    piv = pivots(closes, 4, highs, lows);
  const states = new Array(closes.length).fill(null);
  let pi = 0;
  const H = [],
    L = [];
  for (let i = 210; i < closes.length; i++) {
    while (pi < piv.length && piv[pi].i + 4 <= i) {
      (piv[pi].type === "H" ? H : L).push(piv[pi]);
      pi++;
    }
    if (H.length < 2 || L.length < 2) continue;
    const hh = H[H.length - 1].price > H[H.length - 2].price;
    const hl = L[L.length - 1].price > L[L.length - 2].price;
    const dow = hh && hl ? "u" : !hh && !hl ? "d" : "s";
    const winH = H_.slice(i - 40, i),
      winL = L_.slice(i - 40, i);
    const R = Math.max(...winH),
      S = Math.min(...winL);
    const pos = (closes[i] - S) / (R - S || 1e-9);
    const r = rsiArr[i];
    states[i] = {
      dow,
      posB: pos < 0.33 ? "lo" : pos > 0.67 ? "hi" : "mid",
      rB: r == null ? "m" : r < 40 ? "lo" : r > 60 ? "hi" : "m",
      vs50: ma50[i] != null && closes[i] > ma50[i] ? "a" : "b",
      mh: mac[i].hist >= 0 ? "p" : "n",
      R,
      S,
    };
  }
  return states;
}
function analogProbabilities(closes, states, horizon = 20) {
  let cs = null,
    ci = -1;
  for (let i = states.length - 1; i >= 0; i--)
    if (states[i]) {
      cs = states[i];
      ci = i;
      break;
    }
  if (!cs) return null;
  const dimSets = [
    ["dow", "posB", "rB", "vs50", "mh"],
    ["dow", "posB", "rB", "vs50"],
    ["dow", "posB", "rB"],
    ["dow", "posB"],
  ];
  for (const keys of dimSets) {
    const matches = [];
    for (let i = 210; i < states.length - horizon - 1; i++) {
      const st = states[i];
      if (!st || i === ci) continue;
      if (keys.every((k) => st[k] === cs[k])) matches.push(i);
    }
    if (matches.length >= 25 || keys.length === 2) {
      let a = 0,
        b = 0,
        c = 0;
      matches.forEach((i) => {
        const st = states[i];
        let res = "c";
        for (let j = i + 1; j <= i + horizon; j++) {
          if (closes[j] > st.R) {
            res = "a";
            break;
          }
          if (closes[j] < st.S) {
            res = "b";
            break;
          }
        }
        if (res === "a") a++;
        else if (res === "b") b++;
        else c++;
      });
      const n = matches.length || 1;
      return {
        n: matches.length,
        dims: keys.length,
        horizon,
        pA: Math.round((a / n) * 100),
        pB: Math.round((b / n) * 100),
        pC: Math.round((c / n) * 100),
      };
    }
  }
  return null;
}
function analogAt(closes, states, asOf, horizon = 20) {
  const cs = states[asOf];
  if (!cs) return null;
  const dimSets = [
    ["dow", "posB", "rB", "vs50", "mh"],
    ["dow", "posB", "rB", "vs50"],
    ["dow", "posB", "rB"],
    ["dow", "posB"],
  ];
  const cap = asOf - horizon - 1;
  for (const keys of dimSets) {
    const matches = [];
    for (let i = 210; i < cap; i++) {
      const st = states[i];
      if (!st) continue;
      if (keys.every((k) => st[k] === cs[k])) matches.push(i);
    }
    if (matches.length >= 25 || keys.length === 2) {
      let a = 0,
        b = 0,
        c = 0;
      matches.forEach((i) => {
        const st = states[i];
        let res = "c";
        for (let j = i + 1; j <= i + horizon; j++) {
          if (closes[j] > st.R) {
            res = "a";
            break;
          }
          if (closes[j] < st.S) {
            res = "b";
            break;
          }
        }
        if (res === "a") a++;
        else if (res === "b") b++;
        else c++;
      });
      const nn = matches.length || 1;
      return {
        n: matches.length,
        dims: keys.length,
        horizon,
        pA: Math.round((a / nn) * 100),
        pB: Math.round((b / nn) * 100),
        pC: Math.round((c / nn) * 100),
      };
    }
  }
  return null;
}

function backtestSystem(closes, highs, lows, dates) {
  // Chỉ kiểm chứng phía MUA (long) — TTCK VN không có bán khống nên
  // kịch bản "breakout xuống" không sinh ra một lệnh nào để test.
  const H_ = highs || closes,
    L_ = lows || closes;
  const ma50 = sma(closes, 50),
    ma200 = sma(closes, 200);
  const rsiArr = rsi(closes),
    mac = macd(closes),
    piv = pivots(closes, 4, highs, lows),
    vp = volProxy(closes);
  let pi = 0;
  const H = [],
    L = [];
  const sys = { trades: [] },
    raw = { trades: [] };
  let inSys = null,
    inRaw = null;
  // Quét thắng/thua bằng High/Low thật trong phiên: đạt target nếu High
  // chạm t1, bị vô hiệu nếu Low chạm mức inv — kể cả khi giá đóng cửa quay
  // lại trong biên. Nếu cả hai cùng chạm trong 1 phiên, giả định thận trọng
  // là bị vô hiệu (loss) trước.
  const manage = (pos, book, i) => {
    if (!pos) return null;
    const hi = H_[i],
      lo = L_[i],
      c = closes[i];
    const win = hi >= pos.t1;
    const loss = lo < pos.inv;
    if (win || loss || i - pos.i0 >= 30) {
      const exitP = loss ? pos.inv : win ? pos.t1 : c;
      book.trades.push((exitP - pos.entry) / (pos.u || 1e-9));
      return null;
    }
    return pos;
  };
  let firstIdx = null;
  for (let i = 210; i < closes.length; i++) {
    while (pi < piv.length && piv[pi].i + 4 <= i) {
      (piv[pi].type === "H" ? H : L).push(piv[pi]);
      pi++;
    }
    const c = closes[i];
    inSys = manage(inSys, sys, i);
    inRaw = manage(inRaw, raw, i);
    if (H.length < 2 || L.length < 2) continue;
    const winH = H_.slice(i - 40, i),
      winL = L_.slice(i - 40, i);
    const R = Math.max(...winH),
      S = Math.min(...winL);
    const range = R - S;
    if (range <= 0) continue;
    if (!(c > R && closes[i - 1] <= R)) continue; // chỉ xét breakout LÊN
    if (firstIdx == null) firstIdx = i;
    const hh = H[H.length - 1].price > H[H.length - 2].price;
    const hl = L[L.length - 1].price > L[L.length - 2].price;
    const conds = [
      hh && hl,
      ma50[i] != null && c > ma50[i],
      ma50[i] != null && ma200[i] != null && ma50[i] > ma200[i],
      rsiArr[i] != null && rsiArr[i] > 50,
      mac[i].hist > 0,
    ];
    const score = conds.filter(Boolean).length;
    const pos = {
      entry: c,
      i0: i,
      u: vp[i],
      t1: R + 0.618 * range,
      inv: R,
    };
    if (!inRaw) inRaw = { ...pos };
    if (!inSys && score >= 3) inSys = { ...pos };
  }
  const stat = (book) => {
    const t = book.trades;
    if (!t.length) return { n: 0 };
    const wins = t.filter((r) => r > 0);
    const gw = wins.reduce((a, b) => a + b, 0);
    const gl = Math.abs(t.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
    let eqv = 0,
      peak = 0,
      maxDD = 0;
    const eq = t.map((r, k) => {
      eqv += r;
      peak = Math.max(peak, eqv);
      maxDD = Math.max(maxDD, peak - eqv);
      return { x: k + 1, eq: +eqv.toFixed(2) };
    });
    return {
      n: t.length,
      winRate: Math.round((wins.length / t.length) * 100),
      avg: (t.reduce((a, b) => a + b, 0) / t.length).toFixed(2),
      pf: gl ? (gw / gl).toFixed(2) : "∞",
      maxDD: maxDD.toFixed(1),
      eq,
    };
  };
  // So sánh với "chỉ mua và giữ" trên đúng khoảng thời gian có thể đã giao
  // dịch (từ lần breakout đầu tiên tới hết dữ liệu) — vì đây là cổ phiếu,
  // luôn cần biết hệ thống có thắng nổi việc đơn giản là mua rồi để đó không.
  const bhFrom = firstIdx != null ? firstIdx : 210;
  const buyHold = dates ? buyHoldEquity(closes, dates, bhFrom) : null;
  return { sys: stat(sys), raw: stat(raw), buyHold, buyHoldFromDate: dates ? dates[bhFrom] : null };
}

function percentileOf(sorted, v) {
  if (!sorted.length) return null;
  let c = 0;
  for (const x of sorted) if (x <= v) c++;
  return Math.round((c / sorted.length) * 100);
}
function scanSwings(closes, dates, highs, lows) {
  const piv = pivots(closes, 4, highs, lows);
  const legs = [];
  for (let k = 1; k < piv.length; k++) {
    const a = piv[k - 1],
      b = piv[k];
    if (a.type === b.type) continue;
    legs.push({
      dir: b.price > a.price ? "up" : "down",
      bars: b.i - a.i,
      days: Math.round((new Date(dates[b.i]) - new Date(dates[a.i])) / 864e5),
      amplPct: (Math.abs(b.price - a.price) / a.price) * 100,
      from: dates[a.i],
      to: dates[b.i],
    });
  }
  const med = (arr) => arr[Math.floor(arr.length / 2)];
  const stats = (dir) => {
    const L = legs.filter((l) => l.dir === dir);
    if (!L.length) return { n: 0 };
    const sb = L.map((l) => l.bars).sort((x, y) => x - y);
    const sd = L.map((l) => l.days).sort((x, y) => x - y);
    const sa = L.map((l) => l.amplPct).sort((x, y) => x - y);
    return {
      n: L.length,
      medBars: med(sb),
      p25B: sb[Math.floor(sb.length * 0.25)],
      p75B: sb[Math.floor(sb.length * 0.75)],
      medDays: med(sd),
      medAmpl: +med(sa).toFixed(2),
      p25A: +sa[Math.floor(sa.length * 0.25)].toFixed(2),
      p75A: +sa[Math.floor(sa.length * 0.75)].toFixed(2),
      sortedBars: sb,
      sortedAmpl: sa,
    };
  };
  const up = stats("up"),
    down = stats("down");
  let cur = null;
  if (piv.length) {
    const lastP = piv[piv.length - 1];
    const i1 = closes.length - 1;
    const dir = closes[i1] > lastP.price ? "up" : "down";
    const bars = i1 - lastP.i;
    const amplPct = +(
      (Math.abs(closes[i1] - lastP.price) / lastP.price) *
      100
    ).toFixed(2);
    const ref = dir === "up" ? up : down;
    cur = {
      dir,
      bars,
      amplPct,
      from: dates[lastP.i],
      days: Math.round(
        (new Date(dates[i1]) - new Date(dates[lastP.i])) / 864e5
      ),
      pctBars: ref.n ? percentileOf(ref.sortedBars, bars) : null,
      pctAmpl: ref.n ? percentileOf(ref.sortedAmpl, amplPct) : null,
    };
  }
  const hDur = [];
  const maxB = Math.min(Math.max(...legs.map((l) => l.bars), 0), 60);
  for (let b0 = 4; b0 <= maxB; b0 += 6)
    hDur.push({
      bucket: `${b0}–${b0 + 5}`,
      up: legs.filter((l) => l.dir === "up" && l.bars >= b0 && l.bars < b0 + 6)
        .length,
      down: legs.filter(
        (l) => l.dir === "down" && l.bars >= b0 && l.bars < b0 + 6
      ).length,
    });
  const hAmp = [];
  const maxA = Math.min(Math.max(...legs.map((l) => l.amplPct), 0), 8);
  for (let a0 = 0; a0 <= maxA; a0 += 1)
    hAmp.push({
      bucket: `${a0}–${a0 + 1}%`,
      up: legs.filter(
        (l) => l.dir === "up" && l.amplPct >= a0 && l.amplPct < a0 + 1
      ).length,
      down: legs.filter(
        (l) => l.dir === "down" && l.amplPct >= a0 && l.amplPct < a0 + 1
      ).length,
    });
  return { legs, up, down, cur, hDur, hAmp };
}
function seasonality(dates, closes) {
  const byMonth = Array.from({ length: 12 }, () => []);
  let prevClose = null,
    prevMonth = null;
  dates.forEach((d, i) => {
    const m = +d.slice(5, 7) - 1;
    if (prevMonth === null) {
      prevMonth = m;
      prevClose = closes[i];
      return;
    }
    if (m !== prevMonth) {
      byMonth[prevMonth].push((closes[i - 1] / prevClose - 1) * 100);
      prevMonth = m;
      prevClose = closes[i - 1];
    }
  });
  return byMonth.map((a) =>
    a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : 0
  );
}

/* ============================================================
   3. PLAYBOOK ENGINE (nếu-thì, trigger, target, bằng chứng)
   ============================================================ */

const trendVN = { up: "Tăng", down: "Giảm", side: "Đi ngang" };

function buildPlaybook(m) {
  const {
    closes,
    piv,
    frames,
    rsiArr,
    macdArr,
    scens,
    patterns,
    volConfirm,
    ma50,
    ma200,
    strength,
    div,
    digits,
  } = m;
  const last = closes[closes.length - 1];
  const fx = (v) => v.toFixed(digits);
  const overhead = piv
    .filter((p) => p.type === "H" && p.price > last)
    .map((p) => p.price);
  const below = piv
    .filter((p) => p.type === "L" && p.price < last)
    .map((p) => p.price);
  const R = overhead.length
    ? Math.min(...overhead)
    : Math.max(...closes.slice(-40));
  const S = below.length ? Math.max(...below) : Math.min(...closes.slice(-40));
  const range = Math.max(R - S, 1e-9);
  const fibs = fibLevels(majorSwing(piv));

  const lastRSI = rsiArr[rsiArr.length - 1] ?? 50;
  const lastM = macdArr[macdArr.length - 1];
  const m50 = ma50[ma50.length - 1],
    m200 = ma200[ma200.length - 1];
  const topScen = scens[0];
  const bullPat = patterns.find((p) => p.dir === "tăng");
  const bearPat = patterns.find((p) => p.dir === "giảm");

  const mkEv = (up) => [
    {
      txt: `Xu hướng M: ${trendVN[frames.M.trend].toLowerCase()}`,
      ok: frames.M.trend === (up ? "up" : "down"),
      layer: 1,
    },
    {
      txt: `Xu hướng W: ${trendVN[frames.W.trend].toLowerCase()}`,
      ok: frames.W.trend === (up ? "up" : "down"),
      layer: 1,
    },
    {
      txt: `Xu hướng D: ${trendVN[frames.D.trend].toLowerCase()}`,
      ok: frames.D.trend === (up ? "up" : "down"),
      layer: 1,
    },
    {
      txt:
        m50 != null
          ? `Giá ${last > m50 ? "trên" : "dưới"} MA50`
          : "MA50 chưa đủ dữ liệu",
      ok: m50 != null && (up ? last > m50 : last < m50),
      layer: 1,
    },
    {
      txt:
        m50 != null && m200 != null
          ? `MA50 ${m50 > m200 ? "trên" : "dưới"} MA200 (${
              m50 > m200 ? "golden" : "death"
            }-cross regime)`
          : "MA200 chưa đủ dữ liệu",
      ok: m50 != null && m200 != null && (up ? m50 > m200 : m50 < m200),
      layer: 1,
    },
    {
      txt: `RSI(14) = ${lastRSI.toFixed(1)}`,
      ok: up ? lastRSI > 50 : lastRSI < 50,
      layer: 3,
    },
    {
      txt: `MACD ${lastM.macd > lastM.signal ? "trên" : "dưới"} signal`,
      ok: up ? lastM.macd > lastM.signal : lastM.macd < lastM.signal,
      layer: 3,
    },
    {
      txt:
        div.type === (up ? "bearish" : "bullish")
          ? div.txt
          : `Không có phân kỳ ${up ? "giảm" : "tăng"}`,
      ok: div.type !== (up ? "bearish" : "bullish"),
      layer: 3,
    },
    {
      txt: topScen
        ? `Elliott #1: ${topScen.name} (~${topScen.prob}%)`
        : "Elliott: chưa đủ pivot",
      ok: !!topScen && topScen.dir === (up ? "up" : "down"),
      layer: 2,
    },
    {
      txt: (up ? bullPat : bearPat)
        ? `Pattern: ${(up ? bullPat : bearPat).name} — ${
            (up ? bullPat : bearPat).status
          }`
        : `Không có pattern ${up ? "tăng" : "giảm"}`,
      ok: !!(up ? bullPat : bearPat),
      layer: 2,
    },
    {
      txt: volConfirm
        ? `Volume gấp ${volConfirm.ratio.toFixed(
            1
          )}× TB20 phiên gần nhất — ${
            volConfirm.ratio >= 1.5 ? "dòng tiền mạnh" : "bình thường"
          }`
        : "Chưa đủ dữ liệu volume",
      ok: !!volConfirm && volConfirm.ratio >= 1.3 && volConfirm.up === up,
      layer: 3,
    },
  ];
  const evBull = mkEv(true),
    evBear = mkEv(false);

  const bullScore = evBull.filter((e) => e.ok).length;
  const bearScore = evBear.filter((e) => e.ok).length;
  const biasPct = Math.round((bullScore / (bullScore + bearScore || 1)) * 100);
  const bias = biasPct >= 60 ? "up" : biasPct <= 40 ? "down" : "side";

  const tA1 = R + range * 0.618,
    tA2 = R + range;
  const tB1 = S - range * 0.618,
    tB2 = S - range;
  const branches = [
    {
      id: "A",
      dir: "up",
      title: `Kịch bản A — phá lên trên kháng cự ${fx(R)}`,
      trigger: `Nến D đóng cửa trên ${fx(R)} (chạm trong phiên không tính)`,
      targets: [
        `T1 = ${fx(tA1)} (0.618 × biên độ S–R)`,
        `T2 = ${fx(tA2)} (measured move: R + (R−S))`,
        ...(topScen && topScen.dir === "up" && topScen.target.includes("Fib")
          ? [`T3 = theo ${topScen.target}`]
          : []),
        ...(bullPat && bullPat.target
          ? [`Pattern target = ${fx(bullPat.target)}`]
          : []),
      ],
      invalid: `Vô hiệu nếu sau khi phá, giá đóng cửa quay lại dưới ${fx(
        R
      )} (false break); bỏ hẳn khi đóng dưới ${fx(S)}`,
      evidence: evBull,
      score: bullScore,
      total: evBull.length,
    },
    {
      id: "B",
      dir: "down",
      title: `Kịch bản B — cảnh báo nếu thủng hỗ trợ ${fx(S)} (không mở lệnh bán khống — TTCK VN không hỗ trợ short)`,
      trigger: `Nến D đóng cửa dưới ${fx(S)} — đây là tín hiệu THOÁT/TRÁNH MUA, không phải điểm vào lệnh`,
      targets: [
        `Vùng giá có thể về nếu thủng: ${fx(tB1)} (0.618 × biên độ S–R)`,
        `Vùng mở rộng: ${fx(tB2)} (measured move: S − (R−S))`,
        ...(topScen && topScen.dir === "down" && topScen.target.includes("Fib")
          ? [`Tham chiếu thêm: ${topScen.target}`]
          : []),
        ...(bearPat && bearPat.target
          ? [`Pattern chiếu tới: ${fx(bearPat.target)}`]
          : []),
      ],
      invalid: `Cảnh báo hết hiệu lực nếu giá đóng cửa quay lại trên ${fx(
        S
      )}; loại bỏ hẳn khi đóng trên ${fx(R)}`,
      evidence: evBear,
      score: bearScore,
      total: evBear.length,
    },
    {
      id: "C",
      dir: "side",
      title: `Kịch bản C — kẹt trong biên ${fx(S)} – ${fx(R)}`,
      trigger: `Giá bị từ chối tại biên (chạm gần R rồi RSI quay xuống từ >60, hoặc gần S với RSI hồi từ <40) mà chưa có nến đóng ngoài biên`,
      targets: [
        `Dao động về biên đối diện; điểm giữa biên ${fx(
          (R + S) / 2
        )} là mốc cân bằng`,
      ],
      invalid:
        "Kịch bản C tự hết hiệu lực ngay khi A hoặc B kích hoạt (đóng cửa ngoài biên)",
      evidence: [
        {
          txt: `Xu hướng W hiện ${trendVN[
            frames.W.trend
          ].toLowerCase()} — range trade hợp lý nhất khi W đi ngang`,
          ok: frames.W.trend === "side",
          layer: 1,
        },
        {
          txt: `Độ mạnh xu hướng 40 phiên: slope ${strength.slopePerDayInVol.toFixed(
            2
          )} vol/ngày, R²=${strength.r2.toFixed(2)} ${
            strength.r2 < 0.3
              ? "(yếu → thuận range)"
              : "(rõ → bất lợi cho range)"
          }`,
          ok: strength.r2 < 0.3,
          layer: 1,
        },
        {
          txt: `RSI ở vùng giữa (40–60): ${lastRSI.toFixed(1)}`,
          ok: lastRSI >= 40 && lastRSI <= 60,
          layer: 3,
        },
      ],
      score: 0,
      total: 3,
    },
  ];
  branches[2].score = branches[2].evidence.filter((e) => e.ok).length;
  return {
    R,
    S,
    range,
    fibs,
    tA1,
    tA2,
    tB1,
    tB2,
    last,
    branches,
    bias,
    biasPct,
    bullScore,
    bearScore,
  };
}

/* ============================================================
   4. HURST ENGINE — 40+ chỉ báo (kể cả Volume), walk-forward
   ============================================================ */

function sharpeOf(rets) {
  const s = mstd(rets);
  return s.sd > 0 ? (s.mean / s.sd) * Math.sqrt(252) : 0;
}
function maxDrawdown(rets) {
  let cum = 1,
    peak = 1,
    mdd = 0;
  for (const r of rets) {
    cum *= 1 + r;
    if (cum > peak) peak = cum;
    const dd = (cum - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}
function seriesStats(r) {
  const nz = r.filter((v) => v !== 0);
  let cum = 1;
  for (const v of r) cum *= 1 + v;
  const years = r.length / 252;
  return {
    sharpe: sharpeOf(r),
    cagr: (years > 0 ? Math.pow(cum, 1 / years) - 1 : 0) * 100,
    maxDD: maxDrawdown(r) * 100,
    pctInMarket: (nz.length / r.length) * 100,
    hitRate: nz.length
      ? (nz.filter((v) => v > 0).length / nz.length) * 100
      : NaN,
  };
}
// Benchmark "chỉ mua và giữ" (Buy & Hold) — vì đây là cổ phiếu (không phải
// forex), mọi chiến lược cần so sánh với việc đơn giản là mua rồi nắm giữ từ
// đầu kỳ OOS tới cuối. Trả về đường equity (%, giống format các view khác)
// và daily returns để tính Sharpe/CAGR/MaxDD cùng thước đo với chiến lược.
function buyHoldEquity(closes, dates, fromIdx) {
  const n = closes.length;
  const base = closes[fromIdx];
  const equity = [];
  const dailyReturns = Array(n).fill(0);
  let cum = 0;
  for (let i = fromIdx; i < n; i++) {
    if (i > fromIdx) dailyReturns[i] = closes[i] / closes[i - 1] - 1;
    cum = closes[i] / base - 1;
    equity.push({ d: dates[i], cum: cum * 100 });
  }
  const st = seriesStats(dailyReturns.slice(fromIdx));
  return {
    equity,
    dailyReturns,
    totalReturnPct: cum * 100,
    sharpe: st.sharpe,
    maxDDPct: st.maxDD,
    cagr: st.cagr,
  };
}
function rsStat(sub) {
  const m = mstd(sub);
  if (!(m.sd > 0)) return null;
  let cum = 0,
    mx = -Infinity,
    mn = Infinity;
  for (const r of sub) {
    cum += r - m.mean;
    if (cum > mx) mx = cum;
    if (cum < mn) mn = cum;
  }
  return (mx - mn) / m.sd;
}
function rollingHurst(rets, window, step) {
  const out = [];
  for (let i = window; i < rets.length; i += step) {
    const slice = rets.slice(i - window, i);
    const pts = [];
    for (const l of [16, 32, 64, 128]) {
      if (l > window / 2) continue;
      const nSub = Math.floor(slice.length / l);
      if (nSub < 2) continue;
      let sum = 0,
        cnt = 0;
      for (let s = 0; s < nSub; s++) {
        const rs = rsStat(slice.slice(s * l, (s + 1) * l));
        if (rs && isFinite(rs) && rs > 0) {
          sum += rs;
          cnt++;
        }
      }
      if (cnt > 0) pts.push([Math.log(l), Math.log(sum / cnt)]);
    }
    if (pts.length >= 2)
      out.push({
        i,
        H: linreg(
          pts.map((p) => p[0]),
          pts.map((p) => p[1])
        ).slope,
      });
  }
  return out;
}
function quickHurst(rets) {
  const window = Math.min(256, rets.length);
  const slice = rets.slice(-window);
  const pts = [];
  for (const l of [16, 32, 64, 128]) {
    if (l > window / 2) continue;
    const nSub = Math.floor(slice.length / l);
    if (nSub < 2) continue;
    let sum = 0,
      cnt = 0;
    for (let s = 0; s < nSub; s++) {
      const rs = rsStat(slice.slice(s * l, (s + 1) * l));
      if (rs && isFinite(rs) && rs > 0) {
        sum += rs;
        cnt++;
      }
    }
    if (cnt > 0) pts.push([Math.log(l), Math.log(sum / cnt)]);
  }
  if (pts.length < 2) return null;
  return linreg(
    pts.map((p) => p[0]),
    pts.map((p) => p[1])
  ).slope;
}
function denseHurst(raw, n) {
  const out = Array(n).fill(null);
  let last = null,
    idx = 0;
  for (let i = 0; i < n; i++) {
    while (idx < raw.length && raw[idx].i <= i) {
      last = raw[idx].H;
      idx++;
    }
    out[i] = last;
  }
  return out;
}
function stableOverWindow(arr, i, win, cond) {
  if (i - win + 1 < 0) return false;
  for (let k = i - win + 1; k <= i; k++) if (!cond(arr[k], k)) return false;
  return true;
}
function classifyPhase(hurstDense, n, stableWin, buffer) {
  const b = buffer || 0;
  const phase = Array(n).fill("OTHER");
  for (let i = 1; i < n; i++) {
    if (
      stableOverWindow(
        hurstDense,
        i - 1,
        stableWin,
        (v) => v != null && v > 0.5 + b
      )
    )
      phase[i] = "TREND";
    else if (
      stableOverWindow(
        hurstDense,
        i - 1,
        stableWin,
        (v) => v != null && v < 0.5 - b
      )
    )
      phase[i] = "RANGE";
  }
  return phase;
}

function rsiWilder(closes, period) {
  const n = closes.length,
    out = Array(n).fill(null);
  if (n <= period) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let ag = g / period,
    al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function zscoreSeries(closes, window) {
  const n = closes.length,
    out = Array(n).fill(null);
  for (let i = window; i < n; i++) {
    const s = mstd(closes.slice(i - window, i));
    out[i] = s.sd > 0 ? (closes[i] - s.mean) / s.sd : 0;
  }
  return out;
}
function bollinger(closes, window, mult) {
  const mid = sma(closes, window),
    n = closes.length;
  const upper = Array(n).fill(null),
    lower = Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    const sd = mstd(closes.slice(i - window + 1, i + 1)).sd;
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}
function rocSignal(closes, w) {
  return closes.map((_, i) =>
    i >= w
      ? closes[i] > closes[i - w]
        ? 1
        : closes[i] < closes[i - w]
        ? -1
        : 0
      : 0
  );
}
function rollingSlope(closes, window) {
  const n = closes.length,
    out = Array(n).fill(null);
  const mx = (window - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < window; x++) sxx += (x - mx) ** 2;
  for (let i = window; i <= n; i++) {
    const ys = closes.slice(i - window, i);
    const my = ys.reduce((a, b) => a + b, 0) / window;
    let sxy = 0;
    for (let k = 0; k < window; k++) sxy += (k - mx) * (ys[k] - my);
    out[i - 1] = sxx > 0 ? sxy / sxx : 0;
  }
  return out;
}
function tripleMaSignal(closes, w1, w2, w3) {
  const m1 = sma(closes, w1),
    m2 = sma(closes, w2),
    m3 = sma(closes, w3);
  return closes.map((_, i) => {
    if (m1[i] == null || m2[i] == null || m3[i] == null) return 0;
    if (m1[i] > m2[i] && m2[i] > m3[i]) return 1;
    if (m1[i] < m2[i] && m2[i] < m3[i]) return -1;
    return 0;
  });
}
function trixCalc(closes, period) {
  const e1 = ema(closes, period),
    e2 = ema(e1, period),
    e3 = ema(e2, period);
  const out = Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++)
    if (e3[i - 1]) out[i] = ((e3[i] - e3[i - 1]) / e3[i - 1]) * 100;
  return out;
}
function gmmaSignal(closes) {
  const shortP = [3, 5, 8, 10, 12, 15],
    longP = [30, 35, 40, 45, 50, 60];
  const sM = shortP.map((p) => sma(closes, p)),
    lM = longP.map((p) => sma(closes, p));
  return closes.map((_, i) => {
    const sv = sM.map((m) => m[i]).filter((v) => v != null);
    const lv = lM.map((m) => m[i]).filter((v) => v != null);
    if (sv.length < shortP.length || lv.length < longP.length) return 0;
    return sv.reduce((a, b) => a + b, 0) / sv.length >
      lv.reduce((a, b) => a + b, 0) / lv.length
      ? 1
      : -1;
  });
}
function kamaCalc(closes, erP, fastE, slowE) {
  const n = closes.length,
    out = Array(n).fill(null);
  const fastSC = 2 / (fastE + 1),
    slowSC = 2 / (slowE + 1);
  if (n <= erP) return out;
  out[erP] = closes[erP];
  for (let i = erP + 1; i < n; i++) {
    const change = Math.abs(closes[i] - closes[i - erP]);
    let vol = 0;
    for (let k = i - erP + 1; k <= i; k++)
      vol += Math.abs(closes[k] - closes[k - 1]);
    const er = vol > 0 ? change / vol : 0;
    const sc = (er * (fastSC - slowSC) + slowSC) ** 2;
    const prev = out[i - 1] == null ? closes[i - 1] : out[i - 1];
    out[i] = prev + sc * (closes[i] - prev);
  }
  return out;
}
function hullMA(closes, window) {
  const halfW = Math.max(1, Math.round(window / 2)),
    sqrtW = Math.max(1, Math.round(Math.sqrt(window)));
  const wh = wma(closes, halfW),
    wf = wma(closes, window);
  const diff = closes.map((_, i) =>
    wh[i] != null && wf[i] != null ? 2 * wh[i] - wf[i] : 0
  );
  return wma(diff, sqrtW);
}
function elderImpulseSignal(closes) {
  const e13 = ema(closes, 13);
  const { macd: m, signal: s } = macdCalc(closes, 12, 26, 9);
  const hist = closes.map((_, i) => m[i] - s[i]);
  return closes.map((_, i) => {
    if (i < 1) return 0;
    const emaUp = e13[i] > e13[i - 1],
      histUp = hist[i] > hist[i - 1];
    if (emaUp && histUp) return 1;
    if (!emaUp && !histUp) return -1;
    return 0;
  });
}
function coppockSignal(closes) {
  const r14 = closes.map((c, i) =>
    i >= 14 ? ((c - closes[i - 14]) / closes[i - 14]) * 100 : 0
  );
  const r11 = closes.map((c, i) =>
    i >= 11 ? ((c - closes[i - 11]) / closes[i - 11]) * 100 : 0
  );
  const curve = wma(
    closes.map((_, i) => r14[i] + r11[i]),
    10
  );
  return curve.map((v, i) =>
    v != null && i > 0 && curve[i - 1] != null ? (v > curve[i - 1] ? 1 : -1) : 0
  );
}
function demaCalc(closes, p) {
  const e1 = ema(closes, p),
    e2 = ema(e1, p);
  return closes.map((_, i) => 2 * e1[i] - e2[i]);
}
function temaCalc(closes, p) {
  const e1 = ema(closes, p),
    e2 = ema(e1, p),
    e3 = ema(e2, p);
  return closes.map((_, i) => 3 * e1[i] - 3 * e2[i] + e3[i]);
}
function kstCalc(closes) {
  const rocN = (n) =>
    closes.map((c, i) =>
      i >= n ? ((c - closes[i - n]) / closes[i - n]) * 100 : 0
    );
  const s1 = sma(rocN(10), 10),
    s2 = sma(rocN(15), 10),
    s3 = sma(rocN(20), 10),
    s4 = sma(rocN(30), 15);
  return closes.map((_, i) =>
    s1[i] != null && s2[i] != null && s3[i] != null && s4[i] != null
      ? s1[i] + 2 * s2[i] + 3 * s3[i] + 4 * s4[i]
      : null
  );
}
function stochRsiCalc(rsiArr, period) {
  const n = rsiArr.length,
    out = Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const slice = rsiArr.slice(i - period + 1, i + 1).filter((v) => v != null);
    if (slice.length < period) continue;
    const hh = Math.max(...slice),
      ll = Math.min(...slice);
    out[i] = hh > ll ? ((rsiArr[i] - ll) / (hh - ll)) * 100 : 50;
  }
  return out;
}
function fisherCloseCalc(closes, period) {
  const n = closes.length,
    val = Array(n).fill(0),
    fish = Array(n).fill(0);
  for (let i = period - 1; i < n; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const hh = Math.max(...slice),
      ll = Math.min(...slice);
    const raw = hh > ll ? 2 * ((closes[i] - ll) / (hh - ll)) - 1 : 0;
    val[i] =
      0.33 * Math.max(-0.999, Math.min(0.999, raw)) + 0.67 * (val[i - 1] || 0);
    const vC = Math.max(-0.999, Math.min(0.999, val[i]));
    fish[i] = 0.5 * Math.log((1 + vC) / (1 - vC)) + 0.5 * (fish[i - 1] || 0);
  }
  return fish;
}
function cmoCalc(closes, period) {
  const n = closes.length,
    out = Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let up = 0,
      dn = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const d = closes[k] - closes[k - 1];
      if (d > 0) up += d;
      else dn -= d;
    }
    out[i] = up + dn > 0 ? (100 * (up - dn)) / (up + dn) : 0;
  }
  return out;
}
function tsiCalc(closes, longP, shortP) {
  const mom = closes.map((c, i) => (i > 0 ? c - closes[i - 1] : 0));
  const sm2 = ema(ema(mom, longP), shortP);
  const sa2 = ema(ema(mom.map(Math.abs), longP), shortP);
  return closes.map((_, i) => (sa2[i] ? (100 * sm2[i]) / sa2[i] : null));
}
function dpoCalc(closes, period) {
  const n = closes.length,
    shift = Math.floor(period / 2) + 1,
    mid = sma(closes, period);
  const out = Array(n).fill(null);
  for (let i = shift; i < n; i++)
    if (mid[i] != null) out[i] = closes[i - shift] - mid[i];
  return out;
}
function percentB(closes, period, mult) {
  const b = bollinger(closes, period, mult);
  return closes.map((c, i) =>
    b.upper[i] != null && b.upper[i] > b.lower[i]
      ? (c - b.lower[i]) / (b.upper[i] - b.lower[i])
      : null
  );
}
function rollingMinMaxClose(closes, period) {
  const n = closes.length,
    hi = Array(n).fill(null),
    lo = Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity,
      ll = Infinity;
    for (let k = i - period + 1; k <= i; k++) {
      if (closes[k] > hh) hh = closes[k];
      if (closes[k] < ll) ll = closes[k];
    }
    hi[i] = hh;
    lo[i] = ll;
  }
  return { hi, lo };
}
// Bản dùng High/Low thật — chuẩn hơn rollingMinMaxClose vì Stochastic/Williams
// %R/Donchian đúng định nghĩa phải lấy Highest-High và Lowest-Low, không phải
// lấy từ giá đóng cửa.
function rollingMinMaxHL(highs, lows, period) {
  const n = highs.length,
    hi = Array(n).fill(null),
    lo = Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity,
      ll = Infinity;
    for (let k = i - period + 1; k <= i; k++) {
      if (highs[k] > hh) hh = highs[k];
      if (lows[k] < ll) ll = lows[k];
    }
    hi[i] = hh;
    lo[i] = ll;
  }
  return { hi, lo };
}
function closeStochK(closes, period, highs, lows) {
  const { hi, lo } =
    highs && lows
      ? rollingMinMaxHL(highs, lows, period)
      : rollingMinMaxClose(closes, period);
  return closes.map((c, i) =>
    hi[i] != null && hi[i] > lo[i]
      ? ((c - lo[i]) / (hi[i] - lo[i])) * 100
      : null
  );
}
function closeWilliamsR(closes, period, highs, lows) {
  const { hi, lo } =
    highs && lows
      ? rollingMinMaxHL(highs, lows, period)
      : rollingMinMaxClose(closes, period);
  return closes.map((c, i) =>
    hi[i] != null && hi[i] > lo[i]
      ? ((hi[i] - c) / (hi[i] - lo[i])) * -100
      : null
  );
}
// CCI đúng chuẩn dùng giá điển hình (High+Low+Close)/3 khi có H/L thật.
function closeCCI(closes, period, highs, lows) {
  const tp =
    highs && lows
      ? closes.map((c, i) => (highs[i] + lows[i] + c) / 3)
      : closes;
  const n = closes.length,
    out = Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const slice = tp.slice(i - period + 1, i + 1);
    const m = slice.reduce((a, b) => a + b, 0) / period;
    const md = slice.reduce((a, b) => a + Math.abs(b - m), 0) / period;
    out[i] = md > 0 ? (tp[i] - m) / (0.015 * md) : 0;
  }
  return out;
}
function keltnerFadeClose(closes, period, mult) {
  const mid = ema(closes, period),
    n = closes.length;
  const upper = Array(n).fill(null),
    lower = Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const sd = mstd(closes.slice(i - period + 1, i + 1)).sd;
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, lower };
}
function smaEnvelope(closes, period, pct) {
  const mid = sma(closes, period);
  return {
    upper: mid.map((v) => (v == null ? null : v * (1 + pct))),
    lower: mid.map((v) => (v == null ? null : v * (1 - pct))),
  };
}

// buildDefs: 20 chỉ báo TREND + 20 chỉ báo RANGE + 2 chỉ báo VOLUME.
// Khi có highs/lows thật, Stochastic/Williams%R/CCI/Donchian (r15,r16,r17,r18)
// dùng đúng High/Low trong phiên thay vì xấp xỉ bằng giá đóng cửa.
function buildDefs(closes, volumes, highs, lows) {
  const ma10 = sma(closes, 10),
    ma50 = sma(closes, 50),
    ma13 = sma(closes, 13),
    ma26 = sma(closes, 26);
  const ma20 = sma(closes, 20),
    ma100 = sma(closes, 100);
  const e12 = ema(closes, 12),
    e26 = ema(closes, 26),
    e50 = ema(closes, 50);
  const { macd: mc, signal: sg } = macdCalc(closes, 12, 26, 9);
  const roc10 = rocSignal(closes, 10);
  const sl20 = rollingSlope(closes, 20),
    sl50 = rollingSlope(closes, 50);
  const tri = tripleMaSignal(closes, 5, 20, 50);
  const trix15 = trixCalc(closes, 15),
    gm = gmmaSignal(closes),
    kama10 = kamaCalc(closes, 10, 2, 30);
  const hull20 = hullMA(closes, 20),
    elder = elderImpulseSignal(closes),
    copp = coppockSignal(closes);
  const dema20 = demaCalc(closes, 20),
    tema20 = temaCalc(closes, 20),
    kst = kstCalc(closes);

  const rsi14 = rsiWilder(closes, 14),
    rsi7 = rsiWilder(closes, 7),
    rsi2 = rsiWilder(closes, 2),
    rsi21 = rsiWilder(closes, 21);
  const b202 = bollinger(closes, 20, 2),
    b1015 = bollinger(closes, 10, 1.5);
  const z20 = zscoreSeries(closes, 20),
    z50 = zscoreSeries(closes, 50);
  const srsi = stochRsiCalc(rsi14, 14),
    fish = fisherCloseCalc(closes, 10),
    cmo = cmoCalc(closes, 14);
  const tsi = tsiCalc(closes, 25, 13),
    dpo = dpoCalc(closes, 20),
    pB = percentB(closes, 20, 2);
  const csK = closeStochK(closes, 14, highs, lows),
    cwR = closeWilliamsR(closes, 14, highs, lows),
    cCCI = closeCCI(closes, 20, highs, lows);
  const donch =
    highs && lows
      ? rollingMinMaxHL(highs, lows, 20)
      : rollingMinMaxClose(closes, 20),
    kelt = keltnerFadeClose(closes, 20, 2),
    env = smaEnvelope(closes, 20, 0.02);

  // --- Volume (đặc thù cổ phiếu VN, forex OTC không có) ---
  const volMA20 = sma(volumes, 20);
  const obv = obvSeries(closes, volumes);
  const obvSlope = rollingSlope(obv, 10);

  const trendDefs = [
    [
      "t1",
      "MA10/50 Cross",
      (i) =>
        ma10[i - 1] != null && ma50[i - 1] != null
          ? ma10[i - 1] > ma50[i - 1]
            ? 1
            : -1
          : 0,
    ],
    [
      "t2",
      "MA13/26 Cross",
      (i) =>
        ma13[i - 1] != null && ma26[i - 1] != null
          ? ma13[i - 1] > ma26[i - 1]
            ? 1
            : -1
          : 0,
    ],
    [
      "t3",
      "SMA20/100 Cross",
      (i) =>
        ma20[i - 1] != null && ma100[i - 1] != null
          ? ma20[i - 1] > ma100[i - 1]
            ? 1
            : -1
          : 0,
    ],
    ["t4", "EMA12/26 Cross", (i) => (e12[i - 1] > e26[i - 1] ? 1 : -1)],
    ["t5", "MACD Signal Cross", (i) => (mc[i - 1] > sg[i - 1] ? 1 : -1)],
    ["t6", "MACD Zero-Cross", (i) => (mc[i - 1] > 0 ? 1 : -1)],
    ["t7", "ROC(10) Momentum", (i) => roc10[i - 1]],
    [
      "t8",
      "Linreg Slope(20)",
      (i) => (sl20[i - 1] != null ? (sl20[i - 1] > 0 ? 1 : -1) : 0),
    ],
    [
      "t9",
      "Linreg Slope(50)",
      (i) => (sl50[i - 1] != null ? (sl50[i - 1] > 0 ? 1 : -1) : 0),
    ],
    ["t10", "Triple MA(5/20/50)", (i) => tri[i - 1]],
    [
      "t11",
      "TRIX(15)",
      (i) => (trix15[i - 1] != null ? (trix15[i - 1] > 0 ? 1 : -1) : 0),
    ],
    ["t12", "GMMA (Guppy MA)", (i) => gm[i - 1]],
    [
      "t13",
      "KAMA(10) Slope",
      (i) =>
        kama10[i - 1] != null && kama10[i - 2] != null
          ? kama10[i - 1] > kama10[i - 2]
            ? 1
            : -1
          : 0,
    ],
    [
      "t14",
      "Hull MA(20) Slope",
      (i) =>
        hull20[i - 1] != null && hull20[i - 2] != null
          ? hull20[i - 1] > hull20[i - 2]
            ? 1
            : -1
          : 0,
    ],
    ["t15", "Elder Impulse", (i) => elder[i - 1]],
    ["t16", "Coppock Curve", (i) => copp[i - 1]],
    ["t17", "Giá vs EMA(50)", (i) => (closes[i - 1] > e50[i - 1] ? 1 : -1)],
    ["t18", "DEMA(20) Slope", (i) => (dema20[i - 1] > dema20[i - 2] ? 1 : -1)],
    ["t19", "TEMA(20) Slope", (i) => (tema20[i - 1] > tema20[i - 2] ? 1 : -1)],
    [
      "t20",
      "KST (Know Sure Thing)",
      (i) => (kst[i - 1] != null ? (kst[i - 1] > 0 ? 1 : -1) : 0),
    ],
    [
      "t21",
      "Volume Breakout Confirm",
      (i) =>
        volMA20[i - 1] != null && volumes[i - 1] > volMA20[i - 1] * 1.3
          ? closes[i - 1] > closes[i - 2]
            ? 1
            : -1
          : 0,
    ],
    [
      "t22",
      "OBV Slope(10)",
      (i) => (obvSlope[i - 1] != null ? (obvSlope[i - 1] > 0 ? 1 : -1) : 0),
    ],
  ];
  const rangeDefs = [
    [
      "r1",
      "RSI(14) 30/70",
      (i) =>
        rsi14[i - 1] != null
          ? rsi14[i - 1] < 30
            ? 1
            : rsi14[i - 1] > 70
            ? -1
            : 0
          : 0,
    ],
    [
      "r2",
      "RSI(7) 30/70",
      (i) =>
        rsi7[i - 1] != null
          ? rsi7[i - 1] < 30
            ? 1
            : rsi7[i - 1] > 70
            ? -1
            : 0
          : 0,
    ],
    [
      "r3",
      "RSI(21) 30/70",
      (i) =>
        rsi21[i - 1] != null
          ? rsi21[i - 1] < 30
            ? 1
            : rsi21[i - 1] > 70
            ? -1
            : 0
          : 0,
    ],
    [
      "r4",
      "RSI(2) Extreme 10/90",
      (i) =>
        rsi2[i - 1] != null
          ? rsi2[i - 1] < 10
            ? 1
            : rsi2[i - 1] > 90
            ? -1
            : 0
          : 0,
    ],
    [
      "r5",
      "Bollinger(20,2)",
      (i) =>
        b202.upper[i - 1] == null
          ? 0
          : closes[i - 1] <= b202.lower[i - 1]
          ? 1
          : closes[i - 1] >= b202.upper[i - 1]
          ? -1
          : 0,
    ],
    [
      "r6",
      "Bollinger(10,1.5)",
      (i) =>
        b1015.upper[i - 1] == null
          ? 0
          : closes[i - 1] <= b1015.lower[i - 1]
          ? 1
          : closes[i - 1] >= b1015.upper[i - 1]
          ? -1
          : 0,
    ],
    [
      "r7",
      "%B Bollinger(20,2)",
      (i) =>
        pB[i - 1] != null
          ? pB[i - 1] < 0.1
            ? 1
            : pB[i - 1] > 0.9
            ? -1
            : 0
          : 0,
    ],
    [
      "r8",
      "Z-score(20) ±1",
      (i) =>
        z20[i - 1] != null
          ? z20[i - 1] < -1
            ? 1
            : z20[i - 1] > 1
            ? -1
            : 0
          : 0,
    ],
    [
      "r9",
      "Z-score(50) ±1.5",
      (i) =>
        z50[i - 1] != null
          ? z50[i - 1] < -1.5
            ? 1
            : z50[i - 1] > 1.5
            ? -1
            : 0
          : 0,
    ],
    [
      "r10",
      "StochRSI(14) 20/80",
      (i) =>
        srsi[i - 1] != null
          ? srsi[i - 1] < 20
            ? 1
            : srsi[i - 1] > 80
            ? -1
            : 0
          : 0,
    ],
    [
      "r11",
      "Fisher Transform(10)",
      (i) => (fish[i - 1] < -1 ? 1 : fish[i - 1] > 1 ? -1 : 0),
    ],
    [
      "r12",
      "CMO(14) ±50",
      (i) =>
        cmo[i - 1] != null
          ? cmo[i - 1] < -50
            ? 1
            : cmo[i - 1] > 50
            ? -1
            : 0
          : 0,
    ],
    [
      "r13",
      "TSI(25,13) ±25",
      (i) =>
        tsi[i - 1] != null
          ? tsi[i - 1] < -25
            ? 1
            : tsi[i - 1] > 25
            ? -1
            : 0
          : 0,
    ],
    [
      "r14",
      "DPO(20) Extreme ±2%",
      (i) =>
        dpo[i - 1] != null && closes[i - 1]
          ? dpo[i - 1] / closes[i - 1] < -0.02
            ? 1
            : dpo[i - 1] / closes[i - 1] > 0.02
            ? -1
            : 0
          : 0,
    ],
    [
      "r15",
      "Stochastic %K H/L(14)",
      (i) =>
        csK[i - 1] != null
          ? csK[i - 1] < 20
            ? 1
            : csK[i - 1] > 80
            ? -1
            : 0
          : 0,
    ],
    [
      "r16",
      "Williams %R H/L(14)",
      (i) =>
        cwR[i - 1] != null
          ? cwR[i - 1] < -80
            ? 1
            : cwR[i - 1] > -20
            ? -1
            : 0
          : 0,
    ],
    [
      "r17",
      "CCI giá điển hình(20) ±100",
      (i) =>
        cCCI[i - 1] != null
          ? cCCI[i - 1] < -100
            ? 1
            : cCCI[i - 1] > 100
            ? -1
            : 0
          : 0,
    ],
    [
      "r18",
      "Donchian H/L(20) Fade",
      (i) =>
        donch.hi[i - 1] == null
          ? 0
          : closes[i - 1] <= donch.lo[i - 1]
          ? 1
          : closes[i - 1] >= donch.hi[i - 1]
          ? -1
          : 0,
    ],
    [
      "r19",
      "Keltner-close(20,2) Fade",
      (i) =>
        kelt.upper[i - 1] == null
          ? 0
          : closes[i - 1] <= kelt.lower[i - 1]
          ? 1
          : closes[i - 1] >= kelt.upper[i - 1]
          ? -1
          : 0,
    ],
    [
      "r20",
      "SMA Envelope(20,±2%) Fade",
      (i) =>
        env.upper[i - 1] == null
          ? 0
          : closes[i - 1] <= env.lower[i - 1]
          ? 1
          : closes[i - 1] >= env.upper[i - 1]
          ? -1
          : 0,
    ],
  ];
  return { trendDefs, rangeDefs };
}

let PRICE_UNIT = 1; // đơn vị hiển thị P&L: VND/cổ phiếu (không dùng "pip" như forex)

function buildInversePosArray(rawFn, n) {
  const pos = Array(n).fill(0);
  let held = false,
    side = 0,
    prev = 0;
  for (let i = 1; i < n; i++) {
    const raw = rawFn(i);
    if (raw !== 0 && raw !== prev) {
      if (!held) {
        held = true;
        side = raw;
      } else if (raw === side) {
        held = false;
        side = 0;
      }
    }
    pos[i] = held ? -side : 0;
    prev = raw;
  }
  return pos;
}
function extractTradesRaw(fn, n, bh, closes) {
  const trades = [];
  let cur = 0,
    entryIdx = -1,
    cum = 1;
  for (let i = 1; i < n; i++) {
    const p = fn(i);
    if (p !== cur) {
      if (cur !== 0) {
        const ep = closes[entryIdx - 1],
          xp = closes[i - 1];
        trades.push({
          entryIdx,
          exitIdx: i - 1,
          side: cur,
          ret: cum - 1,
          entryPrice: ep,
          exitPrice: xp,
          priceDiff: cur * (xp - ep),
        });
      }
      if (p !== 0) {
        entryIdx = i;
        cum = 1;
      }
      cur = p;
    }
    if (cur !== 0) cum *= 1 + cur * bh[i];
  }
  if (cur !== 0) {
    const ep = closes[entryIdx - 1],
      xp = closes[n - 1];
    trades.push({
      entryIdx,
      exitIdx: n - 1,
      side: cur,
      ret: cum - 1,
      entryPrice: ep,
      exitPrice: xp,
      priceDiff: cur * (xp - ep),
      open: true,
    });
  }
  return trades;
}
const filterTradesByPhase = (trades, phase, label, upTo) =>
  trades.filter((t) => t.entryIdx < upTo && phase[t.entryIdx] === label);

function buildConsensusTradesWithSL(pos, bh, closes, atr, slMult, lows, highs) {
  const n = pos.length,
    trades = [];
  let side = 0,
    entryIdx = -1,
    cum = 1,
    slPrice = null,
    slDist = null;
  const start = (i) => {
    entryIdx = i;
    cum = 1;
    const a = atr[i - 1];
    if (a != null && a > 0) {
      slDist = a * slMult;
      slPrice = closes[i - 1] - side * slDist;
    } else {
      slDist = null;
      slPrice = null;
    }
  };
  const end = (exitIdx, exitPrice, stoppedOut) => {
    const ep = closes[entryIdx - 1];
    trades.push({
      entryIdx,
      exitIdx,
      finalExitIdx: exitIdx,
      side,
      entryPrice: ep,
      exitPrice,
      finalExitPrice: exitPrice,
      ret: cum - 1,
      priceDiff: side * (exitPrice - ep),
      slPrice,
      slDistance: slDist,
      R: slDist ? (side * (exitPrice - ep)) / slDist : null,
      stoppedOut,
    });
  };
  for (let i = 1; i < n; i++) {
    const ns = pos[i] > 0 ? 1 : pos[i] < 0 ? -1 : 0;
    if (ns !== side) {
      if (side !== 0) end(i - 1, closes[i - 1], false);
      side = ns;
      if (side !== 0) start(i);
    }
    if (side !== 0) {
      cum *= 1 + side * bh[i];
      if (slPrice != null) {
        // "Quét SL": dùng Low thật trong phiên (lệnh Long) — nếu giá chỉ
        // chạm SL rồi đóng cửa hồi lại, lệnh dừng vẫn đã khớp trong thực tế.
        // Chỉ dùng Close để kiểm tra khi chưa có dữ liệu Low/High thật.
        const hit =
          side === 1
            ? lows
              ? lows[i] <= slPrice
              : closes[i] <= slPrice
            : highs
            ? highs[i] >= slPrice
            : closes[i] >= slPrice;
        if (hit) {
          end(i, slPrice, true);
          side = 0;
        }
      }
    }
  }
  if (side !== 0) end(n - 1, closes[n - 1], false);
  return trades;
}
function simulateEquityDaily(trades, closes, n, riskPct = 0.01) {
  const valid = trades.filter((t) => t.R != null && t.slDistance > 0);
  const opensOn = Array.from({ length: n }, () => []);
  for (const t of valid) opensOn[Math.max(1, t.entryIdx)].push(t);
  let equity = 1,
    peak = 1,
    maxDD = 0,
    stopped = 0,
    blown = false;
  const open = new Map();
  const daily = Array(n).fill(0);
  for (let day = 1; day < n; day++) {
    for (const t of opensOn[day]) open.set(t, riskPct * (t.riskWeight ?? 1));
    let pnl = 0;
    for (const [t, risk] of open) {
      const price = day === t.finalExitIdx ? t.finalExitPrice : closes[day];
      pnl += ((t.side * (price - closes[day - 1])) / t.slDistance) * risk;
    }
    equity += pnl;
    if (equity <= 0) {
      equity = 0;
      blown = true;
    }
    daily[day] = pnl;
    for (const [t] of open)
      if (day === t.finalExitIdx) {
        open.delete(t);
        if (t.stoppedOut) stopped++;
      }
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDD) maxDD = dd;
    if (blown) break;
  }
  return {
    n: valid.length,
    finalMultiple: equity,
    totalReturnPct: (equity - 1) * 100,
    maxDDPct: maxDD * 100,
    stoppedOutCount: stopped,
    stoppedOutPct: valid.length ? (stopped / valid.length) * 100 : NaN,
    dailyReturns: daily,
    blown,
  };
}
function tradeStats(trades, n) {
  if (!trades.length)
    return { sharpe: -Infinity, count: 0, hitRate: NaN, avgHoldDays: 0 };
  const rets = trades.map((t) => t.ret);
  const m = mstd(rets);
  const perYear = trades.length / Math.max(n / 252, 1e-6);
  const sharpe =
    m.sd > 0
      ? (m.mean / m.sd) * Math.sqrt(Math.max(perYear, 1e-6))
      : m.mean > 0
      ? 5
      : m.mean < 0
      ? -5
      : 0;
  return {
    sharpe,
    count: trades.length,
    hitRate: (rets.filter((r) => r > 0).length / rets.length) * 100,
    avgHoldDays:
      trades.reduce((s, t) => s + (t.exitIdx - t.entryIdx + 1), 0) /
      trades.length,
  };
}
function summarizeTrades(key, label, trades, phase, phaseLabel, n, inv) {
  const f = filterTradesByPhase(trades, phase, phaseLabel, n);
  const st = tradeStats(f, n);
  return {
    key,
    label,
    sharpe: st.sharpe,
    n: f.length,
    activeN: st.count,
    hitRate: st.hitRate,
    avgHoldDays: st.avgHoldDays,
    inv,
  };
}
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q,
    base = Math.floor(pos),
    rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}
function distStats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b),
    n = s.length;
  return {
    n,
    min: s[0],
    max: s[n - 1],
    mean: s.reduce((a, b) => a + b, 0) / n,
    median: quantile(s, 0.5),
    q1: quantile(s, 0.25),
    q3: quantile(s, 0.75),
  };
}
function winLossStats(trades, valueFn) {
  const vf = valueFn || ((t) => t.ret);
  return {
    win: distStats(trades.filter((t) => t.ret > 0).map(vf)),
    loss: distStats(trades.filter((t) => t.ret <= 0).map(vf)),
    all: distStats(trades.map(vf)),
  };
}

const GRID = {
  buffers: [0, 0.03, 0.06],
  stableWins: [3, 5, 8],
  minTrades: [3, 5, 8],
};
function selectReliable(cands, phase, label, upTo, minTrades) {
  const res = cands.map((d) => {
    const f = filterTradesByPhase(d.trades, phase, label, upTo);
    const st = tradeStats(f, upTo);
    return {
      ...d,
      sharpe: st.sharpe,
      tradeCount: st.count,
      hitRate: st.hitRate,
      avgHoldDays: st.avgHoldDays,
      filteredTrades: f,
    };
  });
  return {
    results: res,
    rel: res.filter(
      (r) => isFinite(r.sharpe) && r.sharpe > 0 && r.tradeCount >= minTrades
    ),
  };
}
function selectReliableAll(cands, upTo, minTrades) {
  const res = cands.map((d) => {
    const f = d.trades.filter((t) => t.entryIdx < upTo);
    const st = tradeStats(f, upTo);
    return {
      ...d,
      sharpe: st.sharpe,
      tradeCount: st.count,
      hitRate: st.hitRate,
      avgHoldDays: st.avgHoldDays,
      filteredTrades: f,
    };
  });
  return {
    results: res,
    rel: res.filter(
      (r) => isFinite(r.sharpe) && r.sharpe > 0 && r.tradeCount >= minTrades
    ),
  };
}
function evalCombo(
  hurstDense,
  n,
  mode,
  buffer,
  stableWin,
  minTrades,
  tC,
  rC,
  bh,
  direction,
  upTo,
  floor
) {
  const dm = (raw) =>
    direction === "long" ? (raw > 0 ? 1 : 0) : raw < 0 ? -1 : 0;
  let phaseCombo = null,
    relTrend = null,
    relRange = null,
    allRel = null;
  if (mode === "always")
    allRel = selectReliableAll([...tC, ...rC], upTo, minTrades).rel;
  else {
    phaseCombo = classifyPhase(hurstDense, n, stableWin, buffer);
    relTrend = selectReliable(tC, phaseCombo, "TREND", upTo, minTrades).rel;
    relRange = selectReliable(rC, phaseCombo, "RANGE", upTo, minTrades).rel;
  }
  const ret = Array(upTo).fill(0);
  let active = 0;
  for (let i = 1; i < upTo; i++) {
    const sigs =
      mode === "always"
        ? allRel
        : phaseCombo[i] === "TREND"
        ? relTrend
        : phaseCombo[i] === "RANGE"
        ? relRange
        : [];
    if (!sigs.length) continue;
    let sum = 0;
    for (const c of sigs) sum += dm(c.fn(i));
    const pos = sum / sigs.length;
    if (pos !== 0) active++;
    ret[i] = pos * bh[i];
  }
  return {
    buffer,
    stableWin,
    minTrades,
    mode,
    phaseCombo,
    relTrend,
    relRange,
    allRel,
    sharpe: active >= floor ? sharpeOf(ret) : -Infinity,
    activeDays: active,
  };
}
function bestCombo(hurstDense, n, mode, tC, rC, bh, direction, upTo, floor) {
  let best = null;
  const buffers = mode === "always" ? [0] : GRID.buffers;
  const wins = mode === "always" ? [1] : GRID.stableWins;
  for (const b of buffers)
    for (const w of wins)
      for (const mt of GRID.minTrades) {
        const r = evalCombo(
          hurstDense,
          n,
          mode,
          b,
          w,
          mt,
          tC,
          rC,
          bh,
          direction,
          upTo,
          floor
        );
        if (!best || r.sharpe > best.sharpe) best = r;
      }
  return best;
}
function runWalkForwardOptimized(
  hurstDense,
  n,
  tC,
  rC,
  bh,
  dates,
  opts,
  direction,
  mode
) {
  const folds = Math.max(2, opts.wfFolds);
  const bnd = Array.from({ length: folds + 1 }, (_, k) =>
    Math.floor((n * k) / folds)
  );
  const combinedPos = Array(n).fill(0),
    combinedRet = Array(n).fill(0);
  const dm = (raw) =>
    direction === "long" ? (raw > 0 ? 1 : 0) : raw < 0 ? -1 : 0;
  const foldDiagnostics = [],
    oosTrades = [];
  for (let f = 1; f < folds; f++) {
    const trainEnd = bnd[f],
      testStart = bnd[f],
      testEnd = bnd[f + 1];
    const best = bestCombo(
      hurstDense,
      n,
      mode,
      tC,
      rC,
      bh,
      direction,
      trainEnd,
      Math.max(10, Math.round(trainEnd * 0.01))
    );
    for (let i = Math.max(1, testStart); i < testEnd; i++) {
      const sigs =
        mode === "always"
          ? best.allRel
          : best.phaseCombo[i] === "TREND"
          ? best.relTrend
          : best.phaseCombo[i] === "RANGE"
          ? best.relRange
          : [];
      if (!sigs.length) continue;
      let sum = 0;
      for (const c of sigs) sum += dm(c.fn(i));
      combinedPos[i] = sum / sigs.length;
      combinedRet[i] = combinedPos[i] * bh[i];
    }
    const collect = (list, label) => {
      for (const c of list)
        for (const t of c.trades) {
          if (t.entryIdx < testStart || t.entryIdx >= testEnd) continue;
          if (label && best.phaseCombo[t.entryIdx] !== label) continue;
          if (dm(t.side) === 0) continue;
          oosTrades.push(t);
        }
    };
    if (mode === "always") collect(best.allRel, null);
    else {
      collect(best.relTrend, "TREND");
      collect(best.relRange, "RANGE");
    }
    foldDiagnostics.push({
      fold: f,
      testFromDate: dates[testStart],
      testToDate: dates[Math.min(n - 1, testEnd - 1)],
      buffer: mode === "always" ? null : best.buffer,
      stableWin: mode === "always" ? null : best.stableWin,
      minTrades: best.minTrades,
      trainSharpe: isFinite(best.sharpe) ? best.sharpe : null,
      relTrendCount: mode === "always" ? null : best.relTrend.length,
      relCount:
        mode === "always"
          ? best.allRel.length
          : best.relTrend.length + best.relRange.length,
    });
  }
  const oosStart = bnd[1];
  let cum = 0;
  const equity = [];
  for (let i = oosStart; i < n; i++) {
    cum += combinedRet[i];
    equity.push({ d: dates[i], cum: cum * 100 });
  }
  return {
    combinedPos,
    combinedRet,
    equity,
    stats: seriesStats(combinedRet.slice(oosStart)),
    portfolioTrades: oosTrades,
    portfolioTradeStats: tradeStats(oosTrades, Math.max(n - oosStart, 1)),
    foldDiagnostics,
    oosStart,
    oosFromDate: dates[oosStart],
  };
}

function buildTrendConsensusSeries(relTrend, phase, n, direction) {
  const dm = (raw) =>
    direction === "long" ? (raw > 0 ? 1 : 0) : raw < 0 ? -1 : 0;
  const pos = Array(n).fill(0);
  if (!relTrend || !relTrend.length) return pos;
  for (let i = 1; i < n; i++) {
    if (phase[i] !== "TREND") continue;
    let sum = 0;
    for (const c of relTrend) sum += dm(c.fn(i));
    pos[i] = sum / relTrend.length;
  }
  return pos;
}
function buildPullbackPos(
  trendPos,
  closes,
  direction,
  atr,
  minTrendStrength,
  minPullbackATR
) {
  const n = trendPos.length,
    pos = Array(n).fill(0);
  const mts = minTrendStrength || 0,
    mpb = minPullbackATR || 0;
  let inPos = false;
  for (let i = 2; i < n; i++) {
    const t = trendPos[i - 1];
    const confirms = direction === "long" ? t > mts : t < -mts;
    const move = closes[i - 1] - closes[i - 2];
    const aRef =
      atr[i - 2] != null ? atr[i - 2] : atr[i - 1] != null ? atr[i - 1] : 0;
    const pulled =
      direction === "long" ? move < -mpb * aRef : move > mpb * aRef;
    if (!inPos && confirms && pulled) inPos = true;
    else if (inPos && !confirms) inPos = false;
    pos[i] = inPos ? (direction === "long" ? 1 : -1) : 0;
  }
  return pos;
}
function runPullbackWalkForward(
  hurstDense,
  n,
  tC,
  rC,
  bh,
  dates,
  closes,
  atr,
  opts,
  direction,
  lows,
  highs
) {
  const folds = Math.max(2, opts.wfFolds);
  const bnd = Array.from({ length: folds + 1 }, (_, k) =>
    Math.floor((n * k) / folds)
  );
  const trendPosFull = Array(n).fill(0);
  const foldDiagnostics = [];
  const dm = (raw) =>
    direction === "long" ? (raw > 0 ? 1 : 0) : raw < 0 ? -1 : 0;
  for (let f = 1; f < folds; f++) {
    const trainEnd = bnd[f],
      testStart = bnd[f],
      testEnd = bnd[f + 1];
    const best = bestCombo(
      hurstDense,
      n,
      "gated",
      tC,
      rC,
      bh,
      direction,
      trainEnd,
      Math.max(10, Math.round(trainEnd * 0.01))
    );
    for (let i = Math.max(2, testStart); i < testEnd; i++) {
      if (best.phaseCombo[i] !== "TREND" || !best.relTrend.length) continue;
      let sum = 0;
      for (const c of best.relTrend) sum += dm(c.fn(i));
      trendPosFull[i] = sum / best.relTrend.length;
    }
    foldDiagnostics.push({
      fold: f,
      testFromDate: dates[testStart],
      testToDate: dates[Math.min(n - 1, testEnd - 1)],
      buffer: best.buffer,
      stableWin: best.stableWin,
      relTrendCount: best.relTrend.length,
    });
  }
  const oosStart = bnd[1];
  const pbPos = buildPullbackPos(
    trendPosFull,
    closes,
    direction,
    atr,
    opts.minTrendStrength,
    opts.minPullbackATR
  );
  const allTrades = buildConsensusTradesWithSL(
    pbPos,
    bh,
    closes,
    atr,
    opts.slMult,
    lows,
    highs
  );
  const oosTrades = allTrades.filter((t) => t.entryIdx >= oosStart);
  const sim = simulateEquityDaily(oosTrades, closes, n, opts.riskPct);
  let cum = 0;
  const equity = [];
  for (let i = oosStart; i < n; i++) {
    cum += sim.dailyReturns[i];
    equity.push({ d: dates[i], cum: cum * 100 });
  }
  return {
    trendPosFull,
    pbPosFull: pbPos,
    oosTrades,
    tradeStats: tradeStats(oosTrades, Math.max(n - oosStart, 1)),
    winLoss: winLossStats(oosTrades, (t) => t.priceDiff),
    sim,
    equity,
    foldDiagnostics,
    oosStart,
    oosFromDate: dates[oosStart],
  };
}

function buildRangeConsensusSeries(relRange, phase, n, direction) {
  const dm = (raw) =>
    direction === "long"
      ? raw > 0
        ? 1
        : 0
      : direction === "short"
      ? raw < 0
        ? -1
        : 0
      : raw;
  const pos = Array(n).fill(0);
  if (!relRange || !relRange.length) return pos;
  for (let i = 1; i < n; i++) {
    if (phase[i] !== "RANGE") continue;
    let sum = 0;
    for (const c of relRange) sum += dm(c.fn(i));
    pos[i] = sum / relRange.length;
  }
  return pos;
}
function buildRangeFadePos(rangeCons, direction, enterThr) {
  const n = rangeCons.length,
    pos = Array(n).fill(0);
  const thr = enterThr || 0.2;
  let inPos = false,
    side = 0;
  for (let i = 1; i < n; i++) {
    const c = rangeCons[i - 1];
    if (!inPos) {
      if (direction !== "short" && c >= thr) {
        inPos = true;
        side = 1;
      } else if (direction !== "long" && c <= -thr) {
        inPos = true;
        side = -1;
      }
    } else if ((side === 1 && c <= 0) || (side === -1 && c >= 0)) {
      inPos = false;
      side = 0;
    }
    pos[i] = inPos ? side : 0;
  }
  return pos;
}
function runRangeFadeWalkForward(
  hurstDense,
  n,
  tC,
  rC,
  bh,
  dates,
  closes,
  atr,
  opts,
  direction,
  lows,
  highs
) {
  const folds = Math.max(2, opts.wfFolds);
  const bnd = Array.from({ length: folds + 1 }, (_, k) =>
    Math.floor((n * k) / folds)
  );
  const consFull = Array(n).fill(0);
  const foldDiagnostics = [];
  const dm = (raw) =>
    direction === "long"
      ? raw > 0
        ? 1
        : 0
      : direction === "short"
      ? raw < 0
        ? -1
        : 0
      : raw;
  for (let f = 1; f < folds; f++) {
    const trainEnd = bnd[f],
      testStart = bnd[f],
      testEnd = bnd[f + 1];
    const best = bestCombo(
      hurstDense,
      n,
      "gated",
      tC,
      rC,
      bh,
      direction,
      trainEnd,
      Math.max(10, Math.round(trainEnd * 0.01))
    );
    for (let i = Math.max(1, testStart); i < testEnd; i++) {
      if (best.phaseCombo[i] !== "RANGE" || !best.relRange.length) continue;
      let sum = 0;
      for (const c of best.relRange) sum += dm(c.fn(i));
      consFull[i] = sum / best.relRange.length;
    }
    foldDiagnostics.push({
      fold: f,
      testFromDate: dates[testStart],
      testToDate: dates[Math.min(n - 1, testEnd - 1)],
      buffer: best.buffer,
      stableWin: best.stableWin,
      relRangeCount: best.relRange.length,
    });
  }
  const oosStart = bnd[1];
  const pos = buildRangeFadePos(consFull, direction, opts.rangeEnterThr || 0.2);
  const allTrades = buildConsensusTradesWithSL(
    pos,
    bh,
    closes,
    atr,
    opts.slMult,
    lows,
    highs
  );
  const oosTrades = allTrades.filter((t) => t.entryIdx >= oosStart);
  const sim = simulateEquityDaily(oosTrades, closes, n, opts.riskPct);
  let cum = 0;
  const equity = [];
  for (let i = oosStart; i < n; i++) {
    cum += sim.dailyReturns[i];
    equity.push({ d: dates[i], cum: cum * 100 });
  }
  return {
    consFull,
    posFull: pos,
    oosTrades,
    tradeStats: tradeStats(oosTrades, Math.max(n - oosStart, 1)),
    winLoss: winLossStats(oosTrades, (t) => t.priceDiff),
    sim,
    equity,
    foldDiagnostics,
    oosStart,
    oosFromDate: dates[oosStart],
  };
}

function buildCMTRegimeSeries(closes, highs, lows) {
  const H_ = highs || closes,
    L_ = lows || closes;
  const n = closes.length,
    reg = Array(n).fill(0);
  for (let i = 40; i < n; i++) {
    const R = Math.max(...H_.slice(i - 40, i)),
      S = Math.min(...L_.slice(i - 40, i));
    reg[i] = closes[i] > R ? 1 : closes[i] < S ? -1 : 0;
  }
  return reg;
}
function runProfitViewsWalkForward(
  hurstDense,
  n,
  tC,
  rC,
  bh,
  dates,
  closes,
  atr,
  opts,
  highs,
  lows
) {
  const folds = Math.max(2, opts.wfFolds);
  const bnd = Array.from({ length: folds + 1 }, (_, k) =>
    Math.floor((n * k) / folds)
  );
  const cmtReg = buildCMTRegimeSeries(closes, highs, lows);
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const rawTrend = Array(n).fill(0),
    rawRange = Array(n).fill(0);
  const foldDiagnostics = [];
  for (let f = 1; f < folds; f++) {
    const trainEnd = bnd[f],
      testStart = bnd[f],
      testEnd = bnd[f + 1];
    const best = bestCombo(
      hurstDense,
      n,
      "gated",
      tC,
      rC,
      bh,
      "long",
      trainEnd,
      Math.max(10, Math.round(trainEnd * 0.01))
    );
    for (let i = Math.max(1, testStart); i < testEnd; i++) {
      if (best.relTrend.length) {
        let s = 0;
        for (const c of best.relTrend) s += sgn(c.fn(i));
        rawTrend[i] = s / best.relTrend.length;
      }
      if (best.relRange.length) {
        let s = 0;
        for (const c of best.relRange) s += sgn(c.fn(i));
        rawRange[i] = s / best.relRange.length;
      }
    }
    foldDiagnostics.push({
      fold: f,
      testFromDate: dates[testStart],
      testToDate: dates[Math.min(n - 1, testEnd - 1)],
      buffer: best.buffer,
      stableWin: best.stableWin,
      relTrendCount: best.relTrend.length,
      relRangeCount: best.relRange.length,
    });
  }
  // Chỉ Long — TTCK VN không bán khống. Khi regime là "breakdown" (cmtReg<0),
  // hệ thống đứng ngoài (vị thế = 0) thay vì mở short.
  const tLong = buildPullbackPos(
    rawTrend,
    closes,
    "long",
    atr,
    opts.minTrendStrength,
    opts.minPullbackATR
  );
  const rPos = buildRangeFadePos(rawRange, "long", opts.rangeEnterThr || 0.2);
  const trendOnly = Array(n).fill(0),
    rangeOnly = Array(n).fill(0),
    combined = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    trendOnly[i] = tLong[i];
    rangeOnly[i] = rPos[i];
    combined[i] = cmtReg[i] > 0 ? tLong[i] : cmtReg[i] < 0 ? 0 : rPos[i];
  }
  const oosStart = bnd[1];
  const mk = (pos) => {
    const trades = buildConsensusTradesWithSL(
      pos,
      bh,
      closes,
      atr,
      opts.slMult,
      lows,
      highs
    ).filter((t) => t.entryIdx >= oosStart);
    const sim = simulateEquityDaily(trades, closes, n, opts.riskPct);
    let cum = 0;
    const equity = [];
    for (let i = oosStart; i < n; i++) {
      cum += sim.dailyReturns[i];
      equity.push({ d: dates[i], cum: cum * 100 });
    }
    return {
      trades,
      sim,
      tradeStats: tradeStats(trades, Math.max(n - oosStart, 1)),
      winLoss: winLossStats(trades, (t) => t.priceDiff),
      equity,
    };
  };
  let cntT = 0,
    cntR = 0,
    cntTot = 0;
  for (let i = oosStart; i < n; i++) {
    cntTot++;
    if (cmtReg[i] !== 0) cntT++;
    else cntR++;
  }
  return {
    oosStart,
    oosFromDate: dates[oosStart],
    foldDiagnostics,
    cmtReg,
    trendOnly: mk(trendOnly),
    rangeOnly: mk(rangeOnly),
    combined: mk(combined),
    buyHold: buyHoldEquity(closes, dates, oosStart),
    pctTrendTime: cntTot ? (cntT / cntTot) * 100 : 0,
    pctRangeTime: cntTot ? (cntR / cntTot) * 100 : 0,
  };
}

// ============================================================
// CMT trên khung THÁNG — cổ phiếu VN nên định hướng/kịch bản/TP ở khung lớn
// hơn (ổn định, ít nhiễu, biên độ đủ rộng để TP không bị sát ngay khi vào
// lệnh) rồi mới xuống ngày để bắt điểm vào. Mỗi ngày dùng R/S/target của
// THÁNG TRƯỚC đã đóng hoàn chỉnh (không dùng tháng đang chạy — tránh nhìn
// trước dữ liệu chưa xảy ra).
function buildMonthlyCMT(closes, highs, lows, dates) {
  const n = closes.length;
  const H_ = highs || closes,
    L_ = lows || closes;
  const mo = aggMonthly(closes, dates);
  const moHL = aggMonthlyHL(H_, L_, dates);
  const nm = mo.closes.length;

  // Ngày → chỉ số tháng chứa ngày đó.
  const dayMonthIdx = Array(n).fill(0);
  let m = -1,
    curKey = null;
  for (let i = 0; i < n; i++) {
    const key = dates[i].slice(0, 7);
    if (key !== curKey) {
      m++;
      curKey = key;
    }
    dayMonthIdx[i] = m;
  }

  // Pivot tháng (xác nhận sau 1 tháng — dữ liệu tháng thưa hơn tuần nên
  // dùng độ trễ ngắn hơn để vẫn đủ điểm pivot) → R/S/hướng/target.
  const pivMo = pivots(mo.closes, 1, moHL.highs, moHL.lows);
  let pm = 0;
  const MH = [],
    ML = [];
  const monState = Array(nm).fill(null),
    monTarget = Array(nm).fill(null),
    monR = Array(nm).fill(null),
    monS = Array(nm).fill(null);
  for (let mm = 0; mm < nm; mm++) {
    while (pm < pivMo.length && pivMo[pm].i + 1 <= mm) {
      (pivMo[pm].type === "H" ? MH : ML).push(pivMo[pm]);
      pm++;
    }
    const c = mo.closes[mm];
    const overhead = MH.filter((p) => p.price > c).map((p) => p.price);
    const below = ML.filter((p) => p.price < c).map((p) => p.price);
    const m6H = moHL.highs.slice(Math.max(0, mm - 6), mm),
      m6L = moHL.lows.slice(Math.max(0, mm - 6), mm);
    if (!m6H.length) continue;
    const R = overhead.length ? Math.min(...overhead) : Math.max(...m6H);
    const S = below.length ? Math.max(...below) : Math.min(...m6L);
    const range = Math.max(R - S, 1e-9);
    monR[mm] = R;
    monS[mm] = S;
    if (c > R) {
      monState[mm] = "RUN_UP";
      monTarget[mm] = R + 0.618 * range;
    } else if (c < S) {
      monState[mm] = "RUN_DOWN";
      monTarget[mm] = null;
    } else {
      monState[mm] = "IN_RANGE";
      monTarget[mm] = R;
    }
  }

  return { dayMonthIdx, monState, monTarget, monR, monS, monDates: mo.dates, nm };
}

// ============================================================
// CMT × chỉ báo Trend TUẦN — xác nhận xu hướng còn nguyên hay không bằng
// đúng bộ 22 chỉ báo Trend (kể cả Volume) dùng ở tab Hurst, nhưng tính trên
// KHUNG TUẦN thay vì để Hurst tự dò regime Trend/Range mỗi ngày. Dùng tuần
// TRƯỚC đã đóng (nhân quả, không nhìn trước). Đồng thuận tuần quay ≤0 chỉ
// NGỪNG GOM THÊM — không tự thoát lệnh (thoát hoàn toàn do khung THÁNG quyết).
function buildWeeklyTrendGate(closes, volumes, highs, lows, dates) {
  const n = closes.length;
  const H_ = highs || closes,
    L_ = lows || closes;
  const wk = aggWeekly(closes, dates);
  const wkHL = aggWeeklyHL(H_, L_, dates);
  const wkVol = aggWeeklyVolume(volumes, dates);
  const nw = wk.closes.length;
  const { trendDefs } = buildDefs(wk.closes, wkVol, wkHL.highs, wkHL.lows);
  const weekNet = Array(nw).fill(0);
  for (let w = 0; w < nw; w++) weekNet[w] = netAtDefs(trendDefs, w);

  const dayWeekIdx = Array(n).fill(0);
  let w = -1,
    curKey = null;
  for (let i = 0; i < n; i++) {
    const dt = new Date(dates[i] + "T00:00:00Z");
    const day = (dt.getUTCDay() + 6) % 7;
    const mon = new Date(dt);
    mon.setUTCDate(dt.getUTCDate() - day);
    const key = mon.toISOString().slice(0, 10);
    if (key !== curKey) {
      w++;
      curKey = key;
    }
    dayWeekIdx[i] = w;
  }
  return { dayWeekIdx, weekNet, nw };
}
function netAtDefs(defs, i) {
  let s = 0,
    c = 0;
  for (let k = 0; k < defs.length; k++) {
    const v = defs[k][2](i);
    s += v > 0 ? 1 : v < 0 ? -1 : 0;
    c++;
  }
  return c ? s / c : 0;
}

// ============================================================
// LUẬT GIAO DỊCH CMT × TREND — dùng chung cho backtest lịch sử VÀ trạng
// thái "đang sống" hiển thị trên Bộ lọc. Hoàn toàn nhân quả (không nhìn
// trước), chỉ Long (TTCK VN không bán khống, mặc định CK VN đang trong xu
// hướng tăng dài hạn nên không còn phân biệt regime Trend/Range của Hurst):
//
//  (1) CMT xác định HƯỚNG + TP trên KHUNG THÁNG (tháng trước đã đóng):
//        · Tháng đã breakout lên: TP = R + 0.618×(R−S)
//        · Tháng đang trong biên: TP = R tháng (kháng cự)
//        · Tháng breakout xuống: KHÔNG vào lệnh, đang giữ thì thoát hết
//  (2) Xác nhận xu hướng KHUNG TUẦN bằng đúng bộ 22 chỉ báo Trend (kể cả
//      Volume) — đồng thuận tuần (tuần trước đã đóng) phải còn dương mới
//      được GOM THÊM; quay ≤0 chỉ ngừng gom, không tự thoát lệnh.
//  (3) Xuống khung NGÀY để GOM lệnh (DCA/pyramid): mỗi lần bộ chỉ báo Trend
//      ngày đang NGHIÊNG MUA (>ngưỡng) VÀ giá vừa giảm VÀ TP vẫn gấp đủ số
//      lần rủi ro cố định (R:R tối thiểu) — mua thêm, rủi ro % vốn như lần
//      đầu, không giới hạn số lần. Giá vào TRUNG BÌNH cập nhật lại sau mỗi
//      lần gom; SL cứng = giá vào trung bình × (1 − stopPct).
//      CHẠM TP: bán 50%, phần còn lại CHẠY TIẾP (ngừng gom thêm), không còn
//      TP cho phần này nữa — chỉ thoát khi dính SL cứng hoặc khung THÁNG
//      chuyển hẳn sang kịch bản giảm (hỗ trợ tháng vỡ / state RUN_DOWN).
// ============================================================
const ENTRY_CONSENSUS_THR = 0.2;

function runCMTHurstLongRule(closes, highs, lows, volumes, dates, opts) {
  const n = closes.length;
  const H_ = highs || closes,
    L_ = lows || closes;

  // (1) CMT khung THÁNG — hướng, R/S, target cho toàn bộ lịch sử một lần
  const mCMT = buildMonthlyCMT(closes, highs, lows, dates);

  // (2) Xác nhận xu hướng khung TUẦN — thay cho việc Hurst dò regime hàng ngày
  const wGate = buildWeeklyTrendGate(closes, volumes, highs, lows, dates);

  // (3) Bộ chỉ báo Trend khung NGÀY — bắt điểm gom hàng cụ thể
  const { trendDefs } = buildDefs(closes, volumes, highs, lows);

  const trades = [];
  let pos = null;
  // TP nằm ở khung tháng (có thể là một move kéo dài nhiều tháng) nên thời
  // gian giữ tối đa phải đủ rộng để mục tiêu có cơ hội chạm tới — mặc định
  // 120 phiên (~6 tháng); đặt quá ngắn sẽ khiến phần lớn lệnh bị "hết hạn
  // giữ" trước khi kịp đạt TP, kéo kết quả xuống dù R:R mỗi lệnh vẫn tốt.
  const maxHold = opts.cardMaxHold || 120;
  const stopPct = opts.stopPct || 0.1;
  const minRR = opts.minRR || 1.0;
  const start = Math.max(300, 210);

  for (let i = start; i < n; i++) {
    // (a) Quản lý vị thế đang mở — quét TP/SL bằng High/Low THẬT của phiên i
    let justExited = false;
    if (pos) {
      const hi = H_[i],
        lo = L_[i],
        c = closes[i];
      const hitSL = lo <= pos.stop;
      // Bảo vệ vốn theo khung THÁNG: nếu hỗ trợ của tháng trước đã bị giá
      // đóng cửa phá — kịch bản tháng đã đổi, thoát hết dù chưa dính SL.
      const mm = mCMT.dayMonthIdx[i] - 1;
      const mS = mm >= 0 ? mCMT.monS[mm] : null;
      const flipDown = mS != null && c < mS;
      const timeoutHit = i - pos.i0 >= maxHold;

      if (hitSL || flipDown || timeoutHit) {
        // Ưu tiên bảo toàn vốn: nếu cùng phiên vừa chạm TP vừa dính SL/vỡ
        // hỗ trợ, coi như thoát hết trước, không xét bán 50% nữa.
        const stoppedOut = hitSL || flipDown;
        const exit = hitSL ? pos.stop : c;
        trades.push({
          entryIdx: pos.i0,
          exitIdx: i,
          finalExitIdx: i,
          side: 1,
          entryPrice: pos.avgEntry,
          exitPrice: exit,
          finalExitPrice: exit,
          slDistance: pos.slDist,
          R: (exit - pos.avgEntry) / pos.slDist,
          ret: (exit - pos.avgEntry) / pos.avgEntry,
          priceDiff: exit - pos.avgEntry,
          stoppedOut,
          exitReason: hitSL ? "sl" : flipDown ? "flip" : "timeout",
          scen: pos.state,
          numAdds: pos.lots.length,
          riskWeight: pos.partialDone ? 0.5 : 1,
        });
        pos = null;
        justExited = true;
      } else if (!pos.partialDone && pos.tp != null && hi >= pos.tp) {
        // Chạm TP: bán 50%, phần còn lại chạy tiếp — không đóng lệnh hẳn.
        trades.push({
          entryIdx: pos.i0,
          exitIdx: i,
          finalExitIdx: i,
          side: 1,
          entryPrice: pos.avgEntry,
          exitPrice: pos.tp,
          finalExitPrice: pos.tp,
          slDistance: pos.slDist,
          R: (pos.tp - pos.avgEntry) / pos.slDist,
          ret: (pos.tp - pos.avgEntry) / pos.avgEntry,
          priceDiff: pos.tp - pos.avgEntry,
          stoppedOut: false,
          exitReason: "tp_partial",
          scen: pos.state,
          numAdds: pos.lots.length,
          riskWeight: 0.5,
        });
        pos.partialDone = true;
        pos.tp = null; // không còn TP cho nửa còn lại — chạy tới khi SL/tháng đảo chiều
      }
    }
    if (justExited) continue;

    // (b) Ngày quyết định j = i-1 (chỉ dùng dữ liệu đã biết)
    const j = i - 1;
    const lastC = closes[j];

    // (1) CMT khung THÁNG: hướng + target — lấy tháng TRƯỚC tháng chứa ngày j
    const mIdx = mCMT.dayMonthIdx[j] - 1;
    if (mIdx < 0) continue;
    const state = mCMT.monState[mIdx];
    const target = mCMT.monTarget[mIdx];
    if (!state || state === "RUN_DOWN" || target == null || target <= lastC) continue;

    // Đã bán 50% (đang chạy phần còn lại) thì không gom thêm nữa
    if (pos && pos.partialDone) continue;

    // (2) Xác nhận khung TUẦN: đồng thuận tuần trước phải còn dương mới gom
    const wIdx = wGate.dayWeekIdx[j] - 1;
    if (wIdx < 0) continue;
    const weeklyOK = wGate.weekNet[wIdx] > 0;
    if (!weeklyOK) continue;

    // (3) Xuống khung ngày: đồng thuận mua + giá vừa giảm → mở lệnh mới
    // hoặc GOM THÊM nếu đang giữ, miễn còn đủ R:R với TP tháng hiện tại.
    const dailyConsensus = netAtDefs(trendDefs, j);
    const pulledBack = j >= 1 && closes[j] < closes[j - 1];
    if (dailyConsensus > ENTRY_CONSENSUS_THR && pulledBack) {
      const entry = lastC;
      const rewardDist = target - entry;
      const slDistProxy = entry * stopPct;
      if (rewardDist < slDistProxy * minRR) continue; // R:R không đủ — bỏ qua lần này
      if (!pos) {
        pos = {
          i0: i,
          lots: [{ idx: i, price: entry }],
          avgEntry: entry,
          slDist: slDistProxy,
          stop: entry * (1 - stopPct),
          tp: target,
          state,
          partialDone: false,
        };
      } else {
        pos.lots.push({ idx: i, price: entry });
        pos.avgEntry = pos.lots.reduce((s, l) => s + l.price, 0) / pos.lots.length;
        pos.slDist = pos.avgEntry * stopPct;
        pos.stop = pos.avgEntry * (1 - stopPct);
        pos.tp = target; // cập nhật theo target tháng mới nhất
        pos.state = state;
      }
    }
  }

  // Trạng thái SỐNG tính tới phiên cuối cùng có dữ liệu
  let live;
  if (pos) {
    const lastC = closes[n - 1];
    live = {
      active: true,
      entryIdx: pos.i0,
      entryDate: dates[pos.i0],
      entryPrice: pos.avgEntry,
      numAdds: pos.lots.length,
      lastAddDate: dates[pos.lots[pos.lots.length - 1].idx],
      stop: pos.stop,
      tp: pos.tp,
      partialDone: pos.partialDone,
      cmtState: pos.state,
      daysHeld: n - 1 - pos.i0,
      unrealizedR: (lastC - pos.avgEntry) / pos.slDist,
      unrealizedPct: (lastC / pos.avgEntry - 1) * 100,
      openedToday: pos.i0 === n - 1,
      addedToday: pos.lots.length > 1 && pos.lots[pos.lots.length - 1].idx === n - 1,
    };
  } else {
    const lastTrade = trades[trades.length - 1];
    live = {
      active: false,
      lastExit: lastTrade
        ? {
            date: dates[lastTrade.exitIdx],
            reason: lastTrade.exitReason,
            R: lastTrade.R,
            numAdds: lastTrade.numAdds,
            exitedToday: lastTrade.exitIdx === n - 1,
          }
        : null,
    };
  }

  return { trades, live, start, warmupFromDate: dates[start] };
}

// Gói thống kê đầy đủ (tradeStats/winLoss/equity/theo đoạn/theo trạng thái
// CMT lúc vào/Buy&Hold/live) từ danh sách lệnh thô của runCMTHurstLongRule.
function summarizeRuleBacktest(engine, closes, dates, opts) {
  const { trades, live, start } = engine;
  const n = closes.length;
  const sim = simulateEquityDaily(trades, closes, n, opts.riskPct);
  let cum = 0;
  const equity = [];
  for (let i = start; i < n; i++) {
    cum += sim.dailyReturns[i];
    equity.push({ d: dates[i], cum: cum * 100 });
  }
  const folds = Math.max(2, opts.wfFolds);
  const bnd = Array.from({ length: folds + 1 }, (_, k) =>
    Math.floor(((n - start) * k) / folds) + start
  );
  const foldStats = [];
  for (let f = 0; f < folds; f++) {
    const ft = trades.filter(
      (t) => t.entryIdx >= bnd[f] && t.entryIdx < bnd[f + 1]
    );
    const wins = ft.filter((t) => t.R > 0).length;
    const totR = ft.reduce((s, t) => s + t.R, 0);
    foldStats.push({
      fold: f + 1,
      from: dates[bnd[f]],
      to: dates[Math.min(n - 1, bnd[f + 1] - 1)],
      n: ft.length,
      hit: ft.length ? Math.round((wins / ft.length) * 100) : null,
      totR: +totR.toFixed(1),
    });
  }
  const byScen = {};
  trades.forEach((t) => {
    const k = t.scen || "?";
    byScen[k] = byScen[k] || { n: 0, win: 0, R: 0 };
    byScen[k].n++;
    if (t.R > 0) byScen[k].win++;
    byScen[k].R += t.R;
  });
  return {
    trades,
    tradeStats: tradeStats(trades, Math.max(n - start, 1)),
    winLoss: winLossStats(trades, (t) => t.priceDiff),
    sim,
    equity,
    foldStats,
    byScen,
    oosStart: start,
    oosFromDate: dates[start],
    allCount: trades.length,
    buyHold: buyHoldEquity(closes, dates, start),
    live,
  };
}

function runHurstAnalysis(closes, volumes, dates, opts, direction, digits, highs, lows) {
  PRICE_UNIT = 1;
  const n = closes.length;
  const bh = Array(n).fill(0),
    rets = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    bh[i] = closes[i] / closes[i - 1] - 1;
    rets[i] = Math.log(closes[i] / closes[i - 1]);
  }
  const hurstDense = denseHurst(
    rollingHurst(rets.slice(1), opts.hurstWin, opts.hurstStep),
    n
  );
  // ATR thật (H/L/C) khi có dữ liệu; rơi về xấp xỉ close-only nếu thiếu.
  const atr =
    highs && lows
      ? atrTrue(highs, lows, closes, opts.atrPeriod)
      : closeATR(closes, opts.atrPeriod);
  const { trendDefs, rangeDefs } = buildDefs(closes, volumes, highs, lows);
  const withInverse = (defs) => [
    ...defs.map(([key, label, fn]) => ({
      key,
      label,
      fn,
      inv: false,
      trades: extractTradesRaw(fn, n, bh, closes),
    })),
    ...defs.map(([key, label, fn]) => {
      const arr = buildInversePosArray(fn, n);
      const invFn = (i) => arr[i];
      return {
        key: key + "i",
        label: label + " (đảo chiều)",
        fn: invFn,
        inv: true,
        trades: extractTradesRaw(invFn, n, bh, closes),
      };
    }),
  ];
  const plain = (defs) =>
    defs.map(([key, label, fn]) => ({
      key,
      label,
      fn,
      inv: false,
      trades: extractTradesRaw(fn, n, bh, closes),
    }));
  const tC = opts.testInverse ? withInverse(trendDefs) : plain(trendDefs);
  const rC = opts.testInverse ? withInverse(rangeDefs) : plain(rangeDefs);

  const wf = runWalkForwardOptimized(
    hurstDense,
    n,
    tC,
    rC,
    bh,
    dates,
    opts,
    direction,
    "gated"
  );
  const wfNoFilter = runWalkForwardOptimized(
    hurstDense,
    n,
    tC,
    rC,
    bh,
    dates,
    opts,
    direction,
    "always"
  );

  const floor = Math.max(30, Math.round(n * 0.02));
  const liveGated = bestCombo(
    hurstDense,
    n,
    "gated",
    tC,
    rC,
    bh,
    direction,
    n,
    floor
  );
  const liveAlways = bestCombo(
    hurstDense,
    n,
    "always",
    tC,
    rC,
    bh,
    direction,
    n,
    floor
  );
  const phase = liveGated.phaseCombo;
  const useAlways = opts.hurstFilterMode === "always";
  const activeLive = useAlways ? liveAlways : liveGated;
  const activeWf = useAlways ? wfNoFilter : wf;

  const trendResults = tC
    .map((d) =>
      summarizeTrades(d.key, d.label, d.trades, phase, "TREND", n, d.inv)
    )
    .sort(
      (a, b) =>
        (isFinite(b.sharpe) ? b.sharpe : -Infinity) -
        (isFinite(a.sharpe) ? a.sharpe : -Infinity)
    );
  const rangeResults = rC
    .map((d) =>
      summarizeTrades(d.key, d.label, d.trades, phase, "RANGE", n, d.inv)
    )
    .sort(
      (a, b) =>
        (isFinite(b.sharpe) ? b.sharpe : -Infinity) -
        (isFinite(a.sharpe) ? a.sharpe : -Infinity)
    );

  const dm = (raw) =>
    direction === "long" ? (raw > 0 ? 1 : 0) : raw < 0 ? -1 : 0;
  const lastIdx = n - 1;
  const todayPhase = phase[lastIdx];
  const livePool = useAlways
    ? activeLive.allRel
    : todayPhase === "TREND"
    ? liveGated.relTrend
    : todayPhase === "RANGE"
    ? liveGated.relRange
    : [];
  let sum = 0;
  for (const c of livePool) sum += dm(c.fn(lastIdx));
  const todayPos = livePool.length ? sum / livePool.length : 0;

  const relTrendCount = useAlways
    ? activeLive.allRel.filter((c) => c.key[0] === "t").length
    : liveGated.relTrend.length;
  const relRangeCount = useAlways
    ? activeLive.allRel.filter((c) => c.key[0] === "r").length
    : liveGated.relRange.length;

  const pullbackWF = runPullbackWalkForward(
    hurstDense,
    n,
    tC,
    rC,
    bh,
    dates,
    closes,
    atr,
    opts,
    direction,
    lows,
    highs
  );
  const trendPosLive = buildTrendConsensusSeries(
    liveGated.relTrend,
    phase,
    n,
    direction
  );
  const pbPosLive = buildPullbackPos(
    trendPosLive,
    closes,
    direction,
    atr,
    opts.minTrendStrength,
    opts.minPullbackATR
  );
  const pbTradesLive = buildConsensusTradesWithSL(
    pbPosLive,
    bh,
    closes,
    atr,
    opts.slMult,
    lows,
    highs
  );
  const pullbackEquitySimLive = simulateEquityDaily(
    pbTradesLive,
    closes,
    n,
    opts.riskPct
  );
  const pbToday = pbPosLive[lastIdx];
  let pbTodayStatus = "NONE",
    pbEntryDate = null;
  if (pbToday !== 0) {
    pbTodayStatus = "HOLDING";
    let j = lastIdx;
    while (j > 0 && pbPosLive[j - 1] === pbToday) j--;
    pbEntryDate = dates[j];
  } else {
    const t = trendPosLive[lastIdx],
      mts = opts.minTrendStrength || 0;
    pbTodayStatus = (direction === "long" ? t > mts : t < -mts)
      ? "WAIT_PULLBACK"
      : "WAIT_TREND";
  }

  const rangeFadeWF = runRangeFadeWalkForward(
    hurstDense,
    n,
    tC,
    rC,
    bh,
    dates,
    closes,
    atr,
    opts,
    "long",
    lows,
    highs
  );
  const rangeConsLive = buildRangeConsensusSeries(
    liveGated.relRange,
    phase,
    n,
    "long"
  );
  const rfPosLive = buildRangeFadePos(
    rangeConsLive,
    "long",
    opts.rangeEnterThr || 0.2
  );
  const rfTradesLive = buildConsensusTradesWithSL(
    rfPosLive,
    bh,
    closes,
    atr,
    opts.slMult,
    lows,
    highs
  );
  const rangeFadeEquitySimLive = simulateEquityDaily(
    rfTradesLive,
    closes,
    n,
    opts.riskPct
  );
  const rfToday = rfPosLive[lastIdx];
  let rfTodayStatus = "NONE",
    rfEntryDate = null;
  if (rfToday !== 0) {
    rfTodayStatus = "HOLDING";
    let j = lastIdx;
    while (j > 0 && rfPosLive[j - 1] === rfToday) j--;
    rfEntryDate = dates[j];
  } else
    rfTodayStatus = phase[lastIdx] === "RANGE" ? "WAIT_EDGE" : "WAIT_RANGE";

  let hurstNow = null;
  for (let i = lastIdx; i >= 0; i--)
    if (hurstDense[i] != null) {
      hurstNow = hurstDense[i];
      break;
    }
  const netOf = (defs) => {
    let s = 0,
      c = 0;
    for (const d of defs)
      if (!d.inv) {
        const v = d.fn(lastIdx);
        s += v > 0 ? 1 : v < 0 ? -1 : 0;
        c++;
      }
    return c ? s / c : 0;
  };
  const trendNetToday = netOf(tC);
  const rangeNetToday = netOf(rC);

  const profitViews = runProfitViewsWalkForward(
    hurstDense,
    n,
    tC,
    rC,
    bh,
    dates,
    closes,
    atr,
    opts,
    highs,
    lows
  );
  const cardBacktest = summarizeRuleBacktest(
    runCMTHurstLongRule(closes, highs, lows, volumes, dates, opts),
    closes,
    dates,
    opts
  );

  return {
    dates,
    closes,
    phase,
    trendResults,
    rangeResults,
    relTrendCount,
    relRangeCount,
    liveCombo: {
      mode: activeLive.mode,
      buffer: activeLive.buffer,
      stableWin: activeLive.stableWin,
      minTrades: activeLive.minTrades,
      sharpe: activeLive.sharpe,
    },
    activeWf,
    todayPos,
    todayPhase,
    n,
    lastDate: dates[lastIdx],
    pullbackWF,
    pullbackEquitySimLive,
    pbToday,
    pbTodayStatus,
    pbEntryDate,
    rangeFadeWF,
    rangeFadeEquitySimLive,
    rfToday,
    rfTodayStatus,
    rfEntryDate,
    hurstNow,
    trendNetToday,
    rangeNetToday,
    profitViews,
    cardBacktest,
  };
}

function quickTrendConsensusFn(closes) {
  const ma10 = sma(closes, 10),
    ma50 = sma(closes, 50);
  const e12 = ema(closes, 12),
    e26 = ema(closes, 26),
    e50 = ema(closes, 50);
  const sl20 = rollingSlope(closes, 20);
  const { macd: mc, signal: sg } = macdCalc(closes, 12, 26, 9);
  return (i) => {
    let s = 0,
      c = 0;
    const add = (v) => {
      if (v != null) {
        s += v;
        c++;
      }
    };
    add(
      ma10[i - 1] != null && ma50[i - 1] != null
        ? ma10[i - 1] > ma50[i - 1]
          ? 1
          : -1
        : null
    );
    add(e12[i - 1] > e26[i - 1] ? 1 : -1);
    add(closes[i - 1] > e50[i - 1] ? 1 : -1);
    add(sl20[i - 1] != null ? (sl20[i - 1] > 0 ? 1 : -1) : null);
    add(mc[i - 1] > sg[i - 1] ? 1 : -1);
    return c ? s / c : 0;
  };
}
function quickPullbackBacktest(closes, dir, atr, slMult, riskPct, lows, highs) {
  const n = closes.length;
  const cons = quickTrendConsensusFn(closes);
  const trendPos = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = cons(i);
    trendPos[i] = dir === "long" ? (c > 0.5 ? 1 : 0) : c < -0.5 ? -1 : 0;
  }
  const bh = Array(n).fill(0);
  for (let i = 1; i < n; i++) bh[i] = closes[i] / closes[i - 1] - 1;
  const pos = buildPullbackPos(trendPos, closes, dir, atr, 0, 0);
  const trades = buildConsensusTradesWithSL(pos, bh, closes, atr, slMult, lows, highs);
  const sim = simulateEquityDaily(trades, closes, n, riskPct);
  const st = tradeStats(trades, n);
  return {
    sharpe: isFinite(st.sharpe) ? st.sharpe : 0,
    count: st.count,
    maxDD: sim.maxDDPct,
  };
}

/* ============================================================
   5. SCREENER — XẾP HẠNG BẰNG TÍN HIỆU CMT (rổ VN30)
   ------------------------------------------------------------
   Điểm CMT (0–100), Hurst chỉ là cột tham chiếu:
     30%  Cán cân bằng chứng   |biasPct − 50| × 2
     28%  Xác suất analog cùng hướng bias
     20%  Tỷ lệ đạt T1 lịch sử của quy tắc breakout, đúng hướng bias
     14%  Khoảng cách tới trigger (sát/đã phá = cao)
      8%  Đồng thuận đa khung W & D
   ============================================================ */

function screenStock(cfg, closes, volumes, dates, opts, highs, lows) {
  const H_ = highs || closes,
    L_ = lows || closes;
  const n = closes.length;
  const last = closes[n - 1];
  const rsiArr = rsi(closes),
    mac = macd(closes);
  const ma50 = sma(closes, 50),
    ma200 = sma(closes, 200);
  const pivD = pivots(closes, 4, highs, lows);
  const wk = aggWeekly(closes, dates);
  const mo = aggMonthly(closes, dates);
  const wkHL = aggWeeklyHL(H_, L_, dates);
  const moHL = aggMonthlyHL(H_, L_, dates);
  const tD = dowTrend(pivD).trend;
  const tW = dowTrend(pivots(wk.closes, 2, wkHL.highs, wkHL.lows)).trend;
  const tM = dowTrend(pivots(mo.closes, 2, moHL.highs, moHL.lows)).trend;
  const consensus = tW === tD && tD !== "side";

  const m50 = ma50[n - 1],
    m200 = ma200[n - 1];
  const lastRSI = rsiArr[n - 1] ?? 50,
    lastM = mac[n - 1];
  const vma20 = sma(volumes, 20);
  const volRatio = vma20[n - 1] ? volumes[n - 1] / vma20[n - 1] : 1;
  const bull = [
    tW === "up",
    tD === "up",
    m50 != null && last > m50,
    m50 != null && m200 != null && m50 > m200,
    lastRSI > 50,
    lastM.hist > 0,
    volRatio >= 1.2 && last > closes[n - 2],
  ].filter(Boolean).length;
  const bear = [
    tW === "down",
    tD === "down",
    m50 != null && last < m50,
    m50 != null && m200 != null && m50 < m200,
    lastRSI < 50,
    lastM.hist < 0,
    volRatio >= 1.2 && last < closes[n - 2],
  ].filter(Boolean).length;
  const biasPct = Math.round((bull / (bull + bear || 1)) * 100);
  const bias = biasPct >= 60 ? "up" : biasPct <= 40 ? "down" : "side";

  const overhead = pivD
    .filter((p) => p.type === "H" && p.price > last)
    .map((p) => p.price);
  const below = pivD
    .filter((p) => p.type === "L" && p.price < last)
    .map((p) => p.price);
  const R = overhead.length
    ? Math.min(...overhead)
    : Math.max(...H_.slice(-40));
  const S = below.length ? Math.max(...below) : Math.min(...L_.slice(-40));
  const range = Math.max(R - S, 1e-9);

  const w40H = H_.slice(-41, -1),
    w40L = L_.slice(-41, -1);
  const R40 = Math.max(...w40H),
    S40 = Math.min(...w40L);
  let state = "IN_RANGE";
  if (last > R40) state = "RUN_UP";
  else if (last < S40) state = "RUN_DOWN";
  else if (Math.min(R - last, last - S) / range < 0.15) state = "NEAR_TRIGGER";

  const analog = analogProbabilities(closes, buildStates(closes, highs, lows));
  const rule = scanBreakoutRule(closes, highs, lows);
  const H = quickHurst(returns(closes).map((r) => Math.log(1 + r)));
  const atr =
    highs && lows
      ? atrTrue(highs, lows, closes, opts.atrPeriod)
      : closeATR(closes, opts.atrPeriod);
  const volPct = ((atr[n - 1] ?? 0) / last) * 100;
  // Kiểm tra chất lượng "mua theo hồi xu hướng" trên chính mã này — luôn
  // theo chiều LONG vì TTCK VN không bán khống, bất kể bias hiện tại là gì.
  const qb = quickPullbackBacktest(closes, "long", atr, opts.slMult, opts.riskPct, lows, highs);
  // Trạng thái lệnh "sống" theo đúng luật CMT×Hurst (đang giữ từ khi nào,
  // hay đang chờ tín hiệu) — hiển thị ngay trên Bộ lọc cho cả rổ VN30.
  const live = runCMTHurstLongRule(closes, highs, lows, volumes, dates, opts).live;

  const prob = analog
    ? bias === "up"
      ? analog.pA
      : bias === "down"
      ? analog.pB
      : analog.pC
    : 50;
  const histRate =
    bias === "up"
      ? rule.up.rate
      : bias === "down"
      ? rule.down.rate
      : Math.round(((rule.up.rate ?? 50) + (rule.down.rate ?? 50)) / 2);
  const dist =
    bias === "up"
      ? R - last
      : bias === "down"
      ? last - S
      : Math.min(R - last, last - S);
  const prox =
    state === "RUN_UP" || state === "RUN_DOWN"
      ? 100
      : Math.max(0, 100 * (1 - Math.min(1, (dist / range) * 2)));

  const evi = Math.abs(biasPct - 50) * 2;
  const score = Math.round(
    0.3 * evi +
      0.28 * (prob ?? 50) +
      0.2 * (histRate ?? 50) +
      0.14 * prox +
      0.08 * (consensus ? 100 : 50)
  );

  const row = {
    key: cfg.key,
    label: cfg.label,
    digits: cfg.digits,
    price: last,
    tM,
    tW,
    tD,
    consensus,
    bias,
    biasPct,
    R,
    S,
    range,
    state,
    analog,
    rule,
    histRate,
    H,
    volPct,
    volRatio,
    qb,
    prob,
    prox: Math.round(prox),
    score,
    distPct: (Math.abs(dist) / last) * 100,
    spark: closes.slice(-90).map((c, i) => ({ i, c })),
    live,
  };
  row.strategy = deriveStrategy(row);
  return row;
}

/* ============================================================
   BỘ SUY LUẬN CHIẾN LƯỢC — vị trí giá × xác suất 2 kịch bản cao nhất
   ============================================================ */
function deriveStrategy(row) {
  const st = deriveStrategyCore(row);
  const { R, S, range, state } = row;
  const buf = 0.12 * range;
  st.actionable = false;
  st.entryTrigger = "none";
  st.stopY = null;
  st.tp1Y = st.tps && st.tps[0] ? st.tps[0].y : null;
  st.tp2Y = st.tps && st.tps[1] ? st.tps[1].y : null;
  st.entryY = row.price;
  // TTCK VN không có bán khống — chỉ set điểm vào lệnh cho kịch bản MUA.
  if (st.side !== "long") return st;
  if (st.scen === "reject-S") {
    st.actionable = true;
    st.entryTrigger = "now";
    st.stopY = S - buf;
  } else if (st.scen === "A" && state === "RUN_UP") {
    st.actionable = true;
    st.entryTrigger = "now";
    st.stopY = R - buf;
  } else if (st.dir === "long-breakout" || st.scen === "false-B") {
    st.entryTrigger = "break";
  }
  return st;
}

function deriveStrategyCore(row) {
  const { analog, R, S, range, price, digits, state, tM, tW, tD } = row;
  const fx = (v) => v.toFixed(digits);
  const mid = (R + S) / 2;
  if (!analog)
    return {
      dir: "wait",
      conf: "thấp",
      title: "Chưa đủ dữ liệu xác suất analog",
      why: "Không đủ trạng thái lịch sử tương tự để tính A/B/C — chưa đưa lệnh.",
      entry: null,
      stop: null,
      tps: [],
      scen: null,
      side: "none",
    };
  const { pA, pB, pC, n } = analog;
  const posInRange = Math.max(0, Math.min(1, (price - S) / range));
  const nearR = state !== "RUN_UP" && state !== "RUN_DOWN" && posInRange >= 0.7;
  const nearS = state !== "RUN_UP" && state !== "RUN_DOWN" && posInRange <= 0.3;
  const ranked = [
    ["A", pA],
    ["B", pB],
    ["C", pC],
  ].sort((a, b) => b[1] - a[1]);
  const top = ranked[0][0];
  const spread = ranked[0][1] - ranked[2][1];
  const tfDown = [tM, tW, tD].filter((t) => t === "down").length;
  const tfUp = [tM, tW, tD].filter((t) => t === "up").length;
  const confOf = (aligned) =>
    n >= 40 && spread >= 25 && aligned
      ? "cao"
      : n >= 25 && spread >= 12
      ? "trung bình"
      : "thấp";

  const tpDown = (safe) =>
    safe
      ? { lbl: "Vùng cần chú ý (an toàn) = biên dưới S", y: S }
      : { lbl: "Vùng cần chú ý (mở rộng) = target B", y: S - 0.618 * range };
  const tpUp = (safe) =>
    safe
      ? { lbl: "TP1 (an toàn) = biên trên R", y: R }
      : { lbl: "TP2 (mở rộng) = target A", y: R + 0.618 * range };

  if (state === "RUN_UP") {
    if (top === "A" || pA >= 40)
      return {
        dir: "long",
        conf: confOf(tfUp >= 2),
        title: "Tiếp diễn phá lên — mua khi giá hồi (pullback)",
        why: `Giá đã đóng trên biên và A (phá lên) vẫn là kịch bản cao (${pA}%). Chờ hồi về vùng ${fx(
          R
        )} rồi mua tiếp, xác nhận bằng volume.`,
        entry: `Chờ hồi về retest ~${fx(R)} có nến từ chối giảm + volume không tăng bất thường`,
        stop: `Đóng cửa lại dưới ${fx(R)} (false break)`,
        tps: [
          { lbl: "T1 = R + 0.618×biên", y: R + 0.618 * range },
          { lbl: "T2 = R + biên (measured)", y: R + range },
        ],
        scen: "A",
        side: "long",
      };
    return {
      dir: "avoid",
      conf: "thấp",
      title: "Phá lên nhưng xác suất A thấp — tránh mua đuổi",
      why: `Giá phá lên nhưng A chỉ ${pA}% trong khi kịch bản khác cao hơn — rủi ro bull-trap. TTCK VN không bán khống nên không có lệnh cho kịch bản này; nếu đang cầm hàng, cân nhắc chốt lời khi giá còn trên ${fx(
        R
      )}, và thoát nếu đóng cửa quay lại dưới ${fx(R)}.`,
      entry: null,
      stop: `Nếu đang giữ: cân nhắc thoát khi đóng lại dưới ${fx(R)}`,
      tps: [tpDown(true), { lbl: "về giữa biên", y: mid }],
      scen: "false-A",
      side: "avoid",
    };
  }
  if (state === "RUN_DOWN") {
    if (top === "B" || pB >= 40)
      return {
        dir: "avoid",
        conf: confOf(tfDown >= 2),
        title: "Tiếp diễn phá xuống — đứng ngoài, không mua",
        why: `Giá đã đóng dưới biên và B (phá xuống) vẫn cao (${pB}%). TTCK VN không bán khống nên không có lệnh cho kịch bản này. Nếu đang cầm hàng, đây là vùng rủi ro — cân nhắc cắt lỗ hoặc chờ hồi lên retest ~${fx(
          S
        )} để thoát bớt.`,
        entry: null,
        stop: `Nếu đang giữ: cân nhắc cắt lỗ nếu chưa đóng lại trên ${fx(S)}`,
        tps: [
          { lbl: "Vùng cần chú ý T1 = S − 0.618×biên", y: S - 0.618 * range },
          { lbl: "Vùng cần chú ý T2 = S − biên (measured)", y: S - range },
        ],
        scen: "B",
        side: "avoid",
      };
    return {
      dir: "caution",
      conf: "thấp",
      title: "Phá xuống nhưng xác suất B thấp — cảnh giác bear-trap",
      why: `Giá phá xuống nhưng B chỉ ${pB}% — rủi ro bẫy giảm, dễ bật lại. Chờ đóng cửa quay lại trên ${fx(
        S
      )} mới mua — không mua khi còn dưới biên.`,
      entry: `Chỉ mua khi đóng cửa quay lại trên ${fx(S)}`,
      stop: `Dưới đáy vừa tạo`,
      tps: [tpUp(true), { lbl: "về giữa biên", y: mid }],
      scen: "false-B",
      side: "long",
    };
  }

  if (nearR) {
    if (top === "A" && pA >= 45)
      return {
        dir: "long-breakout",
        conf: confOf(tfUp >= 2),
        title: "Chờ phá lên kháng cự — mua khi break xác nhận",
        why: `Giá ở kháng cự ${fx(
          R
        )} và A (phá lên) là kịch bản cao nhất (${pA}%). Chờ đóng cửa trên R kèm volume tăng rồi mua.`,
        entry: `Mua khi đóng trên ${fx(R)} + volume > 1.3× TB20`,
        stop: `Dưới ${fx(R)} sau khi phá`,
        tps: [tpUp(true), tpUp(false)],
        scen: "A",
        side: "long",
      };
    return {
      dir: "avoid",
      conf: confOf(tfDown >= 1),
      title: "Tại kháng cự — tránh mua đuổi (không có lệnh short)",
      why: `Giá chạm kháng cự ${fx(
        R
      )}. A chỉ ${pA}% — thấp; B ${pB}% và C ${pC}% đều cao hơn, nhiều khả năng bị từ chối và quay xuống. TTCK VN không bán khống nên không mở lệnh mới ở đây — chờ giá hồi về hỗ trợ ${fx(
        S
      )} để mua, hoặc chờ break xác nhận qua ${fx(R)}.`,
      entry: null,
      stop: null,
      tps: [
        tpDown(true),
        pB >= 35 ? tpDown(false) : { lbl: "về giữa biên (C)", y: mid },
      ],
      scen: "reject-R",
      side: "avoid",
    };
  }

  if (nearS) {
    if (top === "B" && pB >= 45)
      return {
        dir: "avoid",
        conf: confOf(tfDown >= 2),
        title: "Tại hỗ trợ nhưng nghiêng thủng — chờ, chưa mua",
        why: `Giá ở hỗ trợ ${fx(
          S
        )} nhưng B (phá xuống) cao nhất (${pB}%) — rủi ro thủng hỗ trợ. Chờ giá ổn định hoặc đóng cửa giữ vững trên ${fx(
          S
        )} rồi mới mua; nếu đang giữ, đây là vùng cần theo dõi sát để cắt lỗ nếu thủng.`,
        entry: null,
        stop: `Nếu đang giữ: cắt lỗ nếu đóng cửa dưới ${fx(S)}`,
        tps: [tpDown(true), tpDown(false)],
        scen: "B",
        side: "avoid",
      };
    return {
      dir: "long",
      conf: confOf(tfUp >= 1),
      title: "Fade hỗ trợ — LONG (phá xuống xác suất thấp)",
      why: `Giá chạm hỗ trợ ${fx(
        S
      )}. B chỉ ${pB}% — thấp; A ${pA}% và C ${pC}% cao. Nhiều khả năng bật lên → LONG tại hỗ trợ.`,
      entry: `Long quanh ${fx(
        S
      )} khi có nến từ chối giảm / RSI quay lên từ <30`,
      stop: `Đóng dưới ${fx(S)} (B kích hoạt → sai kèo)`,
      tps: [
        tpUp(true),
        pA >= 35 ? tpUp(false) : { lbl: "về giữa biên (C)", y: mid },
      ],
      scen: "reject-S",
      side: "long",
    };
  }

  if (top === "C" || (pC >= pA && pC >= pB))
    return {
      dir: "wait",
      conf: "trung bình",
      title: "Giữa biên, C (đi ngang) cao — chờ giá tới mép",
      why: `Giá đang ở giữa biên và C (giữ biên ${pC}%) là kịch bản cao nhất. Đặt cảnh báo tại ${fx(
        S
      )} (để mua) và ${fx(R)} (để chốt lời nếu đang giữ / tránh mua đuổi).`,
      entry: `Đặt cảnh báo tại ${fx(R)} và ${fx(S)}`,
      stop: null,
      tps: [
        { lbl: "Biên trên R (chốt lời/tránh mua đuổi)", y: R },
        { lbl: "Biên dưới S (vùng mua)", y: S },
      ],
      scen: "C",
      side: "none",
    };
  const dirUp = top === "A";
  return {
    dir: dirUp ? "wait" : "avoid",
    conf: "trung bình",
    title: dirUp
      ? "Giữa biên — nghiêng phá lên (A), chờ điểm vào"
      : "Giữa biên — nghiêng phá xuống (B), chưa mua",
    why: dirUp
      ? `Giữa biên nhưng A trội (${pA}%). Chờ giá về hỗ trợ ${fx(
          S
        )} để mua theo A, hoặc chờ break xác nhận qua ${fx(R)}.`
      : `Giữa biên nhưng B trội (${pB}%) — nghiêng giảm. TTCK VN không bán khống nên không có lệnh cho kịch bản này; chờ giá về gần hỗ trợ ${fx(
          S
        )} và ổn định trở lại rồi mới cân nhắc mua.`,
    entry: dirUp
      ? `Chờ hồi về ${fx(S)} rồi mua, hoặc mua break trên ${fx(R)}`
      : null,
    stop: null,
    tps: dirUp ? [tpUp(true), tpUp(false)] : [tpDown(true), tpDown(false)],
    scen: dirUp ? "A" : "B",
    side: dirUp ? "long" : "avoid",
  };
}

/* ============================================================
   6. THEME & COMPONENT NỀN
   ============================================================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
:root{--ink:#0d1322;--panel:#151d31;--panel2:#1a2440;--line:#273455;
--text:#dbe4f5;--mut:#8b9ab8;--dim:#5f6f8f;--bull:#3fd6a4;--bear:#ee6a5f;--amber:#e9b44c;--blue:#6ea8ff}
*{box-sizing:border-box}body{margin:0;background:var(--ink)}
.fxapp{min-height:100vh;background:var(--ink);color:var(--text);
font-family:'Archivo',system-ui,sans-serif;font-size:14px;line-height:1.45}
.mono{font-family:'IBM Plex Mono',monospace}
.topbar{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);
flex-wrap:wrap;position:sticky;top:0;background:rgba(13,19,34,.92);backdrop-filter:blur(6px);z-index:20}
.brand{font-weight:800;letter-spacing:.06em;font-size:15px}
.brand small{display:block;font-weight:500;color:var(--dim);letter-spacing:.14em;font-size:10px;text-transform:uppercase}
select.pair{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;
padding:7px 10px;font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600}
.tabs{display:flex;gap:6px;padding:10px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tab{background:transparent;border:1px solid var(--line);color:var(--mut);border-radius:10px;
padding:8px 15px;font:inherit;font-weight:700;font-size:13px;cursor:pointer}
.tab.on{background:var(--panel2);color:var(--blue);border-color:rgba(110,168,255,.45)}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
font-size:11.5px;font-weight:600;letter-spacing:.03em;border:1px solid var(--line)}
.chip.up{color:var(--bull);border-color:rgba(63,214,164,.4);background:rgba(63,214,164,.08)}
.chip.down{color:var(--bear);border-color:rgba(238,106,95,.4);background:rgba(238,106,95,.08)}
.chip.side{color:var(--amber);border-color:rgba(233,180,76,.4);background:rgba(233,180,76,.08)}
.chip.mut{color:var(--mut)}
.layout{display:flex;align-items:flex-start}
.rail{width:238px;flex:none;padding:16px 12px;border-right:1px solid var(--line);
position:sticky;top:57px;max-height:calc(100vh - 57px);overflow:auto}
.railhead{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);padding:0 6px 10px}
.step{display:flex;gap:10px;width:100%;text-align:left;background:none;border:none;color:var(--text);
cursor:pointer;padding:10px 8px;border-radius:10px;font:inherit}
.step:hover{background:var(--panel)}.step.on{background:var(--panel2);outline:1px solid var(--line)}
.stepline{display:flex;flex-direction:column;align-items:center;flex:none}
.dot{width:11px;height:11px;border-radius:50%;border:2px solid var(--dim);margin-top:3px;flex:none}
.dot.up{border-color:var(--bull);background:rgba(63,214,164,.35)}
.dot.down{border-color:var(--bear);background:rgba(238,106,95,.35)}
.dot.side{border-color:var(--amber);background:rgba(233,180,76,.3)}
.vline{width:2px;flex:1;min-height:22px;background:var(--line);margin-top:2px}
.steptitle{font-weight:700;font-size:13px}.stepsub{color:var(--mut);font-size:11px;margin-top:2px}
.confl{margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.confl b{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
.main{flex:1;min-width:0;padding:18px;display:flex;flex-direction:column;gap:16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.panel h3{margin:0 0 4px;font-size:15px;font-weight:700}
.panel h3 .mod{color:var(--dim);font-size:10px;letter-spacing:.16em;text-transform:uppercase;display:block;margin-bottom:3px}
.sub{color:var(--mut);font-size:12.5px;margin:0 0 12px}
.warn{display:flex;gap:8px;align-items:flex-start;background:rgba(233,180,76,.08);
border:1px solid rgba(233,180,76,.35);border-radius:10px;padding:9px 11px;font-size:12px;color:var(--amber);margin:10px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
table.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;color:var(--dim);font-weight:600;font-size:10.5px;letter-spacing:.1em;
text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:7px 8px;border-bottom:1px solid rgba(39,52,85,.5)}
.tbl tr.hot{background:rgba(110,168,255,.06)}
.num{font-family:'IBM Plex Mono',monospace;font-size:12px}
.bt{background:var(--panel2);border:1px solid var(--line);color:var(--blue);border-radius:8px;
padding:6px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.bt:hover{border-color:var(--blue)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:12.5px;
border-bottom:1px dashed rgba(39,52,85,.6)}
.kv span:first-child{color:var(--mut)}
.scen{border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px;background:var(--panel2)}
.prob{font-family:'IBM Plex Mono',monospace;font-weight:600;color:var(--blue)}
.rule{font-size:12px;display:flex;gap:7px;align-items:center;padding:2px 0}
.ok{color:var(--bull)}.no{color:var(--bear)}
input.inp{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;
padding:7px 9px;font-family:'IBM Plex Mono',monospace;font-size:13px;width:100%}
label.lb{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 4px}
.foot{padding:14px 18px;color:var(--dim);font-size:11.5px}
.loading{display:flex;flex-direction:column;align-items:center;gap:14px;padding:80px 20px;color:var(--mut)}
.spin{width:28px;height:28px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--blue);
animation:sp 0.9s linear infinite}
.scorebar{height:5px;border-radius:3px;background:var(--line);overflow:hidden;min-width:52px}
.scorebar i{display:block;height:100%;background:linear-gradient(90deg,#6ea8ff,#3fd6a4)}
@keyframes sp{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spin{animation-duration:2.5s}}
@media(max-width:900px){.layout{flex-direction:column}
.rail{width:100%;position:static;max-height:none;display:flex;gap:4px;overflow-x:auto;
border-right:none;border-bottom:1px solid var(--line);padding:10px}
.railhead,.vline,.confl{display:none}.step{flex:none;width:auto;padding:8px 10px}
.stepsub{display:none}.grid2,.grid3{grid-template-columns:1fr}}
`;

const TT = {
  background: "#1a2440",
  border: "1px solid #273455",
  borderRadius: 8,
  fontSize: 12,
};
const CLR = {
  bull: "#3fd6a4",
  bear: "#ee6a5f",
  amber: "#e9b44c",
  blue: "#6ea8ff",
  mut: "#8b9ab8",
  dim: "#5f6f8f",
  line: "#273455",
  text: "#dbe4f5",
};

const Chip = ({ cls, children, style }) => (
  <span className={`chip ${cls}`} style={style}>{children}</span>
);
const Warn = ({ children }) => (
  <div className="warn">
    <span>⚠</span>
    <span>{children}</span>
  </div>
);
const Panel = ({ mod, title, sub, children }) => (
  <section className="panel">
    <h3>
      <span className="mod">{mod}</span>
      {title}
    </h3>
    {sub && <p className="sub">{sub}</p>}
    {children}
  </section>
);
const fmtMoney = (v) =>
  v == null || !isFinite(v)
    ? "—"
    : v.toLocaleString("vi-VN", { maximumFractionDigits: 0 }) + " ₫";
const fmtVol = (v) =>
  v == null || !isFinite(v) ? "—" : v.toLocaleString("vi-VN");
const priceTxt = (v) =>
  v == null || !isFinite(v)
    ? "—"
    : (v >= 0 ? "+" : "") + v.toLocaleString("vi-VN", { maximumFractionDigits: 0 }) + " đ";

function VolumeMiniChart({ dates, volumes, closes, height = 60 }) {
  const vma20 = sma(volumes, 20);
  const data = volumes.map((v, i) => ({
    d: dates[i],
    v,
    up: i > 0 ? closes[i] >= closes[i - 1] : true,
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <Bar dataKey="v" isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.up ? CLR.bull : CLR.bear} fillOpacity={0.55} />
          ))}
        </Bar>
        <YAxis hide domain={[0, "auto"]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function PriceChart({
  dates,
  closes,
  highs,
  lows,
  digits,
  height = 300,
  dots = null,
  refLines = null,
}) {
  const data = closes.map((c, i) => ({
    i,
    d: dates[i],
    c,
    range: highs && lows ? [lows[i], highs[i]] : undefined,
  }));
  const fmt = (v) => Number(v).toLocaleString("vi-VN", { maximumFractionDigits: digits });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={data}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          stroke={CLR.line}
          strokeDasharray="2 4"
          vertical={false}
        />
        <XAxis
          dataKey="d"
          tick={{ fill: CLR.dim, fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: CLR.line }}
          minTickGap={50}
          tickFormatter={(d) => (d ? d.slice(5) : "")}
        />
        <YAxis
          domain={["auto", "auto"]}
          tick={{ fill: CLR.dim, fontSize: 10, fontFamily: "IBM Plex Mono" }}
          tickFormatter={fmt}
          width={64}
          tickLine={false}
          axisLine={false}
          orientation="right"
        />
        <Tooltip
          contentStyle={TT}
          labelStyle={{ color: CLR.mut }}
          formatter={(v, name) =>
            name === "range"
              ? [`${fmt(v[0])} – ${fmt(v[1])}`, "Low–High"]
              : [fmt(v), "Đóng cửa"]
          }
        />
        {highs && lows && (
          <Area
            dataKey="range"
            stroke="none"
            fill={CLR.mut}
            fillOpacity={0.12}
            isAnimationActive={false}
          />
        )}
        <Line
          dataKey="c"
          stroke={CLR.blue}
          dot={false}
          strokeWidth={1.7}
          isAnimationActive={false}
        />
        {refLines}
        {dots}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ============================================================
   7. TRANG BỘ LỌC (Screener VN30)
   ============================================================ */

const STATE_LABEL = {
  RUN_UP: { t: "Đang chạy ↑", c: "up" },
  RUN_DOWN: { t: "Đang chạy ↓", c: "down" },
  NEAR_TRIGGER: { t: "Sát trigger", c: "side" },
  IN_RANGE: { t: "Trong biên", c: "mut" },
};
const DIR_META = {
  long: { t: "LONG", c: CLR.bull },
  "long-breakout": { t: "LONG (chờ break)", c: CLR.bull },
  avoid: { t: "TRÁNH MUA", c: CLR.bear },
  caution: { t: "CẢNH GIÁC", c: CLR.amber },
  wait: { t: "CHỜ", c: CLR.mut },
};

function StrategyMiniChart({ row }) {
  const { R, S, range, price, digits, analog, spark } = row;
  const hist = (spark || []).slice(-45).map((p, i) => ({ x: i, c: p.c }));
  const base = hist.length;
  const F = 16,
    mid = (R + S) / 2;
  const scen = { A: analog?.pA ?? 0, B: analog?.pB ?? 0, C: analog?.pC ?? 0 };
  const top2 = Object.entries(scen)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map((e) => e[0]);
  const wpsFor = (k) => {
    if (k === "A")
      return [
        [0, price],
        [4, R],
        [9, R + 0.618 * range],
        [F, R + range],
      ];
    if (k === "B")
      return [
        [0, price],
        [4, S],
        [9, S - 0.618 * range],
        [F, S - range],
      ];
    const nearTop = price > mid;
    return [
      [0, price],
      [5, mid],
      [10, nearTop ? S + 0.15 * range : R - 0.15 * range],
      [F, mid],
    ];
  };
  const interp = (wps, t) => {
    for (let w = 1; w < wps.length; w++) {
      const [t0, v0] = wps[w - 1],
        [t1, v1] = wps[w];
      if (t <= t1) return v0 + (v1 - v0) * ((t - t0) / (t1 - t0 || 1));
    }
    return wps[wps.length - 1][1];
  };
  const data = hist.map((h) => ({ ...h }));
  const wA = wpsFor(top2[0]),
    wB = wpsFor(top2[1]);
  data[base - 1] = { ...data[base - 1], s0: price, s1: price };
  for (let t = 1; t <= F; t++)
    data.push({ x: base - 1 + t, s0: interp(wA, t), s1: interp(wB, t) });
  const colOf = (k) =>
    k === "A" ? CLR.bull : k === "B" ? CLR.bear : CLR.amber;
  const nameOf = (k) =>
    k === "A" ? "A · phá lên" : k === "B" ? "B · phá xuống" : "C · giữ biên";
  const fx = (v) => Number(v).toLocaleString("vi-VN", { maximumFractionDigits: digits });
  const allY = [...hist.map((h) => h.c), R, S, R + range, S - range].filter(
    (v) => isFinite(v)
  );
  const yMin = Math.min(...allY) - range * 0.1,
    yMax = Math.max(...allY) + range * 0.1;
  return (
    <div>
      <div style={{ width: "100%", height: 190 }}>
        <ResponsiveContainer>
          <ComposedChart
            data={data}
            margin={{ top: 6, right: 10, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              stroke={CLR.line}
              strokeDasharray="2 4"
              vertical={false}
            />
            <XAxis dataKey="x" type="number" domain={[0, base - 1 + F]} hide />
            <YAxis
              domain={[yMin, yMax]}
              tick={{ fill: CLR.dim, fontSize: 9, fontFamily: "IBM Plex Mono" }}
              tickFormatter={fx}
              width={58}
              tickLine={false}
              axisLine={false}
              orientation="right"
            />
            <Tooltip
              contentStyle={TT}
              formatter={(v, nm) => [
                fx(v),
                nm === "c"
                  ? "Giá"
                  : nm === "s0"
                  ? nameOf(top2[0])
                  : nameOf(top2[1]),
              ]}
              labelFormatter={() => ""}
            />
            <ReferenceLine
              y={R}
              stroke={CLR.bear}
              strokeDasharray="4 3"
              label={{
                value: `R ${fx(R)}`,
                fill: CLR.bear,
                fontSize: 9,
                position: "insideTopLeft",
              }}
            />
            <ReferenceLine
              y={S}
              stroke={CLR.bull}
              strokeDasharray="4 3"
              label={{
                value: `S ${fx(S)}`,
                fill: CLR.bull,
                fontSize: 9,
                position: "insideBottomLeft",
              }}
            />
            <ReferenceLine
              x={base - 1}
              stroke={CLR.line}
              label={{
                value: "nay",
                fill: CLR.dim,
                fontSize: 9,
                position: "insideTop",
              }}
            />
            <Line
              dataKey="c"
              stroke={CLR.blue}
              dot={false}
              strokeWidth={1.7}
              isAnimationActive={false}
            />
            <Line
              dataKey="s0"
              stroke={colOf(top2[0])}
              dot={false}
              strokeWidth={2.2}
              strokeDasharray="7 4"
              isAnimationActive={false}
              connectNulls
            />
            <Line
              dataKey="s1"
              stroke={colOf(top2[1])}
              dot={false}
              strokeWidth={1.6}
              strokeDasharray="3 5"
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "center",
          fontSize: 11,
          marginTop: 2,
        }}
      >
        <span style={{ color: colOf(top2[0]) }}>
          ━ {nameOf(top2[0])} ({scen[top2[0]]}%)
        </span>
        <span style={{ color: colOf(top2[1]) }}>
          ┄ {nameOf(top2[1])} ({scen[top2[1]]}%)
        </span>
      </div>
    </div>
  );
}

function StrategyModal({ row, onClose, onOpenCMT }) {
  const s = row.strategy;
  const fx = (v) => (v == null ? "—" : v.toLocaleString("vi-VN", { maximumFractionDigits: row.digits }));
  const a = row.analog;
  const posPct = Math.max(
    0,
    Math.min(100, ((row.price - row.S) / (row.range || 1e-9)) * 100)
  );
  const dm = DIR_META[s.dir] || DIR_META.wait;
  const scenBar = (label, val, color) => (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11.5,
          marginBottom: 2,
        }}
      >
        <span style={{ color: CLR.mut }}>{label}</span>
        <span className="num" style={{ color }}>
          {val}%
        </span>
      </div>
      <div
        style={{
          height: 6,
          background: CLR.line,
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${val}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(6,10,20,.72)",
        backdropFilter: "blur(3px)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        overflow: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#151d31",
          border: `1px solid ${CLR.line}`,
          borderRadius: 16,
          maxWidth: 560,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${CLR.line}`,
          }}
        >
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>
              {row.label}{" "}
              <span
                className="num"
                style={{ color: CLR.mut, fontWeight: 500, fontSize: 13 }}
              >
                {fx(row.price)}
              </span>
            </div>
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: CLR.dim,
              }}
            >
              Thẻ chiến lược nhanh
            </div>
          </div>
          <button className="bt" onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: CLR.mut,
                marginBottom: 4,
              }}
            >
              <span>Hỗ trợ S {fx(row.S)}</span>
              <span>Vị trí giá trong biên</span>
              <span>Kháng cự R {fx(row.R)}</span>
            </div>
            <div
              style={{
                position: "relative",
                height: 10,
                background:
                  "linear-gradient(90deg,rgba(63,214,164,.25),rgba(233,180,76,.15),rgba(238,106,95,.25))",
                borderRadius: 5,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: `calc(${posPct}% - 6px)`,
                  top: -3,
                  width: 12,
                  height: 16,
                  background: CLR.text,
                  borderRadius: 3,
                  border: "2px solid #151d31",
                }}
              />
            </div>
            <div
              style={{
                textAlign: "center",
                fontSize: 11,
                color: CLR.mut,
                marginTop: 4,
              }}
            >
              {Math.round(posPct)}% từ S → R ·{" "}
              <Chip cls={STATE_LABEL[row.state].c}>
                {STATE_LABEL[row.state].t}
              </Chip>{" "}
              · Volume {row.volRatio.toFixed(1)}× TB20
            </div>
          </div>

          <div
            style={{
              background: "#1a2440",
              border: `1px solid ${CLR.line}`,
              borderRadius: 12,
              padding: "10px 12px 6px",
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 11, color: CLR.mut, marginBottom: 4 }}>
              Hướng đi 2 kịch bản xác suất cao nhất (minh hoạ)
            </div>
            <StrategyMiniChart row={row} />
          </div>

          <div
            style={{
              background: "#1a2440",
              border: `1px solid ${CLR.line}`,
              borderRadius: 12,
              padding: 12,
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 11, color: CLR.mut, marginBottom: 8 }}>
              Xác suất 3 kịch bản (analog lịch sử{a ? `, n=${a.n}` : ""})
            </div>
            {a ? (
              <>
                {scenBar("A · Phá lên trên R", a.pA, CLR.bull)}
                {scenBar("B · Thủng xuống dưới S", a.pB, CLR.bear)}
                {scenBar("C · Giữ trong biên", a.pC, CLR.amber)}
              </>
            ) : (
              <div className="sub">Chưa đủ dữ liệu analog.</div>
            )}
          </div>

          <div
            style={{
              border: `1px solid ${dm.c}44`,
              background: `${dm.c}0f`,
              borderRadius: 12,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 8,
              }}
            >
              <span style={{ fontWeight: 800, fontSize: 15, color: dm.c }}>
                {dm.t}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{s.title}</span>
              <span
                style={{ marginLeft: "auto", fontSize: 11, color: CLR.mut }}
              >
                Độ tin:{" "}
                <b
                  style={{
                    color:
                      s.conf === "cao"
                        ? CLR.bull
                        : s.conf === "trung bình"
                        ? CLR.amber
                        : CLR.mut,
                  }}
                >
                  {s.conf}
                </b>
              </span>
            </div>
            <p
              style={{
                margin: "0 0 10px",
                fontSize: 13,
                lineHeight: 1.55,
                color: "#c9d3e6",
              }}
            >
              {s.why}
            </p>
            <div style={{ display: "grid", gap: 6 }}>
              {s.entry && (
                <div className="kv" style={{ border: "none", padding: "3px 0" }}>
                  <span>Điểm vào</span>
                  <span style={{ textAlign: "right", maxWidth: "62%" }}>
                    {s.entry}
                  </span>
                </div>
              )}
              {s.stop && (
                <div className="kv" style={{ border: "none", padding: "3px 0" }}>
                  <span>Dừng lỗ / vô hiệu</span>
                  <span
                    style={{
                      textAlign: "right",
                      maxWidth: "62%",
                      color: CLR.amber,
                    }}
                  >
                    {s.stop}
                  </span>
                </div>
              )}
              {s.tps &&
                s.tps.map((tp, i) => (
                  <div
                    key={i}
                    className="kv"
                    style={{ border: "none", padding: "3px 0" }}
                  >
                    <span>
                      {tp.lbl.includes("=")
                        ? tp.lbl.split("=")[0].trim()
                        : "Mục tiêu"}
                    </span>
                    <span
                      className="num"
                      style={{ color: i === 0 ? CLR.bull : CLR.blue }}
                    >
                      {tp.y != null ? fx(tp.y) : ""}{" "}
                      {tp.lbl.includes("=")
                        ? `(${tp.lbl.split("=")[1].trim()})`
                        : tp.lbl}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          <div
            style={{
              fontSize: 11,
              color: CLR.dim,
              marginBottom: 14,
              lineHeight: 1.5,
            }}
          >
            Đa khung: M {trendVN[row.tM]?.toLowerCase()} · W{" "}
            {trendVN[row.tW]?.toLowerCase()} · D{" "}
            {trendVN[row.tD]?.toLowerCase()}. Gợi ý dựa trên vị trí giá + xác
            suất lịch sử + volume, KHÔNG phải khuyến nghị đầu tư.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="bt"
              style={{
                borderColor: CLR.blue,
                color: CLR.text,
                fontWeight: 700,
              }}
              onClick={onOpenCMT}
            >
              Mở phân tích CMT đầy đủ →
            </button>
            <button className="bt" onClick={onClose}>
              Đóng
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveDeskPanel({ rows, openStock }) {
  const holding = rows
    .filter((r) => r.live && r.live.active)
    .sort((a, b) => new Date(b.live.entryDate) - new Date(a.live.entryDate));
  const openedToday = holding.filter((r) => r.live.openedToday);
  const closedToday = rows.filter(
    (r) => r.live && !r.live.active && r.live.lastExit && r.live.lastExit.exitedToday
  );
  const reasonVN = { tp: "chạm TP", tp_partial: "chạm TP (bán 50%)", sl: "dính SL", flip: "CMT cảnh báo giảm", timeout: "hết hạn giữ" };
  const stateVN = { RUN_UP: "breakout tháng", IN_RANGE: "trong biên tháng" };
  const fmtPct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  return (
    <Panel
      mod="Bàn lệnh · Luật CMT × Trend"
      title={`Đang giữ ${holding.length} mã${
        openedToday.length ? ` · mở mới hôm nay ${openedToday.length}` : ""
      }${closedToday.length ? ` · đóng hôm nay ${closedToday.length}` : ""}`}
      sub="Luật: (1) CMT xác định hướng + TP trên KHUNG THÁNG (dùng tháng trước đã đóng) · (2) Xác nhận xu hướng khung TUẦN bằng bộ chỉ báo Trend, đảo chiều thì ngừng gom (không tự thoát) · (3) xuống khung ngày GOM lệnh khi bộ chỉ báo đồng thuận mua + giá vừa giảm + còn đủ R:R (không giới hạn số lần). Chạm TP: bán 50%, phần còn lại chạy tiếp; thoát hết khi dính SL cứng hoặc khung THÁNG chuyển kịch bản giảm. Chỉ Long."
    >
      {holding.length === 0 ? (
        <p className="sub">
          Hiện không có mã VN30 nào đang mở lệnh theo luật này — tất cả đang
          chờ tín hiệu.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Mã</th>
                <th>Vào lần đầu</th>
                <th>Số lần gom</th>
                <th>Số phiên giữ</th>
                <th>Giá vào TB</th>
                <th>SL</th>
                <th>TP</th>
                <th>Lãi/lỗ tạm tính</th>
                <th>Bối cảnh</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {holding.map((r) => (
                <tr key={r.key} className={r.live.openedToday || r.live.addedToday ? "hot" : undefined}>
                  <td style={{ fontWeight: 800 }}>{r.label}</td>
                  <td className="num">
                    {r.live.entryDate}
                    {r.live.openedToday && (
                      <Chip cls="up" style={{ marginLeft: 6 }}>
                        MỞ HÔM NAY
                      </Chip>
                    )}
                  </td>
                  <td className="num">
                    {r.live.numAdds}
                    {r.live.addedToday && (
                      <Chip cls="up" style={{ marginLeft: 6 }}>
                        GOM THÊM HÔM NAY
                      </Chip>
                    )}
                  </td>
                  <td className="num">{r.live.daysHeld}</td>
                  <td className="num">{r.live.entryPrice.toLocaleString("vi-VN")}</td>
                  <td className="num" style={{ color: CLR.bear }}>
                    {r.live.stop.toLocaleString("vi-VN")}
                  </td>
                  <td className="num" style={{ color: CLR.bull }}>
                    {r.live.tp != null ? r.live.tp.toLocaleString("vi-VN") : "đã bán 50% — chạy tiếp"}
                  </td>
                  <td
                    className="num"
                    style={{
                      fontWeight: 700,
                      color: r.live.unrealizedPct >= 0 ? CLR.bull : CLR.bear,
                    }}
                  >
                    {fmtPct(r.live.unrealizedPct)} ({r.live.unrealizedR.toFixed(2)}R)
                  </td>
                  <td style={{ color: CLR.mut, fontSize: 12 }}>
                    {stateVN[r.live.cmtState] || r.live.cmtState}
                    {r.live.partialDone && " · đã bán 50%, đang chạy tiếp"}
                  </td>
                  <td>
                    <button className="bt" onClick={() => openStock(r.key)}>
                      Xem →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closedToday.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="sub" style={{ marginBottom: 6 }}>
            Đóng lệnh hôm nay
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {closedToday.map((r) => (
              <Chip key={r.key} cls={r.live.lastExit.R >= 0 ? "up" : "down"}>
                {r.label}: {reasonVN[r.live.lastExit.reason] || r.live.lastExit.reason} (
                {r.live.lastExit.R >= 0 ? "+" : ""}
                {r.live.lastExit.R.toFixed(2)}R, gom {r.live.lastExit.numAdds} lần)
              </Chip>
            ))}
          </div>
        </div>
      )}
      <p className="sub" style={{ marginTop: 10, fontSize: 11 }}>
        Tính bằng phiên bản nhanh (không dò walk-forward) của luật để chạy
        được cho cả 30 mã — xem tab Hurst của từng mã để có bản backtest đầy
        đủ (equity, so với Mua & Giữ, xếp hạng chỉ báo).
      </p>
    </Panel>
  );
}

function ScreenerSection({ rows, openStock }) {
  const [sortKey, setSortKey] = useState("score");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [stratRow, setStratRow] = useState(null);
  const view = useMemo(() => {
    let r = [...rows];
    if (onlyRunning)
      r = r.filter(
        (x) =>
          x.state === "RUN_UP" ||
          x.state === "RUN_DOWN" ||
          x.state === "NEAR_TRIGGER"
      );
    const get = {
      score: (x) => x.score,
      prob: (x) => x.prob ?? 0,
      evi: (x) => Math.abs(x.biasPct - 50),
      hist: (x) => x.histRate ?? 0,
      vol: (x) => x.volRatio,
    };
    return r.sort((a, b) => get[sortKey](b) - get[sortKey](a));
  }, [rows, sortKey, onlyRunning]);
  const top = view[0];
  const dirT = (b) =>
    b === "up" ? "Tăng" : b === "down" ? "Giảm" : "Đi ngang";

  return (
    <>
      <LiveDeskPanel rows={rows} openStock={openStock} />
      <Panel
        mod="Bộ lọc · Tín hiệu CMT"
        title="Mã VN30 nào xác suất cao và đang chạy?"
        sub="Xếp hạng 30 mã VN30 bằng ĐIỂM CMT: 30% cán cân bằng chứng (kể cả volume) · 28% xác suất analog lịch sử cùng hướng · 20% tỷ lệ đạt T1 của quy tắc breakout · 14% khoảng cách tới trigger · 8% đồng thuận tuần/ngày. Cột Hurst chỉ để tham chiếu, không tính điểm."
      >
        {top && (
          <div className="grid3" style={{ marginBottom: 12 }}>
            <div className="scen" style={{ margin: 0 }}>
              <b>Đứng đầu: {top.label}</b>
              <div className="kv">
                <span>Điểm CMT</span>
                <span className="num">{top.score}/100</span>
              </div>
              <div className="kv">
                <span>Hướng bằng chứng</span>
                <span className="num">
                  {dirT(top.bias)} ({top.biasPct}%)
                </span>
              </div>
              <div className="kv" style={{ border: "none" }}>
                <span>Trạng thái</span>
                <span>
                  <Chip cls={STATE_LABEL[top.state].c}>
                    {STATE_LABEL[top.state].t}
                  </Chip>
                </span>
              </div>
            </div>
            <div className="scen" style={{ margin: 0 }}>
              <b>Xác suất analog (20 phiên tới)</b>
              {top.analog ? (
                <>
                  <div className="kv">
                    <span>Phá lên biên trước</span>
                    <span className="num" style={{ color: CLR.bull }}>
                      {top.analog.pA}%
                    </span>
                  </div>
                  <div className="kv">
                    <span>Thủng biên trước</span>
                    <span className="num" style={{ color: CLR.bear }}>
                      {top.analog.pB}%
                    </span>
                  </div>
                  <div className="kv" style={{ border: "none" }}>
                    <span>Vẫn kẹt trong biên</span>
                    <span className="num" style={{ color: CLR.amber }}>
                      {top.analog.pC}% (n={top.analog.n})
                    </span>
                  </div>
                </>
              ) : (
                <p className="sub" style={{ margin: "6px 0 0" }}>
                  Chưa đủ trạng thái tương tự trong lịch sử.
                </p>
              )}
            </div>
            <div className="scen" style={{ margin: 0 }}>
              <b>Sắp xếp & lọc</b>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  margin: "8px 0",
                }}
              >
                {[
                  ["score", "Điểm CMT"],
                  ["prob", "Xác suất"],
                  ["evi", "Bằng chứng"],
                  ["hist", "Lịch sử"],
                  ["vol", "Volume mạnh"],
                ].map(([k, t]) => (
                  <button
                    key={k}
                    className="bt"
                    onClick={() => setSortKey(k)}
                    style={
                      sortKey === k
                        ? { borderColor: CLR.blue, color: CLR.text }
                        : {}
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
              <button
                className="bt"
                onClick={() => setOnlyRunning(!onlyRunning)}
                style={
                  onlyRunning ? { borderColor: CLR.bull, color: CLR.text } : {}
                }
              >
                {onlyRunning
                  ? "Đang chỉ hiện mã đang chạy"
                  : "Chỉ hiện mã đang chạy / sát trigger"}
              </button>
            </div>
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 1080 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Mã</th>
                <th>Lệnh (luật CMT×Hurst)</th>
                <th>90 phiên</th>
                <th>Trạng thái</th>
                <th>Bằng chứng</th>
                <th>W / D</th>
                <th>Analog A·B·C</th>
                <th>Lịch sử đạt T1</th>
                <th>Tới trigger</th>
                <th>Volume/TB20</th>
                <th>Hurst</th>
                <th>Điểm CMT</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.map((r, i) => (
                <tr key={r.key} className={i < 3 ? "hot" : undefined}>
                  <td
                    className="num"
                    style={{
                      color: i < 3 ? CLR.blue : CLR.dim,
                      fontWeight: 800,
                    }}
                  >
                    {i + 1}
                  </td>
                  <td style={{ fontWeight: 800 }}>
                    <button
                      onClick={() => setStratRow(r)}
                      style={{
                        background: "none",
                        border: "none",
                        color: CLR.text,
                        font: "inherit",
                        fontWeight: 800,
                        cursor: "pointer",
                        padding: 0,
                        textDecoration: "underline",
                        textDecorationColor: CLR.line,
                        textUnderlineOffset: 3,
                      }}
                      title="Xem chiến lược"
                    >
                      {r.label}
                    </button>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.live && r.live.active ? (
                      <span style={{ color: CLR.bull, fontWeight: 700 }}>
                        Đang giữ từ {r.live.entryDate}
                        {r.live.openedToday ? " · MỚI" : ` (${r.live.daysHeld}p, gom ${r.live.numAdds}x)`}
                      </span>
                    ) : r.live && r.live.lastExit && r.live.lastExit.exitedToday ? (
                      <span style={{ color: CLR.amber, fontWeight: 700 }}>
                        Vừa đóng hôm nay
                      </span>
                    ) : (
                      <span style={{ color: CLR.dim }}>Chờ tín hiệu</span>
                    )}
                  </td>
                  <td style={{ padding: "2px 8px" }}>
                    <div style={{ width: 96, height: 28 }}>
                      <ResponsiveContainer>
                        <LineChart
                          data={r.spark}
                          margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
                        >
                          <Line
                            dataKey="c"
                            stroke={
                              r.bias === "down"
                                ? CLR.bear
                                : r.bias === "up"
                                ? CLR.bull
                                : CLR.amber
                            }
                            dot={false}
                            strokeWidth={1.2}
                            isAnimationActive={false}
                          />
                          <YAxis hide domain={["auto", "auto"]} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </td>
                  <td>
                    <Chip cls={STATE_LABEL[r.state].c}>
                      {STATE_LABEL[r.state].t}
                    </Chip>
                  </td>
                  <td
                    className="num"
                    style={{
                      color:
                        r.bias === "up"
                          ? CLR.bull
                          : r.bias === "down"
                          ? CLR.bear
                          : CLR.amber,
                      fontWeight: 700,
                    }}
                  >
                    {dirT(r.bias)} {r.biasPct}%
                  </td>
                  <td
                    className="num"
                    style={{ color: r.consensus ? CLR.text : CLR.dim }}
                  >
                    {trendVN[r.tW][0]}/{trendVN[r.tD][0]}
                    {r.consensus ? " ✓" : ""}
                  </td>
                  <td className="num">
                    {r.analog ? (
                      <>
                        <span style={{ color: CLR.bull }}>{r.analog.pA}</span>·
                        <span style={{ color: CLR.bear }}>{r.analog.pB}</span>·
                        <span style={{ color: CLR.amber }}>{r.analog.pC}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">
                    {r.histRate != null ? `${r.histRate}%` : "—"}
                  </td>
                  <td className="num">
                    {r.state.startsWith("RUN")
                      ? "đã phá"
                      : `${r.distPct.toFixed(2)}%`}
                  </td>
                  <td
                    className="num"
                    style={{ color: r.volRatio >= 1.3 ? CLR.blue : CLR.text }}
                  >
                    {r.volRatio.toFixed(1)}×
                  </td>
                  <td
                    className="num"
                    style={{
                      color:
                        r.H == null
                          ? CLR.dim
                          : r.H > 0.5
                          ? CLR.bull
                          : CLR.amber,
                    }}
                  >
                    {r.H != null ? r.H.toFixed(2) : "—"}
                  </td>
                  <td>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 7 }}
                    >
                      <span
                        className="num"
                        style={{
                          fontWeight: 800,
                          color: i < 3 ? CLR.blue : CLR.text,
                        }}
                      >
                        {r.score}
                      </span>
                      <div className="scorebar">
                        <i style={{ width: `${r.score}%` }} />
                      </div>
                    </div>
                  </td>
                  <td style={{ display: "flex", gap: 5 }}>
                    <button
                      className="bt"
                      onClick={() => setStratRow(r)}
                      style={{
                        borderColor:
                          r.strategy &&
                          (r.strategy.side === "long"
                            ? "rgba(63,214,164,.5)"
                            : r.strategy.side === "avoid"
                            ? "rgba(238,106,95,.5)"
                            : CLR.line),
                      }}
                      title="Chiến lược nhanh"
                    >
                      ⚡
                    </button>
                    <button className="bt" onClick={() => openStock(r.key)}>
                      CMT →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          Bấm <b>tên mã</b> hoặc nút <b>⚡</b> để xem thẻ chiến lược nhanh. "Đang
          chạy" = giá đóng cửa đã ra ngoài biên 40 phiên. "Sát trigger" = còn
          dưới 15% biên độ là chạm. A phá lên · B thủng xuống · C kẹt biên; n
          nhỏ (&lt;40) đọc thận trọng. Điểm chỉ là thước xếp hạng, không phải
          tín hiệu vào lệnh.
        </p>
      </Panel>
      <Warn>
        Dữ liệu là giá đóng cửa, High/Low & khối lượng khớp lệnh thật từ
        vnstock (nguồn KBS), không phải toàn bộ thị trường mà chỉ rổ VN30 để
        backend không quá tải. Chưa tính phí giao dịch/thuế. Toàn bộ khuyến
        nghị trong app chỉ áp dụng cho lệnh MUA — TTCK VN hiện không cho phép
        bán khống (short) với nhà đầu tư cá nhân.
      </Warn>
      {stratRow && (
        <StrategyModal
          row={stratRow}
          onClose={() => setStratRow(null)}
          onOpenCMT={() => {
            setStratRow(null);
            openStock(stratRow.key);
          }}
        />
      )}
    </>
  );
}

/* ============================================================
   8. CMT — LỚP 1: XU HƯỚNG
   ============================================================ */

function TrendLayer({ cfg, tf, setTf, frames, dates, closes, highs, lows, volumes, digits, piv, cascade }) {
  const n = Math.min(closes.length, tf === "M" ? 60 : tf === "W" ? 80 : 160);
  const off = closes.length - n;
  const dots = piv
    .filter((p) => p.i >= off)
    .slice(-8)
    .map((p, k) => (
      <ReferenceDot
        key={k}
        x={dates[p.i]}
        y={p.price}
        r={3.5}
        fill={p.type === "H" ? CLR.bear : CLR.bull}
        stroke="none"
        label={{
          value: p.type === "H" ? "Đ" : "đ",
          fill: CLR.mut,
          fontSize: 10,
          position: p.type === "H" ? "top" : "bottom",
        }}
      />
    ));
  const c = cascade || {};
  const fmtR = (r) => (r == null ? "—" : `${r.toFixed(1)}×`);
  const fmtA = (a) => (a == null ? "—" : `${a.toFixed(2)}%`);
  return (
    <>
      <Panel
        mod="Module 1 · Dow Theory"
        title="Trạng thái xu hướng đa khung — Tháng → Tuần → Ngày"
        sub="Chuỗi Tháng→Tuần→Ngày cho cơ sở suy ra khung nhỏ hơn sẽ hành xử ra sao — thị trường có tính tự đồng dạng."
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Khung</th>
              <th>Vai trò</th>
              <th>Xu hướng</th>
              <th>Căn cứ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">M</td>
              <td>Cấp cao (major)</td>
              <td>
                <Chip cls={frames.M.trend}>{trendVN[frames.M.trend]}</Chip>
              </td>
              <td style={{ color: CLR.mut }}>{frames.M.detail}</td>
            </tr>
            <tr>
              <td className="num">W</td>
              <td>Primary (chính)</td>
              <td>
                <Chip cls={frames.W.trend}>{trendVN[frames.W.trend]}</Chip>
              </td>
              <td style={{ color: CLR.mut }}>{frames.W.detail}</td>
            </tr>
            <tr>
              <td className="num">D</td>
              <td>Secondary (trung)</td>
              <td>
                <Chip cls={frames.D.trend}>{trendVN[frames.D.trend]}</Chip>
              </td>
              <td style={{ color: CLR.mut }}>{frames.D.detail}</td>
            </tr>
          </tbody>
        </table>
        <div
          style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <Chip
            cls={frames.fullAlign ? "up" : frames.consensus ? "side" : "mut"}
          >
            {frames.fullAlign
              ? "M · W · D đồng thuận hoàn toàn — trend mạnh"
              : frames.consensus
              ? "W · D thuận nhưng M chưa đồng pha — cẩn trọng khung lớn"
              : "Các khung phân kỳ — ưu tiên đứng ngoài chờ rõ ràng hơn"}
          </Chip>
        </div>
      </Panel>

      <Panel
        mod="Module 1 · Fractal"
        title="Suy diễn xuống khung nhỏ hơn (Tháng→Tuần→Ngày→giờ)"
        sub="Đo biên độ sóng trung vị ở M, W, D rồi lấy tỉ lệ bước xuống giữa các khung — cho vùng kỳ vọng của khung nhỏ mà không bịa số."
      >
        <table className="tbl">
          <thead>
            <tr>
              <th>Khung</th>
              <th>Biên độ sóng (trung vị)</th>
              <th>Thời lượng (trung vị)</th>
              <th>Tỉ lệ so với khung dưới</th>
              <th>Số sóng</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num">M</td>
              <td className="num">{fmtA(c.M?.medAmpl)}</td>
              <td className="num">{c.M?.medDur ?? "—"} tháng</td>
              <td className="num">{fmtR(c.rMW)} (M/W)</td>
              <td className="num">{c.M?.n ?? 0}</td>
            </tr>
            <tr>
              <td className="num">W</td>
              <td className="num">{fmtA(c.W?.medAmpl)}</td>
              <td className="num">{c.W?.medDur ?? "—"} tuần</td>
              <td className="num">{fmtR(c.rWD)} (W/D)</td>
              <td className="num">{c.W?.n ?? 0}</td>
            </tr>
            <tr>
              <td className="num">D</td>
              <td className="num">{fmtA(c.D?.medAmpl)}</td>
              <td className="num">{c.D?.medDur ?? "—"} phiên</td>
              <td className="num" style={{ color: CLR.mut }}>
                × {fmtR(c.projRatio)} →
              </td>
              <td className="num">{c.D?.n ?? 0}</td>
            </tr>
          </tbody>
        </table>
        <div
          style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <Chip cls={c.consistent ? "up" : "side"}>
            {c.consistent
              ? `Tỉ lệ bước xuống nhất quán (M/W ${fmtR(c.rMW)} ≈ W/D ${fmtR(
                  c.rWD
                )}) — có cơ sở tự đồng dạng`
              : `Tỉ lệ bước xuống KHÔNG đều (M/W ${fmtR(c.rMW)} vs W/D ${fmtR(
                  c.rWD
                )}) — mã này ít tự đồng dạng, đọc số khung nhỏ dè dặt`}
          </Chip>
        </div>
      </Panel>

      <Panel
        mod="Module 1 · Volume"
        title="Khối lượng khớp lệnh — xác nhận dòng tiền"
        sub="Cổ phiếu VN có volume thật (khác forex OTC) — dùng để xác nhận breakout và đo sức mạnh dòng tiền."
      >
        <VolumeMiniChart
          dates={dates.slice(-n)}
          volumes={volumes.slice(-n)}
          closes={closes.slice(-n)}
          height={90}
        />
        <p className="sub" style={{ marginTop: 8 }}>
          Cột xanh = phiên tăng, đỏ = phiên giảm. Breakout kèm volume tăng vọt
          (≥1.3–1.5× TB20 phiên) đáng tin hơn breakout volume thấp.
        </p>
      </Panel>

      <Panel
        mod="Biểu đồ"
        title={`${cfg.label} — khung ${
          tf === "M" ? "Tháng" : tf === "W" ? "Tuần" : "Ngày"
        }`}
        sub="Đ = đỉnh swing, đ = đáy swing dùng cho chuỗi Dow — lấy từ High/Low thật trong phiên/tuần/tháng, nên có thể nằm ngoài đường giá đóng cửa; dải mờ phía sau là vùng High–Low để đối chiếu."
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {["M", "W", "D"].map((k) => (
            <button
              key={k}
              className="bt"
              onClick={() => setTf(k)}
              style={tf === k ? { borderColor: CLR.blue, color: CLR.text } : {}}
            >
              {k}
            </button>
          ))}
        </div>
        <PriceChart
          dates={dates.slice(-n)}
          closes={closes.slice(-n)}
          highs={highs ? highs.slice(-n) : undefined}
          lows={lows ? lows.slice(-n) : undefined}
          digits={digits}
          dots={dots}
        />
      </Panel>
    </>
  );
}

/* ============================================================
   9. CMT — LỚP 2: CẤU TRÚC GIÁ
   ============================================================ */

function StructureLayer({ dates, closes, highs, lows, digits, patterns, scens, swings }) {
  const [scIdx, setScIdx] = useState(0);
  const sc = scens[Math.min(scIdx, scens.length - 1)];
  const dots = sc
    ? sc.labels.map((p, k) => (
        <ReferenceDot
          key={k}
          x={dates[p.i]}
          y={p.price}
          r={4}
          fill={CLR.blue}
          stroke="#0d1322"
          strokeWidth={1.5}
          label={{
            value: p.tag,
            fill: CLR.text,
            fontSize: 11,
            fontWeight: 700,
            position: p.type === "H" ? "top" : "bottom",
          }}
        />
      ))
    : null;
  const refs = patterns
    .filter((p) => p.neck != null)
    .map((p, k) => (
      <ReferenceLine
        key={k}
        y={p.neck}
        stroke={CLR.amber}
        strokeDasharray="5 4"
        label={{
          value: "neckline",
          fill: CLR.amber,
          fontSize: 10,
          position: "insideTopLeft",
        }}
      />
    ));
  return (
    <>
      <Panel
        mod="Module 2 · Elliott Wave"
        title="Kịch bản đếm sóng song song"
        sub="Đếm sóng ở KHUNG THÁNG (ổn định hơn tuần/ngày) — mang tính chủ quan cao, hệ thống trình bày các kịch bản khả dĩ kèm xác suất tương đối, không khẳng định một đáp án."
      >
        {swings && swings.cur && swings.up.n > 0 && swings.down.n > 0 && (
          <div className="scen" style={{ borderColor: "rgba(233,180,76,.4)" }}>
            <b>Thước kỳ vọng từ lịch sử sóng</b>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Sóng {swings.cur.dir === "up" ? "tăng" : "giảm"} hiện tại:{" "}
              {swings.cur.bars} phiên · {swings.cur.amplPct}% — median lịch sử
              cùng chiều:{" "}
              {(swings.cur.dir === "up" ? swings.up : swings.down).medBars}{" "}
              phiên ·{" "}
              {(swings.cur.dir === "up" ? swings.up : swings.down).medAmpl}%
              (đã dài hơn {swings.cur.pctBars}% và lớn hơn {swings.cur.pctAmpl}%
              số sóng lịch sử).
            </p>
          </div>
        )}
        {scens.length === 0 && (
          <p className="sub">
            Chưa đủ pivot rõ ràng trên dữ liệu gần đây để dựng kịch bản.
          </p>
        )}
        {scens.map((s, i) => (
          <div
            key={i}
            className="scen"
            style={i === scIdx ? { borderColor: CLR.blue } : {}}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "baseline",
                flexWrap: "wrap",
              }}
            >
              <b>{s.name}</b>
              <span className="prob">~{s.prob}% tương đối</span>
            </div>
            {s.rules.map((r, j) => (
              <div key={j} className="rule">
                <span className={r.ok ? "ok" : "no"}>{r.ok ? "✓" : "✕"}</span>
                <span>{r.txt}</span>
              </div>
            ))}
            <div className="kv" style={{ border: "none", paddingTop: 8 }}>
              <span>Target</span>
              <span className="num">{s.target}</span>
            </div>
            <button
              className="bt"
              onClick={() => setScIdx(i)}
              style={{ marginTop: 6 }}
            >
              {i === scIdx
                ? "Đang hiển thị nhãn trên biểu đồ"
                : "Hiển thị nhãn sóng"}
            </button>
          </div>
        ))}
      </Panel>
      <Panel
        mod="Module 2 · Chart Patterns"
        title="Mẫu hình cổ điển đang theo dõi"
        sub="Nhận diện ở KHUNG THÁNG từ đỉnh/đáy High/Low thật; target đo bằng chiều cao mẫu hình."
      >
        {patterns.length === 0 && (
          <p className="sub">
            Không phát hiện mẫu hình đạt điều kiện trên cửa sổ hiện tại.
          </p>
        )}
        {patterns.map((p, i) => (
          <div key={i} className="scen">
            <b>{p.name}</b>{" "}
            <Chip
              cls={p.dir === "tăng" ? "up" : p.dir === "giảm" ? "down" : "side"}
            >
              {p.dir}
            </Chip>
            <div className="kv">
              <span>Trạng thái</span>
              <span>{p.status}</span>
            </div>
            {p.neck != null && (
              <div className="kv">
                <span>Neckline / breakout</span>
                <span className="num">{p.neck.toFixed(digits)}</span>
              </div>
            )}
            {p.target != null && (
              <div className="kv">
                <span>Target</span>
                <span className="num">{p.target.toFixed(digits)}</span>
              </div>
            )}
            {p.heightTxt && (
              <div className="kv">
                <span>Cách đo target</span>
                <span>{p.heightTxt}</span>
              </div>
            )}
          </div>
        ))}
      </Panel>
      <Panel mod="Biểu đồ" title="Khung tháng — overlay nhãn sóng & neckline">
        <PriceChart
          dates={dates}
          closes={closes}
          highs={highs}
          lows={lows}
          digits={digits}
          dots={dots}
          refLines={refs}
          height={320}
        />
      </Panel>
    </>
  );
}

/* ============================================================
   10. CMT — LỚP 3: XÁC NHẬN (Momentum + Volume)
   ============================================================ */

function ConfirmLayer({
  dates,
  closes,
  volumes,
  rsiArr,
  macdArr,
  stochArr,
  bt,
  trendD,
  div,
}) {
  const w = Math.min(120, closes.length),
    off = closes.length - w;
  const oscData = closes.slice(-w).map((c, i) => ({
    d: dates[off + i],
    rsi: rsiArr[off + i],
    macd: macdArr[off + i].macd,
    sig: macdArr[off + i].signal,
    hist: macdArr[off + i].hist,
    k: stochArr[off + i],
  }));
  const vma20 = sma(volumes, 20);
  const volData = closes.slice(-w).map((c, i) => ({
    d: dates[off + i],
    v: volumes[off + i],
    vma: vma20[off + i],
    up: i > 0 ? closes[off + i] >= closes[off + i - 1] : true,
  }));
  const lastRSI = rsiArr[rsiArr.length - 1];
  const lastM = macdArr[macdArr.length - 1];
  const lastVolRatio =
    vma20[vma20.length - 1] ? volumes[volumes.length - 1] / vma20[vma20.length - 1] : 1;
  const [showBT, setShowBT] = useState(false);
  const confirmOK =
    (trendD === "up" && lastRSI > 50 && lastM.macd > lastM.signal) ||
    (trendD === "down" && lastRSI < 50 && lastM.macd < lastM.signal);
  return (
    <>
      <Panel
        mod="Module 3 · Momentum"
        title="RSI · MACD · Stochastic (khung ngày)"
        sub="Lớp này xác nhận hoặc phủ nhận kết luận từ lớp xu hướng và cấu trúc — không dùng độc lập."
      >
        <div className="grid3" style={{ marginBottom: 10 }}>
          <div className="kv" style={{ border: "none" }}>
            <span>RSI(14)</span>
            <span
              className="num"
              style={{
                color:
                  lastRSI > 55 ? CLR.bull : lastRSI < 45 ? CLR.bear : CLR.amber,
              }}
            >
              {lastRSI ? lastRSI.toFixed(1) : "—"}
            </span>
          </div>
          <div className="kv" style={{ border: "none" }}>
            <span>MACD vs Signal</span>
            <span
              className="num"
              style={{ color: lastM.macd > lastM.signal ? CLR.bull : CLR.bear }}
            >
              {lastM.macd > lastM.signal ? "Trên" : "Dưới"}
            </span>
          </div>
          <div className="kv" style={{ border: "none" }}>
            <span>Đồng pha xu hướng D?</span>
            <span>
              {confirmOK ? (
                <Chip cls="up">Xác nhận</Chip>
              ) : (
                <Chip cls="side">Chưa xác nhận</Chip>
              )}
            </span>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <Chip
            cls={
              div.type === "bearish"
                ? "down"
                : div.type === "bullish"
                ? "up"
                : "mut"
            }
          >
            {div.txt}
          </Chip>
        </div>
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={oscData}>
            <XAxis dataKey="d" hide />
            <YAxis domain={[0, 100]} hide />
            <ReferenceLine y={70} stroke={CLR.bear} strokeDasharray="3 4" />
            <ReferenceLine y={30} stroke={CLR.bull} strokeDasharray="3 4" />
            <Tooltip contentStyle={TT} />
            <Line
              dataKey="rsi"
              name="RSI"
              stroke={CLR.blue}
              dot={false}
              strokeWidth={1.6}
              isAnimationActive={false}
            />
            <Line
              dataKey="k"
              name="Stoch %K (close-based)"
              stroke={CLR.amber}
              dot={false}
              strokeWidth={1}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
        <ResponsiveContainer width="100%" height={90}>
          <ComposedChart data={oscData}>
            <XAxis dataKey="d" hide />
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip contentStyle={TT} />
            <Bar dataKey="hist" name="MACD hist" isAnimationActive={false}>
              {oscData.map((d, i) => (
                <Cell key={i} fill={d.hist >= 0 ? CLR.bull : CLR.bear} />
              ))}
            </Bar>
            <Line
              dataKey="macd"
              name="MACD"
              stroke={CLR.blue}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="sig"
              name="Signal"
              stroke={CLR.amber}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ marginTop: 10 }}>
          <button className="bt" onClick={() => setShowBT(!showBT)}>
            {showBT
              ? "Ẩn lịch sử khớp"
              : "Xem lịch sử khớp quy tắc confluence này"}
          </button>
          {showBT && (
            <div className="scen" style={{ marginTop: 8 }}>
              <b>
                Quy tắc: xu hướng Dow khung D + RSI cắt lại 40/60 theo hướng xu
                hướng
              </b>
              {bt ? (
                <>
                  <div className="kv">
                    <span>Số lần khớp (rolling, không nhìn trước)</span>
                    <span className="num">{bt.n}</span>
                  </div>
                  <div className="kv">
                    <span>Tỷ lệ dương sau 12 phiên</span>
                    <span className="num">{bt.winRate}%</span>
                  </div>
                  <div className="kv">
                    <span>Kết quả TB (đơn vị vol-proxy)</span>
                    <span className="num">{bt.avgR}R</span>
                  </div>
                </>
              ) : (
                <p className="sub">
                  Chưa có lần khớp nào trong lịch sử đã tải.
                </p>
              )}
            </div>
          )}
        </div>
      </Panel>

      <Panel
        mod="Module 3 · Volume"
        title="Xác nhận bằng khối lượng khớp lệnh"
        sub="Dữ liệu volume thật từ HOSE (khác forex OTC không có volume) — cột volume + TB20 phiên."
      >
        <div className="kv" style={{ border: "none", marginBottom: 10 }}>
          <span>Volume hôm nay / TB20 phiên</span>
          <span
            className="num"
            style={{
              color: lastVolRatio >= 1.3 ? CLR.blue : CLR.text,
              fontWeight: 700,
            }}
          >
            {lastVolRatio.toFixed(2)}×
          </span>
        </div>
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={volData}>
            <XAxis dataKey="d" hide />
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              contentStyle={TT}
              formatter={(v, nm) => [fmtVol(v), nm === "v" ? "Volume" : "TB20"]}
            />
            <Bar dataKey="v" isAnimationActive={false}>
              {volData.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.up ? CLR.bull : CLR.bear}
                  fillOpacity={0.6}
                />
              ))}
            </Bar>
            <Line
              dataKey="vma"
              stroke={CLR.amber}
              dot={false}
              strokeWidth={1.4}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="sub" style={{ marginTop: 8 }}>
          Volume tăng vọt kèm giá breakout = dòng tiền thật vào lệnh, tin cậy
          hơn breakout thanh khoản thấp (dễ bị "úp bô" quay đầu).
        </p>
      </Panel>
    </>
  );
}

/* ============================================================
   11. CMT — LỚP 4: RỦI RO & TƯƠNG QUAN
   ============================================================ */

function RiskLayer({ allCloses, matrixKeys, vol, volIsTrueATR, cfg, digits, lastPrice }) {
  const [equity, setEquity] = useState(100000000);
  const [riskPct, setRiskPct] = useState(1);
  const [volMult, setVolMult] = useState(2);
  const [positions, setPositions] = useState([cfg.key]);
  const rets = {};
  matrixKeys.forEach((k) => (rets[k] = returns(allCloses[k] || []).slice(-60)));
  const mat = matrixKeys.map((a) =>
    matrixKeys.map((b) => pearson(rets[a] || [], rets[b] || []))
  );
  // Toàn bộ vị thế đều là MUA (TTCK VN không bán khống), nên "double risk"
  // ở đây chỉ còn một dạng: hai mã cùng đang mua mà tương quan quá cao —
  // thực chất là đặt cược hai lần vào cùng một yếu tố (ngành, VNINDEX...).
  const dbl = [];
  positions.forEach((a, i) =>
    positions.slice(i + 1).forEach((b) => {
      if (!rets[a] || !rets[b]) return;
      const c = pearson(rets[a], rets[b]);
      if (c > 0.7) dbl.push({ a, b, c });
    })
  );
  const stopDist = vol * volMult;
  const riskAmount = (equity * riskPct) / 100;
  const sizeShares = riskAmount / (stopDist || 1e-9);
  const colFor = (v) =>
    v === 1
      ? "rgba(110,168,255,.15)"
      : v > 0
      ? `rgba(63,214,164,${0.08 + Math.abs(v) * 0.3})`
      : `rgba(238,106,95,${0.08 + Math.abs(v) * 0.3})`;
  const toggle = (k) =>
    setPositions((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  return (
    <>
      <Panel
        mod="Module 4 · Position sizing"
        title={`Khối lượng theo biến động — ${cfg.label}`}
        sub={
          volIsTrueATR
            ? "Không sizing cố định — khối lượng co giãn theo biến động để rủi ro mỗi lệnh là hằng số. Vol dùng ATR(14) thật (Wilder, tính từ High/Low/Close)."
            : "Không sizing cố định — khối lượng co giãn theo biến động để rủi ro mỗi lệnh là hằng số. Vol dùng EMA(14) của |Δ giá đóng cửa| (chưa có High/Low)."
        }
      >
        <div className="grid3">
          <div>
            <label className="lb">Vốn (VND)</label>
            <input
              className="inp"
              type="number"
              value={equity}
              onChange={(e) => setEquity(+e.target.value || 0)}
            />
          </div>
          <div>
            <label className="lb">Rủi ro mỗi lệnh (%)</label>
            <input
              className="inp"
              type="number"
              step="0.25"
              value={riskPct}
              onChange={(e) => setRiskPct(+e.target.value || 0)}
            />
          </div>
          <div>
            <label className="lb">Stop = vol ×</label>
            <input
              className="inp"
              type="number"
              step="0.25"
              value={volMult}
              onChange={(e) => setVolMult(+e.target.value || 0)}
            />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span>{volIsTrueATR ? "ATR thật(14) khung D" : "Vol-proxy(14) khung D"}</span>
            <span className="num">{fmtMoney(vol)}</span>
          </div>
          <div className="kv">
            <span>Khoảng stop (vol × hệ số)</span>
            <span className="num">{fmtMoney(stopDist)}</span>
          </div>
          <div className="kv">
            <span>Rủi ro tiền mỗi lệnh</span>
            <span className="num">{fmtMoney(riskAmount)}</span>
          </div>
          <div className="kv">
            <span>Khối lượng gợi ý (xấp xỉ)</span>
            <span className="num" style={{ color: CLR.blue, fontWeight: 600 }}>
              {isFinite(sizeShares) ? Math.round(sizeShares).toLocaleString("vi-VN") + " cổ phiếu" : "—"}
            </span>
          </div>
        </div>
      </Panel>
      <div className="grid2">
        <Panel
          mod="Module 4 · Tương quan"
          title="Ma trận tương quan giữa các mã VN30"
          sub="Cảnh báo khi hai lệnh mua thực chất là một cược (cùng ngành, cùng nhóm dẫn dắt bởi VNINDEX)."
        >
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th></th>
                  {matrixKeys.map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixKeys.map((a, i) => (
                  <tr key={a}>
                    <td style={{ color: CLR.mut, fontSize: 11 }}>{a}</td>
                    {matrixKeys.map((b, j) => (
                      <td key={b}>
                        <div
                          style={{
                            padding: "6px 8px",
                            textAlign: "center",
                            fontFamily: "IBM Plex Mono, monospace",
                            fontSize: 12,
                            borderRadius: 6,
                            background: colFor(mat[i][j]),
                          }}
                        >
                          {mat[i][j].toFixed(2)}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dbl.map((d, i) => (
            <div key={i} style={{ marginTop: 10 }}>
              <Chip cls="down">
                Double risk: Mua {d.a} + Mua {d.b} (corr {d.c.toFixed(2)}) —
                thực chất là một cược nhân đôi
              </Chip>
            </div>
          ))}
          {dbl.length === 0 && (
            <div style={{ marginTop: 10 }}>
              <Chip cls="up">
                Không có cặp mã trùng cược trên ngưỡng tương quan 0.70
              </Chip>
            </div>
          )}
        </Panel>
        <Panel
          mod="Module 4 · Danh mục giả định"
          title="Chọn vị thế MUA để kiểm tra rủi ro chéo"
          sub="Bật/tắt mã để mô phỏng danh mục đang nắm giữ — kiểm tra double risk trên tương quan thật. TTCK VN chỉ có chiều mua nên không có lựa chọn hướng."
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Mã</th>
                <th>Trong danh mục (đang mua)</th>
              </tr>
            </thead>
            <tbody>
              {matrixKeys.map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>
                    <button className="bt" onClick={() => toggle(k)}>
                      {positions.includes(k) ? "Đang mua — bỏ" : "Thêm vào danh mục"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub" style={{ marginTop: 10 }}>
            R:R tối thiểu khuyến nghị theo setup breakout/pullback: 1:2.
          </p>
        </Panel>
      </div>
    </>
  );
}

/* ============================================================
   12. CMT — LỚP 5: KỊCH BẢN GIAO DỊCH
   ============================================================ */

function PlaybookChart({ dates, closes, highs, lows, digits, pb, ma50, ma200 }) {
  const n = Math.min(130, closes.length),
    off = closes.length - n;
  const data = closes
    .slice(-n)
    .map((c, i) => ({
      d: dates[off + i],
      c,
      m50: ma50[off + i],
      m200: ma200[off + i],
      range: highs && lows ? [lows[off + i], highs[off + i]] : undefined,
    }));
  const fmt = (v) => Number(v).toLocaleString("vi-VN", { maximumFractionDigits: digits });
  const yPad = pb.range * 0.15;
  const loSlice = lows ? lows.slice(-n) : closes.slice(-n);
  const hiSlice = highs ? highs.slice(-n) : closes.slice(-n);
  const yMin = Math.min(pb.tB2, Math.min(...loSlice)) - yPad;
  const yMax = Math.max(pb.tA2, Math.max(...hiSlice)) + yPad;
  const rl = (y, c, l, pos, dash) => (
    <ReferenceLine
      y={y}
      stroke={c}
      strokeDasharray={dash}
      strokeWidth={dash ? 1 : 1.5}
      label={{ value: l, fill: c, fontSize: dash ? 9 : 10, position: pos }}
    />
  );
  return (
    <ResponsiveContainer width="100%" height={380}>
      <ComposedChart
        data={data}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          stroke={CLR.line}
          strokeDasharray="2 4"
          vertical={false}
        />
        <XAxis
          dataKey="d"
          tick={{ fill: CLR.dim, fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: CLR.line }}
          minTickGap={55}
          tickFormatter={(d) => (d ? d.slice(5) : "")}
        />
        <YAxis
          domain={[yMin, yMax]}
          tick={{ fill: CLR.dim, fontSize: 10, fontFamily: "IBM Plex Mono" }}
          tickFormatter={fmt}
          width={70}
          tickLine={false}
          axisLine={false}
          orientation="right"
        />
        <Tooltip
          contentStyle={TT}
          labelStyle={{ color: CLR.mut }}
          formatter={(v, nm) =>
            v == null
              ? ["—", nm]
              : [fmt(v), nm === "c" ? "Giá" : nm.toUpperCase()]
          }
        />
        <ReferenceArea y1={pb.R} y2={yMax} fill={CLR.bull} fillOpacity={0.05} />
        <ReferenceArea y1={yMin} y2={pb.S} fill={CLR.bear} fillOpacity={0.05} />
        {highs && lows && (
          <Area dataKey="range" stroke="none" fill={CLR.mut} fillOpacity={0.12} isAnimationActive={false} />
        )}
        {pb.fibs.map((f) => (
          <ReferenceLine
            key={f.f}
            y={f.y}
            stroke={CLR.dim}
            strokeDasharray="2 6"
            strokeOpacity={0.7}
            label={{
              value: `Fib ${(f.f * 100).toFixed(1)}%`,
              fill: CLR.dim,
              fontSize: 9,
              position: "insideLeft",
            }}
          />
        ))}
        {rl(pb.R, CLR.bull, `R ${fmt(pb.R)} — trigger KB A`, "insideTopLeft")}
        {rl(
          pb.S,
          CLR.bear,
          `S ${fmt(pb.S)} — trigger KB B`,
          "insideBottomLeft"
        )}
        {rl(pb.tA1, CLR.bull, `A·T1 ${fmt(pb.tA1)}`, "insideRight", "6 4")}
        {rl(pb.tA2, CLR.bull, `A·T2 ${fmt(pb.tA2)}`, "insideRight", "6 4")}
        {rl(pb.tB1, CLR.bear, `B·T1 ${fmt(pb.tB1)}`, "insideRight", "6 4")}
        {rl(pb.tB2, CLR.bear, `B·T2 ${fmt(pb.tB2)}`, "insideRight", "6 4")}
        <Line
          dataKey="m200"
          name="MA200"
          stroke={CLR.mut}
          dot={false}
          strokeWidth={1}
          strokeDasharray="4 3"
          isAnimationActive={false}
          connectNulls
        />
        <Line
          dataKey="m50"
          name="MA50"
          stroke={CLR.amber}
          dot={false}
          strokeWidth={1.2}
          isAnimationActive={false}
          connectNulls
        />
        <Line
          dataKey="c"
          name="Giá"
          stroke={CLR.blue}
          dot={false}
          strokeWidth={1.8}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

const LAYER_NAMES = {
  1: "L1 Xu hướng",
  2: "L2 Cấu trúc",
  3: "L3 Xác nhận",
};

function PlaybookLayer({ cfg, pb, dates, closes, highs, lows, digits, ma50, ma200, goLayer, analog }) {
  const probOf = (id) =>
    analog
      ? id === "A"
        ? analog.pA
        : id === "B"
        ? analog.pB
        : analog.pC
      : null;
  return (
    <>
      <Panel
        mod="Tổng hợp workflow"
        title={`Kịch bản giao dịch — ${cfg.label}`}
        sub="Đầu ra của trình tự CMT: hỗ trợ/kháng cự và kịch bản A·B·C xác định từ pivot THÁNG thật (ổn định hơn tuần/ngày); mỗi nhánh là một kế hoạch if-then với trigger, target, mức vô hiệu và bằng chứng trích từ đúng lớp phân tích sinh ra nó. Giá hiện tại vẫn cập nhật theo từng phiên ngày."
      >
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}
        >
          <Chip cls={pb.bias}>
            Cán cân bằng chứng: {pb.biasPct}% nghiêng tăng ({pb.bullScore} tăng ·{" "}
            {pb.bearScore} giảm)
          </Chip>
          <Chip cls="mut">
            Biên hiện tại: {pb.S.toLocaleString("vi-VN")} –{" "}
            {pb.R.toLocaleString("vi-VN")} (rộng {pb.range.toLocaleString("vi-VN")})
          </Chip>
          <Chip cls="mut">Giá: {pb.last.toLocaleString("vi-VN")}</Chip>
        </div>
        {analog ? (
          <div className="scen" style={{ marginBottom: 10 }}>
            <b>Xác suất thực nghiệm từ lịch sử (analog)</b>
            <div
              style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}
            >
              <Chip cls="up">A · phá lên: {analog.pA}%</Chip>
              <Chip cls="down">B · thủng xuống: {analog.pB}%</Chip>
              <Chip cls="side">
                C · kẹt biên sau {analog.horizon} phiên: {analog.pC}%
              </Chip>
            </div>
            <p className="sub" style={{ margin: 0 }}>
              Cách tính: quét toàn bộ lịch sử tìm {analog.n} thời điểm có trạng
              thái giống hiện tại (khớp {analog.dims}/5 điều kiện), rồi đếm
              trong {analog.horizon} phiên kế tiếp giá phá lên biên trước,
              thủng biên trước, hay vẫn kẹt. Mẫu {analog.n} lần{" "}
              {analog.n < 40
                ? "là NHỎ — đọc thận trọng"
                : "ở mức chấp nhận được"}
              .
            </p>
          </div>
        ) : (
          <p className="sub">
            Chưa đủ trạng thái tương tự trong lịch sử để tính xác suất analog.
          </p>
        )}
        <PlaybookChart
          dates={dates}
          closes={closes}
          highs={highs}
          lows={lows}
          digits={digits}
          pb={pb}
          ma50={ma50}
          ma200={ma200}
        />
      </Panel>

      {pb.branches.map((b) => (
        <Panel
          key={b.id}
          mod={`Nhánh ${b.id}${
            probOf(b.id) != null ? ` · xác suất analog ~${probOf(b.id)}%` : ""
          }`}
          title={b.title}
          sub={
            b.dir === "side"
              ? "Kịch bản mặc định khi chưa nhánh nào kích hoạt."
              : undefined
          }
        >
          <div className="kv">
            <span>Điều kiện kích hoạt</span>
            <span>{b.trigger}</span>
          </div>
          <div className="kv">
            <span>Mục tiêu nếu kích hoạt</span>
            <span>
              {b.targets.map((t, i) => (
                <div key={i} className="num" style={{ textAlign: "right" }}>
                  {t}
                </div>
              ))}
            </span>
          </div>
          <div className="kv">
            <span>Mức vô hiệu</span>
            <span style={{ color: CLR.amber }}>{b.invalid}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="sub" style={{ marginBottom: 6 }}>
              Dựa vào đâu — indicator & lớp phân tích ({b.score}/{b.total} đang
              ủng hộ):
            </div>
            {b.evidence.map((e, i) => (
              <div key={i} className="rule">
                <span className={e.ok ? "ok" : "no"}>{e.ok ? "✓" : "✕"}</span>
                <span>{e.txt}</span>
                <button
                  className="bt"
                  style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 10.5 }}
                  onClick={() => goLayer(e.layer - 1)}
                >
                  {LAYER_NAMES[e.layer]}
                </button>
              </div>
            ))}
          </div>
        </Panel>
      ))}
      <Warn>
        Kịch bản là kế hoạch theo dõi có điều kiện, không phải khuyến nghị vào
        lệnh. Trước khi hành động theo bất kỳ nhánh nào, bắt buộc qua L4
        (sizing theo biến động + kiểm tra double-risk).
      </Warn>
    </>
  );
}

/* ============================================================
   13. CMT — LỚP 6: KIỂM CHỨNG LỊCH SỬ
   ============================================================ */

function HistoryLayer({ cfg, hist, digits }) {
  if (!hist)
    return <Panel mod="Kiểm chứng" title="Đang tính lịch sử…" />;
  const { events, rule, confl, closes, dates, system, swings } = hist;
  const eqLen = Math.max(
    system.sys.eq ? system.sys.eq.length : 0,
    system.raw.eq ? system.raw.eq.length : 0
  );
  const eqData = Array.from({ length: eqLen }, (_, k) => ({
    x: k + 1,
    sys: system.sys.eq && system.sys.eq[k] ? system.sys.eq[k].eq : null,
    raw: system.raw.eq && system.raw.eq[k] ? system.raw.eq[k].eq : null,
  }));
  const groups = {};
  events.forEach((e) => {
    if (!groups[e.name])
      groups[e.name] = { n: 0, hit: 0, fail: 0, open: 0, bars: [] };
    const g = groups[e.name];
    g.n++;
    g[e.res]++;
    if (e.bars != null && e.res === "hit") g.bars.push(e.bars);
  });
  const rows = Object.entries(groups).map(([name, g]) => {
    const decided = g.hit + g.fail;
    const med = g.bars.length
      ? g.bars.sort((a, b) => a - b)[Math.floor(g.bars.length / 2)]
      : null;
    return {
      name,
      ...g,
      rate: decided ? Math.round((g.hit / decided) * 100) : null,
      med,
    };
  });
  const totHit = events.filter((e) => e.res === "hit").length;
  const totFail = events.filter((e) => e.res === "fail").length;
  const totRate =
    totHit + totFail ? Math.round((totHit / (totHit + totFail)) * 100) : null;
  const step = Math.max(1, Math.floor(closes.length / 1000));
  const data = [];
  for (let i = 0; i < closes.length; i += step)
    data.push({ x: i, d: dates[i], c: closes[i] });
  const fmt = (v) => Number(v).toLocaleString("vi-VN", { maximumFractionDigits: digits });
  const evColor = { hit: CLR.bull, fail: CLR.bear, open: CLR.amber };
  const resVN = { hit: "Đạt target", fail: "Vô hiệu", open: "Chưa phân định" };
  const tickF = (v) =>
    dates[Math.round(v)] ? dates[Math.round(v)].slice(0, 7) : "";
  return (
    <>
      <Panel
        mod="Kiểm chứng · Toàn hệ thống"
        title={`Đánh giá hệ thống giao dịch hoàn chỉnh — ${cfg.label}`}
        sub="Vào lệnh khi breakout biên 40 phiên VÀ bộ lọc confluence đồng thuận (≥3/5); thoát tại T1 / false-break / hết 30 phiên; tối đa 1 vị thế. So với breakout thuần để thấy bộ lọc CMT thêm/bớt được gì."
      >
        <table className="tbl" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Hệ thống</th>
              <th>Số lệnh</th>
              <th>Tỷ lệ thắng</th>
              <th>TB mỗi lệnh (vol)</th>
              <th>Profit factor</th>
              <th>Max drawdown (vol)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Breakout + bộ lọc confluence CMT</td>
              <td className="num">{system.sys.n}</td>
              <td className="num" style={{ color: CLR.bull }}>
                {system.sys.n ? `${system.sys.winRate}%` : "—"}
              </td>
              <td className="num">{system.sys.avg ?? "—"}</td>
              <td className="num">{system.sys.pf ?? "—"}</td>
              <td className="num" style={{ color: CLR.bear }}>
                {system.sys.maxDD ?? "—"}
              </td>
            </tr>
            <tr>
              <td style={{ color: CLR.mut }}>
                Breakout thuần (không lọc — đối chứng)
              </td>
              <td className="num">{system.raw.n}</td>
              <td className="num">
                {system.raw.n ? `${system.raw.winRate}%` : "—"}
              </td>
              <td className="num">{system.raw.avg ?? "—"}</td>
              <td className="num">{system.raw.pf ?? "—"}</td>
              <td className="num">{system.raw.maxDD ?? "—"}</td>
            </tr>
          </tbody>
        </table>
        {system.buyHold && (
          <div
            className="scen"
            style={{ borderColor: "rgba(233,180,76,.4)", marginBottom: 12 }}
          >
            <b>So với đối chứng bắt buộc cho cổ phiếu — chỉ MUA VÀ GIỮ</b>
            <p className="sub" style={{ margin: "6px 0 10px" }}>
              Nếu từ {system.buyHoldFromDate} (thời điểm breakout đầu tiên
              trong dữ liệu) chỉ mua {cfg.label} rồi giữ tới nay, không giao
              dịch gì thêm:
            </p>
            <div className="grid3">
              <div className="kv" style={{ border: "none" }}>
                <span>Tổng lợi nhuận</span>
                <span
                  className="num"
                  style={{
                    fontWeight: 700,
                    color: system.buyHold.totalReturnPct >= 0 ? CLR.bull : CLR.bear,
                  }}
                >
                  {system.buyHold.totalReturnPct >= 0 ? "+" : ""}
                  {system.buyHold.totalReturnPct.toFixed(1)}%
                </span>
              </div>
              <div className="kv" style={{ border: "none" }}>
                <span>Sharpe (theo ngày)</span>
                <span className="num">{system.buyHold.sharpe.toFixed(2)}</span>
              </div>
              <div className="kv" style={{ border: "none" }}>
                <span>Max Drawdown</span>
                <span className="num" style={{ color: CLR.bear }}>
                  {system.buyHold.maxDDPct.toFixed(1)}%
                </span>
              </div>
            </div>
            <p className="sub" style={{ margin: "8px 0 0" }}>
              Bảng phía trên tính bằng đơn vị vol-proxy (R-multiple) trên từng
              lệnh riêng lẻ nên không cộng dồn trực tiếp thành % được — xem
              phần "Lợi nhuận (3 góc nhìn)" ở tab Hurst để có đường % lợi
              nhuận cộng dồn đối chiếu trực tiếp với đường Buy & Hold này.
            </p>
          </div>
        )}
        {eqLen > 0 && (
          <>
            <div className="sub" style={{ marginBottom: 4 }}>
              Equity curve luỹ kế (đơn vị vol-proxy, theo thứ tự lệnh)
            </div>
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={eqData}>
                <CartesianGrid
                  stroke={CLR.line}
                  strokeDasharray="2 4"
                  vertical={false}
                />
                <XAxis
                  dataKey="x"
                  tick={{ fill: CLR.dim, fontSize: 9 }}
                  tickLine={false}
                  axisLine={{ stroke: CLR.line }}
                />
                <YAxis
                  tick={{ fill: CLR.dim, fontSize: 9, fontFamily: "IBM Plex Mono" }}
                  width={44}
                  tickLine={false}
                  axisLine={false}
                />
                <ReferenceLine y={0} stroke={CLR.line} />
                <Tooltip contentStyle={TT} />
                <Line
                  dataKey="sys"
                  name="Có bộ lọc CMT"
                  stroke={CLR.bull}
                  dot={false}
                  strokeWidth={1.8}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  dataKey="raw"
                  name="Breakout thuần"
                  stroke={CLR.mut}
                  dot={false}
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  isAnimationActive={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </Panel>

      <Panel
        mod="Kiểm chứng · Mẫu hình"
        title={`Mẫu hình đã xuất hiện — ${cfg.label}`}
        sub="Mỗi chấm là một lần mẫu hình hoàn thành breakout trong quá khứ; màu = kết quả trong 40 phiên sau đó."
      >
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}
        >
          <Chip cls="mut">Tổng {events.length} lần xuất hiện</Chip>
          {totRate != null && (
            <Chip cls={totRate >= 55 ? "up" : totRate <= 45 ? "down" : "side"}>
              Tỷ lệ đạt target chung: {totRate}% ({totHit}/{totHit + totFail} đã
              phân định)
            </Chip>
          )}
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              stroke={CLR.line}
              strokeDasharray="2 4"
              vertical={false}
            />
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, closes.length - 1]}
              tick={{ fill: CLR.dim, fontSize: 9 }}
              tickLine={false}
              axisLine={{ stroke: CLR.line }}
              tickFormatter={tickF}
              tickCount={8}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: CLR.dim, fontSize: 9, fontFamily: "IBM Plex Mono" }}
              tickFormatter={fmt}
              width={66}
              tickLine={false}
              axisLine={false}
              orientation="right"
            />
            <Tooltip
              contentStyle={TT}
              labelFormatter={tickF}
              formatter={(v) => [fmt(v), "Giá"]}
            />
            <Line
              dataKey="c"
              stroke={CLR.blue}
              dot={false}
              strokeWidth={1.2}
              isAnimationActive={false}
            />
            {events.map((e, i) => (
              <ReferenceDot
                key={i}
                x={e.i}
                y={e.entry}
                r={4}
                fill={evColor[e.res]}
                stroke="#0d1322"
                strokeWidth={1}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
        <table className="tbl" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Mẫu hình</th>
              <th>Số lần</th>
              <th>Đạt</th>
              <th>Vô hiệu</th>
              <th>Chưa rõ</th>
              <th>Tỷ lệ đạt</th>
              <th>Median phiên tới target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{r.n}</td>
                <td className="num" style={{ color: CLR.bull }}>
                  {r.hit}
                </td>
                <td className="num" style={{ color: CLR.bear }}>
                  {r.fail}
                </td>
                <td className="num" style={{ color: CLR.amber }}>
                  {r.open}
                </td>
                <td className="num">{r.rate != null ? `${r.rate}%` : "—"}</td>
                <td className="num">{r.med != null ? r.med : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: CLR.mut }}>
                  Không tìm thấy mẫu hình hoàn chỉnh nào theo điều kiện quét.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel
        mod="Kiểm chứng · Sóng"
        title="Chu kỳ & biên độ sóng lịch sử (swing pivot-to-pivot)"
        sub="Nền của mọi cách đếm Elliott: mỗi sóng quá khứ kéo dài bao nhiêu phiên và chạy bao nhiêu % — thước kỳ vọng cho sóng đang đếm ở bước 2."
      >
        <table className="tbl" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Chiều sóng</th>
              <th>Số sóng</th>
              <th>Median thời gian</th>
              <th>P25–P75 (phiên)</th>
              <th>Median biên độ</th>
              <th>P25–P75 (%)</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["up", "Sóng tăng", swings.up],
              ["down", "Sóng giảm", swings.down],
            ].map(([k, label, st]) => (
              <tr key={k}>
                <td>
                  <Chip cls={k}>{label}</Chip>
                </td>
                {st.n ? (
                  <>
                    <td className="num">{st.n}</td>
                    <td className="num">
                      {st.medBars} phiên (~{st.medDays} ngày lịch)
                    </td>
                    <td className="num">
                      {st.p25B}–{st.p75B}
                    </td>
                    <td className="num">{st.medAmpl}%</td>
                    <td className="num">
                      {st.p25A}–{st.p75A}%
                    </td>
                  </>
                ) : (
                  <td colSpan={5} style={{ color: CLR.mut }}>
                    Chưa đủ dữ liệu
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid2">
          <div>
            <div className="sub" style={{ marginBottom: 4 }}>
              Phân phối thời gian sóng (phiên)
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={swings.hDur}>
                <XAxis
                  dataKey="bucket"
                  tick={{ fill: CLR.dim, fontSize: 9 }}
                  tickLine={false}
                  axisLine={{ stroke: CLR.line }}
                />
                <YAxis hide allowDecimals={false} />
                <Tooltip contentStyle={TT} />
                <Bar
                  dataKey="up"
                  name="Sóng tăng"
                  fill={CLR.bull}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="down"
                  name="Sóng giảm"
                  fill={CLR.bear}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div>
            <div className="sub" style={{ marginBottom: 4 }}>
              Phân phối biên độ sóng (%)
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={swings.hAmp}>
                <XAxis
                  dataKey="bucket"
                  tick={{ fill: CLR.dim, fontSize: 9 }}
                  tickLine={false}
                  axisLine={{ stroke: CLR.line }}
                />
                <YAxis hide allowDecimals={false} />
                <Tooltip contentStyle={TT} />
                <Bar
                  dataKey="up"
                  name="Sóng tăng"
                  fill={CLR.bull}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="down"
                  name="Sóng giảm"
                  fill={CLR.bear}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        {swings.cur && (
          <div className="scen" style={{ marginTop: 12 }}>
            <b>Sóng hiện tại (từ pivot {swings.cur.from})</b>
            <div className="kv">
              <span>Chiều & tuổi sóng</span>
              <span className="num">
                {swings.cur.dir === "up" ? "Tăng" : "Giảm"} · {swings.cur.bars}{" "}
                phiên (~{swings.cur.days} ngày lịch)
              </span>
            </div>
            <div className="kv">
              <span>Biên độ đã chạy</span>
              <span className="num">{swings.cur.amplPct}%</span>
            </div>
            <div className="kv">
              <span>So với lịch sử cùng chiều</span>
              <span className="num">
                dài hơn {swings.cur.pctBars ?? "—"}% số sóng · biên độ vượt{" "}
                {swings.cur.pctAmpl ?? "—"}% số sóng
              </span>
            </div>
          </div>
        )}
      </Panel>

      <div className="grid2">
        <Panel
          mod="Kiểm chứng · Quy tắc playbook"
          title="Breakout biên 40 phiên → T1 (0.618×biên)"
          sub="Kiểm chứng đúng quy tắc mà bước Kịch bản và Bộ lọc đang dùng."
        >
          {["up", "down"].map((d) => (
            <div key={d} className="kv">
              <span>
                {d === "up" ? "Phá lên (kiểu KB A)" : "Thủng xuống (kiểu KB B)"}{" "}
                — {rule[d].n} lần
              </span>
              <span className="num">
                {rule[d].rate != null ? `${rule[d].rate}% đạt T1` : "—"} ·{" "}
                {rule[d].hit}✓ {rule[d].fail}✕ {rule[d].open}∼
              </span>
            </div>
          ))}
        </Panel>
        <Panel
          mod="Kiểm chứng · Confluence"
          title="Dow (rolling) + RSI cắt 40/60"
          sub="Pivot chỉ được dùng sau khi đã xác nhận đủ 4 phiên — không nhìn trước tương lai."
        >
          {confl ? (
            <>
              <div className="kv">
                <span>Số lần khớp</span>
                <span className="num">{confl.n}</span>
              </div>
              <div className="kv">
                <span>Tỷ lệ dương sau 12 phiên</span>
                <span className="num">{confl.winRate}%</span>
              </div>
              <div className="kv">
                <span>Kết quả TB (đơn vị vol-proxy)</span>
                <span className="num">{confl.avgR}R</span>
              </div>
            </>
          ) : (
            <p className="sub">Không có lần khớp nào trên lịch sử.</p>
          )}
        </Panel>
      </div>
      <Warn>
        Giới hạn: (1) chưa tính phí giao dịch/thuế; (2) pivot cần 4 phiên xác
        nhận nên nhận diện mẫu hình luôn có độ trễ; (3) mẫu vài chục lần là nhỏ
        về mặt thống kê; (4) lịch sử vnstock qua nguồn KBS có thể không sâu như
        10 năm — mẫu ngắn hơn thì xác suất kém tin cậy hơn.
      </Warn>
    </>
  );
}

/* ============================================================
   14. CMT — LỚP 7: TỔNG HỢP & KẾ HOẠCH
   ============================================================ */

function SummaryLayer({ cfg, model, hist, digits, goLayer, goHurst }) {
  const [openRow, setOpenRow] = useState(null);
  const pb = model.playbook;
  const gate = model.tradeGate;
  const curDir =
    hist && hist.swings && hist.swings.cur
      ? hist.swings.cur.dir
      : pb.biasPct >= 50
      ? "up"
      : "down";
  const an = hist ? hist.analog : null;
  const sys = hist ? hist.system : null;
  const sw = hist ? hist.swings : null;
  const vol = model.vol;
  const fx = (v) => v.toLocaleString("vi-VN", { maximumFractionDigits: digits });

  const biasBranch = pb.bias === "up" ? "A" : pb.bias === "down" ? "B" : "C";
  let plan = { branch: "C", mode: "wait", agree: false };
  if (an) {
    const maxP = Math.max(an.pA, an.pB, an.pC);
    const probBranch = maxP === an.pA ? "A" : maxP === an.pB ? "B" : "C";
    const agree = probBranch === biasBranch;
    if (agree && probBranch !== "C" && maxP >= 45)
      plan = { branch: probBranch, mode: "follow", agree: true, p: maxP };
    else if (agree && probBranch === "C")
      plan = { branch: "C", mode: "range", agree: true, p: maxP };
    else if (maxP >= 60)
      plan = { branch: probBranch, mode: "follow", agree: false, p: maxP };
    else plan = { branch: "C", mode: "wait", agree: false, p: maxP };
  }
  const planB = pb.branches.find((b) => b.id === plan.branch) || pb.branches[2];
  const trigLevel =
    plan.branch === "A" ? pb.R : plan.branch === "B" ? pb.S : null;
  const distA = Math.abs(pb.R - pb.last),
    distB = Math.abs(pb.S - pb.last);
  const barsToA = vol ? Math.max(1, Math.round(distA / vol)) : null;
  const barsToB = vol ? Math.max(1, Math.round(distB / vol)) : null;
  const pfv = (x) => (x === "∞" ? 1e9 : parseFloat(x));
  const filterAdds =
    sys && sys.sys.n >= 10 && sys.raw.n >= 10
      ? pfv(sys.sys.pf) > pfv(sys.raw.pf)
      : null;
  const swOld =
    sw && sw.cur && sw.cur.pctBars != null &&
    (sw.cur.pctBars >= 75 || sw.cur.pctAmpl >= 75);
  const swYoung =
    sw && sw.cur && sw.cur.pctBars != null &&
    sw.cur.pctBars <= 25 && sw.cur.pctAmpl <= 25;

  const planTitle =
    plan.mode === "follow"
      ? `Theo dõi kích hoạt Nhánh ${plan.branch} — ${
          plan.branch === "A"
            ? `chờ đóng cửa trên ${fx(pb.R)}`
            : `chờ đóng cửa dưới ${fx(pb.S)}`
        }`
      : plan.mode === "range"
      ? `Giao dịch trong biên ${fx(pb.S)} – ${fx(pb.R)} (Nhánh C) theo điều kiện fade`
      : "Đứng ngoài quan sát — bằng chứng và xác suất chưa đồng thuận";

  const planSteps =
    plan.mode === "follow"
      ? [
          `Chưa làm gì trước khi có nến đóng ${
            plan.branch === "A" ? "trên" : "dưới"
          } ${fx(trigLevel)} — chạm trong phiên KHÔNG tính.`,
          "Khi kích hoạt: xác nhận volume ≥1.3× TB20 phiên rồi mới vào; ưu tiên chờ hồi (pullback) hơn đuổi giá.",
          "Khối lượng lấy từ bước 4 (rủi ro cố định theo vol-proxy, kiểm tra double-risk nếu đang giữ mã khác cùng ngành).",
          `Vô hiệu & thoát: ${planB.invalid}`,
        ]
      : plan.mode === "range"
      ? [
          "Chỉ fade tại biên khi có nến từ chối + RSI cực trị.",
          `Chốt dần ở giữa biên ${fx((pb.R + pb.S) / 2)}; mục tiêu biên đối diện.`,
          "Bỏ toàn bộ kế hoạch range ngay khi có nến đóng ngoài biên — chuyển sang nhánh A/B tương ứng.",
        ]
      : [
          `Không mở vị thế mới trên ${cfg.label} cho đến khi: (1) có nến đóng ngoài biên, hoặc (2) xác suất analog và cán cân bằng chứng cùng chỉ về một nhánh.`,
          "Trong lúc chờ: theo dõi danh sách bên dưới, cập nhật lại app mỗi ngày sau khi thị trường đóng cửa (~15:00).",
        ];

  const watch = [
    {
      ok: true,
      txt: `Trigger A tại ${fx(pb.R)} — cách ${(
        (distA / pb.last) *
        100
      ).toFixed(
        2
      )}% (~${barsToA} phiên di chuyển trung bình). Trigger B tại ${fx(
        pb.S
      )} — cách ${((distB / pb.last) * 100).toFixed(2)}% (~${barsToB} phiên).`,
    },
    ...(an
      ? [
          {
            ok: true,
            txt: `Xác suất analog tính cho cửa sổ ${an.horizon} phiên tới (A ${an.pA}% · B ${an.pB}% · C ${an.pC}%, mẫu ${an.n} lần) — hết cửa sổ mà chưa nhánh nào nổ thì trạng thái đã đổi, đọc lại từ đầu.`,
          },
        ]
      : []),
    ...(sw && sw.cur
      ? [
          {
            ok: !swOld,
            txt: swOld
              ? `Sóng ${
                  sw.cur.dir === "up" ? "tăng" : "giảm"
                } hiện tại đã GIÀ (dài hơn ${
                  sw.cur.pctBars
                }% sóng lịch sử) — ưu tiên canh pivot kết thúc sóng hơn là đu theo.`
              : swYoung
              ? `Sóng hiện tại còn trẻ (${sw.cur.bars} phiên, ~P${sw.cur.pctBars}) — dư địa thống kê còn nếu các lớp đồng pha.`
              : `Sóng hiện tại ${sw.cur.bars} phiên (~P${sw.cur.pctBars} lịch sử) — vùng giữa phân phối, trung tính.`,
          },
        ]
      : []),
    ...(model.div.type
      ? [
          {
            ok: false,
            txt: `${model.div.txt} — nếu giá tiến về trigger thuận chiều phân kỳ thì tin cậy tăng, ngược chiều thì cảnh giác.`,
          },
        ]
      : []),
    {
      ok: model.volConfirm && model.volConfirm.ratio >= 1.3,
      txt: model.volConfirm
        ? `Volume gần nhất ${model.volConfirm.ratio.toFixed(1)}× TB20 phiên — ${
            model.volConfirm.ratio >= 1.3
              ? "dòng tiền đang mạnh, hỗ trợ kịch bản đang theo"
              : "chưa có dấu hiệu dòng tiền bất thường, chờ volume xác nhận trước khi vào lệnh lớn"
          }.`
        : "Chưa đủ dữ liệu volume để xác nhận.",
    },
    {
      ok: true,
      txt: "Báo cáo tài chính quý / ĐHCĐ / chia cổ tức có thể tạo biến động bất thường ngoài mô hình kỹ thuật — kiểm tra lịch sự kiện doanh nghiệp trước khi vào lệnh lớn (app chưa có nguồn lịch này).",
    },
  ];

  const ifThen = [
    {
      ev: `Nến đóng cửa trên ${fx(pb.R)}`,
      re: `Nhánh A kích hoạt${
        an ? ` (analog ${an.pA}%)` : ""
      }: chờ volume xác nhận rồi mua theo hồi; target ${fx(pb.tA1)} → ${fx(
        pb.tA2
      )}; vô hiệu nếu đóng lại dưới ${fx(pb.R)}.`,
      layer: 4,
    },
    {
      ev: `Nến đóng cửa dưới ${fx(pb.S)}`,
      re: `Nhánh B kích hoạt${
        an ? ` (analog ${an.pB}%)` : ""
      }: bán theo hồi; target ${fx(pb.tB1)} → ${fx(
        pb.tB2
      )}; vô hiệu nếu đóng lại trên ${fx(pb.S)}.`,
      layer: 4,
    },
    {
      ev: `Chạm ${fx(pb.R)} rồi đóng cửa quay xuống`,
      re: "Từ chối tại biên → điều kiện fade của nhánh C; cũng là cảnh báo false break cho ai mua đuổi.",
      layer: 4,
    },
    {
      ev: `Chạm ${fx(pb.S)} rồi đóng cửa bật lên`,
      re: `Từ chối tại biên dưới → fade nhánh C chiều mua; mục tiêu giữa biên ${fx(
        (pb.R + pb.S) / 2
      )}.`,
      layer: 4,
    },
    {
      ev: "Xuất hiện pivot mới (sóng hiện tại kết thúc)",
      re: "Biên S–R và toàn bộ kịch bản được tính lại — mở lại bước 1 xem xu hướng mới, bước 6 xem tuổi sóng reset.",
      layer: 0,
    },
    {
      ev: "Volume tăng vọt bất thường (>2× TB20) không kèm tin gì rõ",
      re: "Có thể là dòng tiền lớn (tổ chức/tự doanh) vào trước thông tin — theo dõi sát 1-2 phiên tới, đừng vào lệnh ngược dòng tiền lớn.",
      layer: 3,
    },
    {
      ev: "Báo cáo tài chính quý / tin doanh nghiệp lớn ra",
      re: "Không hành động trong phiên có tin; chỉ đánh giá lại sau khi nến đóng, vì tin có thể đẩy giá qua trigger chỉ do phản ứng ngắn hạn.",
      layer: 0,
    },
    ...(an
      ? [
          {
            ev: `Hết ${an.horizon} phiên mà giá vẫn kẹt trong biên`,
            re: "Kịch bản C đã đúng — nhưng trạng thái analog cũng đã cũ: chạy lại phân tích từ đầu, không tái sử dụng xác suất cũ.",
            layer: 0,
          },
        ]
      : []),
  ];

  return (
    <>
      <Panel
        mod="Tổng hợp · Kế hoạch chính"
        title={planTitle}
        sub="Suy ra tự động từ: xác suất analog lịch sử × cán cân bằng chứng 5 lớp (kể cả volume) × chất lượng hệ thống đã kiểm chứng × tuổi sóng. Mọi con số bấm được về đúng bước sinh ra nó."
      >
        {!hist && (
          <p className="sub">
            Đang tính lịch sử — xác suất analog và kiểm chứng hệ thống sẽ hiện
            sau vài giây…
          </p>
        )}
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}
        >
          {an && (
            <Chip cls={plan.agree ? "up" : "side"}>
              {plan.agree
                ? `Analog và bằng chứng CÙNG chỉ về nhánh ${biasBranch}`
                : `Analog (${plan.branch}) và bằng chứng (${biasBranch}) đang LỆCH nhau — lý do khiến kế hoạch thận trọng`}
            </Chip>
          )}
          {an && (
            <Chip cls="mut">
              Analog: A {an.pA}% · B {an.pB}% · C {an.pC}% (n={an.n})
            </Chip>
          )}
          <Chip cls={pb.bias}>Bằng chứng: {pb.biasPct}% nghiêng tăng</Chip>
          {filterAdds != null && (
            <Chip cls={filterAdds ? "up" : "down"}>
              {filterAdds
                ? `Bộ lọc CMT ĐÃ cộng giá trị trên ${cfg.label} (PF ${sys.sys.pf} vs ${sys.raw.pf})`
                : `Bộ lọc CMT CHƯA hơn breakout thuần trên ${cfg.label} (PF ${sys.sys.pf} vs ${sys.raw.pf}) → hạ kỳ vọng, sizing nhỏ lại`}
            </Chip>
          )}
        </div>
        <ol
          style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 7, fontSize: 13 }}
        >
          {planSteps.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="bt" onClick={() => goLayer(4)}>
            Mở chi tiết kịch bản (bước 5)
          </button>
          <button className="bt" onClick={() => goLayer(3)}>
            Tính khối lượng (bước 4)
          </button>
          <button className="bt" onClick={() => goLayer(5)}>
            Xem kiểm chứng (bước 6)
          </button>
        </div>
      </Panel>

      <Panel
        mod="Bàn giao · CMT → Hurst"
        title="Đối chiếu trạng thái CMT với Hurst"
        sub="Quy trình: CMT đưa ra trạng thái (breakout hoặc trong biên) và hướng; sang tab Hurst để đối chiếu — Hurst có đồng ý regime không, chỉ báo (kể cả volume) nghiêng cùng hướng không."
      >
        {gate.active ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <Chip cls={gate.dir === "long" ? "up" : "down"}>
                ● CMT: BREAKOUT {gate.dir === "long" ? "LÊN — LONG" : "XUỐNG — CẢNH BÁO (không short)"}
              </Chip>
              <Chip cls="mut">
                Phá {gate.dir === "long" ? "lên trên" : "xuống dưới"}{" "}
                {fx(gate.level)} từ {gate.sinceDate} · đã đi{" "}
                {gate.distPct.toFixed(2)}%
              </Chip>
              {gate.conflict && (
                <Chip cls="side">
                  ⚠ Breakout ngược cán cân bằng chứng ({pb.biasPct}%) — rủi ro
                  false break
                </Chip>
              )}
            </div>
            <button
              className="bt"
              style={{ borderColor: gate.dir === "long" ? CLR.bull : CLR.bear, color: CLR.text, fontWeight: 700 }}
              onClick={goHurst}
            >
              {gate.dir === "long"
                ? "⚡ Đối chiếu với Hurst (Trend) →"
                : "⚡ Xem Hurst — tham khảo rủi ro nếu đang giữ →"}
            </button>
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <Chip cls="side">● CMT: ĐANG TRONG BIÊN</Chip>
              <Chip cls="mut">
                Biên {fx(gate.S)} – {fx(gate.R)} · còn{" "}
                {gate.distPct != null ? gate.distPct.toFixed(2) : "—"}% là chạm
                biên {gate.nextDir === "long" ? "trên" : "dưới"}
              </Chip>
            </div>
            <button
              className="bt"
              style={{ borderColor: CLR.amber, color: CLR.text, fontWeight: 700 }}
              onClick={goHurst}
            >
              ⚡ Đối chiếu với Hurst (Range) →
            </button>
          </>
        )}
      </Panel>

      <Panel
        mod="Tổng hợp · Theo dõi"
        title="Vài ngày tới cần quan tâm"
        sub="Danh sách canh me sinh tự động từ trạng thái hiện tại — xem lại mỗi ngày sau khi đóng cửa."
      >
        {watch.map((w, i) => (
          <div key={i} className="rule" style={{ padding: "5px 0", alignItems: "flex-start" }}>
            <span className={w.ok ? "ok" : "no"} style={{ marginTop: 2 }}>
              {w.ok ? "•" : "⚠"}
            </span>
            <span>{w.txt}</span>
          </div>
        ))}
      </Panel>

      <Panel
        mod="Tổng hợp · Nếu — thì"
        title="Cây phản ứng theo tình huống"
        sub="Quyết định trước khi chuyện xảy ra — đến lúc xảy ra chỉ việc thực hiện, không suy nghĩ lại giữa chừng."
      >
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: "32%" }}>Nếu…</th>
                <th>Thì…</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ifThen.map((r, i) => (
                <tr key={i}>
                  <td style={{ verticalAlign: "top" }}>
                    <b style={{ fontSize: 12.5 }}>{r.ev}</b>
                  </td>
                  <td style={{ color: "#b9c4dc", verticalAlign: "top" }}>{r.re}</td>
                  <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>
                    <button
                      className="bt"
                      style={{ padding: "3px 8px", fontSize: 10.5 }}
                      onClick={() => goLayer(r.layer)}
                    >
                      Mở bước
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Warn>
        Trang này tổng hợp máy móc từ các bước 1–6 trên dữ liệu giá & khối
        lượng thật của {cfg.label}. Xác suất là tần suất quá khứ, không phải
        cam kết tương lai; kế hoạch là khung theo dõi có điều kiện, quyết định
        vào lệnh và chịu rủi ro là của bạn.
      </Warn>
    </>
  );
}

/* ============================================================
   15. TAB HURST — MÔ PHỎNG HIỆU SUẤT
   ============================================================ */

function MetricBox({ label, value, sub, color }) {
  return (
    <div
      style={{
        background: "#1a2440",
        border: `1px solid ${CLR.line}`,
        borderRadius: 12,
        padding: "10px 14px",
        minWidth: 150,
      }}
    >
      <div style={{ fontSize: 10.5, color: CLR.mut, textTransform: "uppercase", letterSpacing: 0.6 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 20, color: color || CLR.blue, marginTop: 2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: CLR.mut, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function computeConfirm(d, cmtRegime, cmtDir) {
  const H = d.hurstNow;
  const phase = d.todayPhase;
  const familyNet = cmtRegime === "TREND" ? d.trendNetToday : d.rangeNetToday;
  let regimeMatch = "mixed";
  if (phase === cmtRegime) regimeMatch = "match";
  else if (phase === "OTHER") regimeMatch = "unclear";
  else regimeMatch = "conflict";
  // netDir "down" là NGHIÊNG GIẢM của chỉ báo (thông tin tham khảo/cảnh báo),
  // không phải một lệnh short — TTCK VN không bán khống.
  const netDir = familyNet > 0.05 ? "long" : familyNet < -0.05 ? "down" : "flat";
  const dirMatch =
    cmtDir === "side"
      ? netDir !== "flat"
        ? "lean"
        : "flat"
      : netDir === cmtDir
      ? "match"
      : netDir === "flat"
      ? "weak"
      : "conflict";
  let verdict, vcls;
  if (regimeMatch === "match" && dirMatch === "match") {
    verdict = "Hurst XÁC NHẬN CMT";
    vcls = cmtDir === "long" ? "up" : cmtDir === "down" ? "down" : "side";
  } else if (regimeMatch === "conflict") {
    verdict = "Hurst MÂU THUẪN về regime";
    vcls = "down";
  } else if (regimeMatch === "match" && dirMatch === "conflict") {
    verdict = "Hurst đồng ý regime nhưng NGƯỢC hướng";
    vcls = "side";
  } else if (regimeMatch === "match" && dirMatch === "lean") {
    verdict = `Hurst đồng ý regime · chỉ báo nghiêng ${netDir === "long" ? "Tăng" : "Giảm"}`;
    vcls = netDir === "long" ? "up" : "down";
  } else if (regimeMatch === "match") {
    verdict = "Hurst đồng ý regime, hướng chưa rõ";
    vcls = "side";
  } else {
    verdict = "Hurst chưa rõ regime";
    vcls = "mut";
  }
  return { H, phase, familyNet, regimeMatch, netDir, dirMatch, verdict, vcls };
}

const REGIME_STRAT = {
  TREND: {
    name: "Pullback theo Trend (Long)",
    desc: "Chỉ mua khi có xu hướng tăng + phiên giá lùi ngược (không mở lệnh khi xu hướng giảm — TTCK VN không bán khống); bám 22 chỉ báo Trend (kể cả 2 chỉ báo volume).",
  },
  RANGE: {
    name: "Mua đáy biên (Long-only)",
    desc: "Chỉ mua khi đồng thuận oscillator chạm cực trị đáy biên; KHÔNG bán khống ở đỉnh biên — tại đỉnh biên chỉ dùng làm tín hiệu chốt lời nếu đang giữ. Bám 20 chỉ báo Oscillator.",
  },
};

function HurstTab({ cfg, dir, opts, setOpts, detail, capital, riskPctIn, gate }) {
  const [profitView, setProfitView] = React.useState("combined");
  if (!detail)
    return (
      <Panel mod="Hurst" title="Đang chạy walk-forward…" sub="Đối chiếu trạng thái CMT với Hurst cho mã đang chọn." />
    );
  const d = detail;
  const setOpt = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const cmtRegime = gate && gate.active ? "TREND" : "RANGE";
  const cmtDir =
    gate && gate.active ? gate.dir : gate && gate.nextDir ? gate.nextDir : "side";
  const conf = computeConfirm(d, cmtRegime, cmtDir);
  const isTrend = cmtRegime === "TREND";
  const strat = REGIME_STRAT[cmtRegime];
  const regChip = (m) =>
    m === "match" ? "up" : m === "conflict" ? "down" : m === "unclear" || m === "mixed" ? "side" : "mut";
  const netPct = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;

  return (
    <>
      <Panel
        mod="Đối chiếu · CMT ↔ Hurst"
        title={`CMT nói ${
          cmtRegime === "TREND" ? `BREAKOUT ${cmtDir === "long" ? "LÊN (LONG)" : "XUỐNG (CẢNH BÁO — không short)"}` : "ĐANG TRONG BIÊN"
        } — Hurst có đồng ý không?`}
        sub="Hurst kiểm tra chính trạng thái CMT đưa ra: regime có khớp không (phase Hurst + hệ số H), và họ chỉ báo tương ứng (kể cả 2 chỉ báo volume) nghiêng hướng nào."
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <Chip cls={conf.vcls}>● {conf.verdict}</Chip>
          {gate && gate.active && gate.conflict && (
            <Chip cls="side">⚠ Breakout còn ngược cán cân bằng chứng CMT — thận trọng</Chip>
          )}
        </div>
        <div className="grid3">
          <div className="scen" style={{ margin: 0 }}>
            <b>1 · CMT đưa ra</b>
            <div className="kv">
              <span>Regime</span>
              <span className="num">{cmtRegime === "TREND" ? "Breakout / Trend" : "Trong biên / Range"}</span>
            </div>
            <div className="kv">
              <span>Hướng</span>
              <span
                className="num"
                style={{ color: cmtDir === "long" ? CLR.bull : cmtDir === "down" ? CLR.bear : CLR.amber }}
              >
                {cmtDir === "long" ? "Long" : cmtDir === "down" ? "Giảm (không có lệnh)" : "Trung tính"}
              </span>
            </div>
            <div className="kv" style={{ border: "none" }}>
              <span>Nguồn</span>
              <span style={{ color: CLR.mut }}>
                {gate && gate.active ? `phá ${gate.level.toLocaleString("vi-VN")}` : "giá trong biên 40 phiên"}
              </span>
            </div>
          </div>
          <div className="scen" style={{ margin: 0 }}>
            <b>2 · Hurst đo regime</b>
            <div className="kv">
              <span>Phase Hurst</span>
              <span
                className="num"
                style={{ color: conf.phase === "TREND" ? CLR.bull : conf.phase === "RANGE" ? CLR.amber : CLR.mut }}
              >
                {conf.phase === "TREND" ? "TREND" : conf.phase === "RANGE" ? "RANGE" : "Chưa rõ"}
              </span>
            </div>
            <div className="kv">
              <span>Hệ số Hurst (H)</span>
              <span className="num">
                {conf.H != null ? conf.H.toFixed(2) : "—"}{" "}
                {conf.H != null ? (conf.H > 0.5 ? "(>0.5 trend)" : "(<0.5 range)") : ""}
              </span>
            </div>
            <div className="kv" style={{ border: "none" }}>
              <span>Khớp regime CMT?</span>
              <span>
                <Chip cls={regChip(conf.regimeMatch)}>
                  {conf.regimeMatch === "match" ? "KHỚP" : conf.regimeMatch === "conflict" ? "NGƯỢC" : "chưa rõ"}
                </Chip>
              </span>
            </div>
          </div>
          <div className="scen" style={{ margin: 0 }}>
            <b>3 · Chỉ báo Hurst ({isTrend ? "Trend + Volume" : "Oscillator"})</b>
            <div className="kv">
              <span>Net đồng thuận</span>
              <span className="num" style={{ color: conf.familyNet > 0 ? CLR.bull : conf.familyNet < 0 ? CLR.bear : CLR.mut }}>
                {netPct(conf.familyNet)} ({conf.netDir === "long" ? "Long" : conf.netDir === "down" ? "Giảm" : "phẳng"})
              </span>
            </div>
            <div className="kv">
              <span>So với hướng CMT</span>
              <span>
                <Chip cls={conf.dirMatch === "match" ? "up" : conf.dirMatch === "conflict" ? "down" : "side"}>
                  {conf.dirMatch === "match" ? "CÙNG" : conf.dirMatch === "conflict" ? "NGƯỢC" : conf.dirMatch === "lean" ? "có lean" : "yếu"}
                </Chip>
              </span>
            </div>
            <div className="kv" style={{ border: "none" }}>
              <span>Chiến lược khớp</span>
              <span style={{ color: CLR.mut }}>{strat.name}</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        mod="Hurst · Tham số mô phỏng"
        title="Vốn & rủi ro của bạn"
        sub="Áp cho backtest và mô phỏng tài khoản. TTCK VN không có bán khống nên toàn bộ hệ thống chỉ mở lệnh Mua (Long) — khi CMT báo breakdown, hệ thống đứng ngoài thay vì mở lệnh ngược. TP nay tính theo khung tháng nên 'Giữ tối đa' cần đủ rộng để mục tiêu có cơ hội chạm tới."
      >
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="lb">Vốn ban đầu (VND)</label>
            <input
              className="inp"
              style={{ width: 140 }}
              type="number"
              min="1000000"
              value={capital.value}
              onChange={(e) => capital.set(Math.max(1000000, +e.target.value || 100000000))}
            />
          </div>
          <div>
            <label className="lb">Rủi ro mỗi lệnh (%)</label>
            <input
              className="inp"
              style={{ width: 90 }}
              type="number"
              step="0.25"
              min="0.1"
              max="5"
              value={riskPctIn.value}
              onChange={(e) => riskPctIn.set(Math.max(0.1, Math.min(5, +e.target.value || 1)))}
            />
          </div>
          <div>
            <label className="lb">Chu kỳ ATR</label>
            <input
              className="inp"
              style={{ width: 80 }}
              type="number"
              min="3"
              max="60"
              value={opts.atrPeriod}
              onChange={(e) => setOpt("atrPeriod", Math.max(3, Math.min(60, +e.target.value || 14)))}
            />
          </div>
          <div>
            <label className="lb">Hệ số SL (×ATR) — luật Trend/Range</label>
            <input
              className="inp"
              style={{ width: 80 }}
              type="number"
              step="0.1"
              min="0.5"
              max="6"
              value={opts.slMult}
              onChange={(e) => setOpt("slMult", Math.max(0.5, Math.min(6, +e.target.value || 2)))}
            />
          </div>
          <div>
            <label className="lb">Cắt lỗ (%) — luật CMT×Hurst tháng</label>
            <input
              className="inp"
              style={{ width: 80 }}
              type="number"
              step="1"
              min="2"
              max="30"
              value={Math.round(opts.stopPct * 100)}
              onChange={(e) =>
                setOpt("stopPct", Math.max(2, Math.min(30, +e.target.value || 10)) / 100)
              }
            />
          </div>
          <div>
            <label className="lb">R:R tối thiểu — luật CMT×Hurst</label>
            <input
              className="inp"
              style={{ width: 80 }}
              type="number"
              step="0.1"
              min="0.5"
              max="5"
              value={opts.minRR}
              onChange={(e) => setOpt("minRR", Math.max(0.5, Math.min(5, +e.target.value || 1.0)))}
            />
          </div>
          <div>
            <label className="lb">Walk-forward folds</label>
            <input
              className="inp"
              style={{ width: 80 }}
              type="number"
              min="2"
              max="12"
              value={opts.wfFolds}
              onChange={(e) => setOpt("wfFolds", Math.max(2, Math.min(12, +e.target.value || 5)))}
            />
          </div>
          <div>
            <label className="lb">Giữ tối đa (phiên) — luật tháng</label>
            <input
              className="inp"
              style={{ width: 90 }}
              type="number"
              min="20"
              max="500"
              value={opts.cardMaxHold}
              onChange={(e) => setOpt("cardMaxHold", Math.max(20, Math.min(500, +e.target.value || 120)))}
            />
          </div>
          <div>
            <label className="lb">Hướng giao dịch</label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: 33,
                padding: "0 10px",
                border: `1px solid ${CLR.line}`,
                borderRadius: 8,
                color: CLR.bull,
                fontWeight: 700,
                fontSize: 13,
              }}
              title="TTCK VN không hỗ trợ bán khống — toàn bộ hệ thống chỉ tính lệnh Mua (Long)"
            >
              Chỉ Long
            </div>
          </div>
        </div>
      </Panel>

      {(() => {
        const pv = d.profitViews;
        const VIEWS = {
          trend: {
            label: "Chỉ theo Trend",
            data: pv.trendOnly,
            color: CLR.bull,
            note: "Chỉ chạy chiến lược trend pullback (2 chiều), bất kể CMT đang range hay trend.",
          },
          range: {
            label: "Chỉ theo Range (Oscillator)",
            data: pv.rangeOnly,
            color: CLR.amber,
            note: "Chỉ chạy oscillator fade 2 đầu biên, bất kể CMT đang range hay trend.",
          },
          combined: {
            label: `Theo regime CMT (${cfg.label})`,
            data: pv.combined,
            color: CLR.blue,
            note: `Chỉ tính trên đúng mã ${cfg.label}. Mỗi phiên xét regime CMT của mã này: breakout → trend pullback; trong biên → oscillator fade.`,
          },
          buyhold: {
            label: "Mua & Giữ (Buy & Hold)",
            data: { equity: pv.buyHold.equity },
            color: "#9aa5c0",
            note: "Đối chứng bắt buộc cho cổ phiếu: mua từ đầu kỳ OOS rồi giữ nguyên, không giao dịch gì thêm. Mọi chiến lược ở trên phải thắng được đường này mới đáng cân nhắc.",
            isBuyHold: true,
          },
        };
        const cur = VIEWS[profitView];
        const s = cur.isBuyHold
          ? {
              totalReturnPct: pv.buyHold.totalReturnPct,
              maxDDPct: pv.buyHold.maxDDPct,
              blown: false,
              finalMultiple: 1 + pv.buyHold.totalReturnPct / 100,
            }
          : cur.data.sim;
        const ts = cur.isBuyHold
          ? { sharpe: pv.buyHold.sharpe, count: null, hitRate: NaN, avgHoldDays: null }
          : cur.data.tradeStats;
        const wl = cur.isBuyHold ? null : cur.data.winLoss;
        const moneyEq = cur.data.equity.map((e) => ({ d: e.d, v: capital.value * (1 + e.cum / 100) }));
        const byDate = {};
        ["trend", "range", "combined", "buyhold"].forEach((k) =>
          VIEWS[k].data.equity.forEach((p) => {
            (byDate[p.d] = byDate[p.d] || { d: p.d })[k] = p.cum;
          })
        );
        const overlay = Object.values(byDate);
        const endCum = (k) => {
          const eq = VIEWS[k].data.equity;
          return eq.length ? eq[eq.length - 1].cum : 0;
        };
        return (
          <Panel
            mod="Hurst · Lợi nhuận (4 góc nhìn)"
            title={`${cfg.label} — chỉ Trend · chỉ Range · theo regime CMT · so với Mua & Giữ`}
            sub={`Rủi ro CỐ ĐỊNH ${riskPctIn.value}%/lệnh trên vốn gốc ${fmtMoney(
              capital.value
            )} (không dồn lãi). SL = ATR(${opts.atrPeriod})×${opts.slMult.toFixed(
              1
            )}, walk-forward ngoài mẫu từ ${pv.oosFromDate}. Trong kỳ OOS: trend ${pv.pctTrendTime.toFixed(
              0
            )}% thời gian · range ${pv.pctRangeTime.toFixed(0)}%.`}
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {["trend", "range", "combined", "buyhold"].map((k) => (
                <button
                  key={k}
                  className="bt"
                  onClick={() => setProfitView(k)}
                  style={
                    profitView === k
                      ? { borderColor: VIEWS[k].color, color: CLR.text, fontWeight: 700 }
                      : {}
                  }
                >
                  {VIEWS[k].label}{" "}
                  <span className="num" style={{ color: endCum(k) >= 0 ? CLR.bull : CLR.bear, marginLeft: 4 }}>
                    {endCum(k) >= 0 ? "+" : ""}
                    {endCum(k).toFixed(0)}%
                  </span>
                </button>
              ))}
            </div>
            <div className="sub" style={{ marginBottom: 4 }}>
              So sánh cộng dồn OOS (%) — cả 4 góc nhìn, kể cả Mua & Giữ
            </div>
            <div style={{ width: "100%", height: 190 }}>
              <ResponsiveContainer>
                <LineChart data={overlay} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={CLR.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="d"
                    tick={{ fill: CLR.dim, fontSize: 9 }}
                    tickLine={false}
                    axisLine={{ stroke: CLR.line }}
                    minTickGap={60}
                    tickFormatter={(x) => (x ? x.slice(0, 7) : "")}
                  />
                  <YAxis
                    tick={{ fill: CLR.dim, fontSize: 9, fontFamily: "IBM Plex Mono" }}
                    width={44}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                  />
                  <ReferenceLine y={0} stroke={CLR.line} />
                  <Tooltip
                    contentStyle={TT}
                    formatter={(v, nm) => [`${v.toFixed(1)}%`, VIEWS[nm] ? VIEWS[nm].label : nm]}
                  />
                  <Line dataKey="trend" stroke={CLR.bull} dot={false} strokeWidth={profitView === "trend" ? 2.2 : 1} strokeOpacity={profitView === "trend" ? 1 : 0.4} isAnimationActive={false} connectNulls />
                  <Line dataKey="range" stroke={CLR.amber} dot={false} strokeWidth={profitView === "range" ? 2.2 : 1} strokeOpacity={profitView === "range" ? 1 : 0.4} isAnimationActive={false} connectNulls />
                  <Line dataKey="combined" stroke={CLR.blue} dot={false} strokeWidth={profitView === "combined" ? 2.2 : 1} strokeOpacity={profitView === "combined" ? 1 : 0.4} isAnimationActive={false} connectNulls />
                  <Line dataKey="buyhold" stroke="#9aa5c0" strokeDasharray="5 4" dot={false} strokeWidth={profitView === "buyhold" ? 2.2 : 1} strokeOpacity={profitView === "buyhold" ? 1 : 0.5} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="sub" style={{ margin: "8px 0 12px" }}>{cur.note}</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <MetricBox
                label="Tổng lợi nhuận OOS"
                value={s.blown ? "⚠ Cháy TK" : `${s.totalReturnPct >= 0 ? "+" : ""}${s.totalReturnPct.toFixed(1)}%`}
                color={s.totalReturnPct >= 0 ? CLR.bull : CLR.bear}
                sub={s.blown ? "" : fmtMoney(capital.value * s.finalMultiple)}
              />
              <MetricBox
                label={cur.isBuyHold ? "Sharpe (theo ngày)" : "Sharpe (theo lệnh)"}
                value={isFinite(ts.sharpe) ? ts.sharpe.toFixed(2) : "—"}
                sub={cur.isBuyHold ? "nắm giữ toàn kỳ, không có lệnh rời rạc" : `${ts.count} lệnh · giữ TB ${ts.avgHoldDays ? ts.avgHoldDays.toFixed(1) : "—"} phiên`}
              />
              {!cur.isBuyHold && (
                <MetricBox label="Tỷ lệ thắng" value={isFinite(ts.hitRate) ? ts.hitRate.toFixed(0) + "%" : "—"} />
              )}
              <MetricBox label="Max Drawdown" value={`${s.maxDDPct.toFixed(1)}%`} color={CLR.bear} sub={fmtMoney((capital.value * Math.abs(s.maxDDPct)) / 100)} />
              {!cur.isBuyHold && (
                <MetricBox label="% lệnh dừng SL" value={isFinite(s.stoppedOutPct) ? s.stoppedOutPct.toFixed(0) + "%" : "—"} />
              )}
            </div>
            {cur.isBuyHold && (
              <Warn>
                Mua & Giữ không có lệnh dừng lỗ, không "quét SL" — đây là mốc
                tối thiểu mọi chiến lược chủ động phải vượt qua (sau rủi ro và
                công sức bỏ ra) mới đáng làm thay vì chỉ mua rồi để đó.
              </Warn>
            )}
            <div className="sub" style={{ marginBottom: 4 }}>
              Giá trị tài khoản — {cur.label} (vốn {fmtMoney(capital.value)})
            </div>
            <div style={{ width: "100%", height: 160 }}>
              <ResponsiveContainer>
                <LineChart data={moneyEq} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                  <Line dataKey="v" stroke={cur.color} dot={false} strokeWidth={1.8} isAnimationActive={false} />
                  <XAxis dataKey="d" hide />
                  <YAxis hide domain={["auto", "auto"]} />
                  <ReferenceLine y={capital.value} stroke={CLR.line} label={{ value: "vốn gốc", fill: CLR.mut, fontSize: 10, position: "insideBottomLeft" }} />
                  <Tooltip contentStyle={TT} formatter={(v) => [fmtMoney(v), "Giá trị tài khoản (OOS)"]} labelStyle={{ color: CLR.blue }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {!cur.isBuyHold && wl && (
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table className="tbl" style={{ minWidth: 620 }}>
                  <thead>
                    <tr>
                      <th></th>
                      <th>N</th>
                      <th>Min</th>
                      <th>Trung vị</th>
                      <th>TB</th>
                      <th>Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ color: CLR.bull, fontWeight: 800 }}>Lệnh THẮNG (đ/cp)</td>
                      <td className="num">{wl.win ? wl.win.n : 0}</td>
                      <td className="num" style={{ color: CLR.bull }}>{wl.win ? priceTxt(wl.win.min) : "—"}</td>
                      <td className="num" style={{ color: CLR.bull }}>{wl.win ? priceTxt(wl.win.median) : "—"}</td>
                      <td className="num" style={{ color: CLR.bull, fontWeight: 700 }}>{wl.win ? priceTxt(wl.win.mean) : "—"}</td>
                      <td className="num" style={{ color: CLR.bull }}>{wl.win ? priceTxt(wl.win.max) : "—"}</td>
                    </tr>
                    <tr>
                      <td style={{ color: CLR.bear, fontWeight: 800 }}>Lệnh THUA (đ/cp)</td>
                      <td className="num">{wl.loss ? wl.loss.n : 0}</td>
                      <td className="num" style={{ color: CLR.bear }}>{wl.loss ? priceTxt(wl.loss.min) : "—"}</td>
                      <td className="num" style={{ color: CLR.bear }}>{wl.loss ? priceTxt(wl.loss.median) : "—"}</td>
                      <td className="num" style={{ color: CLR.bear, fontWeight: 700 }}>{wl.loss ? priceTxt(wl.loss.mean) : "—"}</td>
                      <td className="num" style={{ color: CLR.bear }}>{wl.loss ? priceTxt(wl.loss.max) : "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="sub" style={{ marginTop: 10, fontSize: 11 }}>
              ⚠ Walk-forward ngoài mẫu, quét TP/SL bằng High/Low thật trong
              phiên (không chỉ giá đóng cửa), chưa trừ phí/thuế/trượt giá. Rủi
              ro cố định trên vốn gốc (không dồn lãi) nên đây là % cộng dồn
              tuyến tính, không phải tăng trưởng kép của tài khoản thật.
            </p>
          </Panel>
        );
      })()}

      {(() => {
        const cb = d.cardBacktest;
        if (!cb) return null;
        const s = cb.sim,
          ts = cb.tradeStats,
          wl = cb.winLoss;
        const scenName = {
          RUN_UP: "Mua theo pullback ngày, tháng đang breakout",
          IN_RANGE: "Mua theo pullback ngày, tháng đang trong biên",
        };
        const scenRows = Object.entries(cb.byScen).sort((a, b) => b[1].n - a[1].n);
        const reasonVN = { tp: "chạm TP", tp_partial: "chạm TP (bán 50%)", sl: "dính SL", flip: "CMT cảnh báo giảm", timeout: "hết hạn giữ" };
        const stateVN2 = { RUN_UP: "breakout tháng", IN_RANGE: "trong biên tháng" };
        return (
          <Panel
            mod="Hurst · Backtest theo luật CMT × Trend"
            title={`${cfg.label} — nếu bám đúng luật thì lời/lỗ ra sao?`}
            sub={`Luật: (1) CMT xác định hướng + TP trên KHUNG THÁNG (tháng trước đã đóng) · (2) Hurst chọn bộ chỉ báo Trend/Range của ngày quyết định · (3) xuống khung ngày GOM lệnh mỗi khi bộ chỉ báo đồng thuận mua + giá vừa giảm + còn đủ R:R (không giới hạn số lần, giá vào tính trung bình). Cắt lỗ cứng ${Math.round(
              opts.stopPct * 100
            )}% trên giá vào TB, chỉ gom khi TP ≥ ${opts.minRR.toFixed(
              1
            )}× khoảng cách SL. Chạm TP: bán 50%, phần còn lại chạy tiếp tới khi dính SL hoặc khung tháng chuyển kịch bản giảm. Vốn ${fmtMoney(capital.value)}, rủi ro ${riskPctIn.value}%/lệnh. Mô phỏng nhân quả từ ${cb.oosFromDate}.`}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 12,
                padding: "10px 12px",
                border: `1px solid ${CLR.line}`,
                borderRadius: 10,
                background: "#1a2440",
              }}
            >
              {cb.live.active ? (
                <>
                  <Chip cls="up">
                    ● Đang giữ từ {cb.live.entryDate}
                    {cb.live.openedToday ? " (MỚI HÔM NAY)" : ` (${cb.live.daysHeld} phiên)`}
                  </Chip>
                  <Chip cls={cb.live.addedToday ? "up" : "mut"}>
                    Đã gom {cb.live.numAdds} lần{cb.live.addedToday ? " · THÊM HÔM NAY" : ""} · lần gần nhất {cb.live.lastAddDate}
                  </Chip>
                  <Chip cls="mut">
                    Vào TB {cb.live.entryPrice.toLocaleString("vi-VN")} · SL{" "}
                    {cb.live.stop.toLocaleString("vi-VN")} · TP{" "}
                    {cb.live.tp != null ? cb.live.tp.toLocaleString("vi-VN") : "đã bán 50% — chạy tiếp"}
                  </Chip>
                  <Chip cls={cb.live.unrealizedPct >= 0 ? "up" : "down"}>
                    Tạm tính {cb.live.unrealizedPct >= 0 ? "+" : ""}
                    {cb.live.unrealizedPct.toFixed(1)}% ({cb.live.unrealizedR.toFixed(2)}R)
                  </Chip>
                  <Chip cls="mut">
                    Bối cảnh: {stateVN2[cb.live.cmtState] || cb.live.cmtState}
                    {cb.live.partialDone && " · đã bán 50%, đang chạy tiếp"}
                  </Chip>
                </>
              ) : (
                <>
                  <Chip cls="side">● Đang chờ tín hiệu — chưa có lệnh mở</Chip>
                  {cb.live.lastExit && (
                    <Chip cls={cb.live.lastExit.R >= 0 ? "up" : "down"}>
                      Lệnh gần nhất đóng {cb.live.lastExit.date} (đã gom {cb.live.lastExit.numAdds} lần) —{" "}
                      {reasonVN[cb.live.lastExit.reason] || cb.live.lastExit.reason} (
                      {cb.live.lastExit.R >= 0 ? "+" : ""}
                      {cb.live.lastExit.R.toFixed(2)}R)
                      {cb.live.lastExit.exitedToday ? " · HÔM NAY" : ""}
                    </Chip>
                  )}
                </>
              )}
            </div>
            {cb.trades.length < 5 ? (
              <Warn>
                Chỉ có {cb.trades.length} lệnh trong giai đoạn mô phỏng — quá
                ít để kết luận.
              </Warn>
            ) : (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <MetricBox
                    label="Tổng lợi nhuận OOS"
                    value={s.blown ? "⚠ Cháy TK" : `${s.totalReturnPct >= 0 ? "+" : ""}${s.totalReturnPct.toFixed(1)}%`}
                    color={s.totalReturnPct >= 0 ? CLR.bull : CLR.bear}
                    sub={s.blown ? "" : fmtMoney(capital.value * s.finalMultiple)}
                  />
                  <MetricBox label="Số lệnh" value={ts.count} sub={`giữ TB ${ts.avgHoldDays ? ts.avgHoldDays.toFixed(1) : "—"} phiên`} />
                  <MetricBox label="Tỷ lệ thắng" value={isFinite(ts.hitRate) ? ts.hitRate.toFixed(0) + "%" : "—"} />
                  <MetricBox label="Sharpe (theo lệnh)" value={isFinite(ts.sharpe) ? ts.sharpe.toFixed(2) : "—"} />
                  <MetricBox label="Max Drawdown" value={`${s.maxDDPct.toFixed(1)}%`} color={CLR.bear} />
                  <MetricBox
                    label="So với Mua & Giữ"
                    value={`${s.totalReturnPct - cb.buyHold.totalReturnPct >= 0 ? "+" : ""}${(
                      s.totalReturnPct - cb.buyHold.totalReturnPct
                    ).toFixed(1)}%`}
                    color={s.totalReturnPct >= cb.buyHold.totalReturnPct ? CLR.bull : CLR.bear}
                    sub={`Mua & Giữ cùng kỳ: ${cb.buyHold.totalReturnPct >= 0 ? "+" : ""}${cb.buyHold.totalReturnPct.toFixed(1)}%`}
                  />
                </div>
                <div className="sub" style={{ marginBottom: 4 }}>
                  Đường vốn (OOS, walk-forward causal) — nét liền là chiến
                  lược, nét đứt là chỉ mua & giữ
                </div>
                <div style={{ width: "100%", height: 150 }}>
                  <ResponsiveContainer>
                    <LineChart
                      data={(() => {
                        const byD = {};
                        cb.equity.forEach((e) => {
                          (byD[e.d] = byD[e.d] || { d: e.d }).strat =
                            capital.value * (1 + e.cum / 100);
                        });
                        cb.buyHold.equity.forEach((e) => {
                          (byD[e.d] = byD[e.d] || { d: e.d }).bh =
                            capital.value * (1 + e.cum / 100);
                        });
                        return Object.values(byD);
                      })()}
                      margin={{ top: 4, right: 6, bottom: 0, left: 0 }}
                    >
                      <Line dataKey="strat" name="Chiến lược" stroke={CLR.blue} dot={false} strokeWidth={1.8} isAnimationActive={false} connectNulls />
                      <Line dataKey="bh" name="Mua & Giữ" stroke="#9aa5c0" strokeDasharray="5 4" dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls />
                      <XAxis dataKey="d" hide />
                      <YAxis hide domain={["auto", "auto"]} />
                      <ReferenceLine y={capital.value} stroke={CLR.line} label={{ value: "vốn gốc", fill: CLR.mut, fontSize: 10, position: "insideBottomLeft" }} />
                      <Tooltip contentStyle={TT} formatter={(v, nm) => [fmtMoney(v), nm === "strat" ? "Chiến lược" : "Mua & Giữ"]} labelStyle={{ color: CLR.blue }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid2" style={{ marginTop: 14 }}>
                  <div>
                    <div className="sub" style={{ marginBottom: 4 }}>Theo bối cảnh CMT tháng lúc vào</div>
                    <table className="tbl">
                      <thead>
                        <tr><th>Loại lệnh</th><th>Số</th><th>Thắng</th><th>Tổng R</th></tr>
                      </thead>
                      <tbody>
                        {scenRows.map(([k, v]) => (
                          <tr key={k}>
                            <td>{scenName[k] || k}</td>
                            <td className="num">{v.n}</td>
                            <td className="num" style={{ color: v.win / v.n >= 0.5 ? CLR.bull : CLR.bear }}>
                              {Math.round((v.win / v.n) * 100)}%
                            </td>
                            <td className="num" style={{ color: v.R >= 0 ? CLR.bull : CLR.bear }}>
                              {v.R >= 0 ? "+" : ""}{v.R.toFixed(1)}R
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <div className="sub" style={{ marginBottom: 4 }}>Theo đoạn thời gian (walk-forward)</div>
                    <table className="tbl">
                      <thead>
                        <tr><th>Đoạn</th><th>Từ</th><th>Số</th><th>Thắng</th><th>Tổng R</th></tr>
                      </thead>
                      <tbody>
                        {cb.foldStats.map((f) => (
                          <tr key={f.fold}>
                            <td>#{f.fold}</td>
                            <td className="num">{f.from ? f.from.slice(0, 7) : "—"}</td>
                            <td className="num">{f.n}</td>
                            <td className="num">{f.hit != null ? f.hit + "%" : "—"}</td>
                            <td className="num" style={{ color: f.totR >= 0 ? CLR.bull : CLR.bear }}>
                              {f.totR >= 0 ? "+" : ""}{f.totR}R
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </Panel>
        );
      })()}

      <Panel
        mod="Hurst · Xếp hạng chỉ báo"
        title={`${cfg.label} — họ chỉ báo ${isTrend ? "TREND (kể cả Volume)" : "OSCILLATOR"}`}
        sub={`Dữ liệu ${d.n.toLocaleString("vi-VN")} phiên, ${d.dates[0]} → ${d.lastDate}. Đang tô đậm họ ${
          isTrend ? "Trend-following" : "Oscillator/mean-reversion"
        } vì CMT ở regime ${cmtRegime}. Thanh mờ = biến thể đảo chiều.`}
      >
        <div style={{ width: "100%", height: Math.max(420, (isTrend ? d.trendResults : d.rangeResults).length * 19) }}>
          <ResponsiveContainer>
            <BarChart data={isTrend ? d.trendResults : d.rangeResults} layout="vertical" margin={{ top: 6, right: 20, bottom: 0, left: 10 }}>
              <CartesianGrid stroke={CLR.line} strokeDasharray="2 4" horizontal={false} />
              <XAxis type="number" tick={{ fill: CLR.mut, fontSize: 10 }} />
              <YAxis type="category" dataKey="label" tick={{ fill: CLR.text, fontSize: 10 }} width={170} />
              <ReferenceLine x={0} stroke={CLR.mut} />
              <Tooltip contentStyle={TT} formatter={(v, n2, pl) => [`Sharpe ${v.toFixed(2)} (số lệnh=${pl.payload.activeN})`, ""]} />
              <Bar dataKey="sharpe" isAnimationActive={false}>
                {(isTrend ? d.trendResults : d.rangeResults).map((row, i) => (
                  <Cell key={i} fill={row.sharpe >= 0 ? (isTrend ? CLR.bull : CLR.amber) : CLR.bear} fillOpacity={row.inv ? 0.55 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Warn>
        Hurst ở đây là lớp ĐỐI CHIẾU cho lệnh CMT: khớp regime + hướng thì tăng
        độ tin, ngược thì cảnh báo. Số backtest đo "quy tắc như đã cài đặt"
        trên giá đóng cửa thật, chưa trừ phí/thuế/trượt giá. Quyết định vào
        lệnh vẫn dựa trên phân tích CMT ở tab bên cạnh. Không phải khuyến nghị
        đầu tư.
      </Warn>
    </>
  );
}

/* ============================================================
   16. TRÌNH CMT (7 bước) — bọc quanh 1 mã
   ============================================================ */

function buildCMTModel(closes, volumes, dates, cfg, highs, lows) {
  const H_ = highs || closes,
    L_ = lows || closes;
  const wk = aggWeekly(closes, dates);
  const mo = aggMonthly(closes, dates);
  const wkHL = aggWeeklyHL(H_, L_, dates);
  const moHL = aggMonthlyHL(H_, L_, dates);
  wk.highs = wkHL.highs;
  wk.lows = wkHL.lows;
  wk.ma50 = sma(wk.closes, 50);
  wk.ma200 = sma(wk.closes, 200);
  mo.highs = moHL.highs;
  mo.lows = moHL.lows;
  mo.ma50 = sma(mo.closes, 50);
  mo.ma200 = sma(mo.closes, 200);
  const pivD = pivots(closes, 4, highs, lows);
  const pivW = pivots(wk.closes, 2, wkHL.highs, wkHL.lows);
  const pivM = pivots(mo.closes, 2, moHL.highs, moHL.lows);
  const dW = dowTrend(pivW),
    dD = dowTrend(pivD),
    dM = dowTrend(pivM);
  const frames = {
    M: { trend: dM.trend, detail: dM.detail },
    W: { trend: dW.trend, detail: dW.detail },
    D: { trend: dD.trend, detail: dD.detail },
    consensus: dW.trend === dD.trend && dD.trend !== "side",
    fullAlign: dM.trend === dW.trend && dW.trend === dD.trend && dD.trend !== "side",
  };
  const cascade = stepDownCascade(closes, dates, highs, lows);

  // Kịch bản (Elliott, mẫu hình, Playbook A/B/C) tính trên khung THÁNG — ổn
  // định hơn tuần/ngày, biên độ đủ rộng để TP không bị sát ngay lúc vào
  // lệnh. Riêng lớp xác nhận (Module 3: RSI/MACD/MA) và giá "hiện tại" vẫn
  // lấy từ khung ngày, vì đó là trạng thái tức thời cần theo dõi từng phiên.
  const av = volProxy(closes).slice(-1)[0] ?? 0;
  const avM = volProxy(mo.closes).slice(-1)[0] ?? 0;
  const winMonths = Math.min(96, mo.closes.length);
  const winCloses = mo.closes.slice(-winMonths),
    winDates = mo.dates.slice(-winMonths);
  const winHighs = mo.highs.slice(-winMonths),
    winLows = mo.lows.slice(-winMonths);
  const pivWin = pivots(winCloses, 1, winHighs, winLows);
  const patterns = detectPatterns(winCloses, pivWin, avM * 3, cfg.digits);
  const scens = elliottScenarios(pivWin, cfg.digits);

  const rsiArr = rsi(closes),
    macdArr = macd(closes),
    stochArr = stochClose(closes);
  const ma50 = sma(closes, 50),
    ma200 = sma(closes, 200);
  const strength = trendStrength(closes);
  const div = rsiDivergence(closes, rsiArr, pivD);

  const vma20 = sma(volumes, 20);
  const lastVolRatio = vma20[vma20.length - 1] ? volumes[volumes.length - 1] / vma20[vma20.length - 1] : 1;
  const volConfirm = {
    ratio: lastVolRatio,
    up: closes[closes.length - 1] > closes[closes.length - 2],
  };

  // buildPlaybook nhận `closes` đầy đủ khung ngày (để "last" = giá hiện tại
  // thật) nhưng `piv` là pivot THÁNG — R/S/target/kịch bản A·B·C theo đó đều
  // ở khung tháng, chỉ vị trí giá hiện tại được cập nhật theo từng phiên.
  const playbook = buildPlaybook({
    closes,
    piv: pivWin.map((p) => ({ ...p })),
    frames,
    rsiArr,
    macdArr,
    scens,
    patterns,
    volConfirm,
    ma50,
    ma200,
    strength,
    div,
    digits: cfg.digits,
  });

  const lastC = closes[closes.length - 1];
  const w40H = H_.slice(-41, -1),
    w40L = L_.slice(-41, -1);
  const R40 = Math.max(...w40H),
    S40 = Math.min(...w40L);
  const band40 = Math.max(R40 - S40, 1e-9);
  // TTCK VN không bán khống — tradeGate.dir chỉ có "long" (breakout lên, có
  // thể mua) hoặc "down" (breakout xuống — CẢNH BÁO, không mở lệnh mới,
  // chỉ để tham khảo cho người đang cầm hàng cân nhắc thoát/cắt lỗ).
  let tradeGate = {
    active: false,
    dir: null,
    state: "IN_RANGE",
    level: null,
    R: R40,
    S: S40,
    sinceDate: null,
    distPct: null,
    conflict: false,
  };
  const findBreakDate = (above) => {
    let j = closes.length - 1;
    while (j > 1) {
      const wj = above ? H_.slice(Math.max(0, j - 41), j - 1) : L_.slice(Math.max(0, j - 41), j - 1);
      if (!wj.length) break;
      const rj = above ? Math.max(...wj) : null,
        sj = !above ? Math.min(...wj) : null;
      const out = above ? closes[j - 1] > rj : closes[j - 1] < sj;
      if (!out) break;
      j--;
    }
    return dates[Math.min(closes.length - 1, j)];
  };
  if (lastC > R40)
    tradeGate = {
      active: true,
      dir: "long",
      state: "RUN_UP",
      level: R40,
      R: R40,
      S: S40,
      sinceDate: findBreakDate(true),
      distPct: ((lastC - R40) / lastC) * 100,
      conflict: playbook.bias === "down",
    };
  else if (lastC < S40)
    tradeGate = {
      active: true,
      dir: "down",
      state: "RUN_DOWN",
      level: S40,
      R: R40,
      S: S40,
      sinceDate: findBreakDate(false),
      distPct: ((S40 - lastC) / lastC) * 100,
      conflict: playbook.bias === "up",
    };
  else {
    const near = Math.min(R40 - lastC, lastC - S40) / band40 < 0.15;
    tradeGate.state = near ? "NEAR_TRIGGER" : "IN_RANGE";
    tradeGate.distPct = (Math.min(R40 - lastC, lastC - S40) / lastC) * 100;
    tradeGate.nextDir = lastC - S40 > R40 - lastC ? "long" : "down";
  }

  const lastRSI = rsiArr[rsiArr.length - 1],
    lastM = macdArr[macdArr.length - 1];
  const confirmOK =
    (dD.trend === "up" && lastRSI > 50 && lastM.macd > lastM.signal) ||
    (dD.trend === "down" && lastRSI < 50 && lastM.macd < lastM.signal);
  const verdicts = [
    dD.trend === "side" ? "side" : dD.trend,
    scens.length ? scens[0].dir : "side",
    confirmOK ? (dD.trend === "side" ? "side" : dD.trend) : "side",
    "side",
    playbook.bias,
    "side",
    playbook.bias,
  ];
  return {
    closes,
    volumes,
    dates,
    wk,
    mo,
    frames,
    pivD,
    pivW,
    pivM,
    cascade,
    patterns,
    scens,
    rsiArr,
    macdArr,
    stochArr,
    ma50,
    ma200,
    strength,
    div,
    volConfirm,
    playbook,
    tradeGate,
    winCloses,
    winDates,
    winHighs,
    winLows,
    verdicts,
    vol: highs && lows ? (atrTrue(highs, lows, closes, 14).slice(-1)[0] ?? av) : av,
    volIsTrueATR: !!(highs && lows),
    digits: cfg.digits,
  };
}

/* ============================================================
   17. ROOT
   ============================================================ */

export default function App() {
  const [vn30, setVn30] = useState(null);
  const [batchData, setBatchData] = useState(null); // { SYM: {dates,closes,opens,highs,lows,volumes} }
  const [status, setStatus] = useState("loading");
  const [progress, setProgress] = useState("");
  const [reload, setReload] = useState(0);

  const [view, setView] = useState("screener");
  const [stockKey, setStockKey] = useState("VNM");
  const [layer, setLayer] = useState(6);
  const [tf, setTf] = useState("D");
  // TTCK VN không bán khống — không cần state chọn hướng, luôn là Long.

  const [capital, setCapital] = useState(100000000);
  const [riskPctIn, setRiskPctIn] = useState(1);
  const [opts, setOpts] = useState({
    hurstWin: 128,
    hurstStep: 5,
    testInverse: true,
    wfFolds: 5,
    hurstFilterMode: "gated",
    atrPeriod: 14,
    slMult: 2,
    stopPct: 0.1,
    minRR: 1.0,
    minTrendStrength: 0,
    minPullbackATR: 0,
    rangeEnterThr: 0.2,
    cardMaxHold: 120,
  });

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    (async () => {
      try {
        setProgress("Đang tải danh sách VN30…");
        const symbols = await fetchVN30();
        if (!alive) return;
        setVn30(symbols);
        setProgress(`Đang tải lịch sử ${symbols.length} mã (có thể mất 20–60s lần đầu)…`);
        const batch = await fetchBatchHistory(symbols, HISTORY_START, todayISO());
        if (!alive) return;
        const parsed = {};
        for (const sym of symbols) {
          const entry = batch[sym];
          if (entry && entry.ok) parsed[sym] = normalizeRows(entry.data);
        }
        setBatchData(parsed);
        setStatus("ok");
        setProgress("");
      } catch (e) {
        if (!alive) return;
        setStatus("err");
        setProgress(String(e.message || e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  const screenOpts = useMemo(
    () => ({
      atrPeriod: opts.atrPeriod,
      slMult: opts.slMult,
      stopPct: opts.stopPct,
      minRR: opts.minRR,
      riskPct: Math.max(0.1, riskPctIn) / 100,
      hurstWin: opts.hurstWin,
      hurstStep: opts.hurstStep,
      cardMaxHold: opts.cardMaxHold,
    }),
    [opts.atrPeriod, opts.slMult, opts.stopPct, opts.minRR, riskPctIn, opts.hurstWin, opts.hurstStep, opts.cardMaxHold]
  );

  const screener = useMemo(() => {
    if (!batchData) return null;
    const rows = [];
    for (const sym of Object.keys(batchData)) {
      const d = batchData[sym];
      if (!d.closes || d.closes.length < 250) continue;
      const cfg = { key: sym, label: sym, digits: 0 };
      rows.push(screenStock(cfg, d.closes, d.volumes, d.dates, screenOpts, d.highs, d.lows));
    }
    return rows.sort((a, b) => b.score - a.score);
  }, [batchData, screenOpts]);

  const cfg = { key: stockKey, label: stockKey, digits: 0 };
  const stockData = batchData ? batchData[stockKey] : null;

  const model = useMemo(() => {
    if (!stockData || !stockData.closes || stockData.closes.length < 260) return null;
    return buildCMTModel(stockData.closes, stockData.volumes, stockData.dates, cfg, stockData.highs, stockData.lows);
  }, [stockData, stockKey]);

  const hist = useMemo(() => {
    if (!stockData || !stockData.closes || stockData.closes.length < 260) return null;
    const { closes, dates, highs, lows } = stockData;
    const states = buildStates(closes, highs, lows);
    return {
      closes,
      dates,
      events: scanPatternHistory(closes, dates, highs, lows),
      rule: scanBreakoutRule(closes, highs, lows),
      confl: backtestConfluenceRolling(closes, highs, lows),
      analog: analogProbabilities(closes, states),
      system: backtestSystem(closes, highs, lows, dates),
      swings: scanSwings(closes, dates, highs, lows),
    };
  }, [stockData]);

  const gate = model ? model.tradeGate : null;
  const resolvedDir = "long"; // TTCK VN chỉ có chiều mua

  const hurstOpts = useMemo(() => ({ ...opts, riskPct: Math.max(0.1, riskPctIn) / 100 }), [opts, riskPctIn]);
  const hurstCache = useRef(new Map());
  const detail = useMemo(() => {
    if (!stockData || view !== "hurst") return null;
    if (!stockData.closes || stockData.closes.length < 260) return null;
    const key = `${stockKey}|${JSON.stringify(hurstOpts)}`;
    if (hurstCache.current.has(key)) return hurstCache.current.get(key);
    const res = runHurstAnalysis(
      stockData.closes,
      stockData.volumes,
      stockData.dates,
      hurstOpts,
      resolvedDir,
      cfg.digits,
      stockData.highs,
      stockData.lows
    );
    if (hurstCache.current.size > 8) hurstCache.current.clear();
    hurstCache.current.set(key, res);
    return res;
  }, [stockData, view, stockKey, resolvedDir, hurstOpts]);

  const openStockCMT = useCallback((key) => {
    setStockKey(key);
    setView("cmt");
    setLayer(6);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  if (status === "err") {
    return (
      <div className="fxapp">
        <style>{CSS}</style>
        <div className="loading">
          <b>Không tải được dữ liệu từ backend</b>
          <p className="sub">{progress || "Kiểm tra backend Render / kết nối mạng rồi thử lại."}</p>
          <button className="bt" onClick={() => setReload((r) => r + 1)}>Thử lại</button>
        </div>
      </div>
    );
  }
  if (status !== "ok" || !batchData || !screener) {
    return (
      <div className="fxapp">
        <style>{CSS}</style>
        <div className="loading">
          <div className="spin" />
          <span>{progress || "Đang tải…"}</span>
        </div>
      </div>
    );
  }

  if (!stockData || !stockData.closes || stockData.closes.length < 260 || !model) {
    return (
      <div className="fxapp">
        <style>{CSS}</style>
        <div className="loading">
          <b>Chưa đủ dữ liệu lịch sử cho {stockKey}</b>
          <p className="sub">
            Cần tối thiểu ~260 phiên (1 năm) để phân tích CMT/Hurst đầy đủ.
            Nguồn KBS có thể chưa đủ sâu cho mã này.
          </p>
          <button className="bt" onClick={() => { setStockKey("VNM"); setView("screener"); }}>
            Về Screener
          </button>
        </div>
      </div>
    );
  }

  const lastPrice = stockData.closes[stockData.closes.length - 1];
  const pbBias = model.playbook.bias;
  const pbBiasPct = model.playbook.biasPct;
  const tfCloses = tf === "M" ? model.mo.closes : tf === "W" ? model.wk.closes : stockData.closes;
  const tfDates = tf === "M" ? model.mo.dates : tf === "W" ? model.wk.dates : stockData.dates;
  const tfHighs = tf === "M" ? model.mo.highs : tf === "W" ? model.wk.highs : stockData.highs;
  const tfLows = tf === "M" ? model.mo.lows : tf === "W" ? model.wk.lows : stockData.lows;
  const tfPiv = tf === "M" ? model.pivM : tf === "W" ? model.pivW : model.pivD;

  const STEPS = [
    { t: "Xu hướng", s: "Dow · MA · Volume" },
    { t: "Cấu trúc giá", s: "Elliott · patterns · Fib" },
    { t: "Xác nhận", s: "Momentum · Volume · phân kỳ" },
    { t: "Rủi ro", s: "Sizing · tương quan" },
    { t: "Kịch bản giao dịch", s: "If-then · trigger · vô hiệu" },
    { t: "Kiểm chứng lịch sử", s: "Mẫu hình quá khứ · độ chính xác" },
    { t: "Tổng hợp & kế hoạch", s: "Kế hoạch chính · canh gì · nếu-thì" },
  ];
  const vLabel = { up: "Thuận", down: "Nghịch", side: "Theo dõi" };

  // rổ để hiển thị ma trận tương quan trong RiskLayer — lấy tối đa 10 mã có dữ liệu
  const matrixKeys = Object.keys(batchData)
    .filter((k) => batchData[k].closes && batchData[k].closes.length > 60)
    .slice(0, 10);
  const allClosesForMatrix = {};
  matrixKeys.forEach((k) => (allClosesForMatrix[k] = batchData[k].closes));

  return (
    <div className="fxapp">
      <style>{CSS}</style>
      <header className="topbar">
        <div className="brand">
          VN·CMT × HURST
          <small>Bộ lọc tín hiệu CMT · phân tích top-down · mô phỏng hiệu suất</small>
        </div>
        {view !== "screener" && (
          <>
            <select
              className="pair"
              value={stockKey}
              onChange={(e) => setStockKey(e.target.value)}
            >
              {(vn30 || []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span className="num" style={{ fontSize: 14, fontWeight: 600 }}>
              {lastPrice.toLocaleString("vi-VN")}
            </span>
            <Chip cls={pbBias}>Cán cân {pbBiasPct}% tăng</Chip>
          </>
        )}
      </header>

      <div className="tabs">
        <button className={`tab ${view === "screener" ? "on" : ""}`} onClick={() => setView("screener")}>
          🔍 Bộ lọc VN30
        </button>
        <button className={`tab ${view === "cmt" ? "on" : ""}`} onClick={() => setView("cmt")}>
          📐 Phân tích CMT ({stockKey})
        </button>
        <button className={`tab ${view === "hurst" ? "on" : ""}`} onClick={() => setView("hurst")}>
          {gate && gate.active ? (
            <span style={{ color: gate.dir === "long" ? CLR.bull : CLR.bear }}>●</span>
          ) : (
            "○"
          )}{" "}
          Hurst — đối chiếu CMT ({stockKey})
        </button>
      </div>

      {view === "screener" && (
        <div className="main" style={{ maxWidth: 1240, margin: "0 auto", width: "100%" }}>
          <ScreenerSection rows={screener} openStock={openStockCMT} />
        </div>
      )}

      {view === "cmt" && model && (
        <div className="layout">
          <nav className="rail">
            <div className="railhead">Trình tự phân tích CMT</div>
            {STEPS.map((st, i) => (
              <button key={i} className={`step ${layer === i ? "on" : ""}`} onClick={() => setLayer(i)}>
                <span className="stepline">
                  <span className={`dot ${model.verdicts[i]}`} />
                  {i < STEPS.length - 1 && <span className="vline" />}
                </span>
                <span>
                  <span className="steptitle">{i + 1}. {st.t}</span>
                  <span className="stepsub" style={{ display: "block" }}>
                    {st.s} ·{" "}
                    <b style={{ color: model.verdicts[i] === "up" ? CLR.bull : model.verdicts[i] === "down" ? CLR.bear : CLR.amber }}>
                      {vLabel[model.verdicts[i]]}
                    </b>
                  </span>
                </span>
              </button>
            ))}
            <div className="confl">
              <b>Tổng hợp confluence</b>
              <p className="sub" style={{ margin: "6px 0 0" }}>
                Cán cân {model.playbook.biasPct}% nghiêng tăng ({model.playbook.bullScore}✓ tăng ·{" "}
                {model.playbook.bearScore}✓ giảm). Chi tiết if-then ở bước 7.
              </p>
            </div>
          </nav>
          <main className="main">
            {layer === 0 && (
              <TrendLayer
                cfg={cfg}
                tf={tf}
                setTf={setTf}
                frames={model.frames}
                dates={tfDates}
                closes={tfCloses}
                highs={tfHighs}
                lows={tfLows}
                volumes={stockData.volumes}
                digits={cfg.digits}
                piv={tfPiv}
                cascade={model.cascade}
              />
            )}
            {layer === 1 && (
              <StructureLayer
                key={stockKey}
                swings={hist ? hist.swings : null}
                dates={model.winDates}
                closes={model.winCloses}
                highs={model.winHighs}
                lows={model.winLows}
                digits={cfg.digits}
                patterns={model.patterns}
                scens={model.scens}
              />
            )}
            {layer === 2 && (
              <ConfirmLayer
                dates={stockData.dates}
                closes={stockData.closes}
                volumes={stockData.volumes}
                rsiArr={model.rsiArr}
                macdArr={model.macdArr}
                stochArr={model.stochArr}
                bt={backtestConfluenceRolling(stockData.closes, stockData.highs, stockData.lows)}
                trendD={model.frames.D.trend}
                div={model.div}
              />
            )}
            {layer === 3 && (
              <RiskLayer
                allCloses={allClosesForMatrix}
                matrixKeys={matrixKeys}
                vol={model.vol}
                volIsTrueATR={model.volIsTrueATR}
                cfg={cfg}
                digits={cfg.digits}
                lastPrice={lastPrice}
              />
            )}
            {layer === 4 && (
              <PlaybookLayer
                cfg={cfg}
                pb={model.playbook}
                dates={model.winDates}
                closes={model.winCloses}
                highs={model.winHighs}
                lows={model.winLows}
                digits={cfg.digits}
                ma50={model.mo.ma50.slice(-model.winCloses.length)}
                ma200={model.mo.ma200.slice(-model.winCloses.length)}
                goLayer={setLayer}
                analog={hist ? hist.analog : null}
              />
            )}
            {layer === 5 && <HistoryLayer cfg={cfg} hist={hist} digits={cfg.digits} />}
            {layer === 6 && (
              <SummaryLayer
                cfg={cfg}
                model={model}
                hist={hist}
                digits={cfg.digits}
                goLayer={setLayer}
                goHurst={() => setView("hurst")}
              />
            )}
            <div className="foot" style={{ border: `1px solid ${CLR.line}`, borderRadius: 12 }}>
              Nguồn thật: giá & khối lượng khớp lệnh từ vnstock (nguồn KBS) qua
              backend FastAPI riêng — không phải toàn thị trường, chỉ rổ VN30.
              Công cụ hỗ trợ quyết định theo khung CMT — không phải tín hiệu
              mua/bán.
            </div>
          </main>
        </div>
      )}

      {view === "hurst" && (
        <div className="main" style={{ maxWidth: 1180, margin: "0 auto", width: "100%" }}>
          <HurstTab
            cfg={cfg}
            dir={resolvedDir}
            opts={opts}
            setOpts={setOpts}
            detail={detail}
            capital={{ value: capital, set: setCapital }}
            riskPctIn={{ value: riskPctIn, set: setRiskPctIn }}
            gate={gate}
          />
        </div>
      )}
    </div>
  );
}
