"""
generate_forecast.py
--------------------
Primaire data: NOAA GHCND station-data (zelfde bron als Kalshi/Polymarket settlement).
Fallback:      Open-Meteo ERA5 als NOAA niet beschikbaar.

NOAA token (gratis):
    https://www.ncei.noaa.gov/cdo-web/token
    Sla op als noaa_token.txt of omgevingsvariabele NOAA_TOKEN.

Gebruik:
    pip install requests numpy pandas scikit-learn
    python generate_forecast.py
    open forecast.html
"""

import os, sys, json, time, re, requests
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, date
from sklearn.ensemble import GradientBoostingRegressor, GradientBoostingClassifier
from sklearn.metrics import mean_absolute_error, mean_squared_error, brier_score_loss

# ── NOAA API configuratie ─────────────────────────────────────────────────────
NOAA_BASE = "https://www.ncei.noaa.gov/cdo-web/api/v2"

def load_noaa_token():
    """Laad NOAA token uit env-var of bestand."""
    tok = os.environ.get("NOAA_TOKEN", "").strip()
    if tok:
        return tok
    for path in ["noaa_token.txt", os.path.expanduser("~/.noaa_token")]:
        if os.path.exists(path):
            with open(path) as f:
                tok = f.read().strip()
            if tok:
                return tok
    return None

NOAA_TOKEN = load_noaa_token()

# ── Steden + NOAA-stations + Kalshi-tickers ───────────────────────────────────
# NOAA GHCND station-IDs: dezelfde officiële weerstation-data als Kalshi gebruikt.
CITIES = [
    {"name": "New York",     "lat": 40.7128,  "lon": -74.0060,  "tz": "America/New_York",
     "noaa": "GHCND:USW00094728", "noaa_label": "Central Park",         "kalshi": "HIGHNY",     "polymarket": "nyc"},
    {"name": "Los Angeles",  "lat": 34.0522,  "lon": -118.2437, "tz": "America/Los_Angeles",
     "noaa": "GHCND:USW00023174", "noaa_label": "LAX Airport",           "kalshi": "KXHIGHLAX", "polymarket": "los-angeles"},
    {"name": "Chicago",      "lat": 41.8781,  "lon": -87.6298,  "tz": "America/Chicago",
     "noaa": "GHCND:USW00094846", "noaa_label": "O'Hare Airport",        "kalshi": "HIGHCHI",   "polymarket": "chicago"},
    {"name": "Houston",      "lat": 29.7604,  "lon": -95.3698,  "tz": "America/Chicago",
     "noaa": "GHCND:USW00012960", "noaa_label": "Houston Hobby",         "kalshi": None,        "polymarket": "houston"},
    {"name": "Phoenix",      "lat": 33.4484,  "lon": -112.0740, "tz": "America/Phoenix",
     "noaa": "GHCND:USW00023183", "noaa_label": "Phoenix Sky Harbor",    "kalshi": None,        "polymarket": None},
    {"name": "Philadelphia", "lat": 39.9526,  "lon": -75.1652,  "tz": "America/New_York",
     "noaa": "GHCND:USW00013739", "noaa_label": "Philadelphia Intl",     "kalshi": None,        "polymarket": None},
    {"name": "San Antonio",  "lat": 29.4241,  "lon": -98.4936,  "tz": "America/Chicago",
     "noaa": "GHCND:USW00012921", "noaa_label": "San Antonio Intl",      "kalshi": None,        "polymarket": None},
    {"name": "San Diego",    "lat": 32.7157,  "lon": -117.1611, "tz": "America/Los_Angeles",
     "noaa": "GHCND:USW00023188", "noaa_label": "San Diego Intl",        "kalshi": None,        "polymarket": None},
    {"name": "Dallas",       "lat": 32.7767,  "lon": -96.7970,  "tz": "America/Chicago",
     "noaa": "GHCND:USW00013960", "noaa_label": "DFW Airport",           "kalshi": None,        "polymarket": "dallas"},
    {"name": "San Jose",     "lat": 37.3382,  "lon": -121.8863, "tz": "America/Los_Angeles",
     "noaa": "GHCND:USW00023293", "noaa_label": "San Jose Intl",         "kalshi": None,        "polymarket": None},
]

TRAIN_UNTIL   = "2021-12-31"
N_EST_REG     = 200
N_EST_CLF     = 150
LEARNING_RATE = 0.05
HISTORY_SHOW  = 90
HORIZONS      = list(range(1, 8))
ECDF_PCTS     = [1,2,3,5,7,10,13,16,20,25,30,35,40,45,50,55,60,65,70,75,80,84,87,90,93,95,97,98,99]

FEATURES = [
    "day_sin","day_cos","month_sin","month_cos","year",
    "lag_1","lag_2","lag_3","lag_7",
    "roll7_mean","roll14_mean","roll7_std",
]

def c_to_f(c): return round(c * 9/5 + 32, 1)
def f_to_c(f): return round((f - 32) * 5/9, 2)

# ── NOAA data ophalen ─────────────────────────────────────────────────────────
def fetch_noaa_year(session, station_id, year, token):
    """Haal GHCND TMAX op voor één jaar. TMAX = tiende graden Celsius."""
    today  = datetime.now().date()
    end    = min(date(year, 12, 31), today - timedelta(days=1))
    if end < date(year, 1, 1):
        return []

    for attempt in range(3):
        try:
            r = session.get(
                f"{NOAA_BASE}/data",
                params={
                    "datasetid":  "GHCND",
                    "datatypeid": "TMAX",
                    "stationid":  station_id,
                    "startdate":  f"{year}-01-01",
                    "enddate":    end.isoformat(),
                    "limit":      366,
                },
                headers={"token": token},
                timeout=45,
            )
            if r.status_code == 200:
                return r.json().get("results", [])
            elif r.status_code == 429:
                time.sleep(3)
            else:
                return []
        except requests.RequestException:
            time.sleep(2)
    return []

def fetch_noaa_data(city, token, start_year=1990):
    """
    Haal historische TMAX op van NOAA GHCND (officieel weerstation).
    TMAX is in tiende graden Celsius → deel door 10 voor °C.
    Vult korte gaten op (max 3 dagen lineaire interpolatie).
    """
    station_id  = city["noaa"]
    today       = datetime.now().date()
    session     = requests.Session()
    all_records = []

    for year in range(start_year, today.year + 1):
        records = fetch_noaa_year(session, station_id, year, token)
        all_records.extend(records)
        time.sleep(0.22)   # max ~4.5 req/sec, ruim binnen NOAA-limiet (5/sec)

    if not all_records:
        raise ValueError(f"Geen NOAA data voor {city['name']} ({station_id})")

    df = pd.DataFrame(all_records)
    df["date"] = pd.to_datetime(df["date"].str[:10])
    df = df[df["datatype"] == "TMAX"].copy()
    df["tmax"] = df["value"] / 10.0          # tiende °C → °C
    df = (df[["date", "tmax"]]
          .set_index("date")
          .sort_index()
          .pipe(lambda d: d[~d.index.duplicated(keep="first")]))

    # Verwijder fysisch onmogelijke waarden
    df = df[(df["tmax"] > -50) & (df["tmax"] < 65)]

    # Vul kleine gaten (max 3 opeenvolgende dagen)
    df = df.asfreq("D")
    df["tmax"] = df["tmax"].interpolate(method="linear", limit=3)
    df = df.dropna()

    return df

# ── Open-Meteo fallback & aanvulling ─────────────────────────────────────────
def fetch_openmeteo(city, start_date_str, end_date_str):
    """Open-Meteo ERA5 als fallback of aanvulling voor recente dagen."""
    r = requests.get(
        "https://archive-api.open-meteo.com/v1/archive",
        params={
            "latitude":   city["lat"], "longitude": city["lon"],
            "start_date": start_date_str, "end_date": end_date_str,
            "daily":      "temperature_2m_max",
            "timezone":   city["tz"],
            "temperature_unit": "celsius",
        },
        timeout=30,
    )
    r.raise_for_status()
    d = r.json()["daily"]
    df = pd.DataFrame({"date": d["time"], "tmax": d["temperature_2m_max"]})
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date").dropna()

def get_city_data(city, token, start_year=1990):
    """
    Haal data op voor een stad:
    1. NOAA GHCND (officieel station) als token beschikbaar
    2. Vul eventuele recente gaten aan met Open-Meteo
    3. Volledig Open-Meteo als NOAA niet beschikbaar
    """
    today      = datetime.now().date()
    yesterday  = today - timedelta(days=1)
    source     = "NOAA"

    if token:
        try:
            df = fetch_noaa_data(city, token, start_year)
            # Vul recente gaten aan als NOAA achterloopt (>5 dagen oud)
            last_noaa = df.index[-1].date()
            if last_noaa < yesterday - timedelta(days=5):
                fill_start = (last_noaa + timedelta(days=1)).isoformat()
                try:
                    supplement = fetch_openmeteo(city, fill_start, yesterday.isoformat())
                    # Pas ERA5→station bias toe (schat op overlap)
                    overlap_start = max(df.index[-30].date(), date(2024, 1, 1)).isoformat()
                    overlap_om = fetch_openmeteo(city, overlap_start, last_noaa.isoformat())
                    overlap_noaa = df.loc[overlap_start:]
                    common = overlap_om.index.intersection(overlap_noaa.index)
                    if len(common) > 5:
                        bias = float((overlap_noaa.loc[common, "tmax"] - overlap_om.loc[common, "tmax"]).median())
                        supplement["tmax"] += bias
                    df = pd.concat([df, supplement[~supplement.index.isin(df.index)]])
                    df = df.sort_index()
                    source = "NOAA+ERA5(supplement)"
                except Exception:
                    pass
            return df, source
        except Exception as e:
            print(f"\n    [NOAA mislukt: {e} → fallback Open-Meteo]", end="", flush=True)

    # Fallback: volledig Open-Meteo
    df = fetch_openmeteo(city, f"{start_year}-01-01", yesterday.isoformat())
    return df, "Open-Meteo ERA5"

# ── Feature engineering ───────────────────────────────────────────────────────
def build_horizon_features(df_raw, k):
    d   = df_raw.copy()
    tgt = d.index + pd.Timedelta(days=k)
    doy = tgt.dayofyear
    d["day_sin"]   = np.sin(2*np.pi*doy/365.25)
    d["day_cos"]   = np.cos(2*np.pi*doy/365.25)
    d["month_sin"] = np.sin(2*np.pi*tgt.month/12)
    d["month_cos"] = np.cos(2*np.pi*tgt.month/12)
    d["year"]      = tgt.year
    d["lag_1"]     = d["tmax"].shift(1)
    d["lag_2"]     = d["tmax"].shift(2)
    d["lag_3"]     = d["tmax"].shift(3)
    d["lag_7"]     = d["tmax"].shift(7)
    lag = d["tmax"].shift(1)
    d["roll7_mean"]  = lag.rolling(7).mean()
    d["roll14_mean"] = lag.rolling(14).mean()
    d["roll7_std"]   = lag.rolling(7).std()
    d["target"]      = d["tmax"].shift(-k)
    return d.dropna()

def make_predict_row(df_raw, horizon):
    hist = list(df_raw["tmax"].values)
    fd   = df_raw.index[-1] + timedelta(days=horizon)
    doy  = fd.timetuple().tm_yday
    return pd.DataFrame([{
        "day_sin":    np.sin(2*np.pi*doy/365.25),
        "day_cos":    np.cos(2*np.pi*doy/365.25),
        "month_sin":  np.sin(2*np.pi*fd.month/12),
        "month_cos":  np.cos(2*np.pi*fd.month/12),
        "year":       fd.year,
        "lag_1":      hist[-1],
        "lag_2":      hist[-2],
        "lag_3":      hist[-3],
        "lag_7":      hist[-7],
        "roll7_mean": float(np.mean(hist[-7:])),
        "roll14_mean":float(np.mean(hist[-14:])),
        "roll7_std":  float(np.std(hist[-7:])),
    }])[FEATURES]

# ── Regressiemodellen ─────────────────────────────────────────────────────────
def train_regression_models(df_raw):
    models, error_pcts = {}, {}
    for k in HORIZONS:
        df_k  = build_horizon_features(df_raw, k)
        train = df_k[df_k.index <= TRAIN_UNTIL]
        test  = df_k[df_k.index >  TRAIN_UNTIL]
        X_tr, y_tr = train[FEATURES], train["target"]
        X_te, y_te = test[FEATURES],  test["target"]
        m = GradientBoostingRegressor(
            loss="quantile", alpha=0.50,
            n_estimators=N_EST_REG, learning_rate=LEARNING_RATE,
            max_depth=4, subsample=0.8, random_state=42,
        )
        m.fit(X_tr, y_tr)
        models[k] = m
        errors = y_te.values - m.predict(X_te)
        bias   = float(np.median(errors))
        error_pcts[k] = {
            "p5":   round(float(np.percentile(errors, 5)),  2),
            "p10":  round(float(np.percentile(errors, 10)), 2),
            "p20":  round(float(np.percentile(errors, 20)), 2),
            "p50":  round(bias, 2),
            "p80":  round(float(np.percentile(errors, 80)), 2),
            "p90":  round(float(np.percentile(errors, 90)), 2),
            "mae":  round(float(mean_absolute_error(y_te, m.predict(X_te))), 2),
            "rmse": round(float(np.sqrt(mean_squared_error(y_te, m.predict(X_te)))), 2),
            "n":    len(y_te),
            "ecdf_pcts": ECDF_PCTS,
            "ecdf_vals": [round(float(np.percentile(errors, p)), 3) for p in ECDF_PCTS],
        }
    return models, error_pcts

def forecast_7days(reg_models, error_pcts, df_raw):
    last_date = df_raw.index[-1]
    forecasts = []
    for k in HORIZONS:
        fd  = last_date + timedelta(days=k)
        X   = make_predict_row(df_raw, k)
        med = float(reg_models[k].predict(X)[0])
        ep  = error_pcts[k]
        forecasts.append({
            "date":  fd.strftime("%Y-%m-%d"),
            "label": fd.strftime("%a %d %b"),
            "day":   fd.strftime("%a"),
            "dmy":   fd.strftime("%d %b"),
            "med":   round(med, 1),
            "c80":   round(med + ep["p20"], 1),
            "c90":   round(med + ep["p10"], 1),
            "c95":   round(med + ep["p5"],  1),
            "hi80":  round(med + ep["p80"], 1),
            "hi90":  round(med + ep["p90"], 1),
            "mae":   ep["mae"],
            "rmse":  ep["rmse"],
            "bias":  ep["p50"],
            "ecdf_pcts": ep["ecdf_pcts"] if k == 1 else None,
            "ecdf_vals": ep["ecdf_vals"] if k == 1 else None,
        })
    return forecasts

# ── Classificatiemodel per drempel ────────────────────────────────────────────
def train_prob_classifier(df_raw, threshold_c):
    df   = build_horizon_features(df_raw, 1)
    df["y"] = (df["target"] > threshold_c).astype(int)
    pos_rate = df["y"].mean()
    if not (0.02 <= pos_rate <= 0.98):
        return None
    train = df[df.index <= TRAIN_UNTIL]
    test  = df[df.index >  TRAIN_UNTIL]
    X_tr, y_tr = train[FEATURES], train["y"]
    X_te, y_te = test[FEATURES],  test["y"]
    m = GradientBoostingClassifier(
        n_estimators=N_EST_CLF, learning_rate=LEARNING_RATE,
        max_depth=3, subsample=0.8, random_state=42,
    )
    m.fit(X_tr, y_tr)
    y_prob     = m.predict_proba(X_te)[:, 1]
    brier      = float(brier_score_loss(y_te, y_prob))
    base_brier = float(brier_score_loss(y_te, [y_te.mean()] * len(y_te)))
    skill      = round(1 - brier / base_brier, 3) if base_brier > 0 else 0
    calib_bias = round(float(np.mean(y_prob) - y_te.mean()), 4)
    return {"model": m, "brier": round(brier, 4), "skill": skill,
            "base_rate": round(float(pos_rate), 3), "calib_bias": calib_bias}

def predict_prob(clf_result, df_raw):
    if clf_result is None:
        return None
    X    = make_predict_row(df_raw, 1)
    prob = float(clf_result["model"].predict_proba(X)[0, 1])
    prob = prob - clf_result["calib_bias"]   # bias-correctie
    return round(max(0.01, min(0.99, prob)), 4)

# ── Kalshi markten ophalen ────────────────────────────────────────────────────
def fetch_kalshi_markets(kalshi_ticker, target_date):
    if not kalshi_ticker:
        return []
    date_str = target_date.strftime("%y%b%d").upper()
    event    = f"{kalshi_ticker}-{date_str}"
    try:
        r = requests.get(
            "https://api.elections.kalshi.com/trade-api/v2/markets",
            params={"event_ticker": event, "limit": 25},
            headers={"User-Agent": "TempForecast/1.0"},
            timeout=10,
        )
        if r.status_code not in (200, 206):
            return []
        result = []
        for m in r.json().get("markets", []):
            ticker      = m.get("ticker", "")
            title       = m.get("title", "") or ticker
            strike_type = m.get("strike_type", "")
            # Only use "greater" and "less" markets — these map cleanly to a single threshold
            if strike_type == "greater":
                threshold_f = m.get("floor_strike")
            elif strike_type == "less":
                threshold_f = m.get("cap_strike")
            else:
                continue  # skip "between" range markets
            if threshold_f is None:
                continue
            threshold_f = float(threshold_f)
            yes_p = m.get("yes_ask_dollars") or m.get("yes_bid_dollars") or m.get("last_price_dollars")
            if yes_p is None:
                continue
            result.append({
                "source":      "Kalshi",
                "title":       title,
                "ticker":      ticker,
                "threshold_f": threshold_f,
                "threshold_c": f_to_c(threshold_f),
                "yes_prob":    round(float(yes_p), 4),
                "url":         f"https://kalshi.com/markets/{event}",
            })
        return result
    except Exception:
        return []

def fetch_polymarket_markets(city_slug, target_date):
    """Fetch Polymarket range markets and convert to cumulative P(temp >= T) values.

    Slug pattern: highest-temperature-in-{city_slug}-on-{month}-{day}-{year}
    e.g. highest-temperature-in-nyc-on-april-6-2026
    """
    if not city_slug:
        return []
    month = target_date.strftime("%B").lower()
    day   = str(target_date.day)   # no leading zero
    year  = target_date.year
    slug  = f"highest-temperature-in-{city_slug}-on-{month}-{day}-{year}"
    url   = f"https://polymarket.com/event/{slug}"
    try:
        r = requests.get(
            "https://gamma-api.polymarket.com/events",
            params={"slug": slug},
            headers={"User-Agent": "TempForecast/1.0"},
            timeout=10,
        )
        if r.status_code != 200:
            return []
        events = r.json()
        if not events:
            return []
        markets = events[0].get("markets", [])

        # Parse each range market: "47°F or below", "48-49°F", "66°F or higher"
        ranges = []
        for m in markets:
            title  = m.get("groupItemTitle", "") or m.get("question", "")
            prices = m.get("outcomePrices", [])
            if isinstance(prices, str):
                prices = json.loads(prices)
            if len(prices) < 1:
                continue
            yes_p = float(prices[0])  # first outcome is always Yes

            # Parse bounds from title (strip unicode degree symbols)
            t = title.replace("\u00b0", "").replace("°", "").strip()
            lo_m = re.match(r"(\d+)\s*F\s+or\s+below", t, re.I)
            hi_m = re.match(r"(\d+)\s*F\s+or\s+higher", t, re.I)
            rng_m = re.match(r"(\d+)-(\d+)\s*F", t, re.I)

            if lo_m:
                ranges.append({"lo": None, "hi": float(lo_m.group(1)), "p": yes_p})
            elif hi_m:
                ranges.append({"lo": float(hi_m.group(1)), "hi": None, "p": yes_p})
            elif rng_m:
                ranges.append({"lo": float(rng_m.group(1)), "hi": float(rng_m.group(2)), "p": yes_p})

        if not ranges:
            return []

        # Normalize probabilities to sum to 1 (market prices may not be perfectly calibrated)
        total = sum(r["p"] for r in ranges)
        if total > 0:
            for r in ranges:
                r["p"] /= total

        # Build cumulative P(temp >= T) for each lower range boundary
        # P(temp >= T) = sum of p for all ranges where lo >= T
        result = []
        boundaries = sorted({r["lo"] for r in ranges if r["lo"] is not None})
        for T in boundaries:
            cum_p = sum(r["p"] for r in ranges if r["lo"] is not None and r["lo"] >= T)
            result.append({
                "source":      "Polymarket",
                "title":       f"High temp >= {T:.0f}°F",
                "ticker":      slug,
                "threshold_f": T,
                "threshold_c": f_to_c(T),
                "yes_prob":    round(cum_p, 4),
                "url":         url,
            })
        return result
    except Exception:
        return []

def get_history(df_raw):
    hist = df_raw.tail(HISTORY_SHOW)
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in hist.index],
        "temps": [round(float(t), 1) for t in hist["tmax"]],
    }

# ══════════════════════════════════════════════════════════════════════════════
# HTML TEMPLATE (identiek aan vorige versie — alleen data-source badge bijgewerkt)
# ══════════════════════════════════════════════════════════════════════════════
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>US Temperature Forecast</title>
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#04040d;--border:rgba(255,255,255,.07);--border2:rgba(255,255,255,.13);
  --text:#e8e8f8;--muted:#5a5a80;--muted2:#8888aa;
  --accent:#7c44ff;--hot:#ff5577;--cold:#44aaff;--warm:#ff9944;
  --green:#44ffaa;--red:#ff4466;
}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;min-height:100vh;overflow-x:hidden}
#bgCanvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}
.app{position:relative;z-index:1;max-width:1440px;margin:0 auto;padding:0 36px 56px}

header{padding:40px 0 28px;display:flex;align-items:center;gap:36px;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-bottom:36px}
.header-brand h1{font-family:'Bebas Neue',sans-serif;font-size:3.2rem;letter-spacing:7px;line-height:1;background:linear-gradient(110deg,#44aaff 0%,#aa66ff 45%,#ff5577 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header-brand p{font-size:.68rem;letter-spacing:3px;text-transform:uppercase;color:var(--muted);margin-top:6px}
.field-label{font-size:.6rem;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.city-wrap,.conf-wrap{display:flex;flex-direction:column}
#city-select{background:rgba(255,255,255,.04);border:1px solid var(--border2);border-radius:10px;color:var(--text);font-family:'Inter',sans-serif;font-size:1rem;font-weight:600;padding:11px 44px 11px 18px;cursor:pointer;outline:none;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%235a5a80' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;min-width:215px;transition:border-color .2s,box-shadow .2s}
#city-select:hover,#city-select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,68,255,.15)}
.conf-btns{display:flex;gap:6px}
.conf-btn{background:rgba(255,255,255,.04);border:1px solid var(--border2);border-radius:8px;color:var(--muted2);font-family:'Inter',sans-serif;font-size:.88rem;font-weight:600;padding:10px 20px;cursor:pointer;letter-spacing:.5px;transition:all .18s}
.conf-btn:hover{border-color:rgba(255,255,255,.2);color:var(--text)}
.conf-btn.active{background:rgba(124,68,255,.18);border-color:var(--accent);color:#c0a0ff;box-shadow:0 0 14px rgba(124,68,255,.22)}
.meta-bar{margin-left:auto;display:flex;gap:30px;align-items:flex-end}
.meta-stat{text-align:right}
.meta-stat .val{font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:2px;line-height:1}
.meta-stat .lbl{font-size:.6rem;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;margin-top:3px}
.val-hot{color:#ff5577}.val-cold{color:#44aaff}.val-acc{color:#66ffaa}

.section-title{font-family:'Bebas Neue',sans-serif;font-size:.82rem;letter-spacing:4px;color:var(--muted);text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;gap:12px}
.section-title::after{content:'';flex:1;height:1px;background:var(--border)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);flex-shrink:0}

/* Edge Board */
.edge-section{margin-bottom:36px}
.edge-board{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.edge-board-header{display:grid;grid-template-columns:2.2fr 1fr 1fr 1fr 1.2fr 1.2fr;padding:12px 20px;border-bottom:1px solid var(--border);font-size:.6rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted)}
.edge-row{display:grid;grid-template-columns:2.2fr 1fr 1fr 1fr 1.2fr 1.2fr;padding:14px 20px;border-bottom:1px solid var(--border);transition:background .15s;align-items:center}
.edge-row:last-child{border-bottom:none}
.edge-row:hover{background:rgba(255,255,255,.03)}
.edge-row.buy-yes{border-left:3px solid var(--green)}
.edge-row.buy-no{border-left:3px solid var(--red)}
.edge-row.no-edge{border-left:3px solid var(--border);opacity:.6}
.edge-city{font-weight:600;font-size:.88rem}
.edge-city small{display:block;font-size:.62rem;color:var(--muted);font-weight:400;margin-top:2px}
.edge-val{font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:1px}
.edge-mkt{color:var(--cold)}.edge-mdl{color:#aa66ff}
.edge-diff{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:1px}
.edge-diff.pos{color:var(--green)}.edge-diff.neg{color:var(--red)}.edge-diff.neu{color:var(--muted)}
.edge-signal{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;font-size:.72rem;font-weight:700;letter-spacing:1px;white-space:nowrap;text-decoration:none}
.signal-yes{background:rgba(68,255,170,.12);border:1px solid rgba(68,255,170,.3);color:var(--green)}
.signal-no{background:rgba(255,68,102,.12);border:1px solid rgba(255,68,102,.3);color:var(--red)}
.signal-pass{background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--muted)}
.edge-skill{font-size:.7rem;color:var(--muted2)}
.edge-skill span{display:block;font-size:.6rem;color:var(--muted);margin-top:2px}
.no-markets-msg{padding:32px;text-align:center;color:var(--muted);font-size:.8rem;line-height:1.7}
.data-note{font-size:.68rem;color:var(--muted);padding:12px 20px;border-top:1px solid var(--border);line-height:1.6;background:rgba(68,255,170,.03)}
.data-note b{color:var(--green)}

/* Heatmaps */
.heatmaps-section{margin-bottom:36px}
.heatmaps-row{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.heatmap-card{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.heatmap-title{padding:14px 20px 10px;font-size:.6rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
.heatmap-body{overflow-x:auto;padding:8px 0}
.hm-row{display:flex;align-items:center;gap:6px;padding:5px 16px}
.hm-row:not(:last-child){border-bottom:1px solid rgba(255,255,255,.04)}
.hm-label{min-width:90px;font-size:.78rem;font-weight:600;color:var(--text);flex-shrink:0}
.hm-cells{display:flex;gap:3px;flex-wrap:nowrap}
.hm-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;width:50px;height:50px;border-radius:8px;cursor:default;transition:transform .12s;flex-shrink:0}
.hm-cell:hover{transform:scale(1.1);z-index:1;position:relative}
.hm-cell-val{font-family:'Bebas Neue',sans-serif;font-size:.95rem;letter-spacing:.5px;color:#fff;line-height:1}
.hm-cell-th{font-size:.52rem;color:rgba(255,255,255,.65);margin-top:3px}
.hm-empty{background:rgba(255,255,255,.03)!important}
.hm-empty .hm-cell-val{color:var(--muted)}
.hm-legend{display:flex;align-items:center;gap:8px;padding:10px 16px 14px;font-size:.6rem;color:var(--muted)}
.hm-legend-bar{flex:1;height:8px;border-radius:4px}
@media(max-width:900px){.heatmaps-row{grid-template-columns:1fr}}

/* Day cards */
.hero-section{margin-bottom:32px}
.conf-statement{font-size:.78rem;color:var(--muted2);margin-bottom:18px;line-height:1.6;padding:11px 16px;background:rgba(124,68,255,.07);border:1px solid rgba(124,68,255,.18);border-radius:8px}
.conf-statement strong{color:#c0a0ff}
.day-cards{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}
.day-card{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:14px;padding:22px 10px 18px;text-align:center;transition:transform .18s,border-color .18s,box-shadow .18s;position:relative;overflow:hidden}
.day-card::before{content:'';position:absolute;inset:0;border-radius:14px;opacity:0;transition:opacity .18s;background:radial-gradient(ellipse at 50% 0%,rgba(124,68,255,.14),transparent 70%);pointer-events:none}
.day-card:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.13);box-shadow:0 8px 30px rgba(0,0,0,.4)}
.day-card:hover::before{opacity:1}
.dc-day{font-size:.62rem;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted)}
.dc-date{font-size:.7rem;color:var(--muted2);margin:3px 0 16px}
.dc-cert{font-family:'Bebas Neue',sans-serif;font-size:3.4rem;line-height:1;letter-spacing:1px;transition:color .3s}
.dc-unit{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;opacity:.6}
.dc-sure{font-size:.6rem;color:var(--muted);letter-spacing:1px;margin:4px 0 12px}
.dc-bar{height:3px;border-radius:2px;margin:0 0 10px;transition:background .3s}
.dc-divider{height:1px;background:var(--border);margin-bottom:10px}
.dc-bottom{display:flex;justify-content:space-between;align-items:center;font-size:.6rem;color:var(--muted)}
.dc-med{font-weight:600;color:var(--muted2);font-size:.68rem}

/* Charts */
.charts-section{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
.chart-card{background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:16px;padding:24px 22px 18px;position:relative;overflow:hidden}
.chart-card::after{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(124,68,255,.5),transparent)}
.chart-inner{width:100%;height:300px}
.legend-row{display:flex;gap:18px;margin-top:14px;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:7px;font-size:.65rem;color:var(--muted2)}
.legend-line{width:22px;height:2px;border-radius:1px}

/* Probability calc */
.prob-section{margin-bottom:28px}
.prob-card{background:rgba(255,255,255,.025);border:1px solid var(--border);border-radius:16px;padding:28px 32px;position:relative;overflow:hidden}
.prob-card::after{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(68,170,255,.5),transparent)}
.prob-layout{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:start}
.prob-desc{font-size:.75rem;color:var(--muted2);line-height:1.7;margin-bottom:20px}
.prob-model-note{font-size:.65rem;color:var(--muted);margin-top:10px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;line-height:1.5}
.prob-model-note b{color:var(--green)}
.slider-row{display:flex;align-items:center;gap:14px;margin-bottom:10px}
.temp-display{font-family:'Bebas Neue',sans-serif;font-size:3rem;letter-spacing:2px;color:#44aaff;min-width:90px;text-align:center;transition:color .25s}
.temp-display span{font-size:1.5rem;opacity:.6}
.slider-labels{display:flex;justify-content:space-between;font-size:.62rem;color:var(--muted);margin-top:4px}
#tempSlider{-webkit-appearance:none;appearance:none;width:100%;height:5px;border-radius:3px;background:linear-gradient(to right,#44aaff,var(--muted2));outline:none;cursor:pointer}
#tempSlider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:#44aaff;cursor:pointer;box-shadow:0 0 10px rgba(68,170,255,.5);transition:transform .15s}
#tempSlider::-webkit-slider-thumb:hover{transform:scale(1.2)}
.prob-boxes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}
.prob-box{text-align:center;padding:18px 10px;border-radius:12px}
.prob-box.classifier{background:rgba(68,170,255,.07);border:1px solid rgba(68,170,255,.2)}
.prob-box.regression{background:rgba(124,68,255,.07);border:1px solid rgba(124,68,255,.2)}
.pb-label{font-size:.58rem;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
.classifier .pb-label{color:#44aaff}.regression .pb-label{color:#aa66ff}
.pb-val{font-family:'Bebas Neue',sans-serif;font-size:3rem;letter-spacing:2px;line-height:1;transition:color .3s}
.classifier .pb-val{color:#44aaff}.regression .pb-val{color:#aa66ff}
.pb-sub{font-size:.62rem;color:var(--muted);margin-top:4px;line-height:1.4}

footer{border-top:1px solid var(--border);padding:18px 0 0;display:flex;gap:28px;flex-wrap:wrap;font-size:.67rem;color:var(--muted)}
footer b{color:var(--muted2)}

@media(max-width:1100px){.charts-section{grid-template-columns:1fr}.prob-layout{grid-template-columns:1fr}.edge-board-header,.edge-row{grid-template-columns:2fr 1fr 1fr 1fr}}
@media(max-width:860px){.app{padding:0 20px 40px}.day-cards{grid-template-columns:repeat(4,1fr)}.meta-bar{margin-left:0}}
@media(max-width:560px){.day-cards{grid-template-columns:repeat(2,1fr)}.header-brand h1{font-size:2.4rem}}
</style>
</head>
<body>
<canvas id="bgCanvas"></canvas>
<div class="app">

<header>
  <div class="header-brand">
    <h1>Temperature Forecast</h1>
    <p>NOAA station data · direct multi-step · classifier probabilities · market edge</p>
  </div>
  <div class="city-wrap">
    <div class="field-label">City</div>
    <select id="city-select"></select>
  </div>
  <div class="conf-wrap">
    <div class="field-label">Certainty level</div>
    <div class="conf-btns">
      <button class="conf-btn" data-conf="80">80%</button>
      <button class="conf-btn active" data-conf="90">90%</button>
      <button class="conf-btn" data-conf="95">95%</button>
    </div>
  </div>
  <div class="meta-bar">
    <div class="meta-stat"><div class="val val-hot" id="meta-hi">—</div><div class="lbl">7-day peak</div></div>
    <div class="meta-stat"><div class="val val-cold" id="meta-lo">—</div><div class="lbl">Certainty low</div></div>
    <div class="meta-stat"><div class="val val-acc" id="meta-mae">—</div><div class="lbl">Day+1 MAE</div></div>
  </div>
</header>

<section class="heatmaps-section">
  <div class="section-title"><span class="dot"></span>Market heatmaps — probability &amp; model edge per threshold</div>
  <div class="heatmaps-row">
    <div class="heatmap-card">
      <div class="heatmap-title">Market probability — P(high temp &ge; T)</div>
      <div class="heatmap-body" id="heatmap-prob"></div>
      <div class="hm-legend">
        <span>0%</span>
        <div class="hm-legend-bar" style="background:linear-gradient(90deg,hsl(210,80%,30%),hsl(150,70%,35%),hsl(60,80%,40%),hsl(20,85%,40%),hsl(0,80%,40%)"></div>
        <span>100%</span>
      </div>
    </div>
    <div class="heatmap-card">
      <div class="heatmap-title">Edge — model vs market (pp)</div>
      <div class="heatmap-body" id="heatmap-edge"></div>
      <div class="hm-legend">
        <span>BUY NO</span>
        <div class="hm-legend-bar" style="background:linear-gradient(90deg,hsl(210,80%,35%),rgba(255,255,255,.06),hsl(30,85%,40%))"></div>
        <span>BUY YES</span>
      </div>
    </div>
  </div>
</section>

<section class="edge-section">
  <div class="section-title"><span class="dot"></span>Market edge board — sorted by model vs market discrepancy</div>
  <div class="edge-board" id="edge-board"></div>
</section>

<section class="hero-section">
  <div class="section-title"><span class="dot"></span>7-day certainty forecast</div>
  <div class="conf-statement" id="conf-statement"></div>
  <div class="day-cards" id="day-cards"></div>
</section>

<section class="charts-section">
  <div class="chart-card">
    <div class="section-title"><span class="dot"></span>Temperature certainty bands</div>
    <div class="chart-inner" id="fan-chart"></div>
    <div class="legend-row">
      <div class="legend-item"><div class="legend-line" style="background:#ff5577"></div>Median</div>
      <div class="legend-item"><div class="legend-line" style="background:#ff9944"></div>80%</div>
      <div class="legend-item"><div class="legend-line" style="background:#aa66ff"></div>90%</div>
      <div class="legend-item"><div class="legend-line" style="background:#44aaff"></div>95%</div>
    </div>
  </div>
  <div class="chart-card">
    <div class="section-title"><span class="dot"></span>Historical (NOAA station) + forecast</div>
    <div class="chart-inner" id="line-chart"></div>
  </div>
</section>

<section class="prob-section">
  <div class="section-title"><span class="dot"></span>Tomorrow's probability calculator</div>
  <div class="prob-card">
    <div class="prob-layout">
      <div>
        <div class="prob-desc">P(max temp tomorrow ≥ T°C) — drag the slider. Classifier is trained directly on the binary outcome (same question as Kalshi). Regression-CDF converts the error distribution.</div>
        <div class="slider-row">
          <div style="flex:1">
            <input type="range" id="tempSlider" min="0" max="50" step="0.5" value="20">
            <div class="slider-labels"><span id="sliderMin"></span><span id="sliderMax"></span></div>
          </div>
          <div class="temp-display" id="tempDisplay">20<span>°C</span></div>
        </div>
        <div class="prob-boxes">
          <div class="prob-box classifier">
            <div class="pb-label">Classifier (GBC)</div>
            <div class="pb-val" id="prob-clf">—</div>
            <div class="pb-sub">Direct P(temp > T)<br>bias-corrected</div>
          </div>
          <div class="prob-box regression">
            <div class="pb-label">Regression CDF</div>
            <div class="pb-val" id="prob-reg">—</div>
            <div class="pb-sub">Empirical error dist.<br>interpolated</div>
          </div>
        </div>
        <div class="prob-model-note" id="bias-note"></div>
      </div>
      <div id="prob-markets-panel"></div>
    </div>
  </div>
</section>

<footer>
  <span>Training data: <b id="footer-source">NOAA GHCND station</b></span>
  <span>Regression: <b>GBR direct multi-step per horizon</b></span>
  <span>Probabilities: <b>GBC per threshold + bias correction</b></span>
  <span>Markets: <b>Kalshi / Polymarket</b></span>
  <span>Generated: <b id="gen-time"></b></span>
</footer>
</div>

<script>
const DATA = __DATA__;
let activeCity=null, activeConf=90;
const CONF={
  80:{key:'c80',color:'#ff9944',fill:'rgba(255,153,68,0.10)',label:'80%',text:'Met <strong>80% zekerheid</strong> bereikt de max temperatuur minstens:'},
  90:{key:'c90',color:'#aa66ff',fill:'rgba(170,102,255,0.10)',label:'90%',text:'Met <strong>90% zekerheid</strong> bereikt de max temperatuur minstens:'},
  95:{key:'c95',color:'#44aaff',fill:'rgba(68,170,255,0.10)',label:'95%',text:'Met <strong>95% zekerheid</strong> bereikt de max temperatuur minstens:'},
};
const PL={paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:'Inter,sans-serif',color:'#7777aa',size:11},margin:{t:8,b:50,l:52,r:16},xaxis:{gridcolor:'rgba(255,255,255,0.05)',zerolinecolor:'rgba(255,255,255,0.05)',tickfont:{size:10}},yaxis:{gridcolor:'rgba(255,255,255,0.05)',zerolinecolor:'rgba(255,255,255,0.05)',tickfont:{size:10}}};
const PLcfg={displayModeBar:false,responsive:true};

function tempRgb(t){const stops=[[0,[68,170,255]],[15,[100,200,220]],[22,[160,220,160]],[30,[255,200,80]],[38,[255,120,40]],[45,[255,30,60]]];t=Math.max(0,Math.min(45,t));for(let i=1;i<stops.length;i++){const[t0,c0]=stops[i-1],[t1,c1]=stops[i];if(t<=t1){const f=(t-t0)/(t1-t0);return`rgb(${c0.map((v,j)=>Math.round(v+(c1[j]-v)*f)).join(',')})`;}}return'rgb(255,30,60)';}
function tempRgba(t,a){return tempRgb(t).replace('rgb(','rgba(').replace(')',`,${a})`);}

function probAboveRegression(med,ecdf,threshold){if(!ecdf||!ecdf.pcts)return null;const delta=threshold-med,{pcts,vals}=ecdf;if(delta<=vals[0])return 1;if(delta>=vals[vals.length-1])return 0;let lo=0,hi=vals.length-1;while(lo<hi-1){const mid=(lo+hi)>>1;if(vals[mid]<delta)lo=mid;else hi=mid;}const t=(delta-vals[lo])/(vals[hi]-vals[lo]);return Math.max(0,Math.min(1,1-(pcts[lo]+t*(pcts[hi]-pcts[lo]))/100));}

function probAboveClassifier(city,threshold){const clfs=DATA[city].classifiers;if(!clfs||!clfs.length)return null;const sorted=[...clfs].sort((a,b)=>a.threshold_c-b.threshold_c);if(threshold<=sorted[0].threshold_c)return sorted[0].prob;if(threshold>=sorted[sorted.length-1].threshold_c)return sorted[sorted.length-1].prob;for(let i=1;i<sorted.length;i++){const lo=sorted[i-1],hi=sorted[i];if(threshold<=hi.threshold_c){const f=(threshold-lo.threshold_c)/(hi.threshold_c-lo.threshold_c);const logit=p=>Math.log(Math.max(0.001,p)/Math.max(0.001,1-p));const p=1/(1+Math.exp(-(logit(lo.prob)+f*(logit(hi.prob)-logit(lo.prob)))));return Math.max(0.01,Math.min(0.99,p));}}return null;}

function renderEdgeBoard(){
  const board=document.getElementById('edge-board');
  const allEdges=[];
  for(const[city,d]of Object.entries(DATA)){
    for(const m of(d.markets||[])){
      if(m.threshold_c==null||m.yes_prob==null)continue;
      const mp=m.model_prob_clf??m.model_prob;
      if(mp==null)continue;
      allEdges.push({city,...m,model_prob:mp,edge:mp-m.yes_prob});
    }
  }
  if(!allEdges.length){
    board.innerHTML=`<div class="no-markets-msg">No prediction markets found for tomorrow.<br>Markets for New York, Los Angeles and Chicago are available on Kalshi when active.<br><small style="opacity:.6">Markets open ~1–2 days before the target date.</small></div>`;
    return;
  }
  allEdges.sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));
  const EDGE_MIN=0.04;
  const header=`<div class="edge-board-header"><div>Market</div><div>Market %</div><div>Model %</div><div>Edge</div><div>Signal</div><div>Skill</div></div>`;
  const rows=allEdges.map(m=>{
    const abs=Math.abs(m.edge),rc=abs>=EDGE_MIN?(m.edge>0?'buy-yes':'buy-no'):'no-edge';
    const dc=m.edge>EDGE_MIN?'pos':m.edge<-EDGE_MIN?'neg':'neu';
    const ds=`${m.edge>0?'+':''}${(m.edge*100).toFixed(1)}pp`;
    let sig=`<span class="edge-signal signal-pass">— PASS</span>`;
    if(abs>=EDGE_MIN)sig=m.edge>0?`<a class="edge-signal signal-yes" href="${m.url||'#'}" target="_blank" rel="noopener">▲ BUY YES</a>`:`<a class="edge-signal signal-no" href="${m.url||'#'}" target="_blank" rel="noopener">▼ BUY NO</a>`;
    return`<div class="edge-row ${rc}"><div class="edge-city">${m.city}<small>${m.source} · ${m.threshold_c.toFixed(1)}°C (${m.threshold_f}°F)</small></div><div class="edge-val edge-mkt">${(m.yes_prob*100).toFixed(1)}%</div><div class="edge-val edge-mdl">${(m.model_prob*100).toFixed(1)}%</div><div class="edge-diff ${dc}">${ds}</div><div>${sig}</div><div class="edge-skill">${m.model_skill!=null?(m.model_skill*100).toFixed(0)+'%':'—'}<span>${m.model_brier!=null?'Brier '+m.model_brier.toFixed(3):''}</span></div></div>`;
  }).join('');

  // Bepaal data-bron voor noot
  const sources=[...new Set(Object.values(DATA).map(d=>d.data_source||'NOAA'))];
  const srcStr=sources.join(', ');
  const note=`<div class="data-note"><b>Data source: ${srcStr}</b> — model trained on same official station data as Kalshi settlement. Bias-corrected on test set (2022–present). Edge &lt; ±4pp shown as PASS.</div>`;
  board.innerHTML=header+rows+note;
}

function hmProbColor(p){
  // 0%=deep blue → 50%=green → 100%=hot red
  const h=Math.round(210-(210*p));
  const s=70+Math.round(p*10);
  const l=28+Math.round(p*14);
  return `hsla(${h},${s}%,${l}%,0.88)`;
}
function hmEdgeColor(e){
  if(Math.abs(e)<0.01)return'rgba(255,255,255,.05)';
  const abs=Math.min(Math.abs(e)/0.30,1);
  const alpha=0.25+abs*0.70;
  if(e>0)return`hsla(28,${60+abs*30}%,${30+abs*18}%,${alpha.toFixed(2)})`;
  return`hsla(210,${60+abs*30}%,${28+abs*18}%,${alpha.toFixed(2)})`;
}

function renderHeatmaps(){
  const cities=Object.entries(DATA)
    .map(([city,d])=>({city,markets:(d.markets||[]).filter(m=>m.yes_prob!=null&&m.threshold_f!=null)}))
    .filter(c=>c.markets.length>0);
  if(!cities.length)return;

  ['prob','edge'].forEach(mode=>{
    const el=document.getElementById('heatmap-'+mode);
    if(!el)return;
    const rows=cities.map(({city,markets})=>{
      const sorted=[...markets].sort((a,b)=>a.threshold_f-b.threshold_f);
      const cells=sorted.map(m=>{
        if(mode==='prob'){
          const col=hmProbColor(m.yes_prob);
          const lbl=`${Math.round(m.yes_prob*100)}%`;
          return`<div class="hm-cell" style="background:${col}" title="${m.title||''}"><span class="hm-cell-val">${lbl}</span><span class="hm-cell-th">${m.threshold_f}°F</span></div>`;
        } else {
          const mp=m.model_prob_clf??m.model_prob;
          if(mp==null)return`<div class="hm-cell hm-empty" title="no model"><span class="hm-cell-val">—</span><span class="hm-cell-th">${m.threshold_f}°F</span></div>`;
          const e=mp-m.yes_prob;
          const col=hmEdgeColor(e);
          const lbl=`${e>=0?'+':''}${Math.round(e*100)}pp`;
          return`<div class="hm-cell" style="background:${col}" title="Model ${Math.round(mp*100)}% vs Market ${Math.round(m.yes_prob*100)}%"><span class="hm-cell-val">${lbl}</span><span class="hm-cell-th">${m.threshold_f}°F</span></div>`;
        }
      }).join('');
      return`<div class="hm-row"><div class="hm-label">${city}</div><div class="hm-cells">${cells}</div></div>`;
    }).join('');
    el.innerHTML=rows;
  });
}

function renderDayCards(city,conf){
  const fc=DATA[city].forecast,cfg=CONF[conf];
  document.getElementById('conf-statement').innerHTML=cfg.text;
  const el=document.getElementById('day-cards');el.innerHTML='';
  fc.forEach(f=>{
    const certT=f[cfg.key],col=tempRgb(certT),bar=`linear-gradient(90deg,${tempRgba(certT,.15)},${col})`;
    const card=document.createElement('div');card.className='day-card';
    card.innerHTML=`<div class="dc-day">${f.day}</div><div class="dc-date">${f.dmy}</div><div class="dc-cert" style="color:${col}">${certT}<span class="dc-unit">°</span></div><div class="dc-sure">${cfg.label} certain</div><div class="dc-bar" style="background:${bar}"></div><div class="dc-divider"></div><div class="dc-bottom"><span style="opacity:.7">±${f.mae}°</span><span class="dc-med">${f.med}°C</span></div>`;
    el.appendChild(card);
  });
}

function renderFanChart(city,conf){
  const fc=DATA[city].forecast,days=fc.map(f=>f.label);
  const med=fc.map(f=>f.med),c80=fc.map(f=>f.c80),c90=fc.map(f=>f.c90),c95=fc.map(f=>f.c95),hi80=fc.map(f=>f.hi80),hi90=fc.map(f=>f.hi90);
  const band=(u,l,col)=>({type:'scatter',mode:'lines',x:[...days,...days.slice().reverse()],y:[...u,...l.slice().reverse()],fill:'toself',fillcolor:col,line:{color:'transparent'},hoverinfo:'skip',showlegend:false});
  Plotly.react('fan-chart',[
    band(hi90,c95,'rgba(68,170,255,0.05)'),band(hi80,c80,'rgba(255,153,68,0.06)'),
    {type:'scatter',mode:'lines',x:days,y:c95,name:'95%',line:{color:'#44aaff',width:conf===95?2.5:1.4,dash:conf===95?'solid':'dot'},marker:{size:conf===95?7:0,color:'#44aaff'},hovertemplate:'%{x}: <b>%{y}°C</b><extra>95%</extra>'},
    {type:'scatter',mode:'lines',x:days,y:c90,name:'90%',line:{color:'#aa66ff',width:conf===90?2.5:1.4,dash:conf===90?'solid':'dot'},marker:{size:conf===90?7:0,color:'#aa66ff'},hovertemplate:'%{x}: <b>%{y}°C</b><extra>90%</extra>'},
    {type:'scatter',mode:'lines',x:days,y:c80,name:'80%',line:{color:'#ff9944',width:conf===80?2.5:1.4,dash:conf===80?'solid':'dot'},marker:{size:conf===80?7:0,color:'#ff9944'},hovertemplate:'%{x}: <b>%{y}°C</b><extra>80%</extra>'},
    {type:'scatter',mode:'lines+markers',x:days,y:med,name:'Median',line:{color:'#ff5577',width:2.5},marker:{size:7,color:'#ff5577'},hovertemplate:'%{x}: <b>%{y}°C</b><extra>Median</extra>'},
  ],{...PL,yaxis:{...PL.yaxis,title:{text:'Max temp (°C)',standoff:8,font:{size:10}}},showlegend:false},PLcfg);
}

function renderLineChart(city,conf){
  const d=DATA[city],h=d.history,fc=d.forecast,cfg=CONF[conf];
  const jD=h.dates[h.dates.length-1],jT=h.temps[h.temps.length-1];
  const fcD=[jD,...fc.map(f=>f.date)],fcM=[jT,...fc.map(f=>f.med)];
  const fcL=[jT,...fc.map(f=>f[cfg.key])],fcH=[jT,...fc.map(f=>f.hi90)];
  Plotly.react('line-chart',[
    {type:'scatter',mode:'lines',x:h.dates,y:h.temps,name:'Historical',line:{color:'#7c44ff',width:1.5},hovertemplate:'%{x}: <b>%{y}°C</b><extra>Historical</extra>'},
    {type:'scatter',mode:'lines',x:[...fcD,...fcD.slice().reverse()],y:[...fcH,...fcL.slice().reverse()],fill:'toself',fillcolor:cfg.fill,line:{color:'transparent'},hoverinfo:'skip',showlegend:false},
    {type:'scatter',mode:'lines+markers',x:fcD,y:fcM,name:'Forecast',line:{color:'#ff5577',width:2.5},marker:{size:5,color:'#ff5577'},hovertemplate:'%{x}: <b>%{y}°C</b><extra>Forecast</extra>'},
    {type:'scatter',mode:'lines',x:fcD,y:fcL,name:`${conf}%`,line:{color:cfg.color,width:1.8,dash:'dot'},hovertemplate:`%{x}: <b>%{y}°C</b><extra>${conf}%</extra>`},
  ],{...PL,yaxis:{...PL.yaxis,title:{text:'Max temp (°C)',standoff:8,font:{size:10}}},xaxis:{...PL.xaxis,type:'date'},legend:{x:.01,y:.99,bgcolor:'rgba(0,0,0,0)',font:{size:10}},shapes:[{type:'line',x0:jD,x1:jD,y0:0,y1:1,yref:'paper',line:{color:'rgba(255,255,255,0.1)',width:1,dash:'dot'}}]},PLcfg);
}

function initProbCalc(city){
  const fc0=DATA[city].forecast[0];
  const ecdf={pcts:fc0.ecdf_pcts,vals:fc0.ecdf_vals};
  const med=fc0.med,rmse=fc0.rmse,bias=fc0.bias||0;
  const lo=Math.floor(med-3*rmse),hi=Math.ceil(med+3*rmse);
  const slider=document.getElementById('tempSlider');
  slider.min=lo;slider.max=hi;slider.value=Math.round(med);
  document.getElementById('sliderMin').textContent=`${lo}°C`;
  document.getElementById('sliderMax').textContent=`${hi}°C`;
  const biasAbs=Math.abs(bias);
  document.getElementById('bias-note').innerHTML=`<b>Test-set median bias: ${bias>0?'+':''}${bias.toFixed(2)}°C</b> — `+(biasAbs<0.25?'model is well-calibrated.':bias>0?`model under-predicts by ${biasAbs.toFixed(1)}°C on average.`:`model over-predicts by ${biasAbs.toFixed(1)}°C on average.`)+` Classifier probabilities corrected for this bias.`;

  function update(){
    const T=parseFloat(slider.value),col=tempRgb(T);
    document.getElementById('tempDisplay').innerHTML=`${T.toFixed(1)}<span>°C</span>`;
    document.getElementById('tempDisplay').style.color=col;
    const pReg=probAboveRegression(med,ecdf,T);
    const pClf=probAboveClassifier(city,T);
    const fmt=p=>p!=null?`${(p*100).toFixed(1)}%`:'—';
    const pcol=p=>p==null?'var(--muted)':p>0.7?'#66ffaa':p>0.4?'#ffdd44':'#ff5577';
    const ce=document.getElementById('prob-clf');ce.textContent=fmt(pClf);ce.style.color=pcol(pClf);
    const re=document.getElementById('prob-reg');re.textContent=fmt(pReg);re.style.color=pcol(pReg);
    renderProbMarketsPanel(city,T,pClf??pReg);
  }
  slider.addEventListener('input',update);update();
}

function renderProbMarketsPanel(city,threshold,modelProb){
  const markets=(DATA[city].markets||[]).filter(m=>m.threshold_c!=null);
  const panel=document.getElementById('prob-markets-panel');
  if(!markets.length){panel.innerHTML=`<div style="font-size:.75rem;color:var(--muted);padding-top:8px">No markets found for ${city} tomorrow.<br><br>Kalshi markets for NYC, LA and Chicago open ~1–2 days before target date.</div>`;return;}
  const sorted=[...markets].sort((a,b)=>Math.abs(a.threshold_c-threshold)-Math.abs(b.threshold_c-threshold));
  const allRows=sorted.slice(0,5).map(m=>{
    const mmp=m.model_prob_clf??m.model_prob;
    const me=mmp!=null?mmp-m.yes_prob:null;
    const mc=me!=null&&Math.abs(me)>=0.04?(me>0?'pos':'neg'):'neu';
    const active=Math.abs(m.threshold_c-threshold)<1?'style="background:rgba(124,68,255,.08)"':'';
    return`<div ${active} style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);font-size:.72rem"><span>${m.threshold_c.toFixed(1)}°C<span style="color:var(--muted);margin-left:4px">${m.threshold_f}°F</span></span><span style="color:var(--cold)">${(m.yes_prob*100).toFixed(1)}%</span><span style="color:#aa66ff">${mmp!=null?(mmp*100).toFixed(1)+'%':'—'}</span><span class="${mc}" style="font-weight:700">${me!=null?(me>0?'+':'')+(me*100).toFixed(1)+'pp':'—'}</span></div>`;
  }).join('');
  const near=sorted[0],nmp=near.model_prob_clf??near.model_prob,ne=nmp!=null?nmp-near.yes_prob:null;
  const neStr=ne!=null?`${ne>0?'+':''}${(ne*100).toFixed(1)}pp`:'—';
  const neCls=ne!=null&&Math.abs(ne)>=0.04?(ne>0?'pos':'neg'):'neu';
  const sigCls=ne==null||Math.abs(ne)<0.04?'signal-pass':ne>0?'signal-yes':'signal-no';
  const sigLbl=ne==null||Math.abs(ne)<0.04?'— PASS':ne>0?'▲ BUY YES':'▼ BUY NO';
  panel.innerHTML=`<div style="font-size:.62rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px">${near.source} · ${city}</div><div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:16px"><div style="display:flex;justify-content:space-between;padding:6px 12px;font-size:.58rem;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)"><span>Threshold</span><span style="color:var(--cold)">Market</span><span style="color:#aa66ff">Model</span><span>Edge</span></div>${allRows}</div><div style="text-align:center"><span class="edge-signal ${sigCls}" style="font-size:.85rem;padding:10px 24px">${sigLbl}</span><div style="font-size:.65rem;color:var(--muted);margin-top:8px">Nearest: ${near.threshold_c.toFixed(1)}°C · Edge: <span class="${neCls}">${neStr}</span></div></div>`;
}

function renderMeta(city,conf){
  const fc=DATA[city].forecast,key=CONF[conf].key;
  document.getElementById('meta-hi').textContent=`${Math.round(Math.max(...fc.map(f=>f.med)))}°C`;
  document.getElementById('meta-lo').textContent=`${Math.round(Math.min(...fc.map(f=>f[key])))}°C`;
  document.getElementById('meta-mae').textContent=`${fc[0].mae.toFixed(2)}°C`;
}

function renderAll(){renderDayCards(activeCity,activeConf);renderFanChart(activeCity,activeConf);renderLineChart(activeCity,activeConf);renderMeta(activeCity,activeConf);initProbCalc(activeCity);}

(function(){const cv=document.getElementById('bgCanvas');if(!cv)return;const ctx=cv.getContext('2d');let W,H,stars=[];function initStars(){stars=Array.from({length:200},()=>({x:Math.random()*W,y:Math.random()*H,r:.25+Math.random()*1.1,phase:Math.random()*Math.PI*2,spd:.004+Math.random()*.013,base:.15+Math.random()*.55}));}function resize(){W=cv.width=window.innerWidth;H=cv.height=window.innerHeight;initStars();}let t=0,last=0;function frame(now){const dt=Math.min((now-last)/16.67,2.5);last=now;t+=dt;const sky=ctx.createLinearGradient(0,0,0,H);sky.addColorStop(0,'#020209');sky.addColorStop(.5,'#050612');sky.addColorStop(1,'#07050f');ctx.fillStyle=sky;ctx.fillRect(0,0,W,H);for(const s of stars){const a=s.base*(.5+.5*Math.sin(s.phase+t*s.spd));ctx.fillStyle=`rgba(200,215,255,${a.toFixed(2)})`;ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill();}requestAnimationFrame(frame);}window.addEventListener('resize',resize);resize();requestAnimationFrame(frame);})();

document.addEventListener('DOMContentLoaded',()=>{
  const sel=document.getElementById('city-select');
  Object.keys(DATA).forEach((city,i)=>{const opt=document.createElement('option');opt.value=city;opt.textContent=`${city} ${DATA[city].data_source==='NOAA'?'✓':''}`;sel.appendChild(opt);if(i===0)activeCity=city;});
  document.querySelectorAll('.conf-btn').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.conf-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');activeConf=parseInt(btn.dataset.conf);renderAll();});});
  sel.addEventListener('change',()=>{activeCity=sel.value.split(' ✓')[0].trim();renderAll();});

  // Footer data source summary
  const sources=[...new Set(Object.values(DATA).map(d=>d.data_source))];
  document.getElementById('footer-source').textContent=sources.join(' / ');

  document.getElementById('gen-time').textContent='__GEN_TIME__';
  renderHeatmaps();
  renderEdgeBoard();
  renderAll();
});
</script>
</body>
</html>
"""

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if not NOAA_TOKEN:
        print("\n  ⚠  Geen NOAA token gevonden.")
        print("     Vraag een gratis token aan op: https://www.ncei.noaa.gov/cdo-web/token")
        print("     Sla op als noaa_token.txt of zet NOAA_TOKEN omgevingsvariabele.")
        print("     Doorgaan met Open-Meteo ERA5 als fallback...\n")

    print("\n  TEMPERATURE FORECAST  (NOAA station data + market edge)")
    print("  " + "="*58)

    all_data = {}
    tomorrow = datetime.now().date() + timedelta(days=1)

    for city in CITIES:
        name = city["name"]
        print(f"\n  {name:<16}", end="", flush=True)

        try:
            # 1. Data ophalen (NOAA of Open-Meteo)
            df_raw, source = get_city_data(city, NOAA_TOKEN)
            n_years = (df_raw.index[-1] - df_raw.index[0]).days / 365.25
            last_date = df_raw.index[-1].date()
            print(f"  {n_years:.0f}y [{source}, t/m {last_date}]", end="", flush=True)

            # 2. Regressie (7-daagse forecast)
            reg_models, error_pcts = train_regression_models(df_raw)
            maes = " ".join(f"+{k}:{error_pcts[k]['mae']:.1f}" for k in HORIZONS)
            print(f"\n               MAE {maes}", end="", flush=True)

            forecasts = forecast_7days(reg_models, error_pcts, df_raw)
            history   = get_history(df_raw)

            # 3. Markten ophalen (Polymarket primair, Kalshi als fallback)
            markets = fetch_polymarket_markets(city.get("polymarket"), tomorrow)
            if not markets:
                markets = fetch_kalshi_markets(city.get("kalshi"), tomorrow)

            # 4. Classificatiemodellen (per marktdrempel + extra drempels voor slider)
            classifiers_summary = []
            if markets:
                src = markets[0].get("source", "market")
                print(f"  | {len(markets)} {src}-markten", end="", flush=True)
            for m in markets:
                thresh = m.get("threshold_c")
                if thresh is None: continue
                clf = train_prob_classifier(df_raw, thresh)
                if clf:
                    prob = predict_prob(clf, df_raw)
                    m["model_prob_clf"] = prob
                    m["model_skill"]    = clf["skill"]
                    m["model_brier"]    = clf["brier"]
                    classifiers_summary.append({"threshold_c": thresh, "prob": prob, "skill": clf["skill"]})

            # Extra slider-drempels voor steden met markets
            if city.get("polymarket") or city.get("kalshi"):
                med1  = forecasts[0]["med"]
                rmse1 = error_pcts[1]["rmse"]
                for i in range(-5, 6):
                    thresh = round(med1 + i * rmse1 * 0.4, 1)
                    if any(abs(thresh - cs["threshold_c"]) < 0.4 for cs in classifiers_summary):
                        continue
                    clf = train_prob_classifier(df_raw, thresh)
                    if clf:
                        classifiers_summary.append({
                            "threshold_c": thresh,
                            "prob": predict_prob(clf, df_raw),
                            "skill": clf["skill"],
                        })

            all_data[name] = {
                "data_source": source,
                "noaa_station": city.get("noaa_label", ""),
                "mae":          error_pcts[1]["mae"],
                "rmse":         error_pcts[1]["rmse"],
                "history":      history,
                "forecast":     forecasts,
                "markets":      markets,
                "classifiers":  classifiers_summary,
            }
            print("  ✓")

        except Exception as e:
            import traceback
            print(f"\n  FOUT: {e}")
            traceback.print_exc()

    if not all_data:
        print("Geen data."); return

    gen_time = datetime.now().strftime("%d %b %Y %H:%M")
    html = HTML_TEMPLATE.replace("__DATA__", json.dumps(all_data, ensure_ascii=False))
    html = html.replace("__GEN_TIME__", gen_time)
    with open("forecast.html", "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\n  → forecast.html geschreven\n")

if __name__ == "__main__":
    if sys.platform == "win32":
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    main()
