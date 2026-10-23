'use strict';
/** Pruebas de los módulos de entrenamiento (sin red, con datos en una carpeta temporal). */
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'botiquin-'));
process.env.GEMINI_API_KEY = ''; process.env.GROQ_API_KEY = ''; process.env.OPENROUTER_API_KEY = '';
const assert = require('assert');

const wa = require('../services/whatsappService');
const sent = [];
wa.sendText = async (to, body) => { sent.push(body); return { ok: true }; };

const training = require('../services/trainingService');
const kb = require('../services/knowledgeService');
const store = require('../services/store');
const bot = require('../services/botController');
const runner = require('../services/testRunner');
const { buildSystemPrompt } = require('../services/promptBuilder');
const ok = (m) => console.log('OK  ' + m);
const say = async (from, text) => { await bot.processIncoming({ from, text }); return sent.at(-1); };

(async () => {
  /* --- contenido con vigencia y borradores --- */
  const live = kb.addArticle({ title: 'Pago SINPE', content: 'Aceptamos SINPE Móvil al 8888-0000.', keywords: ['sinpe'], state: 'live' });
  const draft = kb.addArticle({ title: 'Promo dia madre', content: 'Descuento 20% en vitaminas.', keywords: ['promo'], state: 'draft' });
  const expired = kb.addArticle({ title: 'Promo vencida', content: 'Oferta vencida de vitaminas.', keywords: ['vitaminas'], validTo: '2020-01-01' });
  const future = kb.addArticle({ title: 'Promo futura', content: 'Oferta futura de jarabes.', keywords: ['jarabes'], validFrom: '2999-01-01' });
  assert.ok(kb.retrieve('aceptan sinpe?').some((h) => h.id === live.id));
  assert.ok(!kb.retrieve('hay promo?').some((h) => h.id === draft.id), 'borrador no se usa');
  assert.ok(!kb.retrieve('vitaminas').some((h) => h.id === expired.id), 'vencido no se usa');
  assert.ok(!kb.retrieve('jarabes').some((h) => h.id === future.id), 'futuro no se usa');
  kb.setKnowledge({ articles: kb.getKnowledge().articles.map((a) => (a.id === draft.id ? { id: a.id, title: a.title, content: a.content } : a)) }); // el panel viejo no pisa el estado
  assert.strictEqual(kb.getKnowledge().articles.find((a) => a.id === draft.id).state, 'draft');
  ok('contenido: borrador, vigencia y conservación de campos');

  /* --- intenciones y seguridad --- */
  assert.strictEqual(training.classifyIntent('¿A qué hora abren mañana?'), 'horarios_sucursales');
  assert.strictEqual(training.classifyIntent('quiero poner una queja, pésimo servicio'), 'queja');
  assert.strictEqual(training.classifyIntent('hola'), 'otro');
  assert.ok(training.checkSafety('ya no quiero vivir'));
  assert.strictEqual(training.checkSafety('¿tienen ibuprofeno?'), null);
  ok('intenciones y Safety Guard');

  /* --- guidance al prompt --- */
  training.upsertGuidanceRule({ category: 'communication', text: 'Termina siempre con "Pura vida".', state: 'live' });
  training.upsertGuidanceRule({ category: 'other', text: 'REGLA BORRADOR NO APLICA', state: 'draft' });
  training.setBasics({ tone: 'professional', length: 'concise' });
  const prompt = buildSystemPrompt({ message: 'hola' });
  assert.ok(prompt.includes('Pura vida') && !prompt.includes('REGLA BORRADOR'));
  assert.ok(prompt.includes('Máximo 2 o 3 líneas') && prompt.includes('profesional'));
  assert.throws(() => training.setBasics({ tone: 'raro' }));
  ok('guidance: solo reglas publicadas, tono y longitud');

  /* --- parser y motor de procedimientos --- */
  const bad = training.parseScript('hacer cosas\nsi x contiene y -> nada');
  assert.ok(bad.errors.length >= 2);
  const proc = training.upsertProcedure({ name: 'Pedido', state: 'live', keywords: ['pedido a domicilio'], script: 'preguntar producto: ¿Qué producto?\npreguntar zona: ¿Zona?\nsi producto contiene receta -> r | sino -> n\netiqueta: r\ntraspasar: Receta de {{producto}} en {{zona}}\netiqueta: n\nfin: Anotado {{producto}}' });
  const pv = training.previewProcedure(proc.id, ['aspirina', 'Pavas']);
  assert.strictEqual(pv.done, 'end');
  assert.ok(pv.transcript.some((t) => t.text === 'Anotado aspirina'));
  assert.strictEqual(training.previewProcedure(proc.id, ['receta de amoxicilina', 'Lomas']).done, 'handoff');
  assert.throws(() => training.upsertProcedure({ name: 'x', script: 'decir: hola', state: 'live' }), /disparador/);
  ok('procedimientos: parser, ramas si/sino y traspaso');

  /* --- flujo real: procedimiento dentro del chat --- */
  const P = '50688887777';
  await say(P, 'hola'); await say(P, '1'); await say(P, '1');
  let r = await say(P, 'quiero un pedido a domicilio');
  assert.match(r, /Qué producto/);
  assert.strictEqual(store.ensureShape(P).fsm.proc.id, proc.id);
  r = await say(P, 'receta de amoxicilina');
  assert.match(r, /Zona/);
  r = await say(P, 'Pavas');
  assert.match(r, /Receta de receta de amoxicilina en Pavas/);
  assert.strictEqual(store.isBotEnabled(P), false, 'traspaso pausa el bot');
  assert.strictEqual(store.ensureShape(P).fsm.summary.data.zona, 'Pavas');
  assert.strictEqual(training.getProcedure(proc.id).stats.handoffs, 1);
  ok('flujo real: procedimiento completo con traspaso y resumen');

  /* cancelar a mitad */
  const C = '50688886666';
  await say(C, 'hola'); await say(C, '1'); await say(C, '2');
  await say(C, 'pedido a domicilio por favor');
  r = await say(C, 'cancelar');
  assert.match(r, /cancel/i);
  assert.strictEqual(store.ensureShape(C).fsm.proc, null);
  ok('procedimiento: cancelar');

  /* --- reglas de escalado deterministas --- */
  const escRule = training.upsertEscalationRule({ name: 'Pagos', intent: 'pagos', enabled: true });
  const E = '50688885555';
  await say(E, 'hola'); await say(E, '1'); await say(E, '1');
  r = await say(E, 'necesito factura electrónica de mi pago');
  assert.match(r, /asesor humano/);
  assert.strictEqual(store.isBotEnabled(E), false);
  assert.throws(() => training.upsertEscalationRule({ name: 'sin condicion' }), /condición/);
  ok('regla de escalado por intención');

  /* --- Safety Guard en el chat --- */
  const S = '50688884444';
  r = await say(S, 'ya no quiero vivir');
  assert.match(r, /911/);
  assert.strictEqual(store.isBotEnabled(S), false);
  ok('Safety Guard en el chat');

  /* --- recomendaciones: hueco -> artículo --- */
  const G = '50688883333';
  await say(G, 'hola'); await say(G, '1'); await say(G, '1');
  await say(G, '¿Tienen servicio de toma de presión arterial?');
  await say(G, '¿Tienen servicio de toma de presión arterial?');
  let recs = training.listRecommendations();
  const rec = recs.find((x) => /presión arterial/.test(x.question));
  assert.ok(rec && rec.count === 2, 'misma pregunta se agrupa');
  assert.throws(() => training.acceptRecommendation(rec.id, {}), /respuesta/);
  const added = training.acceptRecommendation(rec.id, { content: 'Sí, control de presión gratis en ambas sucursales.', keywords: 'presion,tension' });
  assert.strictEqual(added.article.state, 'live');
  assert.ok(kb.retrieve('toma de presion').some((h) => h.id === added.article.id));
  assert.ok(!training.listRecommendations().some((x) => x.id === rec.id));
  ok('recomendaciones: agrupar, aceptar y que el bot ya lo sepa');

  /* --- banco de pruebas --- */
  training.upsertEscalationRule({ id: escRule.id, enabled: false }); // para que no atrape la pregunta de SINPE
  const g = training.createTestGroup('Mis pruebas');
  const q1 = training.upsertQuestion(g.id, { q: 'Tengo dolor de pecho', expectOutcome: 'escalado' });
  const q2 = training.upsertQuestion(g.id, { q: 'aceptan sinpe?', expect: ['8888-0000'] });
  const q3 = training.upsertQuestion(g.id, { q: 'pregunta sin expectativa' });
  assert.strictEqual((await runner.runQuestion(g.id, q1.id)).last.autoRating, 'good');
  const res2 = await runner.runQuestion(g.id, q2.id);
  assert.strictEqual(res2.last.autoRating, 'good');
  assert.ok(res2.last.sources.some((s) => s.title === 'Pago SINPE'), 'muestra el artículo usado');
  assert.strictEqual((await runner.runQuestion(g.id, q3.id)).last.autoRating, null);
  training.upsertQuestion(g.id, { id: q3.id, rating: 'poor', note: 'revisar' });
  const csv = runner.exportCsv(g.id);
  assert.ok(csv.includes('Pago SINPE') && csv.includes('poor'));
  for (let i = 0; i < 47; i++) training.upsertQuestion(g.id, { q: 'extra ' + i });
  assert.throws(() => training.upsertQuestion(g.id, { q: 'una más' }), /Máximo 50/);
  ok('test: valoración automática, fuentes, CSV y límite de 50');

  /* --- analítica y changelog --- */
  const a = training.analytics();
  assert.ok(a.total > 5 && a.escalated >= 3 && a.topIntents.length);
  assert.ok(training.getChangelog().some((c) => c.area === 'guidance'));
  assert.ok(training.getChangelog().some((c) => c.area === 'recomendaciones'));
  ok('analítica y changelog');

  /* --- persistencia --- */
  training.__test.flush();
  assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'training.json'), 'utf8')).procedures.length >= 2);
  console.log('\n✅ ENTRENAMIENTO OK — contenido, guidance, procedimientos, escalado, seguridad, recomendaciones, test y analítica');
  process.exit(0);
})().catch((e) => { console.error('❌ FALLO:', e.stack || e.message); process.exit(1); });
