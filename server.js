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
