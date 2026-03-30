// ─── SAE 911 — Sistema de Informes Automáticos ───────────────────────────────
// Archivo principal: src/app.jsx
// Integración: Firebase Auth (Google) + Firestore
// Requiere: src/firebase-config.js con window.FIREBASE_CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const { useState, useCallback, useMemo, useEffect, useRef } = React;

// ════════════════════════════════════════════════════════════════════════════
//  FIREBASE — referencias globales (inyectadas por index.html)
// ════════════════════════════════════════════════════════════════════════════
const getDB   = () => window.db   || null;
const getAuth = () => window.auth || null;

// ════════════════════════════════════════════════════════════════════════════
//  THEME
// ════════════════════════════════════════════════════════════════════════════
const C = {
  navy:    "#0f2444",
  blue:    "#1B3A6B",
  mid:     "#2E5FA3",
  light:   "#D6E4F0",
  green:   "#16a34a",
  greenBg: "#D1FAE5",
  red:     "#dc2626",
  redBg:   "#FEE2E2",
  orange:  "#ea580c",
  orBg:    "#FFEDD5",
  yellow:  "#d97706",
  ylBg:    "#FEF3C7",
  gray:    "#64748b",
  border:  "#e2e8f0",
  bg:      "#f0f4f8",
  card:    "#ffffff",
};

// ════════════════════════════════════════════════════════════════════════════
//  PARSERS
// ════════════════════════════════════════════════════════════════════════════
function parseTimeToSeconds(str) {
  if (!str) return 0;
  str = str.trim();
  let total = 0;
  const m = str.match(/(\d+)\s*minutos?/i);
  const s = str.match(/(\d+)\s*segundos?/i);
  if (m) total += parseInt(m[1], 10) * 60;
  if (s) total += parseInt(s[1], 10);
  const parts = str.split(":").map(p => parseInt(p, 10));
  if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    total = parts[0] * 60 + parts[1];
  } else if (parts.length === 3 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1]) && !Number.isNaN(parts[2])) {
    total = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return total;
}

function fmtSeconds(sec) {
  if (!sec || sec === 0) return `0\"`;
  if (sec < 60) return `${sec}\"`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}' ${s}\"` : `${m}'`;
}

function parseSemicolon(line) {
  const cols = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ";" && !inQ) { cols.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  cols.push(cur.trim());
  return cols;
}

function parseLines(raw) {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function parseAgentes(raw) {
  const lines = parseLines(raw);
  const agents = [];
  let meta = {};
  const idx = {
    nombre: 0,
    codigo: 1,
    ofrecidas: 2,
    contestadas: 3,
    abandonadas: 5,
    tiempoConectado: 10,
    tiempoAusente: 11,
    disponibilidad: 14,
  };
  let headerFound = false;

  for (let i = 0; i < lines.length; i++) {
    const cols = parseSemicolon(lines[i]);
    if (!cols.length) continue;
    const first = (cols[0] || "").trim();

    if (first === "Fecha del informe:" && cols[1]) {
      meta.fecha = cols[1];
      continue;
    }
    if (first === "Rango del informe:" && cols[1]) {
      meta.fechaDesde = cols[1]; meta.fechaHasta = cols[2];
      meta.horaDesde = cols[3]; meta.horaHasta = cols[4];
      continue;
    }

    if (!headerFound && cols.some(h => /agente/i.test(h)) && cols.some(h => /ofrec/i.test(h))) {
      headerFound = true;
      cols.forEach((h, j) => {
        const key = (h || "").toLowerCase();
        if (key.includes("ofrec")) idx.ofrecidas = j;
        if (key.includes("contest")) idx.contestadas = j;
        if (/aband/i.test(key)) idx.abandonadas = j;
        if (/voz preparada/i.test(key)) idx.vozPreparada = j;
        if (/voz no preparada/i.test(key)) idx.vozNoPreparada = j;
        if (/tiempo.*conect|t\.?\s*conect/i.test(key)) idx.tiempoConectado = j;
        if (/tiempo.*ausent|t\.?\s*ausent/i.test(key)) idx.tiempoAusente = j;
        if (key.includes("disponib")) idx.disponibilidad = j;
      });
      continue;
    }

    if (cols[1] && cols[1].startsWith("SG_") && first && first !== "Agente") {
      const nombre = first;
      if (nombre === "Total" || nombre === "Promedio") continue;
      agents.push({
        nombre,
        ofrecidas:        parseInt(cols[idx.ofrecidas])  || 0,
        contestadas:      parseInt(cols[idx.contestadas])  || 0,
        abandonadas:      parseInt(cols[idx.abandonadas])  || 0,
        tiempoConectado:  cols[idx.tiempoConectado]  || "0:00:00",
        tiempoAusente:    cols[idx.tiempoAusente] || "0:00:00",
        disponibilidad:   parseFloat((cols[idx.disponibilidad] || "0").replace(",", ".")) || 0,
      });
      continue;
    }

    if (first === "Total" && cols[1] === "-") {
      meta.totalOfrecidas   = parseInt(cols[idx.ofrecidas]) || parseInt(cols[2]) || 0;
      meta.totalContestadas = parseInt(cols[idx.contestadas]) || parseInt(cols[3]) || 0;
      meta.totalAbanCabina  = parseInt(cols[idx.abandonadas]) || parseInt(cols[5]) || 0;
    }
  }

  return { agents, meta };
}

function parseAbandonadas(raw) {
  const lines = parseLines(raw);
  const intervals = [];
  let totals = {}, meta = {};
  for (let i = 0; i < lines.length; i++) {
    const cols = parseSemicolon(lines[i]);
    if (cols[0] === "Fecha del informe:" && cols[1]) meta.fecha = cols[1];
    if (cols[0] === "Rango del informe:" && cols[1]) {
      meta.fechaDesde = cols[1]; meta.fechaHasta = cols[2];
      meta.horaDesde = cols[3]; meta.horaHasta = cols[4];
    }
    const interval = cols[0] ? cols[0].trim() : "";
    if (interval.includes(" - ") && !isNaN(parseInt(cols[3]))) {
      intervals.push({
        label:        interval,
        hora:         interval.split(" - ")[0].trim(),
        cola:         parseInt(cols[1]) || 0,
        cabina:       parseInt(cols[2]) || 0,
        abandonadas:  parseInt(cols[3]) || 0,
        ofrecidas:    parseInt(cols[4]) || 0,
        contestadas:  parseInt(cols[5]) || 0,
      });
    }
    if (interval === "Total") {
      totals = {
        cola:        parseInt(cols[1]) || 0,
        cabina:      parseInt(cols[2]) || 0,
        abandonadas: parseInt(cols[3]) || 0,
        ofrecidas:   parseInt(cols[4]) || 0,
        contestadas: parseInt(cols[5]) || 0,
      };
    }
  }
  return { intervals, totals, meta };
}

function parseDespacho(raw) {
  const cleaned = raw.replace(/^\uFEFF/, "")
    .replace(/AsignaciÃ³n/g, "Asignación")
    .replace(/Ã³/g, "ó").replace(/Ã©/g, "é").replace(/Ãº/g, "ú")
    .replace(/Ã¡/g, "á").replace(/Ã­/g, "í");
  const lines = parseLines(cleaned).filter(line => line.trim() !== "");
  if (!lines.length) return [];

  const normalize = text => text
    .toLowerCase().trim()
    .replace(/á/g, "a").replace(/é/g, "e").replace(/í/g, "i").replace(/ó/g, "o").replace(/ú/g, "u")
    .replace(/[\s\/-]+/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");

  const headerCols = parseSemicolon(lines[0]).map(h => normalize(h));
  const hasHeader = headerCols.some(h => h.includes("tiempo") || h.includes("total") || h.includes("efectiva") || h.includes("inicio") || h.includes("centro") || h.includes("deriv") || h.includes("creacion") || h.includes("asignacion"));

  const idx = { nombre: 0, tiempo1: 1, tiempo2: 2, tiempo3: 3, total: -1, efectiva: -1 };

  if (hasHeader) {
    headerCols.forEach((h, i) => {
      if (h.includes("distrito") || h.includes("centro") || h.includes("nombre")) idx.nombre = i;
      if (h.includes("inicio") && h.includes("despacho")) idx.tiempo1 = i;
      if (h.includes("deriv") && h.includes("inicio")) idx.tiempo2 = i;
      if ((h.includes("creaci") || h.includes("creacion")) && (h.includes("despacho") || h.includes("tiempo"))) idx.tiempo3 = i;
      if (h.includes("total")) idx.total = i;
      if (h.includes("efectiva")) idx.efectiva = i;
    });
  }

  const distritos = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cols = parseSemicolon(lines[i]);
    if (!cols[idx.nombre] || cols[idx.nombre].startsWith("Centro") || cols[idx.nombre] === "") continue;
    const nombre = cols[idx.nombre] || "";
    const tiempo1Str = cols[idx.tiempo1] || "0:00";
    const tiempo2Str = cols[idx.tiempo2] || "0:00";
    const tiempo3Str = cols[idx.tiempo3] || "0:00";
    const total = idx.total >= 0 ? parseInt(cols[idx.total]) || 0 : 0;
    const efectiva = idx.efectiva >= 0 ? parseInt(cols[idx.efectiva]) || 0 : 0;
    const tiempo1Sec = parseTimeToSeconds(tiempo1Str);
    const tiempo2Sec = parseTimeToSeconds(tiempo2Str);
    const tiempo3Sec = parseTimeToSeconds(tiempo3Str);
    const tiempoSec = tiempo1Sec;
    if (nombre && (tiempo1Sec || tiempo2Sec || tiempo3Sec || total || efectiva)) {
      distritos.push({ nombre, tiempo1Str, tiempo2Str, tiempo3Str, tiempo1Sec, tiempo2Sec, tiempo3Sec, tiempoStr: tiempo1Str, tiempoSec, total, efectiva, noEfectiva: Math.max(0, total - efectiva) });
    }
  }
  return distritos;
}

function detectType(text) {
  const t = text.slice(0, 600).toLowerCase();
  if (t.includes("llamadas por agente") || t.includes("actividad del agente")) return "agentes";
  if (t.includes("abandonadas") && t.includes("grupo de servicio")) return "abandonadas";
  if (t.includes("centro despacho") || t.includes("inicio despacho") || t.includes("asignaci")) return "despacho";
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  REPORT HELPERS
// ════════════════════════════════════════════════════════════════════════════
function generateReportId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `RPT-${timestamp}-${random}`.toUpperCase();
}

function generateToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < 8; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
  return token;
}

function generateTurnoLabel(meta) {
  if (!meta.fechaDesde) return "Sin identificar";
  const hasta = `${meta.horaHasta || "23:59"}`;
  return `${meta.fechaDesde} ${meta.horaDesde || ""} → ${hasta}`.trim();
}

// ════════════════════════════════════════════════════════════════════════════
//  FIRESTORE HELPERS
// ════════════════════════════════════════════════════════════════════════════
async function saveReportToFirestore(files, meta, user) {
  const db = getDB();
  console.log("saveReportToFirestore db:", db, "user:", user);
  if (!db || !user?.uid) {
    console.error("Firebase Firestore no disponible o usuario no definido", { db, user });
    return null;
  }

  const uid = user.uid;
  const userEmail = user.email || null;
  const userDisplayName = user.displayName || null;
  const userProviderId = user.providerData?.[0]?.providerId || null;

  const agentesData = files?.agentes;
  const abandonadasData = files?.abandonadas;
  const despachoData = files?.despacho;
  let fullMeta = { ...meta };
  if (agentesData?.meta) fullMeta = { ...fullMeta, ...agentesData.meta };

  const totalOfrecidas   = agentesData?.meta?.totalOfrecidas   || (agentesData?.agents ? agentesData.agents.reduce((s, a) => s + (a.ofrecidas || 0), 0) : 0);
  const totalContestadas = agentesData?.meta?.totalContestadas || (agentesData?.agents ? agentesData.agents.reduce((s, a) => s + (a.contestadas || 0), 0) : 0);
  const totalAbandonadas = agentesData?.meta?.totalAbanCabina  || (abandonadasData?.totals?.abandonadas || (abandonadasData?.intervals ? abandonadasData.intervals.reduce((s, i) => s + (i.abandonadas || 0), 0) : 0));

  const turnoLabel = generateTurnoLabel(fullMeta);

  const report = {
    id:            generateReportId(),
    token:         generateToken(),
    uid:           uid,
    fechaGuardado: new Date().toISOString(),
    turnoLabel:    turnoLabel,
    turno: {
      fecha:     fullMeta.fechaDesde || fullMeta.fecha || "",
      horaDesde: fullMeta.horaDesde || "",
      horaHasta: fullMeta.horaHasta || "",
    },
    resumen: {
      totalOfrecidas,
      totalContestadas,
      totalAbandonadas,
    },
    datos: {
      agentes:          agentesData?.agents      || [],
      abandonadas:      abandonadasData?.intervals || [],
      despacho:         despachoData             || [],
      agentesResumen:   agentesData?.meta        || {},
      abandonadasResumen: abandonadasData?.totals || {},
    },
  };

  try {
    const { addDoc, collection, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const docRef = await addDoc(collection(db, "informes"), {
      ...report,
      createdAt: serverTimestamp(),
    });
    console.log("✓ Informe guardado en Firestore:", docRef.id);

    // También guardar en historial CSV
    await addDoc(collection(db, "historial_csv"), {
      uid,
      userEmail,
      userDisplayName,
      userProviderId,
      turnoLabel,
      archivos: [
        agentesData    ? { nombre: "agentes",     tipo: "agentes",     filas: agentesData.agents?.length || 0 } : null,
        abandonadasData ? { nombre: "abandonadas", tipo: "abandonadas", filas: abandonadasData.intervals?.length || 0 } : null,
        despachoData   ? { nombre: "despacho",    tipo: "despacho",    filas: despachoData.length || 0 } : null,
      ].filter(Boolean),
      timestamp: serverTimestamp(),
    });

    return { ...report, firestoreId: docRef.id };
  } catch (e) {
    console.error("✗ Error guardando en Firestore:", e);
    return null;
  }
}

async function loadReportsFromFirestore(uid) {
  const db = getDB();
  if (!db || !uid) return [];
  try {
    const { collection, query, where, orderBy, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const q = query(
      collection(db, "informes"),
      where("uid", "==", uid),
      orderBy("fechaGuardado", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(doc => ({ firestoreId: doc.id, ...doc.data() }));
  } catch (e) {
    console.error("✗ Error cargando reportes:", e);
    return [];
  }
}

async function deleteReportFromFirestore(firestoreId) {
  const db = getDB();
  if (!db || !firestoreId) return false;
  try {
    const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await deleteDoc(doc(db, "informes", firestoreId));
    return true;
  } catch (e) {
    console.error("✗ Error eliminando reporte:", e);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH HELPERS
// ════════════════════════════════════════════════════════════════════════════
async function signInWithGoogle() {
  const auth = getAuth();
  console.log("signInWithGoogle auth:", auth);
  if (!auth) { console.error("Firebase Auth no disponible"); return null; }
  try {
    const { signInWithPopup, GoogleAuthProvider } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    console.log("signInWithGoogle user:", result.user);
    return result.user;
  } catch (e) {
    console.error("✗ Error en login con Google:", e);
    return null;
  }
}

async function signOutUser() {
  const auth = getAuth();
  if (!auth) return;
  const { signOut } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  await signOut(auth);
}

// ════════════════════════════════════════════════════════════════════════════
//  LOCAL STORAGE FALLBACK (sin login)
// ════════════════════════════════════════════════════════════════════════════
function getLocalHistory() {
  try { return JSON.parse(localStorage.getItem("sae911_reports") || "[]"); }
  catch { return []; }
}

function saveLocalReport(files, meta) {
  try {
    const history = getLocalHistory();
    const agentesData = files?.agentes;
    const abandonadasData = files?.abandonadas;
    let fullMeta = { ...meta };
    if (agentesData?.meta) fullMeta = { ...fullMeta, ...agentesData.meta };
    const totalOfrecidas   = agentesData?.meta?.totalOfrecidas   || (agentesData?.agents?.reduce((s, a) => s + (a.ofrecidas || 0), 0) || 0);
    const totalContestadas = agentesData?.meta?.totalContestadas || (agentesData?.agents?.reduce((s, a) => s + (a.contestadas || 0), 0) || 0);
    const totalAbandonadas = agentesData?.meta?.totalAbanCabina  || (abandonadasData?.totals?.abandonadas || 0);
    const report = {
      id: generateReportId(), token: generateToken(),
      fechaGuardado: new Date().toISOString(),
      turnoLabel: generateTurnoLabel(fullMeta),
      turno: { fecha: fullMeta.fechaDesde || "", horaDesde: fullMeta.horaDesde || "", horaHasta: fullMeta.horaHasta || "" },
      resumen: { totalOfrecidas, totalContestadas, totalAbandonadas },
      datos: {
        agentes: agentesData?.agents || [], abandonadas: abandonadasData?.intervals || [],
        despacho: files?.despacho || [], agentesResumen: agentesData?.meta || {}, abandonadasResumen: abandonadasData?.totals || {},
      },
    };
    history.push(report);
    localStorage.setItem("sae911_reports", JSON.stringify(history));
    return report;
  } catch { return null; }
}

function getTurnoStats(turnoLabel, history) {
  const reports = history.filter(r => r.turnoLabel === turnoLabel);
  if (!reports.length) return null;
  return {
    turnoLabel, cantidad: reports.length,
    totalOfrecidas:   reports.reduce((s, r) => s + (r.resumen.totalOfrecidas || 0), 0),
    totalContestadas: reports.reduce((s, r) => s + (r.resumen.totalContestadas || 0), 0),
    totalAbandonadas: reports.reduce((s, r) => s + (r.resumen.totalAbandonadas || 0), 0),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  CHART COMPONENTS
// ════════════════════════════════════════════════════════════════════════════
function ChartBar({ id, data, options }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "bar", data, options });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [JSON.stringify(data)]);
  return React.createElement("canvas", { ref, id });
}

function ChartDoughnut({ id, data, options }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "doughnut", data, options });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [JSON.stringify(data)]);
  return React.createElement("canvas", { ref, id });
}

function ChartGauge({ id, value, max, color }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) chartRef.current.destroy();
    const actual = Math.min(value, max);
    chartRef.current = new Chart(ref.current, {
      type: "doughnut",
      data: { labels: ["Valor","Resto"], datasets: [{ data: [actual, Math.max(0, max - actual)], backgroundColor: [color, "#E5E7EB"], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "80%", rotation: -Math.PI, circumference: Math.PI, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [value, max, color]);
  return React.createElement("canvas", { ref, id });
}

function getGaugeMax(value, defaultMax) {
  if (typeof value !== "number" || isNaN(value)) return defaultMax;
  return Math.max(defaultMax, Math.ceil(value / 30) * 30);
}

function getGaugeColor(value, threshold) {
  if (typeof value !== "number" || isNaN(value)) return C.gray;
  if (value <= threshold * 0.75) return C.green;
  if (value <= threshold) return C.yellow;
  return C.red;
}

function ChartLine({ id, data, options }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, { type: "line", data, options });
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [JSON.stringify(data)]);
  return React.createElement("canvas", { ref, id });
}

// ════════════════════════════════════════════════════════════════════════════
//  UI PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════
const Card = ({ children, style = {} }) =>
  React.createElement("div", { className: "card", style: { background: C.card, borderRadius: 14, padding: 24, border: `1px solid ${C.border}`, boxShadow: "0 2px 8px rgba(0,0,0,0.05)", ...style } }, children);

const Badge = ({ label, color, bg }) =>
  React.createElement("span", { style: { background: bg, color, borderRadius: 99, padding: "3px 10px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" } }, label);

const SectionTitle = ({ num, title, sub }) =>
  React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 } },
    React.createElement("div", { style: { width: 30, height: 30, borderRadius: "50%", background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 13, color: "#fff", flexShrink: 0 } }, num),
    React.createElement("div", null,
      React.createElement("div", { style: { fontWeight: 800, fontSize: 17, color: C.navy } }, title),
      sub && React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 1 } }, sub)
    )
  );

const StatKpi = ({ label, value, sub, accent }) =>
  React.createElement("div", { style: { background: C.card, border: `1px solid ${C.border}`, borderTop: `4px solid ${accent}`, borderRadius: 10, padding: "16px 20px", flex: 1, minWidth: 130 } },
    React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 } }, label),
    React.createElement("div", { style: { fontSize: 30, fontWeight: 900, color: accent, lineHeight: 1 } }, value),
    sub && React.createElement("div", { style: { fontSize: 11, color: C.gray, marginTop: 4 } }, sub)
  );

const MiniBar = ({ pct, color }) =>
  React.createElement("div", { style: { background: C.border, borderRadius: 99, height: 5, flex: 1, overflow: "hidden" } },
    React.createElement("div", { style: { width: `${Math.min(100, pct || 0)}%`, background: color, height: "100%", borderRadius: 99 } })
  );

// ════════════════════════════════════════════════════════════════════════════
//  LOGIN PANEL
// ════════════════════════════════════════════════════════════════════════════
function LoginPanel({ onLogin, onSkip }) {
  const [loading, setLoading] = useState(false);

  const handleGoogle = async () => {
    setLoading(true);
    const user = await signInWithGoogle();
    setLoading(false);
    if (user) onLogin(user);
  };

  return React.createElement("div", {
    style: { minHeight: "100vh", background: `linear-gradient(135deg, ${C.navy} 0%, ${C.blue} 60%, ${C.mid} 100%)`, display: "flex", alignItems: "center", justifyContent: "center" }
  },
    React.createElement("div", {
      style: { background: "#fff", borderRadius: 20, padding: "48px 40px", width: 380, textAlign: "center", boxShadow: "0 24px 80px rgba(0,0,0,0.25)" }
    },
      React.createElement("div", { style: { fontSize: 44, marginBottom: 12 } }, "🚨"),
      React.createElement("div", { style: { fontSize: 22, fontWeight: 900, color: C.navy, marginBottom: 4 } }, "SAE 911"),
      React.createElement("div", { style: { fontSize: 13, color: C.gray, marginBottom: 8 } }, "Sistema de Informes — DCGyC"),
      React.createElement("div", { style: { marginBottom: 24, fontSize: 14, color: C.navy, fontWeight: 700 } }, "Inicia sesión con Google para guardar tus informes en la nube con tu correo."),

      React.createElement("button", {
        onClick: handleGoogle,
        disabled: loading,
        style: {
          width: "100%", padding: "14px 20px", borderRadius: 10, border: `1px solid ${C.border}`,
          background: loading ? "#f8fafc" : "#fff", cursor: loading ? "not-allowed" : "pointer",
          fontSize: 14, fontWeight: 700, color: C.navy, display: "flex", alignItems: "center",
          justifyContent: "center", gap: 10, transition: "all .15s",
          boxShadow: "0 1px 4px rgba(0,0,0,0.1)"
        }
      },
        React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 18 18" },
          React.createElement("path", { d: "M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z", fill: "#4285F4" }),
          React.createElement("path", { d: "M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z", fill: "#34A853" }),
          React.createElement("path", { d: "M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z", fill: "#FBBC05" }),
          React.createElement("path", { d: "M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z", fill: "#EA4335" })
        ),
        loading ? "Conectando..." : "Ingresar con Google"
      ),

      React.createElement("div", { style: { margin: "20px 0", display: "flex", alignItems: "center", gap: 12 } },
        React.createElement("div", { style: { flex: 1, height: 1, background: C.border } }),
        React.createElement("span", { style: { fontSize: 11, color: C.gray } }, "o"),
        React.createElement("div", { style: { flex: 1, height: 1, background: C.border } })
      ),

      React.createElement("button", {
        onClick: onSkip,
        style: { width: "100%", padding: "10px", borderRadius: 8, border: `1px solid ${C.border}`, background: "#f8fafc", cursor: "pointer", fontSize: 12, color: C.gray, fontWeight: 600 }
      }, "Continuar sin cuenta (solo local)"),

      React.createElement("div", { style: { marginTop: 20, fontSize: 10, color: C.gray, lineHeight: 1.5 } },
        "Los informes se guardan en Firestore y quedan disponibles desde cualquier dispositivo."
      )
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  UPLOAD ZONE
// ════════════════════════════════════════════════════════════════════════════
function UploadZone({ onFiles, loaded }) {
  const [drag, setDrag] = useState(false);
  const types = {
    agentes:     { label: "Llamadas por Agente",    color: C.mid,   bg: C.light },
    abandonadas: { label: "Abandonadas por Hora",   color: C.red,   bg: C.redBg },
    despacho:    { label: "Tiempo Inicio Despacho", color: C.green, bg: C.greenBg },
  };
  return React.createElement("div", {
    onDragOver: e => { e.preventDefault(); setDrag(true); },
    onDragLeave: () => setDrag(false),
    onDrop: e => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files)); },
    style: { border: `2px dashed ${drag ? C.mid : C.border}`, borderRadius: 16, padding: "40px 28px", textAlign: "center", background: drag ? "#EFF6FF" : C.bg, transition: "all .2s", cursor: "pointer", position: "relative" }
  },
    React.createElement("input", { type: "file", multiple: true, accept: ".csv", onChange: e => onFiles(Array.from(e.target.files)), style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" } }),
    React.createElement("div", { style: { fontSize: 40, marginBottom: 10 } }, "📂"),
    React.createElement("div", { style: { fontSize: 18, fontWeight: 800, color: C.navy, marginBottom: 6 } }, "Arrastrá los archivos CSV aquí"),
    React.createElement("div", { style: { fontSize: 13, color: C.gray, marginBottom: 20 } }, "o hacé clic para seleccionarlos — se detectan automáticamente"),
    React.createElement("div", { style: { display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" } },
      Object.entries(types).map(([key, { label, color, bg }]) => {
        const done = loaded.includes(key);
        return React.createElement("span", { key, style: { background: done ? bg : "#f1f5f9", color: done ? color : C.gray, border: `1.5px solid ${done ? color : C.border}`, borderRadius: 99, padding: "5px 14px", fontSize: 11, fontWeight: 700, transition: "all .2s" } }, done ? `✓ ${label}` : `○ ${label}`);
      })
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: RESUMEN
// ════════════════════════════════════════════════════════════════════════════
function ViewResumen({ data }) {
  const { abandonadas: ab, agentes: ag, despacho: dp } = data;
  const tot = ab?.totals || {};
  const pctAtend = tot.ofrecidas ? ((tot.contestadas / tot.ofrecidas) * 100) : 0;
  const pctAband = tot.ofrecidas ? ((tot.abandonadas / tot.ofrecidas) * 100) : 0;
  const meta = ab?.meta || ag?.meta || {};

  const horaData = useMemo(() => {
    if (!ab?.intervals?.length) return null;
    const ivs = ab.intervals;
    return {
      labels: ivs.map(i => i.hora),
      datasets: [
        { label: "Atendidas",   data: ivs.map(i => i.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6, order: 1 },
        { label: "Abandonadas", data: ivs.map(i => i.abandonadas),  backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 6, order: 1 },
      ]
    };
  }, [ab]);

  const abandonDonut = useMemo(() => {
    if (!tot.abandonadas) return null;
    return { labels: ["En Cola","En Cabina"], datasets: [{ data: [tot.cola || 0, tot.cabina || 0], backgroundColor: ["#ea580c","#eab308"], borderWidth: 0, hoverOffset: 4 }] };
  }, [tot]);

  const agentesData = useMemo(() => {
    if (!ag?.agents?.length) return null;
    const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a,b) => b.contestadas - a.contestadas);
    return { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Contestadas", data: main.map(a => a.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6 }, { label: "Abandonadas", data: main.map(a => a.abandonadas), backgroundColor: "rgba(220,38,38,0.7)", borderRadius: 6 }] };
  }, [ag]);

  const despData = useMemo(() => {
    if (!dp?.length) return null;
    const sorted = [...dp].sort((a,b) => a.tiempoSec - b.tiempoSec);
    return { labels: sorted.map(d => d.nombre.replace("DISTRITO ","D.")), datasets: [{ label: "Seg. promedio", data: sorted.map(d => d.tiempoSec), borderColor: C.mid, backgroundColor: "rgba(46,95,163,0.10)", fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: sorted.map(d => d.tiempoSec > 200 ? C.red : d.tiempoSec < 40 ? C.green : C.mid) }] };
  }, [dp]);

  const efectivDonut = useMemo(() => {
    if (!dp?.length) return null;
    const totalCartas = dp.reduce((s,d) => s + d.total, 0);
    const totalEfect  = dp.reduce((s,d) => s + d.efectiva, 0);
    return { labels: ["Efectivas","No Efectivas"], datasets: [{ data: [totalEfect, totalCartas - totalEfect], backgroundColor: [C.green, C.red], borderWidth: 0, hoverOffset: 4 }] };
  }, [dp]);

  const gaugeData = useMemo(() => {
    if (!dp?.length) return null;
    const avg = arr => arr.length ? Math.round(arr.reduce((s,v) => s+v, 0) / arr.length) : 0;
    return { tiempoInicioDespacho: avg(dp.map(d => d.tiempo1Sec||0)), tiempoDerivacionInicio: avg(dp.map(d => d.tiempo2Sec||0)), tiempoCreacionDespacho: avg(dp.map(d => d.tiempo3Sec||0)) };
  }, [dp]);

  const donutOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, padding: 10 } } }, cutout: "65%" };
  const turnoLabel = meta.fechaDesde && meta.fechaHasta ? `${meta.fechaDesde} ${meta.horaDesde||""} → ${meta.fechaHasta} ${meta.horaHasta||""}` : "Período cargado";

  return React.createElement("div", null,
    React.createElement("div", { style: { background: `linear-gradient(135deg, ${C.navy} 0%, ${C.blue} 60%, ${C.mid} 100%)`, borderRadius: 14, padding: "28px 32px", marginBottom: 24, color: "#fff" } },
      React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: "#93c5fd", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 } }, "DCGyC — SAE 911"),
      React.createElement("div", { style: { fontSize: 26, fontWeight: 900 } }, "Resumen del Turno"),
      React.createElement("div", { style: { fontSize: 13, color: "#94a3b8", marginTop: 4 } }, turnoLabel)
    ),
    React.createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 } },
      tot.ofrecidas  && React.createElement(StatKpi, { label: "Llamadas Recibidas",  value: tot.ofrecidas.toLocaleString("es-AR"),   sub: `~${Math.round(tot.ofrecidas/12)}/hora`, accent: C.mid }),
      tot.contestadas && React.createElement(StatKpi, { label: "Atendidas",           value: tot.contestadas.toLocaleString("es-AR"), sub: `${pctAtend.toFixed(1)}% del total`,     accent: C.green }),
      tot.abandonadas && React.createElement(StatKpi, { label: "Abandonadas",         value: tot.abandonadas.toLocaleString("es-AR"), sub: `${pctAband.toFixed(1)}% del total`,     accent: C.red }),
      ag?.agents?.filter(a => a.ofrecidas >= 30).length > 0 && React.createElement(StatKpi, { label: "Operadores Activos", value: ag.agents.filter(a => a.ofrecidas >= 30).length, sub: "cabinas cubiertas", accent: C.yellow }),
      dp?.length && React.createElement(StatKpi, { label: "Distritos Evaluados", value: dp.length, sub: "en el período", accent: "#7c3aed" }),
    ),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 } },
      horaData && React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 14 } }, "📞 Llamadas por Hora"),
        React.createElement("div", { style: { height: 220 } }, React.createElement(ChartBar, { id: "chart-hora", data: horaData, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 11 } } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 } } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
      ),
      abandonDonut && React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 4 } }, "🔴 Tipo de Abandono"),
        React.createElement("div", { style: { fontSize: 11, color: C.gray, marginBottom: 14 } }, `Total: ${tot.abandonadas?.toLocaleString("es-AR")} llamadas`),
        React.createElement("div", { style: { height: 180 } }, React.createElement(ChartDoughnut, { id: "chart-abandono", data: abandonDonut, options: donutOpts })),
        React.createElement("div", { style: { marginTop: 12, display: "flex", gap: 8, justifyContent: "center" } },
          React.createElement(Badge, { label: `Cola: ${tot.cola}`,   color: C.orange, bg: C.orBg }),
          React.createElement(Badge, { label: `Cabina: ${tot.cabina}`, color: C.yellow, bg: C.ylBg })
        )
      )
    ),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 } },
      agentesData && React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 14 } }, "👤 Desempeño por Operador"),
        React.createElement("div", { style: { height: 220 } }, React.createElement(ChartBar, { id: "chart-agentes", data: agentesData, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 10 } } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 } } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
      ),
      efectivDonut && React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 4 } }, "✅ Efectividad Despacho"),
        React.createElement("div", { style: { fontSize: 11, color: C.gray, marginBottom: 14 } }, `Total cartas: ${dp.reduce((s,d)=>s+d.total,0)}`),
        React.createElement("div", { style: { height: 180 } }, React.createElement(ChartDoughnut, { id: "chart-efectiv", data: efectivDonut, options: donutOpts })),
        React.createElement("div", { style: { marginTop: 12, display: "flex", gap: 8, justifyContent: "center" } },
          (() => { const t2 = dp.reduce((s,d)=>s+d.total,0); const ef = dp.reduce((s,d)=>s+d.efectiva,0); const pct = t2>0?((ef/t2)*100).toFixed(1):0; return React.createElement(Badge, { label: `${pct}% efectivas`, color: C.green, bg: C.greenBg }); })()
        )
      )
    ),
    gaugeData && React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 16 } },
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 10 } }, "⏱️ Inicio → Despacho"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: 120 } },
          React.createElement("div", { style: { fontSize: 48, fontWeight: 900, color: getGaugeColor(gaugeData.tiempoInicioDespacho, 120) } }, fmtSeconds(gaugeData.tiempoInicioDespacho))
        )
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 10 } }, "⏱️ Derivación → Inicio"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: 120 } },
          React.createElement("div", { style: { fontSize: 48, fontWeight: 900, color: getGaugeColor(gaugeData.tiempoDerivacionInicio, 90) } }, fmtSeconds(gaugeData.tiempoDerivacionInicio))
        )
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 10 } }, "⏱️ Creación → Despacho"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: 120 } },
          React.createElement("div", { style: { fontSize: 48, fontWeight: 900, color: getGaugeColor(gaugeData.tiempoCreacionDespacho, 180) } }, fmtSeconds(gaugeData.tiempoCreacionDespacho))
        )
      )
    ),
    despData && React.createElement(Card, { style: { marginBottom: 16 } },
      React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 4 } }, "🚓 Tiempo Inicio Despacho → Asignación (por Distrito)"),
      React.createElement("div", { style: { fontSize: 11, color: C.gray, marginBottom: 14 } }, "Ordenado de menor a mayor. Verde < 40 seg. · Rojo > 3 min."),
      React.createElement("div", { style: { height: 200 } }, React.createElement(ChartLine, { id: "chart-despacho", data: despData, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45 } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 }, callback: v => fmtSeconds(v) } } } } }))
    ),
    React.createElement(AutoAlertas, { data })
  );
}

// ─── Alertas automáticas ────────────────────────────────────────────────────
function AutoAlertas({ data }) {
  const alerts = useMemo(() => {
    const list = [];
    const tot = data.abandonadas?.totals || {};
    const pctAb = tot.ofrecidas ? (tot.abandonadas / tot.ofrecidas) * 100 : 0;
    if (pctAb > 25) list.push({ type: "red",    msg: `Tasa de abandono elevada: ${pctAb.toFixed(1)}% (supera el umbral del 25%)` });
    if (pctAb >= 15 && pctAb <= 25) list.push({ type: "yellow", msg: `Tasa de abandono moderada: ${pctAb.toFixed(1)}% — monitorear` });
    if (data.abandonadas?.intervals) {
      const worst = [...data.abandonadas.intervals].sort((a,b) => b.abandonadas - a.abandonadas)[0];
      if (worst && worst.abandonadas > 80) list.push({ type: "orange", msg: `Hora pico de abandono: ${worst.hora} hs (${worst.abandonadas} abandonadas)` });
    }
    if (data.agentes?.agents) {
      const main = data.agentes.agents.filter(a => a.ofrecidas >= 30);
      main.forEach(a => { const parts = a.tiempoAusente.split(":"); const ausMin = parseInt(parts[0])*60+parseInt(parts[1]||0); if (ausMin > 130) list.push({ type: "yellow", msg: `${a.nombre}: tiempo ausente elevado (${a.tiempoAusente} hs)` }); });
      main.forEach(a => { if (a.abandonadas > 50) list.push({ type: "orange", msg: `${a.nombre}: ${a.abandonadas} abandonadas en cabina — revisar` }); });
    }
    if (data.despacho) { data.despacho.filter(d => d.tiempoSec > 300).forEach(d => list.push({ type: "red", msg: `${d.nombre}: tiempo de despacho crítico (${fmtSeconds(d.tiempoSec)})` })); }
    return list;
  }, [data]);

  if (!alerts.length) return React.createElement("div", { style: { padding: "14px 18px", background: C.greenBg, border: "1px solid #86efac", borderRadius: 10, fontSize: 13, color: "#14532d", fontWeight: 600 } }, "✅ Sin alertas críticas en este turno.");

  const colors = { red: [C.redBg,"#991b1b"], yellow: [C.ylBg,"#78350f"], orange: [C.orBg,"#7c2d12"] };
  const icons  = { red: "🔴", yellow: "🟡", orange: "🟠" };
  return React.createElement("div", null,
    React.createElement("div", { style: { fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 10 } }, "⚠️ Alertas Automáticas"),
    alerts.map((a, i) => React.createElement("div", { key: i, style: { background: colors[a.type][0], border: `1px solid ${colors[a.type][1]}33`, borderRadius: 8, padding: "10px 14px", marginBottom: 8, fontSize: 13, color: colors[a.type][1], display: "flex", gap: 10, alignItems: "flex-start" } },
      React.createElement("span", null, icons[a.type]), React.createElement("span", null, a.msg)
    ))
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: HORAS
// ════════════════════════════════════════════════════════════════════════════
function ViewHoras({ data }) {
  const ivs = data.abandonadas?.intervals || [];
  const tot = data.abandonadas?.totals || {};
  if (!ivs.length) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargá el archivo de Abandonadas para ver este módulo.");

  return React.createElement("div", null,
    React.createElement(SectionTitle, { num: "2", title: "Llamadas por Hora", sub: "Análisis detallado por intervalo horario" }),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 } },
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Atendidas vs Abandonadas"),
        React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "hora-bar", data: { labels: ivs.map(i => i.hora), datasets: [{ label: "Atendidas", data: ivs.map(i => i.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 5 }, { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#f1f5f9" } } } } }))
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "% Abandono por Hora"),
        React.createElement("div", { style: { height: 260 } }, React.createElement(ChartLine, { id: "hora-pct", data: { labels: ivs.map(i => i.hora), datasets: [{ label: "% Abandono", data: ivs.map(i => i.ofrecidas ? +((i.abandonadas/i.ofrecidas)*100).toFixed(1) : 0), borderColor: C.red, backgroundColor: "rgba(220,38,38,0.08)", fill: true, tension: 0.4, pointRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#f1f5f9" }, ticks: { callback: v => v + "%" } } } } }))
      )
    ),
    React.createElement(Card, null,
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
          React.createElement("thead", null,
            React.createElement("tr", { style: { background: C.blue } },
              ["Intervalo","Ofrecidas","Atendidas","% Atend.","Cola","Cabina","Total Aband.","% Aband."].map(h =>
                React.createElement("th", { key: h, style: { padding: "9px 12px", color: "#fff", fontWeight: 700, textAlign: h === "Intervalo" ? "left" : "center", fontSize: 11 } }, h)
              )
            )
          ),
          React.createElement("tbody", null,
            ivs.map((iv, i) => {
              const pctA = iv.ofrecidas ? +((iv.contestadas/iv.ofrecidas)*100).toFixed(0) : 0;
              const pctAb = iv.ofrecidas ? +((iv.abandonadas/iv.ofrecidas)*100).toFixed(0) : 0;
              return React.createElement("tr", { key: i, style: { background: i%2===0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                React.createElement("td", { style: { padding: "8px 12px", fontWeight: 600 } }, iv.label),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center" } }, iv.ofrecidas),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700, color: C.mid } }, iv.contestadas),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center" } }, React.createElement(Badge, { label: `${pctA}%`, color: pctA >= 80 ? C.green : C.yellow, bg: pctA >= 80 ? C.greenBg : C.ylBg })),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", color: C.orange } }, iv.cola),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", color: C.yellow } }, iv.cabina),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700, color: C.red } }, iv.abandonadas),
                React.createElement("td", { style: { padding: "8px 12px", textAlign: "center" } }, React.createElement(Badge, { label: `${pctAb}%`, color: pctAb > 30 ? C.red : pctAb > 20 ? C.orange : C.green, bg: pctAb > 30 ? C.redBg : pctAb > 20 ? C.orBg : C.greenBg }))
              );
            })
          ),
          React.createElement("tfoot", null,
            React.createElement("tr", { style: { background: C.navy, color: "#fff" } },
              React.createElement("td", { style: { padding: "8px 12px", fontWeight: 700 } }, "TOTAL"),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.ofrecidas),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.contestadas),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.ofrecidas ? `${((tot.contestadas/tot.ofrecidas)*100).toFixed(1)}%` : "—"),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.cola),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.cabina),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.abandonadas),
              React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.ofrecidas ? `${((tot.abandonadas/tot.ofrecidas)*100).toFixed(1)}%` : "—"),
            )
          )
        )
      )
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: OPERADORES
// ════════════════════════════════════════════════════════════════════════════
function ViewOperadores({ data }) {
  const ag = data.agentes;
  if (!ag) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargá el archivo de Llamadas por Agente.");
  const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a,b) => b.contestadas - a.contestadas);

  return React.createElement("div", null,
    React.createElement(SectionTitle, { num: "3", title: "Gestión por Operador", sub: `${main.length} operadores activos` }),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 20 } },
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Contestadas vs Abandonadas"),
        React.createElement("div", { style: { height: 240 } }, React.createElement(ChartBar, { id: "ag-bar", data: { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Contestadas", data: main.map(a => a.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 5 }, { label: "Abandonadas", data: main.map(a => a.abandonadas), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 } } }, y: { grid: { color: "#f1f5f9" } } } } }))
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Disponibilidad %"),
        React.createElement("div", { style: { height: 240 } }, React.createElement(ChartBar, { id: "ag-disp", data: { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Disponibilidad %", data: main.map(a => a.disponibilidad), backgroundColor: main.map(a => a.disponibilidad > 80 ? "rgba(22,163,74,0.8)" : a.disponibilidad > 60 ? "rgba(217,119,6,0.8)" : "rgba(220,38,38,0.8)"), borderRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 } } }, y: { max: 100, ticks: { callback: v => v+"%" } } } } }))
      )
    ),
    React.createElement(Card, null,
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
          React.createElement("thead", null,
            React.createElement("tr", { style: { background: C.blue } },
              ["Operador","Ofrecidas","Contestadas","Aband. Cabina","T. Conectado","T. Ausente","Disponibilidad"].map(h =>
                React.createElement("th", { key: h, style: { padding: "9px 12px", color: "#fff", fontWeight: 700, textAlign: h === "Operador" ? "left" : "center", fontSize: 11 } }, h)
              )
            )
          ),
          React.createElement("tbody", null,
            main.map((a, i) => React.createElement("tr", { key: a.nombre, style: { background: i%2===0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
              React.createElement("td", { style: { padding: "9px 12px", fontWeight: 700 } }, a.nombre),
              React.createElement("td", { style: { padding: "9px 12px", textAlign: "center" } }, a.ofrecidas),
              React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontWeight: 700, color: C.mid } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, justifyContent: "center" } }, a.contestadas, React.createElement(MiniBar, { pct: main[0]?.contestadas ? (a.contestadas/main[0].contestadas)*100 : 0, color: C.mid }))
              ),
              React.createElement("td", { style: { padding: "9px 12px", textAlign: "center" } }, React.createElement(Badge, { label: a.abandonadas, color: a.abandonadas > 50 ? C.red : C.green, bg: a.abandonadas > 50 ? C.redBg : C.greenBg })),
              React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontFamily: "monospace", color: "#334155" } }, a.tiempoConectado),
              React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontFamily: "monospace" } },
                React.createElement("span", { style: { color: parseTimeToSeconds(a.tiempoAusente) > 7200 ? C.red : "#334155", fontWeight: parseTimeToSeconds(a.tiempoAusente) > 7200 ? 700 : 400 } }, a.tiempoAusente)
              ),
              React.createElement("td", { style: { padding: "9px 12px" } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                  React.createElement(MiniBar, { pct: a.disponibilidad, color: a.disponibilidad > 80 ? C.green : a.disponibilidad > 60 ? C.yellow : C.red }),
                  React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: a.disponibilidad > 80 ? C.green : C.yellow, minWidth: 40 } }, `${a.disponibilidad.toFixed(1)}%`)
                )
              )
            ))
          )
        )
      )
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: DESPACHO
// ════════════════════════════════════════════════════════════════════════════
function ViewDespacho({ data }) {
  const dp = data.despacho;
  if (!dp?.length) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargá el archivo de Tiempo Inicio Despacho.");
  const sorted = [...dp].sort((a,b) => a.tiempoSec - b.tiempoSec);
  const maxSec = sorted[sorted.length - 1]?.tiempoSec || 1;
  const top3 = sorted.slice(0, 3);
  const bot3 = sorted.slice(-3).reverse();

  return React.createElement("div", null,
    React.createElement(SectionTitle, { num: "4", title: "Tiempo Inicio Despacho → Asignación", sub: `${sorted.length} distritos evaluados` }),
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 } },
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: "#065f46", marginBottom: 12 } }, "🏆 Top 3 — Mayor Desempeño"),
        top3.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: i+1, variant: "top" }))
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.red, marginBottom: 12 } }, "⚠️ Bottom 3 — Menor Desempeño"),
        bot3.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: sorted.length-i, variant: "bot" }))
      )
    ),
    React.createElement(Card, null,
      React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Ranking Completo"),
      sorted.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: i+1, variant: i < 3 ? "top" : i >= sorted.length-3 ? "bot" : "mid" }))
    )
  );
}

function DistritoRow({ d, maxSec, rank, variant }) {
  const pct   = maxSec > 0 ? (d.tiempoSec / maxSec) * 100 : 0;
  const efPct = d.total > 0 ? (d.efectiva / d.total) * 100 : 0;
  const col   = variant === "bot" ? C.red : variant === "top" ? C.green : C.mid;
  const bg    = variant === "bot" ? C.redBg : variant === "top" ? C.greenBg : (rank % 2 === 0 ? "#f8fafc" : "#fff");
  const bdr   = variant === "bot" ? "#fecaca" : variant === "top" ? "#86efac" : C.border;

  return React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: bg, borderRadius: 8, border: `1px solid ${bdr}`, marginBottom: 5 } },
    React.createElement("div", { style: { width: 24, height: 24, borderRadius: "50%", background: col, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900, color: "#fff", flexShrink: 0 } }, rank),
    React.createElement("div", { style: { width: 100, fontSize: 11, fontWeight: 700, color: C.navy } }, d.nombre),
    React.createElement("div", { style: { flex: 1, display: "flex", alignItems: "center", gap: 8 } },
      React.createElement(MiniBar, { pct, color: col }),
      React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: col, minWidth: 70, textAlign: "right" } }, fmtSeconds(d.tiempoSec))
    ),
    React.createElement("div", { style: { width: 80, textAlign: "right", fontSize: 11 } },
      React.createElement("span", { style: { color: C.gray } }, `${d.efectiva}/${d.total} `),
      React.createElement("span", { style: { fontWeight: 700, color: efPct >= 90 ? C.green : efPct >= 80 ? C.yellow : C.red } }, `(${efPct.toFixed(0)}%)`)
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: HISTORIAL — Firebase + local fallback
// ════════════════════════════════════════════════════════════════════════════
function ViewHistorial({ user }) {
  const [history, setHistory]           = useState([]);
  const [loading, setLoading]           = useState(true);
  const [filterTurno, setFilterTurno]   = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [deleting, setDeleting]         = useState(null);

  const isFirebase = !!user;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (isFirebase) {
      loadReportsFromFirestore(user.uid).then(reports => {
        if (!cancelled) { setHistory(reports); setLoading(false); }
      });
    } else {
      setHistory(getLocalHistory().slice().reverse());
      setLoading(false);
    }
    return () => { cancelled = true; };
  }, [user]);

  const handleDelete = async (report) => {
    if (!confirm(`¿Eliminar el reporte ${report.id}? Esta acción no se puede deshacer.`)) return;
    setDeleting(report.id);
    if (isFirebase && report.firestoreId) {
      const ok = await deleteReportFromFirestore(report.firestoreId);
      if (ok) setHistory(h => h.filter(r => r.firestoreId !== report.firestoreId));
    } else {
      const updated = getLocalHistory().filter(r => r.id !== report.id);
      localStorage.setItem("sae911_reports", JSON.stringify(updated));
      setHistory(updated.slice().reverse());
    }
    setDeleting(null);
  };

  const turnos = [...new Set(history.map(r => r.turnoLabel))].filter(Boolean).sort().reverse();
  const filteredReports = filterTurno ? history.filter(r => r.turnoLabel === filterTurno) : history;

  if (loading) return React.createElement("div", { style: { padding: 60, textAlign: "center", color: C.gray } }, "Cargando historial…");

  if (!history.length) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } },
    React.createElement("div", { style: { fontSize: 28, marginBottom: 10 } }, "📋"),
    React.createElement("div", { style: { fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 6 } }, "Sin reportes guardados"),
    React.createElement("div", { style: { fontSize: 13 } }, isFirebase ? "Los reportes que generes se guardarán automáticamente en Firestore." : "Los reportes se guardan localmente en este navegador.")
  );

  if (selectedReport) return React.createElement("div", null,
    React.createElement(Card, { style: { marginBottom: 20 } },
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 } },
        React.createElement("button", { onClick: () => setSelectedReport(null), style: { background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 } }, "← Volver al Listado"),
        React.createElement("div", null,
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: C.navy } }, `Reporte: ${selectedReport.id}`),
          React.createElement("div", { style: { fontSize: 11, color: C.gray, marginTop: 2 } }, `Token: ${selectedReport.token}`)
        )
      ),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 20 } },
        React.createElement("div", null,
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase", marginBottom: 4 } }, "Turno"),
          React.createElement("div", { style: { fontSize: 12, fontWeight: 700, color: C.navy } }, selectedReport.turnoLabel)
        ),
        React.createElement("div", null,
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase", marginBottom: 4 } }, "Guardado"),
          React.createElement("div", { style: { fontSize: 12, fontWeight: 700, color: C.navy } }, selectedReport.fechaGuardado ? new Date(selectedReport.fechaGuardado).toLocaleString("es-ES") : "-")
        )
      )
    ),
    React.createElement(Card, { style: { marginBottom: 20 } },
      React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 16 } }, "📊 Resumen del Reporte"),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 } },
        React.createElement(StatKpi, { label: "Llamadas Ofrecidas",   value: selectedReport.resumen.totalOfrecidas,   accent: C.mid }),
        React.createElement(StatKpi, { label: "Llamadas Contestadas", value: selectedReport.resumen.totalContestadas, accent: C.green }),
        React.createElement(StatKpi, { label: "Llamadas Abandonadas", value: selectedReport.resumen.totalAbandonadas, accent: C.red })
      )
    ),
    selectedReport.datos?.agentes?.length > 0 && React.createElement(Card, { style: { marginBottom: 20 } },
      React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 12 } }, "🧍 Operadores"),
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 10 } },
          React.createElement("thead", null,
            React.createElement("tr", { style: { background: C.blue } },
              ["Operador","Ofrecidas","Contestadas","Abandonadas","Disponibilidad"].map(h =>
                React.createElement("th", { key: h, style: { padding: "6px 10px", color: "#fff", fontWeight: 700, textAlign: "left" } }, h)
              )
            )
          ),
          React.createElement("tbody", null,
            selectedReport.datos.agentes.map((a, i) =>
              React.createElement("tr", { key: a.nombre, style: { background: i%2===0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                React.createElement("td", { style: { padding: "6px 10px", fontWeight: 600 } }, a.nombre),
                React.createElement("td", { style: { padding: "6px 10px", textAlign: "center" } }, a.ofrecidas),
                React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", fontWeight: 600, color: C.green } }, a.contestadas),
                React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", fontWeight: 600, color: C.red } }, a.abandonadas),
                React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", color: a.disponibilidad > 80 ? C.green : a.disponibilidad > 60 ? C.yellow : C.red } }, `${a.disponibilidad.toFixed(1)}%`)
              )
            )
          )
        )
      )
    ),
    selectedReport.datos?.despacho?.length > 0 && React.createElement(Card, null,
      React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 12 } }, "🚓 Despacho (Top 10)"),
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 10 } },
          React.createElement("thead", null,
            React.createElement("tr", { style: { background: C.blue } },
              ["Distrito","Tiempo","Efectividad"].map(h => React.createElement("th", { key: h, style: { padding: "6px 10px", color: "#fff", fontWeight: 700, textAlign: "left" } }, h))
            )
          ),
          React.createElement("tbody", null,
            selectedReport.datos.despacho.slice(0, 10).map((d, i) =>
              React.createElement("tr", { key: d.nombre, style: { background: i%2===0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                React.createElement("td", { style: { padding: "6px 10px", fontWeight: 600 } }, d.nombre),
                React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", fontFamily: "monospace" } }, fmtSeconds(d.tiempoSec)),
                React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", color: (d.efectiva/d.total)*100 >= 90 ? C.green : (d.efectiva/d.total)*100 >= 80 ? C.yellow : C.red } }, `${((d.efectiva/d.total)*100).toFixed(0)}%`)
              )
            )
          )
        )
      )
    )
  );

  return React.createElement("div", null,
    React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 } },
      React.createElement(SectionTitle, { num: "5", title: "Historial de Reportes", sub: `${history.length} reportes — ${isFirebase ? "sincronizados en Firestore" : "almacenados localmente"}` }),
      isFirebase && React.createElement("button", {
        onClick: () => { setLoading(true); loadReportsFromFirestore(user.uid).then(r => { setHistory(r); setLoading(false); }); },
        style: { background: C.light, border: `1px solid ${C.mid}`, color: C.blue, borderRadius: 7, padding: "6px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer" }
      }, "↺ Actualizar")
    ),

    React.createElement(Card, { style: { marginBottom: 20 } },
      React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 12 } }, "Filtrar por Turno"),
      React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        React.createElement("button", { onClick: () => setFilterTurno(null), style: { padding: "6px 14px", borderRadius: 6, border: filterTurno === null ? `2px solid ${C.blue}` : `1px solid ${C.border}`, background: filterTurno === null ? C.light : "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: filterTurno === null ? C.blue : C.gray } }, `Todos (${history.length})`),
        turnos.map(turno => React.createElement("button", { key: turno, onClick: () => setFilterTurno(turno), style: { padding: "6px 14px", borderRadius: 6, border: filterTurno === turno ? `2px solid ${C.blue}` : `1px solid ${C.border}`, background: filterTurno === turno ? C.light : "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: filterTurno === turno ? C.blue : C.gray } }, turno))
      )
    ),

    filterTurno && (() => { const stats = getTurnoStats(filterTurno, history); return stats ? React.createElement(Card, { style: { marginBottom: 20 } },
      React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 12 } }, `Estadísticas: ${filterTurno}`),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 } },
        React.createElement(StatKpi, { label: "Reportes",          value: stats.cantidad,          accent: C.blue }),
        React.createElement(StatKpi, { label: "Total Ofrecidas",   value: stats.totalOfrecidas,    accent: C.mid }),
        React.createElement(StatKpi, { label: "Total Contestadas", value: stats.totalContestadas,  accent: C.green }),
        React.createElement(StatKpi, { label: "Total Abandonadas", value: stats.totalAbandonadas,  accent: C.red })
      )
    ) : null; })(),

    React.createElement(Card, null,
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 11 } },
          React.createElement("thead", null,
            React.createElement("tr", { style: { background: C.blue } },
              ["ID Reporte","Token","Fecha Guardado","Turno","Ofrecidas","Contestadas","Abandonadas","Acciones"].map(h =>
                React.createElement("th", { key: h, style: { padding: "9px 12px", color: "#fff", fontWeight: 700, textAlign: "left", fontSize: 11 } }, h)
              )
            )
          ),
          React.createElement("tbody", null,
            filteredReports.map((r, i) => {
              const reportDate = r.fechaGuardado ? new Date(r.fechaGuardado).toLocaleString("es-ES") : "-";
              return React.createElement("tr", { key: r.id || i, style: { background: i%2===0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                React.createElement("td", { style: { padding: "9px 12px", fontWeight: 700, fontFamily: "monospace", fontSize: 9, color: C.blue } }, r.id),
                React.createElement("td", { style: { padding: "9px 12px", fontFamily: "monospace", fontSize: 9, background: "#f0f4f8", color: C.mid, fontWeight: 600 } }, r.token),
                React.createElement("td", { style: { padding: "9px 12px", fontSize: 10, color: C.gray } }, reportDate),
                React.createElement("td", { style: { padding: "9px 12px", fontSize: 10, fontWeight: 600 } }, r.turnoLabel),
                React.createElement("td", { style: { padding: "9px 12px", textAlign: "center" } }, r.resumen?.totalOfrecidas),
                React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontWeight: 700, color: C.green } }, r.resumen?.totalContestadas),
                React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontWeight: 700, color: C.red } }, r.resumen?.totalAbandonadas),
                React.createElement("td", { style: { padding: "9px 12px", display: "flex", gap: 6 } },
                  React.createElement("button", { onClick: () => setSelectedReport(r), style: { background: C.blue, color: "#fff", border: "none", borderRadius: 4, padding: "4px 10px", fontSize: 10, fontWeight: 600, cursor: "pointer" } }, "Ver"),
                  React.createElement("button", { onClick: () => handleDelete(r), disabled: deleting === r.id, style: { background: C.redBg, color: C.red, border: `1px solid #fca5a5`, borderRadius: 4, padding: "4px 8px", fontSize: 10, fontWeight: 600, cursor: "pointer" } }, deleting === r.id ? "…" : "✕")
                )
              );
            })
          )
        )
      )
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ════════════════════════════════════════════════════════════════════════════
function App() {
  const [user, setUser]       = useState(undefined);  // undefined = cargando, null = no auth, object = logueado
  const [skipAuth, setSkipAuth] = useState(false);
  const [files, setFiles]     = useState({ agentes: null, abandonadas: null, despacho: null });
  const [loaded, setLoaded]   = useState([]);
  const [view, setView]       = useState("upload");
  const [err, setErr]         = useState(null);
  const lastSavedTurno        = useRef(null);

  // Escuchar cambios de auth
  useEffect(() => {
    let unsub = null;
    let intervalId = null;
    let timeoutId = null;

    const subscribeAuth = async (auth) => {
      try {
        const { onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
        unsub = onAuthStateChanged(auth, u => setUser(u || null));
      } catch (e) {
        console.error("✗ Error inicializando auth:", e);
        setUser(null);
      }
    };

    const auth = getAuth();
    if (auth) {
      subscribeAuth(auth);
    } else {
      intervalId = window.setInterval(() => {
        const nextAuth = getAuth();
        if (nextAuth) {
          window.clearInterval(intervalId);
          subscribeAuth(nextAuth);
        }
      }, 250);

      timeoutId = window.setTimeout(() => {
        if (!getAuth()) {
          window.clearInterval(intervalId);
          setUser(null);
        }
      }, 3000);
    }

    return () => {
      if (intervalId) window.clearInterval(intervalId);
      if (timeoutId) window.clearTimeout(timeoutId);
      if (typeof unsub === "function") unsub();
    };
  }, []);

  // Auto-guardar informe cuando los 3 archivos están cargados
  useEffect(() => {
    if (loaded.length !== 3) return;
    const meta = files.abandonadas?.meta || files.agentes?.meta || {};
    const turnoLabel = generateTurnoLabel(meta);
    if (lastSavedTurno.current === turnoLabel) return;
    lastSavedTurno.current = turnoLabel;

    if (user) {
      saveReportToFirestore(files, meta, user).then(r => {
        if (r) console.log("✓ Guardado en Firestore:", r.id);
      });
    } else {
      const r = saveLocalReport(files, meta);
      if (r) console.log("✓ Guardado localmente:", r.id);
    }
  }, [loaded.length, user]);

  const handleLogin = useCallback(async () => {
    const u = await signInWithGoogle();
    if (u) setUser(u);
  }, []);

  const handleFiles = useCallback(async (fileList) => {
    setErr(null);
    const next = { ...files };
    const nextLoaded = [...loaded];
    for (const f of fileList) {
      if (!f.name.endsWith(".csv")) { setErr(`"${f.name}" no es un CSV.`); continue; }
      let text;
      try { text = await f.text(); } catch (_) {
        text = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej;
          r.readAsText(f, "latin-1");
        });
      }
      const type = detectType(text);
      if (!type) { setErr(`No se pudo identificar "${f.name}".`); continue; }
      if (type === "agentes")     next.agentes     = parseAgentes(text);
      if (type === "abandonadas") next.abandonadas = parseAbandonadas(text);
      if (type === "despacho")    next.despacho    = parseDespacho(text);
      if (!nextLoaded.includes(type)) nextLoaded.push(type);
    }
    setFiles(next);
    setLoaded(nextLoaded);
    if (nextLoaded.length > 0 && view === "upload") setView("resumen");
  }, [files, loaded, view]);

  const reset = () => { setFiles({ agentes: null, abandonadas: null, despacho: null }); setLoaded([]); setView("upload"); setErr(null); lastSavedTurno.current = null; };

  // Pantalla de carga inicial (esperando onAuthStateChanged)
  if (user === undefined && !skipAuth) {
    return React.createElement("div", { style: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg } },
      React.createElement("div", { style: { fontSize: 14, color: C.gray } }, "Iniciando…")
    );
  }

  // Login screen (si Firebase está disponible y no hay sesión)
  if (!skipAuth && !user && getAuth()) {
    return React.createElement(LoginPanel, {
      onLogin: u => setUser(u),
      onSkip:  () => { setSkipAuth(true); setUser(null); }
    });
  }

  const hasData = loaded.length > 0;
  const meta = files.abandonadas?.meta || files.agentes?.meta || {};
  const turnoLabel = meta.fechaDesde ? `${meta.fechaDesde} ${meta.horaDesde||""} → ${meta.fechaHasta||""} ${meta.horaHasta||""}` : "";

  const navItems = [
    { id: "resumen",    label: "📊 Resumen",    avail: hasData },
    { id: "horas",      label: "📞 Por Hora",   avail: !!files.abandonadas },
    { id: "operadores", label: "👤 Operadores", avail: !!files.agentes },
    { id: "despacho",   label: "🚓 Despacho",   avail: !!files.despacho },
    { id: "historial",  label: "📋 Historial",  avail: true },
  ];

  return React.createElement("div", { style: { minHeight: "100vh", background: C.bg } },

    // TOPBAR
    React.createElement("div", { style: { background: `linear-gradient(90deg, ${C.navy} 0%, ${C.blue} 100%)`, padding: "0 28px", display: "flex", alignItems: "center", gap: 0, height: 56, boxShadow: "0 2px 12px rgba(0,0,0,0.2)" } },
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginRight: 32 } },
        React.createElement("span", { style: { fontSize: 22 } }, "🚨"),
        React.createElement("div", null,
          React.createElement("div", { style: { fontSize: 15, fontWeight: 900, color: "#fff", lineHeight: 1 } }, "SAE 911"),
          React.createElement("div", { style: { fontSize: 10, color: "#93c5fd", fontWeight: 600, letterSpacing: 0.5 } }, "DCGyC — Informes")
        )
      ),
      hasData && React.createElement("div", { style: { display: "flex", gap: 4, flex: 1 } },
        navItems.filter(n => n.avail).map(n =>
          React.createElement("button", { key: n.id, onClick: () => setView(n.id), style: { background: view === n.id ? "rgba(255,255,255,0.18)" : "transparent", border: view === n.id ? "1px solid rgba(255,255,255,0.3)" : "1px solid transparent", color: view === n.id ? "#fff" : "#94a3b8", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all .15s" } }, n.label)
        )
      ),
      !hasData && React.createElement("div", { style: { flex: 1 } }),

      React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 } },
        turnoLabel && React.createElement("span", { style: { fontSize: 10, color: "#64748b", fontWeight: 600 } }, turnoLabel),

        // Historial nav (siempre visible)
        !hasData && React.createElement("button", { onClick: () => setView("historial"), style: { background: view === "historial" ? "rgba(255,255,255,0.18)" : "transparent", border: view === "historial" ? "1px solid rgba(255,255,255,0.3)" : "1px solid transparent", color: view === "historial" ? "#fff" : "#94a3b8", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" } }, "📋 Historial"),

        hasData && React.createElement("label", { title: "Agregar más archivos", style: { background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 7, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600, position: "relative" } },
          "+ CSV",
          React.createElement("input", { type: "file", multiple: true, accept: ".csv", onChange: e => handleFiles(Array.from(e.target.files)), style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" } })
        ),
        hasData && React.createElement("button", { onClick: reset, style: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#94a3b8", borderRadius: 7, padding: "5px 12px", fontSize: 11, cursor: "pointer" } }, "↺ Reset"),
        hasData && React.createElement("button", { onClick: () => window.print(), className: "no-print", style: { background: C.mid, border: "none", color: "#fff", borderRadius: 7, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 700 } }, "🖨 Imprimir"),

        getAuth() && !user && React.createElement("button", { onClick: handleLogin, style: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#94a3b8", borderRadius: 7, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 700 } }, "Ingresar con Google"),

        // Avatar / logout
        user && React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginLeft: 8 } },
          user.photoURL && React.createElement("img", { src: user.photoURL, style: { width: 28, height: 28, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.3)" }, referrerPolicy: "no-referrer" }),
          React.createElement("span", { style: { fontSize: 11, color: "#94a3b8", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, user.displayName || user.email),
          React.createElement("button", { onClick: signOutUser, title: "Cerrar sesión", style: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#94a3b8", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" } }, "✕")
        )
      )
    ),

    // MAIN CONTENT
    React.createElement("div", { style: { maxWidth: 1140, margin: "0 auto", padding: "28px 20px" } },
      err && React.createElement("div", { style: { background: C.redBg, border: "1px solid #fca5a5", borderRadius: 10, padding: "12px 16px", color: "#7f1d1d", fontSize: 13, marginBottom: 16, fontWeight: 600 } }, `⚠ ${err}`),

      view === "upload" && React.createElement("div", null,
        React.createElement("div", { style: { textAlign: "center", marginBottom: 32, paddingTop: 20 } },
          React.createElement("div", { style: { fontSize: 32, marginBottom: 10 } }, "🚨"),
          React.createElement("div", { style: { fontSize: 26, fontWeight: 900, color: C.navy, marginBottom: 6 } }, "Sistema de Informes SAE 911"),
          React.createElement("div", { style: { fontSize: 14, color: C.gray } }, "Cargá los CSV exportados del sistema para generar el informe automáticamente"),
          !user && getAuth() && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: C.yellow, fontWeight: 700 } }, "⚠️ Inicia sesión con Google para que tu correo quede registrado en Firestore."),
          user && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: C.green, fontWeight: 600 } }, `✓ Sesión activa: ${user.displayName || user.email} — los informes se sincronizan en la nube`)
        ),
        React.createElement(UploadZone, { onFiles: handleFiles, loaded }),
        React.createElement("div", { style: { marginTop: 28, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 } },
          [
            { icon: "📊", title: "Resumen con gráficos", desc: "Vista ejecutiva con KPIs y alertas automáticas" },
            { icon: "📞", title: "Análisis por hora",    desc: "Volumen, abandono y atención en cada intervalo" },
            { icon: "🚓", title: "Ranking de distritos", desc: "Tiempo de despacho y efectividad por zona" },
          ].map(({ icon, title, desc }) =>
            React.createElement("div", { key: title, style: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px", textAlign: "center" } },
              React.createElement("div", { style: { fontSize: 28, marginBottom: 8 } }, icon),
              React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 4 } }, title),
              React.createElement("div", { style: { fontSize: 12, color: C.gray } }, desc)
            )
          )
        )
      ),

      view === "resumen"    && React.createElement(ViewResumen,    { data: files }),
      view === "horas"      && React.createElement(ViewHoras,      { data: files }),
      view === "operadores" && React.createElement(ViewOperadores, { data: files }),
      view === "despacho"   && React.createElement(ViewDespacho,   { data: files }),
      view === "historial"  && React.createElement(ViewHistorial,  { user }),
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
