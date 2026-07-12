import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default function App() {
  const [symbol, setSymbol] = useState("VNM");
  const [start, setStart] = useState(todayISO(-180));
  const [end, setEnd] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function fetchHistory(e) {
    e?.preventDefault();
    setLoading(true);
    setError("");
    setRows([]);
    try {
      const url = `${API_URL}/api/stock/${symbol.trim().toUpperCase()}?start=${start}&end=${end}&interval=1D`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Lỗi ${res.status}`);
      }
      const data = await res.json();
      setRows(data);
    } catch (err) {
      setError(err.message || "Không lấy được dữ liệu");
    } finally {
      setLoading(false);
    }
  }

  const chartData = rows.map((r) => ({
    time: (r.time || r.date || "").toString().slice(0, 10),
    close: r.close,
  }));

  return (
    <div className="app">
      <header>
        <h1>VN Stock Viewer</h1>
        <p className="subtitle">FastAPI + vnstock demo — React frontend</p>
      </header>

      <form className="controls" onSubmit={fetchHistory}>
        <label>
          Mã CK
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="VNM, VCB, HPG..."
            maxLength={10}
          />
        </label>
        <label>
          Từ ngày
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          Đến ngày
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? "Đang tải..." : "Xem dữ liệu"}
        </button>
      </form>

      {error && <div className="error">⚠ {error}</div>}

      {chartData.length > 0 && (
        <div className="chart-card">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a35" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={30} />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 11 }}
                width={60}
              />
              <Tooltip />
              <Line type="monotone" dataKey="close" stroke="#4fd1c5" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ngày</th>
                <th>Mở</th>
                <th>Cao</th>
                <th>Thấp</th>
                <th>Đóng</th>
                <th>KL</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().slice(0, 30).map((r, i) => (
                <tr key={i}>
                  <td>{(r.time || r.date || "").toString().slice(0, 10)}</td>
                  <td>{r.open}</td>
                  <td>{r.high}</td>
                  <td>{r.low}</td>
                  <td>{r.close}</td>
                  <td>{r.volume?.toLocaleString?.() ?? r.volume}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 30 && (
            <p className="table-note">Hiển thị 30 dòng gần nhất trong tổng số {rows.length} dòng.</p>
          )}
        </div>
      )}
    </div>
  );
}
