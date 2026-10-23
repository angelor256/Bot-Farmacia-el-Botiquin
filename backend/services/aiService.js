'use strict';
/**
 * services/aiService.js — GATEWAY DE IA con fallback multi-proveedor.
 *
 * Diagnóstico de los fallos que este módulo corrige:
 *  1. Modelos inexistentes ("gemini-3.8-flash" / "gemini-3.5-flash-lite") → HTTP 404
 *     guaranteed failure. Aquí la lista de modelos es configurable y se valida en cadena.
 *  2. API key expuesta en el HTML → cualquier visitante la roba (y Google bloquea la
 *     llamada por origen/referrer). Las keys ahora SOLO viven en .env del backend.
 *  3. thinkingConfig.thinkingLevel → parámetro no soportado por la REST API de Gemini
 *     en ciertos modelos → 400. Se quita; se usa temperature/maxOutputTokens válidos.
 *  4. Sin clasificación de errores → se reintentaba un 401 (no recuperable) igual que
 *     un timeout. Aquí: retry+backoff solo para 408/429/5xx/red; skip inmediato en 401/403/404.
 *  5. Sin fallback real de proveedor → si Gemini caía, el bot callaba. Ahora:
 *     Gemini (N modelos) → Groq → OpenRouter → respuesta de respaldo local (fallback).
 */
// Se usa el módulo axios RESUELTO en tiempo de llamada (no capturado al require),
// para que los tests puedan simular la red sustituyendo axios.post.
const http = () => require('axios');
const config = require('../config');
const log = require('../utils/logger');
const kb = require('./knowledgeService');
const { buildSystemPrompt } = require('./promptBuilder');

/* ---------------- Herreras de error tipadas ---------------- */
class AiError extends Error {
  constructor(message, { status = 0, kind = 'unknown', provider = '', model = '' } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;   // HTTP status si aplica
    this.kind = kind;       // auth | notfound | quota | server | network | timeout | empty | blocked
    this.provider = provider;
    this.model = model;
    this.retryable = ['quota', 'server', 'network', 'timeout'].includes(kind);
  }
}

/** Clasifica un fallo de proveedor en una categoría accionable. */
function classify(status, bodyText = '') {
  const b = String(bodyText).toLowerCase();
  // OJO: Gemini NO devuelve 401 con key inválida: devuelve HTTP 400 con
  // reason "API_KEY_INVALID" / "API key not valid". Sin este chequeo, ese
  // error se clasificaba como desconocido y se reintentaban los 3 modelos
  // con la misma key rota → el bot caía al fallback sin diagnóstico claro.
  if (status === 401 || status === 403) return 'auth';
  if (b.includes('api_key_invalid') || b.includes('api key not valid') ||
      b.includes('invalid api key') || b.includes('permission denied') ||
      b.includes('unauthorized') || b.includes('key not valid') ||
      b.includes('invalid x-api-key') || b.includes('insufficient credit') ||
      b.includes('no endpoints found') ||
      // Gemini responde ACCESS_TOKEN_TYPE_UNSUPPORTED cuando la credential NO
      // es una API key clásica (AIzaSy...): son tokens de Google AI Studio /
      // Firebase App Manager (formato "AQ....") que solo sirven en sus proxies
      // propios y jamás funcionarán contra generativelanguage.googleapis.com.
      b.includes('access_token_type_unsupported')) return 'auth';
  if (status === 404 || b.includes('not found') || b.includes('is not found for api version')) return 'notfound';
  if (status === 429 || b.includes('quota') || /\brate\b/.test(b)) return 'quota';
  if (status === 400 && (b.includes('safety') || b.includes('block') || b.includes('recitation'))) return 'blocked';
  if (status >= 500) return 'server';
  return 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => config.ai.retry.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);

/* ---------------- Traducción de historial a cada API ---------------- */
/** history: [{role:'user'|'model'|'assistant', text}] -> formato Gemini `contents` */
function toGeminiContents(history, userMsg) {
  const norm = (r) => (r === 'model' || r === 'assistant' ? 'model' : 'user');
  const contents = history.map((m) => ({ role: norm(m.role), parts: [{ text: m.text }] }));
  contents.push({ role: 'user', parts: [{ text: userMsg }] });
  // Gemini exige que el primer turno sea 'user': recorta cabeceras huérfanas de 'model'.
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

/** history -> mensajes estilo OpenAI (Groq / OpenRouter) */
function toOpenAiMessages(systemPrompt, history, userMsg) {
  const norm = (r) => (r === 'model' || r === 'assistant' ? 'assistant' : 'user');
  return [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: norm(m.role), content: m.text })),
    { role: 'user', content: userMsg },
  ];
}

/* ---------------- Proveedores ---------------- */
async function callGemini({ apiKey, baseUrl }, model, systemPrompt, contents) {
  const url = `${baseUrl}/${model}:generateContent`;
  try {
    const { data } = await http().post(url, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: config.ai.temperature, maxOutputTokens: config.ai.maxOutputTokens },
    }, {
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: config.ai.timeoutMs,
    });
    const cand = data?.candidates?.[0];
    // CAMBIO CLAVE (bug "responde mal"): antes un 200 con texto vacío lanzaba
    // AiError('empty') que NO era retryable ni skip → abortaba TODA la cadena
    // y caía directo al fallback genérico. Ahora devuelve null y el orquestador
    // prueba el siguiente modelo/proveedor antes de rendirse.
    const text = extractGeminiText(cand, data);
    if (text === null) return null;
    // Post-proceso: los modelos alucinan a veces la sintaxis del endpoint
    // ":streamGenerateContent" dentro del texto. Se limpia para no romper la UI.
    return text.replace(/\/v1beta\/models\/[\w.-]+:streamGenerateContent\?[^*\s]*/g, 'la sucursal');
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw wrapAxios(err, 'gemini', model);
  }
}

async function callOpenAiCompatible({ apiKey, baseUrl }, model, messages) {
  try {
    const { data } = await http().post(`${baseUrl}/chat/completions`, {
      model, messages,
      temperature: config.ai.temperature,
      max_tokens: config.ai.maxOutputTokens,
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: config.ai.timeoutMs,
    });
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null; // mismo criterio: 200-vacío → siguiente destino, no muerte de cadena
    return text;
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw wrapAxios(err, 'groq/openrouter', model);
  }
}

function wrapAxios(err, provider, model) {
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
    return new AiError(`${provider}/${model}: timeout tras ${config.ai.timeoutMs}ms`, { kind: 'timeout', provider, model });
  }
  if (err.response) {
    const status = err.response.status;
    const body = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data || {});
    return new AiError(`${provider}/${model} → HTTP ${status}: ${body.slice(0, 300)}`, { status, kind: classify(status, body), provider, model });
  }
  return new AiError(`${provider}/${model}: error de red (${err.message})`, { kind: 'network', provider, model });
}

/* ---------------- Fallback final (objetivo #1) ---------------- */
const FALLBACKS = [
  'Disculpe, en este momento mi cerebro IA está saturado 😅. Un farmacéutico le atenderá en breve por este medio o al tel. 2213 5670.',
  'Estamos teniendo problemas de conexión con el asistente virtual 💙. Escriba su consulta y se la pasamos a nuestro equipo en la sucursal.',
  'Ups, el bot no logra responder ahora mismo. Puede llamarnos al 2213 5670 o acercarse a Pavas Centro / Lomas del Río. 🙏',
];
const defaultFallback = () => FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];

/* ---------------- Circuit breaker (interruptor por proveedor) ---------------- */
/**
 * Si un proveedor falla por credenciales inválidas o agota toda su cadena de
 * modelos, lo marcamos "abierto" durante un rato para no desperdiciar tiempo
 * del cliente reintentando un destino roto en cada mensaje.
 */
const breaker = new Map(); // provider -> { until, reason }
const BREAKER_MS = 60_000;
function openBreaker(provider, reason) {
  breaker.set(provider, { until: Date.now() + BREAKER_MS, reason });
  log.warn(`[ai] circuit-breaker ABIERTO para ${provider} durante ${BREAKER_MS / 1000}s (${reason}).`);
}
const breakerOpen = (provider) => {
  const b = breaker.get(provider);
  if (!b) return false;
  if (Date.now() >= b.until) { breaker.delete(provider); return false; }
  return true;
};

/* ---------------- Diagnóstico local (sin keys) ---------------- */
/**
 * Cuando NO hay ninguna API key configurada, el gateway puede seguir
 * respondiendo con reglas locales simples (menú, precios, horarios),
 * útil para demos/simulador del panel. Devuelve null si no sabe responder
 * (y entonces sí procede el fallback humano).
 */
function localAnswer(userMessage, context = {}) {
  const t = String(userMessage || '').toLowerCase();
  const rules = context.business_rules || {};
  // 1) Base de conocimiento enseñada desde el panel (Sección D "Entrena al bot"):
  //    si una ficha coincide con la pregunta, ESA es la respuesta autoritativa.
  const hits = kb.retrieve(userMessage, { topK: 2 });
  if (hits.length && hits[0].score >= 3) {
    return `💙 ${hits[0].title}\n${hits[0].excerpt}`;
  }
  if (/horario|abren|cierran|atienden/.test(t)) {
    return '🕐 Horarios El Botiquín:\nLun a Sáb: 7:00–22:00\nDom: 8:00–20:00 💙';
  }
  if (/direccion|donde|sucursal|ubicad/.test(t)) {
    return '📍 Pavas Centro (frente a la feria del farmer, L-20) y Lomas del Río (100 m sur de la entrada principal). 🏥';
  }
  if (/env[ií]o|domicilio|delivery/.test(t)) {
    return rules.envios_domicilio
      ? 'Sí, hacemos envíos a domicilio 🛵. Indíquenos su dirección y producto y coordinamos la entrega. 💙'
      : 'Por ahora no contamos con servicio a domicilio, pero le esperamos en cualquiera de nuestras sucursales. 🙏';
  }
  if (/precio|cuanto|vale|costo/.test(t)) {
    const list = (context.price_lists || [])[0];
    if (list && Array.isArray(list.items) && list.items.length) {
      const hit = list.items.find((i) => t.includes(String(i.name || '').toLowerCase()));
      if (hit) return `El/La ${hit.name} está en ₡${hit.price}. ¿Desea apartarlo? 💊`;
    }
    return 'Para precios exactos dígame el nombre del producto y la sucursal (Pavas Centro o Lomas del Río) y lo verifico con gusto. 😊';
  }
  return null;
}

/* ---------------- Cadena principal ---------------- */
/**
 * Devuelve el texto de un candidato de Gemini, o null si el modelo respondió
 * 200 pero con contenido no utilizable (bloqueo de seguridad, corte por
 * límite de tokens, solo thought-signatures). Esos casos se recorren como
 * destino fallido para probar el siguiente modelo/proveedor ANTES de caer
 * al fallback — antes era la causa #1 de "no responde correctamente" con
 * prompts largos: HTTP 200 + parts[] vacío.
 */
function extractGeminiText(cand, data) {
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (text) return text;
  const reason = cand?.finishReason || data?.promptFeedback?.blockReason || '';
  log.warn(`[ai] Gemini respondió sin texto útil (motivo: ${reason || 'vacío'}); se prueba el siguiente destino`);
  return null;
}

/**
 * Pide una respuesta a la IA recorriendo proveedores/modelos con reintento.
 * @param {Object} opts
 * @param {string} opts.userMessage        Mensaje actual del cliente.
 * @param {Array<{role,text}>} [opts.history] Historial reciente (desde store.getRecentHistory).
 * @param {Object} [opts.context]          business_rules / branch / option / message para el prompt.
 * @param {(info:{provider,model,attempts,errors})=>void} [opts.onDegrade] aviso de degradación.
 * @returns {Promise<{text:string, provider:string, model:string, degraded:boolean}>}
 */
async function generateReply({ userMessage, history = [], context = {}, onDegrade }) {
  // ctx.message permite que el RAG recupere artículos según la pregunta ACTUAL.
  const systemPrompt = buildSystemPrompt({ ...context, message: userMessage });
  const contents = toGeminiContents(history, userMessage);
  const messages = toOpenAiMessages(systemPrompt, history, userMessage);
  const errors = [];
  let attempted = 0;

  const plan = [];
  const P = config.ai.providers;
  if (P.gemini.enabled) P.gemini.models.forEach((m) => plan.push({ run: () => callGemini(P.gemini, m, systemPrompt, contents), provider: 'gemini', model: m }));
  if (P.groq.enabled) P.groq.models.forEach((m) => plan.push({ run: () => callOpenAiCompatible(P.groq, m, messages), provider: 'groq', model: m }));
  if (P.openrouter.enabled) P.openrouter.models.forEach((m) => plan.push({ run: () => callOpenAiCompatible(P.openrouter, m, messages), provider: 'openrouter', model: m }));

  if (!plan.length) {
    // Sin ninguna API key: intentamos resolver localmente (horarios, sedes,
    // envíos, precios) para que el bot NO muera en demos/simulador del panel.
    const local = localAnswer(userMessage, context);
    if (local) {
      log.warn('[ai] Sin proveedores configurados: respuesta resuelta por reglas locales.');
      return { text: local, provider: 'fallback-local', model: 'rules', degraded: true };
    }
    log.warn('[ai] Ningún proveedor configurado (sin API keys): usando respuesta de respaldo.');
    return { text: defaultFallback(), provider: 'fallback-local', model: 'none', degraded: true };
  }

  for (const step of plan) {
    if (breakerOpen(step.provider)) continue; // proveedor ya marcado como roto: lo saltamos
    for (let attempt = 0; attempt < config.ai.retry.attempts; attempt++) {
      try {
        let text = await step.run();
        if (text === null) { // 200-pero-vacío/bloqueado → tratar como fallo y seguir la cadena
          errors.push(`${step.provider}/${step.model}: respuesta vacía o bloqueada`);
          break; // siguiente destino (otro modelo suele generar texto donde este se bloqueó)
        }
        attempted++;
        const degraded = errors.length > 0;
        if (degraded && typeof onDegrade === 'function') onDegrade({ provider: step.provider, model: step.model, attempts: attempted, errors });
        if (degraded) log.warn(`[ai] degradación: respondió ${step.provider}/${step.model} tras ${errors.length} fallo(s): ${errors.join(' | ')}`);
        return { text, provider: step.provider, model: step.model, degraded };
      } catch (err) {
        errors.push(`${step.provider}/${step.model}: ${err.message}`);
        log.error('[ai]', err);
        // Errores irrecuperables: no tiene sentido reintentar N modelos cuando
        // la credencial es inválida o ese modelo concreto no existe en la API.
        if (err.kind === 'auth' || err.kind === 'notfound') {
          log.warn(`[ai] ${step.provider}/${step.model}: ${err.kind} → descarto este destino sin reintentos.`);
          // auth = credencial rota para TODO el proveedor → abrimos el breaker
          // y pasamos directo al siguiente proveedor de la cadena.
          if (err.kind === 'auth') { openBreaker(step.provider, 'credencial inválida'); break; }
          break;
        }
        if (err.retryable && attempt < config.ai.retry.attempts - 1) { await sleep(backoff(attempt)); continue; }
        break; // no reintentable o ya agoté intentos → siguiente modelo/proveedor
      }
    }
  }
  // El breaker SOLO se abre por fallo de CREDENCIAL (kind auth), confirmado
  // arriba en el catch. Un 404 es un problema por MODELO (el siguiente del
  // mismo proveedor puede funcionar), y los fallos transitorios (5xx/quota)
  // deben reintentarse en el próximo mensaje: abrir el breaker aquí sería
  // un falso positivo que dejaría al bot sin su mejor proveedor.

  log.error(`[ai] TODOS los proveedores fallaron (${errors.length}). Sirviendo fallback.`);
  // Última oportunidad ANTES del mensaje genérico de error: si la base de
  // conocimiento enseñada en el panel (Sección D) o las reglas locales cubren
  // la pregunta, el cliente recibe una respuesta útil aunque la IA remota
  // esté caída/ mal configurada. Corrige el síntoma "no responde correctamente"
  // cuando el único proveedor configurado tiene credenciales inválidas.
  const local = localAnswer(userMessage, context);
  if (local) {
    if (typeof onDegrade === 'function') onDegrade({ provider: 'fallback-local', model: 'rules', attempts: attempted, errors });
    return { text: local, provider: 'fallback-local', model: 'rules', degraded: true, errors };
  }
  if (typeof onDegrade === 'function') onDegrade({ provider: 'fallback-local', model: 'none', attempts: attempted, errors });
  return { text: defaultFallback(), provider: 'fallback-local', model: 'none', degraded: true, errors };
}

/** Un proveedor cuenta si tiene API key configurada (las claves de Gemini pueden ser "AIza…" o "AQ.…"). */
function usableProvider(name) {
  const p = config.ai.providers[name];
  return !!(p && p.enabled);
}

/** Estado de salud para el panel (qué proveedores están configurados/activos). */
function health() {
  const P = config.ai.providers;
  const names = ['gemini', 'groq', 'openrouter'];
  const warnings = [];
  return {
    configured: names.filter(usableProvider).map((k) => ({ provider: k, models: P[k].models })),
    totalProviders: Object.keys(P).length,
    live: names.some(usableProvider),
    warnings,
  };
}

module.exports = { generateReply, health, defaultFallback, localAnswer, toGeminiContents, toOpenAiMessages, AiError, classify };
