# FerFootBall — Fútbol español en tiempo real

Web estática (HTML + CSS + JavaScript sin dependencias) lista para GitHub Pages.

## Estructura
```
index.html        Página principal, modales (login, registro, perfil, partido, cookies, textos legales)
css/styles.css    Estilos, tema oscuro/claro y diseño responsive
js/utils.js       Utilidades: almacenamiento, fechas, traducciones, toasts
js/cookies.js     Banner y configuración de cookies (RGPD/LSSI), con categorías
js/auth.js        Registro, inicio de sesión, recuperar contraseña, perfil y favoritos
js/api.js         Cliente de datos en tiempo real (API pública de ESPN)
js/render.js      Plantillas HTML de cada sección
js/app.js         Controlador: carga de datos, auto-actualización, detección de goles
```

## Datos en tiempo real
- Marcadores en directo con minuto de juego (LaLiga, Hypermotion, Copa del Rey, Champions, Europa League, Liga F).
- Estadísticas de cada partido: posesión, tiros, córners, pases, tarjetas, etc.
- Incidencias (goles, asistencias, tarjetas, cambios), alineaciones y narración minuto a minuto.
- Clasificación oficial ordenable, máximos goleadores y asistentes, noticias y fichajes.
- Se actualiza cada 30 s cuando hay partidos en juego (2 min si no los hay) y avisa de cada gol.

## Cuentas de usuario
Las cuentas se guardan en el navegador (localStorage) con contraseña cifrada PBKDF2-SHA256.
Para que las cuentas funcionen entre dispositivos, conecta `js/auth.js` (objeto `repo`) a
Firebase Authentication o Supabase.

## Publicar en GitHub Pages
Sube todos los archivos a la raíz del repositorio y activa Pages en Settings → Pages.

## Registro de cookies con IP (documento Word)
Cada vez que un visitante acepta, rechaza o configura las cookies, la web envía su elección a
`server/consent_server.py`, que guarda fecha, IP, elección, navegador e ID en
`server/data/consentimientos.docx` (y una copia en `consentimientos.jsonl`).

- Página de administración: `admin.html` → escribe la clave y pulsa «Descargar Word».
- La clave está en `server/data/admin_key.txt` (o define la variable `FF_ADMIN_KEY`).
- GitHub Pages no ejecuta servidores: publica la carpeta `server/` en Render, Railway o un VPS
  (`pip install -r requirements.txt && python consent_server.py`) y pon su URL en
  `window.FF_CONFIG.consentApi` dentro de `index.html` y `admin.html`.
- Para limitar quién puede enviar datos, define `FF_ALLOWED_ORIGINS=https://tu-usuario.github.io`.
