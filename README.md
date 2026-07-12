# VIXPRO-BOT - Servidor OAuth para Deriv

Servidor Node/Express que maneja el login OAuth2+PKCE con la nueva
API de Deriv, para que el bot Python (tkinter) pueda obtener un
access_token.

**Esta version usa la app de Deriv como CLIENTE PUBLICO**: no hay
client_secret en ningun lado del flujo. La seguridad la da PKCE
(code_verifier / code_challenge). Esto coincide con lo que muestra
el dashboard de Deriv: tu app OAuth2 solo tiene `app_id` y
`Redirect URLs`, sin ningun campo de secreto.

## Paso 1: Subir este codigo a GitHub

Si nunca subiste un repo, segui estos comandos EXACTOS desde una
terminal, parado dentro de esta carpeta:

```bash
git init
git add .
git commit -m "Servidor OAuth VIXPRO-BOT (cliente publico, sin client_secret)"
```

Despues:

1. Entra a https://github.com y logueate.
2. Click en el "+" arriba a la derecha -> "New repository".
3. Nombre sugerido: `vixpro-bot-oauth`. Dejalo **privado**. NO marques
   "Add a README" (ya tenes uno). Click "Create repository".
4. GitHub te va a mostrar comandos como estos (usa los que GitHub te
   muestre a TI, con tu usuario real):

```bash
git remote add origin https://github.com/TU_USUARIO/vixpro-bot-oauth.git
git branch -M main
git push -u origin main
```

5. Te puede pedir loguearte: usa tu usuario de GitHub y, como
   contraseña, un "Personal Access Token" (GitHub ya no acepta la
   contraseña normal por git). Si no tenes uno, GitHub te da la
   opcion de crearlo ahi mismo o via Settings -> Developer settings
   -> Personal access tokens.

## Paso 2: Crear el servicio en Render

1. Entra a https://render.com y logueate (podes usar tu cuenta de
   GitHub para entrar, es mas rapido).
2. Click "New +" -> "Web Service".
3. Conecta tu cuenta de GitHub si no lo hiciste, y seleccioná el
   repo `vixpro-bot-oauth`.
4. Si Render detecta `render.yaml`, te va a pre-completar todo. Si
   no, configuralo a mano:
   - **Name**: vixpro-bot-oauth
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Antes de crear el servicio, en la seccion "Environment Variables"
   agrega:
   - `DERIV_CLIENT_ID` = tu app_id real (ej: 33AAhTttdb54bShIXnfqZ)
   - `PUBLIC_BASE_URL` = (dejalo en blanco por ahora, lo completamos
     en el paso siguiente)

   **YA NO hace falta `DERIV_CLIENT_SECRET`.** Si la tenes de un
   intento anterior, podes borrarla, no se usa.
6. Click "Create Web Service". Esperá el deploy (unos minutos).

## Paso 3: Completar PUBLIC_BASE_URL

1. Cuando termine el deploy, Render te muestra la URL real arriba del
   dashboard, algo como `https://vixprooo.onrender.com`.
2. Copiala. Ve a la pestaña "Environment" de tu servicio en Render.
3. Editá `PUBLIC_BASE_URL` y pegá esa URL completa, SIN barra al
   final (ej: `https://vixprooo.onrender.com`).
4. Guardá. Render va a redeployar automaticamente con la variable
   nueva.

## Paso 4: Verificar que funciona

Abrí en el navegador: `https://TU-URL-REAL.onrender.com/health`

Deberias ver un JSON como:

```json
{
  "status": "ok",
  "redirect_uri": "https://TU-URL-REAL.onrender.com/callback",
  "auth_url": "https://auth.deriv.com/oauth2/auth",
  "token_url": "https://auth.deriv.com/oauth2/token",
  "client_id_configurado": true,
  "public_base_url_configurado": true,
  "sessions_activas": 0
}
```

Si algun campo `_configurado` sale `false`, revisa esa variable de
entorno en Render.

## Paso 5: Registrar la Redirect URL en Deriv

1. Entra a https://developers.deriv.com -> Dashboard -> Registered apps.
2. Edita tu app (la del app_id que usaste arriba).
3. En "Redirect URLs" poné exactamente: `https://TU-URL-REAL.onrender.com/callback`
4. Guardá.

## Paso 6: Conectar el bot Python

En `vixpro_auth.py`, cambia la linea:

```python
SERVER_URL = "https://CAMBIAR-ESTO.onrender.com"
```

por tu URL real de Render (sin barra final). Listo, el bot ya puede
hacer login.

## Modulo de licencias (Panel de Control DAKO-BOT)

Este servidor ahora tambien controla la activacion de cada bot por
correo (lo usa `dako_admin_panel.py`, el Panel de Control, y
`dako_license_client.py`, integrado en el bot).

1. En Render, en "Environment", agrega una variable mas:
   - `ADMIN_KEY` = una clave secreta que vos elijas (ej: un password
     largo). Esta es la que vas a poner en `dako_admin_panel.py` para
     poder administrar las cuentas. Si no la configuras, se usa el
     valor por defecto `dako-admin-2024` (cambialo en produccion).
2. Los datos de licencias se guardan en `data/licenses.json` dentro
   del propio servicio. Igual que las sesiones OAuth, esto vive
   mientras el servicio esta arriba; si Render redeploya el servicio
   se reinicia. Para produccion seria mejor una base de datos, pero
   para controlar un puñado de cuentas esto alcanza.
3. Endpoints nuevos:
   - `POST /api/license/register` `{email}` -- el bot se registra la
     primera vez que corre.
   - `GET /api/license/status?email=...` -- el bot pregunta si sigue
     activo.
   - `GET /api/license/messages?email=...&since_id=N` -- el bot
     revisa si el admin le mando un mensaje nuevo.
   - `GET /api/admin/accounts` (requiere header `X-Admin-Key`) -- lista
     todas las cuentas para el Panel de Control.
   - `POST /api/admin/accounts/:email/activate` / `.../deactivate`
     (requiere `X-Admin-Key`).
   - `POST /api/admin/message` `{to, text}` (requiere `X-Admin-Key`) --
     `to` puede ser un correo o `"*"` para todos los bots.

## Por que no hay client_secret

La documentacion oficial de Deriv (developers.deriv.com/docs/intro/oauth/)
especifica que el intercambio de codigo por token solo requiere:

```
grant_type=authorization_code
client_id=TU_CLIENT_ID
code=CODIGO_DEL_CALLBACK
code_verifier=TU_CODE_VERIFIER_ORIGINAL
redirect_uri=https://tu-app.com/callback
```

Sin `client_secret`. El dashboard de Deriv tampoco muestra un campo
de secreto para apps OAuth2 -- solo `app_id` y `Redirect URLs`,
confirmando que es un cliente publico tipo PKCE.

## Nota sobre el plan gratuito de Render

El plan free "duerme" el servicio tras ~15 minutos sin trafico, y
demora unos segundos en despertar con la primera request despues de
eso. Para un login ocasional esto no es un problema (el usuario solo
nota un par de segundos extra la primera vez). Si esto te molesta,
existen planes pagos de Render que evitan el sleep, o alternativas
como Railway.
