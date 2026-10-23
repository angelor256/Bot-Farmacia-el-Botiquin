'use strict';
/**
 * services/knowledgeService.js — Base de conocimiento estilo "Fin AI" (Intercom).
 *
 * El dueño de la empresa "enseña" al bot mediante:
 *   - Articles  : fichas {title, content, keywords[], category}
 *   - Policies  : reglas conversacionales {id, name, enabled, priority, instruction}
 *                 (obligatorias para la IA) + directivas de escalado {escalateToHuman, autoEscalate}
 *   - Map       : mapa visual del flujo de interacción (estados + condiciones de
 *                 escalado a humano) → se serializa como texto determinista y se
 *                 inyecta en el system prompt. Es LA fuente de verdad de "cuándo sí
 *                 y cuándo no escalar".
 *
 * Persistencia: JSON en disco con escritura atómica (mismo patrón que store.js);
 * en producción basta sustituir read/write por una tabla Postgres/Redis.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../utils/logger');

const FILE = path.join(config.dataDir, 'knowledge.json');

/* ---------------- Estado en memoria ---------------- */
let kb = { articles: [], policies: null, map: null, updatedAt: null };

/* ---------------- Política y mapa por defecto (El Botiquín) ---------------- */
const DEFAULT_POLICIES = [
  { id: 'med_seguros', name: 'Alcance médico seguro', enabled: true, priority: 10, escalateToHuman: false, autoEscalate: '',
    instruction: 'Puedes explicar para qué sirve un medicamento y precauciones generales, pero NUNCA des dosis personalizadas ni diagnósticos: deriva al farmacéutico.' },
  { id: 'urgencias', name: 'Urgencias médicas', enabled: true, priority: 1, escalateToHuman: true, autoEscalate: 'Detección automática: palabras de urgencia grave (dolor de pecho, dificultad respiratoria, convulsión, sobredosis, reacción alérgica severa, sangrado, suicidio).' },
  { id: 'recetas', name: 'Recetas médicas', enabled: true, priority: 3, escalateToHuman: true, autoEscalate: 'Cuando el cliente necesite presentar o validar una receta médica (adjuntar foto o pasar en sucursal).' },
  { id: 'precios', name: 'Precios y existencias', enabled: true, priority: 5, escalateToHuman: false, autoEscalate: '',
    instruction: 'Cita precios SOLO si aparecen en las listas oficiales adjuntas; si no estás seguro, di que el farmacéutico confirma disponibilidad y precio. Nunca inventes cifras.' },
  { id: 'quejas', name: 'Quejas y reclamos', enabled: true, priority: 4, escalateToHuman: true, autoEscalate: 'Cliente molesto, reclamación, error de pedido o cobro incorrecto: responde empáticamente y escala a un agente humano.' },
  { id: 'pagos', name: 'Pagos, facturas y devoluciones', enabled: true, priority: 6, escalateToHuman: true, autoEscalate: 'Temas de pagos electrónicos, facturas electrónicas, notas de crédito o devoluciones monetarias.' },
  { id: 'human_handoff', name: 'Solicitud de humano', enabled: true, priority: 2, escalateToHuman: true, autoEscalate: 'Si el cliente pide hablar con una persona (\"humano\", \"agente\", \"farmacéutico\", \"encargado\") o lo repite 2 veces, escala de inmediato.' },
  { id: 'fuera_scope', name: 'Fuera de alcance', enabled: true, priority: 8, escalateToHuman: false, autoEscalate: '',
    instruction: 'Si el tema no tiene relación con la farmacia, redirige amablemente; tras 2 desvíos ofrece derivar a un humano.' },
];

const DEFAULT_MAP = {
  entry: 'inicio',
  states: [
    { id: 'saludo', label: 'Saludo / Menú principal', type: 'start',
      actions: ['Mostrar menú numerado', 'Detectar saludo o agradecimiento'],
      transitions: [
        { on: 'opción 1-5 del menú', to: 'triage' },
        { on: 'mensaje libre', to: 'triage', note: 'Clasificar intención y guiar al menú' },
      ] },
    { id: 'triage', label: 'Menú · Sucursal · Contexto', type: 'flow',
      actions: ['Registrar opción elegida', 'Preguntar sucursal (1 o 2)', 'Guardar contexto rama/motivo'],
      transitions: [{ on: 'sucursal elegida', to: 'conversacion' }] },
    { id: 'conversacion', label: 'Conversación con IA', type: 'ai',
      actions: ['Responder usando base de conocimiento', 'Aplicar políticas obligatorias', 'Hacer UNA pregunta aclaratoria si falta un dato clave'],
      transitions: [
        { on: 'tema resuelto', to: 'cierre' },
        { on: 'disparador de política con escalateToHuman', to: 'escalamiento' },
        { on: '2 malentendidos seguidos', to: 'escalamiento' },
      ] },
    { id: 'escalamiento', label: 'Traspaso a humano', type: 'escalation',
      actions: ['Confirmar al cliente que un humano continuará', 'Pausar el bot para ese número (botPaused)', 'Notificar al agente en la bandeja'],
      transitions: [{ on: 'humano reactiva el bot', to: 'conversacion' }] },
    { id: 'cierre', label: 'Cierre', type: 'end',
      actions: ['Resumen breve', 'Agradecimiento'], transitions: [] },
  ],
};

/* ---------------- Normalización / validación ---------------- */
const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '').replace(/^\+?0{0,2}(506)?/, '').slice(-8);

const ARTICLE_TYPES = ['public', 'internal', 'snippet'];

function normalizeArticle(a = {}, i = 0, prev = {}) {
  // Los campos que no llegan en el payload se conservan del artículo previo (mismo id).
  const g = (k, d) => (a[k] !== undefined ? a[k] : prev[k] !== undefined ? prev[k] : d);
  const title = String(a.title || prev.title || `Artículo ${i + 1}`).trim().slice(0, 200);
  const kw = a.keywords !== undefined ? a.keywords : prev.keywords;
  return {
    id: a.id || prev.id || 'kb-' + Math.random().toString(36).slice(2, 9),
    title,
    content: String(g('content', '')).trim().slice(0, 4000),
    keywords: Array.isArray(kw) ? kw.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 15)
      : title.toLowerCase().split(/[^a-z0-9áéíóúñ]+/).filter((w) => w.length > 3).slice(0, 8),
    category: g('category', 'general') || 'general',
    enabled: g('enabled', true) !== false,
    type: ARTICLE_TYPES.includes(g('type')) ? g('type') : 'public',
    state: g('state') === 'draft' ? 'draft' : 'live',
    validFrom: g('validFrom', null) || null,
    validTo: g('validTo', null) || null,
    used: Number(g('used', 0)) || 0,
    updatedAt: a.updatedAt || prev.updatedAt || null,
  };
}

/** ¿El artículo puede usarse AHORA? (publicado + dentro de su ventana de vigencia). */
function isActive(a, now = Date.now()) {
  if (!a || a.enabled === false || a.state === 'draft') return false;
  if (a.validFrom && now < Date.parse(a.validFrom)) return false;
  if (a.validTo && now > Date.parse(a.validTo) + 86399999) return false; // incluye todo el día final
  return true;
}

function normalizePolicy(p = {}) {
  return {
    id: p.id || 'pol-' + Math.random().toString(36).slice(2, 9),
    name: String(p.name || 'Regla').slice(0, 120),
    enabled: p.enabled !== false,
    priority: Number.isFinite(+p.priority) ? +p.priority : 10,
    escalateToHuman: !!p.escalateToHuman,
    autoEscalate: String(p.autoEscalate || '').slice(0, 500),
    instruction: String(p.instruction || '').slice(0, 1000),
  };
}

function validateMap(map) {
  if (!map || !Array.isArray(map.states) || !map.states.length) throw new Error('knowledge.map: se requiere al menos un estado');
  const ids = new Set(map.states.map((s) => s.id));
  if (!ids.has(map.entry)) throw new Error(`knowledge.map: entry "${map.entry}" no corresponde a ningún estado`);
  for (const s of map.states) {
    for (const t of s.transitions || []) {
      if (!ids.has(t.to)) throw new Error(`knowledge.map: transición "${s.id}→${t.to}" apunta a un estado inexistente`);
    }
  }
  return map;
}

/** Valida y normaliza un payload completo {articles?, policies?, map?}. */
function normalizePayload(input = {}) {
  const out = {};
  if (input.articles) {
    if (!Array.isArray(input.articles)) throw new Error('knowledge.articles debe ser un arreglo');
    out.articles = input.articles.slice(0, 300).map((a, i) => normalizeArticle(a, i, kb.articles.find((x) => x.id === a.id) || {}));
  }
  if (input.policies) {
    if (!Array.isArray(input.policies)) throw new Error('knowledge.policies debe ser un arreglo');
    out.policies = input.policies.slice(0, 40).map(normalizePolicy);
  }
  if (input.map) out.map = validateMap(input.map);
  return out;
}

/* ---------------- API pública ---------------- */
function getKnowledge() {
  return {
    articles: kb.articles,
    policies: kb.policies || DEFAULT_POLICIES,
    map: kb.map || DEFAULT_MAP,
    isDefault: !kb.policies && !kb.map && !kb.articles.length,
    updatedAt: kb.updatedAt,
  };
}

function setKnowledge(patch) {
  const clean = normalizePayload(patch);
  kb = { ...kb, ...clean, updatedAt: new Date().toISOString() };
  schedulePersist();
  log.info(`[knowledge] actualizada: ${clean.articles ? clean.articles.length + ' artículos; ' : ''}${clean.policies ? clean.policies.length + ' políticas; ' : ''}${clean.map ? 'mapa de flujo; ' : ''}`);
  return getKnowledge();
}

/* ---------------- CRUD por artículo (panel de entrenamiento) ---------------- */
function addArticle(input) {
  const art = normalizeArticle({ ...input, id: undefined }, kb.articles.length);
  art.updatedAt = new Date().toISOString();
  kb = { ...kb, articles: [...kb.articles, art], updatedAt: art.updatedAt };
  schedulePersist();
  return art;
}
function updateArticle(id, patch) {
  const prev = kb.articles.find((x) => x.id === id);
  if (!prev) return null;
  const art = normalizeArticle({ ...patch, id }, 0, prev);
  art.updatedAt = new Date().toISOString();
  art.used = prev.used; // el contador de uso no se edita a mano
  kb = { ...kb, articles: kb.articles.map((x) => (x.id === id ? art : x)), updatedAt: art.updatedAt };
  schedulePersist();
  return art;
}
function removeArticle(id) {
  const prev = kb.articles.find((x) => x.id === id);
  if (!prev) return null;
  kb = { ...kb, articles: kb.articles.filter((x) => x.id !== id), updatedAt: new Date().toISOString() };
  schedulePersist();
  return prev;
}
/** Cuenta cuántas veces se usó cada artículo para responder (métrica "Reports" de Fin). */
function markUsed(ids = []) {
  let n = 0;
  for (const a of kb.articles) if (ids.includes(a.id)) { a.used = (a.used || 0) + 1; n++; }
  if (n) schedulePersist();
}

/* ---------------- Recuperación ligera (RAG sin embeddings) ---------------- */
/**
 * Busca los artículos más relevantes para un mensaje por coincidencia de
 * keywords/título (score). Costo O(n·palabras) sobre ≤100 fichas: suficiente
 * y evita depender de librerías pesadas. Devuelve fragmentos listos para
 * adjuntar al prompt (top_k).
 */
function retrieve(message, { topK = 3, minScore = 1 } = {}) {
  const q = String(message || '').toLowerCase();
  const words = q.split(/[^a-z0-9áéíóúñ]+/).filter((w) => w.length >= 4);
  const scored = [];
  for (const a of kb.articles) {
    if (!isActive(a) || !a.content) continue;
    let score = 0;
    for (const k of a.keywords) if (k && q.includes(k)) score += 2;
    for (const w of words) if (a.title.toLowerCase().includes(w) || a.content.toLowerCase().includes(w)) score += 1;
    if (score >= minScore) scored.push({ article: a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, topK).map(({ article: a, score }) => ({
    id: a.id, title: a.title, category: a.category, score,
    excerpt: a.content.length > 700 ? a.content.slice(0, 700) + '…' : a.content,
  }));
}

/* ---------------- Detección de disparadores de escalado ---------------- */
const URGENT_RE = /\b(dolor\s+de\s+pecho|infarto|no\s+puedo\s+respirar|dificultad\s+respiratoria|convulsion|sobredosis|reacci[oó]n\s+al[eé]rgica|anafilaxia|sangrado\s+(abundante|intenso|grave)|desmay|inconsciente|veneno|intoxicaci[oó]n|suicidi|herviendo|quemadura\s+grave)\b/i;
const HUMAN_RE = /\b(humano|una\s+persona|agente|asesor|encargad[oa]|farmac[eé]utic[oa]\s+(atienda|converse|hable)|hablar\s+con\s+(un|alguien)|persona\s+real|delegado)\b/i;
const COMPLAINT_RE = /\b(reclamaci[oó]n|queja|quejo|indignad[oa]|me\s+molest|p[eé]sima\s+(atenci[oó]n|servicio)|cobro\s+incorrecto|error\s+de\s+(pedido|factura)|devolver\s+mi\s+dinero|denuncia)\b/i;

/**
 * Reglas deterministas de pre-escalado (antes de gastar un token de IA):
 * urgencia, solicitud explícita de humano, queja, o 2 malentendidos seguidos.
 * Solo se evalúan las políticas del panel que tengan escalateToHuman activo.
 */
function detectEscalation(message, { policies, fsm = {} } = {}) {
  const pol = (policies || getKnowledge().policies).filter((p) => p.enabled && p.escalateToHuman);
  const has = (frag) => pol.some((p) => p.name.toLowerCase().includes(frag) || p.id.includes(frag));
  const text = String(message || '');
  if (/^\d{1,2}$/.test(text.trim())) return null; // opciones del menú: flujo normal
  if (URGENT_RE.test(text) && has('urgencia')) return { reason: 'urgencia-medica', policy: 'Urgencias médicas', notifyClient: true };
  if (HUMAN_RE.test(text) && has('humano')) return { reason: 'solicitado-por-cliente', policy: 'Solicitud de humano', notifyClient: true };
  if (COMPLAINT_RE.test(text) && has('queja')) return { reason: 'queja-reclamo', policy: 'Quejas y reclamos', notifyClient: true };
  if ((fsm.misroutes || 0) >= 2) return { reason: 'loop-malentendidos', policy: 'Umbral de traspaso', notifyClient: true };
  return null;
}

/* ---------------- Serialización para el prompt ---------------- */
function policiesToPromptText(policies) {
  const active = policies.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
  if (!active.length) return '(sin políticas activas)';
  return active.map((p, i) => {
    const head = `${i + 1}. [${p.name}] PRIORIDAD ${p.priority}`;
    if (p.escalateToHuman) return `${head} → ESCALAR A HUMANO cuando: ${p.autoEscalate || p.instruction || p.name}`;
    return `${head} → ${p.instruction}`;
  }).join('\n');
}

function mapToPromptText(map) {
  const lines = (map.states || []).map((s) => {
    const acts = s.actions && s.actions.length ? ` · hace: ${s.actions.join('; ')}` : '';
    const trans = (s.transitions || []).map((t) => `si ${t.on} → ${t.to}${t.note ? ` (${t.note})` : ''}`).join(' | ');
    return `- ESTADO ${s.id}${s.id === map.entry ? ' (INICIO)' : ''}: ${s.label}${acts}${trans ? `\n  transiciones: ${trans}` : ''}`;
  });
  return lines.join('\n');
}

/**
 * Bloque listo para insertar en el system prompt: políticas obligatorias,
 * mapa de interacción, protocolo de traspaso y artículos recuperados.
 */
function buildKnowledgePromptPart({ message = '', history = [] } = {}) {
  const { policies, map, articles } = getKnowledge();
  const hits = retrieve(message, { topK: 3 });
  const escalationOn = policies.some((p) => p.enabled && p.escalateToHuman);
  const parts = [`\nBASE DE CONOCIMIENTO DE LA EMPRESA (${articles.length} fichas cargadas)`];
  parts.push(hits.length
    ? `HECHOS RELEVANTES PARA ESTA PREGUNTA (cítalos textualmente, no los contradigas):\n${hits.map((h) => `• ${h.title}: ${h.excerpt}`).join('\n')}`
    : 'No hay fichas relevantes para esta pregunta: NO inventes datos de la empresa.');
  parts.push(`POLÍTICAS ACTIVAS (OBLIGATORIAS, orden de prioridad):\n${policiesToPromptText(policies)}`);
  parts.push(`MAPA DE INTERACCIÓN (síguelo; define cuándo escalar):\n${mapToPromptText(map)}`);
  if (escalationOn) {
    parts.push('PROTOCOLO DE TRASPASO A HUMANO: cuando una política exija escalar, termina TU respuesta con exactamente el token [[ESCALAR_HUMANO]] (se lo explicaste antes al cliente de forma natural; el token es invisible para él). No lo uses fuera de los casos del mapa.');
  }
  return parts.join('\n\n');
}

/* ---------------- Persistencia en disco ---------------- */
let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(kb, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      log.warn('[knowledge] no se pudo persistir:', err.message);
    }
  }, 300);
  if (persistTimer.unref) persistTimer.unref();
}

(function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    kb = { articles: (data.articles || []).map((a, i) => normalizeArticle(a, i)), policies: data.policies || null, map: data.map || null, updatedAt: data.updatedAt || null };
    log.info(`[knowledge] ${kb.articles.length} artículos restaurados desde disco`);
  } catch (err) {
    log.warn('[knowledge] snapshot ilegible, se inicia vacío:', err.message);
  }
})();

module.exports = {
  getKnowledge, setKnowledge, addArticle, updateArticle, removeArticle, markUsed, isActive, normalizePayload, validateMap,
  retrieve, detectEscalation, buildKnowledgePromptPart,
  policiesToPromptText, mapToPromptText, normPhone,
  DEFAULT_POLICIES, DEFAULT_MAP,
  __test: { reset: () => { kb = { articles: [], policies: null, map: null, updatedAt: null }; } },
};
