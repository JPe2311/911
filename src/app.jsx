// ─── SAE 911 — Sistema de Informes Automáticos ───────────────────────────────
// Archivo principal: src/app.jsx
// Integración: Firebase Auth (Google) + Firestore
// Requiere: src/firebase-config.js con window.FIREBASE_CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const { useState, useCallback, useMemo, useEffect, useRef } = React;

// ════════════════════════════════════════════════════════════════════════════
//  FIREBASE — referencias globales (inyectadas por index.html)
// ════════════════════════════════════════════════════════════════════════════
const getDB = () => window.db || null;
const getAuth = () => window.auth || null;

// ════════════════════════════════════════════════════════════════════════════
//  THEME
// ════════════════════════════════════════════════════════════════════════════
const C = {
  navy: "#0a0c10", // Fondo ultra oscuro
  black: "#000000",
  blue: "#3b82f6",  // Azul eléctrico
  mid: "#1e293b",   // Gris azulado para superficies
  light: "#f8fafc",  // Blanco para textos
  green: "#10b981", 
  greenBg: "rgba(16, 185, 129, 0.1)",
  red: "#ef4444",
  redBg: "rgba(239, 68, 68, 0.1)",
  gray: "#94a3b8",
  border: "rgba(255, 255, 255, 0.1)",
  bg: "#000",
  card: "rgba(15, 23, 42, 0.6)", // Fondo de tarjeta con glassmorphism
};

// Global Styles Injection
if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.innerHTML = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap');
    body { 
      background: ${C.black}; 
      color: ${C.light}; 
      font-family: 'Outfit', sans-serif;
      margin: 0;
      overflow-x: hidden;
    }
    .glass {
      background: ${C.card};
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid ${C.border};
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
    }
    .neon-blue {
      box-shadow: 0 0 15px rgba(59, 130, 246, 0.3);
    }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${C.mid}; border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: ${C.blue}; }
  `;
  document.head.appendChild(style);
}

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
        ofrecidas: parseInt(cols[idx.ofrecidas]) || 0,
        contestadas: parseInt(cols[idx.contestadas]) || 0,
        abandonadas: parseInt(cols[idx.abandonadas]) || 0,
        tiempoConectado: cols[idx.tiempoConectado] || "0:00:00",
        tiempoAusente: cols[idx.tiempoAusente] || "0:00:00",
        disponibilidad: parseFloat((cols[idx.disponibilidad] || "0").replace(",", ".")) || 0,
      });
      continue;
    }

    if (first === "Total" && cols[1] === "-") {
      meta.totalOfrecidas = parseInt(cols[idx.ofrecidas]) || parseInt(cols[2]) || 0;
      meta.totalContestadas = parseInt(cols[idx.contestadas]) || parseInt(cols[3]) || 0;
      meta.totalAbanCabina = parseInt(cols[idx.abandonadas]) || parseInt(cols[5]) || 0;
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
        label: interval,
        hora: interval.split(" - ")[0].trim(),
        cola: parseInt(cols[1]) || 0,
        cabina: parseInt(cols[2]) || 0,
        abandonadas: parseInt(cols[3]) || 0,
        ofrecidas: parseInt(cols[4]) || 0,
        contestadas: parseInt(cols[5]) || 0,
      });
    }
    if (interval === "Total") {
      totals = {
        cola: parseInt(cols[1]) || 0,
        cabina: parseInt(cols[2]) || 0,
        abandonadas: parseInt(cols[3]) || 0,
        ofrecidas: parseInt(cols[4]) || 0,
        contestadas: parseInt(cols[5]) || 0,
      };
    }
  }
  return { intervals, totals, meta };
}

function parseDespacho(raw, type = "despacho") {
  const cleaned = raw.replace(/^\uFEFF/, "")
    .replace(/Asignaci\u00c3\u00b3n/g, "Asignaci\u00f3n")
    .replace(/\u00c3\u00b3/g, "o").replace(/\u00c3\u00a9/g, "e").replace(/\u00c3\u00ba/g, "u")
    .replace(/\u00c3\u00a1/g, "a").replace(/\u00c3\u00ad/g, "i");
  const lines = parseLines(cleaned).filter(line => line.trim() !== "");
  if (!lines.length) return [];

  const normalize = text => text
    .toLowerCase().trim()
    .replace(/\u00e1/g, "a").replace(/\u00e9/g, "e").replace(/\u00ed/g, "i").replace(/\u00f3/g, "o").replace(/\u00fa/g, "u")
    .replace(/[\s\/-]+/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");

  // Detectar delimitador: punto y coma o tabulacion
  const firstLine = lines[0];
  const useTabs = !firstLine.includes(";") && firstLine.includes("\t");
  const splitRow = line => useTabs
    ? line.split("\t").map(s => s.trim())
    : parseSemicolon(line);

  const headerCols = splitRow(lines[0]).map(h => normalize(h));
  const hasHeader = headerCols.some(h => h.includes("tiempo") || h.includes("total") || h.includes("efectiva") || h.includes("inicio") || h.includes("centro") || h.includes("deriv") || h.includes("creacion") || h.includes("asignacion"));

  const idx = { nombre: 0, tiempo1: -1, tiempo2: -1, tiempo3: -1, total: -1, efectiva: -1 };

  if (hasHeader) {
    headerCols.forEach((h, i) => {
      if (h.includes("distrito") || h.includes("centro") || h.includes("nombre")) idx.nombre = i;
      if (h.includes("inicio") && h.includes("despacho")) idx.tiempo1 = i;
      // Derivacion: col que contenga 'deriv' pero no 'creacion'
      if (h.includes("deriv") && !h.includes("creacion")) idx.tiempo2 = i;
      // Creacion: col que contenga 'creacion'
      if (h.includes("creacion")) idx.tiempo3 = i;
      if (h.includes("total") && !h.includes("efectiva")) idx.total = i;
      if (h.includes("efectiva")) idx.efectiva = i;
    });
  }

  if (type === "despacho-inicio" && idx.tiempo1 < 0) idx.tiempo1 = 1;
  if (type === "despacho-derivacion" && idx.tiempo2 < 0) idx.tiempo2 = 1;
  if (type === "despacho-creacion" && idx.tiempo3 < 0) idx.tiempo3 = 1;
  if (type === "despacho" && idx.tiempo1 < 0) idx.tiempo1 = 1;

  // Columna de tiempo principal segun el tipo de archivo
  const tiempoIdx = type === "despacho-derivacion" ? idx.tiempo2
    : type === "despacho-creacion" ? idx.tiempo3
      : idx.tiempo1;

  // Limpiar el nombre de distrito: eliminar cualquier texto de tiempo que pueda quedar pegado
  const cleanNombre = raw => {
    return (raw || "")
      .replace(/;.*$/g, "")           // cortar en primer punto y coma
      .replace(/\t.*$/g, "")          // cortar en primer tab
      .replace(/\s+\d+\s*min(?:utos?)?\s*\d*\s*seg(?:undos?)?/gi, "")
      .replace(/\s+\d+\s*seg(?:undos?)?/gi, "")
      .replace(/\s+\d+:\d+:\d+/g, "")
      .replace(/\s+\d+:\d+/g, "")
      .trim();
  };

  const distritos = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    const rawNombre = (cols[idx.nombre] || "").trim();
    if (!rawNombre || rawNombre.toLowerCase().startsWith("centro") || rawNombre.toLowerCase() === "total") continue;

    const nombre = cleanNombre(rawNombre);
    if (!nombre) continue;

    const tiempoStr = tiempoIdx >= 0 ? (cols[tiempoIdx] || "0:00").trim() : "0:00";
    const tiempo1Str = idx.tiempo1 >= 0 ? (cols[idx.tiempo1] || "0:00").trim() : "0:00";
    const tiempo2Str = idx.tiempo2 >= 0 ? (cols[idx.tiempo2] || "0:00").trim() : "0:00";
    const tiempo3Str = idx.tiempo3 >= 0 ? (cols[idx.tiempo3] || "0:00").trim() : "0:00";
    const total = idx.total >= 0 ? parseInt(cols[idx.total]) || 0 : 0;
    const efectiva = idx.efectiva >= 0 ? parseInt(cols[idx.efectiva]) || 0 : 0;
    const tiempoSec = parseTimeToSeconds(tiempoStr);
    const tiempo1Sec = parseTimeToSeconds(tiempo1Str);
    const tiempo2Sec = parseTimeToSeconds(tiempo2Str);
    const tiempo3Sec = parseTimeToSeconds(tiempo3Str);
    if (nombre && (tiempoSec || total || efectiva)) {
      distritos.push({ nombre, tiempoStr, tiempoSec, tiempo1Str, tiempo2Str, tiempo3Str, tiempo1Sec, tiempo2Sec, tiempo3Sec, total, efectiva, noEfectiva: Math.max(0, total - efectiva) });
    }
  }
  return distritos;
}


function detectType(text, filename) {
  const normalize = str => str.toLowerCase().trim()
    .replace(/á/g, "a").replace(/é/g, "e").replace(/í/g, "i").replace(/ó/g, "o").replace(/ú/g, "u")
    .replace(/[\s\/-]+/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");

  // Detección por nombre de archivo (más confiable que el contenido)
  if (filename) {
    const fn = normalize(filename);
    if (fn.startsWith("llamadas por agente") || fn.startsWith("actividad del agente")) return "agentes";
    if (fn.startsWith("abandonadas")) return "abandonadas";
    if (fn.startsWith("tiempo inicio") || fn.startsWith("tiempo inicio despacho")) return "despacho-inicio";
    if (fn.startsWith("tiempo derivacion") || fn.startsWith("tiempo derivaci")) return "despacho-derivacion";
    if (fn.startsWith("tiempo creacion") || fn.startsWith("tiempo creaci")) return "despacho-creacion";
  }

  // Fallback: detección por contenido
  const t = normalize(text.slice(0, 2000));
  if (t.includes("llamadas por agente") || t.includes("actividad del agente")) return "agentes";
  if (t.includes("abandonadas") && t.includes("grupo de servicio")) return "abandonadas";
  // creacion ANTES que derivacion (el CSV de Creacion contiene 'derivacion' en su header)
  if (t.includes("creacion")) return "despacho-creacion";
  if (t.includes("tiempo inicio despacho") || t.includes("inicio despacho")) return "despacho-inicio";
  if (t.includes("tiempo derivacion") || t.includes("derivacion")) return "despacho-derivacion";
  if (t.includes("centro despacho") || t.includes("asignaci")) return "despacho";
  return null;
}

function hasRequiredUploads(loaded) {
  return loaded.includes("agentes") &&
    loaded.includes("abandonadas") &&
    loaded.includes("despacho-inicio") &&
    loaded.includes("despacho-derivacion") &&
    loaded.includes("despacho-creacion");
}

function buildScheduleLabel(meta) {
  if (!meta) return "";
  const { horaDesde, horaHasta, fechaDesde, fechaHasta } = meta;
  if (!horaDesde && !horaHasta) return fechaDesde || "";
  const from = horaDesde ? horaDesde.slice(0, 5) : "";
  const to = horaHasta ? horaHasta.slice(0, 5) : "";
  const fDate = fechaDesde || "";
  const tDate = fechaHasta && fechaHasta !== fechaDesde ? ` ${fechaHasta}` : "";
  return `${fDate} ${from} → ${tDate} ${to}`.trim();
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
  const despachoInicio = files?.despachoInicio || [];
  const despachoDerivacion = files?.despachoDerivacion || [];
  const despachoCreacion = files?.despachoCreacion || [];
  let fullMeta = { ...meta };
  if (agentesData?.meta) fullMeta = { ...fullMeta, ...agentesData.meta };

  const totalOfrecidas = agentesData?.meta?.totalOfrecidas || (agentesData?.agents ? agentesData.agents.reduce((s, a) => s + (a.ofrecidas || 0), 0) : 0);
  const totalContestadas = agentesData?.meta?.totalContestadas || (agentesData?.agents ? agentesData.agents.reduce((s, a) => s + (a.contestadas || 0), 0) : 0);
  const totalAbandonadas = agentesData?.meta?.totalAbanCabina || (abandonadasData?.totals?.abandonadas || (abandonadasData?.intervals ? abandonadasData.intervals.reduce((s, i) => s + (i.abandonadas || 0), 0) : 0));

  const turnoLabel = generateTurnoLabel(fullMeta);

  const report = {
    id: generateReportId(),
    token: generateToken(),
    uid: uid,
    usuario: userDisplayName || userEmail || uid,
    fechaGuardado: new Date().toISOString(),
    turnoLabel: turnoLabel,
    turno: {
      fecha: fullMeta.fechaDesde || fullMeta.fecha || "",
      horaDesde: fullMeta.horaDesde || "",
      horaHasta: fullMeta.horaHasta || "",
    },
    resumen: {
      totalOfrecidas,
      totalContestadas,
      totalAbandonadas,
    },
    datos: {
      agentes: agentesData?.agents || [],
      abandonadas: abandonadasData?.intervals || [],
      despachoInicio,
      despachoDerivacion,
      despachoCreacion,
      agentesResumen: agentesData?.meta || {},
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
      usuario: userDisplayName || userEmail || uid,
      userEmail,
      userDisplayName,
      userProviderId,
      turnoLabel,
      archivos: [
        agentesData ? { nombre: "agentes", tipo: "agentes", filas: agentesData.agents?.length || 0 } : null,
        abandonadasData ? { nombre: "abandonadas", tipo: "abandonadas", filas: abandonadasData.intervals?.length || 0 } : null,
        despachoInicio.length ? { nombre: "despacho-inicio", tipo: "despacho-inicio", filas: despachoInicio.length } : null,
        despachoDerivacion.length ? { nombre: "despacho-derivacion", tipo: "despacho-derivacion", filas: despachoDerivacion.length } : null,
        despachoCreacion.length ? { nombre: "despacho-creacion", tipo: "despacho-creacion", filas: despachoCreacion.length } : null,
      ].filter(Boolean),
      timestamp: serverTimestamp(),
    });

    return { ...report, firestoreId: docRef.id };
  } catch (e) {
    console.error("✗ Error guardando en Firestore:", e);
    return null;
  }
}

async function loadReportsFromFirestore() {
  const db = getDB();
  if (!db) return [];
  try {
    const { collection, query, orderBy, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    // Carga TODOS los reportes (visibles para todos los usuarios autenticados)
    const q = query(
      collection(db, "informes"),
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

// ─── Mensual Firestore Helpers ──────────────────
async function saveMensualToFirestore(data, meta, user) {
  const db = getDB();
  if (!db || !user?.uid) return null;
  const { collection, query, where, getDocs, setDoc, doc, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  try {
    // 🔍 Buscar si ya existe un registro para este mes/año del mismo usuario
    const q = query(
      collection(db, "analisis_mensual"),
      where("uid", "==", user.uid),
      where("meta.monthNum", "==", meta.monthNum),
      where("meta.year", "==", meta.year)
    );
    const snap = await getDocs(q);
    
    const payload = {
      ...data,
      meta,
      uid: user.uid,
      usuario: user.displayName || user.email || user.uid,
      updatedAt: serverTimestamp()
    };

    if (!snap.empty) {
      // 📝 Sobrescribir existente
      const existingDoc = snap.docs[0];
      await setDoc(doc(db, "analisis_mensual", existingDoc.id), payload, { merge: true });
      return existingDoc.id;
    } else {
      // ✨ Crear nuevo
      const docRef = await addDoc(collection(db, "analisis_mensual"), {
        ...payload,
        createdAt: serverTimestamp()
      });
      return docRef.id;
    }
  } catch (e) {
    console.error("Error saving monthly data:", e);
    return null;
  }
}

async function loadMensualFromFirestore() {
  const db = getDB();
  if (!db) return [];
  const { collection, query, orderBy, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  try {
    const q = query(collection(db, "analisis_mensual"), orderBy("meta.year", "desc"), orderBy("meta.monthNum", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(doc => ({ firestoreId: doc.id, ...doc.data() }));
  } catch (e) {
    console.error("Error loading monthly records:", e);
    throw e; // Lanzar el error para que la UI lo capture
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
    const totalOfrecidas = agentesData?.meta?.totalOfrecidas || (agentesData?.agents?.reduce((s, a) => s + (a.ofrecidas || 0), 0) || 0);
    const totalContestadas = agentesData?.meta?.totalContestadas || (agentesData?.agents?.reduce((s, a) => s + (a.contestadas || 0), 0) || 0);
    const totalAbandonadas = agentesData?.meta?.totalAbanCabina || (abandonadasData?.totals?.abandonadas || 0);
    const report = {
      id: generateReportId(), token: generateToken(),
      fechaGuardado: new Date().toISOString(),
      turnoLabel: generateTurnoLabel(fullMeta),
      turno: { fecha: fullMeta.fechaDesde || "", horaDesde: fullMeta.horaDesde || "", horaHasta: fullMeta.horaHasta || "" },
      resumen: { totalOfrecidas, totalContestadas, totalAbandonadas },
      datos: {
        agentes: agentesData?.agents || [],
        abandonadas: abandonadasData?.intervals || [],
        despachoInicio: files?.despachoInicio || [],
        despachoDerivacion: files?.despachoDerivacion || [],
        despachoCreacion: files?.despachoCreacion || [],
        agentesResumen: agentesData?.meta || {},
        abandonadasResumen: abandonadasData?.totals || {},
      },
    };
    history.push(report);
    localStorage.setItem("sae911_reports", JSON.stringify(history));
    return report;
  } catch { return null; }
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
  React.createElement("div", { 
    className: "glass",
    style: { borderRadius: 24, padding: "28px", ...style } 
  }, children);

const Badge = ({ label, color, bg }) =>
  React.createElement("span", { 
    style: { 
      fontSize: 10, fontWeight: 800, color: color, background: bg, 
      padding: "5px 12px", borderRadius: 10, border: `1px solid ${color}44`,
      textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap"
    } 
  }, label);

const SectionTitle = ({ title, sub, icon }) =>
  React.createElement("div", { style: { marginBottom: 32, display: "flex", alignItems: "center", gap: 16 } },
    icon && React.createElement("div", { style: { fontSize: 24, padding: 10, background: "rgba(59, 130, 246, 0.1)", borderRadius: 14, color: C.blue } }, icon),
    React.createElement("div", null,
      React.createElement("div", { style: { fontSize: 24, fontWeight: 900, color: "#fff", letterSpacing: -0.5 } }, title),
      sub && React.createElement("div", { style: { fontSize: 13, color: C.gray, marginTop: 4, fontWeight: 500 } }, sub)
    )
  );

const StatKpi = ({ label, value, sub, accent, icon }) =>
  React.createElement("div", { 
    className: "glass neon-blue",
    style: { padding: "24px 28px", borderRadius: 24, flex: 1, minWidth: 160, position: "relative", overflow: "hidden" } 
  },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 } },
      React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: C.gray, textTransform: "uppercase", letterSpacing: 1 } }, label),
      icon && React.createElement("div", { style: { fontSize: 22, opacity: 0.8 } }, icon)
    ),
    React.createElement("div", { style: { fontSize: 36, fontWeight: 900, color: "#fff", lineHeight: 1, marginBottom: 8 } }, value),
    sub && React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: accent || C.blue, display: "flex", alignItems: "center", gap: 4 } }, sub),
    // Decorative glow
    React.createElement("div", { style: { position: "absolute", bottom: -20, right: -20, width: 80, height: 80, background: accent || C.blue, filter: "blur(40px)", opacity: 0.15, pointerEvents: "none" } })
  );

const MiniBar = ({ pct, color }) =>
  React.createElement("div", { style: { background: "rgba(255,255,255,0.05)", borderRadius: 99, height: 6, flex: 1, overflow: "hidden" } },
    React.createElement("div", { style: { width: `${Math.min(100, pct || 0)}%`, background: color || C.blue, height: "100%", borderRadius: 99, boxShadow: `0 0 10px ${color || C.blue}66` } })
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
      React.createElement("img", { src: "src/img/dirlogo.png", alt: "Logo", style: { height: 60, marginBottom: 16 } }),
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
    agentes: { label: "Llamadas por Agente", color: C.mid, bg: C.light },
    abandonadas: { label: "Abandonadas por Hora", color: C.red, bg: C.redBg },
    "despacho-inicio": { label: "Tiempo Inicio Despacho", color: C.green, bg: C.greenBg },
    "despacho-derivacion": { label: "Tiempo Derivación Inicio", color: C.orange, bg: C.orBg },
    "despacho-creacion": { label: "Tiempo Creación/Derivación", color: C.blue, bg: C.light },
  };
  const totalTypes = Object.keys(types).length;
  const doneCount = Object.keys(types).filter(k => loaded.includes(k)).length;
  return React.createElement("div", {
    onDragOver: e => { e.preventDefault(); setDrag(true); },
    onDragLeave: () => setDrag(false),
    onDrop: e => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files)); },
    style: { border: `2px dashed ${drag ? C.mid : C.border}`, borderRadius: 16, padding: "40px 28px", textAlign: "center", background: drag ? "#EFF6FF" : C.bg, transition: "all .2s", cursor: "pointer", position: "relative" }
  },
    React.createElement("input", { type: "file", multiple: true, accept: ".csv", onChange: e => onFiles(Array.from(e.target.files)), style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" } }),
    React.createElement("div", { style: { fontSize: 40, marginBottom: 10 } }, "📂"),
    React.createElement("div", { style: { fontSize: 18, fontWeight: 800, color: C.navy, marginBottom: 6 } }, "Arrastrá los 5 archivos CSV aquí"),
    React.createElement("div", { style: { fontSize: 13, color: C.gray, marginBottom: 4 } }, "o hacé clic para seleccionarlos — se detectan automáticamente"),
    React.createElement("div", { style: { fontSize: 12, color: doneCount === totalTypes ? C.green : C.orange, fontWeight: 700, marginBottom: 16 } }, `${doneCount} de ${totalTypes} archivos cargados`),
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
  const { abandonadas: ab, agentes: ag, despachoInicio: dpI, despachoDerivacion: dpD, despachoCreacion: dpC } = data;
  const tot = ab?.totals || {};
  const pctAtend = tot.ofrecidas ? ((tot.contestadas / tot.ofrecidas) * 100) : 0;
  const pctAband = tot.ofrecidas ? ((tot.abandonadas / tot.ofrecidas) * 100) : 0;
  const meta = ab?.meta || ag?.meta || {};

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: "bottom", labels: { color: "#fff", font: { family: 'Outfit', size: 10 } } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: C.gray, font: { size: 9 } } },
      y: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: C.gray, font: { size: 9 } } }
    }
  };

  const horaData = useMemo(() => {
    if (!ab?.intervals?.length) return null;
    const ivs = ab.intervals;
    return {
      labels: ivs.map(i => i.hora),
      datasets: [
        { label: "Atendidas", data: ivs.map(i => i.contestadas), backgroundColor: C.blue, borderRadius: 8 },
        { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 8 },
      ]
    };
  }, [ab]);

  const abandonDonut = useMemo(() => {
    if (!tot.abandonadas) return null;
    return { 
      labels: ["En Cola", "En Cabina"], 
      datasets: [{ 
        data: [tot.cola || 0, tot.cabina || 0], 
        backgroundColor: [C.blue, "rgba(255,255,255,0.2)"], 
        borderWidth: 0, 
        hoverOffset: 10 
      }] 
    };
  }, [tot]);

  const agentesData = useMemo(() => {
    if (!ag?.agents?.length) return null;
    const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a, b) => b.contestadas - a.contestadas);
    return { 
      labels: main.map(a => a.nombre.split(",")[0]), 
      datasets: [
        { label: "Atendidas", data: main.map(a => a.contestadas), backgroundColor: C.blue, borderRadius: 8 },
        { label: "Abandonadas", data: main.map(a => a.abandonadas), backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 8 }
      ] 
    };
  }, [ag]);

  const agentsRanking = useMemo(() => {
    if (!ag?.agents?.length) return { top: [], bot: [] };
    const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a, b) => b.contestadas - a.contestadas);
    return {
      top: main.slice(0, 3),
      bot: [...main].reverse().slice(0, 3),
      total: main.length
    };
  }, [ag]);

  const gaugeData = useMemo(() => {
    const avg = arr => Array.isArray(arr) && arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
    const tI = avg((dpI || []).map(d => d.tiempoSec || 0));
    const tD = avg((dpD || []).map(d => d.tiempoSec || 0));
    const tC = avg((dpC || []).map(d => d.tiempoSec || 0));
    return { tI, tD, tC };
  }, [dpI, dpD, dpC]);

  return React.createElement("div", null,
    React.createElement(SectionTitle, { 
      title: "Resumen Operativo", 
      sub: meta.fechaDesde ? `${meta.fechaDesde} ${meta.horaDesde} → ${meta.fechaHasta} ${meta.horaHasta}` : "Datos del turno actual",
      icon: "📊"
    }),

    React.createElement("div", { style: { display: "flex", gap: 20, marginBottom: 32 } },
      React.createElement(StatKpi, { label: "Total Ofrecidas", value: tot.ofrecidas?.toLocaleString(), icon: "📞", sub: "Volumen total" }),
      React.createElement(StatKpi, { label: "Nivel Atención", value: `${pctAtend.toFixed(1)}%`, icon: "🎯", accent: C.blue, sub: `${tot.contestadas?.toLocaleString()} atendidas` }),
      React.createElement(StatKpi, { label: "Abandono", value: `${pctAband.toFixed(1)}%`, icon: "⚠️", accent: pctAband > 20 ? C.red : C.gray, sub: `${tot.abandonadas?.toLocaleString()} perdidas` }),
      React.createElement(StatKpi, { label: "Operadores", value: agentsRanking.total, icon: "👤", sub: "Cabinas activas" })
    ),

    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.8fr 1fr", gap: 24, marginBottom: 24 } },
      horaData && React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Tendencia Horaria"),
        React.createElement("div", { style: { height: 300 } }, React.createElement(ChartBar, { id: "chart-hora", data: horaData, options: chartOptions }))
      ),
      abandonDonut && React.createElement(Card, { style: { display: "flex", flexDirection: "column" } },
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 8 } }, "Distribución Abandono"),
        React.createElement("div", { style: { fontSize: 13, color: C.gray, marginBottom: 20 } }, "Fuga en cola vs cabina"),
        React.createElement("div", { style: { flex: 1, minHeight: 200 } }, React.createElement(ChartDoughnut, { id: "chart-abandono", data: abandonDonut, options: { ...chartOptions, cutout: "75%" } })),
        React.createElement("div", { style: { marginTop: 24, display: "flex", justifyContent: "center", gap: 12 } },
          React.createElement(Badge, { label: `Cola: ${tot.cola}`, color: C.blue, bg: "rgba(59, 130, 246, 0.1)" }),
          React.createElement(Badge, { label: `Cabina: ${tot.cabina}`, color: "#fff", bg: "rgba(255, 255, 255, 0.05)" })
        )
      )
    ),

    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.8fr 1fr", gap: 24, marginBottom: 24 } },
      agentesData && React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Desempeño Individual"),
        React.createElement("div", { style: { height: 340 } }, React.createElement(ChartBar, { id: "chart-agentes", data: agentesData, options: chartOptions }))
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Mejores Operadores"),
        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
          agentsRanking.top.map((a, i) => React.createElement("div", { key: a.nombre, style: { padding: "14px 20px", borderRadius: 16, background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 14 } },
            React.createElement("div", { style: { width: 32, height: 32, borderRadius: 10, background: C.blue, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 900 } }, i + 1),
            React.createElement("div", { style: { flex: 1 } },
              React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: "#fff" } }, a.nombre.split(",")[0]),
              React.createElement("div", { style: { fontSize: 11, color: C.gray } }, `${a.ofrecidas} ofrecidas`)
            ),
            React.createElement("div", { style: { fontSize: 16, fontWeight: 900, color: C.blue } }, a.contestadas)
          ))
        ),
        React.createElement("div", { style: { height: 1, background: C.border, margin: "24px 0" } }),
        React.createElement("div", { style: { fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 12, opacity: 0.8 } }, "⚠️ REVISIÓN NECESARIA"),
        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
          agentsRanking.bot.map((a, i) => React.createElement("div", { key: a.nombre, style: { padding: "10px 16px", borderRadius: 12, background: "rgba(239, 68, 68, 0.05)", border: "1px solid rgba(239, 68, 68, 0.1)", display: "flex", alignItems: "center", gap: 12 } },
             React.createElement("div", { style: { flex: 1, fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.7)" } }, a.nombre.split(",")[0]),
             React.createElement("div", { style: { fontSize: 12, fontWeight: 800, color: C.red } }, a.contestadas)
          ))
        )
      )
    ),

    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, marginBottom: 24 } },
      [
        { lab: "Inicio → Despacho", val: gaugeData.tI, thr: 120 },
        { lab: "Derivación → Inicio", val: gaugeData.tD, thr: 80 },
        { lab: "Creación → Despacho", val: gaugeData.tC, thr: 180 }
      ].map(g => React.createElement(Card, { key: g.lab, style: { textAlign: "center" } },
         React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: C.gray, marginBottom: 16, textTransform: "uppercase" } }, g.lab),
         React.createElement("div", { style: { fontSize: 42, fontWeight: 900, color: g.val > g.thr ? C.red : (g.val > g.thr * 0.7 ? "#fff" : C.blue), filter: "drop-shadow(0 0 10px rgba(59,130,246,0.3))" } }, fmtSeconds(g.val))
      ))
    ),

    React.createElement(AutoAlertas, { data })
  );
}

// ─── Alertas automáticas ────────────────────────────────────────────────────
function AutoAlertas({ data }) {
  const alerts = useMemo(() => {
    const list = [];
    const tot = data.abandonadas?.totals || {};
    const ivs = data.abandonadas?.intervals || [];
    const meta = data.abandonadas?.meta || data.agentes?.meta || {};

    // Calcular umbral dinámico de abandono por hora basado en el volumen total del turno
    const totalHoras = ivs.length || 1;
    const promAbandPorHora = ivs.length ? ivs.reduce((s, i) => s + i.abandonadas, 0) / ivs.length : 0;
    const umbralAbandHora = Math.max(30, Math.round(promAbandPorHora * 2));

    const pctAb = tot.ofrecidas ? (tot.abandonadas / tot.ofrecidas) * 100 : 0;
    if (pctAb > 25) list.push({ type: "red", msg: `Tasa de abandono elevada: ${pctAb.toFixed(1)}% (supera el umbral del 25%)` });
    if (pctAb >= 15 && pctAb <= 25) list.push({ type: "yellow", msg: `Tasa de abandono moderada: ${pctAb.toFixed(1)}% — monitorear` });

    // Horario del turno
    const scheduleStr = meta.horaDesde && meta.horaHasta ? ` (turno ${meta.horaDesde.slice(0, 5)} → ${meta.horaHasta.slice(0, 5)})` : "";

    if (ivs.length) {
      const worst = [...ivs].sort((a, b) => b.abandonadas - a.abandonadas)[0];
      if (worst && worst.abandonadas > umbralAbandHora) {
        const pctIv = worst.ofrecidas > 0 ? Math.round((worst.abandonadas / worst.ofrecidas) * 100) : 0;
        list.push({ type: "orange", msg: `Hora pico de abandono${scheduleStr}: ${worst.hora} hs (${worst.abandonadas} abandonadas — ${pctIv}% del intervalo)` });
      }
    }
    if (data.agentes?.agents) {
      const main = data.agentes.agents.filter(a => a.ofrecidas >= 30);
      main.forEach(a => { const parts = a.tiempoAusente.split(":"); const ausMin = parseInt(parts[0]) * 60 + parseInt(parts[1] || 0); if (ausMin > 130) list.push({ type: "yellow", msg: `${a.nombre}: tiempo ausente elevado (${a.tiempoAusente} hs)` }); });
      main.forEach(a => { if (a.abandonadas > 50) list.push({ type: "orange", msg: `${a.nombre}: ${a.abandonadas} abandonadas en cabina — revisar` }); });
    }
    const allDespacho = [...(data.despachoInicio || []), ...(data.despachoDerivacion || []), ...(data.despachoCreacion || [])];
    allDespacho.filter(d => d.tiempoSec > 300).forEach(d => list.push({ type: "red", msg: `${d.nombre}: tiempo de despacho crítico (${fmtSeconds(d.tiempoSec)})` }));
    return list;
  }, [data]);

  if (!alerts.length) return React.createElement("div", { style: { padding: "14px 18px", background: C.greenBg, border: "1px solid #86efac", borderRadius: 10, fontSize: 13, color: "#14532d", fontWeight: 600 } }, "✅ Sin alertas críticas en este turno.");

  const colors = { red: [C.redBg, "#991b1b"], yellow: [C.ylBg, "#78350f"], orange: [C.orBg, "#7c2d12"] };
  const icons = { red: "🔴", yellow: "🟡", orange: "🟠" };
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
  const meta = data.abandonadas?.meta || data.agentes?.meta || {};
  const scheduleLabel = buildScheduleLabel(meta);
  
  if (!ivs.length) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargá el archivo de Abandonadas para ver este módulo.");

  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { 
      x: { grid: { display: false }, ticks: { color: C.gray, font: { size: 9 } } }, 
      y: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: C.gray, font: { size: 9 } } } 
    }
  };

  return React.createElement("div", { style: { animation: "fadeInUp 0.6s ease-out" } },
    React.createElement(SectionTitle, { title: "Tráfico por Hora", sub: scheduleLabel || "Análisis detallado por intervalo horario", icon: "🕒" }),
    
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.8fr 1fr", gap: 24, marginBottom: 24 } },
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Cargas Atendidas vs Abandonadas"),
        React.createElement("div", { style: { height: 280 } }, React.createElement(ChartBar, { id: "hora-bar", data: { 
          labels: ivs.map(i => i.hora), 
          datasets: [
            { label: "Atendidas", data: ivs.map(i => i.contestadas), backgroundColor: C.blue, borderRadius: 6 }, 
            { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 6 }
          ] 
        }, options: chartOptions }))
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Tasa de Abandono %"),
        React.createElement("div", { style: { height: 280 } }, React.createElement(ChartLine, { id: "hora-pct", data: { 
          labels: ivs.map(i => i.hora), 
          datasets: [{ 
            data: ivs.map(i => i.ofrecidas ? +((i.abandonadas / i.ofrecidas) * 100).toFixed(1) : 0), 
            borderColor: C.blue, backgroundColor: "rgba(59, 130, 246, 0.1)", fill: true, tension: 0.4, pointRadius: 4, borderWidth: 3
          }] 
        }, options: chartOptions }))
      )
    ),

    React.createElement(Card, null,
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { className: "modern-table" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              ["Intervalo", "Ofrecidas", "Atendidas", "Cola", "Cabina", "Total Aband.", "% Aband."].map(h => React.createElement("th", { key: h }, h))
            )
          ),
          React.createElement("tbody", null,
            ivs.map((iv, i) => {
              const pctAb = iv.ofrecidas ? +((iv.abandonadas / iv.ofrecidas) * 100).toFixed(0) : 0;
              return React.createElement("tr", { key: i },
                React.createElement("td", { style: { fontWeight: 800, color: "#fff" } }, iv.label),
                React.createElement("td", null, iv.ofrecidas),
                React.createElement("td", { style: { color: C.blue, fontWeight: 700 } }, iv.contestadas),
                React.createElement("td", null, iv.cola),
                React.createElement("td", null, iv.cabina),
                React.createElement("td", { style: { color: C.red, fontWeight: 700 } }, iv.abandonadas),
                React.createElement("td", null, React.createElement(Badge, { label: `${pctAb}%`, color: pctAb > 20 ? C.red : C.blue, bg: pctAb > 20 ? "rgba(239, 68, 68, 0.1)" : "rgba(59, 130, 246, 0.1)" }))
              );
            })
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
  
  const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a, b) => b.contestadas - a.contestadas);

  return React.createElement("div", { style: { animation: "fadeInUp 0.6s ease-out" } },
    React.createElement(SectionTitle, { title: "Gestión de Cabinas", sub: `${main.length} operadores activos en el turno`, icon: "👥" }),
    
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 } },
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Productividad Individual"),
        React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "ag-bar", data: { 
          labels: main.map(a => a.nombre.split(",")[0]), 
          datasets: [
            { label: "Atendidas", data: main.map(a => a.contestadas), backgroundColor: C.blue, borderRadius: 6 }, 
            { label: "Ofrecidas", data: main.map(a => a.ofrecidas), backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 6 }
          ] 
        }, options: { 
          responsive: true, maintainAspectRatio: false, 
          plugins: { legend: { display: false } },
          scales: { 
            x: { grid: { display: false }, ticks: { color: C.gray, font: { size: 9 } } }, 
            y: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: C.gray, font: { size: 9 } } } 
          }
        } }))
      ),
      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "% Disponibilidad"),
        React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "ag-disp", data: { 
          labels: main.map(a => a.nombre.split(",")[0]), 
          datasets: [{ 
            data: main.map(a => a.disponibilidad), 
            backgroundColor: main.map(a => a.disponibilidad > 85 ? C.blue : a.disponibilidad > 70 ? "rgba(59, 130, 246, 0.4)" : "rgba(255,255,255,0.1)"), 
            borderRadius: 6 
          }] 
        }, options: { 
          responsive: true, maintainAspectRatio: false, 
          plugins: { legend: { display: false } },
          scales: { 
            x: { grid: { display: false }, ticks: { color: C.gray, font: { size: 9 } } }, 
            y: { max: 100, grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: C.gray, font: { size: 9 } } } 
          }
        } }))
      )
    ),

    React.createElement(Card, null,
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { className: "modern-table" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              ["Operador", "Ofrec.", "Contest.", "Aband.", "Conectado", "Ausente", "Disponib."].map(h => React.createElement("th", { key: h }, h))
            )
          ),
          React.createElement("tbody", null,
            main.map((a, i) => React.createElement("tr", { key: a.nombre },
              React.createElement("td", { style: { fontWeight: 800, color: "#fff" } }, a.nombre),
              React.createElement("td", null, a.ofrecidas),
              React.createElement("td", { style: { color: C.blue, fontWeight: 700 } }, a.contestadas),
              React.createElement("td", null, React.createElement(Badge, { label: a.abandonadas, color: a.abandonadas > 30 ? C.red : C.gray, bg: a.abandonadas > 30 ? "rgba(239, 68, 68, 0.1)" : "rgba(255,255,255,0.03)" })),
              React.createElement("td", { style: { fontFamily: "monospace", fontSize: 11 } }, a.tiempoConectado),
              React.createElement("td", { style: { fontFamily: "monospace", fontSize: 11, color: parseTimeToSeconds(a.tiempoAusente) > 7200 ? C.red : C.gray } }, a.tiempoAusente),
              React.createElement("td", { style: { width: 140 } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  React.createElement(MiniBar, { pct: a.disponibilidad, color: a.disponibilidad > 80 ? C.blue : "rgba(255,255,255,0.2)" }),
                  React.createElement("span", { style: { fontSize: 10, fontWeight: 800, color: "#fff", minWidth: 40 } }, `${a.disponibilidad.toFixed(1)}%`)
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
function DespachoSection({ title, subtitle, dataset, sectionNum, compact }) {
  if (!dataset?.length) return React.createElement("div", { style: { padding: "20px", textAlign: "center", color: C.gray, fontSize: 12 } }, `Sin datos para: ${title}`);
  const sorted = [...dataset].sort((a, b) => a.tiempoSec - b.tiempoSec);
  const maxSec = sorted[sorted.length - 1]?.tiempoSec || 1;
  const top3 = sorted.slice(0, 3);
  const bot3 = sorted.slice(-3).reverse();
  
  return React.createElement("div", { style: { marginBottom: compact ? 16 : 40 } },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 } },
      React.createElement("div", null,
        React.createElement("div", { style: { fontWeight: 900, fontSize: 18, color: "#fff", letterSpacing: -0.5 } }, title),
        React.createElement("div", { style: { fontSize: 13, color: C.gray, marginTop: 4 } }, subtitle || `${sorted.length} distritos analizados`)
      )
    ),
    
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 } },
      React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: 1, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 } }, 
          React.createElement("span", null, "🏆 Eficiencia Superior (Top 3)")
        ),
        top3.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: i + 1, variant: "top" }))
      ),
      React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color: C.red, textTransform: "uppercase", letterSpacing: 1, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 } }, 
          React.createElement("span", null, "⚠️ Atención Requerida (Bottom 3)")
        ),
        bot3.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: sorted.length - i, variant: "bot" }))
      )
    ),

    !compact && React.createElement(Card, null,
      React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Ranking General de Despacho"),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))", gap: 12 } },
        sorted.map((d, i) => React.createElement(DistritoRow, { key: i, d, maxSec, rank: i + 1, variant: i < 3 ? "top" : i >= sorted.length - 3 ? "bot" : "mid" }))
      )
    )
  );
}


function ViewDespacho({ data }) {
  const dpI = data.despachoInicio || [];
  const dpD = data.despachoDerivacion || [];
  const dpC = data.despachoCreacion || [];

  if (!dpI.length && !dpD.length && !dpC.length)
    return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargá los archivos de tiempos de despacho.");

  return React.createElement("div", { style: { animation: "fadeInUp 0.6s ease-out" } },
    React.createElement(SectionTitle, { title: "Tiempos de Respuesta", sub: "Análisis comparativo de latencia por distrito", icon: "⏱️" }),
    
    dpC.length > 0 && React.createElement(DespachoSection, {
      title: "Creación → Derivación",
      subtitle: "Tiempo transcurrido desde la creación del evento hasta la derivación a despacho",
      dataset: dpC,
    }),
    
    dpD.length > 0 && React.createElement(DespachoSection, {
      title: "Derivación → Inicio Despacho",
      subtitle: "Tiempo de espera en cola de despacho antes de ser tomado por un operador",
      dataset: dpD,
    }),
    
    dpI.length > 0 && React.createElement(DespachoSection, {
      title: "Inicio Despacho → Asignación",
      subtitle: "Tiempo que tarda el operador en asignar un recurso al evento",
      dataset: dpI,
    })
  );
}


function DistritoRow({ d, maxSec, rank, variant }) {
  const pct = maxSec > 0 ? (d.tiempoSec / maxSec) * 100 : 0;
  const efPct = d.total > 0 ? (d.efectiva / d.total) * 100 : 0;
  const isAlt = variant === "bot";
  const color = isAlt ? C.red : (variant === "top" ? C.blue : "#fff");

  return React.createElement("div", { 
    className: "glass",
    style: { 
      display: "flex", alignItems: "center", gap: 16, padding: "14px 20px", 
      borderRadius: 16, marginBottom: 8, border: `1px solid ${variant === 'mid' ? 'transparent' : color + '22'}`
    } 
  },
    React.createElement("div", { style: { width: 28, height: 28, borderRadius: 10, background: variant === 'mid' ? 'rgba(255,255,255,0.05)' : color, color: variant === 'mid' ? C.gray : '#fff', display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, flexShrink: 0 } }, rank),
    React.createElement("div", { style: { flex: 1 } },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 } },
        React.createElement("div", { style: { fontSize: 13, fontWeight: 800, color: "#fff" } }, d.nombre),
        React.createElement("div", { style: { fontSize: 14, fontWeight: 900, color: color, filter: variant !== 'mid' ? `drop-shadow(0 0 8px ${color}44)` : 'none' } }, fmtSeconds(d.tiempoSec))
      ),
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
        React.createElement(MiniBar, { pct, color: color }),
        React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, minWidth: 60, textAlign: "right" } }, 
           React.createElement("span", { style: { color: efPct >= 90 ? C.blue : (efPct >= 70 ? "#fff" : C.red) } }, `${efPct.toFixed(0)}% Efic.`)
        )
      )
    )
  );
}


// ════════════════════════════════════════════════════════════════════════════
//  VIEW: HISTORIAL — Firebase + local fallback
// ════════════════════════════════════════════════════════════════════════════
function ViewHistorial({ user }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterTurno, setFilterTurno] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const isFirebase = !!user;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (isFirebase) {
      loadReportsFromFirestore().then(reports => {
        if (!cancelled) { setHistory(reports); setLoading(false); }
      });
    } else {
      setHistory(getLocalHistory().slice().reverse());
      setLoading(false);
    }
    return () => { cancelled = true; };
  }, [user]);

  const handleDelete = async (report) => {
    if (isFirebase && report.uid !== user?.uid) return;
    if (!confirm(`¿Eliminar el reporte ${report.id}?`)) return;
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
  const canDelete = (r) => !isFirebase || r.uid === user?.uid;

  if (loading) return React.createElement("div", { style: { padding: 60, textAlign: "center", color: C.gray } }, "Cargando historial…");

  if (!history.length) return React.createElement("div", { style: { padding: 80, textAlign: "center", color: C.gray } },
    React.createElement("div", { style: { fontSize: 64, marginBottom: 24 } }, "📋"),
    React.createElement("div", { style: { fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 12 } }, "Bóveda Vacía"),
    React.createElement("div", { style: { fontSize: 13, maxWidth: 400, margin: "0 auto" } }, isFirebase ? "Los informes generados se sincronizan automáticamente en la nube." : "No se encontraron informes locales guardados en este navegador.")
  );

  if (selectedReport) {
    const avg = arr => Array.isArray(arr) && arr.length ? Math.round(arr.reduce((s, v) => s + (v.tiempoSec || 0), 0) / arr.length) : 0;
    const dpI = selectedReport.datos?.despachoInicio || [];
    const dpD = selectedReport.datos?.despachoDerivacion || [];
    const dpC = selectedReport.datos?.despachoCreacion || [];

    return React.createElement("div", { style: { animation: "fadeIn 0.4s ease-out" } },
      React.createElement(Card, { style: { marginBottom: 24 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 } },
          React.createElement("button", { onClick: () => setSelectedReport(null), style: { background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, color: "#fff", borderRadius: 12, padding: "10px 20px", cursor: "pointer", fontSize: 12, fontWeight: 800 } }, "← Volver al Listado"),
          React.createElement("div", { style: { textAlign: "right" } },
            React.createElement("div", { style: { fontSize: 14, fontWeight: 900, color: C.blue } }, `Identificador: ${selectedReport.id}`),
            React.createElement("div", { style: { fontSize: 11, color: C.gray, marginTop: 4 } }, selectedReport.fechaGuardado ? new Date(selectedReport.fechaGuardado).toLocaleString() : "")
          )
        ),
        React.createElement("div", { style: { display: "flex", gap: 20 } },
           React.createElement(StatKpi, { label: "Turno Analizado", value: selectedReport.turnoLabel, icon: "🕒" }),
           React.createElement(StatKpi, { label: "Operador de Carga", value: selectedReport.usuario || "Sistema", icon: "👤" })
        )
      ),

      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 } },
        React.createElement(Card, null,
          React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Indicadores de Volumen"),
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
            React.createElement(StatKpi, { label: "Ofrecidas", value: selectedReport.resumen.totalOfrecidas, compact: true }),
            React.createElement(StatKpi, { label: "Contestadas", value: selectedReport.resumen.totalContestadas, accent: C.blue, compact: true }),
            React.createElement(StatKpi, { label: "Abandonadas", value: selectedReport.resumen.totalAbandonadas, accent: C.red, compact: true })
          )
        ),
        React.createElement(Card, null,
          React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Latencia Promedio"),
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
            React.createElement(StatKpi, { label: "Inicio Despacho", value: fmtSeconds(avg(dpI)), compact: true }),
            React.createElement(StatKpi, { label: "Derivaciones", value: fmtSeconds(avg(dpD)), compact: true }),
            React.createElement(StatKpi, { label: "Creaciones", value: fmtSeconds(avg(dpC)), compact: true })
          )
        )
      ),

      selectedReport.datos?.agentes?.length > 0 && React.createElement(Card, { style: { marginBottom: 24 } },
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Desempeño de Agentes en este Turno"),
        React.createElement("table", { className: "modern-table" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              ["Agente", "Ofrec.", "Cont.", "Aband.", "Disp."].map(h => React.createElement("th", { key: h }, h))
            )
          ),
          React.createElement("tbody", null,
            selectedReport.datos.agentes.map((a, i) => React.createElement("tr", { key: i },
              React.createElement("td", { style: { fontWeight: 800, color: "#fff" } }, a.nombre),
              React.createElement("td", null, a.ofrecidas),
              React.createElement("td", { color: C.blue }, a.contestadas),
              React.createElement("td", { color: C.red }, a.abandonadas),
              React.createElement("td", null, `${a.disponibilidad.toFixed(1)}%`)
            ))
          )
        )
      )
    );
  }

  return React.createElement("div", { style: { animation: "fadeInUp 0.6s ease-out" } },
    React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 } },
      React.createElement(SectionTitle, { title: "Bóveda de Archivos", sub: `${history.length} reportes conservados`, icon: "📦" }),
      isFirebase && React.createElement("button", {
        onClick: () => { setLoading(true); loadReportsFromFirestore().then(r => { setHistory(r); setLoading(false); }); },
        className: "neon-blue",
        style: { background: C.blue, border: "none", color: "#fff", borderRadius: 12, padding: "10px 20px", fontSize: 12, fontWeight: 800, cursor: "pointer" }
      }, "↺ Hibernar Datos")
    ),

    React.createElement(Card, { style: { marginBottom: 32 } },
      React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: "#fff", marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 } }, "Filtro Chronológico"),
      React.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
        React.createElement("button", { 
          onClick: () => setFilterTurno(null), 
          style: { 
            padding: "10px 20px", borderRadius: 12, border: filterTurno === null ? `1px solid ${C.blue}` : "1px solid rgba(255,255,255,0.1)", 
            background: filterTurno === null ? "rgba(59, 130, 246, 0.1)" : "transparent",
            color: filterTurno === null ? "#fff" : C.gray, cursor: "pointer", fontSize: 12, fontWeight: 700
          } 
        }, "Todos"),
        turnos.map(turno => React.createElement("button", { 
          key: turno, onClick: () => setFilterTurno(turno), 
          style: { 
            padding: "10px 20px", borderRadius: 12, border: filterTurno === turno ? `1px solid ${C.blue}` : "1px solid rgba(255,255,255,0.1)", 
            background: filterTurno === turno ? "rgba(59, 130, 246, 0.1)" : "transparent",
            color: filterTurno === turno ? "#fff" : C.gray, cursor: "pointer", fontSize: 12, fontWeight: 700
          } 
        }, turno))
      )
    ),

    React.createElement(Card, null,
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { className: "modern-table" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              ["Hash ID", "Operador", "Turno", "V. Total", "Atend.", "Aband.", "Acciones"].map(h => React.createElement("th", { key: h }, h))
            )
          ),
          React.createElement("tbody", null,
            filteredReports.map((r, i) => React.createElement("tr", { key: r.id || i },
              React.createElement("td", { style: { fontFamily: "monospace", color: C.blue, fontWeight: 800, fontSize: 10 } }, (r.id || "-").substring(0, 8)),
              React.createElement("td", { style: { fontSize: 12 } }, r.usuario || "Admin"),
              React.createElement("td", { style: { fontWeight: 800, color: "#fff" } }, r.turnoLabel),
              React.createElement("td", null, r.resumen?.totalOfrecidas),
              React.createElement("td", { style: { color: C.blue, fontWeight: 700 } }, r.resumen?.totalContestadas),
              React.createElement("td", { style: { color: C.red, fontWeight: 700 } }, r.resumen?.totalAbandonadas),
              React.createElement("td", { style: { width: 100 } },
                React.createElement("div", { style: { display: "flex", gap: 8 } },
                  React.createElement("button", { onClick: () => setSelectedReport(r), style: { background: C.blue, color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" } }, "Abrir"),
                  canDelete(r) && React.createElement("button", { onClick: () => handleDelete(r), style: { background: "rgba(239, 68, 68, 0.1)", color: C.red, border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" } }, "✕")
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
//  VIEW: MENSUAL
// ════════════════════════════════════════════════════════════════════════════
function ViewMensual({ user }) {
  const [history, setHistory] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedMonths, setSelectedMonths] = useState([]);

  useEffect(() => { if (user) loadData(); }, [user]);

  const loadData = async () => {
    setLoading(true);
    try { const data = await loadMensualFromFirestore(); setHistory(data); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const handleMonthlyFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await processMonthlyCSV(file, user);
      if (result) {
        alert("¡Mes cargado correctamente!");
        loadData();
      }
    } catch (err) {
      console.error(err);
      alert("Error al procesar el archivo.");
    } finally {
      setUploading(false);
    }
  };

  const chartData = useMemo(() => {
    const selected = history.filter(h => selectedMonths.includes(h.firestoreId));
    if (!selected.length) return null;
    return {
      labels: selected.map(h => h.meta.label),
      datasets: [
        { label: "Ofrecidas", data: selected.map(h => h.resumen.totalOfrecidas), backgroundColor: C.blue, borderRadius: 6 },
        { label: "Contestadas", data: selected.map(h => h.resumen.totalContestadas), backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 6 }
      ]
    };
  }, [history, selectedMonths]);

  if (loading && history.length === 0) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargando histórico...");

  return React.createElement("div", { style: { animation: "fadeInUp 0.6s ease-out" } },
    React.createElement(SectionTitle, { title: "Archivo Mensual", sub: "Histórico de indicadores y mapas críticos", icon: "📅" }),
    
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 2fr", gap: 24, marginBottom: 24 } },
      React.createElement(Card, { style: { textAlign: "center", display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 20px" } },
        React.createElement("div", { style: { fontSize: 48, marginBottom: 20 } }, "📊"),
        React.createElement("div", { style: { fontWeight: 800, fontSize: 18, color: "#fff", marginBottom: 8 } }, "Cargar nuevo mes"),
        React.createElement("div", { style: { fontSize: 13, color: C.gray, marginBottom: 32 } }, "Subí el archivo consolidado para expandir el histórico."),
        React.createElement("div", { style: { position: "relative" } },
          React.createElement("button", { 
            disabled: uploading, 
            className: uploading ? "" : "neon-blue",
            style: { width: "100%", background: C.blue, color: "#fff", border: "none", borderRadius: 14, padding: "14px 24px", fontWeight: 800, cursor: uploading ? "wait" : "pointer" } 
          }, uploading ? "Procesando..." : "📂 Seleccionar CSV"),
          React.createElement("input", { type: "file", accept: ".csv", onChange: handleMonthlyFile, style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" } })
        )
      ),

      React.createElement(Card, null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Comparativa Temporal"),
        history.length === 0 ? 
          React.createElement("div", { style: { color: C.gray, fontSize: 13, textAlign: "center", padding: 40 } }, "No hay datos históricos cargados.") :
          React.createElement("div", null,
            React.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 } },
              history.map(h => {
                const isSel = selectedMonths.includes(h.firestoreId);
                return React.createElement("button", { 
                  key: h.firestoreId, 
                  onClick: () => setSelectedMonths(s => isSel ? s.filter(x => x !== h.firestoreId) : [...s, h.firestoreId]), 
                  style: { 
                    padding: "8px 16px", borderRadius: 12, border: `1px solid ${isSel ? C.blue : "rgba(255,255,255,0.1)"}`, 
                    background: isSel ? "rgba(59, 130, 246, 0.1)" : "rgba(255,255,255,0.03)", 
                    color: isSel ? "#fff" : C.gray, fontWeight: 700, fontSize: 12, cursor: "pointer", transition: "all 0.2s" 
                  } 
                }, h.meta.label);
              })
            ),
            chartData && React.createElement("div", { style: { height: 180 } }, 
              React.createElement(ChartBar, { id: "chart-monthly-comp", data: chartData, options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: { 
                  x: { grid: { display: false }, ticks: { color: C.gray, font: { size: 9 } } },
                  y: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: C.gray, font: { size: 9 } } }
                }
              } })
            )
          )
      )
    ),

    selectedMonths.length === 1 && (() => {
      const h = history.find(x => x.firestoreId === selectedMonths[0]);
      if (!h || !h.detalles) return null;
      return React.createElement(HeatmapSection, { report: h });
    })(),

    history.length > 0 && React.createElement(Card, null,
      React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff", marginBottom: 24 } }, "Historial de Reportes"),
      React.createElement("div", { style: { overflowX: "auto" } },
        React.createElement("table", { className: "modern-table" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              ["Mes/Año", "Ofrecidas", "Contestadas", "Abandonadas", "% Atenc.", "% Aband."].map(h => React.createElement("th", { key: h }, h))
            )
          ),
          React.createElement("tbody", null,
            history.map((h, i) => {
              const pctAt = h.resumen.totalOfrecidas ? (h.resumen.totalContestadas / h.resumen.totalOfrecidas * 100).toFixed(1) : 0;
              const pctAb = h.resumen.totalOfrecidas ? (h.resumen.totalAbandonadas / h.resumen.totalOfrecidas * 100).toFixed(1) : 0;
              return React.createElement("tr", { key: i },
                React.createElement("td", { style: { fontWeight: 800, color: "#fff" } }, h.meta.label),
                React.createElement("td", null, h.resumen.totalOfrecidas.toLocaleString()),
                React.createElement("td", { style: { color: C.blue, fontWeight: 700 } }, h.resumen.totalContestadas.toLocaleString()),
                React.createElement("td", { style: { color: C.red, fontWeight: 700 } }, h.resumen.totalAbandonadas.toLocaleString()),
                React.createElement("td", null, React.createElement(Badge, { label: `${pctAt}%`, color: C.blue, bg: "rgba(59, 130, 246, 0.1)" })),
                React.createElement("td", null, React.createElement(Badge, { label: `${pctAb}%`, color: C.red, bg: "rgba(239, 68, 68, 0.1)" }))
              );
            })
          )
        )
      )
    )
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT: HEATMAP SECTION
// ─────────────────────────────────────────────────────────────────────────────
function HeatmapSection({ report }) {
  const [metric, setMetric] = useState("total"); // total, cnt, abd

  const grid = useMemo(() => {
    const data = report.detalles || [];
    const matrix = {};
    let max = 0;
    data.forEach(row => {
      const h = (row.h || "00:00").substring(0, 2) + ":00";
      const d = row.d;
      let val = 0;
      if (metric === "total") val = row.o || 0;
      else if (metric === "cnt") val = row.c || 0;
      else if (metric === "abd") val = (row.o || 0) - (row.c || 0);

      if (!matrix[h]) matrix[h] = {};
      matrix[h][d] = (matrix[h][d] || 0) + val;
      if (matrix[h][d] > max) max = matrix[h][d];
    });
    return { matrix, max };
  }, [report, metric]);

  const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00`);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);

  const getCellColor = (val) => {
    if (!val) return "rgba(255,255,255,0.02)";
    const ratio = Math.max(0.1, val / (grid.max || 1));
    return `rgba(59, 130, 246, ${ratio})`;
  };

  return React.createElement(Card, { style: { marginBottom: 24 } },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 } },
      React.createElement("div", null,
        React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: "#fff" } }, "Mapa Crítico de Rendimiento"),
        React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 4 } }, report.meta.label)
      ),
      React.createElement("div", { className: "glass", style: { display: "flex", padding: 4, borderRadius: 12 } },
        [
          { id: "total", label: "Totales" }, 
          { id: "cnt", label: "Atendidas" }, 
          { id: "abd", label: "Abandonos" }
        ].map(m => React.createElement("button", { 
          key: m.id, onClick: () => setMetric(m.id), 
          style: { 
            background: metric === m.id ? C.blue : "transparent", color: "#fff", border: "none", 
            padding: "8px 16px", borderRadius: 10, fontSize: 11, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" 
          } 
        }, m.label))
      )
    ),

    React.createElement("div", { style: { overflowX: "auto" } },
      React.createElement("div", { style: { minWidth: 900 } },
        React.createElement("div", { style: { display: "flex", marginBottom: 8 } },
          React.createElement("div", { style: { width: 50 } }),
          days.map(d => React.createElement("div", { key: d, style: { flex: 1, textAlign: "center", fontSize: 9, color: C.gray, fontWeight: 700 } }, d))
        ),
        hours.map(h => React.createElement("div", { key: h, style: { display: "flex", alignItems: "center", height: 26, marginBottom: 2 } },
          React.createElement("div", { style: { width: 50, fontSize: 10, color: C.gray, fontWeight: 700 } }, h),
          days.map(d => {
            const val = grid.matrix[h]?.[d] || 0;
            return React.createElement("div", { 
              key: d, title: `Día ${d}, Hora ${h}: ${val}`,
              style: { 
                flex: 1, height: "100%", margin: "0 1px", borderRadius: 3, background: getCellColor(val), 
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: val > grid.max * 0.6 ? "#fff" : "transparent"
              } 
            }, val || "");
          })
        ))
      )
    ),
    React.createElement("div", { style: { marginTop: 20, display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: C.gray } },
      React.createElement("span", null, "Menor volumen"),
      React.createElement("div", { style: { display: "flex", gap: 2 } }, 
        [0.1, 0.3, 0.5, 0.7, 0.9].map(o => React.createElement("div", { key: o, style: { width: 16, height: 16, borderRadius: 4, background: `rgba(59, 130, 246, ${o})` } }))
      ),
      React.createElement("span", null, "Mayor volumen")
    )
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ════════════════════════════════════════════════════════════════════════════
function App() {
  const [user, setUser] = useState(undefined);  // undefined = cargando, null = no auth, object = logueado
  const [skipAuth, setSkipAuth] = useState(false);
  const [files, setFiles] = useState({ agentes: null, abandonadas: null, despachoInicio: null, despachoDerivacion: null, despachoCreacion: null });
  const [loaded, setLoaded] = useState([]);
  const [view, setView] = useState("upload");
  const [err, setErr] = useState(null);
  const lastSavedTurno = useRef(null);

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

  // Auto-guardar informe cuando los 5 archivos están cargados
  useEffect(() => {
    if (!hasRequiredUploads(loaded)) return;
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
      if (!f.name.toLowerCase().trim().endsWith(".csv")) { setErr(`"${f.name}" no es un CSV.`); continue; }
      let text;
      try { text = await f.text(); } catch (_) {
        text = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej;
          r.readAsText(f, "latin-1");
        });
      }
      const type = detectType(text, f.name);
      if (!type) { setErr(`No se pudo identificar "${f.name}".`); continue; }
      if (type === "agentes") {
        next.agentes = parseAgentes(text);
      } else if (type === "abandonadas") {
        next.abandonadas = parseAbandonadas(text);
      } else if (type === "despacho-inicio") {
        next.despachoInicio = parseDespacho(text, "despacho-inicio");
      } else if (type === "despacho-derivacion") {
        next.despachoDerivacion = parseDespacho(text, "despacho-derivacion");
      } else if (type === "despacho-creacion") {
        next.despachoCreacion = parseDespacho(text, "despacho-creacion");
      }
      if (!nextLoaded.includes(type)) nextLoaded.push(type);
    }
    setFiles(next);
    setLoaded(nextLoaded);
    if (nextLoaded.length > 0 && view === "upload") setView("resumen");
  }, [files, loaded, view]);

  const reset = () => { setFiles({ agentes: null, abandonadas: null, despachoInicio: null, despachoDerivacion: null, despachoCreacion: null }); setLoaded([]); setView("upload"); setErr(null); lastSavedTurno.current = null; };

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
      onSkip: () => { setSkipAuth(true); setUser(null); }
    });
  }

  const hasData = loaded.length > 0;
  const meta = files.abandonadas?.meta || files.agentes?.meta || {};
  const turnoLabel = meta.fechaDesde ? `${meta.fechaDesde} ${meta.horaDesde || ""} → ${meta.fechaHasta || ""} ${meta.horaHasta || ""}` : "";

  const menuItems = [
    { id: "upload", label: "Inicio", icon: "🏠", avail: true },
    { id: "resumen", label: "Dashboard", icon: "📊", avail: hasData },
    { id: "horas", label: "Por Hora", icon: "📞", avail: !!files.abandonadas },
    { id: "operadores", label: "Agentes", icon: "👤", avail: !!files.agentes },
    { id: "despacho", label: "Despacho", icon: "🚓", avail: !!(files.despachoInicio || files.despachoDerivacion || files.despachoCreacion) },
    { id: "mensual", label: "Mensual", icon: "📉", avail: true },
    { id: "historial", label: "Archivo", icon: "📋", avail: true },
  ];

  const sidebarVisible = view !== "upload";

  return React.createElement("div", { style: { display: "flex", minHeight: "100vh", background: C.black } },
    // SIDEBAR
    sidebarVisible && React.createElement("div", { className: "glass", style: { width: 260, position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 100, display: "flex", flexDirection: "column", padding: "32px 20px" } },
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 48, padding: "0 10px" } },
        React.createElement("div", { className: "neon-blue", style: { width: 36, height: 36, background: C.blue, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 20, color: "#fff" } }, "S"),
        React.createElement("div", { style: { display: "flex", flexDirection: "column" } },
          React.createElement("div", { style: { fontWeight: 800, fontSize: 20, color: "#fff", letterSpacing: 1, lineHeight: 1 } }, "SAE 911"),
          React.createElement("div", { style: { fontSize: 9, color: C.blue, fontWeight: 700, letterSpacing: 2, marginTop: 4 } }, "COMMAND CENTER")
        )
      ),
      React.createElement("nav", { style: { display: "flex", flexDirection: "column", gap: 10, flex: 1 } },
        menuItems.map(m => 
          m.avail && React.createElement("button", { 
            key: m.id, 
            onClick: () => setView(m.id),
            style: { 
              display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", borderRadius: 14, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, transition: "all .3s cubic-bezier(0.4, 0, 0.2, 1)",
              background: view === m.id ? "rgba(59, 130, 246, 0.15)" : "transparent",
              color: view === m.id ? "#fff" : C.gray,
              border: view === m.id ? `1px solid ${C.blue}` : "1px solid transparent",
            },
            onMouseOver: e => { if(view !== m.id) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.color = "#fff"; } },
            onMouseOut: e => { if(view !== m.id) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.gray; } }
          }, 
            React.createElement("span", { style: { fontSize: 20, filter: view === m.id ? "none" : "grayscale(1) opacity(0.5)" } }, m.icon),
            m.label
          )
        )
      ),
      user && React.createElement("div", { style: { marginTop: "auto", padding: "20px 10px", borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12 } },
        user.photoURL && React.createElement("img", { src: user.photoURL, style: { width: 36, height: 36, borderRadius: 12, border: `1px solid ${C.border}` } }),
        React.createElement("div", { style: { overflow: "hidden", flex: 1 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, user.displayName),
          React.createElement("button", { onClick: signOutUser, style: { background: "none", border: "none", color: C.blue, fontSize: 11, fontWeight: 700, padding: 0, cursor: "pointer", marginTop: 2 } }, "Cerrar Sesión")
        )
      )
    ),

    // MAIN CONTENT
    React.createElement("div", { style: { flex: 1, marginLeft: sidebarVisible ? 260 : 0, transition: "margin-left 0.4s cubic-bezier(0.4, 0, 0.2, 1)", overflow: "hidden" } },
      // HEADER BAR
      React.createElement("header", { className: "glass", style: { height: 72, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 40px", position: "sticky", top: 0, zIndex: 90 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
          !sidebarVisible && React.createElement("div", { style: { fontWeight: 900, fontSize: 22, color: "#fff", letterSpacing: 1 } }, "SAE 911"),
          sidebarVisible && React.createElement("div", { style: { fontSize: 18, fontWeight: 700, color: "#fff" } }, menuItems.find(m => m.id === view)?.label)
        ),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
          hasData && React.createElement("div", { style: { marginRight: 20, display: "flex", gap: 8 } },
            React.createElement("button", { onClick: () => window.print(), className: "neon-blue", style: { background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, color: "#fff", borderRadius: 10, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" } }, "🖨 Exportar"),
            React.createElement("button", { onClick: reset, style: { background: "transparent", border: `1px solid ${C.border}`, color: C.gray, borderRadius: 10, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" } }, "↺ Reset")
          ),
          !user && getAuth() && React.createElement("button", { onClick: handleLogin, style: { background: C.blue, color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontSize: 12, fontWeight: 800, cursor: "pointer", boxShadow: "0 4px 15px rgba(59, 130, 246, 0.3)" } }, "Acceder con Google")
        )
      ),

      React.createElement("main", { style: { padding: sidebarVisible ? "40px" : "80px 40px", maxWidth: 1600, margin: "0 auto" } },
        err && React.createElement("div", { className: "glass", style: { borderLeft: `4px solid ${C.red}`, borderRadius: 12, padding: "20px 24px", color: C.red, fontSize: 14, marginBottom: 32, fontWeight: 600 } }, `⚠ ${err}`),

        view === "upload" && React.createElement("div", { style: { textAlign: "center", animation: "fadeIn 0.8s ease-out" } },
          React.createElement("img", { src: "src/img/logo_geston.png", alt: "Logo Geston", style: { height: 120, marginBottom: 40, filter: "brightness(0) invert(1) drop-shadow(0 0 20px rgba(59,130,246,0.2))" } }),
          React.createElement("div", { style: { fontSize: 56, fontWeight: 900, marginBottom: 16, color: "#fff", letterSpacing: -1 } }, "Quality Control"),
          React.createElement("div", { style: { fontSize: 18, color: C.gray, marginBottom: 60, maxWidth: 600, margin: "0 auto 60px" } }, "Análisis avanzado de datos operativos para la toma de decisiones estratégicas."),
          
          React.createElement("div", { style: { maxWidth: 800, margin: "0 auto" } }, 
             React.createElement(UploadZone, { onFiles: handleFiles, loaded })
          ),
          
          React.createElement("div", { style: { marginTop: 60, display: "flex", justifyContent: "center", gap: 24 } },
            React.createElement("button", { 
              onClick: () => setView("mensual"),
              className: "neon-blue",
              style: { background: C.blue, color: "#fff", border: "none", borderRadius: 16, padding: "20px 40px", fontSize: 18, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", gap: 14, transition: "transform 0.2s" }
            }, 
              React.createElement("span", { style: { fontSize: 24 } }, "📈"),
              "Análisis Mensual"
            ),
            React.createElement("button", { 
              onClick: () => setView("historial"),
              style: { background: "rgba(255,255,255,0.05)", color: "#fff", border: `2px solid ${C.border}`, borderRadius: 16, padding: "20px 40px", fontSize: 18, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }
             }, 
               React.createElement("span", { style: { fontSize: 24 } }, "📋"),
               "Registros Históricos"
             )
          )
        ),

        view === "resumen" && React.createElement(ViewResumen, { data: files }),
        view === "horas" && React.createElement(ViewHoras, { data: files }),
        view === "operadores" && React.createElement(ViewOperadores, { data: files }),
        view === "despacho" && React.createElement(ViewDespacho, { data: files }),
        view === "mensual" && React.createElement(ViewMensual, { user }),
        view === "historial" && React.createElement(ViewHistorial, { user })
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
