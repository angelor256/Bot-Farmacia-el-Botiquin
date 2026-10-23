# Guía paso a paso: probar el bot de Farmacia El Botiquín en tu computadora

Esta guía asume que no tienes a nadie que te ayude. Sigue los pasos en orden y marca cada casilla.
Tiempo estimado: 15–20 minutos.

---

## 0. Qué vas a tener al final

Un panel web en `http://localhost:3000` con un simulador de chat. Ahí escribes como si fueras un cliente y el bot responde usando la IA de Gemini. WhatsApp real **no** forma parte de esta prueba.

---

## 1. Instalar lo necesario (solo la primera vez)

### 1.1 Node.js (versión 18 o mayor)
- [ ] Entra a https://nodejs.org y descarga la versión **LTS**. Instálala con "Siguiente, Siguiente".
- [ ] Abre una terminal:
  - **Windows:** busca "PowerShell" en el menú Inicio.
  - **Mac:** abre la app "Terminal".
- [ ] Escribe `node -v` y presiona Enter. Debe mostrar algo como `v20.x.x` o mayor.
  - Si dice "no se reconoce el comando", cierra y vuelve a abrir la terminal. Si sigue igual, reinstala Node.

### 1.2 Git
- [ ] Escribe `git --version`.
  - Si muestra una versión, ya lo tienes.
  - Si no, instálalo desde https://git-scm.com/downloads.
  - Alternativa sin Git: entra al repo en GitHub, botón verde **Code → Download ZIP**, descomprime y salta al paso 2.2.

---

## 2. Descargar el proyecto

### 2.1 Clonar
Elige una carpeta (por ejemplo Documentos) y ejecuta:

```bash
git clone https://github.com/angelor256/Bot-Farmacia-el-Botiquin.git
cd Bot-Farmacia-el-Botiquin
```

- [ ] Si el PR #7 **ya fue fusionado**, estás listo. Si **no**, cambia a la rama con los arreglos:

```bash
git checkout claude/admiring-goldberg-rchr0o
```

### 2.2 Instalar dependencias
```bash
cd backend
npm install
```
- [ ] Debe terminar sin la palabra `ERR!`. Algún aviso `WARN` o de "vulnerabilities" no es problema.

---

## 3. Configurar la clave de Gemini

### 3.1 Crear tu archivo `.env`
Estando dentro de la carpeta `backend`:

- **Windows (PowerShell):** `copy .env.example .env`
- **Mac / Linux:** `cp .env.example .env`

### 3.2 Editarlo
- [ ] Abre `backend/.env` con el Bloc de notas o cualquier editor de texto.
- [ ] Busca la línea `GEMINI_API_KEY=` y pega tu clave justo después del `=`, sin espacios ni comillas:

```
GEMINI_API_KEY=AQ.tu_clave_completa
```

- [ ] Busca `ADMIN_TOKEN=` y déjalo **vacío** (borra lo que tenga después del `=`):

```
ADMIN_TOKEN=
```

- [ ] Verifica que esta línea diga así (modelos actualizados):

```
GEMINI_MODELS=gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite
```

- [ ] Guarda el archivo.

> La clave debe ser tuya. Si la compartiste en algún chat, revócala después de las pruebas en https://aistudio.google.com/apikey y crea otra.
> El archivo `.env` nunca se sube a GitHub; no hay riesgo de publicarlo por accidente con `git`.

---

## 4. Arrancar el servidor

```bash
npm start
```

- [ ] En la terminal debes ver estas dos líneas:
  - `Panel + bot escuchando en http://localhost:3000`
  - `IA proveedores activos: gemini`
- [ ] Deja esta terminal **abierta**. Si la cierras, el bot se apaga. Para detenerlo: `Ctrl + C`.

También verás `WA_ACCESS_TOKEN vacio: ... modo simulacion`. Es normal: no enviamos a WhatsApp real.

---

## 5. Comprobaciones rápidas (antes de usar el panel)

- [ ] **Salud del sistema.** Abre en el navegador http://localhost:3000/api/health
  Debe mostrar `"ok":true` y `"live":true`. Si `live` es `false`, la clave no se leyó: vuelve al paso 3.
- [ ] **Tests automáticos.** En otra terminal, dentro de `backend`, ejecuta `npm test`.
  Debe terminar con `CADENA DE FALLBACK VERIFICADA`. (Verás líneas de error rojas en medio: son simulaciones del test, normales.)

---

## 6. Probar el bot en el simulador

Abre **http://localhost:3000** (¡no hagas doble clic al archivo `index.html`!) y busca el simulador de chat.

Haz esta secuencia y compara con lo esperado:

| # | Escribes | Debe responder |
|---|----------|----------------|
| 1 | `hola` | Saludo y menú con 5 opciones |
| 2 | `1` | Pregunta la sucursal (1 Pavas Centro, 2 Lomas del Río) |
| 3 | `1` | Confirma sucursal y pregunta en qué ayudar |
| 4 | `¿Tienen acetaminofén? ¿Para qué sirve?` | Respuesta **escrita por la IA**, amable, con pregunta de seguimiento |
| 5 | `¿Y se lo puedo dar a un niño de 3 años?` | Dice que depende del peso y recomienda consultar al farmacéutico (no da dosis) |
| 6 | `¿Cuál es el horario?` | Horario (Lun–Sáb 7:00–22:00, Dom 8:00–20:00) |
| 7 | `tengo dolor de pecho` | "Le paso con un asesor humano" y el bot **se pausa** para ese chat |
| 8 | Cualquier mensaje después del 7 | El bot **no** responde (está pausado) |

Para volver a empezar, usa el botón **Reiniciar chat** del panel.

### Pruebas extra (opcionales)
- En la sección **Entrena al bot**, agrega una ficha de conocimiento (por ejemplo, "Pagamos con SINPE Móvil"), pulsa **Publicar entrenamiento** y pregunta por ello en el chat.
- Cambiar una regla de negocio (por ejemplo, desactivar envíos a domicilio), publicarla con su botón y preguntar "¿hacen envíos?".

---

## 7. Cómo saber si todo está bien (checklist final)

- [ ] `node -v` muestra v18 o mayor
- [ ] `npm install` terminó sin `ERR!`
- [ ] `npm start` muestra `IA proveedores activos: gemini`
- [ ] `/api/health` muestra `"live":true`
- [ ] `npm test` termina con `CADENA DE FALLBACK VERIFICADA`
- [ ] El paso 4 de la tabla (acetaminofén) respondió con texto de la IA, no con "mi cerebro IA está saturado"
- [ ] El paso 7 (dolor de pecho) pausó el bot

Si los siete están marcados, el sistema funciona.

---

## 8. Si algo falla

| Síntoma | Qué hacer |
|---------|-----------|
| `node` o `git` "no se reconoce" | Cierra y abre la terminal; si persiste, reinstala |
| `npm install` falla | Verifica que estás dentro de la carpeta `backend` y tienes internet |
| `Error: listen EADDRINUSE` / puerto ocupado | Agrega `PORT=3001` en `.env` y abre `http://localhost:3001` |
| `/api/health` muestra `"live":false` | La clave no se leyó. Revisa que `.env` está en `backend/`, que no se llama `.env.txt` (en Windows activa "Extensiones de nombre de archivo") y que no hay espacios ni comillas |
| El bot responde "mi cerebro IA está saturado" / "problemas de conexión" | Mira la terminal donde corre el servidor: |
| → ve `HTTP 503` ... `high demand` | Google saturado. El bot prueba el siguiente modelo; espera unos segundos y reintenta |
| → ve `HTTP 400` o `403` o `API key not valid` | Clave mal copiada o revocada. Genera una nueva en https://aistudio.google.com/apikey |
| → ve `HTTP 404` ... `no longer available` | Modelo retirado. Actualiza `GEMINI_MODELS` en `.env` con modelos vigentes y reinicia (`Ctrl+C`, `npm start`) |
| → ve `HTTP 429` | Pasaste el límite gratuito. Espera un minuto |
| El panel carga pero el chat no responde | Asegúrate de abrirlo desde `http://localhost:3000`, no como archivo |
| Cambié `.env` y no pasa nada | Hay que reiniciar el servidor (`Ctrl+C`, luego `npm start`) |
| Quiero ver más detalle | Todo lo que hace el bot aparece en la terminal del servidor |

---

## 9. Al terminar

- [ ] Detén el servidor con `Ctrl + C`.
- [ ] Revoca la clave de Gemini si ya no la vas a usar, o si fue compartida en algún chat.
- [ ] No subas nunca tu `.env` a GitHub.

---

## Notas

- **WhatsApp real:** requiere cuenta de Meta Business y las variables `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` y `WA_APP_SECRET`, además de una URL pública (hosting o túnel). No es necesario para esta prueba.
- **Datos de prueba:** las conversaciones se guardan en `backend/data/chats.json` y la base de conocimiento en `backend/data/knowledge.json`.
- **GitHub Pages** no puede ejecutar el backend; por eso la prueba se hace en local.
