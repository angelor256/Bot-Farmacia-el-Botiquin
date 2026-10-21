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
const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');
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
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || b.includes('not found') || b.includes('is not found for api version')) return 'notfound';
  if (status === 429 || b.includes('quota') || b.includes('rate')) return 'quota';
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
    const { data } = await axios.post(url, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: config.ai.temperature, maxOutputTokens: config.ai.maxOutputTokens },
    }, {
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: config.ai.timeoutMs,
    });
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) {
      const reason = cand?.finishReason || data?.promptFeedback?.blockReason || 'empty';
      throw new AiError(`Gemini/${model}: sin texto (${reason})`, { status: 200, kind: reason === 'SAFETY' ? 'blocked' : 'empty', provider: 'gemini', model });
    }
    return text;
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw wrapAxios(err, 'gemini', model);
  }
}

async function callOpenAiCompatible({ apiKey, baseUrl }, model, messages) {
  try {
    const { data } = await axios.post(`${baseUrl}/chat/completions`, {
      model, messages,
      temperature: config.ai.temperature,
      max_tokens: config.ai.maxOutputTokens,
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: config.ai.timeoutMs,
    });
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AiError(`${model}: respuesta vacía`, { status: 200, kind: 'empty', provider: 'openai-compat', model });
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

/* ---------------- Cadena principal ---------------- */
/**
 * Pide una respuesta a la IA recorriendo proveedores/modelos con reintento.
 * @param {Object} opts
 * @param {string} opts.userMessage        Mensaje actual del cliente.
 * @param {Array<{role,text}>} [opts.history] Historial reciente (desde store.getRecentHistory).
 * @param {Object} [opts.context]          business_rules / branch / option para el prompt.
 * @param {(info:{provider,model,attempts,errors})=>void} [opts.onDegrade] aviso de degradación.
 * @returns {Promise<{text:string, provider:string, model:string, degraded:boolean}>}
 */
async function generateReply({ userMessage, history = [], context = {}, onDegrade }) {
  const systemPrompt = buildSystemPrompt(context);
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
    log.warn('[ai] Ningún proveedor configurado (sin API keys): usando respuesta de respaldo.');
    return { text: defaultFallback(), provider: 'fallback-local', model: 'none', degraded: true };
  }

  for (const step of plan) {
    for (let attempt = 0; attempt < config.ai.retry.attempts; attempt++) {
      try {
        const text = await step.run();
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
          break;
        }
        if (err.retryable && attempt < config.ai.retry.attempts - 1) { await sleep(backoff(attempt)); continue; }
        break; // no reintentable o ya agoté intentos → siguiente modelo/proveedor
      }
    }
  }

  log.error(`[ai] TODOS los proveedores fallaron (${errors.length}). Sirviendo fallback.`);
  if (typeof onDegrade === 'function') onDegrade({ provider: 'fallback-local', model: 'none', attempts: attempted, errors });
  return { text: defaultFallback(), provider: 'fallback-local', model: 'none', degraded: true, errors };
}

/** Estado de salud para el panel (qué proveedores están configurados/activos). */
function health() {
  const P = config.ai.providers;
  return {
    configured: Object.entries(P).filter(([, v]) => v.enabled).map(([k, v]) => ({ provider: k, models: v.models })),
    totalProviders: Object.keys(P).length,
    live: Object.values(P).some((v) => v.enabled),
  };
}

module.exports = { generateReply, health, defaultFallback, toGeminiContents, toOpenAiMessages, AiError, classify };
