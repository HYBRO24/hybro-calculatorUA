import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer
} from "recharts";

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const NIGHT_TARIFF   = 1.32;
const DAY_TARIFF     = 2.64;
const PENALTY_TARIFF = 4.32;
const LIMIT_KWH      = 2000;
const ELEC_INFLATION = 0.10;
const GAS_INFLATION  = 0.10;

const fmtUAH = (n) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + " млн ₴";
  return Math.round(n).toLocaleString("uk-UA") + " ₴";
};
const fmtK = (n) => n >= 1000
  ? (n / 1000).toFixed(0) + "k"
  : Math.round(n).toString();

/* ─────────────────────────────────────────────
   CORE MATH
───────────────────────────────────────────── */
function calcMonthCost(kwh, nightFrac, dayFrac) {
  const within = Math.min(kwh, LIMIT_KWH);
  const above  = Math.max(0, kwh - LIMIT_KWH);
  return within * (nightFrac * NIGHT_TARIFF + dayFrac * DAY_TARIFF) + above * PENALTY_TARIFF;
}

function calcYear1OpEx(area, epcValue, officialToggle) {
  const heatingHYBRO  = area * epcValue * 0.7225;
  const heatingHP     = (area * epcValue) / 3.5;
  const heatingGas_m3 = (area * epcValue) / 9.5;
  const hybroMonth    = heatingHYBRO / 6 + 200;
  const hpMonth       = heatingHP    / 6 + 200;

  let hybroCost, hpCost;
  if (officialToggle) {
    hybroCost = calcMonthCost(hybroMonth, 0.60, 0.40) * 6 + 1200 * 2.16;
    hpCost    = calcMonthCost(hpMonth,    0.50, 0.50) * 6 + 1200 * 2.16;
  } else {
    hybroCost = (heatingHYBRO * 4.32) + (2400 * 2.16);
    hpCost    = (heatingHP    * 4.32) + (2400 * 2.16);
  }
  const gasCost = (heatingGas_m3 * 12) + 4000;
  return { hybroCost, hpCost, gasCost, hybroMonth, hpMonth, heatingHYBRO, heatingHP, heatingGas_m3 };
}

function calcHybroCapEx(area, epcValue) {
  const dailyKwh    = (area * epcValue * 0.7225) / 180;
  const panelsCount = Math.ceil(dailyKwh / 2.475);
  const panelCost   = panelsCount * 4990;
  const install     = panelsCount * 900;
  const controllers = Math.ceil(area / 20) * 2000;
  const shield      = 15000;
  return {
    capex:        panelCost + install + controllers + shield,
    panelsCount,
    dailyKwh,
    peakKw:       +(panelsCount * 0.375).toFixed(2),
    activeHours:  +(dailyKwh / (panelsCount * 0.375)).toFixed(1),
  };
}

function buildTCO(area, epcValue, officialToggle, moratoriumToggle, hybroCapEx, solarToggle) {
  const solarCapEx   = solarToggle ? (area / 100) * 240_000 : 0;
  const capexHYBRO   = hybroCapEx + solarCapEx;
  const capexGas     = 140_000 + area * 1200;
  const capexHP      = 250_000 + area * 1200 + solarCapEx;
  const { hybroCost: hybroCostBase, hpCost: hpCostBase, gasCost } =
    calcYear1OpEx(area, epcValue, officialToggle);
  // Solar zeroes electricity OpEx for HYBRO and HP
  const hybroCost = solarToggle ? 0 : hybroCostBase;
  const hpCost    = solarToggle ? 0 : hpCostBase;

  let cumHYBRO = capexHYBRO, cumGas = capexGas, cumHP = capexHP;
  const data = [{ year: 0, hybro: Math.round(cumHYBRO), gas: Math.round(cumGas), hp: Math.round(cumHP) }];

  for (let y = 1; y <= 20; y++) {
    const elecF = Math.pow(1 + ELEC_INFLATION, y);
    let gCost;
    if (!moratoriumToggle) {
      gCost = gasCost * Math.pow(1 + GAS_INFLATION, y);
    } else if (y <= 2) {
      gCost = gasCost * Math.pow(1 + GAS_INFLATION, y);
    } else if (y === 3) {
      gCost = gasCost * Math.pow(1 + GAS_INFLATION, 2) * 1.5;
    } else {
      gCost = gasCost * Math.pow(1 + GAS_INFLATION, 2) * 1.5 * Math.pow(1 + GAS_INFLATION, y - 3);
    }
    const maintGas   = 2000 + (y % 5 === 0 ? 5000 : 0) + (y === 12 ? 50_000 : 0);
    const maintHP    = 7000 + (y === 15 ? 80_000 : 0);
    cumHYBRO += hybroCost * elecF;
    cumGas   += gCost + maintGas;
    cumHP    += hpCost * elecF + maintHP;
    data.push({ year: y, hybro: Math.round(cumHYBRO), gas: Math.round(cumGas), hp: Math.round(cumHP) });
  }
  return data;
}

function findBreakEven(tco, keyA, keyB) {
  for (let i = 1; i < tco.length; i++) {
    const prev = tco[i - 1], curr = tco[i];
    if (prev[keyA] >= prev[keyB] && curr[keyA] < curr[keyB]) {
      const frac = (prev[keyA] - prev[keyB]) /
        ((prev[keyA] - prev[keyB]) - (curr[keyA] - curr[keyB]));
      return ((i - 1) + frac).toFixed(1);
    }
  }
  return null;
}

/* ─────────────────────────────────────────────
   CUSTOM TOOLTIP
───────────────────────────────────────────── */
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const names  = { hybro: "HYBRO", gas: "Газовий котел", hp: "Тепловий насос" };
  const colors = { hybro: "#0D2B4E", gas: "#C4622D", hp: "#1A6FAD" };
  return (
    <div style={{
      background: "#fff", border: "1px solid #E2E8F0", borderRadius: 10,
      padding: "12px 16px", boxShadow: "0 4px 16px rgba(0,0,0,.08)",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase", color: "#64748B", marginBottom: 8 }}>
        Рік {label}
      </p>
      {payload.map(p => (
        <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 20, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors[p.dataKey] }}>{names[p.dataKey]}</span>
          <span style={{ fontSize: 13, fontFamily: "'DM Mono', monospace", fontWeight: 500, color: "#1A202C" }}>
            {fmtUAH(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

/* ─────────────────────────────────────────────
   SECTION TITLE COMPONENT
───────────────────────────────────────────── */
const SectionTitle = ({ children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase", color: "#0D2B4E", whiteSpace: "nowrap" }}>
      {children}
    </span>
    <div style={{ flex: 1, height: 1, background: "#E8EFF7" }} />
  </div>
);

/* ─────────────────────────────────────────────
   TOGGLE COMPONENT
───────────────────────────────────────────── */
const Toggle = ({ active, onToggle, title, subtitle, accentColor = "#0D2B4E", accentBg = "#E8EFF7", accentBorder = "rgba(26,74,120,.27)" }) => (
  <div
    onClick={onToggle}
    style={{
      background: active ? accentBg : "#FFFFFF",
      border: `1px solid ${active ? accentBorder : "#E2E8F0"}`,
      borderRadius: 12, padding: "16px 20px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      cursor: "pointer", userSelect: "none", transition: "all .18s",
      marginBottom: 12,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      {/* Pill */}
      <div style={{
        width: 46, height: 26, borderRadius: 13, flexShrink: 0, position: "relative",
        background: active ? accentColor : "#E2E8F0", transition: "background .2s",
      }}>
        <div style={{
          position: "absolute", top: 3,
          left: active ? 23 : 3,
          width: 20, height: 20, borderRadius: "50%",
          background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.2)",
          transition: "left .2s",
        }} />
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A202C" }}>{title}</div>
        <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>{subtitle}</div>
      </div>
    </div>
    {active && (
      <div style={{
        background: accentColor, color: "#fff",
        fontSize: 11, fontWeight: 700, padding: "3px 12px",
        borderRadius: 20, flexShrink: 0, marginLeft: 12,
      }}>
        Активовано
      </div>
    )}
  </div>
);

/* ─────────────────────────────────────────────
   MAIN COMPONENT
───────────────────────────────────────────── */
export default function HybroUATCO() {
  const [area,             setArea]             = useState(100);
  const [epcValue,         setEpcValue]         = useState(75);
  const [officialToggle,   setOfficialToggle]   = useState(true);
  const [moratoriumToggle, setMoratoriumToggle] = useState(false);
  const [solarToggle,      setSolarToggle]      = useState(false);

  const hybro = useMemo(
    () => calcHybroCapEx(area, epcValue),
    [area, epcValue]
  );

  const solarCapEx = (area / 100) * 240_000;

  const tco = useMemo(
    () => buildTCO(area, epcValue, officialToggle, moratoriumToggle, hybro.capex, solarToggle),
    [area, epcValue, officialToggle, moratoriumToggle, hybro.capex, solarToggle]
  );
  const ops = useMemo(() => calcYear1OpEx(area, epcValue, officialToggle),
    [area, epcValue, officialToggle]);

  const capexHYBRO = hybro.capex + (solarToggle ? solarCapEx : 0);
  const capexGas   = 140_000 + area * 1200;
  const capexHP    = 250_000 + area * 1200 + (solarToggle ? solarCapEx : 0);

  const beGas = findBreakEven(tco, "gas",  "hybro");
  const beHP  = findBreakEven(tco, "hp",   "hybro");

  const hybroOver = ops.hybroMonth > LIMIT_KWH;
  const hpOver    = ops.hpMonth    > LIMIT_KWH;

  let blackout;
  if (area <= 120)      blackout = { hybroCost: "~150 000 ₴", hybro: "5 кВт / 10 кВт·год", waterCost: "~400 000 ₴", water: "12 кВт / 30 кВт·год", waterLabel: "Промисловий резерв" };
  else if (area <= 180) blackout = { hybroCost: "~220 000 ₴", hybro: "8 кВт / 15 кВт·год", waterCost: "~600 000 ₴", water: "20 кВт / 45 кВт·год", waterLabel: "Промисловий резерв" };
  else                  blackout = { hybroCost: "~350 000 ₴", hybro: "12 кВт / 20 кВт·год", waterCost: null,         water: null,                waterLabel: "Дизельний генератор" };

  const epcLabel   = { 35: "А+", 50: "А", 75: "B", 100: "C", 130: "D" }[epcValue];
  const panels     = hybro.panelsCount;
  const sliderPct  = ((area - 50) / 200) * 100;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800&family=DM+Mono:wght@400;500&family=Outfit:wght@700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .hybro { font-family: 'DM Sans', sans-serif; background: #F7F8FA; color: #1A202C; min-height: 100vh; }

        /* HEADER */
        .hybro__header {
          background: #0D2B4E; padding: 36px 24px 40px;
          position: relative; overflow: hidden;
        }
        .hybro__header-deco {
          position: absolute; top: -80px; right: -80px;
          width: 280px; height: 280px; border-radius: 50%;
          background: radial-gradient(circle, rgba(255,255,255,.03) 0%, transparent 70%);
          pointer-events: none;
        }
        .hybro__badge {
          display: inline-block; margin-bottom: 14px;
          background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15);
          color: rgba(255,255,255,.65); font-size: 10px; letter-spacing: .14em;
          text-transform: uppercase; border-radius: 20px; padding: 4px 12px;
        }
        .hybro__h1 {
          font-family: 'Outfit', sans-serif;
          font-size: clamp(24px, 5vw, 42px); font-weight: 800;
          color: #fff; letter-spacing: -.5px; line-height: 1.15; margin-bottom: 12px;
        }
        .hybro__h1 span { color: #7EB8F7; }
        .hybro__sub { font-size: 14px; color: rgba(255,255,255,.5); max-width: 520px; line-height: 1.6; }

        /* BODY */
        .hybro__body { max-width: 880px; margin: 0 auto; padding: 24px 16px 60px; }

        /* CARD */
        .card {
          background: #fff; border: 1px solid #E2E8F0;
          border-radius: 12px; padding: 24px; margin-bottom: 16px;
        }

        /* SLIDER */
        .hybro-slider {
          -webkit-appearance: none; width: 100%; height: 4px;
          border-radius: 4px; outline: none; cursor: pointer; margin: 10px 0;
          background: linear-gradient(to right,
            #0D2B4E 0%, #0D2B4E var(--val, 25%),
            #E2E8F0 var(--val, 25%), #E2E8F0 100%
          );
        }
        .hybro-slider::-webkit-slider-thumb {
          -webkit-appearance: none; width: 20px; height: 20px;
          border-radius: 50%; background: #fff;
          border: 2px solid #0D2B4E;
          box-shadow: 0 1px 4px rgba(13,43,78,.25); cursor: pointer;
        }

        /* SELECT */
        .hybro-select-wrap { position: relative; }
        .hybro-select {
          width: 100%; padding: 11px 36px 11px 14px;
          border: 1px solid #E2E8F0; border-radius: 8px;
          background: #fff; font-family: 'DM Sans', sans-serif;
          font-size: 14px; color: #1A202C; appearance: none; cursor: pointer; outline: none;
          transition: border-color .15s;
        }
        .hybro-select:focus { border-color: #0D2B4E; }
        .hybro-select-wrap::after {
          content: "▾"; position: absolute; right: 12px; top: 50%;
          transform: translateY(-50%); color: #64748B; pointer-events: none; font-size: 13px;
        }

        /* OPEX ROW */
        .opex-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 16px; background: #F7F8FA;
          border-radius: 10px; margin-bottom: 8px;
        }
        .opex-row:last-child { margin-bottom: 0; }

        /* CONCLUSION */
        .conclusion { background: #0D2B4E; border-radius: 12px; padding: 28px; margin-bottom: 0; }
        .conclusion__title {
          font-size: 10px; font-weight: 700; letter-spacing: .14em;
          text-transform: uppercase; color: rgba(255,255,255,.4); margin-bottom: 16px;
        }
        .conclusion__block {
          border-radius: 8px; padding: 14px 18px; margin-bottom: 10px;
        }
        .conclusion__block:last-child { margin-bottom: 0; }
        .conclusion__block--blue  { background: rgba(126,184,247,.10); border-left: 3px solid #7EB8F7; }
        .conclusion__block--amber { background: rgba(196,98,45,.12);   border-left: 3px solid #C4622D; }
        .conclusion__text {
          font-size: 15px; line-height: 1.8;
          color: rgba(255,255,255,.82); font-weight: 500;
        }
        .conclusion__text strong { color: #fff; font-weight: 800; }
        .conclusion__text .accent { color: #7EB8F7; font-weight: 700; }
        .conclusion__text .num {
          font-family: 'Outfit', sans-serif; font-size: 20px;
          font-weight: 800; color: #fff;
        }
        .conclusion__text .warn { color: #fca5a5; font-weight: 700; }
        .conclusion__pill {
          display: inline-block;
          background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12);
          color: rgba(255,255,255,.6); font-size: 11px; font-weight: 600;
          padding: 4px 12px; border-radius: 20px; margin-top: 8px;
        }

        /* ALERTS */
        .alert { border-radius: 8px; padding: 9px 12px; font-size: 12px; line-height: 1.5; margin-top: 10px; }
        .alert--green { color: #16a34a; background: #f0fdf4; border: 1px solid #bbf7d0; }
        .alert--red   { color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; }
        .alert--amber { color: #d97706; background: #fffbeb; border: 1px solid #fde68a; }

        /* INFO TILES */
        .info-tile {
          border-radius: 10px; padding: 18px 20px;
        }
        .info-tile--dark { background: #0D2B4E; }
        .info-tile--amber { background: #fffbeb; border: 1px solid #fde68a; }
        .info-tile__num {
          font-family: 'Outfit', sans-serif; font-size: 42px;
          font-weight: 800; line-height: 1;
        }
        .info-tile__num--white { color: #fff; }
        .info-tile__num--amber { color: #d97706; font-size: 28px; }
        .info-tile__label { font-size: 14px; font-weight: 700; margin-top: 6px; }
        .info-tile__label--white { color: #fff; }
        .info-tile__label--amber { color: #92400e; }
        .info-tile__sub { font-size: 12px; margin-top: 4px; }
        .info-tile__sub--muted { color: rgba(255,255,255,.55); }
        .info-tile__sub--amber { color: #92400e; }

        /* GRID */
        .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .g3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }

        @media (max-width: 580px) {
          .g2, .g3 { grid-template-columns: 1fr; }
          .hybro__body { padding: 16px 12px 40px; }
        }
      `}</style>

      <div className="hybro">

        {/* ── HEADER ── */}
        <div className="hybro__header">
          <div className="hybro__header-deco" />
          <div className="hybro__badge">Версія для України · UAH</div>
          <h1 className="hybro__h1">
            Реальна вартість опалення<br />
            <span>на 20 років</span>
          </h1>
          <p className="hybro__sub">
            Порівняйте повну вартість HYBRO, газового котла та теплового насоса —
            з урахуванням монтажу, енергоспоживання та інфляції.
          </p>
        </div>

        {/* ── BODY ── */}
        <div className="hybro__body">

          {/* TOGGLES */}
          <Toggle
            active={officialToggle}
            onToggle={() => setOfficialToggle(v => !v)}
            title="Офіційне електроопалення (Ліміт 2 000 кВт·год/міс)"
            subtitle="Нічний 1.32 ₴ · Денний 2.64 ₴ · Понад ліміт 4.32 ₴/кВт·год"
          />
          <Toggle
            active={moratoriumToggle}
            onToggle={() => setMoratoriumToggle(v => !v)}
            title="Сценарій МВФ: Скасування мораторію на газ"
            subtitle="З 3-го року газовий тариф зростає на +50% до нової бази"
            accentColor="#C4622D"
            accentBg="#fff7ed"
            accentBorder="rgba(196,98,45,.30)"
          />
          <Toggle
            active={solarToggle}
            onToggle={() => setSolarToggle(v => !v)}
            title="Інвестиція в СЕС (Net Billing / Активний споживач)"
            subtitle={`Встановлення сонячної станції з розрахунку 10 кВт на кожні 100 м² · ${fmtUAH(solarCapEx)}`}
            accentColor="#16a34a"
            accentBg="#f0fdf4"
            accentBorder="rgba(22,163,74,.30)"
          />

          {/* PARAMETERS */}
          <div className="card">
            <SectionTitle>Параметри об'єкта</SectionTitle>
            <div className="g2" style={{ alignItems: "start" }}>
              {/* Area */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase", color: "#64748B", marginBottom: 8 }}>
                  Площа приміщення
                </div>
                <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 40, fontWeight: 800, color: "#0D2B4E", lineHeight: 1 }}>
                  {area}<span style={{ fontSize: 18, fontWeight: 700, color: "#64748B", marginLeft: 4 }}>м²</span>
                </div>
                <input
                  type="range" min={50} max={250} value={area}
                  className="hybro-slider"
                  style={{ "--val": `${sliderPct}%` } as any}
                  onChange={e => setArea(Number(e.target.value))}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94A3B8" }}>
                  <span>50 м²</span><span>250 м²</span>
                </div>
              </div>

              {/* EPC */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase", color: "#64748B", marginBottom: 8 }}>
                  Клас енергоефективності (EPC)
                </div>
                <div className="hybro-select-wrap">
                  <select className="hybro-select" value={epcValue} onChange={e => setEpcValue(Number(e.target.value))}>
                    <option value={35}>Клас А+ · 35 кВт·год/м²</option>
                    <option value={50}>Клас А · 50 кВт·год/м²</option>
                    <option value={75}>Клас B · 75 кВт·год/м²</option>
                    <option value={100}>Клас C · 100 кВт·год/м²</option>
                    <option value={130}>Клас D · 130 кВт·год/м²</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* CHART */}
          <div className="card">
            <SectionTitle>Сукупна вартість за 20 років (TCO)</SectionTitle>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={tco} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="year"
                  tick={{ fill: "#94A3B8", fontSize: 12, fontFamily: "DM Sans" }}
                  tickLine={false} axisLine={{ stroke: "#E2E8F0" }}
                />
                <YAxis
                  tickFormatter={v => fmtK(v) + " ₴"}
                  tick={{ fill: "#94A3B8", fontSize: 11, fontFamily: "DM Mono" }}
                  tickLine={false} axisLine={false} width={64}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  formatter={v => ({ hybro: "HYBRO", gas: "Газ", hp: "Тепловий насос" }[v])}
                  wrapperStyle={{ fontSize: 13, fontFamily: "DM Sans", paddingTop: 10 }}
                />

                <Line type="monotone" dataKey="gas"   stroke="#C4622D" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="hp"    stroke="#1A6FAD" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="hybro" stroke="#0D2B4E" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* INFO TILES */}
          <div className="g2" style={{ marginBottom: 16 }}>
            <div className="info-tile info-tile--dark">
              <div className="info-tile__num info-tile__num--white">{panels}</div>
              <div className="info-tile__label info-tile__label--white">Панелей HYBRO (375 Вт)</div>
              <div className="info-tile__sub info-tile__sub--muted">
                {hybro.peakKw} кВт пікового навантаження · EPC {epcLabel} · {area} м²
              </div>
            </div>
            <div className="info-tile info-tile--amber">
              <div className="info-tile__num info-tile__num--amber">~{Math.round(hybro.dailyKwh)} кВт·год/день</div>
              <div className="info-tile__label info-tile__label--amber">Споживання HYBRO (сезон ÷ 180 днів)</div>
              <div className="info-tile__sub info-tile__sub--amber" style={{ marginTop: 6 }}>
                {Math.round(ops.heatingHYBRO).toLocaleString("uk-UA")} кВт·год/рік · ТО: 0 ₴
              </div>
              <div className="info-tile__sub info-tile__sub--amber" style={{ marginTop: 4 }}>
                Середній час роботи панелей: ~{hybro.activeHours} год/добу
              </div>
            </div>
          </div>

          {/* CAPEX */}
          <div className="card">
            <SectionTitle>Початкові інвестиції (CAPEX)</SectionTitle>
            <div className="g3">
              {[
                { accent: "#C4622D", label: "Газовий котел", name: "Газ",           value: capexGas,   sub: "котел + підключення + труби" },
                { accent: "#1A6FAD", label: "Тепловий насос", name: "Тепловий насос", value: capexHP,  sub: "монтаж + тепла підлога" },
                { accent: "#0D2B4E", label: "Інфрачервоні панелі", name: "HYBRO",   value: capexHYBRO, sub: `${panels} пан. + монтаж + контролери + щит` },
              ].map(c => (
                <div key={c.label} style={{
                  border: "1px solid #E2E8F0",
                  borderTop: `3px solid ${c.accent}`,
                  borderRadius: 10, padding: "18px 20px",
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "#64748B", marginBottom: 6 }}>{c.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#1A202C", marginBottom: 10 }}>{c.name}</div>
                  <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 28, fontWeight: 800, color: c.accent, letterSpacing: -1 }}>{fmtUAH(c.value)}</div>
                  <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4 }}>{c.sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* OPEX */}
          <div className="card">
            <SectionTitle>Річна вартість опалення (OPEX, Рік 1)</SectionTitle>
            {[
              { accent: "#C4622D", label: "Газовий котел",   sub: `${Math.round(ops.heatingGas_m3).toLocaleString("uk-UA")} м³ газу + 4 000 ₴ ГВП + ТО`, value: ops.gasCost },
              { accent: "#1A6FAD", label: "Тепловий насос",  sub: `COP 3.5 → ${Math.round(ops.heatingHP).toLocaleString("uk-UA")} кВт·год + ТО`, value: ops.hpCost },
              { accent: "#0D2B4E", label: "HYBRO IR",        sub: `${Math.round(ops.heatingHYBRO).toLocaleString("uk-UA")} кВт·год × 0.7225 · ТО: 0 ₴`, value: ops.hybroCost },
            ].map(r => (
              <div key={r.label} className="opex-row" style={{ borderLeft: `3px solid ${r.accent}` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#1A202C" }}>{r.label}</div>
                  <div style={{ fontSize: 11, color: "#94A3B8", fontFamily: "'DM Mono', monospace", marginTop: 2 }}>{r.sub}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 16 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 20, fontWeight: 700, color: r.accent }}>{fmtUAH(r.value)}</span>
                  <span style={{ fontSize: 12, color: "#64748B", marginLeft: 4 }}>/рік</span>
                </div>
              </div>
            ))}
          </div>


          {/* 2 WIDGETS */}
          <div className="g2" style={{ marginBottom: 16 }}>

            {/* Widget 1: ТАРИФНИЙ ЛІМІТ */}
            <div className="card" style={{ marginBottom: 0 }}>
              <SectionTitle>Тарифний ліміт (2 000 кВт·год)</SectionTitle>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>
                HYBRO · зима/місяць
              </div>
              <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 36, fontWeight: 800, color: "#0D2B4E", lineHeight: 1 }}>
                {Math.round(ops.hybroMonth).toLocaleString("uk-UA")}
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
                кВт·год/міс · ліміт 2 000
              </div>
            </div>

            {/* Widget 2: ОКУПНІСТЬ КОНКУРЕНТІВ */}
            <div className="card" style={{ marginBottom: 0 }}>
              <SectionTitle>Окупність конкурентів</SectionTitle>
              {(() => {
                const gasNever = !beGas || Number(beGas) > 30;
                const hpNever  = !beHP  || Number(beHP)  > 30;
                if (solarToggle && hpNever) {
                  return (
                    <div>
                      <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 28, fontWeight: 800, color: "#0D2B4E", lineHeight: 1.1, marginBottom: 10 }}>
                        Ніколи.
                      </div>
                      <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, fontWeight: 400 }}>
                        СЕС не покриває витрати на сервіс теплового насоса.
                      </p>
                    </div>
                  );
                }
                if (gasNever && hpNever) {
                  return (
                    <div>
                      <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 28, fontWeight: 800, color: "#0D2B4E", lineHeight: 1.1, marginBottom: 10 }}>
                        Ніколи.
                      </div>
                      <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.7, fontWeight: 400 }}>
                        Переплата не повернеться.
                      </p>
                    </div>
                  );
                }
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {[
                      { label: "Газ",           val: beGas, accent: "#C4622D", never: gasNever },
                      { label: "Тепловий насос", val: beHP,  accent: "#1A6FAD", never: hpNever },
                    ].map(r => (
                      <div key={r.label}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 3 }}>{r.label}</div>
                        <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 24, fontWeight: 800, color: r.never ? "#94A3B8" : r.accent }}>
                          {r.never ? "Ніколи" : `${r.val} р.`}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

          </div>
          {/* CONCLUSION */}
          <div className="conclusion">
            <div className="conclusion__title">Висновок аналізу</div>

            <div className="conclusion__block conclusion__block--blue">
              <p className="conclusion__text">
                <span className="accent">vs. Тепловий насос:</span>{" "}
                Ви економите <span className="num">{fmtUAH(capexHP - capexHYBRO)}</span> на старті —
                це покриває <strong>{((capexHP - capexHYBRO) / ops.hybroCost).toFixed(1)} {" "}
                {Number(((capexHP - capexHYBRO) / ops.hybroCost).toFixed(1)) === 1 ? "рік" : "роки"}</strong> ваших рахунків за електроенергію HYBRO.
                <span className="conclusion__pill">ТО HYBRO: 0 ₴</span>
              </p>
            </div>

            <div className="conclusion__block conclusion__block--amber">
              <p className="conclusion__text">
                <span className="accent">vs. Газовий котел:</span>{" "}
                {!beGas || Number(beGas) > 30
                  ? <>За поточними параметрами Газ ніколи не окупить свої стартові витрати.{" "}
                      <strong>HYBRO залишається фінансово вигіднішим на всій 20-річній дистанції.</strong></>
                  : <>Ви економите <span className="num">{fmtUAH(capexGas - capexHYBRO)}</span> на старті.{" "}
                      Проте, через відсутність пільгового тарифу, Газ наздожене цю економію за{" "}
                      <strong>{beGas} років</strong>.{" "}
                      <span className="warn">Увімкніть «Тариф на електроопалення» або «СЕС», щоб захистити свої інвестиції!</span></>
                }
                {moratoriumToggle && (
                  <> <span className="warn">⚠️ Сценарій МВФ: з 3-го року газовий котел стає економічно небезпечним.</span></>
                )}
              </p>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
