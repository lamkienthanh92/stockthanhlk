"""
VN Stock API — a thin FastAPI wrapper around vnstock, with a simple
in-memory TTL cache so you don't hammer the underlying data source
(and risk getting rate-limited / IP-blocked) every time the frontend
makes a request.

Run locally:
    pip install -r requirements.txt --break-system-packages
    uvicorn main:app --reload

Deploy: see ../README.md for Render instructions.
"""

import os
import time
import traceback
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from vnstock import Vnstock

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "900"))  # 15 minutes
SYMBOLS_CACHE_TTL_SECONDS = int(os.getenv("SYMBOLS_CACHE_TTL_SECONDS", "86400"))  # 1 day
DEFAULT_SOURCE = os.getenv("VNSTOCK_SOURCE", "KBS")

# VN30 — danh sách cố định (cập nhật tay khi HOSE công bố kỳ review mới).
# Dùng làm rổ mặc định cho Screener để tránh quét toàn thị trường (nhiều nghìn mã)
# gây quá tải backend free-tier.
VN30 = [
    "ACB", "BCM", "BID", "BVH", "CTG", "FPT", "GAS", "GVR", "HDB", "HPG",
    "MBB", "MSN", "MWG", "PLX", "POW", "SAB", "SHB", "SSB", "SSI", "STB",
    "TCB", "TPB", "VCB", "VHM", "VIB", "VIC", "VJC", "VNM", "VPB", "VRE",
]

app = FastAPI(title="VN Stock API", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Tiny in-memory TTL cache
# ---------------------------------------------------------------------------

_cache: dict[str, dict] = {}


def cache_get_or_set(key: str, ttl: int, loader):
    now = time.time()
    entry = _cache.get(key)
    if entry and now - entry["time"] < ttl:
        return entry["data"]
    data = loader()
    _cache[key] = {"data": data, "time": now}
    return data


def load_history(symbol: str, start: str, end: str, interval: str, source: str):
    symbol = symbol.upper()
    key = f"stock:{symbol}:{start}:{end}:{interval}:{source}"

    def loader():
        try:
            stock = Vnstock().stock(symbol=symbol, source=source)
            df = stock.quote.history(start=start, end=end, interval=interval)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            raise HTTPException(
                status_code=502,
                detail=f"vnstock error ({type(exc).__name__}): {exc}",
            ) from exc
        if df is None or df.empty:
            return []
        return df.to_dict(orient="records")

    return cache_get_or_set(key, CACHE_TTL_SECONDS, loader)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/vn30")
def get_vn30():
    """Danh sách mã VN30 dùng cho Screener."""
    return {"symbols": VN30}


@app.get("/api/stock/{symbol}")
def get_stock_history(
    symbol: str,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
    interval: str = Query("1D", description="1D, 1W, 1M"),
    source: str = Query(DEFAULT_SOURCE, description="KBS, VCI, TCBS, MSN, ..."),
):
    data = load_history(symbol, start, end, interval, source)
    if not data:
        raise HTTPException(status_code=404, detail=f"No data for symbol '{symbol}'")
    return data


class BatchRequest(BaseModel):
    symbols: List[str]
    start: str
    end: str
    interval: str = "1D"
    source: str = DEFAULT_SOURCE


@app.post("/api/batch")
def get_batch_history(req: BatchRequest):
    """
    Lấy lịch sử giá cho NHIỀU mã trong 1 lần gọi — dùng cho Screener (VN30)
    để tránh 30 request riêng lẻ từ frontend. Mỗi mã vẫn dùng cache TTL riêng
    (cache_get_or_set) nên các lần load lại sau sẽ rất nhanh.
    Mã nào lỗi thì trả về error cho mã đó, không làm hỏng cả batch.
    """
    out = {}
    for sym in req.symbols:
        sym_u = sym.upper()
        try:
            data = load_history(sym_u, req.start, req.end, req.interval, req.source)
            out[sym_u] = {"ok": True, "data": data}
        except HTTPException as exc:
            out[sym_u] = {"ok": False, "error": str(exc.detail)}
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            out[sym_u] = {"ok": False, "error": str(exc)}
    return out


@app.get("/api/index/{code}")
def get_index_history(
    code: str,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
):
    data = load_history(code, start, end, "1D", DEFAULT_SOURCE)
    if not data:
        raise HTTPException(status_code=404, detail=f"No data for index '{code}'")
    return data


@app.get("/api/symbols")
def list_symbols(exchange: Optional[str] = Query("HOSE,HNX,UPCOM")):
    key = f"symbols:{exchange}"

    def loader():
        try:
            from vnstock import Screener

            df = Screener().stock(params={"exchangeName": exchange}, limit=2000)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            raise HTTPException(status_code=502, detail=f"vnstock error ({type(exc).__name__}): {exc}") from exc
        if df is None or df.empty:
            raise HTTPException(status_code=404, detail="No symbols found")
        cols = [c for c in ["ticker", "exchange", "industry"] if c in df.columns]
        return df[cols].to_dict(orient="records") if cols else df.to_dict(orient="records")

    try:
        return cache_get_or_set(key, SYMBOLS_CACHE_TTL_SECONDS, loader)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
