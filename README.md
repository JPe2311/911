# SAE 911 — Sistema de Informes Automáticos

Aplicación web estática para generar informes de turno del Centro de Llamados de Emergencias (DCGyC - SAE 911) a partir de archivos CSV exportados del sistema.

## Cómo usar

1. Abrí `index.html` en el navegador (o accedé a la URL del host)
2. Arrastrá los 3 archivos CSV al área de carga (en cualquier orden):
   - **Llamadas por Agente** (`LLAMADAS_POR_AGENTE_...csv`)
   - **Abandonadas por Hora** (`ABANDONADAS_...csv`)
   - **Tiempo Inicio Despacho** (`Tiempo_Inicio_Despacho_...csv`)
3. El informe se genera automáticamente

## Vistas disponibles

| Vista | Contenido |
|-------|-----------|
| 📊 Resumen | KPIs del turno, gráficos de hora/operadores/despacho, alertas automáticas |
| 📞 Por Hora | Llamadas por intervalo, % abandono por hora, tabla completa |
| 👤 Operadores | Desempeño por agente, disponibilidad, tiempo ausente |
| 🚓 Despacho | Ranking de distritos por tiempo de respuesta y efectividad |

---

## Deploy en Netlify (gratis)

### Opción A — Drag & Drop (más fácil, sin cuenta de GitHub)
1. Creá cuenta en [netlify.com](https://netlify.com)
2. En el dashboard, arrastrá la carpeta `sae911/` al área de deploy
3. Listo — tenés una URL pública tipo `https://xxxxx.netlify.app`

### Opción B — GitHub + Netlify (recomendado para actualizaciones)
1. Subí esta carpeta a un repositorio en [github.com](https://github.com)
2. En Netlify: "Add new site" → "Import an existing project" → elegí el repo
3. Configuración de build:
   - **Build command:** (dejar vacío)
   - **Publish directory:** `.`
4. Deploy — cada `git push` actualiza el sitio automáticamente

---

## Deploy en Vercel (alternativa)

### Opción A — Vercel CLI
```bash
npm install -g vercel
cd sae911/
vercel
```
Seguí las instrucciones — te da una URL en segundos.

### Opción B — GitHub + Vercel
1. Subí la carpeta a GitHub
2. En [vercel.com](https://vercel.com): "New Project" → importá el repo
3. Framework: **Other**
4. Output directory: `.`

---

## Deploy en GitHub Pages (alternativa gratuita)

1. Creá un repositorio en GitHub (público)
2. Subí todos los archivos de esta carpeta
3. En Settings → Pages → Source: `main` branch, carpeta `/` (root)
4. URL: `https://tu-usuario.github.io/nombre-repo/`

---

## Estructura del proyecto

```
sae911/
├── index.html          # Punto de entrada
├── src/
│   └── app.jsx         # Aplicación React completa
├── netlify.toml        # Config para Netlify
├── vercel.json         # Config para Vercel
└── README.md           # Este archivo
```

## Requisitos

- Ninguno en producción: usa CDN (React, Chart.js, Babel)
- Los archivos CSV se procesan **100% en el navegador** — no se envían a ningún servidor
- Funciona offline una vez cargada la página

## Notas técnicas

- Los CSV deben estar separados por `;` (punto y coma) — formato estándar del sistema
- Compatible con encoding `UTF-8` y `Latin-1` (ISO-8859-1)
- El sistema detecta el tipo de CSV automáticamente por su contenido
