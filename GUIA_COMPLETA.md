# Bot de Farmacia El Botiquín — Cómo funciona y cómo probarlo en tu casa

Este documento tiene dos partes:

- **Parte A — Cómo funciona todo** (para entender qué estás probando).
- **Parte B — Prueba paso a paso en tu computadora** (sin necesitar ayuda).

Si solo quieres probarlo, salta a la **Parte B**. Si algo falla, ve al final: **Problemas comunes**.

---

# PARTE A — CÓMO FUNCIONA

## A1. La idea en una frase

Es un **asistente para WhatsApp** que atiende a los clientes de la farmacia con ayuda de una IA (Gemini), y que **tú puedes enseñarle** desde un panel web, parecido a como se entrena a Fin AI Agent en Intercom.

## A2. Las piezas

```
 Cliente (WhatsApp)                         Tú (navegador)
        │                                        │
        ▼                                        ▼
  /webhook  ──────►  ┌──────────────────────────────────────┐
  (Meta)             │          BACKEND (Node.js)           │
                     │                                      │
  /api/chat/simulate │  botController  ← decide qué responder│
  (simulador)  ────► │  aiService      ← habla con Gemini   │
                     │  trainingService← lo que tú le enseñas│
                     │  knowledgeService← base de conocimiento│
                     │  store          ← guarda las conversaciones│
                     └──────────────────────────────────────┘
                                   │
                          backend/data/*.json  (se guarda todo aquí)
```

- **El panel** (`index.html`) tiene el **simulador de chat**: escribes como si fueras un cliente. Desde ahí también publicas reglas del negocio.
- **El panel "Entrenar al bot"** (`entrenamiento.html`) es donde le enseñas cosas.
- **El backend** (carpeta `backend/`) es el cerebro. Se arranca con `npm start`.
- **WhatsApp real** se conectaría por el `/webhook`, pero **no es necesario para esta prueba**: el simulador usa exactamente la misma lógica.
- **Las API keys viven solo en `backend/.env`**, nunca en el navegador.

## A3. Qué pasa cuando llega un mensaje

El bot decide **de lo más seguro y exacto a lo más flexible**. En este orden:

| # | Paso | Qué hace | ¿Quién decide? |
|---|------|----------|----------------|
| 1 | **Safety Guard** | Si el mensaje habla de autolesión o abuso, responde con un texto fijo (con el 911) y pasa la conversación a una persona. No se puede apagar. | El código |
| 2 | **Reglas de escalado** | Si se cumple una condición que tú definiste (ej. "intención = pagos"), pasa a una persona. | El código |
| 3 | **Políticas** | Urgencias médicas ("dolor de pecho"), cliente que pide un humano, quejas. Pasa a una persona. | El código |
| 4 | **Procedimiento** | Si hay uno publicado que coincide ("quiero un pedido a domicilio"), lo ejecuta paso a paso. | El código |
| 5 | **Menú o IA** | Al inicio muestra el menú numerado (opciones 1 a 5). Una vez elegida la sucursal, responde la **IA** usando tu contenido y tus reglas. | La IA |

> Idea clave: **lo que siempre debe cumplirse es código** (pasos 1 a 4). **Lo que se interpreta lo hace la IA** con límites (paso 5).

Cuando **pasa a una persona**, el bot **se pausa solo para ese cliente**. Los demás siguen normal. Los mensajes del cliente se siguen guardando para que alguien los lea.

## A4. Si la IA falla, el cliente nunca se queda sin respuesta

El bot prueba en cadena: **Gemini (varios modelos) → Groq → OpenRouter → respuestas locales → mensaje de respaldo**.

- Si un modelo está saturado (error 503), prueba el siguiente solo.
- Si la clave está mal, lo salta sin perder tiempo.
- Si nada responde, usa las reglas locales (horarios, sucursales, envíos, precios) o tu base de conocimiento.
- Solo si todo falla, manda un mensaje amable de respaldo.

## A5. Qué le puedes enseñar (panel "Entrenar al bot")

Entras desde el botón verde **Entrenar al bot** del panel principal.

| Pestaña | Para qué sirve | Ejemplo |
|---------|----------------|---------|
| **Resumen** | Mapa general de lo que sabe y hace el bot. | — |
| **Contenido** | La biblioteca de conocimiento: lo que el bot puede decir con seguridad. Cada ficha puede ser *borrador* o *publicada*, y tener fechas de vigencia. | "Aceptamos SINPE Móvil al 8888-0000" |
| **Guidance** | Instrucciones de **cómo hablar**, en lenguaje natural. Más el tono y la longitud de las respuestas. | "Despídete siempre con *Pura vida*" |
| **Escalado** | Reglas exactas de **cuándo pasar a una persona**. También el clasificador de intención. | "Si el tema es pagos → pasar a humano" |
| **Procedimientos** | Flujos paso a paso: pregunta datos, decide por ramas, traspasa con resumen. | Pedido a domicilio: pide producto y dirección, y si requiere receta pasa al farmacéutico |
| **Test** | Un banco de preguntas para comprobar que el bot responde bien, sobre todo **después de cambiar algo**. | "¿Cuál es el horario?" debe contener "sábado" |
| **Recomendaciones** | Las preguntas reales que el bot **no supo responder**, de más a menos frecuentes. Tú escribes la respuesta y ya la sabe. | "¿Tienen servicio de presión arterial?" |
| **Análisis** | Cuántos mensajes resolvió el bot, cuántos pasó a personas, de qué hablan los clientes. | 80 % automatizado |
| **Changelog** | Registro de cada cambio que hiciste. | "Guidance creada · Pura vida" |

### Contenido vs. Guidance vs. Procedimiento

- **Contenido** = *qué sabe* (hechos).
- **Guidance** = *cómo habla* (tono, estilo). Influye, pero **no garantiza**.
- **Procedimiento** = *qué hace*, paso a paso. Sí se cumple siempre.

Si algo **debe pasar siempre**, usa **Escalado** o **Procedimientos**, no Guidance.

### El ciclo de mejora

```
Entrenar  →  Probar (Test)  →  Publicar  →  Analizar  →  Recomendaciones piden cambios
   ▲                                                                   │
   └───────────────────────────────────────────────────────────────────┘
```

1. Enseñas algo (Contenido, Guidance, etc.).
2. Corres **Test** para ver que no se rompió nada.
3. Lo usas en el simulador o con clientes.
4. **Análisis** y **Recomendaciones** te muestran dónde falla.
5. Vuelves a enseñar.

### Cómo se escribe un Procedimiento

Una línea por paso:

```
preguntar producto: ¿Qué producto necesita?
preguntar direccion: ¿A qué dirección se lo llevamos?
si producto contiene receta -> con_receta | sino -> sin_receta
etiqueta: con_receta
traspasar: Le paso con un farmacéutico para confirmar {{producto}} en {{direccion}}.
etiqueta: sin_receta
fin: Listo, anotamos {{producto}}. ¡Gracias! 💙
```

| Línea | Qué hace |
|-------|----------|
| `decir: texto` | El bot dice algo |
| `preguntar variable: texto` | Pregunta y guarda la respuesta en esa variable |
| `si variable contiene/es/existe valor -> etiqueta \| sino -> otra` | Decide por rama |
| `etiqueta: nombre` | Marca un punto para saltar |
| `traspasar: texto` | Pasa a una persona (y guarda un resumen) |
| `fin: texto` | Termina |

Los textos pueden usar `{{variable}}`. El cliente puede escribir **cancelar** para salir.

## A6. Dónde se guarda todo

Todo en archivos de la carpeta `backend/data/`:

| Archivo | Contiene |
|---------|----------|
| `chats.json` | Las conversaciones |
| `knowledge.json` | Contenido y políticas |
| `training.json` | Guidance, reglas, procedimientos, tests, recomendaciones, métricas. **No se sube a GitHub.** Si lo borras, vuelven los ejemplos iniciales. |

---

# PARTE B — PRUEBA PASO A PASO EN TU CASA

Tiempo estimado: **20 minutos**. Marca cada casilla.

## B1. Instalar (solo la primera vez)

**Node.js**
- [ ] Descarga la versión **LTS** desde https://nodejs.org e instálala (Siguiente, Siguiente).
- [ ] Abre una terminal: en **Windows** busca "PowerShell"; en **Mac** abre "Terminal".
- [ ] Escribe `node -v`. Debe mostrar `v18` o mayor.

**Git**
- [ ] Escribe `git --version`. Si no lo tienes, instálalo desde https://git-scm.com/downloads.
- Alternativa sin Git: en GitHub, botón verde **Code → Download ZIP**, descomprime y salta al paso B2.2.

## B2. Descargar el proyecto

**B2.1 Clonar**
```bash
git clone https://github.com/angelor256/Bot-Farmacia-el-Botiquin.git
cd Bot-Farmacia-el-Botiquin
```

- [ ] Si el **PR #8** ya está fusionado en GitHub, estás listo. Si **no**, cambia a la rama:
```bash
git checkout claude/admiring-goldberg-rchr0o
```
(Para saberlo: en GitHub abre el repo → *Pull requests* → *#8*. Si dice **Merged**, ya está en `main`.)

**B2.2 Instalar dependencias**
```bash
cd backend
npm install
```
- [ ] Debe terminar sin la palabra `ERR!`. Los avisos `WARN` o "vulnerabilities" no importan.

## B3. Poner tu clave de Gemini

**B3.1 Crear tu archivo `.env`** (estando dentro de `backend`):
- Windows (PowerShell): `copy .env.example .env`
- Mac / Linux: `cp .env.example .env`

**B3.2 Editarlo** con el Bloc de notas o cualquier editor:
- [ ] En la línea `GEMINI_API_KEY=` pega tu clave justo después del `=`, **sin espacios ni comillas**.
  Las claves nuevas empiezan con `AQ.`; las antiguas con `AIza`. Ambas sirven.
- [ ] Deja `ADMIN_TOKEN=` **vacío** (borra lo que tenga después del `=`). Así el panel no pide contraseña.
- [ ] Revisa que `GEMINI_MODELS=` diga: `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite`
- [ ] Guarda el archivo.

> Si compartiste tu clave en algún chat, **revócala al terminar** en https://aistudio.google.com/apikey y crea otra.
> El archivo `.env` nunca se sube a GitHub.
> En Windows, verifica que el archivo se llame `.env` y no `.env.txt` (activa "Extensiones de nombre de archivo" en el Explorador).

## B4. Arrancar

```bash
npm start
```

- [ ] Debes ver: `Panel + bot escuchando en http://localhost:3000`
- [ ] Y: `IA proveedores activos: gemini`
- [ ] **Deja esta terminal abierta.** Si la cierras, el bot se apaga. Para detenerlo: `Ctrl + C`.

El aviso `WA_ACCESS_TOKEN vacio… modo simulacion` es normal: no enviamos a WhatsApp real.

## B5. Comprobaciones rápidas

- [ ] Abre http://localhost:3000/api/health → debe decir `"ok":true` y `"live":true`.
- [ ] En **otra** terminal, dentro de `backend`: `npm test`. Debe terminar con `ENTRENAMIENTO OK`. (Verás líneas rojas de error en medio: son simulaciones del test, es normal.)

## B6. Probar el bot en el simulador

Abre **http://localhost:3000** (¡no hagas doble clic al archivo `index.html`!).

| # | Escribes | Debe responder |
|---|----------|----------------|
| 1 | `hola` | Saludo y menú con 5 opciones |
| 2 | `1` | Pregunta la sucursal |
| 3 | `1` | Confirma la sucursal y pregunta en qué ayudar |
| 4 | `¿Tienen acetaminofén? ¿Para qué sirve?` | Respuesta escrita por la IA |
| 5 | `¿Y se lo puedo dar a un niño de 3 años?` | Dice que depende del peso y no da dosis |
| 6 | `¿Cuál es el horario?` | Lun–Sáb 7:00–22:00, Dom 8:00–20:00 |
| 7 | `¿Hacen envíos a domicilio?` | Sí, en Pavas y alrededores (según la base de conocimiento) |
| 8 | `tengo dolor de pecho` | "Le paso con un asesor humano" y el bot **se pausa** |
| 9 | Cualquier mensaje después | **No** responde (está pausado) |

Para empezar de nuevo, usa el botón **Reiniciar chat**.

## B7. Probar el panel "Entrenar al bot"

Pulsa el botón verde **Entrenar al bot** (o abre http://localhost:3000/entrenamiento.html).

**Prueba 1 — Enseñar un dato (Contenido)**
1. Pestaña **Contenido → Nuevo contenido**.
2. Título: `Tomas de presión`. Contenido: `Sí, tomamos la presión gratis en ambas sucursales.` Palabras clave: `presión, tension`. Estado: **Publicado**. Guardar.
3. Vuelve al simulador, **Reiniciar chat**, llega hasta la sucursal (`hola`, `1`, `1`) y pregunta `¿Tienen toma de presión?`. Debe responder con lo que escribiste.

**Prueba 2 — Un borrador no se usa (Contenido)**
1. Edita esa ficha y ponla en **Borrador**. Pregunta de nuevo: el bot ya no debe citarla.

**Prueba 3 — Cambiar cómo habla (Guidance)**
1. Pestaña **Guidance**. Cambia *Tono de voz* a **Profesional** y *Longitud* a **Concise**. Guardar ajustes.
2. **Nueva regla**: `Despídete siempre con Pura vida.` Estado: **Publicada**.
3. En el simulador pregunta algo y comprueba que responde más corto y se despide así.

**Prueba 4 — Pasar a una persona por una regla (Escalado)**
1. Pestaña **Escalado**. Activa la regla **Pagos y devoluciones** (botón *Activar*).
2. En el simulador (con chat reiniciado) escribe `necesito mi factura electrónica`. Debe pasar a un asesor y pausarse.
3. Pruébalo también en **Probar el clasificador**: escribe `¿a qué hora abren?` y verás la intención detectada.

**Prueba 5 — Un procedimiento (Procedimientos)**
1. Pestaña **Procedimientos** → **Probar** en *Pedido a domicilio*. Escribe en el cuadro: `aspirina` y en otra línea `Pavas`. Verás la conversación simulada.
2. Para usarlo de verdad: **Editar → Estado: Publicado → Guardar**. En el simulador (ya en la sucursal) escribe `quiero un pedido a domicilio` y responde lo que pide. Al final se pausa y queda un resumen para la persona.
3. Puedes escribir `cancelar` a mitad para salir.

**Prueba 6 — El banco de pruebas (Test)**
1. Pestaña **Test** → **Ejecutar todas**. Tarda un minuto: usa la IA real.
2. Cada fila muestra la respuesta, qué contenido o regla usó y una valoración (*Bien / Mal*). Con **Evaluar** ves el detalle y puedes valorar a mano.
3. Cambia algo (por ejemplo una regla de Guidance) y vuelve a ejecutar para comparar. **Informe CSV** lo descarga.

**Prueba 7 — Aprender de lo que no sabe (Recomendaciones)**
1. Pregunta en el simulador cosas que el bot no pueda responder (si la IA responde todo, esta lista puede quedar vacía; es buena señal).
2. Pestaña **Recomendaciones**: aparecen las preguntas sin respuesta. **Enseñar respuesta**, escribe la correcta, y el bot la sabrá.

**Prueba 8 — Resultados (Análisis y Changelog)**
1. **Análisis**: porcentaje automatizado, escalado y sin respuesta; temas más frecuentes.
2. **Changelog**: todo lo que cambiaste, con fecha.

## B8. Checklist final

- [ ] `node -v` muestra v18 o mayor
- [ ] `npm install` terminó sin `ERR!`
- [ ] `npm start` muestra `IA proveedores activos: gemini`
- [ ] `/api/health` muestra `"live":true`
- [ ] `npm test` termina con `ENTRENAMIENTO OK`
- [ ] La pregunta del acetaminofén (B6 #4) la respondió la IA
- [ ] "Dolor de pecho" pausó el bot
- [ ] El contenido que enseñaste (Prueba 1) se usó en una respuesta
- [ ] **Ejecutar todas** en Test completó las preguntas

Si todo está marcado, el sistema funciona.

## B9. Al terminar

- [ ] Detén el servidor con `Ctrl + C`.
- [ ] Si ya no la usarás (o la compartiste en un chat), **revoca la clave** en https://aistudio.google.com/apikey.
- [ ] Nunca subas tu `.env` a GitHub.

---

# PROBLEMAS COMUNES

| Síntoma | Qué hacer |
|---------|-----------|
| `node` o `git` "no se reconoce" | Cierra y abre la terminal; si persiste, reinstala |
| `npm install` falla | Verifica que estás dentro de la carpeta `backend` y que tienes internet |
| Puerto ocupado (`EADDRINUSE`) | Agrega `PORT=3001` en `.env` y abre `http://localhost:3001` |
| `/api/health` muestra `"live":false` | La clave no se leyó. Revisa que `.env` esté en `backend/`, que no se llame `.env.txt` y que no tenga espacios ni comillas |
| El bot responde "mi cerebro IA está saturado" | Mira la terminal del servidor: |
| → `HTTP 503 … high demand` | Google saturado. El bot prueba otro modelo solo; espera unos segundos |
| → `HTTP 400` / `403` / `API key not valid` | Clave mal copiada o revocada. Crea una nueva en https://aistudio.google.com/apikey |
| → `HTTP 404 … no longer available` | Modelo retirado. Actualiza `GEMINI_MODELS` en `.env` y reinicia |
| → `HTTP 429` | Pasaste el límite gratuito. Espera un minuto |
| La página "Entrenar" dice "No se pudo cargar" | El servidor no está corriendo, o abriste el archivo con doble clic. Usa `http://localhost:3000/entrenamiento.html` |
| El panel carga pero el chat no responde | Ábrelo desde `http://localhost:3000`, no como archivo |
| Cambié `.env` y no pasa nada | Reinicia el servidor (`Ctrl + C`, luego `npm start`) |
| El panel pide un token | En `.env` deja `ADMIN_TOKEN=` vacío y reinicia |
| Quiero ver qué hace el bot por dentro | Todo se imprime en la terminal donde corre `npm start` |
| Quiero volver a los ejemplos iniciales del entrenamiento | Detén el servidor y borra `backend/data/training.json` |

---

# GLOSARIO RÁPIDO

- **Backend**: el programa que corre en tu computadora y hace todo el trabajo.
- **Simulador**: el chat del panel, que se comporta como WhatsApp pero en local.
- **API key**: la contraseña que te da Google para usar Gemini.
- **Escalar / traspasar**: pasar la conversación a una persona. El bot se calla para ese cliente.
- **Intención**: el tema de un mensaje (horarios, pagos, queja…).
- **Borrador / Publicado**: un borrador no lo usa el bot; uno publicado sí.
- **Guidance**: instrucciones de estilo en lenguaje natural.
- **Safety Guard**: filtro fijo para temas sensibles; siempre activo.

# LO QUE TODAVÍA NO HACE

- Conectarse a **WhatsApp real** (requiere cuenta de Meta Business y una dirección pública).
- Sincronizar contenido desde sitios web o PDFs.
- Leer datos del cliente desde sistemas externos.
- Redactar con IA las respuestas de las Recomendaciones: las escribes tú, para que el bot nunca invente datos de la farmacia.
