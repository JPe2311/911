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
    navy: "#0f2444",
    blue: "#1B3A6B",
    mid: "#2E5FA3",
    light: "#D6E4F0",
    green: "#16a34a",
    greenBg: "#D1FAE5",
    red: "#dc2626",
    redBg: "#FEE2E2",
    orange: "#ea580c",
    orBg: "#FFEDD5",
    yellow: "#d97706",
    ylBg: "#FEF3C7",
    gray: "#64748b",
    border: "#e2e8f0",
    bg: "#f0f4f8",
    card: "#ffffff",
};

const MONTH_NAMES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];


// ════════════════════════════════════════════════════════════════════════════
//  PARSERS
// ════════════════════════════════════════════════════════════════════════════
function parseTimeToSeconds(str) {
    if (!str || typeof str !== "string") return 0;
    str = str.trim().toLowerCase();
    let total = 0;

    // Check for HH:MM:SS or MM:SS format
    const parts = str.split(":").map(p => parseInt(p, 10));
    if (parts.length === 3 && parts.every(p => !isNaN(p))) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2 && parts.every(p => !isNaN(p))) {
        return parts[0] * 60 + parts[1];
    }

    // Check for "X min Y seg" format
    const m = str.match(/(\d+)\s*m/i);
    const s = str.match(/(\d+)\s*s/i);
    if (m) total += parseInt(m[1], 10) * 60;
    if (s) total += parseInt(s[1], 10);

    // If nothing matched, try parsing as raw number
    if (total === 0 && !isNaN(parseInt(str))) total = parseInt(str);

    return total;
}

function filterDetailsByTurno(detalles, turno) {
    if (!detalles || !Array.isArray(detalles)) return [];
    const valid = detalles.filter(d => d !== null && d !== undefined);
    if (!turno || turno === "all") return valid;
    if (turno === "dia") return valid.filter(r => r.hour >= 7 && r.hour < 19);
    if (turno === "noche") return valid.filter(r => r.hour >= 19 || r.hour < 7);
    return valid;
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
        ofrecidas: 1,
        contestadas: 2,
        abandonadas: 3,
        aht: 4, 
        tiempoConectado: 5,
        tiempoAvisando: 6,
        tiempoAusente: 12,
        vozPreparada: 7,
        vozNoPreparada: 8,
        disponibilidad: 11,
    };
    let headerFound = false;

    for (let i = 0; i < lines.length; i++) {
        const cols = parseSemicolon(lines[i]);
        if (!cols.length || cols.length < 2) continue;
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
                if (/en servicio|promedio.*atenci|aht|tmo/i.test(key)) idx.aht = j;
                if (/voz preparada|tiempo de atenci/i.test(key)) {
                    // La primera columna de "Voz preparada" suele ser el tiempo, la segunda el %
                    if (idx.vozPreparada === undefined || idx.vozPreparada === 7) idx.vozPreparada = j;
                    else idx.pctVozPrep = j;
                }
                if (/voz no preparada/i.test(key)) {
                    if (idx.vozNoPreparada === undefined || idx.vozNoPreparada === 8) idx.vozNoPreparada = j;
                    else idx.pctVozNoPrep = j;
                }
                
                // Tiempos específicos (distinguir T. Conectado de T. Avisando)
                if (/t\.?\s*conect|conectado/i.test(key)) idx.tiempoConectado = j;
                if (/t\.?\s*avis|avisando/i.test(key)) idx.tiempoAvisando = j;
                if (/t\.?\s*ausent|ausente/i.test(key)) idx.tiempoAusente = j;
                
                if (/disponib.*%/i.test(key)) idx.disponibilidad = j;
                else if (key.includes("disponib") && (idx.disponibilidad === undefined || idx.disponibilidad === 11)) idx.disponibilidad = j;
            });
            continue;
        }

        // Validación de fila de agente: debe tener nombre y la columna de ofrecidas debe ser un número
        if (headerFound && first && first !== "Agente" && !isNaN(parseInt(cols[idx.ofrecidas]))) {
            const nombre = first;
            if (nombre === "Total" || nombre === "Promedio") continue;
            const vPrepSec = parseTimeToSeconds(cols[idx.vozPreparada]);
            const vNoPrepSec = parseTimeToSeconds(cols[idx.vozNoPreparada]);
            const ahtSec = parseTimeToSeconds(cols[idx.aht]);
            const totalConectSec = parseTimeToSeconds(cols[idx.tiempoConectado]);

            // Preferir el porcentaje directo de la columna si existe
            let pctVoz = 0;
            if (idx.pctVozPrep !== undefined && cols[idx.pctVozPrep]) {
                pctVoz = parseFloat((cols[idx.pctVozPrep] || "0").replace(",", ".")) || 0;
            } else {
                // Denominador: Tiempo Conectado es más real que la suma de estados parciales
                const denom = totalConectSec > 0 ? totalConectSec : (vPrepSec + vNoPrepSec);
                pctVoz = denom > 0 ? parseFloat(((vPrepSec / denom) * 100).toFixed(1)) : 0;
            }

            agents.push({
                nombre,
                ofrecidas: parseInt(cols[idx.ofrecidas]) || 0,
                contestadas: parseInt(cols[idx.contestadas]) || 0,
                abandonadas: parseInt(cols[idx.abandonadas]) || 0,
                aht: ahtSec,
                tiempoConectado: cols[idx.tiempoConectado] || "0:00:00",
                tiempoAvisando: cols[idx.tiempoAvisando] || "0:00:00",
                tiempoAusente: cols[idx.tiempoAusente] || "0:00:00",
                tiempoManejo: ahtSec, // Usamos AHT para el "Promedio de atención"
                totalPreparado: vPrepSec,
                totalNoPreparado: vNoPrepSec,
                pctVozPreparada: pctVoz,
                pctAbandonoCabina: (parseInt(cols[idx.ofrecidas]) > 0) ? parseFloat(((parseInt(cols[idx.abandonadas]) / parseInt(cols[idx.ofrecidas])) * 100).toFixed(1)) : 0,
                disponibilidad: parseFloat((cols[idx.disponibilidad] || "0").replace(",", ".")) || 0,
            });
            continue;
        }

        if (first === "Total" && cols.length > 3) {
            meta.totalOfrecidas = parseInt(cols[idx.ofrecidas]) || 0;
            meta.totalContestadas = parseInt(cols[idx.contestadas]) || 0;
            meta.totalAbanCabina = parseInt(cols[idx.abandonadas]) || 0;
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


// ─── OPERATOR PERFORMANCE HELPERS ───────────────────────────────────────────
function normalizeName(name) {
    if (!name || typeof name !== "string") return "";
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim().replace(/\s+/g, " ");
}

function parseNominaCSV(raw) {
    const lines = parseLines(raw);
    const result = [];
    lines.forEach((l, i) => {
        if (!l.trim() || i === 0 && l.toUpperCase().includes("JERARQUIA")) return;
        const cols = l.split(";");
        if (cols.length < 3) return;
        result.push({
            jerarquia: cols[0]?.trim(),
            name: cols[1]?.trim(),
            normName: normalizeName(cols[1]),
            turno: cols[2]?.trim()
        });
    });
    return result;
}

function parseOperadoresMensualCSV(raw, month, year) {
    const lines = parseLines(raw);
    const result = [];
    const idx = { name: 0, o: 1, c: 2, ab: 3, aht: 5, connected: 6, vPrepTime: 7, vNoPrepTime: 8, vPrepPct: 9 };

    lines.forEach((l, i) => {
        if (!l.trim()) return;
        const cols = l.split(";");
        if (cols.length < 9) return;

        // Detectar cabecera para ajustar índices si es necesario
        if (cols.some(c => /agente/i.test(c)) && cols.some(c => /ofrec/i.test(c))) {
            cols.forEach((h, j) => {
                const head = (h || "").toLowerCase();
                if (head.includes("agente")) idx.name = j;
                if (head.includes("ofrec")) idx.o = j;
                if (head.includes("contest")) idx.c = j;
                if (head.includes("aband")) idx.ab = j;
                if (/en servicio|promedio.*atenci/i.test(head)) idx.aht = j;
                if (/conectado/i.test(head)) idx.connected = j;
                if (/voz preparada/i.test(head)) {
                    if (idx.vPrepTime === undefined || idx.vPrepTime === 7) idx.vPrepTime = j;
                    else idx.vPrepPct = j;
                }
            });
            return;
        }

        const name = cols[idx.name]?.trim();
        if (!name || name.toLowerCase() === "total" || name.toLowerCase() === "promedio" || name.toLowerCase() === "agente") return;

        const ahtSec = parseTimeToSeconds(cols[idx.aht]);
        const vPrepPct = idx.vPrepPct !== undefined ? (parseFloat((cols[idx.vPrepPct] || "0").replace(",", ".")) || 0) : 0;

        result.push({
            name,
            normName: normalizeName(name),
            month,
            year,
            o: parseInt(cols[idx.o]) || 0,
            c: parseInt(cols[idx.c]) || 0,
            ab: parseInt(cols[idx.ab]) || 0,
            // 'manejo' es el AHT Promedio para los KPIs
            manejo: ahtSec,
            totalConectado: parseTimeToSeconds(cols[idx.connected]),
            totalPreparado: parseTimeToSeconds(cols[idx.vPrepTime]),
            pctVozPreparada: vPrepPct,
            // Compatibilidad
            pctProd: vPrepPct,
        });
    });
    return result;
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
            agentes: agentesData || null,
            abandonadas: abandonadasData || null,
            despachoInicio,
            despachoDerivacion,
            despachoCreacion,
        },
    };

    try {
        const { addDoc, collection, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const docRef = await addDoc(collection(db, "informes"), {
            ...report,
            userDisplayName,
            userEmail,
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
        const { collection, query, orderBy, limit, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        // Carga últimos 45 reportes para optimizar lecturas de Firebase
        const q = query(
            collection(db, "informes"),
            orderBy("fechaGuardado", "desc"),
            limit(45)
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

// ─── FIRESTORE: STAFF & PERFORMANCE ─────────────────────────────────────────

async function saveStaffToFirestore(list) {
    const db = getDB();
    if (!db) return;
    const { doc, setDoc, collection } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const staffRef = collection(db, "staff");
    for (const s of list) {
        await setDoc(doc(staffRef, s.normName), s, { merge: true });
    }
    return true;
}

async function updateStaffTurno(normName, newTurno) {
    const db = getDB();
    if (!db) return;
    const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await updateDoc(doc(db, "staff", normName), { turno: newTurno });
}

async function updateStaffGroup(normName, newGroup) {
    const db = getDB();
    if (!db) return;
    const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    await setDoc(doc(db, "staff", normName), { grupo: newGroup }, { merge: true });
}

async function getGroups() {
    const db = getDB();
    if (!db) return [];
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const snap = await getDocs(collection(db, "staff"));
    const groups = new Set();
    snap.docs.forEach(d => { const g = d.data().grupo; if (g) groups.add(g); });
    return Array.from(groups).sort();
}

async function saveOperatorPerformance(list, month, year) {
    const db = getDB();
    if (!db) return;
    const { doc, setDoc, query, where, getDocs, collection, writeBatch } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const perfRef = collection(db, "operator_performance");

    try {
        // 1. Limpiar datos previos del mismo mes/año para evitar "fantasmas"
        const q = query(perfRef, where("month", "==", month), where("year", "==", year));
        const snap = await getDocs(q);
        const batch = writeBatch(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();

        // 2. Guardar nuevos datos
        const saveBatch = writeBatch(db);
        for (const p of list) {
            const id = `${p.normName}_${month}_${year}`;
            saveBatch.set(doc(perfRef, id), p); // Sin merge: true porque ya limpiamos
        }
        await saveBatch.commit();
        return true;
    } catch (e) {
        console.error("Error saving performance:", e);
        return false;
    }
}

async function getStaffList() {
    const db = getDB();
    if (!db) return [];
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const snap = await getDocs(collection(db, "staff"));
    return snap.docs.map(d => d.data());
}

async function getOperatorPerformance(month, year) {
    const db = getDB();
    if (!db) return [];
    const { collection, getDocs, query, where } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    let q = collection(db, "operator_performance");
    if (month && month !== "all") q = query(q, where("month", "==", month));
    if (year && year !== "all") q = query(q, where("year", "==", year));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
}

async function getOperatorHistory(normName, year) {
    const db = getDB();
    if (!db) return [];
    const { collection, getDocs, query, where, orderBy } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const q = query(
        collection(db, "operator_performance"),
        where("normName", "==", normName),
        where("year", "==", year),
        orderBy("month", "asc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
}

async function getUniqueOperators() {
    const db = getDB();
    if (!db) return [];
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const snap = await getDocs(collection(db, "operator_performance"));
    const map = new Map();
    snap.docs.forEach(d => {
        const data = d.data();
        if (!map.has(data.normName)) {
            map.set(data.normName, { normName: data.normName, name: data.name });
        }
    });
    return Array.from(map.values()).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

async function getGroupAverages(year) {
    const db = getDB();
    if (!db) return {};
    const { collection, getDocs, query, where } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const q = query(collection(db, "operator_performance"), where("year", "==", year));
    const snap = await getDocs(q);
    const months = {}; // { "01": { sumC: 0, sumProd: 0, count: 0, ... } }

    snap.docs.forEach(d => {
        const p = d.data();
        const m = p.month;
        if (!months[m]) months[m] = { c: 0, o: 0, ab: 0, prod: 0, avisando: 0, manejo: 0, count: 0 };
        months[m].c += p.c;
        months[m].o += p.o;
        months[m].ab += p.ab;
        months[m].prod += p.pctProd;
        months[m].avisando += p.avgAvisando;
        months[m].manejo += p.avgManejo;
        months[m].count++;
    });

    const result = {};
    Object.keys(months).forEach(m => {
        const d = months[m];
        result[m] = {
            avgC: Math.round(d.c / d.count),
            avgO: Math.round(d.o / d.count),
            avgAb: Math.round(d.ab / d.count),
            avgProd: (d.prod / d.count).toFixed(1),
            avgAvisando: Math.round(d.avisando / d.count),
            avgManejo: Math.round(d.manejo / d.count)
        };
    });
    return result;
}

// ─── Hallazgos Globales (Scanning Historical Data) ─────────────────────
async function getGlobalInsights(year = 2026) {
    try {
        const db = getDB();
        if (!db) return [];
        const { collection, getDocs, query, where } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

        const perfRef = collection(db, "operator_performance");
        const q = query(perfRef, where("year", "==", year));
        const snap = await getDocs(q);
        const data = snap.docs.map(d => d.data());
        if (!data.length) return [];

        const insights = [];
        const monthNum = new Date().getMonth() + 1;

        // 1. Tendencia de Abandono
        const currentMonthData = data.filter(d => d.month === monthNum);
        const prevMonthData = data.filter(d => d.month === monthNum - 1);

        const getAvgAb = (arr) => arr.length ? arr.reduce((s, v) => s + (v.ab || 0), 0) / arr.length : null;
        const curAvg = getAvgAb(currentMonthData);
        const prevAvg = getAvgAb(prevMonthData);

        if (curAvg !== null && prevAvg !== null) {
            const diff = curAvg - prevAvg;
            if (Math.abs(diff) > 0.5) {
                insights.push({
                    type: diff > 0 ? "red" : "green",
                    icon: diff > 0 ? "📈" : "📉",
                    title: "Tendencia de Abandono",
                    msg: `El abandono general ${diff > 0 ? "subió" : "bajó"} un ${Math.abs(diff).toFixed(1)}% respecto al mes pasado.`,
                    value: `${curAvg.toFixed(1)}%`
                });
            }
        }

        // 2. TMO Promedio
        const avgTmo = data.reduce((s, v) => s + (v.avgManejo || 0), 0) / data.length;
        if (avgTmo > 180) {
            insights.push({
                type: "orange",
                icon: "⏱️",
                title: "Alerta de TMO",
                msg: "El TMO promedio anual supera los 3 minutos. Se recomienda revisar protocolos de atención.",
                value: fmtSeconds(avgTmo)
            });
        }

        // 3. Liderazgo de Célula
        const groups = [...new Set(data.map(d => d.groupName))].filter(Boolean);
        const groupStats = groups.map(g => {
            const gd = data.filter(d => d.groupName === g);
            return { name: g, ab: getAvgAb(gd) };
        });

        const topGroup = [...groupStats].sort((a, b) => a.ab - b.ab)[0];
        if (topGroup) {
            insights.push({
                type: "blue",
                icon: "🏆",
                title: "Célula Destacada",
                msg: `El grupo "${topGroup.name}" mantiene la tasa de abandono más baja del año (${topGroup.ab.toFixed(1)}%).`,
                value: topGroup.name
            });
        }

        // 4. Operador de Mayor Productividad
        const ops = [...new Set(data.map(d => d.normName))];
        const opStats = ops.map(id => {
            const od = data.filter(d => d.normName === id);
            const totalC = od.reduce((s, v) => s + (v.c || 0), 0);
            const totalH = od.reduce((s, v) => s + (v.totalConectado || 0), 0) / 3600;
            return { name: od[0]?.name, prod: totalH > 1 ? totalC / totalH : 0 };
        }).filter(o => o.prod > 0);

        const bestOp = [...opStats].sort((a, b) => b.prod - a.prod)[0];
        if (bestOp) {
            insights.push({
                type: "green",
                icon: "⚡",
                title: "Máxima Productividad",
                msg: `El operador "${bestOp.name}" lidera el año con un promedio de ${bestOp.prod.toFixed(1)} atendidas/hora.`,
                value: bestOp.prod.toFixed(1)
            });
        }

        // 5. Volumen
        const totalCalls = data.reduce((s, v) => s + (v.c || 0), 0);
        insights.push({
            type: "blue",
            icon: "📞",
            title: "Volumen Anual",
            msg: `Se han procesado ${totalCalls.toLocaleString("es-AR")} llamadas en lo que va del año ${year}.`,
            value: totalCalls.toLocaleString("es-AR")
        });

        return insights;
    } catch (e) {
        console.error("Error global insights:", e);
        return [];
    }
}

async function getPerformanceByGroup(month, year) {
    const [perf, staff] = await Promise.all([
        getOperatorPerformance(month, year),
        getStaffList()
    ]);

    const staffMap = {};
    staff.forEach(s => { staffMap[s.normName] = s; });

    const groups = {};
    perf.forEach(p => {
        const group = staffMap[p.normName]?.grupo || "Sin Grupo";
        if (!groups[group]) {
            groups[group] = {
                group,
                o: 0, c: 0, ab: 0,
                sumAvisando: 0, sumManejo: 0,
                countC: 0, ops: 0
            };
        }
        groups[group].o += p.o;
        groups[group].c += p.c;
        groups[group].ab += p.ab;
        if (p.c > 0) {
            groups[group].sumAvisando += (p.avgAvisando || 0) * p.c;
            groups[group].sumManejo += (p.avgManejo || 0) * p.c;
            groups[group].countC += p.c;
        }
        groups[group].ops += 1;
    });

    return Object.values(groups).map(g => ({
        ...g,
        pctAb: g.o ? (g.ab / g.o * 100) : 0,
        avgAvisando: g.countC ? Math.round(g.sumAvisando / g.countC) : 0,
        avgManejo: g.countC ? Math.round(g.sumManejo / g.countC) : 0
    })).sort((a, b) => b.c - a.c);
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
                agentes: agentesData || null,
                abandonadas: abandonadasData || null,
                despachoInicio: files?.despachoInicio || [],
                despachoDerivacion: files?.despachoDerivacion || [],
                despachoCreacion: files?.despachoCreacion || [],
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

function ChartScatter({ id, data, options, onPointClick }) {
    const ref = useRef(null); const chartRef = useRef(null);
    useEffect(() => {
        if (!ref.current) return;
        if (chartRef.current) chartRef.current.destroy();
        const finalOptions = onPointClick ? {
            ...options,
            onClick: (event, elements) => {
                if (elements && elements.length > 0) {
                    onPointClick(elements[0].index, elements[0].datasetIndex);
                }
            },
            onHover: (event, elements) => {
                event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            }
        } : options;
        chartRef.current = new Chart(ref.current, { type: "scatter", data, options: finalOptions });
        return () => { if (chartRef.current) chartRef.current.destroy(); };
    }, [JSON.stringify(data)]);
    return React.createElement("canvas", { ref, id });
}

// ════════════════════════════════════════════════════════════════════════════
//  UI PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════
const Card = ({ children, style = {}, ...props }) =>
    React.createElement("div", { className: "card", style: { background: C.card, borderRadius: 14, padding: 24, border: `1px solid ${C.border}`, boxShadow: "0 2px 8px rgba(0,0,0,0.05)", ...style }, ...props }, children);

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
// ════════════════════════════════════════════════════════════════════════════
//  VIEW: REPORTE HISTORIAL (Executive Summary)
// ════════════════════════════════════════════════════════════════════════════
function ViewReporteHistorial({ data }) {
    const { abandonadas: ab, agentes: ag, despachoInicio: dpI, despachoDerivacion: dpD, despachoCreacion: dpC } = data;
    const [groupFilter, setGroupFilter] = useState("all");
    const [staffMap, setStaffMap] = useState({});

    useEffect(() => {
        getStaffList().then(list => {
            const map = {};
            list.forEach(s => { map[s.normName] = s; });
            setStaffMap(map);
        });
    }, []);

    const groups = useMemo(() => {
        const s = new Set();
        Object.values(staffMap).forEach(st => { if (st.grupo) s.add(st.grupo); });
        return Array.from(s).sort();
    }, [staffMap]);

    const agentsRanking = useMemo(() => {
        if (!ag?.agents?.length) return { top: [], bot: [] };
        let main = ag.agents.filter(a => a.ofrecidas >= 20);

        if (groupFilter !== "all") {
            main = main.filter(a => {
                const norm = normalizeName(a.nombre);
                return staffMap[norm]?.grupo === groupFilter;
            });
        }

        main = main.sort((a, b) => b.contestadas - a.contestadas);
        return {
            top: main.slice(0, 5),
            bot: [...main].reverse().slice(0, 5),
            total: main.length,
            avgManejo: Math.round(main.reduce((s, a) => s + (a.tiempoManejo || 0), 0) / (main.length || 1)),
            avgPctVoz: (main.reduce((s, a) => s + (a.pctVozPreparada || 0), 0) / (main.length || 1)).toFixed(1)
        };
    }, [ag, groupFilter, staffMap]);

    const dp = dpI?.length ? dpI : (dpD?.length ? dpD : dpC);
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
                { label: "Atendidas", data: ivs.map(i => i.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6 },
                { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 6 },
            ]
        };
    }, [ab]);

    const abandonDonut = useMemo(() => {
        if (!tot.abandonadas) return null;
        return { labels: ["En Cola", "En Cabina"], datasets: [{ data: [tot.cola || 0, tot.cabina || 0], backgroundColor: ["#ea580c", "#eab308"], borderWidth: 0 }] };
    }, [tot]);

    const agentesData = useMemo(() => {
        if (!ag?.agents?.length) return null;
        const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a, b) => b.contestadas - a.contestadas).slice(0, 15);
        return { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Contestadas", data: main.map(a => a.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6 }] };
    }, [ag]);

    const despData = useMemo(() => {
        if (!dp?.length) return null;
        const sorted = [...dp].sort((a, b) => (a.tiempoSec || 0) - (b.tiempoSec || 0));
        return {
            labels: sorted.map(d => (d.nombre || "").replace("DISTRITO ", "D.")),
            datasets: [{ label: "Seg. promedio", data: sorted.map(d => d.tiempoSec || 0), borderColor: C.mid, backgroundColor: "rgba(46,95,163,0.10)", fill: true, tension: 0.3 }]
        };
    }, [dp]);

    const gaugeData = useMemo(() => {
        const avg = arr => Array.isArray(arr) && arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
        const tI = avg((dpI || []).map(d => d.tiempoSec || 0));
        const tD = avg((dpD || []).map(d => d.tiempoSec || 0));
        const tC = avg((dpC || []).map(d => d.tiempoSec || 0));
        return { tiempoInicioDespacho: tI, tiempoDerivacionInicio: tD, tiempoCreacionDespacho: tC };
    }, [dpI, dpD, dpC]);

    const donutOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { font: { size: 10 } } } }, cutout: "65%" };
    const turnoLabel = meta.fechaDesde && meta.fechaHasta ? `${meta.fechaDesde} ${meta.horaDesde || ""} → ${meta.fechaHasta} ${meta.horaHasta || ""}` : "Período cargado";

    return React.createElement("div", { className: "animate-fade" },
        // --- HEADER HISTORIAL ---
        React.createElement("div", { style: { background: `linear-gradient(135deg, ${C.navy} 0%, ${C.blue} 100%)`, borderRadius: 16, padding: "32px", marginBottom: 24, color: "#fff", boxShadow: "0 10px 30px rgba(0,0,0,0.1)", display: "flex", justifyContent: "space-between", alignItems: "center" } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color: "#93c5fd", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 } }, "Archivo de Reportes Históricos — SAE 911"),
                React.createElement("h1", { style: { fontSize: 30, fontWeight: 950, margin: 0, letterSpacing: "-0.5px" } }, "Reporte de Gestión Finalizado"),
                React.createElement("div", { style: { fontSize: 15, color: "#cbd5e1", marginTop: 6, fontWeight: 500 } }, `🗓 ${turnoLabel}`)
            ),
            React.createElement("div", { style: { textAlign: "right" } },
                React.createElement("div", { style: { fontSize: 13, fontWeight: 800, color: "#93c5fd" } }, data.usuario ? `Autor: ${data.usuario}` : "Generado Automáticamente")
            )
        ),

        // --- KPIs PRINCIPALES ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 } },
            React.createElement(StatKpi, { label: "Total Recibidas", value: tot.ofrecidas?.toLocaleString("es-AR") || "0", sub: "Llamadas totales", accent: C.blue, icon: "📞" }),
            React.createElement(StatKpi, { label: "Llamadas Perdidas", value: tot.abandonadas?.toLocaleString("es-AR") || "0", sub: "Global fuera de meta", accent: C.red, icon: "📉" }),
            React.createElement(StatKpi, { label: "% de Abandono", value: `${pctAband.toFixed(1)}%`, sub: "Indicador crítico", accent: pctAband > 15 ? C.red : (pctAband > 8 ? C.orange : C.green), icon: "⚠️" }),
            React.createElement(StatKpi, { label: "TMO Promedio", value: fmtSeconds(agentsRanking.avgManejo), sub: "Tiempo de atención", accent: C.mid, icon: "⏱️" })
        ),

        // --- BLOQUE DE NUMÉRICA Y SLA ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 } },
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 16, textTransform: "uppercase" } }, "📊 Detalle Numérico del Informe"),
                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
                    [
                        { label: "Atendidas", val: tot.contestadas, c: C.green },
                        { label: "Abandonadas", val: tot.abandonadas, c: C.red },
                        { label: "En Cola", val: tot.cola, c: C.orange },
                        { label: "En Cabina", val: tot.cabina, c: C.yellow }
                    ].map(n => (
                        React.createElement("div", { key: n.label, style: { padding: "12px", background: "#f8fafc", borderRadius: 10, borderLeft: `4px solid ${n.c}` } },
                            React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase" } }, n.label),
                            React.createElement("div", { style: { fontSize: 20, fontWeight: 900, color: C.navy } }, n.val?.toLocaleString("es-AR") || "0")
                        )
                    ))
                )
            ),
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 16, textTransform: "uppercase" } }, "⏱️ Tiempos de Respuesta Registrados"),
                React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
                    [
                        { label: "Creación → Despacho", val: gaugeData.tiempoCreacionDespacho, meta: 120 },
                        { label: "Derivación → Inicio", val: gaugeData.tiempoDerivacionInicio, meta: 30 },
                        { label: "Inicio → Despacho", val: gaugeData.tiempoInicioDespacho, meta: 120 }
                    ].map(t => (
                        React.createElement("div", { key: t.label, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: "#f1f5f9", borderRadius: 12 } },
                            React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color: C.navy } }, t.label),
                            React.createElement("div", { style: { fontSize: 20, fontWeight: 950, color: getGaugeColor(t.val, t.meta) } }, fmtSeconds(t.val))
                        )
                    ))
                )
            )
        ),

        // --- GRÁFICOS INTERMEDIOS ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20, marginBottom: 20 } },
            horaData && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "📈 Comportamiento Horario"),
                React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "hist-master-hora", data: horaData, options: { responsive: true, maintainAspectRatio: false } }))
            ),
            abandonDonut && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "🔴 Composición de Abandono"),
                React.createElement("div", { style: { height: 180 } }, React.createElement(ChartDoughnut, { id: "hist-master-abandono", data: abandonDonut, options: donutOpts })),
                React.createElement("div", { style: { marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 } },
                    React.createElement(Badge, { label: `Cola: ${tot.cola}`, color: C.orange, bg: C.orBg }),
                    React.createElement(Badge, { label: `Cabina: ${tot.cabina}`, color: C.yellow, bg: C.ylBg })
                )
            )
        ),

        // --- RANKINGS Y DESEMPEÑO ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.8fr 1.2fr", gap: 20, marginBottom: 20 } },
            agentesData && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "👤 Mejores Rendimientos del Turno"),
                React.createElement("div", { style: { height: 350 } }, React.createElement(ChartBar, { id: "hist-master-agentes", data: agentesData, options: { responsive: true, maintainAspectRatio: false, indexAxis: "y" } }))
            ),
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 950, fontSize: 13, color: C.navy, textTransform: "uppercase", paddingBottom: 12, borderBottom: `1px solid ${C.border}`, marginBottom: 20 } }, "🏆 Rankings del Reporte"),
                React.createElement("div", { style: { marginBottom: 30 } },
                    React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: C.green, marginBottom: 12 } }, "🥇 MEJOR DESEMPEÑO"),
                    agentsRanking.top.map((a, i) => React.createElement("div", { key: a.nombre, style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
                        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                            React.createElement("div", { style: { width: 24, height: 24, borderRadius: "50%", background: C.green, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900 } }, i + 1),
                            React.createElement("span", { style: { fontSize: 12, fontWeight: 700, color: C.navy } }, a.nombre.split(",")[0])
                        ),
                        React.createElement("div", { style: { textAlign: "right", fontWeight: 900, fontSize: 13, color: C.navy } }, a.contestadas)
                    ))
                ),
                React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: C.red, marginBottom: 12 } }, "⚠️ MENOR ACTIVIDAD"),
                    agentsRanking.bot.map((a, i) => React.createElement("div", { key: a.nombre, style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
                        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                            React.createElement("div", { style: { width: 24, height: 24, borderRadius: "50%", background: "#fee2e2", color: C.red, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900 } }, agentsRanking.total - i),
                            React.createElement("span", { style: { fontSize: 12, fontWeight: 700, color: C.gray } }, a.nombre.split(",")[0])
                        ),
                        React.createElement("div", { style: { textAlign: "right", fontWeight: 900, fontSize: 13, color: C.navy } }, a.contestadas)
                    ))
                )
            )
        ),

        // --- DISTRITOS ---
        despData && React.createElement(Card, { style: { marginBottom: 24 } },
            React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "🚓 Tiempos de Despacho Registrados por Distrito"),
            React.createElement("div", { style: { height: 250 } }, React.createElement(ChartLine, { id: "hist-master-despacho", data: despData, options: { responsive: true, maintainAspectRatio: false } }))
        ),

        React.createElement(AutoAlertas, { data })
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: RESUMEN (Full Dashboard)
// ════════════════════════════════════════════════════════════════════════════
function ViewResumen({ data }) {
    const { abandonadas: ab, agentes: ag, despachoInicio: dpI, despachoDerivacion: dpD, despachoCreacion: dpC } = data;
    const [groupFilter, setGroupFilter] = useState("all");
    const [staffMap, setStaffMap] = useState({});

    useEffect(() => {
        getStaffList().then(list => {
            const map = {};
            list.forEach(s => { map[s.normName] = s; });
            setStaffMap(map);
        });
    }, []);

    const groups = useMemo(() => {
        const s = new Set();
        Object.values(staffMap).forEach(st => { if (st.grupo) s.add(st.grupo); });
        return Array.from(s).sort();
    }, [staffMap]);

    const agentsRanking = useMemo(() => {
        if (!ag?.agents?.length) return { top: [], bot: [] };
        let main = ag.agents.filter(a => a.ofrecidas >= 20);

        if (groupFilter !== "all") {
            main = main.filter(a => {
                const norm = normalizeName(a.nombre);
                return staffMap[norm]?.grupo === groupFilter;
            });
        }

        main = main.sort((a, b) => b.contestadas - a.contestadas);
        return {
            top: main.slice(0, 5),
            bot: [...main].reverse().slice(0, 5),
            total: main.length,
            avgManejo: Math.round(main.reduce((s, a) => s + (a.tiempoManejo || 0), 0) / (main.length || 1)),
            avgPctVoz: (main.reduce((s, a) => s + (a.pctVozPreparada || 0), 0) / (main.length || 1)).toFixed(1)
        };
    }, [ag, groupFilter, staffMap]);

    const dp = dpI?.length ? dpI : (dpD?.length ? dpD : dpC);
    const tot = ab?.totals || {};
    const pctAtend = tot.ofrecidas ? ((tot.contestadas / tot.ofrecidas) * 100) : 0;
    const pctAband = tot.ofrecidas ? ((tot.abandonadas / tot.ofrecidas) * 100) : 0;
    const pctCola = tot.ofrecidas ? ((tot.cola / tot.ofrecidas) * 100) : 0;
    const meta = ab?.meta || ag?.meta || {};

    const horaData = useMemo(() => {
        if (!ab?.intervals?.length) return null;
        const ivs = ab.intervals;
        return {
            labels: ivs.map(i => i.hora),
            datasets: [
                { label: "Atendidas", data: ivs.map(i => i.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6, order: 1 },
                { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 6, order: 1 },
            ]
        };
    }, [ab]);

    const abandonDonut = useMemo(() => {
        if (!tot.abandonadas) return null;
        return { labels: ["En Cola", "En Cabina"], datasets: [{ data: [tot.cola || 0, tot.cabina || 0], backgroundColor: ["#ea580c", "#eab308"], borderWidth: 0, hoverOffset: 4 }] };
    }, [tot]);

    const agentesData = useMemo(() => {
        if (!ag?.agents?.length) return null;
        const main = ag.agents.filter(a => a.ofrecidas >= 30).sort((a, b) => b.contestadas - a.contestadas).slice(0, 15);
        return { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Contestadas", data: main.map(a => a.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6 }, { label: "Abandonadas", data: main.map(a => a.abandonadas), backgroundColor: "rgba(220,38,38,0.7)", borderRadius: 6 }] };
    }, [ag]);

    const despData = useMemo(() => {
        if (!dp?.length) return null;
        const sorted = [...dp].sort((a, b) => (a.tiempoSec || 0) - (b.tiempoSec || 0));
        return {
            labels: sorted.map(d => (d.nombre || "").replace("DISTRITO ", "D.")),
            datasets: [{ label: "Seg. promedio", data: sorted.map(d => d.tiempoSec || 0), borderColor: C.mid, backgroundColor: "rgba(46,95,163,0.10)", fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: sorted.map(d => (d.tiempoSec || 0) > 200 ? C.red : (d.tiempoSec || 0) < 40 ? C.green : C.mid) }]
        };
    }, [dp]);

    const gaugeData = useMemo(() => {
        const avg = arr => Array.isArray(arr) && arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
        const tI = avg((dpI || []).map(d => d.tiempoSec || 0));
        const tD = avg((dpD || []).map(d => d.tiempoSec || 0));
        const tC = avg((dpC || []).map(d => d.tiempoSec || 0));
        return { tiempoInicioDespacho: tI, tiempoDerivacionInicio: tD, tiempoCreacionDespacho: tC };
    }, [dpI, dpD, dpC]);

    const donutOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { font: { size: 10 }, padding: 10 } } }, cutout: "65%" };
    const turnoLabel = meta.fechaDesde && meta.fechaHasta ? `${meta.fechaDesde} ${meta.horaDesde || ""} → ${meta.fechaHasta} ${meta.horaHasta || ""}` : "Período cargado";

    return React.createElement("div", { className: "animate-fade" },
        // --- HEADER MAESTRO ---
        React.createElement("div", { style: { background: `linear-gradient(135deg, ${C.navy} 0%, ${C.blue} 60%, ${C.mid} 100%)`, borderRadius: 16, padding: "32px", marginBottom: 24, color: "#fff", boxShadow: "0 10px 30px rgba(27,58,107,0.15)", display: "flex", justifyContent: "space-between", alignItems: "center" } },
            React.createElement("div", null,
                React.createElement("h1", { style: { fontSize: 32, fontWeight: 950, margin: 0, letterSpacing: "-0.8px" } }, "Resumen Estadístico 911"),
                React.createElement("div", { style: { fontSize: 15, color: "#cbd5e1", marginTop: 6, fontWeight: 500 } }, `🗓 ${turnoLabel}`)
            ),
            React.createElement("div", { style: { textAlign: "right" } },
                React.createElement("img", { src: "src/img/logo_geston.png", style: { height: 60, filter: "brightness(0) invert(1)" } })
            )
        ),

        // --- KPIs PRINCIPALES ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16, marginBottom: 24 } },
            React.createElement(StatKpi, { label: "Total Recibidas", value: tot.ofrecidas?.toLocaleString("es-AR") || "0", sub: "Llamadas totales", accent: C.blue, icon: "📞" }),
            React.createElement(StatKpi, { label: "Llamadas Perdidas", value: tot.abandonadas?.toLocaleString("es-AR") || "0", sub: "Fuera de meta", accent: C.red, icon: "📉" }),
            React.createElement(StatKpi, { label: "% de Abandono", value: `${pctAband.toFixed(1)}%`, sub: "Indicador crítico", accent: pctAband > 15 ? C.red : (pctAband > 8 ? C.orange : C.green), icon: "⚠️" }),
            React.createElement(StatKpi, { label: "% Abandono Cola", value: `${pctCola.toFixed(1)}%`, sub: "Nivel de Cola", accent: pctCola > 10 ? C.orange : C.blue, icon: "⏳" }),
            React.createElement(StatKpi, { label: "TMO Promedio", value: fmtSeconds(agentsRanking.avgManejo), sub: "Tiempo de atención", accent: C.mid, icon: "⏱️" })
        ),

        // --- BLOQUE DE NUMÉRICA Y SLA ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 } },
            // Numerica Detallada
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 16, textTransform: "uppercase" } }, "📊 Numérica Detallada del Período"),
                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
                    [
                        { label: "Ofrecidas", val: tot.ofrecidas, c: C.blue },
                        { label: "Contestadas", val: tot.contestadas, c: C.green },
                        { label: "Abandonadas", val: tot.abandonadas, c: C.red },
                        { label: "Abandono Cola", val: tot.cola, c: C.orange },
                        { label: "Abandono Cabina", val: tot.cabina, c: C.yellow },
                        { label: "Voz Preparada Avg", val: `${agentsRanking.avgPctVoz}%`, c: C.mid }
                    ].map(n => (
                        React.createElement("div", { key: n.label, style: { padding: "12px", background: "#f8fafc", borderRadius: 10, borderLeft: `4px solid ${n.c}` } },
                            React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase" } }, n.label),
                            React.createElement("div", { style: { fontSize: 20, fontWeight: 900, color: C.navy } }, n.val?.toLocaleString("es-AR") || n.val)
                        )
                    ))
                )
            ),
            // Tiempos de Respuesta
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 16, textTransform: "uppercase" } }, "⏱️ Tiempos de Respuesta (SLA)"),
                React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                    [
                        { label: "Creación → Despacho", val: gaugeData.tiempoCreacionDespacho, meta: 120 },
                        { label: "Derivación → Inicio", val: gaugeData.tiempoDerivacionInicio, meta: 30 },
                        { label: "Inicio → Despacho", val: gaugeData.tiempoInicioDespacho, meta: 120 }
                    ].map(t => (
                        React.createElement("div", { key: t.label, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: "#f1f5f9", borderRadius: 12 } },
                            React.createElement("div", null,
                                React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color: C.navy } }, t.label),
                                React.createElement("div", { style: { fontSize: 9, color: C.gray } }, `Meta: ${fmtSeconds(t.meta)}`)
                            ),
                            React.createElement("div", { style: { textAlign: "right" } },
                                React.createElement("div", { style: { fontSize: 22, fontWeight: 950, color: getGaugeColor(t.val, t.meta) } }, fmtSeconds(t.val)),
                                React.createElement("div", { style: { fontSize: 9, fontWeight: 700, color: t.val > t.meta ? C.red : C.green } }, t.val > t.meta ? "🚫 Excede" : "✅ Cumple")
                            )
                        )
                    ))
                )
            )
        ),

        // --- DISTRIBUCION POR HORA Y ABANDONO ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20, marginBottom: 20 } },
            horaData && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "📈 Distribución de Llamadas por Hora"),
                React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "master-chart-hora", data: horaData, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#f1f5f9" } } } } }))
            ),
            abandonDonut && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "🔴 Análisis de Abandono"),
                React.createElement("div", { style: { height: 180 } }, React.createElement(ChartDoughnut, { id: "master-chart-abandono", data: abandonDonut, options: donutOpts })),
                React.createElement("div", { style: { marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 } },
                    React.createElement(Badge, { label: `Cola: ${tot.cola}`, color: C.orange, bg: C.orBg }),
                    React.createElement(Badge, { label: `Cabina: ${tot.cabina}`, color: C.yellow, bg: C.ylBg }),
                    React.createElement(Badge, { label: `Total: ${tot.abandonadas}`, color: C.red, bg: C.redBg })
                )
            )
        ),

        // --- DESEMPEÑO POR OPERADOR Y RANKINGS ---
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.8fr 1.2fr", gap: 20, marginBottom: 20 } },
            agentesData && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "👤 Rendimiento por Operador (Top 15 Atendidas)"),
                React.createElement("div", { style: { height: 350 } }, React.createElement(ChartBar, { id: "master-chart-agentes", data: agentesData, options: { responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { position: "bottom" } } } }))
            ),
            React.createElement(Card, { style: { padding: "20px 0" } },
                React.createElement("div", { style: { padding: "0 20px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    React.createElement("div", { style: { fontWeight: 800, fontSize: 13, color: C.navy, textTransform: "uppercase" } }, "🏆 Rankings del Turno"),
                    groups.length > 0 && React.createElement("select", {
                        value: groupFilter,
                        onChange: e => setGroupFilter(e.target.value),
                        style: { padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 11, fontWeight: 700, color: C.mid }
                    },
                        React.createElement("option", { value: "all" }, "Todos"),
                        groups.map(g => React.createElement("option", { key: g, value: g }, g))
                    )
                ),
                React.createElement("div", { style: { padding: "16px 20px" } },
                    React.createElement("div", { style: { marginBottom: 24 } },
                        React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: C.green, marginBottom: 12 } }, "🥇 TOP 5 DESEMPEÑO"),
                        agentsRanking.top.map((a, i) => React.createElement("div", { key: a.nombre, style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 } },
                            React.createElement("div", { style: { width: 24, height: 24, borderRadius: "50%", background: C.green, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900 } }, i + 1),
                            React.createElement("div", { style: { flex: 1, fontSize: 11, fontWeight: 700, color: C.navy } }, a.nombre.split(",")[0]),
                            React.createElement("div", { style: { textAlign: "right" } },
                                React.createElement("div", { style: { fontSize: 12, fontWeight: 900, color: C.navy } }, a.contestadas),
                                React.createElement("div", { style: { fontSize: 9, color: C.green, fontWeight: 700 } }, `${a.pctVozPreparada}%`)
                            )
                        ))
                    ),
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: C.red, marginBottom: 12 } }, "⚠️ BOTTOM 5 ACTIVIDAD"),
                        agentsRanking.bot.map((a, i) => React.createElement("div", { key: a.nombre, style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 } },
                            React.createElement("div", { style: { width: 24, height: 24, borderRadius: "50%", background: "#fee2e2", color: C.red, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900 } }, agentsRanking.total - i),
                            React.createElement("div", { style: { flex: 1, fontSize: 11, fontWeight: 700, color: C.gray } }, a.nombre.split(",")[0]),
                            React.createElement("div", { style: { textAlign: "right" } },
                                React.createElement("div", { style: { fontSize: 12, fontWeight: 900, color: C.navy } }, a.contestadas),
                                React.createElement("div", { style: { fontSize: 9, color: C.red, fontWeight: 700 } }, `${a.pctAbandonoCabina}%`)
                            )
                        ))
                    )
                )
            )
        ),

        // --- TIEMPOS POR DISTRITO Y ALERTAS ---
        despData && React.createElement(Card, { style: { marginBottom: 20 } },
            React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 14 } }, "🚓 Tiempos de Despacho Asignación por Distrito"),
            React.createElement("div", { style: { height: 250 } }, React.createElement(ChartLine, { id: "master-chart-despacho", data: despData, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => fmtSeconds(v) } } } } }))
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

    return React.createElement("div", null,
        React.createElement(SectionTitle, { num: "2", title: "Llamadas por Hora", sub: scheduleLabel ? `Turno: ${scheduleLabel} — ${ivs.length} intervalos` : "Análisis detallado por intervalo horario" }),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 } },
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Atendidas vs Abandonadas"),
                React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "hora-bar", data: { labels: ivs.map(i => i.hora), datasets: [{ label: "Atendidas", data: ivs.map(i => i.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 5 }, { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#f1f5f9" } } } } }))
            ),
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "% Abandono por Hora"),
                React.createElement("div", { style: { height: 260 } }, React.createElement(ChartLine, { id: "hora-pct", data: { labels: ivs.map(i => i.hora), datasets: [{ label: "% Abandono", data: ivs.map(i => i.ofrecidas ? +((i.abandonadas / i.ofrecidas) * 100).toFixed(1) : 0), borderColor: C.red, backgroundColor: "rgba(220,38,38,0.08)", fill: true, tension: 0.4, pointRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#f1f5f9" }, ticks: { callback: v => v + "%" } } } } }))
            )
        ),
        React.createElement(Card, null,
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: C.blue } },
                            ["Intervalo", "Ofrecidas", "Atendidas", "% Atend.", "Cola", "Cabina", "Total Aband.", "% Aband."].map(h =>
                                React.createElement("th", { key: h, style: { padding: "9px 12px", color: "#fff", fontWeight: 700, textAlign: h === "Intervalo" ? "left" : "center", fontSize: 11 } }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        ivs.map((iv, i) => {
                            const pctA = iv.ofrecidas ? +((iv.contestadas / iv.ofrecidas) * 100).toFixed(0) : 0;
                            const pctAb = iv.ofrecidas ? +((iv.abandonadas / iv.ofrecidas) * 100).toFixed(0) : 0;
                            return React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
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
                            React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.ofrecidas ? `${((tot.contestadas / tot.ofrecidas) * 100).toFixed(1)}%` : "—"),
                            React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.cola),
                            React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.cabina),
                            React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.abandonadas),
                            React.createElement("td", { style: { padding: "8px 12px", textAlign: "center", fontWeight: 700 } }, tot.ofrecidas ? `${((tot.abandonadas / tot.ofrecidas) * 100).toFixed(1)}%` : "—"),
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
    const main = (ag.agents || []).filter(a => a.ofrecidas >= 30).sort((a, b) => b.contestadas - a.contestadas);

    return React.createElement("div", null,
        React.createElement(SectionTitle, { num: "3", title: "Gestión por Operador", sub: `${main.length} operadores activos` }),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 20 } },
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Contestadas vs Abandonadas"),
                React.createElement("div", { style: { height: 240 } }, React.createElement(ChartBar, { id: "ag-bar", data: { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Contestadas", data: main.map(a => a.contestadas), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 5 }, { label: "Abandonadas", data: main.map(a => a.abandonadas), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 } } }, y: { grid: { color: "#f1f5f9" } } } } }))
            ),
            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 14 } }, "Disponibilidad %"),
                React.createElement("div", { style: { height: 240 } }, React.createElement(ChartBar, { id: "ag-disp", data: { labels: main.map(a => a.nombre.split(",")[0]), datasets: [{ label: "Disponibilidad %", data: main.map(a => a.disponibilidad), backgroundColor: main.map(a => a.disponibilidad > 80 ? "rgba(22,163,74,0.8)" : a.disponibilidad > 60 ? "rgba(217,119,6,0.8)" : "rgba(220,38,38,0.8)"), borderRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 } } }, y: { max: 100, ticks: { callback: v => v + "%" } } } } }))
            )
        ),
        React.createElement(Card, null,
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: C.blue } },
                            ["Operador", "Ofrecidas", "Contestadas", "Aband. Cabina", "T. Conectado", "T. Avisando", "T. Ausente", "Disponibilidad"].map(h =>
                                React.createElement("th", { key: h, style: { padding: "9px 12px", color: "#fff", fontWeight: 700, textAlign: h === "Operador" ? "left" : "center", fontSize: 11 } }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        main.map((a, i) => React.createElement("tr", { key: a.nombre, style: { background: i % 2 === 0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                            React.createElement("td", { style: { padding: "9px 12px", fontWeight: 700 } }, a.nombre),
                            React.createElement("td", { style: { padding: "9px 12px", textAlign: "center" } }, a.ofrecidas),
                            React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontWeight: 700, color: C.mid } },
                                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, justifyContent: "center" } }, a.contestadas, React.createElement(MiniBar, { pct: main[0]?.contestadas ? (a.contestadas / main[0].contestadas) * 100 : 0, color: C.mid }))
                            ),
                            React.createElement("td", { style: { padding: "9px 12px", textAlign: "center" } }, React.createElement(Badge, { label: a.abandonadas, color: a.abandonadas > 50 ? C.red : C.green, bg: a.abandonadas > 50 ? C.redBg : C.greenBg })),
                            React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontFamily: "monospace", color: "#334155" } }, a.tiempoConectado),
                            React.createElement("td", { style: { padding: "9px 12px", textAlign: "center", fontFamily: "monospace", color: "#334155" } }, a.tiempoAvisando),
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
function DespachoSection({ title, subtitle, dataset, sectionNum, compact }) {
    if (!dataset?.length) return React.createElement("div", { style: { padding: "20px", textAlign: "center", color: C.gray, fontSize: 12 } }, `Sin datos para: ${title}`);
    const sorted = [...dataset].sort((a, b) => a.tiempoSec - b.tiempoSec);
    const maxSec = sorted[sorted.length - 1]?.tiempoSec || 1;
    const top3 = sorted.slice(0, 3);
    const bot3 = sorted.slice(-3).reverse();
    return React.createElement("div", { style: { marginBottom: compact ? 16 : 32 } },
        React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 2 } }, title),
        React.createElement("div", { style: { fontSize: 11, color: C.gray, marginBottom: 14 } }, subtitle || `${sorted.length} distritos`),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 } },
            React.createElement(Card, { style: { padding: compact ? "12px 14px" : "20px" } },
                React.createElement("div", { style: { fontWeight: 700, fontSize: 11, color: "#065f46", marginBottom: 10 } }, "🏆 Top 3 — Menor tiempo"),
                top3.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: i + 1, variant: "top" }))
            ),
            React.createElement(Card, { style: { padding: compact ? "12px 14px" : "20px" } },
                React.createElement("div", { style: { fontWeight: 700, fontSize: 11, color: C.red, marginBottom: 10 } }, "⚠️ Bottom 3 — Mayor tiempo"),
                bot3.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: sorted.length - i, variant: "bot" }))
            )
        ),
        !compact && React.createElement(Card, null,
            React.createElement("div", { style: { fontWeight: 700, fontSize: 12, color: C.navy, marginBottom: 10 } }, "Ranking Completo"),
            sorted.map((d, i) => React.createElement(DistritoRow, { key: d.nombre, d, maxSec, rank: i + 1, variant: i < 3 ? "top" : i >= sorted.length - 3 ? "bot" : "mid" }))
        )
    );
}

function ViewDespacho({ data }) {
    const dpI = data.despachoInicio || [];
    const dpD = data.despachoDerivacion || [];
    const dpC = data.despachoCreacion || [];
    if (!dpI.length && !dpD.length && !dpC.length)
        return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargá los archivos de tiempos de despacho.");

    return React.createElement("div", null,
        React.createElement(SectionTitle, { num: "4", title: "Tiempos de Despacho por Distrito", sub: "Un ranking por cada métrica de tiempo" }),
        dpC.length > 0 && React.createElement("div", { style: { height: 1, background: C.border, margin: "8px 0 24px" } }),
        React.createElement(DespachoSection, {
            title: "📋 Creación Evento → Derivación",
            subtitle: `${dpC.length} distritos — tiempo desde la creación del evento hasta el despacho`,
            dataset: dpC,
        }),
        dpD.length > 0 && React.createElement("div", { style: { height: 1, background: C.border, margin: "8px 0 24px" } }),
        React.createElement(DespachoSection, {
            title: "🔄 Derivación → Despacho",
            subtitle: `${dpD.length} distritos — tiempo desde derivación hasta inicio del despacho`,
            dataset: dpD,
        }),
        dpI.length > 0 && React.createElement("div", { style: { height: 1, background: C.border, margin: "8px 0 24px" } }),
        React.createElement(DespachoSection, {
            title: "⏱ Inicio Despacho → Asignación",
            subtitle: `${dpI.length} distritos — tiempo desde inicio del despacho hasta asignación`,
            dataset: dpI,
        })

    );
}

function DistritoRow({ d, maxSec, rank, variant }) {
    const pct = maxSec > 0 ? (d.tiempoSec / maxSec) * 100 : 0;
    const efPct = d.total > 0 ? (d.efectiva / d.total) * 100 : 0;
    const col = variant === "bot" ? C.red : variant === "top" ? C.green : C.mid;
    const bg = variant === "bot" ? C.redBg : variant === "top" ? C.greenBg : (rank % 2 === 0 ? "#f8fafc" : "#fff");
    const bdr = variant === "bot" ? "#fecaca" : variant === "top" ? "#86efac" : C.border;

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

// ── Helper: Aggregate stats for a specific shift label ──────────────────────
function getTurnoStats(turnoLabel, history) {
    if (!history || !history.length) return null;
    const filtered = history.filter(h => h.turnoLabel === turnoLabel);
    if (!filtered.length) return null;

    let totalOfrecidas = 0, totalContestadas = 0, totalAbandonadas = 0;
    filtered.forEach(h => {
        totalOfrecidas += (h.resumen?.totalOfrecidas || 0);
        totalContestadas += (h.resumen?.totalContestadas || 0);
        totalAbandonadas += (h.resumen?.totalAbandonadas || 0);
    });

    return {
        cantidad: filtered.length,
        totalOfrecidas,
        totalContestadas,
        totalAbandonadas
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: HISTORIAL — Firebase + local fallback
// ════════════════════════════════════════════════════════════════════════════
function ViewHistorial({ user, onBack, onLoadReport }) {
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
    const canDelete = (r) => !isFirebase || r.uid === user?.uid;

    if (loading) return React.createElement("div", { style: { padding: 60, textAlign: "center", color: C.gray } }, "Cargando historial…");

    if (!history.length) return React.createElement("div", { style: { padding: 40, textAlign: "center", color: C.gray } },
        React.createElement("div", { style: { display: "flex", justifyContent: "flex-start", marginBottom: 20 } },
            React.createElement("button", { onClick: onBack, style: { background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 } }, "← Ir al Inicio")
        ),
        React.createElement("div", { style: { fontSize: 28, marginBottom: 10 } }, "📋"),
        React.createElement("div", { style: { fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 6 } }, "Sin reportes guardados"),
        React.createElement("div", { style: { fontSize: 13 } }, isFirebase ? "Los reportes que generes se guardarán automáticamente en Firestore." : "Los reportes se guardan localmente en este navegador.")
    );

    if (selectedReport) {
        const avg = arr => Array.isArray(arr) && arr.length ? Math.round(arr.reduce((s, v) => s + (v.tiempoSec || 0), 0) / arr.length) : 0;
        const dpI = selectedReport.datos?.despachoInicio || [];
        const dpD = selectedReport.datos?.despachoDerivacion || [];
        const dpC = selectedReport.datos?.despachoCreacion || [];

        return React.createElement("div", { className: "animate-fade" },
            React.createElement(Card, { style: { marginBottom: 20 } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 } },
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
                        React.createElement("button", { onClick: () => setSelectedReport(null), style: { background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 } }, "← Volver al Listado"),
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontSize: 13, fontWeight: 700, color: C.navy } }, `Reporte: ${selectedReport.id}`),
                            React.createElement("div", { style: { fontSize: 11, color: C.gray, marginTop: 2 } }, `Token: ${selectedReport.token}`)
                        )
                    ),
                    onLoadReport && React.createElement("button", {
                        onClick: () => onLoadReport(selectedReport),
                        style: { background: C.green, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 800, cursor: "pointer", boxShadow: "0 4px 12px rgba(16,185,129,0.2)" }
                    }, "⚡ Cargar en Dashboard")
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
                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12 } },
                    React.createElement(StatKpi, { label: "Llamadas Ofrecidas", value: selectedReport.resumen?.totalOfrecidas || 0, accent: C.mid }),
                    React.createElement(StatKpi, { label: "Llamadas Contestadas", value: selectedReport.resumen?.totalContestadas || 0, accent: C.green }),
                    React.createElement(StatKpi, { label: "Llamadas Abandonadas", value: selectedReport.resumen?.totalAbandonadas || 0, accent: C.red })
                )
            ),
            selectedReport.datos?.agentes?.length > 0 && React.createElement(Card, { style: { marginBottom: 20 } },
                React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 12 } }, "🧍 Operadores"),
                React.createElement("div", { style: { overflowX: "auto" } },
                    React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 10 } },
                        React.createElement("thead", null,
                            React.createElement("tr", { style: { background: C.blue } },
                                ["Operador", "Ofrecidas", "Contestadas", "Abandonadas", "Disponibilidad"].map(h =>
                                    React.createElement("th", { key: h, style: { padding: "6px 10px", color: "#fff", fontWeight: 700, textAlign: "left" } }, h)
                                )
                            )
                        ),
                        React.createElement("tbody", null,
                            selectedReport.datos.agentes.map((a, i) =>
                                React.createElement("tr", { key: a.nombre + i, style: { background: i % 2 === 0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                                    React.createElement("td", { style: { padding: "6px 10px", fontWeight: 600 } }, a.nombre),
                                    React.createElement("td", { style: { padding: "6px 10px", textAlign: "center" } }, a.ofrecidas),
                                    React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", fontWeight: 600, color: C.green } }, a.contestadas),
                                    React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", fontWeight: 600, color: C.red } }, a.abandonadas),
                                    React.createElement("td", { style: { padding: "6px 10px", textAlign: "center", color: a.disponibilidad > 80 ? C.green : a.disponibilidad > 60 ? C.yellow : C.red } }, `${(a.disponibilidad || 0).toFixed(1)}%`)
                                )
                            )
                        )
                    )
                )
            )
        );
    }

    return React.createElement("div", { className: "animate-fade" },
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
                React.createElement("button", { onClick: onBack, style: { background: "#fff", border: `1px solid ${C.border}`, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.navy } }, "←"),
                React.createElement("div", null,
                    React.createElement("h2", { style: { margin: 0, color: C.navy, fontWeight: 900 } }, "📋 Historial de Reportes"),
                    React.createElement("p", { style: { margin: "4px 0 0", color: C.gray, fontSize: 13 } }, `${history.length} reportes guardados`)
                )
            ),
            isFirebase && React.createElement("button", {
                onClick: () => { setLoading(true); loadReportsFromFirestore().then(r => { setHistory(r); setLoading(false); }); },
                style: { background: C.greenBg, border: `1px solid ${C.green}`, color: C.green, borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" }
            }, "↺ Actualizar")
        ),

        React.createElement(Card, { style: { marginBottom: 20 } },
            React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 12 } }, "Filtrar por Turno"),
            React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                React.createElement("button", { onClick: () => setFilterTurno(null), style: { padding: "6px 14px", borderRadius: 6, border: filterTurno === null ? `2px solid ${C.blue}` : `1px solid ${C.border}`, background: filterTurno === null ? C.light : "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: filterTurno === null ? C.blue : C.gray } }, `Todos (${history.length})`),
                turnos.map(turno => React.createElement("button", { key: turno, onClick: () => setFilterTurno(turno), style: { padding: "6px 14px", borderRadius: 6, border: filterTurno === turno ? `2px solid ${C.blue}` : `1px solid ${C.border}`, background: filterTurno === turno ? C.light : "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: filterTurno === turno ? C.blue : C.gray } }, turno))
            )
        ),

        React.createElement(Card, { style: { padding: 0, overflow: "hidden" } },
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse" } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: C.navy, color: "#fff" } },
                            ["ID Reporte", "Usuario", "Fecha", "Turno", "Contest.", "Aband.", "Acciones"].map(h =>
                                React.createElement("th", { key: h, style: { padding: "14px 16px", fontWeight: 700, textAlign: "left", fontSize: 11 } }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        filteredReports.map((r, i) => {
                            const reportDate = r.fechaGuardado ? new Date(r.fechaGuardado).toLocaleDateString("es-ES") : "-";
                            return React.createElement("tr", { key: r.id || i, style: { background: i % 2 === 0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                                React.createElement("td", { style: { padding: "12px 16px", fontWeight: 700, fontFamily: "monospace", fontSize: 10, color: C.blue } }, r.id.substring(0, 10) + "…"),
                                React.createElement("td", { style: { padding: "12px 16px", fontSize: 11, color: C.gray, fontWeight: 600 } }, r.userDisplayName || r.userEmail || "Sistema"),
                                React.createElement("td", { style: { padding: "12px 16px", fontSize: 11, color: C.gray } }, reportDate),
                                React.createElement("td", { style: { padding: "12px 16px", fontSize: 11, fontWeight: 600 } }, r.turnoLabel),
                                React.createElement("td", { style: { padding: "12px 16px", textAlign: "center", fontWeight: 700, color: C.green } }, r.resumen?.totalContestadas || 0),
                                React.createElement("td", { style: { padding: "12px 16px", textAlign: "center", fontWeight: 700, color: C.red } }, r.resumen?.totalAbandonadas || 0),
                                React.createElement("td", { style: { padding: "12px 16px", display: "flex", gap: 8, alignItems: "center" } },
                                    React.createElement("button", { onClick: () => setSelectedReport(r), style: { background: C.mid, color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" } }, "Ver"),
                                    canDelete(r) && React.createElement("button", { onClick: () => handleDelete(r), disabled: deleting === r.id, style: { background: "transparent", color: C.red, border: `1px solid ${C.red}`, borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" } }, "✕")
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
//  VIEW: MENSUAL (Enhanced — Filters, Charts, Turno)
// ════════════════════════════════════════════════════════════════════════════
function ViewMensual({ user, onBack }) {
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [filterYear, setFilterYear] = useState("all");
    const [filterMonth, setFilterMonth] = useState("all");
    const [filterTurno, setFilterTurno] = useState("all"); // "all" | "dia" | "noche"
    const [selectedMonths, setSelectedMonths] = useState([]);


    useEffect(() => {
        if (user === undefined) return;
        setLoading(true);
        setError(null);
        loadMensualFromFirestore()
            .then(res => { setHistory(res); setLoading(false); })
            .catch(err => {
                console.error(err);
                setError("Error de permisos o conexión al cargar registros mensuales. Verificá las reglas de Firestore.");
                setLoading(false);
            });
    }, [user]);

    // ──── CSV Parser (ENERO_2026 format) ─────────────────────────────────────
    const handleMonthlyFile = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setUploading(true);
        const fileName = file.name.toLowerCase();
        const match = fileName.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)_(\d{4})/i);
        if (!match) { alert("Nombre de archivo inválido. Use formato MES_AÑO.csv (ej: ENERO_2026.csv)"); setUploading(false); return; }

        const monthStr = match[1];
        const year = parseInt(match[2]);
        const monthsList = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
        const monthNum = monthsList.indexOf(monthStr.toLowerCase()) + 1;

        try {
            const text = await file.text();
            const lines = parseLines(text);
            let totalOfrecidas = 0, totalContestadas = 0, totalAbandonadas = 0;
            const dailyData = {};
            const hourlyData = [];
            let headerFound = false;
            // Default columns for ENERO_2026 format
            let colIdx = { fecha: 0, intervalo: 1, abandonadas: 2, ofrecidas: 3, contestadas: 4, enCola: 5, avisandoAb: 6, avisando: 7, manejo: 8 };
            // Flag to detect format type
            let isNewFormat = false;

            lines.forEach((line) => {
                const cols = parseSemicolon(line);
                if (cols.length < 3) return;

                // Detect header
                if (!headerFound && (cols.some(c => /intervalo/i.test(c)) || cols.some(c => /ofrec/i.test(c)))) {
                    headerFound = true;
                    // Check if it's the new format with "Intervalo" column
                    if (cols.some(c => /intervalo/i.test(c))) {
                        isNewFormat = true;
                        cols.forEach((c, i) => {
                            const h = c.toLowerCase().trim();
                            if (h === "fecha" || h.includes("fecha")) colIdx.fecha = i;
                            if (h.includes("intervalo")) colIdx.intervalo = i;
                            if (h === "abandonadas") colIdx.abandonadas = i;
                            if (h === "ofrecidas" || (h.includes("ofrec") && !h.includes("abandon"))) colIdx.ofrecidas = i;
                            if (h.includes("abandonadas contestadas") || h.includes("abandon") && h.includes("contest")) colIdx.contestadas = i;
                            if (h.includes("en cola") || h.includes("cola")) colIdx.enCola = i;
                            if (h.includes("abandonadas avisando") || (h.includes("abandon") && h.includes("avisan"))) colIdx.avisandoAb = i;
                            if (h === "avisando") colIdx.avisando = i;
                            if (h === "manejo" || h.includes("manejo")) colIdx.manejo = i;
                        });
                    } else {
                        // Old format fallback (Fecha; Hora; Ofrecidas; Contestadas)
                        cols.forEach((c, i) => {
                            const h = c.toLowerCase();
                            if (h.includes("fecha")) colIdx.fecha = i;
                            if (h.includes("hora")) colIdx.intervalo = i;
                            if (h.includes("ofrec")) colIdx.ofrecidas = i;
                            if (h.includes("contest")) colIdx.contestadas = i;
                        });
                    }
                    return;
                }

                const fechaRaw = (cols[colIdx.fecha] || "").trim();
                if (!fechaRaw) return;

                let ofrec, contest, aband, enCola, avisandoAb, avisandoTime, manejoTime;

                if (isNewFormat) {
                    ofrec = parseInt(cols[colIdx.ofrecidas]) || 0;
                    contest = parseInt(cols[colIdx.contestadas]) || 0;
                    aband = parseInt(cols[colIdx.abandonadas]) || 0;
                    enCola = parseInt(cols[colIdx.enCola]) || 0;
                    avisandoAb = parseInt(cols[colIdx.avisandoAb]) || 0;
                    avisandoTime = parseTimeToSeconds(cols[colIdx.avisando] || "0");
                    manejoTime = parseTimeToSeconds(cols[colIdx.manejo] || "0");
                } else {
                    ofrec = parseInt(cols[colIdx.ofrecidas]) || 0;
                    contest = parseInt(cols[colIdx.contestadas] || cols[colIdx.ofrecidas]) || 0;
                    aband = ofrec - contest;
                    enCola = 0; avisandoAb = 0; avisandoTime = 0; manejoTime = 0;
                }

                if (!ofrec && !contest && !aband) return;

                // Parse date (d/m/yyyy)
                const dateParts = fechaRaw.split(/[\/-]/);
                let dayNum = 0;
                if (dateParts.length >= 2) {
                    const p0 = parseInt(dateParts[0]);
                    const p1 = parseInt(dateParts[1]);
                    if (p1 === monthNum) dayNum = p0;
                    else if (p0 === monthNum) dayNum = p1;
                    else dayNum = p0;
                }

                // Parse hour from intervalo "HH:MM - HH:MM" or simple hour
                let hour = 0;
                const intervaloRaw = (cols[colIdx.intervalo] || "").trim();
                const hourMatch = intervaloRaw.match(/(\d{1,2}):\d{2}\s*-/);
                if (hourMatch) {
                    hour = parseInt(hourMatch[1]);
                } else {
                    const simpleH = intervaloRaw.match(/(\d{1,2})/);
                    if (simpleH) hour = parseInt(simpleH[1]);
                }

                if (dayNum >= 1 && dayNum <= 31) {
                    totalOfrecidas += ofrec;
                    totalContestadas += contest;
                    totalAbandonadas += aband;

                    if (!dailyData[dayNum]) dailyData[dayNum] = { d: dayNum, ofrecidas: 0, contestadas: 0, abandonadas: 0 };
                    dailyData[dayNum].ofrecidas += ofrec;
                    dailyData[dayNum].contestadas += contest;
                    dailyData[dayNum].abandonadas += aband;

                    hourlyData.push({
                        d: dayNum, hour: hour,
                        h: hour.toString().padStart(2, "0") + ":00",
                        o: ofrec, c: contest, ab: aband,
                        ec: enCola, av: avisandoAb,
                        avisandoSec: avisandoTime, manejo: manejoTime
                    });
                }
            });

            const report = {
                resumen: { totalOfrecidas, totalContestadas, totalAbandonadas },
                detalles: hourlyData,
                dailyAggr: Object.values(dailyData).sort((a, b) => a.d - b.d)
            };
            const meta = { month: monthStr, year, monthNum, label: `${monthStr} ${year}`.toUpperCase() };

            const id = await saveMensualToFirestore(report, meta, user);
            if (id) {
                const newEntry = { firestoreId: id, ...report, meta, uid: user.uid };
                setHistory(prev => {
                    const existIdx = prev.findIndex(h => h.meta.monthNum === monthNum && h.meta.year === year);
                    if (existIdx >= 0) { const u = [...prev]; u[existIdx] = newEntry; return u; }
                    return [newEntry, ...prev];
                });
                alert("¡Archivo mensual procesado y guardado correctamente!");
            }
        } catch (e) { console.error(e); alert("Error al procesar el archivo: " + e.message); }
        setUploading(false);
    };

    // ──── Filter helpers ─────────────────────────────────────────────────────
    // (Moved to global scope)

    const availableYears = useMemo(() => [...new Set(history.map(h => h && h.meta ? h.meta.year : null))].filter(Boolean).sort((a, b) => b - a), [history]);

    const filteredHistory = useMemo(() => {
        let res = history;
        if (filterYear !== "all") res = res.filter(h => h.meta.year === parseInt(filterYear));
        if (filterMonth !== "all") res = res.filter(h => h.meta.monthNum === parseInt(filterMonth));
        return res;
    }, [history, filterYear, filterMonth]);

    const availableMonths = useMemo(() => {
        const scope = filterYear !== "all" ? history.filter(h => h.meta.year === parseInt(filterYear)) : history;
        return [...new Set(scope.map(h => h.meta.monthNum))].sort((a, b) => a - b);
    }, [history, filterYear]);

    // ──── KPI aggregate ──────────────────────────────────────────────────────
    const kpis = useMemo(() => {
        const target = selectedMonths.length > 0
            ? history.filter(h => selectedMonths.includes(h.firestoreId))
            : filteredHistory;
        let tO = 0, tC = 0, tA = 0, tEC = 0, tAV = 0, mSum = 0, mCnt = 0, avSum = 0, avCnt = 0;
        target.forEach(h => {
            if (!h) return;
            const rows = filterDetailsByTurno(h.detalles, filterTurno);
            if (!rows || !rows.length) {
                if (h.resumen) {
                    tO += h.resumen.totalOfrecidas || 0;
                    tC += h.resumen.totalContestadas || 0;
                    tA += h.resumen.totalAbandonadas || 0;
                }
                return;
            }
            rows.forEach(r => {
                if (!r) return;
                tO += r.o || 0; tC += r.c || 0; tA += r.ab || 0;
                tEC += r.ec || 0; tAV += r.av || 0;
                if (r.manejo) { mSum += r.manejo; mCnt++; }
                if (r.avisandoSec) { avSum += r.avisandoSec; avCnt++; }
            });
        });
        const pctAt = tO ? (tC / tO * 100) : 0;
        const pctAb = tO ? (tA / tO * 100) : 0;
        const avgManejo = mCnt ? Math.round(mSum / mCnt) : 0;
        const avgAvisando = avCnt ? Math.round(avSum / avCnt) : 0;
        return { tO, tC, tA, tEC, tAV, pctAt, pctAb, avgManejo, avgAvisando, totalManejo: mSum, totalAvisando: avSum, count: target.length };
    }, [filteredHistory, selectedMonths, filterTurno, history]);

    // ──── Monthly Comparison KPIs (per-month with deltas) ────────────────────
    const monthlyCompData = useMemo(() => {
        if (filteredHistory.length === 0) return null;
        const target = selectedMonths.length > 0
            ? history.filter(h => selectedMonths.includes(h.firestoreId))
            : filteredHistory;
        if (target.length === 0) return null;

        const sorted = [...target].sort((a, b) => (a.meta.year * 100 + a.meta.monthNum) - (b.meta.year * 100 + b.meta.monthNum));

        const monthStats = sorted.map(h => {
            if (!h) return null;
            const rows = filterDetailsByTurno(h.detalles, filterTurno);
            let rO = 0, rC = 0, rA = 0, rEC = 0, rAV = 0, mSum = 0, mCnt = 0, avSum = 0, avCnt = 0;
            if (rows && rows.length) {
                rows.forEach(r => {
                    if (!r) return;
                    rO += r.o || 0; rC += r.c || 0; rA += r.ab || 0;
                    rEC += r.ec || 0; rAV += r.av || 0;
                    if (r.manejo) { mSum += r.manejo; mCnt++; }
                    if (r.avisandoSec) { avSum += r.avisandoSec; avCnt++; }
                });
            } else if (h.resumen) {
                rO = h.resumen.totalOfrecidas || 0; rC = h.resumen.totalContestadas || 0; rA = h.resumen.totalAbandonadas || 0;
            }
            const pctAb = rO ? (rA / rO * 100) : 0;
            const pctAt = rO ? (rC / rO * 100) : 0;
            const avgManejo = mCnt ? Math.round(mSum / mCnt) : 0;
            const avgAvisando = avCnt ? Math.round(avSum / avCnt) : 0;
            const uniqueDays = rows && rows.length ? new Set(rows.map(r => r.d)).size : 1;
            const promDiario = uniqueDays ? Math.round(rO / uniqueDays) : 0;
            const promAbandDiario = uniqueDays ? Math.round(rA / uniqueDays) : 0;
            return {
                label: h.meta.label, monthNum: h.meta.monthNum, year: h.meta.year,
                firestoreId: h.firestoreId,
                ofrecidas: rO, contestadas: rC, abandonadas: rA,
                enCola: rEC, avisando: rAV,
                pctAb, pctAt, avgManejo, avgAvisando,
                totalManejo: mSum, totalAvisando: avSum,
                promDiario, promAbandDiario, uniqueDays
            };
        });

        // Calculate deltas (vs previous month)
        const withDeltas = monthStats.map((cur, i) => {
            if (i === 0) return { ...cur, deltas: null };
            const prev = monthStats[i - 1];
            const delta = (curVal, prevVal) => prevVal !== 0 ? ((curVal - prevVal) / prevVal * 100) : (curVal > 0 ? 100 : 0);
            return {
                ...cur,
                deltas: {
                    ofrecidas: delta(cur.ofrecidas, prev.ofrecidas),
                    contestadas: delta(cur.contestadas, prev.contestadas),
                    abandonadas: delta(cur.abandonadas, prev.abandonadas),
                    pctAb: cur.pctAb - prev.pctAb,  // Simple difference for percentage points
                    pctAt: cur.pctAt - prev.pctAt,
                    avgManejo: cur.avgManejo - prev.avgManejo,
                    totalManejo: delta(cur.totalManejo, prev.totalManejo),
                    promDiario: delta(cur.promDiario, prev.promDiario),
                }
            };
        });

        return withDeltas;

        return withDeltas;
    }, [filteredHistory, selectedMonths, filterTurno, history]);

    // ──── Chart: Comparison bar ──────────────────────────────────────────────
    const compChart = useMemo(() => {
        if (filteredHistory.length === 0) return null;
        const data = selectedMonths.length > 0
            ? history.filter(h => selectedMonths.includes(h.firestoreId))
            : filteredHistory;
        if (data.length === 0) return null;
        const sorted = [...data].sort((a, b) => (a.meta.year * 100 + a.meta.monthNum) - (b.meta.year * 100 + b.meta.monthNum));
        return {
            labels: sorted.map(s => s.meta?.label || "—"),
            datasets: [
                { label: "Ofrecidas", data: sorted.map(s => { const rows = filterDetailsByTurno(s.detalles, filterTurno); return rows?.length ? rows.reduce((sum, r) => sum + (r?.o || 0), 0) : (s.resumen?.totalOfrecidas || 0); }), backgroundColor: "rgba(46,95,163,0.85)", borderRadius: 6 },
                { label: "Contestadas", data: sorted.map(s => { const rows = filterDetailsByTurno(s.detalles, filterTurno); return rows?.length ? rows.reduce((sum, r) => sum + (r?.c || 0), 0) : (s.resumen?.totalContestadas || 0); }), backgroundColor: "rgba(22,163,74,0.8)", borderRadius: 6 },
                { label: "Abandonadas", data: sorted.map(s => { const rows = filterDetailsByTurno(s.detalles, filterTurno); return rows?.length ? rows.reduce((sum, r) => sum + (r?.ab || 0), 0) : (s.resumen?.totalAbandonadas || 0); }), backgroundColor: "rgba(220,38,38,0.75)", borderRadius: 6 }
            ]
        };
    }, [filteredHistory, selectedMonths, filterTurno, history]);

    // ──── Chart: Daily trend (single month) ──────────────────────────────────
    const dailyChart = useMemo(() => {
        const single = selectedMonths.length === 1
            ? history.find(h => h.firestoreId === selectedMonths[0])
            : (filteredHistory.length === 1 ? filteredHistory[0] : null);
        if (!single || !single.detalles) return null;
        const rows = filterDetailsByTurno(single.detalles, filterTurno);
        const byDay = {};
        rows.forEach(r => {
            if (!r || r.d === undefined) return;
            if (!byDay[r.d]) byDay[r.d] = { o: 0, c: 0, ab: 0 };
            byDay[r.d].o += r.o || 0; byDay[r.d].c += r.c || 0; byDay[r.d].ab += r.ab || 0;
        });
        const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
        return {
            labels: days.map(d => `Día ${d}`),
            datasets: [
                { label: "Ofrecidas", data: days.map(d => byDay[d].o), borderColor: C.mid, backgroundColor: "rgba(46,95,163,0.08)", fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: C.mid, borderWidth: 2 },
                { label: "Contestadas", data: days.map(d => byDay[d].c), borderColor: C.green, backgroundColor: "rgba(22,163,74,0.06)", fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: C.green, borderWidth: 2 },
                { label: "Abandonadas", data: days.map(d => byDay[d].ab), borderColor: C.red, backgroundColor: "rgba(220,38,38,0.06)", fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: C.red, borderWidth: 2 }
            ]
        };
    }, [filteredHistory, selectedMonths, filterTurno, history]);

    // ──── Chart: Hourly distribution ─────────────────────────────────────────
    const hourlyChart = useMemo(() => {
        const target = selectedMonths.length > 0
            ? history.filter(h => selectedMonths.includes(h.firestoreId))
            : filteredHistory;
        if (!target.length) return null;
        const byHour = {};
        let totalDays = 0;
        target.forEach(h => {
            const rows = filterDetailsByTurno(h.detalles, filterTurno);
            if (!rows || !rows.length) return;
            const daysInMonth = new Set(rows.filter(r => r && r.d !== undefined).map(r => r.d)).size;
            totalDays += daysInMonth;
            rows.forEach(r => {
                if (!r || r.hour === undefined) return;
                if (!byHour[r.hour]) byHour[r.hour] = { o: 0, c: 0, ab: 0 };
                byHour[r.hour].o += r.o || 0;
                byHour[r.hour].c += r.c || 0;
                byHour[r.hour].ab += r.ab || 0;
            });
        });
        const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
        if (!hours.length) return null;
        const divisor = totalDays || 1;
        return {
            labels: hours.map(h => `${h.toString().padStart(2, "0")}:00`),
            datasets: [
                { label: "Prom. Ofrecidas/día", data: hours.map(h => Math.round(byHour[h].o / divisor)), backgroundColor: "rgba(46,95,163,0.75)", borderRadius: 5 },
                { label: "Prom. Abandonadas/día", data: hours.map(h => Math.round(byHour[h].ab / divisor)), backgroundColor: "rgba(220,38,38,0.6)", borderRadius: 5 }
            ]
        };
    }, [filteredHistory, selectedMonths, filterTurno, history]);

    // ──── Chart: Day of Week distribution ────────────────────────────────────
    const weekDayChart = useMemo(() => {
        const target = selectedMonths.length > 0
            ? history.filter(h => selectedMonths.includes(h.firestoreId))
            : filteredHistory;
        if (!target.length) return null;

        const byDay = { 0: { o: 0, c: 0, ab: 0, count: 0 }, 1: { o: 0, c: 0, ab: 0, count: 0 }, 2: { o: 0, c: 0, ab: 0, count: 0 }, 3: { o: 0, c: 0, ab: 0, count: 0 }, 4: { o: 0, c: 0, ab: 0, count: 0 }, 5: { o: 0, c: 0, ab: 0, count: 0 }, 6: { o: 0, c: 0, ab: 0, count: 0 } };

        target.forEach(h => {
            const rows = filterDetailsByTurno(h.detalles, filterTurno);
            if (!rows || !rows.length) return;

            const daysSeen = new Set();
            rows.forEach(r => {
                if (!r || r.d === undefined) return;
                const dt = new Date(h.meta.year, h.meta.monthNum - 1, r.d);
                const dow = dt.getDay();
                byDay[dow].o += r.o || 0;
                byDay[dow].c += r.c || 0;
                byDay[dow].ab += r.ab || 0;
                daysSeen.add(`${dow}-${r.d}`);
            });

            const monthDows = {};
            daysSeen.forEach(s => {
                const dow = s.split("-")[0];
                monthDows[dow] = (monthDows[dow] || 0) + 1;
            });
            Object.keys(monthDows).forEach(dow => {
                byDay[dow].count += monthDows[dow];
            });
        });

        const order = [1, 2, 3, 4, 5, 6, 0]; // Mon -> Sun
        const labels = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

        return {
            labels,
            datasets: [
                { label: "Prom. Ofrecidas", data: order.map(d => byDay[d].count ? Math.round(byDay[d].o / byDay[d].count) : 0), borderColor: C.mid, backgroundColor: "rgba(46,95,163,0.08)", fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: C.mid, borderWidth: 2.5 },
                { label: "Prom. Contestadas", data: order.map(d => byDay[d].count ? Math.round(byDay[d].c / byDay[d].count) : 0), borderColor: C.green, backgroundColor: "rgba(22,163,74,0.06)", fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: C.green, borderWidth: 2.5 },
                { label: "Prom. Abandonadas", data: order.map(d => byDay[d].count ? Math.round(byDay[d].ab / byDay[d].count) : 0), borderColor: C.red, backgroundColor: "rgba(220,38,38,0.06)", fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: C.red, borderWidth: 2.5 }
            ]
        };
    }, [filteredHistory, selectedMonths, filterTurno, history]);

    // ──── Chart: Turno comparison donut ──────────────────────────────────────
    const turnoCompChart = useMemo(() => {
        const target = selectedMonths.length > 0
            ? history.filter(h => selectedMonths.includes(h.firestoreId))
            : filteredHistory;
        if (!target.length) return null;
        let diaO = 0, diaC = 0, diaA = 0, nocO = 0, nocC = 0, nocA = 0;
        target.forEach(h => {
            if (!h.detalles || !Array.isArray(h.detalles)) return;
            h.detalles.forEach(r => {
                if (!r || r.hour === undefined) return;
                if (r.hour >= 7 && r.hour < 19) {
                    diaO += r.o || 0; diaC += r.c || 0; diaA += r.ab || 0;
                } else {
                    nocO += r.o || 0; nocC += r.c || 0; nocA += r.ab || 0;
                }
            });
        });
        if (!diaO && !nocO) return null;
        return {
            donut: { labels: ["Diurno (07–19)", "Nocturno (19–07)"], datasets: [{ data: [diaO, nocO], backgroundColor: ["rgba(46,95,163,0.85)", "rgba(15,36,68,0.85)"], borderWidth: 0, hoverOffset: 8 }] },
            stats: { diaO, diaC, diaA, nocO, nocC, nocA },
            bar: {
                labels: ["Diurno (07–19)", "Nocturno (19–07)"],
                datasets: [
                    { label: "Contestadas", data: [diaC, nocC], backgroundColor: ["rgba(22,163,74,0.8)", "rgba(22,163,74,0.55)"], borderRadius: 6 },
                    { label: "Abandonadas", data: [diaA, nocA], backgroundColor: ["rgba(220,38,38,0.75)", "rgba(220,38,38,0.5)"], borderRadius: 6 }
                ]
            }
        };
    }, [filteredHistory, selectedMonths, history]);

    // ──── Render ─────────────────────────────────────────────────────────────
    if (loading) return React.createElement("div", { style: { padding: 60, textAlign: "center", color: C.gray } }, "Cargando histórico mensual…");
    if (error) return React.createElement("div", { style: { padding: 40, textAlign: "center" } },
        React.createElement("div", { style: { fontSize: 32, marginBottom: 12 } }, "⚠️"),
        React.createElement("div", { style: { color: C.red, fontWeight: 700, marginBottom: 8 } }, error),
        React.createElement("div", { style: { fontSize: 12, color: C.gray } }, "Asegurate de haber actualizado las Reglas de Seguridad en tu Consola de Firebase.")
    );

    const turnoLabel = filterTurno === "dia" ? "Turno Diurno (07:00 – 19:00)" : filterTurno === "noche" ? "Turno Nocturno (19:00 – 07:00)" : "Todos los turnos";

    return React.createElement("div", { className: "view-mensual-root" },
        // ── PRINT STYLES ──────────────────────────────────────────────────────
        React.createElement("style", null, `
            @media print {
                body, .view-mensual-root { background: #fff !important; padding: 0 !important; margin: 0 !important; }
                .view-mensual-root > div:first-child { background: #0f2444 !important; color: #fff !important; border-radius: 0 !important; margin-bottom: 30px !important; print-color-adjust: exact; }
                .view-mensual-root > div:nth-child(2), 
                .view-mensual-root > div:nth-child(3), 
                .view-mensual-root button,
                .view-mensual-root select,
                .view-mensual-root .no-print { display: none !important; }
                .view-mensual-root .card { box-shadow: none !important; border: 1px solid #e2e8f0 !important; break-inside: avoid; page-break-inside: avoid; margin-bottom: 25px !important; }
                .view-mensual-root h2, .view-mensual-root h3 { color: #0f2444 !important; }
                canvas { max-width: 100% !important; height: auto !important; }
                .page-break { page-break-before: always; break-before: page; padding-top: 30px; }
            }
        `),
        // ── HEADER BANNER ──────────────────────────────────────────────────────
        React.createElement("div", { style: { background: `linear-gradient(135deg, ${C.navy} 0%, ${C.blue} 60%, ${C.mid} 100%)`, borderRadius: 14, padding: "28px 32px", marginBottom: 24, color: "#fff", position: "relative" } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
                    onBack && React.createElement("button", { onClick: onBack, style: { background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff" } }, "←"),
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: "#93c5fd", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 } }, ""),
                        React.createElement("div", { style: { fontSize: 26, fontWeight: 900 } }, "Análisis Mensual"),
                        React.createElement("div", { style: { fontSize: 13, color: "#94a3b8", marginTop: 4 } }, `${filteredHistory.length} registros • ${turnoLabel}`)
                    )
                ),
                React.createElement("div", { style: { textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 } },
                    kpis.tO > 0 && React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: 36, fontWeight: 900, lineHeight: 1 } }, kpis.tO.toLocaleString("es-AR")),
                        React.createElement("div", { style: { fontSize: 11, color: "#93c5fd", marginTop: 4 } }, "llamadas totales")
                    ),
                    React.createElement("button", {
                        onClick: () => window.print(),
                        style: {
                            background: "rgba(255,255,255,0.15)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)",
                            borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                            display: "flex", alignItems: "center", gap: 8, backdropFilter: "blur(4px)"
                        }
                    }, "📄 Generar Reporte (PDF)")
                )
            )
        ),

        // ── UPLOAD ──────────────────────────────────────────────────────────────
        React.createElement(Card, { style: { marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 24px" } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
                React.createElement("div", { style: { width: 42, height: 42, borderRadius: 10, background: `linear-gradient(135deg, ${C.blue}, ${C.mid})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 } }, "📁"),
                React.createElement("div", null,
                    React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy } }, "Cargar nuevo mes"),
                    React.createElement("div", { style: { fontSize: 11, color: C.gray } }, "Formato: MES_AÑO.csv (ej: ENERO_2026.csv)")
                )
            ),
            React.createElement("div", { style: { position: "relative" } },
                React.createElement("button", { disabled: uploading, style: { background: `linear-gradient(135deg, ${C.blue}, ${C.mid})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, cursor: uploading ? "wait" : "pointer", fontSize: 13 } }, uploading ? "⏳ Procesando..." : "Seleccionar CSV"),
                React.createElement("input", { type: "file", accept: ".csv", onChange: handleMonthlyFile, style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" } })
            )
        ),

        // ── FILTER BAR ─────────────────────────────────────────────────────────
        history.length > 0 && React.createElement(Card, { style: { marginBottom: 20, padding: "16px 24px" } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" } },
                React.createElement("div", { style: { fontWeight: 800, fontSize: 13, color: C.navy, display: "flex", alignItems: "center", gap: 6 } }, "🔍 Filtros"),
                // Year filter
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: C.gray, textTransform: "uppercase", letterSpacing: 1 } }, "Año"),
                    React.createElement("select", { value: filterYear, onChange: e => { setFilterYear(e.target.value); setFilterMonth("all"); setSelectedMonths([]); }, style: { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.navy, background: "#fff", cursor: "pointer" } },
                        React.createElement("option", { value: "all" }, "Todos"),
                        availableYears.map(y => React.createElement("option", { key: y, value: y }, y))
                    )
                ),
                // Month filter
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: C.gray, textTransform: "uppercase", letterSpacing: 1 } }, "Mes"),
                    React.createElement("select", { value: filterMonth, onChange: e => { setFilterMonth(e.target.value); setSelectedMonths([]); }, style: { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.navy, background: "#fff", cursor: "pointer" } },
                        React.createElement("option", { value: "all" }, "Todos"),
                        availableMonths.map(m => React.createElement("option", { key: m, value: m }, MONTH_NAMES[m]))
                    )
                ),
                // Turno filter
                React.createElement("div", { style: { display: "flex", background: "#f1f5f9", borderRadius: 8, padding: 3, gap: 3 } },
                    [
                        { id: "all", label: "Todo el día", icon: "🕐" },
                        { id: "dia", label: "07:00 – 19:00", icon: "☀️" },
                        { id: "noche", label: "19:00 – 07:00", icon: "🌙" }
                    ].map(t => React.createElement("button", {
                        key: t.id,
                        onClick: () => setFilterTurno(t.id),
                        style: {
                            padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer",
                            background: filterTurno === t.id ? "#fff" : "transparent",
                            color: filterTurno === t.id ? C.blue : C.gray,
                            boxShadow: filterTurno === t.id ? "0 2px 6px rgba(0,0,0,0.08)" : "none",
                            transition: "all .15s",
                            display: "flex", alignItems: "center", gap: 4
                        }
                    }, t.icon, " ", t.label))
                ),
                // Clear filters
                (filterYear !== "all" || filterMonth !== "all" || filterTurno !== "all") && React.createElement("button", {
                    onClick: () => { setFilterYear("all"); setFilterMonth("all"); setFilterTurno("all"); setSelectedMonths([]); },
                    style: { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.border}`, background: "#fff", fontSize: 11, fontWeight: 600, color: C.gray, cursor: "pointer" }
                }, "✕ Limpiar filtros")
            )
        ),

        // ── KPI CARDS ──────────────────────────────────────────────────────────
        kpis.tO > 0 && React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 24 } },
            React.createElement(StatKpi, { label: "Llamadas Ofrecidas", value: kpis.tO.toLocaleString("es-AR"), accent: C.mid }),
            React.createElement(StatKpi, { label: "Contestadas", value: kpis.tC.toLocaleString("es-AR"), sub: `${kpis.pctAt.toFixed(1)}%`, accent: C.green }),
            React.createElement(StatKpi, { label: "Abandonadas", value: kpis.tA.toLocaleString("es-AR"), sub: `${kpis.pctAb.toFixed(1)}%`, accent: C.red }),
            React.createElement(StatKpi, { label: "Aband. en Cola", value: kpis.tEC.toLocaleString("es-AR"), accent: C.orange }),
            React.createElement(StatKpi, { label: "Aband. Avisando", value: kpis.tAV.toLocaleString("es-AR"), accent: C.yellow }),
            React.createElement(StatKpi, { label: "Tiempo Manejo Prom.", value: kpis.avgManejo ? fmtSeconds(kpis.avgManejo) : "—", accent: "#7c3aed" })
        ),

        // ── MONTHLY COMPARISON KPI TABLE ──────────────────────────────────────
        monthlyCompData && monthlyCompData.length >= 1 && React.createElement(Card, { style: { marginBottom: 24, padding: "24px 28px" } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 } },
                React.createElement("div", null,
                    React.createElement("div", { style: { fontWeight: 900, fontSize: 17, color: C.navy, display: "flex", alignItems: "center", gap: 8 } },
                        "📐 Comparativa Numérica Mensual"
                    ),
                    React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 3 } },
                        monthlyCompData.length > 1
                            ? "Variación mes a mes — flechas verdes indican mejora, rojas indican deterioro"
                            : "Métricas del mes seleccionado"
                    )
                ),
                monthlyCompData.length > 1 && React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 10 } },
                        React.createElement("span", { style: { color: C.green, fontWeight: 900 } }, "▲"),
                        React.createElement("span", { style: { color: C.gray } }, "Mejora")
                    ),
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 10 } },
                        React.createElement("span", { style: { color: C.red, fontWeight: 900 } }, "▼"),
                        React.createElement("span", { style: { color: C.gray } }, "Deterioro")
                    )
                )
            ),

            // ── Top-level "latest month vs previous" highlight cards ──
            monthlyCompData.length >= 2 && (() => {
                const latest = monthlyCompData[monthlyCompData.length - 1];
                const prev = monthlyCompData[monthlyCompData.length - 2];
                const d = latest.deltas;
                if (!d) return null;

                const DeltaKpi = ({ label, value, delta, unit, invertColor, icon }) => {
                    // invertColor: for metrics where "up = bad" (e.g., abandonadas, % abandono)
                    const isPositive = invertColor ? delta < 0 : delta > 0;
                    const isNeutral = Math.abs(delta) < 0.5;
                    const arrow = isNeutral ? "→" : (delta > 0 ? "▲" : "▼");
                    const deltaColor = isNeutral ? C.gray : (isPositive ? C.green : C.red);
                    const deltaBg = isNeutral ? "#f1f5f9" : (isPositive ? C.greenBg : C.redBg);

                    return React.createElement("div", {
                        style: {
                            background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12,
                            padding: "16px 18px", flex: 1, minWidth: 160, position: "relative", overflow: "hidden"
                        }
                    },
                        React.createElement("div", { style: { position: "absolute", top: 0, left: 0, right: 0, height: 3, background: deltaColor } }),
                        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, marginTop: 2 } },
                            React.createElement("span", { style: { fontSize: 16 } }, icon),
                            React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase", letterSpacing: 0.8 } }, label)
                        ),
                        React.createElement("div", { style: { fontSize: 28, fontWeight: 900, color: C.navy, lineHeight: 1, marginBottom: 8 } }, value),
                        React.createElement("div", { style: { display: "inline-flex", alignItems: "center", gap: 4, background: deltaBg, borderRadius: 6, padding: "4px 10px" } },
                            React.createElement("span", { style: { fontSize: 11, fontWeight: 900, color: deltaColor } }, arrow),
                            React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: deltaColor } },
                                `${Math.abs(delta).toFixed(1)}${unit || "%"} vs ${prev.label}`
                            )
                        )
                    );
                };

                return React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 20 } },
                    React.createElement(DeltaKpi, {
                        label: "Total Llamadas", icon: "📞",
                        value: latest.ofrecidas.toLocaleString("es-AR"),
                        delta: d.ofrecidas, invertColor: false
                    }),
                    React.createElement(DeltaKpi, {
                        label: "% Atención", icon: "✅",
                        value: `${latest.pctAt.toFixed(1)}%`,
                        delta: d.pctAt, unit: " pp", invertColor: false
                    }),
                    React.createElement(DeltaKpi, {
                        label: "% Abandono", icon: "🔴",
                        value: `${latest.pctAb.toFixed(1)}%`,
                        delta: d.pctAb, unit: " pp", invertColor: true
                    }),
                    React.createElement(DeltaKpi, {
                        label: "Abandonadas", icon: "📉",
                        value: latest.abandonadas.toLocaleString("es-AR"),
                        delta: d.abandonadas, invertColor: true
                    })
                );
            })(),

            // ── Full comparison table ──
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: `linear-gradient(135deg, ${C.navy}, ${C.blue})` } },
                            ["Mes", "Ofrecidas", "Δ", "Contestadas", "Δ", "Abandonadas", "Δ", "% Aband.", "Δ pp", "% Atenc.", "Δ pp", "Prom/Día", "T. Prom. Avisando", "T. Promedio"].map(h =>
                                React.createElement("th", {
                                    key: h + Math.random(), style: {
                                        padding: "10px 8px", color: "#fff", fontWeight: 700, textAlign: "center",
                                        fontSize: h === "Mes" ? 11 : 10, whiteSpace: "nowrap",
                                        borderRight: ["Δ", "Δ pp"].includes(h) ? "2px solid rgba(255,255,255,0.1)" : "none"
                                    }
                                }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        monthlyCompData.map((m, i) => {
                            const d = m.deltas;
                            const DeltaCell = ({ val, invert, unit }) => {
                                if (!d || val === undefined || val === null) return React.createElement("td", { style: { padding: "8px 6px", textAlign: "center", color: "#cbd5e1", fontSize: 10 } }, "—");
                                const isNeutral = Math.abs(val) < 0.5;
                                const isGood = invert ? val < 0 : val > 0;
                                const color = isNeutral ? C.gray : (isGood ? C.green : C.red);
                                const bg = isNeutral ? "transparent" : (isGood ? "rgba(22,163,74,0.08)" : "rgba(220,38,38,0.08)");
                                const arrow = isNeutral ? "→" : (val > 0 ? "▲" : "▼");
                                return React.createElement("td", { style: { padding: "6px 6px", textAlign: "center", background: bg, borderRight: "2px solid #f1f5f9" } },
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: 2 } },
                                        React.createElement("span", { style: { fontSize: 9, fontWeight: 900, color } }, arrow),
                                        React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color } }, `${Math.abs(val).toFixed(1)}${unit || "%"}`)
                                    )
                                );
                            };
                            return React.createElement("tr", {
                                key: m.firestoreId, style: {
                                    background: i % 2 === 0 ? "#f8fafc" : "#fff",
                                    borderBottom: `1px solid ${C.border}`,
                                    transition: "background .15s"
                                }
                            },
                                React.createElement("td", { style: { padding: "10px 10px", fontWeight: 800, color: C.navy, whiteSpace: "nowrap", fontSize: 12 } }, m.label),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 700, color: C.mid, fontSize: 13 } }, m.ofrecidas.toLocaleString("es-AR")),
                                React.createElement(DeltaCell, { val: d?.ofrecidas, invert: false }),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 700, color: C.green, fontSize: 13 } }, m.contestadas.toLocaleString("es-AR")),
                                React.createElement(DeltaCell, { val: d?.contestadas, invert: false }),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 700, color: C.red, fontSize: 13 } }, m.abandonadas.toLocaleString("es-AR")),
                                React.createElement(DeltaCell, { val: d?.abandonadas, invert: true }),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center" } },
                                    React.createElement("span", {
                                        style: {
                                            background: m.pctAb > 25 ? C.redBg : m.pctAb > 15 ? C.orBg : C.greenBg,
                                            color: m.pctAb > 25 ? C.red : m.pctAb > 15 ? C.orange : C.green,
                                            borderRadius: 6, padding: "3px 8px", fontWeight: 800, fontSize: 12
                                        }
                                    }, `${m.pctAb.toFixed(1)}%`)
                                ),
                                React.createElement(DeltaCell, { val: d?.pctAb, invert: true, unit: "" }),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center" } },
                                    React.createElement("span", {
                                        style: {
                                            background: m.pctAt >= 85 ? C.greenBg : m.pctAt >= 70 ? C.ylBg : C.redBg,
                                            color: m.pctAt >= 85 ? C.green : m.pctAt >= 70 ? C.yellow : C.red,
                                            borderRadius: 6, padding: "3px 8px", fontWeight: 800, fontSize: 12
                                        }
                                    }, `${m.pctAt.toFixed(1)}%`)
                                ),
                                React.createElement(DeltaCell, { val: d?.pctAt, invert: false, unit: "" }),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 600, color: C.navy, fontSize: 12 } }, m.promDiario.toLocaleString("es-AR")),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontFamily: "monospace", color: C.blue, fontSize: 11, fontWeight: 700 } },
                                    m.avgAvisando ? fmtSeconds(m.avgAvisando) : "—"
                                ),
                                React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontFamily: "monospace", fontWeight: 700, color: "#7c3aed", fontSize: 12 } }, m.avgManejo ? fmtSeconds(m.avgManejo) : "—")
                            );
                        })
                    ),
                    // Totals footer
                    monthlyCompData.length > 1 && React.createElement("tfoot", null,
                        React.createElement("tr", { style: { background: C.navy, color: "#fff" } },
                            React.createElement("td", { style: { padding: "10px 10px", fontWeight: 800, fontSize: 12 } }, "TOTAL"),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 13 } }, kpis.tO.toLocaleString("es-AR")),
                            React.createElement("td", { style: { padding: "10px 8px" } }),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 13 } }, kpis.tC.toLocaleString("es-AR")),
                            React.createElement("td", { style: { padding: "10px 8px" } }),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 13 } }, kpis.tA.toLocaleString("es-AR")),
                            React.createElement("td", { style: { padding: "10px 8px" } }),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 12 } }, `${kpis.pctAb.toFixed(1)}%`),
                            React.createElement("td", { style: { padding: "10px 8px" } }),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 12 } }, `${kpis.pctAt.toFixed(1)}%`),
                            React.createElement("td", { style: { padding: "10px 8px" } }),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 12 } },
                                (() => { const avg = monthlyCompData.length ? Math.round(monthlyCompData.reduce((s, m) => s + m.promDiario, 0) / monthlyCompData.length) : 0; return avg.toLocaleString("es-AR"); })()
                            ),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 11, color: "#fff" } },
                                fmtSeconds(kpis.avgAvisando)
                            ),
                            React.createElement("td", { style: { padding: "10px 8px", textAlign: "center", fontWeight: 800, fontSize: 11, color: "#fff" } },
                                fmtSeconds(kpis.avgManejo)
                            )
                        )
                    )
                )
            ),

            // ── Promedio diario de abandonadas comparison (Ranking Style) ──
            monthlyCompData.length >= 2 && React.createElement("div", { style: { marginTop: 24, paddingTop: 24, borderTop: `1px dashed ${C.border}` } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontWeight: 900, fontSize: 14, color: C.navy } }, "📊 Ranking de Desempeño (Abandono)"),
                        React.createElement("div", { style: { fontSize: 11, color: C.gray, marginTop: 2 } }, "Comparativa de tasa de abandono y promedio diario por mes")
                    ),
                    (() => {
                        const avgAb = (monthlyCompData.reduce((s, m) => s + m.pctAb, 0) / monthlyCompData.length).toFixed(1);
                        return React.createElement("div", { style: { background: "#f1f5f9", padding: "6px 12px", borderRadius: 8, textAlign: "right" } },
                            React.createElement("div", { style: { fontSize: 9, fontWeight: 700, color: C.gray, textTransform: "uppercase" } }, "Promedio Global"),
                            React.createElement("div", { style: { fontSize: 13, fontWeight: 900, color: C.navy } }, `${avgAb}%`)
                        );
                    })()
                ),
                React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
                    (() => {
                        const sortedByAb = [...monthlyCompData].sort((a, b) => b.pctAb - a.pctAb);
                        const maxAbd = Math.max(...monthlyCompData.map(m => m.promAbandDiario), 1);

                        return sortedByAb.map((m, i) => {
                            const barColor = m.pctAb > 25 ? C.red : m.pctAb > 15 ? C.orange : C.green;
                            const bgAlpha = m.pctAb > 25 ? "rgba(220,38,38,0.1)" : m.pctAb > 15 ? "rgba(249,115,22,0.1)" : "rgba(22,163,74,0.1)";

                            return React.createElement("div", { key: m.firestoreId, style: { display: "grid", gridTemplateColumns: "140px 1fr 100px", alignItems: "center", gap: 15, padding: "8px 12px", borderRadius: 10, background: i === 0 && m.pctAb > 25 ? "rgba(220,38,38,0.03)" : "transparent" } },
                                // Month Label
                                React.createElement("div", { style: { fontWeight: 800, fontSize: 12, color: C.navy, display: "flex", alignItems: "center", gap: 8 } },
                                    React.createElement("span", { style: { width: 18, height: 18, borderRadius: 5, background: i === 0 ? C.navy : "#e2e8f0", color: i === 0 ? "#fff" : C.gray, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center" } }, i + 1),
                                    m.label
                                ),
                                // Progress Bar for Rate
                                React.createElement("div", { style: { position: "relative" } },
                                    React.createElement("div", { style: { width: "100%", height: 8, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" } },
                                        React.createElement("div", { style: { width: `${Math.min(m.pctAb * 2, 100)}%`, height: "100%", background: barColor, borderRadius: 4, transition: "width .6s ease-out" } })
                                    ),
                                    React.createElement("div", { style: { position: "absolute", top: -14, left: `${Math.min(m.pctAb * 2, 100)}%`, fontSize: 9, fontWeight: 800, color: barColor, transform: "translateX(-50%)", whiteSpace: "nowrap" } }, `${m.pctAb.toFixed(1)}%`)
                                ),
                                // Volume Indicator
                                React.createElement("div", { style: { textAlign: "right" } },
                                    React.createElement("div", { style: { fontSize: 13, fontWeight: 900, color: C.navy } }, m.promAbandDiario),
                                    React.createElement("div", { style: { fontSize: 9, fontWeight: 600, color: C.gray, textTransform: "uppercase" } }, "aband./día")
                                )
                            );
                        });
                    })()
                )
            )
        ),

        // ── PER-MONTH KPI CARDS (general → particular) ────────────────────────
        filteredHistory.length > 0 && React.createElement("div", { style: { marginBottom: 24 } },
            React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 } },
                "📅 KPIs por Mes",
                React.createElement("span", { style: { fontSize: 11, fontWeight: 600, color: C.gray, background: "#f1f5f9", borderRadius: 99, padding: "3px 10px" } }, `${filteredHistory.length} ${filteredHistory.length === 1 ? "mes" : "meses"}`)
            ),
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 } },
                (() => {
                    // Compute max ofrecidas across visible months for relative bar sizing
                    const allRO = filteredHistory.map(h => {
                        if (!h) return 0;
                        const rows = filterDetailsByTurno(h.detalles, filterTurno);
                        return rows && rows.length ? rows.reduce((s, r) => s + (r?.o || 0), 0) : (h.resumen?.totalOfrecidas || 0);
                    });
                    const maxRO = Math.max(...allRO, 1);

                    return filteredHistory.map((h, i) => {
                        const rows = filterDetailsByTurno(h.detalles, filterTurno);
                        let rO, rC, rA, rEC, rAV, rM;
                        if (rows && rows.length) {
                            rO = rows.reduce((s, r) => s + (r?.o || 0), 0);
                            rC = rows.reduce((s, r) => s + (r?.c || 0), 0);
                            rA = rows.reduce((s, r) => s + (r?.ab || 0), 0);
                            rEC = rows.reduce((s, r) => s + (r?.ec || 0), 0);
                            rAV = rows.reduce((s, r) => s + (r?.av || 0), 0);
                            const mRows = rows.filter(r => r && r.manejo);
                            rM = mRows.length ? Math.round(mRows.reduce((s, r) => s + r.manejo, 0) / mRows.length) : 0;
                        } else if (h.resumen) {
                            rO = h.resumen.totalOfrecidas || 0; rC = h.resumen.totalContestadas || 0; rA = h.resumen.totalAbandonadas || 0;
                            rEC = 0; rAV = 0; rM = 0;
                        } else {
                            rO = 0; rC = 0; rA = 0; rEC = 0; rAV = 0; rM = 0;
                        }
                        const pctAt = rO ? (rC / rO * 100) : 0;
                        const pctAb = rO ? (rA / rO * 100) : 0;
                        const isSel = selectedMonths.includes(h.firestoreId);
                        const atColor = pctAt >= 85 ? C.green : pctAt >= 70 ? C.yellow : C.red;
                        const abColor = pctAb > 25 ? C.red : pctAb > 15 ? C.orange : C.green;

                        return React.createElement("div", {
                            key: h.firestoreId,
                            onClick: () => setSelectedMonths(s => isSel ? s.filter(x => x !== h.firestoreId) : [...s, h.firestoreId]),
                            style: {
                                background: "#fff", borderRadius: 12, padding: "18px 20px",
                                border: `2px solid ${isSel ? C.blue : C.border}`,
                                boxShadow: isSel ? `0 4px 20px rgba(27,58,107,0.15)` : "0 1px 4px rgba(0,0,0,0.04)",
                                cursor: "pointer", transition: "all .2s",
                                position: "relative", overflow: "hidden"
                            }
                        },
                            // Accent top bar
                            React.createElement("div", { style: { position: "absolute", top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(90deg, ${C.blue}, ${C.mid})`, borderRadius: "12px 12px 0 0" } }),
                            // Header row
                            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, marginTop: 4 } },
                                React.createElement("div", null,
                                    React.createElement("div", { style: { fontWeight: 900, fontSize: 16, color: C.navy } }, h.meta.label),
                                    React.createElement("div", { style: { fontSize: 10, color: C.gray, marginTop: 2 } }, `${h.meta.year} — ${MONTH_NAMES[h.meta.monthNum] || ""}`)
                                ),
                                isSel && React.createElement("div", { style: { background: C.light, color: C.blue, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700 } }, "✓ Seleccionado")
                            ),
                            // Main metric: ofrecidas with relative bar
                            React.createElement("div", { style: { marginBottom: 12 } },
                                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 } },
                                    React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase", letterSpacing: 0.8 } }, "Llamadas Ofrecidas"),
                                    React.createElement("span", { style: { fontSize: 22, fontWeight: 900, color: C.mid } }, rO.toLocaleString("es-AR"))
                                ),
                                React.createElement("div", { style: { background: "#f1f5f9", borderRadius: 99, height: 6, overflow: "hidden" } },
                                    React.createElement("div", { style: { width: `${(rO / maxRO) * 100}%`, background: `linear-gradient(90deg, ${C.blue}, ${C.mid})`, height: "100%", borderRadius: 99, transition: "width .4s" } })
                                )
                            ),
                            // 3-stat row: contestadas, abandonadas, rates
                            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 } },
                                // Contestadas
                                React.createElement("div", { style: { background: C.greenBg, borderRadius: 8, padding: "10px 10px" } },
                                    React.createElement("div", { style: { fontSize: 9, fontWeight: 700, color: C.green, textTransform: "uppercase", marginBottom: 3 } }, "Contestadas"),
                                    React.createElement("div", { style: { fontSize: 18, fontWeight: 900, color: C.green, lineHeight: 1 } }, rC.toLocaleString("es-AR")),
                                    React.createElement("div", { style: { fontSize: 10, color: C.green, marginTop: 3 } }, `${pctAt.toFixed(1)}%`)
                                ),
                                // Abandonadas
                                React.createElement("div", { style: { background: C.redBg, borderRadius: 8, padding: "10px 10px" } },
                                    React.createElement("div", { style: { fontSize: 9, fontWeight: 700, color: C.red, textTransform: "uppercase", marginBottom: 3 } }, "Abandonadas"),
                                    React.createElement("div", { style: { fontSize: 18, fontWeight: 900, color: C.red, lineHeight: 1 } }, rA.toLocaleString("es-AR")),
                                    React.createElement("div", { style: { fontSize: 10, color: C.red, marginTop: 3 } }, `${pctAb.toFixed(1)}%`)
                                ),
                                // Manejo promedio
                                React.createElement("div", { style: { background: "#f5f3ff", borderRadius: 8, padding: "10px 10px" } },
                                    React.createElement("div", { style: { fontSize: 9, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", marginBottom: 3 } }, "T. Manejo"),
                                    React.createElement("div", { style: { fontSize: 18, fontWeight: 900, color: "#7c3aed", lineHeight: 1 } }, rM ? fmtSeconds(rM) : "—"),
                                    React.createElement("div", { style: { fontSize: 10, color: "#7c3aed", marginTop: 3 } }, "promedio")
                                )
                            ),
                            // Rate badges + cola/avisando
                            React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
                                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, background: pctAt >= 85 ? C.greenBg : pctAt >= 70 ? C.ylBg : C.redBg, borderRadius: 6, padding: "4px 8px" } },
                                    React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: atColor } }, `✓ ${pctAt.toFixed(1)}% atendidas`)
                                ),
                                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, background: pctAb > 25 ? C.redBg : pctAb > 15 ? C.orBg : C.greenBg, borderRadius: 6, padding: "4px 8px" } },
                                    React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: abColor } }, `✕ ${pctAb.toFixed(1)}% abandono`)
                                ),
                                rEC > 0 && React.createElement("div", { style: { background: C.orBg, borderRadius: 6, padding: "4px 8px" } },
                                    React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: C.orange } }, `Cola: ${rEC.toLocaleString()}`)
                                ),
                                rAV > 0 && React.createElement("div", { style: { background: C.ylBg, borderRadius: 6, padding: "4px 8px" } },
                                    React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: C.yellow } }, `Avisando: ${rAV.toLocaleString()}`)
                                )
                            )
                        );
                    });
                })()
            )
        ),

        // ── MONTH COMPARISON SELECTION ────────────────────────────────────────
        filteredHistory.length > 1 && React.createElement("div", { style: { marginBottom: 16, display: "flex", alignItems: "center", gap: 8 } },
            React.createElement("div", { style: { fontSize: 12, color: C.gray, fontWeight: 600 } }, "💡 Hacé clic en las tarjetas para seleccionar meses y comparar sus gráficos"),
            selectedMonths.length > 0 && React.createElement("button", {
                onClick: () => setSelectedMonths([]),
                style: { padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "#fff", fontSize: 11, fontWeight: 600, color: C.gray, cursor: "pointer" }
            }, "✕ Deseleccionar todo")
        ),

        // ── COMPARISON CHART ──────────────────────────────────────────────────
        compChart && React.createElement(Card, { style: { marginBottom: 20 }, className: "page-break" },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } },
                React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy } }, "📊 Comparativa Mensual"),
                filterTurno !== "all" && React.createElement(Badge, { label: turnoLabel, color: C.blue, bg: C.light })
            ),
            React.createElement("div", { style: { height: 340 } }, React.createElement(ChartBar, { id: "chart-monthly-comp", data: compChart, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, padding: 14 } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10, weight: "bold" } } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
        ),

        // ── DAILY TREND LINE CHART ────────────────────────────────────────────
        dailyChart && React.createElement(Card, { style: { marginBottom: 20 } },
            React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 16 } }, "📈 Tendencia Diaria"),
            React.createElement("div", { style: { height: 300 } }, React.createElement(ChartLine, { id: "chart-daily-trend", data: dailyChart, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 11 } } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45 } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
        ),

        // ── HOURLY DISTRIBUTION + TURNO COMPARISON ────────────────────────────
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: turnoCompChart ? "3fr 2fr" : "1fr", gap: 16, marginBottom: 20 } },
            hourlyChart && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 16 } }, "⏰ Distribución Horaria"),
                React.createElement("div", { style: { height: 280 } }, React.createElement(ChartBar, { id: "chart-hourly-dist", data: hourlyChart, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 10 } } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 8 }, maxRotation: 45 } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
            ),
            turnoCompChart && React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 16 } }, "☀️🌙 Comparativa por Turno"),
                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 } },
                    // Day shift stats
                    React.createElement("div", { style: { background: "rgba(46,95,163,0.06)", borderRadius: 10, padding: "14px", border: `1px solid rgba(46,95,163,0.15)` } },
                        React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase", marginBottom: 6 } }, "☀️ Diurno"),
                        React.createElement("div", { style: { fontSize: 22, fontWeight: 900, color: C.mid, lineHeight: 1 } }, turnoCompChart.stats.diaO.toLocaleString()),
                        React.createElement("div", { style: { fontSize: 10, color: C.gray, marginTop: 4 } }, `${turnoCompChart.stats.diaO ? ((turnoCompChart.stats.diaA / turnoCompChart.stats.diaO) * 100).toFixed(1) : 0}% abandono`)
                    ),
                    // Night shift stats
                    React.createElement("div", { style: { background: "rgba(15,36,68,0.06)", borderRadius: 10, padding: "14px", border: `1px solid rgba(15,36,68,0.15)` } },
                        React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: C.gray, textTransform: "uppercase", marginBottom: 6 } }, "🌙 Nocturno"),
                        React.createElement("div", { style: { fontSize: 22, fontWeight: 900, color: C.navy, lineHeight: 1 } }, turnoCompChart.stats.nocO.toLocaleString()),
                        React.createElement("div", { style: { fontSize: 10, color: C.gray, marginTop: 4 } }, `${turnoCompChart.stats.nocO ? ((turnoCompChart.stats.nocA / turnoCompChart.stats.nocO) * 100).toFixed(1) : 0}% abandono`)
                    )
                ),
                React.createElement("div", { style: { height: 160 } }, React.createElement(ChartBar, { id: "chart-turno-bar", data: turnoCompChart.bar, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 10 } } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
            )
        ),

        // ── WEEKDAY DISTRIBUTION ──────────────────────────────────────────────
        weekDayChart && React.createElement(Card, { style: { marginBottom: 20 } },
            React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 16 } }, "📅 Distribución por Día de la Semana"),
            React.createElement("div", { style: { height: 280 } }, React.createElement(ChartLine, { id: "chart-weekday-dist", data: weekDayChart, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { font: { size: 10 } } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10, weight: "bold" } } }, y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } } } } }))
        ),

        // ── HEATMAP ────────────────────────────────────────────────────────────
        (() => {
            const single = selectedMonths.length === 1
                ? history.find(h => h.firestoreId === selectedMonths[0])
                : (filteredHistory.length === 1 ? filteredHistory[0] : null);
            if (!single || !single.detalles) return null;
            return React.createElement(MensualHeatmap, { report: single, turnoFilter: filterTurno, className: "page-break" });
        })(),

        // ── TABLE ──────────────────────────────────────────────────────────────
        filteredHistory.length > 0 && React.createElement(Card, { style: { marginTop: 4 }, className: "page-break" },
            React.createElement("div", { style: { fontWeight: 800, fontSize: 15, color: C.navy, marginBottom: 16 } }, "📋 Registros Mensuales"),
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: C.blue, color: "#fff" } },
                            ["Mes/Año", "Ofrecidas", "Contestadas", "Abandonadas", "A. en Cola", "A. Avisando", "% Atenc.", "% Aband.", "T. Manejo Prom."].map(h => React.createElement("th", { key: h, style: { padding: "10px 8px", textAlign: "center", fontSize: 11, fontWeight: 700 } }, h))
                        )
                    ),
                    React.createElement("tbody", null,
                        filteredHistory.map((h, i) => {
                            if (!h) return null;
                            const rows = filterDetailsByTurno(h.detalles, filterTurno);
                            let rO, rC, rA, rEC, rAV, rM;
                            if (rows && rows.length) {
                                rO = rows.reduce((s, r) => s + (r?.o || 0), 0);
                                rC = rows.reduce((s, r) => s + (r?.c || 0), 0);
                                rA = rows.reduce((s, r) => s + (r?.ab || 0), 0);
                                rEC = rows.reduce((s, r) => s + (r?.ec || 0), 0);
                                rAV = rows.reduce((s, r) => s + (r?.av || 0), 0);
                                const mRows = rows.filter(r => r && r.manejo);
                                rM = mRows.length ? Math.round(mRows.reduce((s, r) => s + r.manejo, 0) / mRows.length) : 0;
                            } else if (h.resumen) {
                                rO = h.resumen.totalOfrecidas || 0;
                                rC = h.resumen.totalContestadas || 0;
                                rA = h.resumen.totalAbandonadas || 0;
                                rEC = 0; rAV = 0; rM = 0;
                            } else {
                                rO = 0; rC = 0; rA = 0; rEC = 0; rAV = 0; rM = 0;
                            }
                            const pctAt = rO ? (rC / rO * 100).toFixed(1) : "0"; const pctAb = rO ? (rA / rO * 100).toFixed(1) : "0";
                            return React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#f8fafc" : "#fff", borderBottom: `1px solid ${C.border}` } },
                                React.createElement("td", { style: { padding: "10px", fontWeight: 800, textAlign: "center", color: C.navy } }, h.meta.label),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center", fontWeight: 600 } }, rO.toLocaleString()),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center", color: C.green, fontWeight: 700 } }, rC.toLocaleString()),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center", color: C.red, fontWeight: 700 } }, rA.toLocaleString()),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center", color: C.orange, fontWeight: 600 } }, rEC.toLocaleString()),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center", color: C.yellow, fontWeight: 600 } }, rAV.toLocaleString()),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center" } }, React.createElement(Badge, { label: `${pctAt}%`, color: parseFloat(pctAt) >= 80 ? C.green : C.yellow, bg: parseFloat(pctAt) >= 80 ? C.greenBg : C.ylBg })),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center" } }, React.createElement(Badge, { label: `${pctAb}%`, color: parseFloat(pctAb) > 25 ? C.red : parseFloat(pctAb) > 15 ? C.orange : C.green, bg: parseFloat(pctAb) > 25 ? C.redBg : parseFloat(pctAb) > 15 ? C.orBg : C.greenBg })),
                                React.createElement("td", { style: { padding: "10px", textAlign: "center", fontFamily: "monospace", fontWeight: 600 } }, rM ? fmtSeconds(rM) : "—")
                            );
                        })
                    )
                )
            )
        )
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT: ENHANCED HEATMAP (with turno awareness)
// ─────────────────────────────────────────────────────────────────────────────
function MensualHeatmap({ report, turnoFilter }) {
    const [metric, setMetric] = useState("total");

    const grid = useMemo(() => {
        const data = filterDetailsByTurno(report.detalles, turnoFilter);

        const matrix = {};
        let max = 0;
        data.forEach(row => {
            const h = (row.h || "00:00").substring(0, 2) + ":00";
            const d = row.d;
            let val = 0;
            if (metric === "total") val = row.o || 0;
            else if (metric === "cnt") val = row.c || 0;
            else if (metric === "abd") val = row.ab !== undefined ? row.ab : ((row.o || 0) - (row.c || 0));
            if (!matrix[h]) matrix[h] = {};
            matrix[h][d] = (matrix[h][d] || 0) + val;
            if (matrix[h][d] > max) max = matrix[h][d];
        });
        return { matrix, max };
    }, [report, metric]);

    const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00`);
    const days = Array.from({ length: 31 }, (_, i) => i + 1);

    return React.createElement(Card, { style: { marginBottom: 24, padding: "20px" } },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontWeight: 800, fontSize: 16, color: C.navy } }, `🔥 Análisis Crítico: ${report.meta.label}`),
                React.createElement("div", { style: { fontSize: 12, color: C.gray } }, "Mapa de calor por hora y día")
            ),
            React.createElement("div", { style: { display: "flex", background: "#f1f5f9", borderRadius: 8, padding: 4, gap: 4 } },
                [
                    { id: "total", label: "Ofrecidas" },
                    { id: "cnt", label: "Contestadas" },
                    { id: "abd", label: "Abandonadas" }
                ].map(m =>
                    React.createElement("button", {
                        key: m.id,
                        onClick: () => setMetric(m.id),
                        style: {
                            padding: "6px 12px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer",
                            background: metric === m.id ? "#fff" : "transparent",
                            color: metric === m.id ? C.blue : C.gray,
                            boxShadow: metric === m.id ? "0 2px 4px rgba(0,0,0,0.05)" : "none"
                        }
                    }, m.label)
                )
            )
        ),

        React.createElement("div", { style: { overflowX: "auto" } },
            React.createElement("div", { style: { minWidth: 800 } },
                // Header de días
                React.createElement("div", { style: { display: "flex", marginBottom: 4 } },
                    React.createElement("div", { style: { width: 45 } }),
                    days.map(d => React.createElement("div", { key: d, style: { flex: 1, textAlign: "center", fontSize: 9, color: C.gray, fontWeight: 600 } }, d))
                ),
                // Filas de horas
                hours.map(h =>
                    React.createElement("div", { key: h, style: { display: "flex", gap: 2, marginBottom: 2 } },
                        React.createElement("div", { style: { width: 45, fontSize: 9, color: C.gray, fontWeight: 700, display: "flex", alignItems: "center" } }, h),
                        days.map(d => {
                            const val = grid.matrix[h]?.[d] || 0;
                            const intensity = grid.max > 0 ? (val / grid.max) : 0;
                            // Escala de color: de gris claro a rojo intenso
                            const bg = val === 0 ? "#f8fafc" : `rgba(220, 38, 38, ${0.1 + intensity * 0.9})`;
                            const color = intensity > 0.6 ? "#fff" : C.navy;

                            return React.createElement("div", {
                                key: d,
                                title: `Día ${d}, ${h}: ${val} ${metric}`,
                                style: {
                                    flex: 1, height: 24, background: bg, borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, color: color,
                                    transition: "all .2s"
                                }
                            }, val > 0 ? val : "");
                        })
                    )
                )
            )
        ),

        React.createElement("div", { style: { marginTop: 16, display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: C.gray } },
            React.createElement("span", null, "Menos crítico"),
            React.createElement("div", { style: { flex: 1, height: 8, borderRadius: 4, background: `linear-gradient(to right, #f8fafc, #dc2626)` } }),
            React.createElement("span", null, "Más crítico")
        )
    );
}


// ════════════════════════════════════════════════════════════════════════════
//  VIEW: COMPARATIVA DE GRUPOS
// ════════════════════════════════════════════════════════════════════════════
function ViewComparativaGrupos({ user, onBack }) {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState({
        month: (new Date().getMonth() + 1).toString().padStart(2, "0"),
        year: new Date().getFullYear().toString()
    });

    const loadData = async () => {
        setLoading(true);
        const res = await getPerformanceByGroup(filter.month, filter.year);
        setData(res);
        setLoading(false);
    };

    useEffect(() => { loadData(); }, [filter]);

    const stats = useMemo(() => {
        if (!data.length) return null;
        const totalC = data.reduce((s, g) => s + g.c, 0);
        const bestAb = [...data].sort((a, b) => a.pctAb - b.pctAb)[0];
        const bestProd = [...data].sort((a, b) => (b.c / (b.ops || 1)) - (a.c / (a.ops || 1)))[0];
        return { totalC, bestAb, bestProd };
    }, [data]);

    return React.createElement("div", { className: "animate-fade" },
        // Header
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
                React.createElement("button", { onClick: onBack, style: { background: "#fff", border: `1px solid ${C.border}`, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.navy } }, "←"),
                React.createElement("div", null,
                    React.createElement("h2", { style: { margin: 0, color: C.navy, fontWeight: 900 } }, "👥 Comparativa de Grupos"),
                    React.createElement("p", { style: { margin: "4px 0 0", color: C.gray, fontSize: 13 } }, "Métricas agregadas por Célula/Grupo")
                )
            ),
            React.createElement("div", { style: { display: "flex", gap: 12 } },
                React.createElement("select", {
                    value: filter.month,
                    onChange: e => setFilter({ ...filter, month: e.target.value }),
                    style: { padding: "10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 600 }
                },
                    ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map(m =>
                        React.createElement("option", { key: m, value: m }, m)
                    )
                ),
                React.createElement("select", {
                    value: filter.year,
                    onChange: e => setFilter({ ...filter, year: e.target.value }),
                    style: { padding: "10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 600 }
                },
                    ["2025", "2026", "2027"].map(y => React.createElement("option", { key: y, value: y }, y))
                )
            )
        ),

        loading ? React.createElement("div", { style: { textAlign: "center", padding: 40, color: C.gray } }, "Cargando comparativa…") :
            data.length === 0 ? React.createElement("div", { style: { textAlign: "center", padding: 40, background: "#fff", borderRadius: 12, color: C.gray } }, "No hay datos para este periodo.") :
                React.createElement(React.Fragment, null,
                    // KPI Cards
                    stats && React.createElement("div", { style: { display: "flex", gap: 16, marginBottom: 24 } },
                        React.createElement(StatKpi, { label: "Total Contestadas", value: stats.totalC.toLocaleString(), accent: C.blue }),
                        React.createElement(StatKpi, { label: "Grupo Menor Abandono", value: stats.bestAb.group, sub: `${stats.bestAb.pctAb.toFixed(1)}% de tasa`, accent: C.green }),
                        React.createElement(StatKpi, { label: "Grupo Más Productivo", value: stats.bestProd.group, sub: `${(stats.bestProd.c / (stats.bestProd.ops || 1)).toFixed(0)} llam./op`, accent: C.mid })
                    ),

                    // Charts Grid
                    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 } },
                        // Chart 1: Abandono
                        React.createElement(Card, { style: { padding: 20 } },
                            React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 16 } }, "📉 Tasa de Abandono por Grupo (%)"),
                            React.createElement("div", { style: { height: 260 } },
                                React.createElement(ChartBar, {
                                    id: "chart-group-abandon",
                                    data: {
                                        labels: data.map(g => g.group),
                                        datasets: [{
                                            label: "% Abandono",
                                            data: data.map(g => g.pctAb.toFixed(1)),
                                            backgroundColor: data.map(g => g.pctAb > 20 ? C.red : g.pctAb > 10 ? C.orange : C.green),
                                            borderRadius: 6
                                        }]
                                    },
                                    options: {
                                        responsive: true, maintainAspectRatio: false,
                                        scales: { y: { beginAtZero: true, ticks: { callback: v => v + "%" } } }
                                    }
                                })
                            )
                        ),
                        // Chart 2: TMO (Manejo)
                        React.createElement(Card, { style: { padding: 20 } },
                            React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: C.navy, marginBottom: 16 } }, "⏱ Tiempo de Manejo Promedio"),
                            React.createElement("div", { style: { height: 260 } },
                                React.createElement(ChartBar, {
                                    id: "chart-group-tmo",
                                    data: {
                                        labels: data.map(g => g.group),
                                        datasets: [{
                                            label: "Segundos",
                                            data: data.map(g => g.avgManejo),
                                            backgroundColor: C.mid,
                                            borderRadius: 6
                                        }]
                                    },
                                    options: {
                                        responsive: true, maintainAspectRatio: false,
                                        plugins: { tooltip: { callbacks: { label: ctx => fmtSeconds(ctx.raw) } } }
                                    }
                                })
                            )
                        )
                    ),

                    // Detailed Table
                    React.createElement(Card, { style: { padding: 0, overflow: "hidden" } },
                        React.createElement("table", { style: { width: "100%", borderCollapse: "collapse" } },
                            React.createElement("thead", null,
                                React.createElement("tr", { style: { background: C.navy, color: "#fff" } },
                                    ["Grupo", "Op.", "Ofrecidas", "Contest.", "Aband.", "% Aband.", "TMO", "Avisando"].map(h =>
                                        React.createElement("th", { key: h, style: { padding: "14px 16px", textAlign: "center", fontSize: 12 } }, h)
                                    )
                                )
                            ),
                            React.createElement("tbody", null,
                                data.map((g, i) => React.createElement("tr", { key: g.group, style: { borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "#f8fafc" : "#fff" } },
                                    React.createElement("td", { style: { padding: "14px 16px", fontWeight: 800, color: C.navy } }, g.group),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center" } }, g.ops),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center" } }, g.o.toLocaleString()),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center", color: C.green, fontWeight: 700 } }, g.c.toLocaleString()),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center", color: C.red, fontWeight: 700 } }, g.ab.toLocaleString()),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center" } },
                                        React.createElement(Badge, {
                                            label: `${g.pctAb.toFixed(1)}%`,
                                            color: g.pctAb > 20 ? C.red : g.pctAb > 10 ? C.orange : C.green,
                                            bg: g.pctAb > 20 ? C.redBg : g.pctAb > 10 ? C.orBg : C.greenBg
                                        })
                                    ),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center", fontWeight: 600 } }, fmtSeconds(g.avgManejo)),
                                    React.createElement("td", { style: { padding: "14px 16px", textAlign: "center", fontWeight: 600 } }, fmtSeconds(g.avgAvisando))
                                ))
                            )
                        )
                    )
                )
    );
}


// ════════════════════════════════════════════════════════════════════════════
//  VIEW: ANÁLISIS DE OPERADORES (Métricas Mensuales)
// ════════════════════════════════════════════════════════════════════════════
function ViewAnalisisOperadores({ user, onBack, navigateToProfile }) {
    const [perf, setPerf] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(null);
    const [history, setHistory] = useState([]);
    const [filter, setFilter] = useState({ month: (new Date().getMonth() + 1).toString().padStart(2, "0"), year: new Date().getFullYear().toString() });
    const [groupFilter, setGroupFilter] = useState("all");
    const [staffMap, setStaffMap] = useState({});
    const [availableGroups, setAvailableGroups] = useState([]);

    const loadData = async () => {
        setLoading(true);
        const [pList, staff] = await Promise.all([
            getOperatorPerformance(filter.month, filter.year),
            getStaffList()
        ]);
        setPerf(pList);
        const map = {};
        staff.forEach(s => { map[s.normName] = s; });
        setStaffMap(map);
        const groups = [...new Set(staff.map(s => s.grupo).filter(Boolean))].sort();
        setAvailableGroups(groups);
        setLoading(false);
    };

    useEffect(() => { loadData(); }, [filter]);

    useEffect(() => {
        if (expanded) {
            getOperatorHistory(expanded, filter.year).then(setHistory);
        } else {
            setHistory([]);
        }
    }, [expanded, filter.year]);

    const handleUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const list = parseOperadoresMensualCSV(text, filter.month, filter.year);
        if (list.length) {
            await saveOperatorPerformance(list, filter.month, filter.year);
            loadData();
        }
    };

    const combined = useMemo(() => {
        return perf.map(p => {
            const hours = (p.totalConectado / 3600) || 1;
            const coefProd = p.c / hours;
            return {
                ...p,
                grupo: staffMap[p.normName]?.grupo || "",
                coefProd: coefProd.toFixed(1),
                scoreQuality: (p.pctProd).toFixed(1),
            };
        }).sort((a, b) => b.c - a.c);
    }, [perf, staffMap]);

    const filteredCombined = useMemo(() => {
        if (groupFilter === "all") return combined;
        return combined.filter(p => p.grupo === groupFilter);
    }, [combined, groupFilter]);

    const stats = useMemo(() => {
        if (!filteredCombined.length) return null;
        return {
            totalC: filteredCombined.reduce((s, x) => s + x.c, 0),
            avgProd: (filteredCombined.reduce((s, x) => s + parseFloat(x.coefProd), 0) / filteredCombined.length).toFixed(1),
            avgQual: (filteredCombined.reduce((s, x) => s + parseFloat(x.scoreQuality), 0) / filteredCombined.length).toFixed(1)
        };
    }, [filteredCombined]);


    return React.createElement("div", { className: "animate-fade" },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
                React.createElement("button", { onClick: onBack, style: { background: "#fff", border: `1px solid ${C.border}`, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.navy, transition: "all .2s" } }, "←"),
                React.createElement("div", null,
                    React.createElement("h2", { style: { margin: 0, color: C.navy, fontWeight: 900 } }, "📊 Análisis de Desempeño"),
                    React.createElement("p", { style: { margin: "4px 0 0", color: C.gray, fontSize: 13 } }, "Métricas de productividad y calidad mensual por operador")
                )
            ),
            React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "center" } },
                availableGroups.length > 0 && React.createElement("select", {
                    value: groupFilter,
                    onChange: e => setGroupFilter(e.target.value),
                    style: { padding: "10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 700, color: C.navy, background: "#fff" }
                },
                    React.createElement("option", { value: "all" }, "Todos los Grupos"),
                    availableGroups.map(g => React.createElement("option", { key: g, value: g }, g))
                ),
                React.createElement("select", {
                    value: filter.month,
                    onChange: e => setFilter({ ...filter, month: e.target.value }),
                    style: { padding: "10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 600 }
                },
                    ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map(m =>
                        React.createElement("option", { key: m, value: m }, m)
                    )
                ),
                React.createElement("select", {
                    value: filter.year,
                    onChange: e => setFilter({ ...filter, year: e.target.value }),
                    style: { padding: "10px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 600 }
                },
                    ["2025", "2026", "2027"].map(y => React.createElement("option", { key: y, value: y }, y))
                ),
                React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, background: C.blue, color: "#fff", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13 } },
                    "📤 Cargar Reporte Mensual",
                    React.createElement("input", { type: "file", accept: ".csv", onChange: handleUpload, style: { display: "none" } })
                )
            )
        ),

        stats && React.createElement("div", { style: { display: "flex", gap: 16, marginBottom: 24 } },
            React.createElement(StatKpi, { label: "Total Contestadas", value: stats.totalC.toLocaleString(), accent: C.blue }),
            React.createElement(StatKpi, { label: "Prod. Promedio", value: stats.avgProd, sub: "Contestadas / Hora", accent: C.green }),
            React.createElement(StatKpi, { label: "Puntaje Calidad Avg", value: `${stats.avgQual}%`, sub: "% Tiempo Productivo", accent: C.mid })
        ),

        // ── SCATTER PLOTS ────────────────────────────────────────────────
        filteredCombined.length > 0 && React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 } },
            // Scatter 1: Abandonadas (X) vs Atendidas (Y)
            React.createElement(Card, { style: { padding: 20 } },
                React.createElement("div", { style: { fontWeight: 800, fontSize: 13, color: C.navy, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { style: { fontSize: 18 } }, "🔴"),
                    "Abandonadas vs Atendidas"
                ),
                React.createElement("div", { style: { fontSize: 11, color: C.gray, marginBottom: 12 } }, "Clic en un punto para ver el perfil del operador"),
                React.createElement("div", { style: { height: 300 } },
                    (() => {
                        const scatter1Data = filteredCombined.filter(p => p.ab > 0 || p.c > 0);
                        return React.createElement(ChartScatter, {
                            id: "scatter-abandon-vs-atendidas",
                            data: {
                                datasets: [{
                                    label: "Operadores",
                                    data: scatter1Data.map(p => ({ x: p.ab, y: p.c, name: p.name, normName: p.normName })),
                                    backgroundColor: scatter1Data.map(p => {
                                        const ratio = p.ab / (p.c || 1);
                                        return ratio > 0.15 ? "rgba(220,38,38,0.7)" : ratio > 0.08 ? "rgba(234,88,12,0.7)" : "rgba(22,163,74,0.7)";
                                    }),
                                    borderColor: scatter1Data.map(p => {
                                        const ratio = p.ab / (p.c || 1);
                                        return ratio > 0.15 ? "#dc2626" : ratio > 0.08 ? "#ea580c" : "#16a34a";
                                    }),
                                    borderWidth: 2,
                                    pointRadius: 7,
                                    pointHoverRadius: 10
                                }]
                            },
                            onPointClick: (index) => {
                                const p = scatter1Data[index];
                                if (p) navigateToProfile(p.normName);
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                plugins: {
                                    legend: { display: false },
                                    tooltip: {
                                        callbacks: {
                                            label: (ctx) => {
                                                const pt = ctx.raw;
                                                return `${pt.name}: ${pt.x} aband. / ${pt.y} atend.`;
                                            }
                                        }
                                    }
                                },
                                scales: {
                                    x: {
                                        title: { display: true, text: "Cantidad Abandonadas", font: { size: 12, weight: "bold" }, color: C.navy },
                                        beginAtZero: true,
                                        grid: { color: "rgba(0,0,0,0.05)" },
                                        ticks: { font: { size: 10 } }
                                    },
                                    y: {
                                        title: { display: true, text: "Cantidad Atendidas", font: { size: 12, weight: "bold" }, color: C.navy },
                                        beginAtZero: true,
                                        grid: { color: "rgba(0,0,0,0.05)" },
                                        ticks: { font: { size: 10 } }
                                    }
                                }
                            }
                        });
                    })()
                )
            ),
            // Scatter 2: Tiempo Avisando Promedio (X) vs Tiempo Promedio de Atención (Y)
            React.createElement(Card, { style: { padding: 20 } },
                React.createElement("div", { style: { fontWeight: 800, fontSize: 13, color: C.navy, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { style: { fontSize: 18 } }, "⏱"),
                    "Tiempo Avisando vs Tiempo de Atención"
                ),
                React.createElement("div", { style: { fontSize: 11, color: C.gray, marginBottom: 12 } }, "Clic en un punto para ver el perfil del operador"),
                React.createElement("div", { style: { height: 300 } },
                    (() => {
                        const scatter2Data = filteredCombined.filter(p => p.avgAvisando > 0 || p.avgManejo > 0);
                        return React.createElement(ChartScatter, {
                            id: "scatter-avisando-vs-manejo",
                            data: {
                                datasets: [{
                                    label: "Operadores",
                                    data: scatter2Data.map(p => ({ x: p.avgAvisando, y: p.avgManejo, name: p.name, normName: p.normName })),
                                    backgroundColor: "rgba(46,95,163,0.65)",
                                    borderColor: C.mid,
                                    borderWidth: 2,
                                    pointRadius: 7,
                                    pointHoverRadius: 10
                                }]
                            },
                            onPointClick: (index) => {
                                const p = scatter2Data[index];
                                if (p) navigateToProfile(p.normName);
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                plugins: {
                                    legend: { display: false },
                                    tooltip: {
                                        callbacks: {
                                            label: (ctx) => {
                                                const pt = ctx.raw;
                                                return `${pt.name}: Avisando ${fmtSeconds(pt.x)} / Atención ${fmtSeconds(pt.y)}`;
                                            }
                                        }
                                    }
                                },
                                scales: {
                                    x: {
                                        title: { display: true, text: "Tiempo Avisando Promedio (seg)", font: { size: 12, weight: "bold" }, color: C.navy },
                                        beginAtZero: true,
                                        grid: { color: "rgba(0,0,0,0.05)" },
                                        ticks: { font: { size: 10 }, callback: v => fmtSeconds(v) }
                                    },
                                    y: {
                                        title: { display: true, text: "Tiempo Promedio Atención (seg)", font: { size: 12, weight: "bold" }, color: C.navy },
                                        beginAtZero: true,
                                        grid: { color: "rgba(0,0,0,0.05)" },
                                        ticks: { font: { size: 10 }, callback: v => fmtSeconds(v) }
                                    }
                                }
                            }
                        });
                    })()
                )
            )
        ),

        React.createElement(Card, { style: { padding: 0, overflow: "hidden" } },
            React.createElement("div", { style: { padding: "16px 20px", background: "#f8fafc", borderBottom: `1px solid ${C.border}`, fontWeight: 800, color: C.navy, fontSize: 14, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                React.createElement("span", null, "Ranking de Desempeño (Clic para ver detalle)"),
                groupFilter !== "all" && React.createElement(Badge, { label: `Grupo: ${groupFilter}`, color: C.blue, bg: C.light })
            ),
            React.createElement("table", { style: { width: "100%", borderCollapse: "collapse" } },
                React.createElement("thead", null,
                    React.createElement("tr", { style: { textAlign: "left", background: "#f1f5f9" } },
                        ["Operador", "Grupo", "Atendidas", "Prod (At/Hr)", "% Preparado", "Calidad"].map(h =>
                            React.createElement("th", { key: h, style: { padding: "12px 20px", fontSize: 10, fontWeight: 800, color: C.gray, textTransform: "uppercase" } }, h)
                        )
                    )
                ),
                React.createElement("tbody", null,
                    loading ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { padding: 40, textAlign: "center", color: C.gray } }, "Cargando métricas...")) :
                        filteredCombined.length === 0 ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { padding: 40, textAlign: "center", color: C.gray } }, "No hay datos para este período/grupo.")) :
                            filteredCombined.map((p, i) => (
                                React.createElement(React.Fragment, { key: p.normName },
                                    React.createElement("tr", {
                                        onClick: () => setExpanded(expanded === p.normName ? null : p.normName),
                                        style: { borderTop: `1px solid ${C.border}`, background: i % 2 === 0 ? "#fff" : "#fafafa", transition: "all .1s", cursor: "pointer" },
                                        className: "hover-row"
                                    },
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                                                React.createElement("span", { style: { color: C.blue, fontSize: 10 } }, expanded === p.normName ? "▼" : "▶"),
                                                React.createElement("div", {
                                                    onClick: (e) => { e.stopPropagation(); navigateToProfile(p.normName); },
                                                    style: { fontWeight: 800, color: C.blue, fontSize: 13, textDecoration: "underline" }
                                                }, p.name)
                                            )
                                        ),
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement(Badge, { label: p.grupo || "S/G", color: p.grupo ? C.mid : C.gray, bg: p.grupo ? "rgba(46,95,163,0.08)" : "#f1f5f9" })
                                        ),
                                        React.createElement("td", { style: { padding: "14px 20px", fontWeight: 700 } }, p.c.toLocaleString()),
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                                React.createElement("span", { style: { fontWeight: 900, fontSize: 14, color: C.blue, width: 35 } }, p.coefProd),
                                                React.createElement(MiniBar, { pct: parseFloat(p.coefProd) * 5, color: C.blue })
                                            )
                                        ),
                                        React.createElement("td", { style: { padding: "14px 20px", fontSize: 13, color: C.gray, fontWeight: 700 } }, `${p.pctProd}%`),
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                                React.createElement("span", { style: { fontWeight: 800, fontSize: 13, color: parseFloat(p.scoreQuality) > 80 ? C.green : C.orange } }, `${p.scoreQuality}%`),
                                                React.createElement(MiniBar, { pct: parseFloat(p.scoreQuality), color: parseFloat(p.scoreQuality) > 80 ? C.green : C.orange })
                                            )
                                        )
                                    ),
                                    expanded === p.normName && React.createElement("tr", { style: { background: "#f8fafc" } },
                                        React.createElement("td", { colSpan: 5, style: { padding: "24px 40px", borderBottom: `2px solid ${C.blue}` } },
                                            React.createElement("div", { className: "animate-slide-down" },
                                                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, marginBottom: 24 } },
                                                    // Col 1: Distribución
                                                    React.createElement("div", null,
                                                        React.createElement("div", { style: { fontWeight: 800, fontSize: 12, color: C.gray, textTransform: "uppercase", marginBottom: 12 } }, "📊 Volumen de Llamadas"),
                                                        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                                                            React.createElement(RowStat, { label: "Ofrecidas", value: p.o, color: C.navy }),
                                                            React.createElement(RowStat, { label: "Contestadas", value: p.c, color: C.green }),
                                                            React.createElement(RowStat, { label: "Abandonadas", value: p.ab, color: C.red })
                                                        )
                                                    ),
                                                    // Col 2: Tiempos
                                                    React.createElement("div", null,
                                                        React.createElement("div", { style: { fontWeight: 800, fontSize: 12, color: C.gray, textTransform: "uppercase", marginBottom: 12 } }, "⏱ Tiempos Promedio"),
                                                        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                                                            React.createElement(RowStat, { label: "Prom. Avisando", value: fmtSeconds(p.avgAvisando), color: C.blue }),
                                                            React.createElement(RowStat, { label: "Prom. Manejo", value: fmtSeconds(p.avgManejo), color: C.mid })
                                                        )
                                                    ),
                                                    // Col 3: Conexión
                                                    React.createElement("div", null,
                                                        React.createElement("div", { style: { fontWeight: 800, fontSize: 12, color: C.gray, textTransform: "uppercase", marginBottom: 12 } }, "🔌 Estado de Conexión"),
                                                        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                                                            React.createElement(RowStat, { label: "Total Conectado", value: fmtSeconds(p.totalConectado), color: C.navy }),
                                                            React.createElement(RowStat, { label: "Voz Preparada", value: `${p.pctProd}%`, color: C.green }),
                                                            React.createElement(RowStat, { label: "Voz No Prep.", value: `${p.pctNoProd}%`, color: C.orange })
                                                        )
                                                    )
                                                ),

                                                // ── SECCIÓN COMPARATIVA (NUEVA) ──────────────────────────
                                                history.length > 1 && React.createElement("div", { style: { paddingTop: 24, borderTop: `1px dashed ${C.border}` } },
                                                    React.createElement("div", { style: { fontWeight: 900, fontSize: 13, color: C.navy, marginBottom: 16 } }, `📈 Evolución Anual: ${p.name}`),
                                                    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 24 } },
                                                        // Gráfico de Tendencia
                                                        React.createElement("div", { style: { background: "#fff", padding: 16, borderRadius: 12, border: `1px solid ${C.border}`, height: 220 } },
                                                            React.createElement(ChartLine, {
                                                                id: `trend-${p.normName}`,
                                                                data: {
                                                                    labels: history.map(h => `Mes ${h.month}`),
                                                                    datasets: [{
                                                                        label: "% Voz Preparada",
                                                                        data: history.map(h => h.pctProd),
                                                                        borderColor: C.green,
                                                                        backgroundColor: "rgba(34,197,94,0.1)",
                                                                        tension: 0.3,
                                                                        fill: true,
                                                                        pointRadius: 4,
                                                                        pointBackgroundColor: C.green
                                                                    }]
                                                                },
                                                                options: {
                                                                    responsive: true, maintainAspectRatio: false,
                                                                    plugins: { legend: { display: false } },
                                                                    scales: {
                                                                        y: { min: 0, max: 100, ticks: { callback: v => `${v}%`, font: { size: 9 } } },
                                                                        x: { ticks: { font: { size: 9 } } }
                                                                    }
                                                                }
                                                            })
                                                        ),
                                                        // Tabla Histórica
                                                        React.createElement("div", null,
                                                            React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 11 } },
                                                                React.createElement("thead", null,
                                                                    React.createElement("tr", { style: { background: "#f1f5f9", textAlign: "left" } },
                                                                        ["Mes", "Cont.", "At/Hr", "% Voz"].map(h =>
                                                                            React.createElement("th", { key: h, style: { padding: "8px 10px", fontWeight: 800, color: C.gray } }, h)
                                                                        )
                                                                    )
                                                                ),
                                                                React.createElement("tbody", null,
                                                                    history.map(h => {
                                                                        const hours = (h.totalConectado / 3600) || 1;
                                                                        const coef = (h.c / hours).toFixed(1);
                                                                        return React.createElement("tr", { key: h.month, style: { borderTop: `1px solid ${C.border}` } },
                                                                            React.createElement("td", { style: { padding: "8px 10px", fontWeight: 700 } }, h.month),
                                                                            React.createElement("td", { style: { padding: "8px 10px" } }, h.c),
                                                                            React.createElement("td", { style: { padding: "8px 10px", fontWeight: 700, color: C.blue } }, coef),
                                                                            React.createElement("td", { style: { padding: "8px 10px", fontWeight: 700, color: C.green } }, `${h.pctProd}%`)
                                                                        );
                                                                    })
                                                                )
                                                            )
                                                        )
                                                    )
                                                )
                                            )
                                        )
                                    )
                                )
                            ))
                )
            )
        )
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: PERFIL DE OPERADOR (Individual Dashboard)
// ════════════════════════════════════════════════════════════════════════════
function ViewPerfilOperador({ user, onBack, initialAgent = null }) {
    const [agents, setAgents] = useState([]);
    const [selectedAgent, setSelectedAgent] = useState(initialAgent || "");
    const [year, setYear] = useState(new Date().getFullYear().toString());
    const [history, setHistory] = useState([]);
    const [groupAvg, setGroupAvg] = useState({});
    const [loading, setLoading] = useState(false);

    useEffect(() => { getUniqueOperators().then(setAgents); }, []);

    useEffect(() => {
        if (!selectedAgent) return;
        setLoading(true);
        Promise.all([
            getOperatorHistory(selectedAgent, year),
            getGroupAverages(year)
        ]).then(([h, g]) => {
            setHistory(h);
            setGroupAvg(g);
            setLoading(false);
        });
    }, [selectedAgent, year]);

    const stats = useMemo(() => {
        if (!history.length) return null;
        const totalC = history.reduce((s, h) => s + h.c, 0);
        const avgEff = (history.reduce((s, h) => s + h.pctProd, 0) / history.length).toFixed(1);
        const avgProd = (history.reduce((s, h) => {
            const hrs = (h.totalConectado / 3600) || 1;
            return s + (h.c / hrs);
        }, 0) / history.length).toFixed(1);

        return { totalC, avgEff, avgProd };
    }, [history]);

    const chartData = useMemo(() => {
        if (!history.length) return null;
        const labels = history.map(h => MONTH_NAMES[h.month] || h.month);

        return {
            volume: {
                labels,
                datasets: [
                    { label: "Contestadas (Op)", data: history.map(h => h.c), backgroundColor: C.blue, borderRadius: 6 },
                    { label: "Promedio Grupo", data: history.map(h => groupAvg[h.month]?.avgC || 0), backgroundColor: "rgba(148,163,184,0.3)", borderRadius: 6 }
                ]
            },
            efficiency: {
                labels,
                datasets: [
                    { label: "% Voz Prep (Op)", data: history.map(h => h.pctProd), borderColor: C.green, backgroundColor: "rgba(22,163,74,0.1)", fill: true, tension: 0.3 },
                    { label: "Promedio Grupo", data: history.map(h => groupAvg[h.month]?.avgProd || 0), borderColor: C.gray, borderDash: [5, 5], tension: 0.3 }
                ]
            },
            handling: {
                labels,
                datasets: [
                    { label: "T. Manejo (Op)", data: history.map(h => h.avgManejo), borderColor: "#7c3aed", tension: 0.3 },
                    { label: "Promedio Grupo", data: history.map(h => groupAvg[h.month]?.avgManejo || 0), borderColor: C.gray, borderDash: [5, 5], tension: 0.3 }
                ]
            }
        };
    }, [history, groupAvg]);

    return React.createElement("div", { className: "animate-fade" },
        // Header
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
                React.createElement("button", { onClick: onBack, style: { background: "#fff", border: `1px solid ${C.border}`, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.navy } }, "←"),
                React.createElement("div", null,
                    React.createElement("h2", { style: { margin: 0, color: C.navy, fontWeight: 900 } }, "👤 Perfil de Operador"),
                    React.createElement("p", { style: { margin: "4px 0 0", color: C.gray, fontSize: 13 } }, "Análisis de trayectoria individual y comparativa")
                )
            ),
            React.createElement("div", { style: { display: "flex", gap: 12 } },
                React.createElement("select", {
                    value: selectedAgent,
                    onChange: e => setSelectedAgent(e.target.value),
                    style: { padding: "10px 16px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 700, minWidth: 220, color: C.navy }
                },
                    React.createElement("option", { value: "" }, "Seleccionar Operador..."),
                    agents.map(a => React.createElement("option", { key: a.normName, value: a.normName }, a.name))
                ),
                React.createElement("select", {
                    value: year,
                    onChange: e => setYear(e.target.value),
                    style: { padding: "10px 16px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, fontWeight: 700 }
                },
                    ["2025", "2026", "2027"].map(y => React.createElement("option", { key: y, value: y }, y))
                )
            )
        ),

        !selectedAgent && React.createElement(Card, { style: { textAlign: "center", padding: 60, color: C.gray } }, "Seleccioná un operador para ver sus dashboards."),

        selectedAgent && loading && React.createElement("div", { style: { textAlign: "center", padding: 40, color: C.gray } }, "Cargando trayectoria…"),

        selectedAgent && !loading && history.length === 0 && React.createElement(Card, { style: { textAlign: "center", padding: 60, color: C.gray } }, "No hay datos registrados para este operador en el año seleccionado."),

        selectedAgent && !loading && stats && React.createElement("div", { className: "animate-fade" },
            // KPIs
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 } },
                React.createElement(StatKpi, { label: "Total Atendidas (Año)", value: stats.totalC.toLocaleString(), accent: C.blue }),
                React.createElement(StatKpi, { label: "Eficiencia Avg", value: `${stats.avgEff}%`, sub: "% Voz Preparada", accent: C.green }),
                React.createElement(StatKpi, { label: "Productividad Avg", value: stats.avgProd, sub: "Contestadas / Hora", accent: C.mid })
            ),

            // Charts Dashboard
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 } },
                React.createElement(Card, null,
                    React.createElement("div", { style: { fontWeight: 800, color: C.navy, marginBottom: 16, fontSize: 14 } }, "📈 Volumen: Contestadas vs Promedio Grupo"),
                    React.createElement("div", { style: { height: 260 } }, React.createElement(ChartBar, { id: "vol-comp", data: chartData.volume }))
                ),
                React.createElement(Card, null,
                    React.createElement("div", { style: { fontWeight: 800, color: C.navy, marginBottom: 16, fontSize: 14 } }, "🎯 Eficiencia: % Voz Preparada vs Grupo"),
                    React.createElement("div", { style: { height: 260 } }, React.createElement(ChartLine, { id: "eff-comp", data: chartData.efficiency }))
                )
            ),

            React.createElement(Card, null,
                React.createElement("div", { style: { fontWeight: 800, color: C.navy, marginBottom: 16, fontSize: 14 } }, "⏱ Tiempos: Media Manejo vs Grupo"),
                React.createElement("div", { style: { height: 260 } }, React.createElement(ChartLine, { id: "time-comp", data: chartData.handling }))
            ),

            // Data Table Comparison
            React.createElement(Card, { style: { padding: 0, overflow: "hidden", marginTop: 24 } },
                React.createElement("div", { style: { padding: "16px 20px", borderBottom: `1px solid ${C.border}`, background: "#f8fafc", fontWeight: 800, color: C.navy, fontSize: 13 } }, "Historial Mensual Detallado"),
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse" } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: "#f1f5f9", textAlign: "left" } },
                            ["Mes", "Contestadas", "Prod (At/Hr)", "% Voz Prep.", "% Voz No Prep.", "Puntaje Calidad"].map(h =>
                                React.createElement("th", { key: h, style: { padding: "12px 20px", fontSize: 10, fontWeight: 800, color: C.gray, textTransform: "uppercase" } }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        history.map((h, i) => {
                            const hrs = (h.totalConectado / 3600) || 1;
                            const prod = (h.c / hrs).toFixed(1);
                            return React.createElement("tr", { key: h.month, style: { borderTop: `1px solid ${C.border}`, background: i % 2 === 0 ? "#fff" : "#fafafa" } },
                                React.createElement("td", { style: { padding: "12px 20px", fontWeight: 800, color: C.navy } }, MONTH_NAMES[h.month] || h.month),
                                React.createElement("td", { style: { padding: "12px 20px", fontWeight: 700 } }, h.c),
                                React.createElement("td", { style: { padding: "12px 20px", fontWeight: 700, color: C.blue } }, prod),
                                React.createElement("td", { style: { padding: "12px 20px", color: C.green, fontWeight: 700 } }, `${h.pctProd}%`),
                                React.createElement("td", { style: { padding: "12px 20px", color: C.orange, fontWeight: 700 } }, `${h.pctNoProd}%`),
                                React.createElement("td", { style: { padding: "12px 20px" } },
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                        React.createElement("span", { style: { fontWeight: 800, color: h.pctProd > 80 ? C.green : C.orange } }, `${h.pctProd}%`),
                                        React.createElement(MiniBar, { pct: h.pctProd, color: h.pctProd > 80 ? C.green : C.orange })
                                    )
                                )
                            );
                        })
                    )
                )
            )
        )
    );
}

function RowStat({ label, value, color }) {
    return React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#fff", borderRadius: 8, border: `1px solid ${C.border}` } },
        React.createElement("span", { style: { fontSize: 11, fontWeight: 700, color: C.gray } }, label),
        React.createElement("span", { style: { fontSize: 13, fontWeight: 900, color } }, value)
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  VIEW: GESTOR DE PERSONAL (Grupos)
// ════════════════════════════════════════════════════════════════════════════
function ViewGestorPersonal({ user, onBack }) {
    const [staff, setStaff] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(null); // normName being saved
    const [searchTerm, setSearchTerm] = useState("");

    const loadStaff = async () => {
        setLoading(true);
        const [registered, performance] = await Promise.all([
            getStaffList(),
            getUniqueOperators()
        ]);

        // Merge sources: ensure all unique operators seen in performance reports are listed
        const masterList = [...registered];
        performance.forEach(op => {
            if (!masterList.find(s => s.normName === op.normName)) {
                masterList.push({ ...op, turno: "—", grupo: "" });
            }
        });

        setStaff(masterList.sort((a, b) => (a.name || "").localeCompare(b.name || "")));
        setLoading(false);
    };

    useEffect(() => { loadStaff(); }, []);

    const handleUpdateGroup = async (normName, group) => {
        setSaving(normName);
        await updateStaffGroup(normName, group);
        setStaff(prev => prev.map(s => s.normName === normName ? { ...s, grupo: group } : s));
        setSaving(null);
    };

    const handleUpdateName = async (normName, newName) => {
        setSaving(normName);
        const db = getDB();
        if (db) {
            const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            await setDoc(doc(db, "staff", normName), { name: newName }, { merge: true });
            setStaff(prev => prev.map(s => s.normName === normName ? { ...s, name: newName } : s));
        }
        setSaving(null);
    };

    const filteredStaff = staff.filter(s => {
        const n = (s.name || "").toLowerCase();
        const g = (s.grupo || "").toLowerCase();
        const sc = (searchTerm || "").toLowerCase();
        return n.includes(sc) || g.includes(sc);
    });

    const groupCounts = useMemo(() => {
        const counts = {};
        staff.forEach(s => {
            if (s.grupo) counts[s.grupo] = (counts[s.grupo] || 0) + 1;
        });
        return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    }, [staff]);

    return React.createElement("div", { className: "animate-fade" },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16 } },
                React.createElement("button", { onClick: onBack, style: { background: "#fff", border: `1px solid ${C.border}`, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.navy } }, "←"),
                React.createElement("div", null,
                    React.createElement("h2", { style: { margin: 0, color: C.navy, fontWeight: 900 } }, "👥 Gestión de Personal"),
                    React.createElement("p", { style: { margin: "4px 0 0", color: C.gray, fontSize: 13 } }, "Asignación de grupos y organización de operadores")
                )
            ),
            React.createElement("div", { style: { position: "relative" } },
                React.createElement("input", {
                    type: "text",
                    placeholder: "Buscar por nombre o grupo...",
                    value: searchTerm,
                    onChange: e => setSearchTerm(e.target.value),
                    style: { padding: "10px 16px 10px 40px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, minWidth: 280, color: C.navy }
                }),
                React.createElement("span", { style: { position: "absolute", left: 14, top: 11, fontSize: 16 } }, "🔍")
            )
        ),

        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 300px", gap: 24, alignItems: "start" } },
            // Table
            React.createElement(Card, { style: { padding: 0, overflow: "hidden" } },
                React.createElement("table", { style: { width: "100%", borderCollapse: "collapse" } },
                    React.createElement("thead", null,
                        React.createElement("tr", { style: { background: "#f1f5f9", textAlign: "left" } },
                            ["Operador", "Turno", "Grupo / Célula"].map(h =>
                                React.createElement("th", { key: h, style: { padding: "14px 20px", fontSize: 10, fontWeight: 800, color: C.gray, textTransform: "uppercase" } }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        loading ? React.createElement("tr", null, React.createElement("td", { colSpan: 3, style: { padding: 60, textAlign: "center", color: C.gray } }, "Cargando personal...")) :
                            filteredStaff.length === 0 ? React.createElement("tr", null, React.createElement("td", { colSpan: 3, style: { padding: 60, textAlign: "center", color: C.gray } }, "No se encontraron operadores.")) :
                                filteredStaff.map((s, i) => (
                                    React.createElement("tr", { key: s.normName, style: { borderTop: `1px solid ${C.border}`, background: i % 2 === 0 ? "#fff" : "#fafafa" } },
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                                (saving === s.normName) && React.createElement("span", { className: "animate-spin", style: { fontSize: 12 } }, "⏳"),
                                                React.createElement("input", {
                                                    defaultValue: s.name,
                                                    onBlur: e => e.target.value !== s.name && handleUpdateName(s.normName, e.target.value),
                                                    style: { border: "none", background: "transparent", fontWeight: 800, color: C.navy, fontSize: 14, padding: "4px 0", width: "100%" }
                                                })
                                            )
                                        ),
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement(Badge, { label: s.turno || "—", color: C.gray, bg: "#f1f5f9" })
                                        ),
                                        React.createElement("td", { style: { padding: "14px 20px" } },
                                            React.createElement("input", {
                                                type: "text",
                                                placeholder: "Sin grupo (Ej: Alpha-1)...",
                                                defaultValue: s.grupo || "",
                                                onBlur: e => e.target.value !== (s.grupo || "") && handleUpdateGroup(s.normName, e.target.value),
                                                style: {
                                                    padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
                                                    fontSize: 13, background: s.grupo ? "rgba(46,95,163,0.05)" : "#fff",
                                                    fontWeight: s.grupo ? 700 : 400, color: s.grupo ? C.mid : C.gray,
                                                    width: "100%", outline: "none"
                                                }
                                            })
                                        )
                                    )
                                ))
                    )
                )
            ),

            // Sidebar: Grupos
            React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
                React.createElement(Card, null,
                    React.createElement("div", { style: { fontWeight: 900, color: C.navy, marginBottom: 16, fontSize: 14 } }, "🏢 Grupos Detectados"),
                    groupCounts.length === 0 ? React.createElement("div", { style: { fontSize: 12, color: C.gray, textAlign: "center", padding: "10px 0" } }, "No hay grupos asignados") :
                        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                            groupCounts.map(([g, c]) =>
                                React.createElement("div", { key: g, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#f8fafc", borderRadius: 8 } },
                                    React.createElement("span", { style: { fontSize: 13, fontWeight: 700, color: C.mid } }, g),
                                    React.createElement("span", { style: { background: C.mid, color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 800 } }, c)
                                )
                            )
                        )
                ),
                React.createElement("div", { style: { padding: "12px 16px", background: "#fffbeb", borderRadius: 12, border: `1px solid #fef3c7`, color: "#92400e", fontSize: 12, lineHeight: 1.5 } },
                    React.createElement("div", { style: { fontWeight: 900, marginBottom: 4 } }, "💡 Sugerencia"),
                    "Asigna nombres de grupos para habilitar filtros avanzados y comparativas por equipo en los paneles de análisis."
                )
            )
        )
    );
}

// ─── Panel de Hallazgos Globales ──────────────────────────────────────────
function PanelGlobalInsights({ user }) {
    const [insights, setInsights] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!user) { setLoading(false); return; }
        getGlobalInsights().then(res => {
            setInsights(res);
            setLoading(false);
        });
    }, [user]);

    if (loading) return React.createElement("div", { style: { padding: "24px", textAlign: "center", color: C.gray, fontSize: 13, background: "#f8fafc", borderRadius: 12, border: `1px dashed ${C.border}`, marginBottom: 30 } }, "Analizando tendencias globales…");
    if (!insights.length) return null;

    return React.createElement("div", { className: "animate-fade", style: { marginBottom: 36 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14 } },
            React.createElement("span", { style: { fontSize: 18 } }, "💡"),
            React.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 800, color: C.navy, textTransform: "uppercase", letterSpacing: "1px" } }, "Hallazgos Estratégicos")
        ),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 } },
            insights.map((ins, i) => {
                const color = ins.type === "red" ? C.red : ins.type === "green" ? C.green : ins.type === "orange" ? C.orange : C.blue;
                const bg = ins.type === "red" ? C.redBg : ins.type === "green" ? C.greenBg : ins.type === "orange" ? C.orBg : C.light;

                return React.createElement("div", { key: i, style: { background: "#fff", borderLeft: `5px solid ${color}`, borderRadius: 12, padding: "14px 18px", boxShadow: "0 4px 12px rgba(0,0,0,0.03)", display: "flex", gap: 14, alignItems: "center" } },
                    React.createElement("div", { style: { width: 40, height: 40, borderRadius: "10px", background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 } }, ins.icon),
                    React.createElement("div", { style: { flex: 1 } },
                        React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: C.gray, textTransform: "uppercase", marginBottom: 3 } }, ins.title),
                        React.createElement("div", { style: { fontSize: 12.5, color: C.navy, fontWeight: 700, lineHeight: 1.4 } }, ins.msg)
                    ),
                    React.createElement("div", { style: { textAlign: "right", minWidth: 70 } },
                        React.createElement("div", { style: { fontSize: 15, fontWeight: 900, color: color } }, ins.value)
                    )
                );
            })
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
    const [profileAgent, setProfileAgent] = useState(null);
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

    const navItems = [
        { id: "resumen", label: "📊 Resumen", avail: hasData },
        { id: "horas", label: "📞 Por Hora", avail: !!files.abandonadas },
        { id: "operadores", label: "👤 Operadores", avail: !!files.agentes },
        { id: "despacho", label: "🚓 Despacho", avail: !!(files.despachoInicio || files.despachoDerivacion || files.despachoCreacion) },
        { id: "operadores_analisis", label: "🏆 Ranking", avail: true },
        { id: "operadores_perfil", label: "👤 Perfil", avail: true },
        { id: "comparativa_grupos", label: "👥 Grupos", avail: true },
        { id: "mensual", label: "📈 Mensual", avail: true },
        { id: "historial", label: "📋 Historial", avail: true },
        { id: "personal", label: "👥 Personal", avail: true },
    ];

    return React.createElement("div", { style: { minHeight: "100vh", background: C.bg } },

        // TOPBAR
        React.createElement("div", { className: "no-print", style: { background: `linear-gradient(90deg, ${C.navy} 0%, ${C.blue} 100%)`, padding: "0 28px", display: "flex", alignItems: "center", gap: 0, height: 56, boxShadow: "0 2px 12px rgba(0,0,0,0.2)" } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginRight: 32 } },
                React.createElement("img", { src: "src/img/dirlogo.png", alt: "Logo", style: { height: 48 } }),
                React.createElement("div", null,
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

                // Personal nav (siempre visible)
                React.createElement("button", {
                    onClick: () => setView("personal"),
                    style: {
                        background: view === "personal" ? "rgba(255,255,255,0.18)" : "transparent",
                        border: view === "personal" ? "1px solid rgba(255,255,255,0.3)" : "1px solid transparent",
                        color: view === "personal" ? "#fff" : "#94a3b8",
                        borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer"
                    }
                }, "👥 Personal"),

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
            view === "upload" && React.createElement("div", null,
                React.createElement("div", { style: { textAlign: "center", marginBottom: 32, paddingTop: 20 } },
                    React.createElement("div", { style: { fontSize: 32, marginBottom: 10 } }, "🚨"),
                    React.createElement("img", { src: "src/img/logo_geston.png", alt: "Logo Geston", style: { height: 80, marginBottom: 16 } }),
                    React.createElement("div", { style: { fontSize: 32, fontWeight: 800, marginBottom: 10 } }, "Sistema de Informes de Gestión y Calidad"),
                    React.createElement("div", { style: { fontSize: 14, color: C.gray } }, "Cargá los 5 CSV exportados del sistema para generar el informe automáticamente"),
                    !user && getAuth() && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: C.yellow, fontWeight: 700 } }, "⚠️ Inicia sesión con Google para que tu correo quede registrado en Firestore."),
                    user && React.createElement("div", { style: { marginTop: 8, fontSize: 12, color: C.green, fontWeight: 600 } }, `✓ Sesión activa: ${user.displayName || user.email} — los informes se sincronizan en la nube`),

                    React.createElement("div", { style: { marginTop: 30, display: "flex", justifyContent: "center", gap: 16 } },
                        React.createElement("button", {
                            onClick: () => setView("mensual"),
                            style: { background: `linear-gradient(135deg, ${C.blue} 0%, ${C.mid} 100%)`, color: "#fff", border: "none", borderRadius: 10, padding: "14px 28px", fontSize: 15, fontWeight: 800, cursor: "pointer", boxShadow: "0 10px 25px rgba(27,58,107,0.3)", display: "flex", alignItems: "center", gap: 10, transition: "transform .2s" },
                            onMouseOver: e => e.currentTarget.style.transform = "scale(1.03)",
                            onMouseOut: e => e.currentTarget.style.transform = "scale(1)"
                        },
                            React.createElement("span", { style: { fontSize: 20 } }, "📊"),
                            "Análisis Mensual"
                        )
                    )
                ),
                React.createElement(UploadZone, { onFiles: handleFiles, loaded }),
                React.createElement("div", { style: { marginTop: 28, display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14 } },
                    [
                        { icon: "👤", title: "Llamadas por Agente", desc: "Actividad, disponibilidad y abandonadas cabina por operador" },
                        { icon: "📞", title: "Abandonadas por Hora", desc: "Volumen, abandono y atención en cada intervalo del turno" },
                        { icon: "🚗", title: "Inicio Despacho", desc: "Tiempo desde inicio hasta asignación por distrito" },
                        { icon: "🔄", title: "Derivación → Inicio", desc: "Tiempo desde derivación hasta inicio de despacho" },
                        { icon: "⏱", title: "Creación/Derivación", desc: "Tiempo desde creación del evento hasta despacho" },
                    ].map(({ icon, title, desc }) =>
                        React.createElement("div", { key: title, style: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px", textAlign: "center" } },
                            React.createElement("div", { style: { fontSize: 28, marginBottom: 8 } }, icon),
                            React.createElement("div", { style: { fontWeight: 700, fontSize: 13, color: C.navy, marginBottom: 4 } }, title),
                            React.createElement("div", { style: { fontSize: 12, color: C.gray } }, desc)
                        )
                    )
                ),

                React.createElement(PanelGlobalInsights, { user }),

                // ── SECCIÓN ACCESOS RÁPIDOS ──────────────────────────────────
                React.createElement("div", { style: { marginTop: 40, paddingTop: 30, borderTop: `1px dashed ${C.border}`, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 } },
                    React.createElement(Card, {
                        onClick: () => setView("operadores_analisis"),
                        style: { cursor: "pointer", transition: "all .2s", padding: "20px 24px", display: "flex", gap: 16, alignItems: "center" },
                        onMouseOver: e => e.currentTarget.style.transform = "translateY(-4px)",
                        onMouseOut: e => e.currentTarget.style.transform = "none"
                    },
                        React.createElement("div", { style: { fontSize: 32 } }, "📊"),
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontWeight: 900, fontSize: 16, color: C.navy } }, "Ranking Detallado"),
                            React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 2 } }, "Ranking de calidad y productividad")
                        )
                    ),
                    React.createElement(Card, {
                        onClick: () => setView("operadores_perfil"),
                        style: { cursor: "pointer", transition: "all .2s", padding: "20px 24px", display: "flex", gap: 16, alignItems: "center" },
                        onMouseOver: e => e.currentTarget.style.transform = "translateY(-4px)",
                        onMouseOut: e => e.currentTarget.style.transform = "none"
                    },
                        React.createElement("div", { style: { fontSize: 32 } }, "👤"),
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontWeight: 900, fontSize: 16, color: C.navy } }, "Perfil Individual"),
                            React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 2 } }, "Dashboards comparativos por persona")
                        )
                    ),
                    React.createElement(Card, {
                        onClick: () => setView("comparativa_grupos"),
                        style: { cursor: "pointer", transition: "all .2s", padding: "20px 24px", display: "flex", gap: 16, alignItems: "center", borderTop: `4px solid ${C.mid}` },
                        onMouseOver: e => e.currentTarget.style.transform = "translateY(-4px)",
                        onMouseOut: e => e.currentTarget.style.transform = "none"
                    },
                        React.createElement("div", { style: { fontSize: 32 } }, "👥"),
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontWeight: 900, fontSize: 16, color: C.navy } }, "Comparativa Grupos"),
                            React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 2 } }, "Métricas agregadas por célula")
                        )
                    ),
                    React.createElement(Card, {
                        onClick: () => setView("historial"),
                        style: { cursor: "pointer", transition: "all .2s", padding: "20px 24px", display: "flex", gap: 16, alignItems: "center", borderTop: `4px solid ${C.navy}` },
                        onMouseOver: e => e.currentTarget.style.transform = "translateY(-4px)",
                        onMouseOut: e => e.currentTarget.style.transform = "none"
                    },
                        React.createElement("div", { style: { fontSize: 32 } }, "📋"),
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontWeight: 900, fontSize: 16, color: C.navy } }, "Historial de Reportes"),
                            React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 2 } }, "Consultar informes guardados")
                        )
                    ),
                    React.createElement(Card, {
                        onClick: () => setView("personal"),
                        style: { cursor: "pointer", transition: "all .2s", padding: "20px 24px", display: "flex", gap: 16, alignItems: "center", borderTop: `4px solid ${C.orange}` },
                        onMouseOver: e => e.currentTarget.style.transform = "translateY(-4px)",
                        onMouseOut: e => e.currentTarget.style.transform = "none"
                    },
                        React.createElement("div", { style: { fontSize: 32 } }, "⚙️"),
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontWeight: 900, fontSize: 16, color: C.navy } }, "Gestión Personal"),
                            React.createElement("div", { style: { fontSize: 12, color: C.gray, marginTop: 2 } }, "Configurar grupos y turnos")
                        )
                    )
                )
            ),

            view === "resumen" && React.createElement(ViewResumen, { data: files }),
            view === "reporte_historial" && React.createElement(ViewReporteHistorial, { data: files }),
            view === "mensual" && React.createElement(ViewMensual, { user, onBack: () => setView("upload") }),
            view === "comparativa_grupos" && React.createElement(ViewComparativaGrupos, { user, onBack: () => setView("upload") }),
            view === "historial" && React.createElement(ViewHistorial, {
                user,
                onBack: () => setView("upload"),
                onLoadReport: (rep) => {
                    const raw = rep.datos || {};
                    const normalized = { ...raw };

                    // Compatibilidad con reportes viejos (datos aplanados)
                    if (Array.isArray(raw.agentes)) {
                        normalized.agentes = { agents: raw.agentes, meta: raw.agentesResumen || {} };
                    }
                    if (Array.isArray(raw.abandonadas)) {
                        normalized.abandonadas = { intervals: raw.abandonadas, totals: raw.abandonadasResumen || {}, meta: {} };
                    }

                    setFiles(normalized);
                    const types = [];
                    if (normalized.agentes?.agents?.length) types.push("agentes");
                    if (normalized.abandonadas?.intervals?.length) types.push("abandonadas");
                    if (normalized.despachoInicio?.length) types.push("despacho-inicio");
                    if (normalized.despachoDerivacion?.length) types.push("despacho-derivacion");
                    if (normalized.despachoCreacion?.length) types.push("despacho-creacion");
                    setLoaded(types);
                    setView("reporte_historial");
                }
            }),
            view === "horas" && React.createElement(ViewHoras, { data: files }),
            view === "operadores" && React.createElement(ViewOperadores, { data: files }),
            view === "operadores_analisis" && React.createElement(ViewAnalisisOperadores, { user, onBack: () => setView("upload"), navigateToProfile: (op) => { setProfileAgent(op); setView("operadores_perfil"); } }),
            view === "operadores_perfil" && React.createElement(ViewPerfilOperador, { user, initialAgent: profileAgent, onBack: () => { setProfileAgent(null); setView("upload"); } }),
            view === "despacho" && React.createElement(ViewDespacho, { data: files }),
            view === "personal" && React.createElement(ViewGestorPersonal, { user, onBack: () => setView("upload") }),
        )
    );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));