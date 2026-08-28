#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
akshare_bridge.py — local multi-source fallback for quant-mcp-server.

The Node MCP server is zero-dependency by design. This bridge is OPTIONAL:
the server only calls it when a usable Python (with `akshare`/`baostock`) is
detected at startup. If Python/akshare is absent, the server stays fully
functional on its built-in HTTP mirrors.

Contract:
  stdin  : one JSON object per line: {"method": <str>, "params": <obj>}
  stdout : one JSON object per line: the parsed payload, or {"__error__": <str>}

The Node side treats any __error__ / non-object / empty result as "this source
failed" and falls through to the next source.
"""
import sys, json

def _readline():
    line = sys.stdin.readline()
    if not line:
        return None
    try:
        return json.loads(line)
    except Exception:
        return None

def _out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def method_daily(params):
    """A-share daily OHLCV. akshare primary, baostock secondary."""
    import akshare as ak
    code = str(params.get("code", "")).strip()
    start = str(params.get("start", "20200101")).replace("-", "")
    end = str(params.get("end", "20301231")).replace("-", "")
    fqt = params.get("fqt", 1)  # 1=qfq,2=hfq,0=raw
    adjust = {1: "qfq", 2: "hfq", 0: ""}[fqt]
    mkt = 'sh' if code[:1] == '6' else 'sz'
    ak_sym = code                  # akshare stock_zh_a_hist wants the PLAIN 6-digit code; it derives the market itself via symbol[0]
    bs_sym = mkt + '.' + code      # baostock wants sh.600000
    try:
        df = ak.stock_zh_a_hist(symbol=ak_sym, period="daily",
                                start_date=start, end_date=end, adjust=adjust or None)
        if df is None or len(df) == 0:
            raise ValueError("empty")
        rows = [{
            "date": str(r["日期"]),
            "open": float(r["开盘"]), "close": float(r["收盘"]),
            "high": float(r["最高"]), "low": float(r["最低"]),
            "volume": float(r["成交量"]), "amount": float(r.get("成交额", 0) or 0),
            "amplitude": (float(r["振幅"]) if "振幅" in r else None),
        } for _, r in df.iterrows()]
        return {"name": ak_sym, "code": ak_sym, "rows": rows}
    except Exception:
        # baostock fallback (A-share only, 2015+)
        try:
            import baostock as bs
            bs.login()
            adj = {1: "1", 2: "2", 0: "3"}[fqt]
            rs = bs.query_history_k_data_plus(
                bs_sym, "date,open,close,high,low,volume,amount",
                start_date=start, end_date=end, frequency="d", adjustflag=adj)
            rows = []
            # baostock: rs.next() returns a bool; data is read via rs.get_row_data()
            while rs is not None and rs.error_code == "0" and rs.next():
                c = rs.get_row_data()
                rows.append({"date": c[0], "open": float(c[1]), "close": float(c[2]),
                             "high": float(c[3]), "low": float(c[4]),
                             "volume": float(c[5]), "amount": float(c[6] or 0),
                             "amplitude": None})
            bs.logout()
            if not rows:
                raise ValueError("empty")
            return {"name": bs_sym, "code": bs_sym, "rows": rows}
        except Exception as e:
            return {"__error__": "akshare+baostock both failed: %s" % e}

def method_financials(params):
    import akshare as ak
    code = str(params.get("code", "")).strip()
    n = int(params.get("periods", 4))
    mkt = 'SH' if code[:1] == '6' else 'SZ'
    last_err = None
    for sym in (code, mkt + code):
        try:
            df = ak.stock_financial_analysis_indicator(symbol=sym)
            if df is not None and len(df) > 0:
                df = df.head(n)
                out = []
                for _, r in df.iterrows():
                    out.append({
                        "reportDate": str(r.get("报告期", ""))[:10],
                        "roe": (float(r["净资产收益率(%)"]) if "净资产收益率(%)" in r else None),
                        "eps": (float(r["每股收益"]) if "每股收益" in r else None),
                        "incomeYoy": (float(r["主营业务收入增长率(%)"]) if "主营业务收入增长率(%)" in r else None),
                        "profitYoy": (float(r["净利润增长率(%)"]) if "净利润增长率(%)" in r else None),
                        "grossMargin": (float(r["销售毛利率(%)"]) if "销售毛利率(%)" in r else None),
                    })
                return {"code": sym, "count": len(out), "data": out}
        except Exception as e:
            last_err = e
    return {"__error__": "no financials: %s" % last_err}

def method_northbound(params):
    import akshare as ak
    # Cumulative northbound net buy since Stock Connect launch
    df = ak.stock_hsgt_north_net_flow_in(symbol="北上")
    if df is None or len(df) == 0:
        return {"__error__": "no northbound"}
    last = df.iloc[-1]
    return {
        "totalAllNetAmtInYi": float(last.get("value", 0)) / 1e8 if "value" in last else None,
        "latestDate": str(last.get("date", "")),
        "note": "akshare cumulative northbound net buy (亿元).",
    }

def method_sectors(params):
    import akshare as ak
    t = params.get("type", "industry")
    if t == "concept":
        df = ak.stock_board_concept_name_em()
    elif t == "region":
        df = ak.stock_board_region_name_em()
    else:
        df = ak.stock_board_industry_name_em()
    if df is None or len(df) == 0:
        return {"__error__": "no sectors"}
    cols = list(df.columns)
    out = []
    for _, r in df.iterrows():
        out.append({
            "code": str(r.get(cols[0], "")),
            "name": str(r.get(cols[1], "")),
            "changePercent": (float(r["涨跌幅"]) if "涨跌幅" in r else None),
            "mainNetInflowYi": (float(r["净流入"]) / 1e8 if "净流入" in r else None),
        })
    return {"type": t, "count": len(out), "data": out}

HANDLERS = {
    "daily": method_daily,
    "financials": method_financials,
    "northbound": method_northbound,
    "sectors": method_sectors,
}

def main():
    while True:
        req = _readline()
        if req is None:
            break
        method = req.get("method")
        params = req.get("params", {}) or {}
        h = HANDLERS.get(method)
        if not h:
            _out({"__error__": "unknown method: %s" % method})
            continue
        try:
            _out(h(params))
        except Exception as e:
            _out({"__error__": "%s: %s" % (method, e)})

if __name__ == "__main__":
    main()
