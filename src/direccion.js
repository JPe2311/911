// ─── SAE 911 — PORTAL ALTA DIRECCIÓN ─────────────────────────────────────────
// src/direccion.js
// Solo lectura. Auth: Firebase Google Sign-In.
// Trazabilidad: cada sesión se registra en Firestore (direccion_sessions).
// ─────────────────────────────────────────────────────────────────────────────

const { useState, useEffect, useCallback, useMemo, useRef } = React;

// ══════════════════════════════════════════════════════════════════════════════
//  FIREBASE REFS
// ══════════════════════════════════════════════════════════════════════════════
const getDB   = () => window.dbDir   || window.db   || null;
const getAuth = () => window.authDir || window.auth || null;

// ══════════════════════════════════════════════════════════════════════════════
//  THEME — paleta dorada / oscura
// ══════════════════════════════════════════════════════════════════════════════
const D = {
    bg:       "#080d1a",
    surface:  "#0f172a",
    card:     "rgba(15,23,42,0.75)",
    border:   "rgba(255,255,255,0.07)",
    gold:     "#f59e0b",
    goldBg:   "rgba(245,158,11,0.12)",
    goldBrd:  "rgba(245,158,11,0.25)",
    blue:     "#3b82f6",
    green:    "#22c55e",
    greenBg:  "rgba(34,197,94,0.12)",
    red:      "#ef4444",
    redBg:    "rgba(239,68,68,0.12)",
    orange:   "#f97316",
    orBg:     "rgba(249,115,22,0.12)",
    purple:   "#a855f7",
    gray:     "#64748b",
    text:     "#e2e8f0",
    textMid:  "#94a3b8",
};

const MONTH_NAMES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio",
                     "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function fmtSeconds(sec) {
    if (!sec || sec === 0) return `0"`;
    if (sec < 60) return `${sec}"`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return s > 0 ? `${m}' ${s}"` : `${m}'`;
}

function generateSessionToken() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function pct(a, b) { return b > 0 ? ((a / b) * 100).toFixed(1) : "0.0"; }

// ══════════════════════════════════════════════════════════════════════════════
//  FIRESTORE HELPERS (read-only + sessions)
// ══════════════════════════════════════════════════════════════════════════════
async function registerSession(user) {
    const db = getDB();
    if (!db || !user) return null;
    const token = generateSessionToken();
    try {
        const { collection, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        await addDoc(collection(db, "direccion_sessions"), {
            sessionToken:  token,
            uid:           user.uid,
            email:         user.email || "",
            displayName:   user.displayName || "",
            photoURL:      user.photoURL || "",
            loginAt:       serverTimestamp(),
            lastActivity:  serverTimestamp(),
            userAgent:     navigator.userAgent,
            active:        true,
        });
    } catch(e) { console.error("Error registrando sesión:", e); }
    return token;
}

async function closeSession(token) {
    const db = getDB();
    if (!db || !token) return;
    try {
        const { collection, query, where, getDocs, updateDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
        const q = query(collection(db, "direccion_sessions"), where("sessionToken", "==", token));
        const snap = await getDocs(q);
        for (const d of snap.docs) await updateDoc(d.ref, { active: false, logoutAt: serverTimestamp() });
    } catch(e) { console.error("Error cerrando sesión:", e); }
}

async function loadInformes() {
    const db = getDB();
    if (!db) return [];
    const { collection, query, orderBy, limit, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const snap = await getDocs(query(collection(db, "informes"), orderBy("fechaGuardado", "desc"), limit(45)));
    return snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
}

async function loadMensual() {
    const db = getDB();
    if (!db) return [];
    const { collection, query, orderBy, limit, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const snap = await getDocs(query(collection(db, "analisis_mensual"), orderBy("meta.year", "desc"), orderBy("meta.monthNum", "desc"), limit(24)));
    return snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
}

async function loadPerformance(month, year) {
    const db = getDB();
    if (!db) return [];
    const { collection, query, where, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    let q = collection(db, "operator_performance");
    if (month && month !== "all") q = query(q, where("month", "==", parseInt(month)));
    if (year  && year  !== "all") q = query(q, where("year",  "==", parseInt(year)));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data());
}

async function loadStaff() {
    const db = getDB();
    if (!db) return [];
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const snap = await getDocs(collection(db, "staff"));
    return snap.docs.map(d => d.data());
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════════
async function signInWithGoogle() {
    const auth = getAuth();
    if (!auth) return null;
    const { signInWithPopup, GoogleAuthProvider } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    return result.user;
}

async function signOutDir() {
    const auth = getAuth();
    if (!auth) return;
    const { signOut } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
    await signOut(auth);
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI PRIMITIVES
// ══════════════════════════════════════════════════════════════════════════════
function Spinner() {
    return React.createElement("div", {
        className: "spinner",
        style: { width: 18, height: 18, border: "2px solid rgba(255,255,255,0.1)", borderTop: `2px solid ${D.gold}`, borderRadius: "50%" }
    });
}

function KPICard({ label, value, sub, accent, icon, delay = 0 }) {
    const color = accent || D.gold;
    return React.createElement("div", {
        className: "kpi-card animate-counter",
        style: { animationDelay: `${delay}ms` }
    },
        React.createElement("div", { style: { position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: "14px 14px 0 0", background: color } }),
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: D.gray, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 10 } }, label),
                React.createElement("div", { style: { fontSize: 28, fontWeight: 900, color: D.text, lineHeight: 1 } }, value),
                sub && React.createElement("div", { style: { fontSize: 11, color: D.textMid, marginTop: 6, fontWeight: 500 } }, sub)
            ),
            icon && React.createElement("div", { style: { fontSize: 24, opacity: 0.6 } }, icon)
        )
    );
}

function SectionTitle({ children, icon }) {
    return React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }
    },
        icon && React.createElement("span", { style: { fontSize: 18 } }, icon),
        React.createElement("h3", { style: { margin: 0, fontSize: 13, fontWeight: 800, color: D.textMid, textTransform: "uppercase", letterSpacing: "1.2px" } }, children)
    );
}

function MiniBar({ pct: p, color }) {
    const v = Math.min(100, Math.max(0, parseFloat(p) || 0));
    return React.createElement("div", { style: { flex: 1, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 99 } },
        React.createElement("div", { style: { width: `${v}%`, height: "100%", borderRadius: 99, background: color, transition: "width 0.6s ease" } })
    );
}

function Badge({ label, color, bg }) {
    return React.createElement("span", {
        className: "badge",
        style: { background: bg || "rgba(255,255,255,0.08)", color: color || D.textMid }
    }, label);
}

// ══════════════════════════════════════════════════════════════════════════════
//  CHART COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════
function ChartBar({ id, data, options }) {
    const ref = useRef(null); const chartRef = useRef(null);
    useEffect(() => {
        if (!ref.current) return;
        if (chartRef.current) chartRef.current.destroy();
        const defaults = {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: D.textMid, font: { size: 11 } } } },
            scales: {
                x: { ticks: { color: D.gray, font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                y: { ticks: { color: D.gray, font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } }
            }
        };
        chartRef.current = new Chart(ref.current, { type: "bar", data, options: { ...defaults, ...options } });
        return () => { if (chartRef.current) chartRef.current.destroy(); };
    }, [JSON.stringify(data)]);
    return React.createElement("canvas", { ref, id });
}

function ChartLine({ id, data, options }) {
    const ref = useRef(null); const chartRef = useRef(null);
    useEffect(() => {
        if (!ref.current) return;
        if (chartRef.current) chartRef.current.destroy();
        const defaults = {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: D.textMid, font: { size: 11 } } } },
            scales: {
                x: { ticks: { color: D.gray, font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                y: { ticks: { color: D.gray, font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } }
            }
        };
        chartRef.current = new Chart(ref.current, { type: "line", data, options: { ...defaults, ...options } });
        return () => { if (chartRef.current) chartRef.current.destroy(); };
    }, [JSON.stringify(data)]);
    return React.createElement("canvas", { ref, id });
}

function ChartDoughnut({ id, data, options }) {
    const ref = useRef(null); const chartRef = useRef(null);
    useEffect(() => {
        if (!ref.current) return;
        if (chartRef.current) chartRef.current.destroy();
        const defaults = {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: "right", labels: { color: D.textMid, font: { size: 11 }, padding: 12 } } },
            cutout: "70%"
        };
        chartRef.current = new Chart(ref.current, { type: "doughnut", data, options: { ...defaults, ...options } });
        return () => { if (chartRef.current) chartRef.current.destroy(); };
    }, [JSON.stringify(data)]);
    return React.createElement("canvas", { ref, id });
}

// ══════════════════════════════════════════════════════════════════════════════
//  LOGIN VIEW
// ══════════════════════════════════════════════════════════════════════════════
function LoginView({ onLogin }) {
    const [loading, setLoading] = useState(false);
    const [err, setErr]         = useState(null);

    const handleGoogle = async () => {
        setLoading(true); setErr(null);
        try {
            const u = await signInWithGoogle();
            if (u) onLogin(u);
            else setErr("No se pudo iniciar sesión. Intentá nuevamente.");
        } catch(e) {
            setErr(e.message || "Error de autenticación.");
        } finally { setLoading(false); }
    };

    return React.createElement("div", { className: "login-bg" },
        React.createElement("div", { className: "login-card animate-slide" },

            // Badge
            React.createElement("div", { className: "login-badge", style: { display: "inline-flex", alignItems: "center", gap: 8, background: D.goldBg, border: `1px solid ${D.goldBrd}`, color: D.gold, borderRadius: 99, padding: "6px 16px", fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 28 } },
                React.createElement("span", null, "🔐"), "Acceso Restringido"
            ),

            // Logo
            React.createElement("img", {
                src: "src/img/dirlogo.png",
                alt: "SAE 911",
                style: { height: 56, marginBottom: 24, objectFit: "contain" },
                onError: e => { e.target.style.display = "none"; }
            }),

            React.createElement("h1", {
                style: { fontSize: 22, fontWeight: 900, color: D.text, marginBottom: 6, letterSpacing: "-0.5px" }
            }, "Portal Alta Dirección"),

            React.createElement("p", {
                style: { fontSize: 13, color: D.textMid, marginBottom: 36, lineHeight: 1.5 }
            }, "SAE 911 — Visualización ejecutiva de KPIs y gestión"),

            // Divider
            React.createElement("div", {
                style: { height: 1, background: "rgba(255,255,255,0.06)", marginBottom: 32 }
            }),

            React.createElement("button", {
                className: "btn-google",
                onClick: handleGoogle,
                disabled: loading,
                id: "btn-login-google"
            },
                loading
                    ? React.createElement(Spinner)
                    : React.createElement("svg", { width: 20, height: 20, viewBox: "0 0 48 48" },
                        React.createElement("path", { fill: "#EA4335", d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" }),
                        React.createElement("path", { fill: "#4285F4", d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" }),
                        React.createElement("path", { fill: "#FBBC05", d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" }),
                        React.createElement("path", { fill: "#34A853", d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.35-8.16 2.35-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" }),
                        React.createElement("path", { fill: "none", d: "M0 0h48v48H0z" })
                    ),
                loading ? "Iniciando sesión..." : "Ingresar con Google"
            ),

            err && React.createElement("div", {
                style: { marginTop: 16, padding: "10px 14px", background: D.redBg, border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, fontSize: 12, color: "#fca5a5", textAlign: "center" }
            }, err),

            React.createElement("p", {
                style: { marginTop: 28, fontSize: 11, color: D.gray, lineHeight: 1.5 }
            }, "El acceso queda registrado con trazabilidad completa en el sistema.")
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  HEADER
// ══════════════════════════════════════════════════════════════════════════════
function Header({ user, sessionToken, onLogout }) {
    const tokenShort = sessionToken ? sessionToken.split("-")[0].toUpperCase() : "—";

    return React.createElement("div", { className: "dir-topbar" },

        // Left: Logo + título
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
            React.createElement("img", {
                src: "src/img/dirlogo.png",
                alt: "Logo",
                style: { height: 40, objectFit: "contain" },
                onError: e => { e.target.style.display = "none"; }
            }),
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: 14, fontWeight: 900, color: D.text, letterSpacing: "-0.3px" } }, "Portal Alta Dirección"),
                React.createElement("div", { style: { fontSize: 10, color: D.gray, fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" } }, "SAE 911 — Solo Lectura")
            )
        ),

        // Center: Gold badge
        React.createElement("div", { style: { flex: 1, display: "flex", justifyContent: "center" } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, background: D.goldBg, border: `1px solid ${D.goldBrd}`, borderRadius: 10, padding: "5px 14px" } },
                React.createElement("span", { style: { fontSize: 13 } }, "🛡️"),
                React.createElement("span", { style: { fontSize: 11, fontWeight: 800, color: D.gold, textTransform: "uppercase", letterSpacing: "1px" } }, "Acceso Ejecutivo")
            )
        ),

        // Right: token + user + logout
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
            React.createElement("span", { className: "token-chip", title: `Token completo: ${sessionToken}` }, `TK-${tokenShort}`),
            user.photoURL && React.createElement("img", {
                src: user.photoURL,
                referrerPolicy: "no-referrer",
                style: { width: 30, height: 30, borderRadius: "50%", border: `2px solid ${D.goldBrd}`, objectFit: "cover" }
            }),
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: 12, fontWeight: 700, color: D.text, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, user.displayName || user.email),
                React.createElement("div", { style: { fontSize: 10, color: D.gray } }, user.email)
            ),
            React.createElement("button", {
                onClick: onLogout,
                id: "btn-logout",
                title: "Cerrar sesión",
                style: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#fca5a5", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "Inter, sans-serif" }
            }, "✕ Salir")
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ALERTAS PANEL (automáticas)
// ══════════════════════════════════════════════════════════════════════════════
function AlertasPanel({ informes, mensual, performance }) {
    const alertas = useMemo(() => {
        const list = [];

        // ── 1. Turnos sin datos recientes
        if (!informes || informes.length === 0) {
            list.push({ level: "red", icon: "🚨", title: "Sin Datos de Turno", msg: "No hay informes de turno cargados en el sistema." });
        } else {
            const ultimo = informes[0];
            const hace = Date.now() - new Date(ultimo.fechaGuardado).getTime();
            const horas = hace / (1000 * 60 * 60);
            if (horas > 24) {
                list.push({ level: "orange", icon: "⚠️", title: "Datos Desactualizados", msg: `El último informe de turno tiene más de ${Math.round(horas)}h de antigüedad (${new Date(ultimo.fechaGuardado).toLocaleDateString("es-AR")}).` });
            }
        }

        // ── 2. Tasa de abandono alta (desde informes)
        const informesConAb = (informes || []).filter(r => r.resumen?.totalOfrecidas > 0);
        if (informesConAb.length > 0) {
            const avgAb = informesConAb.reduce((s, r) => {
                return s + ((r.resumen.totalAbandonadas || 0) / (r.resumen.totalOfrecidas || 1) * 100);
            }, 0) / informesConAb.length;
            if (avgAb > 15) {
                list.push({ level: "red", icon: "📈", title: "Abandono Elevado", msg: `Promedio de abandono en los últimos turnos: ${avgAb.toFixed(1)}% (umbral: 15%).`, value: `${avgAb.toFixed(1)}%` });
            } else if (avgAb > 8) {
                list.push({ level: "orange", icon: "📊", title: "Abandono en Alerta", msg: `Promedio de abandono: ${avgAb.toFixed(1)}% — Se recomienda monitoreo.`, value: `${avgAb.toFixed(1)}%` });
            } else if (avgAb > 0) {
                list.push({ level: "green", icon: "✅", title: "Abandono Bajo Control", msg: `Promedio de abandono: ${avgAb.toFixed(1)}% — Dentro del rango aceptable.`, value: `${avgAb.toFixed(1)}%` });
            }
        }

        // ── 3. TMO desde performance mensual
        if (performance && performance.length > 0) {
            const avgTmo = performance.reduce((s, p) => s + (p.avgManejo || 0), 0) / performance.length;
            if (avgTmo > 240) {
                list.push({ level: "red", icon: "⏱️", title: "TMO Crítico", msg: `El tiempo medio de operación supera los 4 min (${fmtSeconds(Math.round(avgTmo))}). Revisar protocolos.`, value: fmtSeconds(Math.round(avgTmo)) });
            } else if (avgTmo > 180) {
                list.push({ level: "orange", icon: "⏱️", title: "TMO Elevado", msg: `TMO promedio: ${fmtSeconds(Math.round(avgTmo))} — Por encima de los 3 min recomendados.`, value: fmtSeconds(Math.round(avgTmo)) });
            }
        }

        // ── 4. Operadores sin grupo asignado
        if (performance && performance.length > 0) {
            const sinGrupo = performance.filter(p => !p.groupName).length;
            if (sinGrupo > 0) {
                list.push({ level: "blue", icon: "👥", title: "Operadores Sin Grupo", msg: `${sinGrupo} registro(s) de operadores sin célula asignada. Configurar en Gestión de Personal.`, value: `${sinGrupo}` });
            }
        }

        // ── 5. Datos mensuales disponibles
        if (mensual && mensual.length > 0) {
            const lastMes = mensual[0];
            list.push({ level: "blue", icon: "📊", title: "Datos Mensuales", msg: `Último análisis mensual cargado: ${MONTH_NAMES[lastMes.meta?.monthNum] || "—"} ${lastMes.meta?.year || ""}` });
        }

        return list;
    }, [informes, mensual, performance]);

    if (!alertas.length) return null;

    const colorMap = { red: D.red, orange: D.orange, green: D.green, blue: D.blue };
    const bgMap    = { red: D.redBg, orange: D.orBg, green: D.greenBg, blue: D.goldBg };

    return React.createElement("div", { className: "animate-fade", style: { marginBottom: 28 } },
        React.createElement(SectionTitle, { icon: "🔔" }, "Alertas del Sistema"),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 } },
            alertas.map((a, i) => {
                const color = colorMap[a.level] || D.blue;
                const bg    = bgMap[a.level]    || D.goldBg;
                return React.createElement("div", {
                    key: i,
                    className: a.level === "red" ? "alert-critical" : "",
                    style: { display: "flex", gap: 14, alignItems: "center", background: D.card, borderLeft: `4px solid ${color}`, borderRadius: 12, padding: "14px 18px", border: `1px solid rgba(255,255,255,0.05)` }
                },
                    React.createElement("div", { style: { width: 38, height: 38, borderRadius: 10, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 } }, a.icon),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: "0.7px", marginBottom: 3 } }, a.title),
                        React.createElement("div", { style: { fontSize: 12, color: D.textMid, lineHeight: 1.4 } }, a.msg)
                    ),
                    a.value && React.createElement("div", { style: { fontSize: 16, fontWeight: 900, color, flexShrink: 0 } }, a.value)
                );
            })
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIEW: RESUMEN MENSUAL
// ══════════════════════════════════════════════════════════════════════════════
function ViewMensualDir({ mensual }) {
    const years  = useMemo(() => [...new Set((mensual || []).map(m => m.meta?.year).filter(Boolean))].sort((a,b) => b-a), [mensual]);
    const months = useMemo(() => [...new Set((mensual || []).map(m => m.meta?.monthNum).filter(Boolean))].sort((a,b) => a-b), [mensual]);

    const [year,  setYear]  = useState(() => years[0]  || new Date().getFullYear());
    const [month, setMonth] = useState("all");

    const filtered = useMemo(() => {
        return (mensual || []).filter(m => {
            const yMatch = !year  || m.meta?.year     === parseInt(year);
            const mMatch = month === "all" || m.meta?.monthNum === parseInt(month);
            return yMatch && mMatch;
        }).sort((a, b) => (a.meta?.monthNum || 0) - (b.meta?.monthNum || 0));
    }, [mensual, year, month]);

    // Totales acumulados del filtro
    const totals = useMemo(() => {
        const acc = { totalC: 0, totalO: 0, totalAb: 0, records: 0 };
        filtered.forEach(m => {
            const rows = m.detalles || m.dailyAggr || m.rows || m.operadores || [];
            if (rows.length > 0) {
                rows.forEach(r => {
                    acc.totalO  += (r.o  || r.ofrecidas || 0);
                    acc.totalC  += (r.c  || r.contestadas || 0);
                    acc.totalAb += (r.ab || r.abandonadas || 0);
                    acc.records++;
                });
            } else if (m.resumen) {
                acc.totalO  += m.resumen.totalOfrecidas || 0;
                acc.totalC  += m.resumen.totalContestadas || 0;
                acc.totalAb += m.resumen.totalAbandonadas || 0;
                acc.records++;
            }
        });
        return acc;
    }, [filtered]);

    // Chart: contestadas por mes
    const chartData = useMemo(() => {
        const byMonth = {};
        filtered.forEach(m => {
            const mn = m.meta?.monthNum;
            if (!mn) return;
            let sumC = 0, sumO = 0, sumAb = 0;
            const rows = m.detalles || m.dailyAggr || m.rows || m.operadores || [];
            if (rows.length > 0) {
                sumC  = rows.reduce((s,r) => s + (r.c  || r.contestadas || 0), 0);
                sumO  = rows.reduce((s,r) => s + (r.o  || r.ofrecidas || 0), 0);
                sumAb = rows.reduce((s,r) => s + (r.ab || r.abandonadas || 0), 0);
            } else if (m.resumen) {
                sumC = m.resumen.totalContestadas || 0;
                sumO = m.resumen.totalOfrecidas || 0;
                sumAb = m.resumen.totalAbandonadas || 0;
            }
            byMonth[mn] = { c: sumC, o: sumO, ab: sumAb, label: MONTH_NAMES[mn] };
        });
        const keys   = Object.keys(byMonth).sort((a,b) => a-b);
        const labels = keys.map(k => byMonth[k].label);
        return {
            labels,
            datasets: [
                { label: "Contestadas", data: keys.map(k => byMonth[k].c),  backgroundColor: "rgba(59,130,246,0.7)", borderRadius: 6 },
                { label: "Abandonadas", data: keys.map(k => byMonth[k].ab), backgroundColor: "rgba(239,68,68,0.6)",  borderRadius: 6 },
            ]
        };
    }, [filtered]);

    if (!mensual || mensual.length === 0) {
        return React.createElement("div", { className: "dir-card", style: { textAlign: "center", padding: 60, color: D.gray } },
            React.createElement("div", { style: { fontSize: 40, marginBottom: 12 } }, "📊"),
            React.createElement("div", { style: { fontWeight: 700, fontSize: 15 } }, "Sin datos mensuales"),
            React.createElement("div", { style: { fontSize: 13, marginTop: 6 } }, "Cargá un análisis mensual desde el sistema principal.")
        );
    }

    return React.createElement("div", { className: "animate-fade" },

        // Filtros
        React.createElement("div", { style: { display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" } },
            React.createElement("select", { className: "dir-select", value: year, onChange: e => setYear(e.target.value), id: "sel-year-mensual" },
                years.map(y => React.createElement("option", { key: y, value: y }, y))
            ),
            React.createElement("select", { className: "dir-select", value: month, onChange: e => setMonth(e.target.value), id: "sel-month-mensual" },
                React.createElement("option", { value: "all" }, "Todos los meses"),
                months.map(m => React.createElement("option", { key: m, value: m }, MONTH_NAMES[m]))
            ),
            React.createElement("span", { style: { fontSize: 12, color: D.gray, marginLeft: "auto" } }, `${filtered.length} período(s) con datos`)
        ),

        // KPIs
        React.createElement("div", { className: "kpi-grid", style: { gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" } },
            React.createElement(KPICard, { label: "Llamadas Atendidas",  value: totals.totalC.toLocaleString("es-AR"),  icon: "📞", accent: D.blue,   delay: 0   }),
            React.createElement(KPICard, { label: "Llamadas Ofrecidas",  value: totals.totalO.toLocaleString("es-AR"),  icon: "📲", accent: D.purple, delay: 80  }),
            React.createElement(KPICard, { label: "Abandonadas",         value: totals.totalAb.toLocaleString("es-AR"), icon: "📉", accent: D.red,    delay: 160 }),
            React.createElement(KPICard, { label: "% Atención",         value: `${pct(totals.totalC, totals.totalO)}%`, icon: "🎯", accent: D.green,  delay: 240,
                sub: totals.totalO > 0 ? `${totals.totalC} de ${totals.totalO}` : "" })
        ),

        // Gráfico
        filtered.length > 1 && React.createElement("div", { className: "dir-card", style: { marginBottom: 24 } },
            React.createElement(SectionTitle, { icon: "📊" }, "Evolución Mensual — Contestadas vs Abandonadas"),
            React.createElement("div", { style: { height: 280 } },
                React.createElement(ChartBar, { id: "dir-bar-mensual", data: chartData })
            )
        ),

        // Tabla de periodos
        React.createElement("div", { className: "dir-card", style: { padding: 0, overflow: "hidden" } },
            React.createElement("div", { style: { padding: "16px 20px", borderBottom: `1px solid ${D.border}`, fontWeight: 800, fontSize: 13, color: D.textMid } }, "Detalle por Período"),
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { className: "dir-table" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            ["Mes", "Año", "Operadores", "Ofrecidas", "Contestadas", "Abandonadas", "% Atención"].map(h =>
                                React.createElement("th", { key: h }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        filtered.map((m, i) => {
                            let sumO = 0, sumC = 0, sumAb = 0, rowLen = 0;
                            const rows = m.detalles || m.dailyAggr || m.rows || m.operadores || [];
                            
                            if (rows.length > 0) {
                                sumO  = rows.reduce((s,r) => s + (r.o  || r.ofrecidas || 0), 0);
                                sumC  = rows.reduce((s,r) => s + (r.c  || r.contestadas || 0), 0);
                                sumAb = rows.reduce((s,r) => s + (r.ab || r.abandonadas || 0), 0);
                                rowLen = rows.length;
                            } else if (m.resumen) {
                                sumO = m.resumen.totalOfrecidas || 0;
                                sumC = m.resumen.totalContestadas || 0;
                                sumAb = m.resumen.totalAbandonadas || 0;
                                rowLen = 0;
                            }
                            const pctAt = pct(sumC, sumO);
                            return React.createElement("tr", { key: i },
                                React.createElement("td", { style: { fontWeight: 800, color: D.gold } }, MONTH_NAMES[m.meta?.monthNum] || "—"),
                                React.createElement("td", { style: { color: D.textMid } }, m.meta?.year || "—"),
                                React.createElement("td", null, rowLen),
                                React.createElement("td", null, sumO.toLocaleString("es-AR")),
                                React.createElement("td", { style: { fontWeight: 700, color: D.blue } }, sumC.toLocaleString("es-AR")),
                                React.createElement("td", { style: { color: sumAb > 0 ? D.red : D.textMid } }, sumAb.toLocaleString("es-AR")),
                                React.createElement("td", null,
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                        React.createElement("span", { style: { fontWeight: 800, color: parseFloat(pctAt) > 85 ? D.green : parseFloat(pctAt) > 70 ? D.orange : D.red, minWidth: 44 } }, `${pctAt}%`),
                                        React.createElement(MiniBar, { pct: parseFloat(pctAt), color: parseFloat(pctAt) > 85 ? D.green : parseFloat(pctAt) > 70 ? D.orange : D.red })
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

// ══════════════════════════════════════════════════════════════════════════════
//  TURNO DETAIL VIEW — Resumen General Ejecutivo por Turno
// ══════════════════════════════════════════════════════════════════════════════
function TurnoDetailView({ report, onBack }) {
    const ab  = report.datos?.abandonadas;
    const ag  = report.datos?.agentes;
    const dpI = report.datos?.despachoInicio  || [];
    const dpD = report.datos?.despachoDerivacion || [];
    const dpC = report.datos?.despachoCreacion || [];

    const tot = ab?.totals || {};
    const ivs = ab?.intervals || [];
    const meta = ab?.meta || ag?.meta || {};
    const agents = ag?.agents || [];

    // Para mantener igualdad con `app.jsx`, los totales se toman del reporte 'abandonadas' primero y luego el calculo agregado de 'agentes'
    const totalO  = tot.ofrecidas   || report.resumen?.totalOfrecidas   || 0;
    const totalC  = tot.contestadas || report.resumen?.totalContestadas || 0;
    const totalAb = tot.abandonadas || report.resumen?.totalAbandonadas || 0;
    const pctAband = totalO > 0 ? ((totalAb / totalO) * 100).toFixed(1) : "0.0";
    const pctAtend = totalO > 0 ? ((totalC  / totalO) * 100).toFixed(1) : "0.0";
    const pctCola  = totalO > 0 ? (( (tot.cola||0) / totalO) * 100).toFixed(1) : "0.0";

    // Tiempos de despacho
    const avgSec = arr => arr.length ? Math.round(arr.reduce((s,v) => s+(v.tiempoSec||0),0)/arr.length) : 0;
    const tI = avgSec(dpI); const tD = avgSec(dpD); const tC = avgSec(dpC);

    // Ranking de agentes
    const ranked = [...agents].filter(a => a.ofrecidas >= 5).sort((a,b) => b.contestadas - a.contestadas);
    const avgManejo = ranked.length ? Math.round(ranked.reduce((s,a) => s + (a.tiempoManejo||0), 0) / ranked.length) : 0;

    // Chart data horario
    const horaData = ivs.length > 0 ? {
        labels: ivs.map(i => i.hora),
        datasets: [
            { label: "Atendidas",   data: ivs.map(i => i.contestadas), backgroundColor: "rgba(59,130,246,0.8)",  borderRadius: 5 },
            { label: "Abandonadas", data: ivs.map(i => i.abandonadas), backgroundColor: "rgba(239,68,68,0.75)", borderRadius: 5 },
        ]
    } : null;

    // Donut abandono
    const abandonDonut = (tot.cola || tot.cabina) ? {
        labels: ["En Cola", "En Cabina"],
        datasets: [{ data: [tot.cola||0, tot.cabina||0], backgroundColor: ["#f97316","#eab308"], borderWidth: 0 }]
    } : null;

    // Chart agentes (top 12)
    const agentesData = ranked.length > 0 ? {
        labels: ranked.slice(0,12).map(a => (a.nombre||"").split(",")[0]),
        datasets: [
            { label: "Contestadas", data: ranked.slice(0,12).map(a => a.contestadas), backgroundColor: "rgba(59,130,246,0.85)", borderRadius: 5 },
            { label: "Abandonadas", data: ranked.slice(0,12).map(a => a.abandonadas), backgroundColor: "rgba(239,68,68,0.7)",  borderRadius: 5 },
        ]
    } : null;

    // Chart despacho por distrito
    const dp = dpI.length ? dpI : (dpD.length ? dpD : dpC);
    const despData = dp.length > 0 ? {
        labels: [...dp].sort((a,b)=>(a.tiempoSec||0)-(b.tiempoSec||0)).map(d => (d.nombre||"").replace("DISTRITO ","D.")),
        datasets: [{ label: "Seg. promedio", data: [...dp].sort((a,b)=>(a.tiempoSec||0)-(b.tiempoSec||0)).map(d => d.tiempoSec||0), borderColor: D.gold, backgroundColor: "rgba(245,158,11,0.08)", fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: [...dp].sort((a,b)=>(a.tiempoSec||0)-(b.tiempoSec||0)).map(d => (d.tiempoSec||0)>200 ? D.red : (d.tiempoSec||0)<40 ? D.green : D.gold) }]
    } : null;

    const chartOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: D.textMid, font: { size: 10 } } } }, scales: { x: { ticks: { color: D.gray, font:{size:9} }, grid: { color: "rgba(255,255,255,0.04)" } }, y: { ticks: { color: D.gray, font:{size:9} }, grid: { color: "rgba(255,255,255,0.04)" } } } };
    const donutOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: D.textMid, font:{size:10}, padding:10 } } }, cutout: "65%" };

    const getGaugeColor = (v, threshold) => v > threshold ? D.red : v > threshold*0.75 ? D.orange : D.green;

    const turnoLabel = `${report.turno?.fecha||""} ${report.turno?.horaDesde||""} → ${report.turno?.horaHasta||""}`.trim();

    // Alertas automáticas
    const alertas = [];
    const pctAbNum = parseFloat(pctAband);
    if (pctAbNum > 25) alertas.push({ level:"red", msg:`Tasa de abandono elevada: ${pctAband}% (supera el 25%)` });
    else if (pctAbNum >= 15) alertas.push({ level:"orange", msg:`Tasa de abandono moderada: ${pctAband}% — monitorear` });
    else if (pctAbNum > 0) alertas.push({ level:"green", msg:`Tasa de abandono dentro del rango aceptable: ${pctAband}%` });
    if (tC > 180) alertas.push({ level:"red", msg:`Tiempo Creación→Despacho excede la meta: ${fmtSeconds(tC)} (meta: 3')` });
    if (tI > 120) alertas.push({ level:"orange", msg:`Tiempo Inicio→Despacho elevado: ${fmtSeconds(tI)} (meta: 2')` });
    const peakHour = ivs.reduce((mx,i) => i.ofrecidas > (mx.ofrecidas||0) ? i : mx, {});
    if (peakHour.hora) alertas.push({ level:"blue", msg:`Pico de demanda registrado a las ${peakHour.hora}: ${peakHour.ofrecidas} llamadas ofrecidas.` });

    const alertColor = { red:D.red, orange:D.orange, green:D.green, blue:D.blue };
    const alertBg    = { red:D.redBg, orange:D.orBg, green:D.greenBg, blue:D.goldBg };

    return React.createElement("div", { className: "animate-fade" },

        // Botón volver
        onBack && React.createElement("button", {
            onClick: onBack,
            style: { background: "transparent", border: `1px solid ${D.border}`, color: D.textMid, borderRadius: 8, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 600, marginBottom: 20, fontFamily: "Inter,sans-serif" }
        }, "← Volver a la lista"),

        // Header banner
        React.createElement("div", { style: { background: "linear-gradient(135deg,#080d1a 0%,#0f2444 60%,#1B3A6B 100%)", borderRadius: 16, padding: 28, marginBottom: 24, border: `1px solid ${D.goldBrd}`, display: "flex", justifyContent: "space-between", alignItems: "center" } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: D.gold, letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 } }, "Portal Alta Dirección — SAE 911"),
                React.createElement("div", { style: { fontSize: 24, fontWeight: 900, color: D.text, letterSpacing: "-0.5px", marginBottom: 4 } }, "Resumen General de Gestión"),
                React.createElement("div", { style: { fontSize: 13, color: D.textMid } }, `🗓 ${turnoLabel}`)
            ),
            React.createElement("div", { style: { textAlign: "right" } },
                report.usuario && React.createElement("div", { style: { fontSize: 11, color: D.gold, fontWeight: 700 } }, `Autor: ${report.usuario}`),
                React.createElement("div", { style: { marginTop: 6, display: "flex", gap: 8 } },
                    React.createElement(Badge, { label: `${pctAtend}% Atendidas`, color: parseFloat(pctAtend)>85?D.green:D.orange, bg: parseFloat(pctAtend)>85?D.greenBg:D.orBg }),
                    React.createElement(Badge, { label: `${pctAband}% Abandono`, color: pctAbNum>15?D.red:pctAbNum>8?D.orange:D.green, bg: pctAbNum>15?D.redBg:pctAbNum>8?D.orBg:D.greenBg })
                )
            )
        ),

        // KPIs principales
        React.createElement("div", { className: "kpi-grid", style: { gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginBottom: 24 } },
            React.createElement(KPICard, { label: "Total Ofrecidas",  value: totalO.toLocaleString("es-AR"),  icon: "📲", accent: D.purple, delay:0   }),
            React.createElement(KPICard, { label: "Llamadas Atendidas", value: totalC.toLocaleString("es-AR"),  icon: "📞", accent: D.blue,   delay:60  }),
            React.createElement(KPICard, { label: "Llamadas Perdidas",  value: totalAb.toLocaleString("es-AR"), icon: "📉", accent: D.red,    delay:120 }),
            React.createElement(KPICard, { label: "% Atención",  value: `${pctAtend}%`, icon: "🎯", accent: parseFloat(pctAtend)>85?D.green:D.orange, delay:180 }),
            React.createElement(KPICard, { label: "% Abandono",  value: `${pctAband}%`, icon: "⚠️", accent: pctAbNum>15?D.red:pctAbNum>8?D.orange:D.green, delay:240 }),
            React.createElement(KPICard, { label: "% Abandono Cola", value: `${pctCola}%`, icon: "⏳", accent: parseFloat(pctCola)>10?D.orange:D.blue, delay:270 }),
            React.createElement(KPICard, { label: "TMO Promedio", value: fmtSeconds(avgManejo), icon: "⏱️", accent: D.gold, delay:300, sub: `${ranked.length} operadores` })
        ),

        // Numérica detallada + SLA tiempos
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, marginBottom: 20 } },
            // Numérica
            React.createElement("div", { className: "dir-card" },
                React.createElement(SectionTitle, { icon: "📊" }, "Numérica Detallada del Período"),
                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
                    [
                        { label:"Ofrecidas",    val: totalO,              c: D.blue   },
                        { label:"Contestadas",  val: totalC,              c: D.green  },
                        { label:"Abandonadas",  val: totalAb,             c: D.red    },
                        { label:"Abandono Cola",    val: tot.cola||0,     c: D.orange },
                        { label:"Abandono Cabina",  val: tot.cabina||0,   c: D.yellow||"#eab308" },
                        { label:"Operadores",   val: agents.length,       c: D.purple },
                    ].map(n => React.createElement("div", { key: n.label, style: { padding: "12px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 10, borderLeft: `3px solid ${n.c}` } },
                        React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: D.gray, textTransform: "uppercase", marginBottom: 4 } }, n.label),
                        React.createElement("div", { style: { fontSize: 20, fontWeight: 900, color: D.text } }, typeof n.val === "number" ? n.val.toLocaleString("es-AR") : n.val)
                    ))
                )
            ),
            // SLA tiempos despacho
            React.createElement("div", { className: "dir-card" },
                React.createElement(SectionTitle, { icon: "⏱️" }, "Tiempos de Respuesta (SLA)"),
                React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                    [
                        { label:"Creación → Despacho",  val: tC, meta: 180 },
                        { label:"Derivación → Inicio",   val: tD, meta: 60  },
                        { label:"Inicio → Despacho",     val: tI, meta: 120 },
                    ].map(t => React.createElement("div", { key: t.label, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 12 } },
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontSize: 11, fontWeight: 800, color: D.textMid } }, t.label),
                            React.createElement("div", { style: { fontSize: 9, color: D.gray } }, `Meta: ${fmtSeconds(t.meta)}`)
                        ),
                        React.createElement("div", { style: { textAlign: "right" } },
                            React.createElement("div", { style: { fontSize: 22, fontWeight: 950, color: getGaugeColor(t.val, t.meta) } }, t.val > 0 ? fmtSeconds(t.val) : "—"),
                            t.val > 0 && React.createElement("div", { style: { fontSize: 9, fontWeight: 700, color: t.val > t.meta ? D.red : D.green } }, t.val > t.meta ? "🚫 Excede" : "✅ Cumple")
                        )
                    ))
                )
            )
        ),

        // Gráfico horario + donut de abandono
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, marginBottom: 20 } },
            horaData && React.createElement("div", { className: "dir-card" },
                React.createElement(SectionTitle, { icon: "📈" }, "Distribución de Llamadas por Hora"),
                React.createElement("div", { style: { height: 260 } },
                    React.createElement(ChartBar, { id: "dir-hora-chart", data: horaData, options: chartOpts })
                )
            ),
            abandonDonut && React.createElement("div", { className: "dir-card" },
                React.createElement(SectionTitle, { icon: "🔴" }, "Composición de Abandono"),
                React.createElement("div", { style: { height: 180 } },
                    React.createElement(ChartDoughnut, { id: "dir-donut-chart", data: abandonDonut, options: donutOpts })
                ),
                React.createElement("div", { style: { marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 } },
                    React.createElement(Badge, { label: `Cola: ${tot.cola||0}`,   color: D.orange, bg: D.orBg }),
                    React.createElement(Badge, { label: `Cabina: ${tot.cabina||0}`, color: "#eab308", bg: "rgba(234,179,8,0.12)" }),
                    React.createElement(Badge, { label: `Total: ${totalAb}`,       color: D.red,    bg: D.redBg })
                )
            )
        ),

        // Gráfico de rendimiento por operador + ranking top/bottom
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, marginBottom: 20 } },
            agentesData && React.createElement("div", { className: "dir-card" },
                React.createElement(SectionTitle, { icon: "👤" }, "Rendimiento por Operador (Top 12)"),
                React.createElement("div", { style: { height: 320 } },
                    React.createElement(ChartBar, { id: "dir-agentes-chart", data: agentesData, options: { ...chartOpts, indexAxis: "y", plugins: { legend: { position:"bottom", labels:{color:D.textMid,font:{size:10}} } } } })
                )
            ),
            ranked.length > 0 && React.createElement("div", { className: "dir-card" },
                React.createElement(SectionTitle, { icon: "🏆" }, "Rankings del Turno"),
                // Top 5
                React.createElement("div", { style: { marginBottom: 20 } },
                    React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: D.green, marginBottom: 10 } }, "🥇 MEJOR DESEMPEÑO"),
                    ranked.slice(0,5).map((a,i) => React.createElement("div", { key: a.nombre, style: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 8 } },
                        React.createElement("div", { style: { display:"flex", alignItems:"center", gap: 8 } },
                            React.createElement("div", { style: { width:22, height:22, borderRadius:"50%", background:D.green, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900 } }, i+1),
                            React.createElement("span", { style: { fontSize:11, fontWeight:700, color:D.text } }, (a.nombre||"").split(",")[0])
                        ),
                        React.createElement("span", { style: { fontSize:13, fontWeight:900, color:D.blue } }, a.contestadas)
                    ))
                ),
                // Bottom 5
                React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: 10, fontWeight: 800, color: D.red, marginBottom: 10 } }, "⚠️ MENOR ACTIVIDAD"),
                    [...ranked].reverse().slice(0,5).map((a,i) => React.createElement("div", { key: a.nombre+"b", style: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 8 } },
                        React.createElement("div", { style: { display:"flex", alignItems:"center", gap: 8 } },
                            React.createElement("div", { style: { width:22, height:22, borderRadius:"50%", background:D.redBg, color:D.red, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900 } }, ranked.length-i),
                            React.createElement("span", { style: { fontSize:11, fontWeight:700, color:D.textMid } }, (a.nombre||"").split(",")[0])
                        ),
                        React.createElement("span", { style: { fontSize:13, fontWeight:900, color:D.gray } }, a.contestadas)
                    ))
                )
            )
        ),

        // Tiempos de despacho por distrito
        despData && React.createElement("div", { className: "dir-card", style: { marginBottom: 20 } },
            React.createElement(SectionTitle, { icon: "🚓" }, "Tiempos de Despacho por Distrito"),
            React.createElement("div", { style: { height: 240 } },
                React.createElement(ChartLine, { id: "dir-despacho-chart", data: despData, options: { ...chartOpts, plugins: { legend:{display:false} }, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, ticks: { ...chartOpts.scales.y.ticks, callback: v => fmtSeconds(v) } } } } })
            )
        ),

        // Alertas automáticas
        alertas.length > 0 && React.createElement("div", { className: "dir-card", style: { marginBottom: 20 } },
            React.createElement(SectionTitle, { icon: "🔔" }, "Alertas Automáticas del Turno"),
            React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
                alertas.map((a,i) => React.createElement("div", { key: i, style: { display:"flex", gap: 12, alignItems: "flex-start", padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderLeft: `4px solid ${alertColor[a.level]||D.blue}`, borderRadius: 10 } },
                    React.createElement("div", { style: { fontSize: 16 } }, a.level==="red"?"🚨":a.level==="orange"?"⚠️":a.level==="green"?"✅":"ℹ️"),
                    React.createElement("div", { style: { fontSize: 12, color: D.textMid, lineHeight: 1.5 } }, a.msg)
                ))
            )
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  CALENDAR PICKER CUSTOM PARA DIRECCION
// ══════════════════════════════════════════════════════════════════════════════
function parseDirDate(dStr) {
    if (!dStr) return new Date(0);
    const p = dStr.split(/[/-]/);
    if (p.length === 3) return new Date(p[2], parseInt(p[1]) - 1, p[0]);
    return new Date(0);
}

function CalendarPicker({ selectedDate, validDates, onSelect }) {
    const [open, setOpen] = useState(false);
    const [currentMonth, setCurrentMonth] = useState(() => {
        const d = selectedDate ? parseDirDate(selectedDate) : new Date();
        return new Date(d.getFullYear(), d.getMonth(), 1);
    });
    const calRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (calRef.current && !calRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
    const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
    const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

    const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
    const firstDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) days.push(i);

    const validSet = new Set(validDates);

    return React.createElement("div", { ref: calRef, style: { position: "relative" } },
        React.createElement("button", {
            className: "dir-select",
            onClick: () => setOpen(!open),
            style: { minWidth: 160, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: "rgba(255,255,255,0.05)", border: `1px solid ${D.border}`, color: D.textTop, fontWeight: 700 }
        },
            React.createElement("span", null, selectedDate || "Seleccionar Fecha..."),
            React.createElement("span", { style: { fontSize: 10, color: D.gold } }, "▼")
        ),
        open && React.createElement("div", { style: { position: "absolute", top: "110%", left: 0, zIndex: 50, background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16, boxShadow: "0 10px 40px rgba(0,0,0,0.8)", width: 280 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
                React.createElement("button", { onClick: prevMonth, style: { background: "transparent", border: "none", color: D.gold, cursor: "pointer", fontSize: 18 } }, "◀"),
                React.createElement("div", { style: { fontWeight: 800, color: D.textTop } }, `${monthNames[currentMonth.getMonth()]} ${currentMonth.getFullYear()}`),
                React.createElement("button", { onClick: nextMonth, style: { background: "transparent", border: "none", color: D.gold, cursor: "pointer", fontSize: 18 } }, "▶")
            ),
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, textAlign: "center", marginBottom: 8 } },
                ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"].map(d => React.createElement("div", { key: d, style: { fontSize: 11, color: D.gray, fontWeight: 700 } }, d))
            ),
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 } },
                days.map((d, i) => {
                    if (!d) return React.createElement("div", { key: i });
                    const dateStr = `${d.toString().padStart(2, "0")}-${(currentMonth.getMonth() + 1).toString().padStart(2, "0")}-${currentMonth.getFullYear()}`;
                    const hasReport = validSet.has(dateStr);
                    const isSelected = selectedDate === dateStr;
                    return React.createElement("button", {
                        key: i,
                        onClick: () => {
                            if (hasReport) {
                                onSelect(dateStr);
                                setOpen(false);
                            }
                        },
                        style: {
                            background: isSelected ? D.blue : (hasReport ? "rgba(255,255,255,0.05)" : "transparent"),
                            border: isSelected ? `1px solid ${D.blue}` : (hasReport ? `1px solid ${D.border}` : "1px solid transparent"),
                            color: isSelected ? "#fff" : (hasReport ? D.textTop : "rgba(255,255,255,0.2)"),
                            borderRadius: 6, padding: "6px 0", fontSize: 12, fontWeight: hasReport ? 800 : 400,
                            cursor: hasReport ? "pointer" : "default",
                            opacity: hasReport ? 1 : 0.3
                        }
                    }, d);
                })
            )
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIEW: REPORTE POR TURNO (con filtro por día)
// ══════════════════════════════════════════════════════════════════════════════
function ViewTurnoDir({ informes }) {
    // Obtener días únicos de los informes
    const dias = useMemo(() => {
        const set = new Set();
        (informes || []).forEach(r => {
            const fecha = r.turno?.fecha || r.datos?.agentes?.meta?.fechaDesde || "";
            if (fecha) set.add(fecha);
        });
        return Array.from(set).sort((a, b) => {
            return parseDirDate(b).getTime() - parseDirDate(a).getTime(); // Más reciente primero
        });
    }, [informes]);

    const [dia,    setDia]    = useState(() => dias[0] || "");
    const [turno,  setTurno]  = useState("all"); // all | dia(07-19) | noche(19-07)
    const [selIdx, setSelIdx] = useState(null);

    // Auto-seleccionar el día más reciente si aún no está seleccionado o llegaron datos nuevos
    useEffect(() => {
        if (!dia && dias.length > 0) setDia(dias[0]);
    }, [dias, dia]);

    // Filtrar informes por día seleccionado
    const porDia = useMemo(() => {
        return (informes || []).filter(r => {
            const fecha = r.turno?.fecha || r.datos?.agentes?.meta?.fechaDesde || "";
            return fecha === dia;
        }).sort((a, b) => {
            const ha = a.turno?.horaDesde || "";
            const hb = b.turno?.horaDesde || "";
            return ha.localeCompare(hb);
        });
    }, [informes, dia]);

    // Filtrar por turno (07-19 / 19-07)
    const porTurno = useMemo(() => {
        if (turno === "all") return porDia;
        return porDia.filter(r => {
            const h = parseInt((r.turno?.horaDesde || "00").split(":")[0]);
            if (turno === "dia")   return h >= 7  && h < 19;
            if (turno === "noche") return h >= 19 || h < 7;
            return true;
        });
    }, [porDia, turno]);

    const selReport = selIdx !== null ? porTurno[selIdx] : (porTurno.length === 1 ? porTurno[0] : null);

    if (!informes || informes.length === 0) {
        return React.createElement("div", { className: "dir-card", style: { textAlign: "center", padding: 60, color: D.gray } },
            React.createElement("div", { style: { fontSize: 40, marginBottom: 12 } }, "📋"),
            React.createElement("div", { style: { fontWeight: 700, fontSize: 15 } }, "Sin informes de turno"),
            React.createElement("div", { style: { fontSize: 13, marginTop: 6 } }, "Los informes se generan desde el sistema principal al cargar los CSV de turno.")
        );
    }

    return React.createElement("div", { className: "animate-fade" },

        // Filtros
        React.createElement("div", { style: { display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" } },
            // Selector de día (Calendario customizado)
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                React.createElement("span", { style: { fontSize: 13, color: D.gold, fontWeight: 800 } }, "📅 Día:"),
                React.createElement(CalendarPicker, {
                    selectedDate: dia,
                    validDates: dias,
                    onSelect: d => { setDia(d); setSelIdx(null); }
                })
            ),

            // Turno
            React.createElement("div", { className: "mode-tabs" },
                [["all","Todos"], ["dia","Turno Día 07-19"], ["noche","Turno Noche 19-07"]].map(([v, l]) =>
                    React.createElement("button", {
                        key: v,
                        className: `mode-tab ${turno === v ? "active" : ""}`,
                        onClick: () => { setTurno(v); setSelIdx(null); },
                        id: `tab-turno-${v}`
                    }, l)
                )
            ),

            React.createElement("span", { style: { fontSize: 12, color: D.gray, marginLeft: "auto" } },
                `${porTurno.length} informe(s)`
            )
        ),

        // Lista de informes del día
        porTurno.length === 0 && dia && React.createElement("div", { className: "dir-card", style: { textAlign: "center", padding: 40, color: D.gray } },
            "No hay informes para el día y turno seleccionado."
        ),

        porTurno.length > 1 && !selReport && React.createElement("div", { style: { marginBottom: 20 } },
            React.createElement(SectionTitle, { icon: "📋" }, `Informes del ${dia}`),
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 } },
                porTurno.map((r, i) => {
                    const hDesde = r.turno?.horaDesde || "—";
                    const hHasta = r.turno?.horaHasta || "—";
                    const atendidas = r.resumen?.totalContestadas || 0;
                    const ab        = r.resumen?.totalAbandonadas  || 0;
                    const ofrecidas = r.resumen?.totalOfrecidas     || 0;
                    return React.createElement("div", {
                        key: i,
                        onClick: () => setSelIdx(i),
                        style: { background: D.card, border: `1px solid ${D.goldBrd}`, borderRadius: 14, padding: "16px 20px", cursor: "pointer", transition: "all 0.2s" },
                        onMouseOver:  e => { e.currentTarget.style.borderColor = D.gold; e.currentTarget.style.transform = "translateY(-2px)"; },
                        onMouseOut:   e => { e.currentTarget.style.borderColor = D.goldBrd; e.currentTarget.style.transform = "none"; }
                    },
                        React.createElement("div", { style: { fontWeight: 800, fontSize: 14, color: D.gold, marginBottom: 8 } },
                            `${hDesde} → ${hHasta}`
                        ),
                        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                            React.createElement("div", { style: { fontSize: 11, color: D.gray } }, "Atendidas"),
                            React.createElement("div", { style: { fontWeight: 700, color: D.blue } }, atendidas),
                            React.createElement("div", { style: { fontSize: 11, color: D.gray } }, "Abandonadas"),
                            React.createElement("div", { style: { fontWeight: 700, color: D.red } }, ab),
                            React.createElement("div", { style: { fontSize: 11, color: D.gray } }, "% Atención"),
                            React.createElement("div", { style: { fontWeight: 700, color: D.green } }, `${pct(atendidas, ofrecidas)}%`)
                        ),
                        r.usuario && React.createElement("div", { style: { marginTop: 10, fontSize: 10, color: D.gray } }, `Cargado por: ${r.usuario}`)
                    );
                })
            )
        ),

        // Detalle del informe seleccionado — Resumen General Ejecutivo (Alineado con sistema principal)
        selReport && React.createElement(TurnoDetailView, { 
            report: selReport, 
            onBack: porTurno.length > 1 ? () => setSelIdx(null) : null 
        })
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  VIEW: PERSONAL (Operadores + Grupos)
// ══════════════════════════════════════════════════════════════════════════════
function ViewPersonalDir({ performance: rawPerf, staff: rawStaff }) {
    const years  = useMemo(() => [...new Set((rawPerf || []).map(p => p.year).filter(Boolean))].sort((a,b) => b-a), [rawPerf]);
    const [year,  setYear]  = useState(() => years[0] || new Date().getFullYear());
    const [month, setMonth] = useState("all");
    const [grupo, setGrupo] = useState("all");
    const [search, setSearch] = useState("");

    const staffMap = useMemo(() => {
        const m = {};
        (rawStaff || []).forEach(s => { m[s.normName] = s; });
        return m;
    }, [rawStaff]);

    const grupos = useMemo(() => {
        const set = new Set();
        (rawStaff || []).forEach(s => { if (s.grupo) set.add(s.grupo); });
        return Array.from(set).sort();
    }, [rawStaff]);

    const months = useMemo(() =>
        [...new Set((rawPerf || []).filter(p => !year || p.year === parseInt(year)).map(p => p.month).filter(Boolean))].sort((a,b) => a-b),
        [rawPerf, year]
    );

    // Agregar por operador (el período filtrado)
    const operadores = useMemo(() => {
        const filtered = (rawPerf || []).filter(p => {
            const yM = !year  || p.year  === parseInt(year);
            const mM = month === "all" || p.month === parseInt(month);
            return yM && mM;
        });

        const map = {};
        filtered.forEach(p => {
            if (!map[p.normName]) {
                map[p.normName] = { normName: p.normName, name: p.name, c: 0, o: 0, ab: 0, sumManejo: 0, sumConectado: 0, records: 0 };
            }
            map[p.normName].c            += (p.c || 0);
            map[p.normName].o            += (p.o || 0);
            map[p.normName].ab           += (p.ab || 0);
            map[p.normName].sumManejo    += (p.avgManejo || 0);
            map[p.normName].sumConectado += (p.totalConectado || 0);
            map[p.normName].records++;
        });

        return Object.values(map).map(op => ({
            ...op,
            grupo:    staffMap[op.normName]?.grupo || "—",
            turno:    staffMap[op.normName]?.turno || "—",
            avgManejo: Math.round(op.sumManejo / (op.records || 1)),
            prod:     op.sumConectado > 0 ? (op.c / (op.sumConectado / 3600)).toFixed(1) : "0.0",
        })).filter(op => {
            const gM = grupo === "all" || op.grupo === grupo;
            const sM = !search || (op.name || "").toLowerCase().includes(search.toLowerCase());
            return gM && sM;
        }).sort((a, b) => b.c - a.c);
    }, [rawPerf, year, month, grupo, search, staffMap]);

    // KPIs globales
    const totales = useMemo(() => ({
        totalC:  operadores.reduce((s, o) => s + o.c, 0),
        totalO:  operadores.reduce((s, o) => s + o.o, 0),
        totalAb: operadores.reduce((s, o) => s + o.ab, 0),
        count:   operadores.length,
    }), [operadores]);

    // Chart: productividad por grupo
    const chartGrupos = useMemo(() => {
        const gMap = {};
        operadores.forEach(op => {
            const g = op.grupo !== "—" ? op.grupo : "Sin Grupo";
            if (!gMap[g]) gMap[g] = { c: 0, count: 0 };
            gMap[g].c     += op.c;
            gMap[g].count++;
        });
        const labels = Object.keys(gMap).sort();
        const COLORS = ["#3b82f6","#22c55e","#f59e0b","#a855f7","#ef4444","#06b6d4"];
        return {
            labels,
            datasets: [{
                label: "Llamadas Atendidas",
                data: labels.map(l => gMap[l].c),
                backgroundColor: labels.map((_, i) => COLORS[i % COLORS.length]),
                borderRadius: 6,
            }]
        };
    }, [operadores]);

    if (!rawPerf || rawPerf.length === 0) {
        return React.createElement("div", { className: "dir-card", style: { textAlign: "center", padding: 60, color: D.gray } },
            React.createElement("div", { style: { fontSize: 40, marginBottom: 12 } }, "👥"),
            React.createElement("div", { style: { fontWeight: 700, fontSize: 15 } }, "Sin datos de personal"),
            React.createElement("div", { style: { fontSize: 13, marginTop: 6 } }, "Cargá los análisis mensuales desde el sistema principal para ver métricas de operadores.")
        );
    }

    return React.createElement("div", { className: "animate-fade" },

        // Filtros
        React.createElement("div", { style: { display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap", alignItems: "center" } },
            React.createElement("select", { className: "dir-select", value: year, onChange: e => setYear(e.target.value), id: "sel-year-personal" },
                years.map(y => React.createElement("option", { key: y, value: y }, y))
            ),
            React.createElement("select", { className: "dir-select", value: month, onChange: e => setMonth(e.target.value), id: "sel-month-personal" },
                React.createElement("option", { value: "all" }, "Todos los meses"),
                months.map(m => React.createElement("option", { key: m, value: m }, MONTH_NAMES[m]))
            ),
            React.createElement("select", { className: "dir-select", value: grupo, onChange: e => setGrupo(e.target.value), id: "sel-grupo-personal" },
                React.createElement("option", { value: "all" }, "Todos los grupos"),
                grupos.map(g => React.createElement("option", { key: g, value: g }, g))
            ),
            React.createElement("div", { style: { position: "relative" } },
                React.createElement("input", {
                    className: "dir-input",
                    type: "text",
                    placeholder: "🔍 Buscar operador...",
                    value: search,
                    onChange: e => setSearch(e.target.value),
                    id: "input-search-personal",
                    style: { paddingLeft: 36 }
                })
            ),
            React.createElement("span", { style: { fontSize: 12, color: D.gray, marginLeft: "auto" } }, `${operadores.length} operador(es)`)
        ),

        // KPIs globales
        React.createElement("div", { className: "kpi-grid", style: { gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginBottom: 24 } },
            React.createElement(KPICard, { label: "Operadores Activos", value: totales.count,                                  icon: "👤", accent: D.purple }),
            React.createElement(KPICard, { label: "Llamadas Atendidas", value: totales.totalC.toLocaleString("es-AR"),         icon: "📞", accent: D.blue   }),
            React.createElement(KPICard, { label: "Total Abandonadas",  value: totales.totalAb.toLocaleString("es-AR"),        icon: "📉", accent: D.red    }),
            React.createElement(KPICard, { label: "% Atención General", value: `${pct(totales.totalC, totales.totalO)}%`,      icon: "🎯", accent: D.green  })
        ),

        // Chart por grupo
        grupos.length > 0 && React.createElement("div", { className: "dir-card", style: { marginBottom: 24 } },
            React.createElement(SectionTitle, { icon: "👥" }, "Desempeño por Grupo / Célula"),
            React.createElement("div", { style: { height: 240 } },
                React.createElement(ChartBar, { id: "dir-bar-grupos", data: chartGrupos })
            )
        ),

        // Tabla ranking operadores
        React.createElement("div", { className: "dir-card", style: { padding: 0, overflow: "hidden" } },
            React.createElement("div", { style: { padding: "16px 20px", borderBottom: `1px solid ${D.border}`, fontWeight: 800, fontSize: 13, color: D.textMid } },
                "🏆 Ranking de Operadores"
            ),
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { className: "dir-table" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            ["#","Operador","Grupo","Turno","Atendidas","Abandonadas","Productividad","TMO"].map(h =>
                                React.createElement("th", { key: h }, h)
                            )
                        )
                    ),
                    React.createElement("tbody", null,
                        operadores.map((op, i) =>
                            React.createElement("tr", { key: op.normName },
                                React.createElement("td", { style: { fontWeight: 700, color: i < 3 ? D.gold : D.gray } }, i < 3 ? ["🥇","🥈","🥉"][i] : i+1),
                                React.createElement("td", { style: { fontWeight: 700, color: D.text } }, op.name || op.normName),
                                React.createElement("td", null,
                                    op.grupo !== "—"
                                        ? React.createElement(Badge, { label: op.grupo, color: D.blue, bg: "rgba(59,130,246,0.12)" })
                                        : React.createElement("span", { style: { color: D.gray, fontSize: 12 } }, "—")
                                ),
                                React.createElement("td", null, React.createElement(Badge, { label: op.turno, color: D.gray, bg: "rgba(255,255,255,0.06)" })),
                                React.createElement("td", { style: { fontWeight: 700, color: D.blue } }, op.c.toLocaleString("es-AR")),
                                React.createElement("td", { style: { color: op.ab > 10 ? D.red : D.textMid } }, op.ab),
                                React.createElement("td", { style: { fontWeight: 800, color: parseFloat(op.prod) > 15 ? D.green : parseFloat(op.prod) > 8 ? D.orange : D.textMid } }, `${op.prod}/h`),
                                React.createElement("td", null, fmtSeconds(op.avgManejo))
                            )
                        )
                    )
                )
            )
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
function AppDir() {
    const [user,          setUser]          = useState(undefined);  // undefined = cargando
    const [sessionToken,  setSessionToken]  = useState(() => sessionStorage.getItem("dir_token") || null);
    const [mode,          setMode]          = useState("turno");    // turno | personal (mensual en botón separado)

    // Data
    const [informes,     setInformes]     = useState([]);
    const [mensual,      setMensual]      = useState([]);
    const [performance,  setPerformance]  = useState([]);
    const [staff,        setStaff]        = useState([]);
    const [dataLoading,  setDataLoading]  = useState(false);

    // ── Auth listener ─────────────────────────────────────────────────────────
    useEffect(() => {
        let unsub  = null;
        let intId  = null;
        let tmId   = null;

        const subscribe = async (auth) => {
            const { onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
            unsub = onAuthStateChanged(auth, async u => {
                setUser(u || null);
            });
        };

        const auth = getAuth();
        if (auth) {
            subscribe(auth);
        } else {
            intId = setInterval(() => {
                const a = getAuth();
                if (a) { clearInterval(intId); subscribe(a); }
            }, 250);
            tmId = setTimeout(() => { if (!getAuth()) { clearInterval(intId); setUser(null); } }, 3500);
        }

        return () => {
            if (intId) clearInterval(intId);
            if (tmId)  clearTimeout(tmId);
            if (typeof unsub === "function") unsub();
        };
    }, []);

    // ── Cargar datos cuando el usuario está autenticado ───────────────────────
    useEffect(() => {
        if (!user) return;
        setDataLoading(true);
        Promise.all([loadInformes(), loadMensual(), loadPerformance(), loadStaff()])
            .then(([inf, men, perf, st]) => {
                setInformes(inf);
                setMensual(men);
                setPerformance(perf);
                setStaff(st);
            })
            .catch(e => console.error("Error cargando datos:", e))
            .finally(() => setDataLoading(false));
    }, [user]);

    // ── Login handler ─────────────────────────────────────────────────────────
    const handleLogin = useCallback(async (u) => {
        const token = await registerSession(u);
        sessionStorage.setItem("dir_token", token || "");
        setSessionToken(token);
        setUser(u);
    }, []);

    // ── Logout handler ────────────────────────────────────────────────────────
    const handleLogout = useCallback(async () => {
        const tok = sessionToken || sessionStorage.getItem("dir_token");
        await closeSession(tok);
        sessionStorage.removeItem("dir_token");
        setSessionToken(null);
        await signOutDir();
        setUser(null);
    }, [sessionToken]);

    // ── Pantalla de carga inicial ─────────────────────────────────────────────
    if (user === undefined) {
        return React.createElement("div", {
            style: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: D.bg }
        },
            React.createElement("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 16 } },
                React.createElement(Spinner),
                React.createElement("div", { style: { fontSize: 13, color: D.gray } }, "Conectando con Firebase…")
            )
        );
    }

    // ── Sin sesión → Login ────────────────────────────────────────────────────
    if (!user) {
        return React.createElement(LoginView, { onLogin: handleLogin });
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────
    const modeConfig = [
        { id: "turno",    label: "📋 Reporte por Turno" },
        { id: "personal", label: "👥 Personal" },
    ];

    return React.createElement("div", { style: { minHeight: "100vh", background: D.bg } },

        // ── HEADER ─────────────────────────────────────────────────────────
        React.createElement(Header, { user, sessionToken, onLogout: handleLogout }),

        // ── CONTENT ────────────────────────────────────────────────────────
        React.createElement("div", { className: "dir-content" },

            // Selectores de modo
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 16 } },
                React.createElement("div", { className: "mode-tabs", id: "mode-tabs" },
                    modeConfig.map(m =>
                        React.createElement("button", {
                            key: m.id,
                            className: `mode-tab ${mode === m.id ? "active" : ""}`,
                            onClick: () => setMode(m.id),
                            id: `tab-mode-${m.id}`
                        }, m.label)
                    )
                ),

                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" } },
                    React.createElement("button", {
                        onClick: () => setMode("mensual"),
                        style: { background: mode === "mensual" ? D.goldBg : "transparent", border: `1px solid ${mode === "mensual" ? D.gold : D.border}`, color: mode === "mensual" ? D.gold : D.textMid, borderRadius: 8, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: 6, transition: "all .2s" }
                    }, React.createElement("span", null, "📊"), "Resumen Mensual"),
                    
                    dataLoading && React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, color: D.gray, fontSize: 12 } },
                        React.createElement(Spinner),
                        React.createElement("span", null, "Cargando…")
                    )
                )
            ),

            // Vista según modo
            mode === "mensual"  && React.createElement(ViewMensualDir,  { mensual }),
            mode === "turno"    && React.createElement(ViewTurnoDir,    { informes }),
            mode === "personal" && React.createElement(ViewPersonalDir, { performance, staff }),

            // Alertas criticas movidas al inferior
            !dataLoading && React.createElement("div", { style: { marginTop: 40 } },
                React.createElement(AlertasPanel, { informes, mensual, performance })
            ),

            // Footer
            React.createElement("div", { style: { marginTop: 48, paddingTop: 24, borderTop: `1px solid ${D.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                React.createElement("div", { style: { fontSize: 11, color: D.gray } },
                    `SAE 911 — Portal Alta Dirección · Solo Lectura · ${new Date().getFullYear()}`
                ),
                React.createElement("div", { style: { fontSize: 11, color: D.gray, display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", null, "Sesión:"),
                    React.createElement("span", { className: "token-chip" }, sessionToken ? sessionToken.substring(0, 18) + "…" : "—")
                )
            )
        )
    );
}

// ══════════════════════════════════════════════════════════════════════════════
//  MOUNT
// ══════════════════════════════════════════════════════════════════════════════
const container = document.getElementById("root-dir");
const root      = ReactDOM.createRoot(container);
root.render(React.createElement(AppDir));
