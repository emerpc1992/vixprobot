// ============================================================
// server.js  -- VIXPRO-BOT
// Servidor OAuth2 + PKCE para la API NUEVA de Deriv
// (developers.deriv.com / api.derivws.com)
// Desplegado en Render (servicio Web gratuito, Node persistente)
// ============================================================
//
// IMPORTANTE - version corregida conforme a la documentacion
// oficial de Deriv (developers.deriv.com/docs/intro/oauth/):
//
//   - Las apps OAuth2 de Deriv son CLIENTES PUBLICOS. NO usan
//     client_secret en ningun momento del flujo. La seguridad la
//     da PKCE (code_verifier / code_challenge), no un secreto
//     compartido. Por eso este archivo NO tiene ni necesita
//     DERIV_CLIENT_SECRET.
//   - El endpoint de autorizacion y el de intercambio de token
//     estan en el MISMO dominio: auth.deriv.com (no oauth.deriv.com).
//   - El access_token es de corta duracion (expires_in ~3600s) y
//     viene con un refresh_token para renovarlo sin pedir login de
//     nuevo. Este servidor expone /api/refresh para eso.
//   - Las llamadas REST a la API de trading requieren DOS headers:
//     "Deriv-App-ID: <client_id>" y "Authorization: Bearer <token>".
//     (Eso lo hace el bot Python directamente, este servidor solo
//     entrega el token).
//
// Endpoints:
//   GET  /                  -> pagina simple "VIXPRO-BOT"
//   GET  /health            -> chequeo de vida + redirect_uri calculada
//   GET  /auth/start.json   -> genera PKCE + state, devuelve auth_url
//   GET  /callback          -> Deriv redirige aca tras login/consentimiento
//   GET  /api/token         -> el bot Python hace polling aca
//   POST /api/refresh       -> renueva un access_token vencido
//
// Variables de entorno a configurar en Render (Dashboard -> tu
// servicio -> Environment):
//   DERIV_CLIENT_ID   = 33AAhTttdb54bShIXnfqZ   (tu app_id real, publico)
//   PUBLIC_BASE_URL   = https://TU-SERVICIO.onrender.com
//                       (la URL real que asigna Render tras el
//                       primer deploy)
//
// YA NO HACE FALTA DERIV_CLIENT_SECRET. Si la tenes configurada en
// Render, podes borrarla o dejarla, no se usa en absoluto.
//
// Redirect URI a registrar en tu app de Deriv (Dashboard -> Applications):
//   https://TU-SERVICIO.onrender.com/callback
//
// ============================================================

import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID || 'TU_CLIENT_ID_AQUI';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://CAMBIAR-ESTO.onrender.com').replace(/\/+$/, '');
const REDIRECT_URI = `${PUBLIC_BASE_URL}/callback`;
const DERIV_SCOPE = 'trade account_manage'; // espacio normal, NO '+'

// Ambos endpoints viven en el mismo dominio: auth.deriv.com
const AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';

// Almacenamiento temporal en memoria: state -> sesion.
// Se reinicia si Render reinicia el proceso (free tier duerme tras
// ~15 min sin trafico). No es grave: simplemente reintentas el login.
const sessions = new Map();

function log(...args) {
  console.log(new Date().toISOString(), '|', ...args);
}

if (DERIV_CLIENT_ID === 'TU_CLIENT_ID_AQUI') {
  log('ADVERTENCIA: DERIV_CLIENT_ID no esta configurado.');
}
if (PUBLIC_BASE_URL.includes('CAMBIAR-ESTO')) {
  log('ADVERTENCIA: PUBLIC_BASE_URL no esta configurado con tu URL real de Render.');
}

// Limpieza de sesiones viejas (>10 min)
setInterval(() => {
  const now = Date.now();
  for (const [state, session] of sessions.entries()) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      sessions.delete(state);
      log('Sesion expirada eliminada:', state);
    }
  }
}, 60 * 1000);

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier() {
  return base64url(crypto.randomBytes(48));
}

function generateCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64url(hash);
}

app.use(express.json());

// ==============================================================
//  MODULO DE LICENCIAS -- DAKO-BOT
// ==============================================================
// Sistema simple de activacion por correo, controlado desde el
// Panel de Control (dako_admin_panel.py). Guarda todo en un JSON
// en disco. En el plan free de Render el disco es efimero (se
// pierde en cada redeploy), pero sobrevive mientras el servicio
// esta arriba -- igual que el Map de "sessions" de OAuth de mas
// arriba. Si mas adelante queres persistencia real, este es el
// unico lugar que habria que cambiar por una base de datos.
//
// Reglas de negocio:
//  - Un correo nuevo se registra ACTIVO, con N dias de vigencia desde
//    el momento del registro, donde N es "trial_days" (por defecto 7,
//    ver LICENSE_DAYS_DEFAULT mas abajo) -- editable en caliente desde
//    el Panel de Control ("🎓 Días de prueba" + GUARDAR), sin reiniciar
//    el servidor.
//  - Cada vez que el admin ACTIVA manualmente una cuenta, se le
//    recargan otros N dias completos desde ese momento (mismo N).
//  - Si el admin DESACTIVA manualmente, la cuenta queda inactiva
//    sin importar cuantos dias le quedaban.
//  - Si se cumplen los N dias sin intervencion del admin, la
//    cuenta pasa a inactiva sola (chequeo perezoso: se evalua
//    cada vez que se lee el estado).
// ==============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LICENSES_FILE = path.join(__dirname, 'data', 'licenses.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dako-admin-2024';
// Valor de arranque si el archivo de datos todavia no tiene un ajuste
// guardado (primera vez que corre el servidor, o archivo viejo). A
// partir de ahi, el numero real que se usa es el que esta guardado en
// data.settings.trial_days, editable desde el Panel de Control
// (boton "🎓 Días de prueba" + GUARDAR) via /api/admin/settings.
const LICENSE_DAYS_DEFAULT = 7;

function loadLicenses() {
  try {
    if (!fs.existsSync(LICENSES_FILE)) {
      return { accounts: {}, messages: [], next_msg_id: 1, resets: {}, settings: { trial_days: LICENSE_DAYS_DEFAULT } };
    }
    const raw = fs.readFileSync(LICENSES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.accounts) data.accounts = {};
    if (!data.messages) data.messages = [];
    if (!data.next_msg_id) data.next_msg_id = 1;
    if (!data.resets) data.resets = {};
    if (!data.settings) data.settings = {};
    if (!data.settings.trial_days) data.settings.trial_days = LICENSE_DAYS_DEFAULT;
    return data;
  } catch (e) {
    log('Error leyendo licenses.json:', e.message);
    return { accounts: {}, messages: [], next_msg_id: 1, resets: {}, settings: { trial_days: LICENSE_DAYS_DEFAULT } };
  }
}

// Numero de dias de prueba que se le asigna a una cuenta NUEVA al
// registrarse, y el que se recarga cada vez que el admin ACTIVA
// manualmente una cuenta. Editable en caliente desde el panel, sin
// reiniciar el servidor ni tocar codigo.
function getTrialDays(data) {
  const n = Number(data && data.settings && data.settings.trial_days);
  return (Number.isFinite(n) && n > 0) ? n : LICENSE_DAYS_DEFAULT;
}

function saveLicenses(data) {
  try {
    fs.mkdirSync(path.dirname(LICENSES_FILE), { recursive: true });
    fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log('Error guardando licenses.json:', e.message);
  }
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Aplica la regla de expiracion automatica de 30 dias a una cuenta
// y devuelve si quedo activa. Muta el objeto "acc" si corresponde.
function applyExpiry(acc) {
  if (acc.active && acc.expires_at) {
    if (Date.now() > new Date(acc.expires_at).getTime()) {
      acc.active = false;
      acc.deactivated_reason = 'auto_expired';
    }
  }
  return acc.active;
}

function accountView(email, acc) {
  const now = Date.now();
  const expiresMs = acc.expires_at ? new Date(acc.expires_at).getTime() : null;
  const daysLeft = (acc.active && expiresMs) ? Math.max(0, Math.ceil((expiresMs - now) / 86400000)) : 0;
  return {
    email,
    active: acc.active,
    registered_at: acc.registered_at,
    activated_at: acc.activated_at,
    expires_at: acc.expires_at,
    days_left: daysLeft,
    deactivated_reason: acc.deactivated_reason || null,
  };
}

function requireAdmin(req, res, next) {
  const key = req.get('X-Admin-Key') || req.query.admin_key;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'admin_key invalido' });
  }
  next();
}

// ------------------------------------------------------------
// Registro / login del bot con un correo. Idempotente: si el
// correo ya existe simplemente devuelve su estado actual (no
// reinicia los 30 dias).
// ------------------------------------------------------------
app.post('/api/license/register', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'correo invalido' });
  }
  const data = loadLicenses();
  if (!data.accounts[email]) {
    const now = new Date();
    const trialDays = getTrialDays(data);
    const expires = new Date(now.getTime() + trialDays * 86400000);
    data.accounts[email] = {
      registered_at: now.toISOString(),
      activated_at: now.toISOString(),
      expires_at: expires.toISOString(),
      active: true,
      deactivated_reason: null,
    };
    saveLicenses(data);
    log('Nuevo registro de licencia:', email, `(${trialDays} dias de prueba)`);
  }
  const acc = data.accounts[email];
  applyExpiry(acc);
  saveLicenses(data);
  res.json(accountView(email, acc));
});

// ------------------------------------------------------------
// El bot consulta periodicamente su propio estado con esto.
// ------------------------------------------------------------
app.get('/api/license/status', (req, res) => {
  const email = normEmail(req.query.email);
  const data = loadLicenses();

  // Si el admin pidio reiniciar esta cuenta desde el panel, avisamos
  // al bot con "reset: true" en lugar del estado normal. El bot,
  // al verlo, borra su correo guardado localmente y vuelve a pedirlo
  // como si fuera la primera vez. Se consume una sola vez (se borra
  // la marca apenas se entrega), asi el bot no queda reiniciandose
  // en cada poll.
  if (data.resets && data.resets[email]) {
    delete data.resets[email];
    saveLicenses(data);
    log('Reset entregado al bot:', email);
    return res.json({ email, reset: true, active: false });
  }

  const acc = data.accounts[email];
  if (!acc) return res.status(404).json({ error: 'correo no registrado', active: false });
  const wasActive = acc.active;
  applyExpiry(acc);
  if (wasActive !== acc.active) saveLicenses(data);
  res.json(accountView(email, acc));
});

// ------------------------------------------------------------
// El bot hace polling de mensajes nuevos dirigidos a su correo
// o de difusion general ("*"), pasando el ultimo id que ya vio.
// ------------------------------------------------------------
app.get('/api/license/messages', (req, res) => {
  const email = normEmail(req.query.email);
  const sinceId = parseInt(req.query.since_id || '0', 10) || 0;
  const data = loadLicenses();
  const msgs = data.messages.filter(
    (m) => m.id > sinceId && (m.to === '*' || m.to === email)
  );
  res.json({ messages: msgs });
});

// ------------------------------------------------------------
// Endpoints de administracion (protegidos con X-Admin-Key).
// Los usa dako_admin_panel.py.
// ------------------------------------------------------------
app.get('/api/admin/accounts', requireAdmin, (req, res) => {
  const data = loadLicenses();
  let changed = false;
  const list = Object.entries(data.accounts).map(([email, acc]) => {
    const before = acc.active;
    applyExpiry(acc);
    if (before !== acc.active) changed = true;
    return accountView(email, acc);
  });
  if (changed) saveLicenses(data);
  list.sort((a, b) => (a.registered_at < b.registered_at ? 1 : -1));
  res.json({ accounts: list });
});

// ------------------------------------------------------------
// Ajustes generales (por ahora solo los dias de prueba por
// defecto). Lo usa el boton "🎓 Días de prueba" + GUARDAR del panel
// de control. Afecta a las cuentas que se registren/activen de aca
// en adelante -- no toca la fecha de vencimiento de cuentas ya
// existentes.
// ------------------------------------------------------------
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const data = loadLicenses();
  res.json({ trial_days: getTrialDays(data) });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const raw = req.body && req.body.trial_days;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    return res.status(400).json({ error: 'trial_days invalido (debe ser un numero entre 1 y 3650)' });
  }
  const data = loadLicenses();
  if (!data.settings) data.settings = {};
  data.settings.trial_days = Math.round(days);
  saveLicenses(data);
  log('Dias de prueba actualizados desde el panel:', data.settings.trial_days);
  res.json({ ok: true, trial_days: data.settings.trial_days });
});

app.post('/api/admin/accounts/:email/activate', requireAdmin, (req, res) => {
  const email = normEmail(req.params.email);
  const data = loadLicenses();
  const now = new Date();
  const trialDays = getTrialDays(data);
  const expires = new Date(now.getTime() + trialDays * 86400000);
  if (!data.accounts[email]) {
    data.accounts[email] = { registered_at: now.toISOString() };
  }
  Object.assign(data.accounts[email], {
    active: true,
    activated_at: now.toISOString(),
    expires_at: expires.toISOString(),
    deactivated_reason: null,
  });
  saveLicenses(data);
  log('Cuenta activada manualmente:', email, `(+${trialDays} dias)`);
  res.json(accountView(email, data.accounts[email]));
});

app.post('/api/admin/accounts/:email/deactivate', requireAdmin, (req, res) => {
  const email = normEmail(req.params.email);
  const data = loadLicenses();
  if (!data.accounts[email]) return res.status(404).json({ error: 'correo no registrado' });
  data.accounts[email].active = false;
  data.accounts[email].deactivated_reason = 'manual';
  saveLicenses(data);
  log('Cuenta desactivada manualmente:', email);
  res.json(accountView(email, data.accounts[email]));
});

// ------------------------------------------------------------
// Editar manualmente la fecha de vencimiento/bloqueo de una
// cuenta (boton "FECHA" del panel de control). Esta ruta faltaba
// por completo -- por eso el boton nunca funcionaba (404).
// ------------------------------------------------------------
app.post('/api/admin/accounts/:email/expiry', requireAdmin, (req, res) => {
  const email = normEmail(req.params.email);
  const expiresAt = req.body && req.body.expires_at;
  if (!expiresAt) {
    return res.status(400).json({ error: 'falta expires_at en el body' });
  }
  const parsed = new Date(expiresAt);
  if (isNaN(parsed.getTime())) {
    return res.status(400).json({ error: 'expires_at invalido' });
  }
  const data = loadLicenses();
  const now = new Date();
  if (!data.accounts[email]) {
    data.accounts[email] = { registered_at: now.toISOString(), activated_at: now.toISOString() };
  }
  const acc = data.accounts[email];
  acc.expires_at = parsed.toISOString();
  // Si la nueva fecha esta en el futuro, la cuenta queda activa
  // (permite reactivar extendiendo la fecha directamente, sin
  // tener que pasar tambien por el boton ACTIVAR). Si la fecha
  // queda en el pasado, se bloquea de una vez.
  if (parsed.getTime() > now.getTime()) {
    acc.active = true;
    acc.deactivated_reason = null;
  } else {
    acc.active = false;
    acc.deactivated_reason = 'manual';
  }
  saveLicenses(data);
  log('Fecha de vencimiento editada manualmente:', email, '->', acc.expires_at);
  res.json(accountView(email, acc));
});

app.delete('/api/admin/accounts/:email', requireAdmin, (req, res) => {
  const email = normEmail(req.params.email);
  const data = loadLicenses();
  delete data.accounts[email];
  saveLicenses(data);
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Reiniciar una cuenta desde el panel: borra el registro del
// servidor (vuelve a quedar "en 0", sin dias consumidos) y deja
// marcada la cuenta para que, la proxima vez que el bot de esa
// persona consulte su estado, se le pida el correo de nuevo (ver
// GET /api/license/status). No requiere que el bot este conectado
// en este momento: la marca queda guardada hasta que el bot haga
// su proximo chequeo periodico.
// ------------------------------------------------------------
app.post('/api/admin/accounts/:email/reset', requireAdmin, (req, res) => {
  const email = normEmail(req.params.email);
  const data = loadLicenses();
  delete data.accounts[email];
  data.resets[email] = true;
  saveLicenses(data);
  log('Reset solicitado desde el panel para:', email);
  res.json({ ok: true, email });
});

// ------------------------------------------------------------
// El admin envia un mensaje que aparecera en la ventana del bot.
// to = "*" para difundir a todos, o un correo especifico.
// ------------------------------------------------------------
app.post('/api/admin/message', requireAdmin, (req, res) => {
  const to = normEmail(req.body && req.body.to) || '*';
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacio' });
  const data = loadLicenses();
  const msg = {
    id: data.next_msg_id++,
    to,
    text,
    created_at: new Date().toISOString(),
  };
  data.messages.push(msg);
  // Nos quedamos solo con los ultimos 300 mensajes para no crecer sin limite.
  if (data.messages.length > 300) data.messages = data.messages.slice(-300);
  saveLicenses(data);
  res.json({ ok: true, message: msg });
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const data = loadLicenses();
  res.json({ messages: data.messages.slice(-200) });
});

// ------------------------------------------------------------
// Pagina raiz
// ------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>VIXPRO-BOT</title></head>
<body style="background:#0d1117;color:#00e0ff;font-family:monospace;
             display:flex;align-items:center;justify-content:center;
             height:100vh;margin:0;font-size:2rem;letter-spacing:2px;">
  VIXPRO-BOT
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    redirect_uri: REDIRECT_URI,
    auth_url: AUTH_URL,
    token_url: TOKEN_URL,
    client_id_configurado: DERIV_CLIENT_ID !== 'TU_CLIENT_ID_AQUI',
    public_base_url_configurado: !PUBLIC_BASE_URL.includes('CAMBIAR-ESTO'),
    sessions_activas: sessions.size,
  });
});

// ------------------------------------------------------------
// El bot Python pide esto para obtener la URL de autorizacion
// ------------------------------------------------------------
app.get('/auth/start.json', (req, res) => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  sessions.set(state, {
    codeVerifier,
    status: 'pending',
    token: null,
    error: null,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: DERIV_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: DERIV_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${AUTH_URL}?${params.toString()}`;
  log('Nuevo flujo iniciado. state=', state);

  res.json({ state, auth_url: authUrl });
});

// ------------------------------------------------------------
// Deriv redirige aca despues del login/consentimiento
// ------------------------------------------------------------
app.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  log('Callback recibido. query=', JSON.stringify(req.query));

  if (error) {
    if (state && sessions.has(state)) {
      sessions.get(state).status = 'error';
      sessions.get(state).error = `${error}: ${error_description || ''}`;
    }
    log('Deriv devolvio error:', error, error_description);
    return res.send(htmlPage('Error de autorizacion', `Deriv devolvio: ${error} ${error_description || ''}`));
  }

  if (!state || !sessions.has(state)) {
    log('State invalido o no encontrado:', state);
    return res.status(400).send(htmlPage('Error', 'State invalido o expirado. Volve a intentar desde el bot.'));
  }

  const session = sessions.get(state);

  if (!code) {
    session.status = 'error';
    session.error = 'no_code';
    log('No llego code en el callback para state=', state);
    return res.send(htmlPage('Error', 'No se recibio el codigo de autorizacion.'));
  }

  try {
    const tokenData = await exchangeCodeForToken(code, session.codeVerifier);

    session.status = 'done';
    session.token = tokenData;

    return res.send(htmlPage('Listo', 'Autorizacion completada. Ya podes cerrar esta ventana y volver al bot.'));
  } catch (err) {
    session.status = 'error';
    session.error = String(err.message || err);
    log('Excepcion en intercambio de token:', err);
    return res.send(htmlPage('Error', 'Fallo el intercambio de token con Deriv. Revisa los logs del servidor.'));
  }
});

// ------------------------------------------------------------
// Helper: intercambia code -> token.
// Cliente PUBLICO: solo client_id + code_verifier, SIN client_secret.
// Endpoint correcto: https://auth.deriv.com/oauth2/token
// ------------------------------------------------------------
async function exchangeCodeForToken(code, codeVerifier) {
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: DERIV_CLIENT_ID,
      code: String(code),
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokenData = await tokenResp.json();
  log('Respuesta de oauth2/token. status=', tokenResp.status);

  if (!tokenResp.ok) {
    throw new Error(JSON.stringify(tokenData));
  }

  return tokenData;
}

// ------------------------------------------------------------
// El bot Python hace polling aca hasta que status sea 'done'
// ------------------------------------------------------------
app.get('/api/token', (req, res) => {
  const { state } = req.query;

  if (!state || !sessions.has(state)) {
    return res.status(404).json({ status: 'not_found' });
  }

  const session = sessions.get(state);

  if (session.status === 'done') {
    const result = { status: 'done', token: session.token };
    sessions.delete(state);
    log('Token entregado al bot para state=', state);
    return res.json(result);
  }

  if (session.status === 'error') {
    const result = { status: 'error', error: session.error };
    sessions.delete(state);
    log('Error entregado al bot para state=', state, result.error);
    return res.json(result);
  }

  return res.json({ status: 'pending' });
});

// ------------------------------------------------------------
// Renovar token usando el refresh_token (la API nueva da tokens
// de corta duracion, esto evita pedirle login de nuevo al usuario).
// Tampoco lleva client_secret: cliente publico.
// ------------------------------------------------------------
app.post('/api/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ status: 'error', error: 'falta refresh_token en el body' });
  }

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: DERIV_CLIENT_ID,
        refresh_token,
      }),
    });

    const tokenData = await tokenResp.json();
    log('Refresh de token. status=', tokenResp.status);

    if (!tokenResp.ok) {
      return res.status(tokenResp.status).json({ status: 'error', error: tokenData });
    }

    return res.json({ status: 'done', token: tokenData });
  } catch (err) {
    log('Excepcion en refresh:', err);
    return res.status(500).json({ status: 'error', error: String(err) });
  }
});

function htmlPage(title, message) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: sans-serif; text-align: center; margin-top: 80px; background:#0d1117; color:#c9d1d9;">
  <h2>${title}</h2>
  <p>${message}</p>
  <p style="color:#00e0ff;">VIXPRO-BOT</p>
</body>
</html>`;
}

app.listen(PORT, () => {
  log(`Servidor VIXPRO-BOT escuchando en puerto ${PORT}`);
  log(`Redirect URI a registrar en Deriv: ${REDIRECT_URI}`);
  log(`Token endpoint usado: ${TOKEN_URL}`);
});
