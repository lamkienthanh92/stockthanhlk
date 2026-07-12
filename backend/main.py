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
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from vnstock import Vnstock

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Comma-separated list of allowed frontend origins, e.g.
# "https://your-app.netlify.app,http://localhost:5173"
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "900"))  # 15 minutes
SYMBOLS_CACHE_TTL_SECONDS = int(os.getenv("SYMBOLS_CACHE_TTL_SECONDS", "86400"))  # 1 day

app = FastAPI(title="VN Stock API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/stock/{symbol}")
def get_stock_history(
    symbol: str,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
    interval: str = Query("1D", description="1D, 1W, 1M"),
    source: str = Query("VCI", description="VCI, TCBS, MSN, ..."),
):
    symbol = symbol.upper()
    key = f"stock:{symbol}:{start}:{end}:{interval}:{source}"

    def loader():
        try:
            stock = Vnstock().stock(symbol=symbol, source=source)
            df = stock.quote.history(start=start, end=end, interval=interval)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"vnstock error: {exc}") from exc
        if df is None or df.empty:
            raise HTTPException(status_code=404, detail=f"No data for symbol '{symbol}'")
        return df.to_dict(orient="records")

    try:
        return cache_get_or_set(key, CACHE_TTL_SECONDS, loader)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/index/{code}")
def get_index_history(
    code: str,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
):
    code = code.upper()
    key = f"index:{code}:{start}:{end}"

    def loader():
        try:
            stock = Vnstock().stock(symbol=code, source="VCI")
            df = stock.quote.history(start=start, end=end)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"vnstock error: {exc}") from exc
        if df is None or df.empty:
            raise HTTPException(status_code=404, detail=f"No data for index '{code}'")
        return df.to_dict(orient="records")

    try:
        return cache_get_or_set(key, CACHE_TTL_SECONDS, loader)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/symbols")
def list_symbols(exchange: Optional[str] = Query("HOSE,HNX,UPCOM")):
    key = f"symbols:{exchange}"

    def loader():
        try:
            from vnstock import Screener

            df = Screener().stock(params={"exchangeName": exchange}, limit=2000)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"vnstock error: {exc}") from exc
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
