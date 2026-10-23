'use strict';
/**
 * services/trainingService.js — Módulos "tipo Fin AI Agent" que el dueño enseña desde el panel.
 *
 *  Guidance        → reglas de comportamiento en lenguaje natural (+ tono y longitud globales).
 *  Intents         → clasificador de intención (equivale a "Attributes" de Fin). Determinista.
 *  Escalation rules→ traspaso a humano por CONDICIÓN (código, no modelo).
 *  Safety guard    → temas sensibles: respuesta fija + traspaso. Siempre activo.
 *  Procedures      → flujos paso a paso con preguntas, ramas (si/sino) y traspaso con resumen.
 *  Tests           → banco de preguntas para regresión (lo corre services/testRunner.js).
 *  Recommendations → huecos de conocimiento detectados en conversaciones reales.
 *  Analytics       → eventos por conversación para métricas.
 *  Changelog       → auditoría de cada cambio.
 *
 * Principio (de la guía de Fin): lo determinista se programa como código; lo interpretado
 * se deja al modelo con límites. Persistencia: un JSON con escritura atómica (como store.js).
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../utils/logger');
const kb = require('./knowledgeService');

const FILE = path.join(config.dataDir, 'training.json');
const MAX_EVENTS = 3000;
const MAX_LOG = 500;
const MAX_TEST_QUESTIONS = 50; // mismo límite que los grupos de Test de Fin

const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 9);
/** minúsculas, sin tildes, sin espacios sobrantes: base de toda comparación de texto. */
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const isoDay = (v) => (v && !Number.isNaN(Date.parse(v)) ? String(v).slice(0, 10) : null);

/* ======================= Estado + seeds ======================= */
const DEFAULT_INTENTS = [
  { id: 'precio_disponibilidad', name: 'Precio o disponibilidad', description: 'Pregunta si hay un producto o cuánto cuesta.', keywords: ['precio', 'cuanto cuesta', 'cuanto vale', 'cuanto sale', 'tienen', 'hay ', 'disponible', 'existencia', 'stock'] },
  { id: 'horarios_sucursales', name: 'Horarios y sucursales', description: 'Horarios de atención o dirección de las sucursales.', keywords: ['horario', 'abren', 'cierran', 'atienden', 'direccion', 'donde estan', 'ubicacion', 'sucursal', 'como llego'] },
  { id: 'envio_domicilio', name: 'Envío a domicilio', description: 'Quiere que le lleven el pedido.', keywords: ['envio', 'domicilio', 'delivery', 'a mi casa', 'llevan', 'traen'] },
  { id: 'receta', name: 'Receta médica', description: 'Receta, antibióticos o medicamentos controlados.', keywords: ['receta', 'recetado', 'prescripcion', 'antibiotico', 'controlado'] },
  { id: 'consulta_medicamento', name: 'Consulta de medicamento', description: 'Para qué sirve, efectos, cómo tomarlo.', keywords: ['para que sirve', 'sirve para', 'dosis', 'cada cuantas horas', 'efecto', 'efectos', 'pastilla', 'jarabe', 'medicamento', 'contraindic'] },
  { id: 'pagos', name: 'Pagos y facturas', description: 'SINPE, tarjeta, factura electrónica, devoluciones.', keywords: ['sinpe', 'tarjeta', 'factura', 'pago', 'pagar', 'devolucion', 'reembolso', 'cobro'] },
  { id: 'queja', name: 'Queja o reclamo', description: 'Cliente molesto o con un problema con el servicio.', keywords: ['queja', 'reclamo', 'reclamacion', 'molest', 'pesimo', 'mal servicio', 'error en mi pedido', 'cobro incorrecto'] },
];

const SCRIPT_DOMICILIO = `# Ejemplo de procedimiento (borrador): pedido a domicilio
preguntar producto: ¿Qué producto necesita? Indíqueme el nombre y la cantidad.
preguntar direccion: ¿A qué dirección se lo llevamos? (distrito y señas)
si producto contiene receta -> con_receta | sino -> sin_receta
etiqueta: con_receta
decir: Ese producto requiere receta. El farmacéutico la validará antes de enviarlo.
traspasar: Perfecto, le paso con un farmacéutico para confirmar su pedido de {{producto}} a {{direccion}}. 💙
etiqueta: sin_receta
traspasar: Listo, anoté {{producto}} para entregar en {{direccion}}. Un compañero confirmará precio y tiempo de entrega. 💙`;

function seed() {
  const procedure = { id: 'seed-pedido-domicilio', name: 'Pedido a domicilio', state: 'draft', keywords: ['pedido a domicilio', 'quiero que me lo traigan', 'enviar a mi casa'], intent: 'envio_domicilio', script: SCRIPT_DOMICILIO, stats: { started: 0, completed: 0, handoffs: 0 }, updatedAt: null };
  procedure.steps = parseScript(procedure.script).steps;
  return {
    guidance: {
      basics: { tone: 'friendly', length: 'standard' },
      rules: [
        { id: 'seed-g1', category: 'context', title: 'Preguntar para quién es', text: 'Cuando el cliente pregunte por un medicamento sin decir para quién es, pregunta si es para un adulto, un niño o un adulto mayor antes de dar más detalles.', state: 'draft', validFrom: null, validTo: null },
        { id: 'seed-g2', category: 'communication', title: 'Evitar tecnicismos', text: 'Usa palabras sencillas. Si debes usar un término médico, explícalo entre paréntesis.', state: 'draft', validFrom: null, validTo: null },
      ],
    },
    intents: DEFAULT_INTENTS,
    escalationRules: [
      { id: 'seed-e1', name: 'Pagos y devoluciones', enabled: false, intent: 'pagos', keywords: [], misroutes: 0, message: '', used: 0 },
      { id: 'seed-e2', name: 'Insistencia sin respuesta (3 malentendidos)', enabled: false, intent: '', keywords: [], misroutes: 3, message: '', used: 0 },
    ],
    procedures: [procedure],
    testGroups: [{
      id: 'seed-t1', name: 'Preguntas base',
      questions: [
        { id: 'q1', q: '¿Cuál es el horario de atención?', expect: ['sábado'], expectOutcome: '', rating: null, note: '', last: null },
        { id: 'q2', q: '¿Hacen envíos a domicilio?', expect: [], expectOutcome: '', rating: null, note: '', last: null },
        { id: 'q3', q: '¿Para qué sirve el acetaminofén?', expect: [], expectOutcome: '', rating: null, note: '', last: null },
        { id: 'q4', q: 'Tengo dolor de pecho y me falta el aire', expect: [], expectOutcome: 'escalado', rating: null, note: '', last: null },
        { id: 'q5', q: 'Quiero hablar con una persona', expect: [], expectOutcome: 'escalado', rating: null, note: '', last: null },
        { id: 'q6', q: '¿Cuánto me da de dosis de ibuprofeno para mi hijo?', expect: ['farmac'], expectOutcome: '', rating: null, note: '', last: null },
      ],
    }],
    recommendations: [],
    changelog: [],
    events: [],
  };
}

let state = null;

/* ======================= Persistencia ======================= */
let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeSnapshot, 300);
  if (persistTimer.unref) persistTimer.unref();
}
function writeSnapshot() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    log.warn('[training] no se pudo persistir:', err.message);
  }
}
(function load() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = { ...seed(), ...data };
      state.guidance = { basics: { ...seed().guidance.basics, ...(data.guidance?.basics || {}) }, rules: data.guidance?.rules || [] };
      log.info(`[training] restaurado: ${state.guidance.rules.length} guidance, ${state.procedures.length} procedimientos, ${state.testGroups.length} grupos de test`);
      return;
    }
  } catch (err) {
    log.warn('[training] snapshot ilegible, se inicia con valores de ejemplo:', err.message);
  }
  state = seed();
  schedulePersist(); // los ids de ejemplo quedan fijos entre reinicios
})();

/* ======================= Changelog ======================= */
function logChange(area, action, item) {
  state.changelog.unshift({ ts: new Date().toISOString(), area, action, item: String(item || '').slice(0, 120), author: 'panel' });
  if (state.changelog.length > MAX_LOG) state.changelog.length = MAX_LOG;
  schedulePersist();
}
const getChangelog = ({ limit = 100 } = {}) => state.changelog.slice(0, limit);

/** Vigencia de reglas y artículos: publicado + dentro de su ventana de fechas. */
const activeNow = (r, now = Date.now()) => r.state === 'live'
  && !(r.validFrom && now < Date.parse(r.validFrom))
  && !(r.validTo && now > Date.parse(r.validTo) + 86399999);

/* ======================= Guidance ======================= */
const GUIDANCE_CATEGORIES = ['communication', 'context', 'content', 'spam', 'other'];
const TONES = { friendly: 'cálido y cercano', neutral: 'neutral', professional: 'profesional y formal', direct: 'directo y al grano', humorous: 'amable con toques de humor ligero' };
const LENGTHS = { concise: 'Máximo 2 o 3 líneas', standard: 'Máximo 5 líneas', thorough: 'Hasta 8 líneas, con más detalle cuando ayude' };

const getGuidance = () => state.guidance;

function setBasics({ tone, length } = {}) {
  if (tone !== undefined && !TONES[tone]) throw new Error(`tone inválido (${Object.keys(TONES).join(', ')})`);
  if (length !== undefined && !LENGTHS[length]) throw new Error(`length inválido (${Object.keys(LENGTHS).join(', ')})`);
  state.guidance.basics = { ...state.guidance.basics, ...(tone ? { tone } : {}), ...(length ? { length } : {}) };
  logChange('guidance', 'basics', `${state.guidance.basics.tone} / ${state.guidance.basics.length}`);
  return state.guidance.basics;
}

function normalizeGuidanceRule(r = {}, prev = {}) {
  const text = String(r.text ?? prev.text ?? '').trim().slice(0, 1200);
  if (!text) throw new Error('La instrucción no puede estar vacía');
  return {
    id: prev.id || uid('g'),
    category: GUIDANCE_CATEGORIES.includes(r.category ?? prev.category) ? (r.category ?? prev.category) : 'other',
    title: String(r.title ?? prev.title ?? text.slice(0, 50)).trim().slice(0, 120),
    text,
    state: ['live', 'draft', 'paused'].includes(r.state ?? prev.state) ? (r.state ?? prev.state) : 'draft',
    validFrom: isoDay(r.validFrom !== undefined ? r.validFrom : prev.validFrom),
    validTo: isoDay(r.validTo !== undefined ? r.validTo : prev.validTo),
  };
}

function upsertGuidanceRule(input) {
  const rules = state.guidance.rules;
  const prev = input.id ? rules.find((x) => x.id === input.id) : null;
  if (input.id && !prev) return null;
  const rule = normalizeGuidanceRule(input, prev || {});
  if (prev) rules[rules.indexOf(prev)] = rule; else rules.push(rule);
  logChange('guidance', prev ? (prev.state !== rule.state ? `estado ${prev.state}→${rule.state}` : 'editada') : 'creada', rule.title);
  return rule;
}
function removeGuidanceRule(id) {
  const prev = state.guidance.rules.find((x) => x.id === id);
  if (!prev) return null;
  state.guidance.rules = state.guidance.rules.filter((x) => x.id !== id);
  logChange('guidance', 'eliminada', prev.title);
  return prev;
}

/** Líneas de ESTILO derivadas de los ajustes globales (tono + longitud). */
function basicsPromptLines() {
  const b = state.guidance.basics;
  return `- Tono de voz: ${TONES[b.tone]}.\n- Longitud: ${LENGTHS[b.length]}.`;
}
/** Bloque de reglas de Guidance vigentes para el system prompt. */
function guidancePromptPart() {
  const live = state.guidance.rules.filter((r) => activeNow(r));
  if (!live.length) return '';
  return '\n\nGUIDANCE DEL DUEÑO (instrucciones de comportamiento adicionales; síguelas siempre que no contradigan las políticas ni la seguridad):\n'
    + live.map((r) => `- [${r.category}] ${r.text}`).join('\n');
}

/* ======================= Intenciones (Attributes) ======================= */
const getIntents = () => state.intents;

function setIntents(list) {
  if (!Array.isArray(list)) throw new Error('intents debe ser un arreglo');
  state.intents = list.slice(0, 40).map((i) => ({
    id: String(i.id || norm(i.name).replace(/[^a-z0-9]+/g, '_') || uid('int')).slice(0, 40),
    name: String(i.name || i.id || 'Intención').slice(0, 80),
    description: String(i.description || '').slice(0, 300),
    keywords: toList(i.keywords).map((k) => norm(k)).concat(),
  }));
  logChange('intents', 'actualizadas', `${state.intents.length} intenciones`);
  return state.intents;
}

/** Clasifica el mensaje por coincidencia de palabras clave; gana la intención con más coincidencias. */
function classifyIntent(text) {
  const t = ' ' + norm(text) + ' ';
  let best = 'otro', bestScore = 0;
  for (const i of state.intents) {
    let score = 0;
    for (const k of i.keywords) if (k && t.includes(k.length < 5 ? ' ' + k.trim() : k)) score += k.split(' ').length;
    if (score > bestScore) { best = i.id; bestScore = score; }
  }
  return best;
}

/* ======================= Safety Guard ======================= */
const SAFETY = [
  { id: 'autolesion', re: /\b(suicid\w*|quitarme la vida|quiero morir|matarme|hacerme dano|autolesi\w*|no quiero vivir)\b/,
    message: 'Lamento mucho lo que está pasando 💙. No está solo/a. Si está en peligro inmediato, llame ya al *911*. Le paso con una persona de nuestro equipo para acompañarle.' },
  { id: 'abuso', re: /\b(abuso sexual|abus\w+ (de|a) (un |una |mi )?(nino|nina|menor)|maltrato infantil|violacion|me violaron|me estan golpeando)\b/,
    message: 'Siento mucho lo que cuenta 💙. Si usted o alguien corre peligro, llame de inmediato al *911*. Voy a pasar su mensaje a una persona de nuestro equipo.' },
];
/** @returns {{id:string,message:string}|null} */
function checkSafety(text) {
  const t = norm(text);
  const hit = SAFETY.find((s) => s.re.test(t));
  return hit ? { id: hit.id, message: hit.message } : null;
}

/* ======================= Reglas de escalado deterministas ======================= */
const getEscalationRules = () => state.escalationRules;

function normalizeEscRule(r = {}, prev = {}) {
  const pick = (k, d) => (r[k] !== undefined ? r[k] : prev[k] !== undefined ? prev[k] : d);
  const rule = {
    id: prev.id || uid('esc'),
    name: String(pick('name', '')).trim().slice(0, 120),
    enabled: pick('enabled', true) !== false,
    intent: String(pick('intent', '')).trim(),
    keywords: toList(pick('keywords', [])).slice(0, 20),
    misroutes: Math.max(0, parseInt(pick('misroutes', 0), 10) || 0),
    message: String(pick('message', '')).trim().slice(0, 500),
    used: prev.used || 0,
  };
  if (!rule.name) throw new Error('La regla necesita un nombre');
  if (!rule.intent && !rule.keywords.length && !rule.misroutes) throw new Error('Defina al menos una condición (intención, palabras clave o malentendidos)');
  if (rule.intent && !state.intents.some((i) => i.id === rule.intent)) throw new Error(`La intención "${rule.intent}" no existe`);
  return rule;
}
function upsertEscalationRule(input) {
  const prev = input.id ? state.escalationRules.find((x) => x.id === input.id) : null;
  if (input.id && !prev) return null;
  const rule = normalizeEscRule(input, prev || {});
  if (prev) state.escalationRules[state.escalationRules.indexOf(prev)] = rule; else state.escalationRules.push(rule);
  logChange('escalado', prev ? (prev.enabled !== rule.enabled ? (rule.enabled ? 'activada' : 'desactivada') : 'editada') : 'creada', rule.name);
  return rule;
}
function removeEscalationRule(id) {
  const prev = state.escalationRules.find((x) => x.id === id);
  if (!prev) return null;
  state.escalationRules = state.escalationRules.filter((x) => x.id !== id);
  logChange('escalado', 'eliminada', prev.name);
  return prev;
}
/** "cuando + Fin hará": TODAS las condiciones definidas deben cumplirse. El código decide, no el modelo. */
function evaluateRules(text, { intent = 'otro', misroutes = 0 } = {}) {
  const t = norm(text);
  for (const r of state.escalationRules) {
    if (!r.enabled) continue;
    if (r.intent && r.intent !== intent) continue;
    if (r.keywords.length && !r.keywords.some((k) => t.includes(norm(k)))) continue;
    if (r.misroutes && misroutes < r.misroutes) continue;
    r.used = (r.used || 0) + 1;
    schedulePersist();
    return { reason: 'regla-' + r.id, policy: r.name, message: r.message || null };
  }
  return null;
}

/* ======================= Procedures ======================= */
/**
 * Lenguaje de pasos (una línea = un paso):
 *   decir: texto                         preguntar variable: texto
 *   si variable contiene|es|existe valor -> etiqueta [| sino -> etiqueta]
 *   etiqueta: nombre     ir a: nombre    traspasar: texto     fin: texto
 * Los textos admiten {{variable}}. Las líneas que empiezan con # son comentarios.
 */
function parseScript(script) {
  const steps = [], errors = [];
  String(script || '').split('\n').forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = line.match(/^decir\s*:\s*(.+)$/i))) steps.push({ type: 'say', text: m[1] });
    else if ((m = line.match(/^preguntar\s+(\w+)\s*:\s*(.+)$/i))) steps.push({ type: 'ask', saveAs: m[1], text: m[2] });
    else if ((m = line.match(/^etiqueta\s*:\s*(\w+)$/i))) steps.push({ type: 'label', id: m[1] });
    else if ((m = line.match(/^ir\s+a\s*:?\s*(\w+)$/i))) steps.push({ type: 'goto', to: m[1] });
    else if ((m = line.match(/^si\s+(\w+)\s+(contiene|es|existe)\s*(.*?)\s*->\s*(\w+)(?:\s*\|\s*sino\s*->\s*(\w+))?$/i))) steps.push({ type: 'if', var: m[1], op: m[2].toLowerCase(), value: m[3], then: m[4], else: m[5] || null });
    else if ((m = line.match(/^traspasar\s*:\s*(.+)$/i))) steps.push({ type: 'handoff', text: m[1] });
    else if ((m = line.match(/^fin\s*:\s*(.+)$/i))) steps.push({ type: 'end', text: m[1] });
    else errors.push(`Línea ${n + 1}: no se entiende «${line.slice(0, 60)}»`);
  });
  const labels = new Set(steps.filter((s) => s.type === 'label').map((s) => s.id));
  for (const s of steps) for (const k of ['then', 'else', 'to']) if (s[k] && !labels.has(s[k])) errors.push(`La etiqueta «${s[k]}» no existe`);
  if (!steps.length && !errors.length) errors.push('El procedimiento no tiene pasos');
  return { steps, errors };
}

const fill = (text, data) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (data[k] !== undefined ? data[k] : ''));

/** Ejecuta pasos desde `i` hasta pedir un dato, traspasar o terminar. Función pura (no toca el estado). */
function runSteps(steps, data, i) {
  const out = [];
  const at = (label) => { const x = steps.findIndex((s) => s.type === 'label' && s.id === label); return x < 0 ? steps.length : x; };
  for (let guard = 0; i < steps.length && guard < 200; guard++) {
    const s = steps[i];
    if (s.type === 'say') { out.push(fill(s.text, data)); i++; }
    else if (s.type === 'ask') { out.push(fill(s.text, data)); return { out, i, waiting: true, done: null }; }
    else if (s.type === 'label') i++;
    else if (s.type === 'goto') i = at(s.to);
    else if (s.type === 'if') {
      const v = String(data[s.var] || '');
      const ok = s.op === 'existe' ? !!v.trim() : s.op === 'es' ? norm(v) === norm(s.value) : norm(v).includes(norm(s.value));
      const target = ok ? s.then : s.else;
      i = target ? at(target) : i + 1;
    } else if (s.type === 'handoff') { out.push(fill(s.text, data)); return { out, i: i + 1, waiting: false, done: 'handoff' }; }
    else if (s.type === 'end') { out.push(fill(s.text, data)); return { out, i: i + 1, waiting: false, done: 'end' }; }
    else i++;
  }
  return { out, i, waiting: false, done: 'end' };
}

function startProcedure(proc) {
  const r = runSteps(proc.steps, {}, 0);
  return { ...r, data: {} };
}
/** Guarda la respuesta del cliente en la variable del paso `ask` actual y continúa. */
function continueProcedure(proc, cur, text) {
  const step = proc.steps[cur.i];
  const data = { ...cur.data };
  if (step && step.type === 'ask') data[step.saveAs] = String(text).trim().slice(0, 300);
  const r = runSteps(proc.steps, data, cur.i + 1);
  return { ...r, data };
}
const getProcedure = (id) => state.procedures.find((p) => p.id === id) || null;
const listProcedures = () => state.procedures;

function procStat(id, key) {
  const p = getProcedure(id);
  if (p) { p.stats[key] = (p.stats[key] || 0) + 1; schedulePersist(); }
}
/** Primer procedimiento publicado cuyo disparador coincide (palabras clave o intención). */
function findProcedure(text, intent) {
  const t = norm(text);
  return state.procedures.find((p) => p.state === 'live'
    && ((p.keywords || []).some((k) => k && t.includes(norm(k))) || (p.intent && p.intent === intent))) || null;
}

function upsertProcedure(input) {
  const prev = input.id ? state.procedures.find((x) => x.id === input.id) : null;
  if (input.id && !prev) return null;
  const pick = (k, d) => (input[k] !== undefined ? input[k] : prev && prev[k] !== undefined ? prev[k] : d);
  const name = String(pick('name', '')).trim().slice(0, 120);
  if (!name) throw new Error('El procedimiento necesita un nombre');
  const script = String(pick('script', ''));
  const { steps, errors } = parseScript(script);
  if (errors.length) throw new Error(errors.join(' · '));
  const intent = String(pick('intent', '')).trim();
  if (intent && !state.intents.some((i) => i.id === intent)) throw new Error(`La intención "${intent}" no existe`);
  const keywords = toList(pick('keywords', []));
  const st = ['live', 'draft', 'paused'].includes(pick('state', 'draft')) ? pick('state', 'draft') : 'draft';
  if (st === 'live' && !keywords.length && !intent) throw new Error('Para publicarlo defina un disparador (palabras clave o intención)');
  const proc = { id: prev ? prev.id : uid('proc'), name, state: st, keywords, intent, script, steps, stats: prev ? prev.stats : { started: 0, completed: 0, handoffs: 0 }, updatedAt: new Date().toISOString() };
  if (prev) state.procedures[state.procedures.indexOf(prev)] = proc; else state.procedures.push(proc);
  logChange('procedimientos', prev ? (prev.state !== proc.state ? `estado ${prev.state}→${proc.state}` : 'editado') : 'creado', proc.name);
  return proc;
}
function removeProcedure(id) {
  const prev = getProcedure(id);
  if (!prev) return null;
  state.procedures = state.procedures.filter((x) => x.id !== id);
  logChange('procedimientos', 'eliminado', prev.name);
  return prev;
}
/** Simula un procedimiento con respuestas de ejemplo, sin tocar ninguna conversación. */
function previewProcedure(id, inputs = []) {
  const proc = getProcedure(id);
  if (!proc) return null;
  const transcript = [];
  let cur = startProcedure(proc);
  cur.out.forEach((t) => transcript.push({ from: 'bot', text: t }));
  const answers = [...inputs];
  while (cur.waiting) {
    if (!answers.length) { transcript.push({ from: 'sistema', text: '(esperando respuesta del cliente…)' }); break; }
    const a = answers.shift();
    transcript.push({ from: 'cliente', text: a });
    cur = continueProcedure(proc, cur, a);
    cur.out.forEach((t) => transcript.push({ from: 'bot', text: t }));
  }
  if (cur.done) transcript.push({ from: 'sistema', text: cur.done === 'handoff' ? '➜ Se traspasa a una persona (el bot se pausa).' : '✔ Procedimiento finalizado.' });
  return { transcript, data: cur.data, done: cur.done };
}

/* ======================= Banco de pruebas (datos) ======================= */
const getTestGroups = () => state.testGroups;
const getTestGroup = (id) => state.testGroups.find((g) => g.id === id) || null;

function createTestGroup(name) {
  const g = { id: uid('tg'), name: String(name || 'Grupo nuevo').trim().slice(0, 80), questions: [] };
  state.testGroups.push(g);
  logChange('test', 'grupo creado', g.name);
  return g;
}
function removeTestGroup(id) {
  const g = getTestGroup(id);
  if (!g) return null;
  state.testGroups = state.testGroups.filter((x) => x.id !== id);
  logChange('test', 'grupo eliminado', g.name);
  return g;
}
function upsertQuestion(groupId, input) {
  const g = getTestGroup(groupId);
  if (!g) return null;
  const prev = input.id ? g.questions.find((x) => x.id === input.id) : null;
  if (input.id && !prev) return null;
  if (!prev && g.questions.length >= MAX_TEST_QUESTIONS) throw new Error(`Máximo ${MAX_TEST_QUESTIONS} preguntas por grupo`);
  const pick = (k, d) => (input[k] !== undefined ? input[k] : prev && prev[k] !== undefined ? prev[k] : d);
  const q = String(pick('q', '')).trim().slice(0, 500);
  if (!q) throw new Error('La pregunta no puede estar vacía');
  const rating = pick('rating', null);
  const question = {
    id: prev ? prev.id : uid('q'), q,
    expect: toList(pick('expect', [])),
    expectOutcome: ['', 'escalado', 'procedimiento', 'ia'].includes(pick('expectOutcome', '')) ? pick('expectOutcome', '') : '',
    rating: ['good', 'acceptable', 'poor'].includes(rating) ? rating : null,
    note: String(pick('note', '')).slice(0, 500),
    last: prev ? prev.last : null,
  };
  if (prev) g.questions[g.questions.indexOf(prev)] = question; else g.questions.push(question);
  schedulePersist();
  return question;
}
function removeQuestion(groupId, qid) {
  const g = getTestGroup(groupId);
  if (!g) return null;
  const prev = g.questions.find((x) => x.id === qid);
  if (!prev) return null;
  g.questions = g.questions.filter((x) => x.id !== qid);
  schedulePersist();
  return prev;
}
function saveResult(groupId, qid, last) {
  const q = getTestGroup(groupId)?.questions.find((x) => x.id === qid);
  if (!q) return null;
  q.last = last;
  schedulePersist();
  return q;
}

/* ======================= Recomendaciones (huecos de conocimiento) ======================= */
const gapKey = (q) => norm(q).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').slice(0, 120);

/** Registra una pregunta que el bot no supo resolver. Preguntas iguales se agrupan y suman. */
function noteGap({ question, reason = 'sin-respuesta', intent = 'otro' }) {
  const key = gapKey(question);
  if (key.length < 6) return null;
  let rec = state.recommendations.find((r) => r.key === key && r.status === 'open');
  if (!rec) {
    rec = { id: uid('rec'), key, type: 'content_gap', question: String(question).trim().slice(0, 300), intent, reason, count: 0, examples: [], status: 'open', createdAt: new Date().toISOString() };
    state.recommendations.push(rec);
  }
  rec.count++;
  rec.lastAt = new Date().toISOString();
  if (rec.examples.length < 5 && !rec.examples.includes(String(question).trim())) rec.examples.push(String(question).trim().slice(0, 300));
  schedulePersist();
  return rec;
}
const listRecommendations = ({ status = 'open' } = {}) => state.recommendations
  .filter((r) => !status || r.status === status).sort((a, b) => b.count - a.count);

/** "Add": convierte la recomendación en un artículo (publicado si trae contenido). */
function acceptRecommendation(id, { title, content, keywords, type = 'snippet', publish = true } = {}) {
  const rec = state.recommendations.find((r) => r.id === id);
  if (!rec) return null;
  if (!String(content || '').trim()) throw new Error('Escriba la respuesta correcta antes de agregarla');
  const art = kb.addArticle({
    title: title || rec.question, content, type,
    keywords: keywords !== undefined ? toList(keywords) : undefined,
    state: publish ? 'live' : 'draft', category: 'aprendido',
  });
  rec.status = 'added'; rec.articleId = art.id; rec.resolvedAt = new Date().toISOString();
  logChange('recomendaciones', 'agregada como contenido', art.title);
  return { recommendation: rec, article: art };
}
function rejectRecommendation(id) {
  const rec = state.recommendations.find((r) => r.id === id);
  if (!rec) return null;
  rec.status = 'rejected'; rec.resolvedAt = new Date().toISOString();
  logChange('recomendaciones', 'rechazada', rec.question);
  return rec;
}

/* ======================= Analítica ======================= */
const AUTOMATED = new Set(['ia', 'menu', 'procedimiento', 'procedimiento-fin']);
const ESCALATED = new Set(['escalado', 'seguridad', 'procedimiento-traspaso']);

function recordEvent(ev) {
  state.events.push({ ts: Date.now(), ...ev });
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  schedulePersist();
}
function analytics({ days = 30 } = {}) {
  const since = Date.now() - days * 86400000;
  const ev = state.events.filter((e) => e.ts >= since);
  const count = (fn) => ev.filter(fn).length;
  const total = ev.length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  const tally = (key) => Object.entries(ev.reduce((a, e) => { const k = e[key] || 'otro'; a[k] = (a[k] || 0) + 1; return a; }, {}))
    .map(([k, n]) => ({ key: k, count: n })).sort((a, b) => b.count - a.count);
  const names = Object.fromEntries(state.intents.map((i) => [i.id, i.name]));
  const automated = count((e) => AUTOMATED.has(e.outcome));
  const escalated = count((e) => ESCALATED.has(e.outcome));
  const fallback = count((e) => e.outcome === 'fallback');
  return {
    days, total, automated, escalated, fallback,
    automationRate: pct(automated), escalationRate: pct(escalated), fallbackRate: pct(fallback),
    byOutcome: tally('outcome'),
    topIntents: tally('intent').slice(0, 8).map((x) => ({ ...x, name: names[x.key] || x.key })),
    openGaps: listRecommendations({ status: 'open' }).slice(0, 8).map((r) => ({ id: r.id, question: r.question, count: r.count })),
    topArticles: kb.getKnowledge().articles.filter((a) => a.used > 0).sort((a, b) => b.used - a.used).slice(0, 8).map((a) => ({ id: a.id, title: a.title, used: a.used })),
    procedures: state.procedures.map((p) => ({ id: p.id, name: p.name, state: p.state, ...p.stats })),
  };
}

function overview() {
  const k = kb.getKnowledge();
  return {
    content: { total: k.articles.length, live: k.articles.filter((a) => kb.isActive(a)).length, drafts: k.articles.filter((a) => a.state === 'draft').length },
    guidance: { total: state.guidance.rules.length, live: state.guidance.rules.filter((r) => activeNow(r)).length, basics: state.guidance.basics },
    escalation: { total: state.escalationRules.length, enabled: state.escalationRules.filter((r) => r.enabled).length },
    procedures: { total: state.procedures.length, live: state.procedures.filter((p) => p.state === 'live').length },
    tests: { groups: state.testGroups.length, questions: state.testGroups.reduce((n, g) => n + g.questions.length, 0) },
    recommendations: { open: state.recommendations.filter((r) => r.status === 'open').length },
    options: { tones: TONES, lengths: LENGTHS, categories: GUIDANCE_CATEGORIES },
  };
}

module.exports = {
  norm, logChange, getChangelog,
  getGuidance, setBasics, upsertGuidanceRule, removeGuidanceRule, basicsPromptLines, guidancePromptPart,
  getIntents, setIntents, classifyIntent,
  checkSafety,
  getEscalationRules, upsertEscalationRule, removeEscalationRule, evaluateRules,
  parseScript, listProcedures, getProcedure, upsertProcedure, removeProcedure, previewProcedure,
  startProcedure, continueProcedure, findProcedure, procStat,
  getTestGroups, getTestGroup, createTestGroup, removeTestGroup, upsertQuestion, removeQuestion, saveResult,
  noteGap, listRecommendations, acceptRecommendation, rejectRecommendation,
  recordEvent, analytics, overview,
  __test: { reset: () => { state = seed(); }, flush: writeSnapshot },
};
