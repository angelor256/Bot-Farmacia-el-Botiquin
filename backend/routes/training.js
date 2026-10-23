'use strict';
/**
 * routes/training.js — API del panel "Entrenar" (módulos tipo Fin AI Agent).
 * Todo cuelga de /api/training y exige X-Admin-Token (si hay ADMIN_TOKEN).
 */
const express = require('express');
const requireAdmin = require('../utils/adminAuth');
const training = require('../services/trainingService');
const kb = require('../services/knowledgeService');
const runner = require('../services/testRunner');
const log = require('../utils/logger');

const router = express.Router();
router.use(requireAdmin);
router.use(express.json({ limit: '2mb' }));

/** Envuelve un handler: los Error de validación del servicio salen como 400. */
const h = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    log.warn('[training] petición rechazada:', err.message);
    res.status(400).json({ error: err.message });
  }
};
const found = (x, what = 'Elemento') => { if (!x) { const e = new Error(`${what} no encontrado`); e.status = 404; throw e; } return x; };

router.get('/overview', h((_req, res) => res.json(training.overview())));

/* ---------- Contenido (artículos / snippets) ---------- */
router.get('/content', h((_req, res) => {
  const articles = kb.getKnowledge().articles.map((a) => ({ ...a, active: kb.isActive(a) }));
  res.json({ articles });
}));
router.post('/content', h((req, res) => {
  const art = kb.addArticle(req.body || {});
  training.logChange('contenido', 'creado', art.title);
  res.status(201).json(art);
}));
router.put('/content/:id', h((req, res) => {
  const art = found(kb.updateArticle(req.params.id, req.body || {}), 'Artículo');
  training.logChange('contenido', 'editado', art.title);
  res.json(art);
}));
router.delete('/content/:id', h((req, res) => {
  const art = found(kb.removeArticle(req.params.id), 'Artículo');
  training.logChange('contenido', 'eliminado', art.title);
  res.json({ ok: true });
}));
/** Importar texto pegado: cada "# Título" (o bloque separado por línea en blanco) pasa a ser un borrador. */
router.post('/content/import', h((req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) throw new Error('Pegue el texto a importar');
  const type = req.body?.type === 'public' ? 'public' : 'snippet';
  const blocks = /^#{1,3}\s/m.test(text)
    ? text.split(/^(?=#{1,3}\s)/m).map((b) => b.trim()).filter(Boolean)
    : text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const created = blocks.slice(0, 50).map((b) => {
    const lines = b.split('\n');
    const head = lines[0].replace(/^#{1,3}\s*/, '').trim();
    const heading = /^#{1,3}\s/.test(lines[0]);
    return kb.addArticle({ title: (heading ? head : head.slice(0, 80)) || 'Sin título', content: (heading ? lines.slice(1) : lines).join('\n').trim() || head, type, state: 'draft', category: 'importado' });
  });
  training.logChange('contenido', 'importado', `${created.length} borradores`);
  res.status(201).json({ created: created.length, articles: created });
}));

/* ---------- Guidance ---------- */
router.get('/guidance', h((_req, res) => res.json({ ...training.getGuidance(), options: training.overview().options })));
router.put('/guidance/basics', h((req, res) => res.json(training.setBasics(req.body || {}))));
router.post('/guidance/rules', h((req, res) => res.status(201).json(training.upsertGuidanceRule({ ...req.body, id: undefined }))));
router.put('/guidance/rules/:id', h((req, res) => res.json(found(training.upsertGuidanceRule({ ...req.body, id: req.params.id }), 'Regla'))));
router.delete('/guidance/rules/:id', h((req, res) => { found(training.removeGuidanceRule(req.params.id), 'Regla'); res.json({ ok: true }); }));

/* ---------- Escalado + intenciones + procedimientos ---------- */
router.get('/escalation', h((_req, res) => res.json({ rules: training.getEscalationRules(), intents: training.getIntents() })));
router.post('/escalation/rules', h((req, res) => res.status(201).json(training.upsertEscalationRule({ ...req.body, id: undefined }))));
router.put('/escalation/rules/:id', h((req, res) => res.json(found(training.upsertEscalationRule({ ...req.body, id: req.params.id }), 'Regla'))));
router.delete('/escalation/rules/:id', h((req, res) => { found(training.removeEscalationRule(req.params.id), 'Regla'); res.json({ ok: true }); }));
router.put('/intents', h((req, res) => res.json(training.setIntents(req.body?.intents))));
router.post('/intents/classify', h((req, res) => res.json({ intent: training.classifyIntent(req.body?.text), safety: training.checkSafety(req.body?.text) })));

router.get('/procedures', h((_req, res) => res.json({ procedures: training.listProcedures() })));
router.post('/procedures', h((req, res) => res.status(201).json(training.upsertProcedure({ ...req.body, id: undefined }))));
router.put('/procedures/:id', h((req, res) => res.json(found(training.upsertProcedure({ ...req.body, id: req.params.id }), 'Procedimiento'))));
router.delete('/procedures/:id', h((req, res) => { found(training.removeProcedure(req.params.id), 'Procedimiento'); res.json({ ok: true }); }));
router.post('/procedures/:id/preview', h((req, res) => res.json(found(training.previewProcedure(req.params.id, req.body?.inputs || []), 'Procedimiento'))));

/* ---------- Test (banco de pruebas) ---------- */
router.get('/tests', h((_req, res) => res.json({ groups: training.getTestGroups() })));
router.post('/tests', h((req, res) => res.status(201).json(training.createTestGroup(req.body?.name))));
router.delete('/tests/:gid', h((req, res) => { found(training.removeTestGroup(req.params.gid), 'Grupo'); res.json({ ok: true }); }));
router.post('/tests/:gid/questions', h((req, res) => res.status(201).json(found(training.upsertQuestion(req.params.gid, { ...req.body, id: undefined }), 'Grupo'))));
router.put('/tests/:gid/questions/:qid', h((req, res) => res.json(found(training.upsertQuestion(req.params.gid, { ...req.body, id: req.params.qid }), 'Pregunta'))));
router.delete('/tests/:gid/questions/:qid', h((req, res) => { found(training.removeQuestion(req.params.gid, req.params.qid), 'Pregunta'); res.json({ ok: true }); }));
router.post('/tests/:gid/questions/:qid/run', h(async (req, res) => res.json(found(await runner.runQuestion(req.params.gid, req.params.qid), 'Pregunta'))));
router.get('/tests/:gid/export.csv', h((req, res) => {
  const csv = found(runner.exportCsv(req.params.gid), 'Grupo');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="test-botiquin.csv"');
  res.send(csv);
}));

/* ---------- Recomendaciones, analítica, changelog ---------- */
router.get('/recommendations', h((req, res) => res.json({ recommendations: training.listRecommendations({ status: req.query.status === 'all' ? '' : req.query.status || 'open' }) })));
router.post('/recommendations/:id/add', h((req, res) => res.json(found(training.acceptRecommendation(req.params.id, req.body || {}), 'Recomendación'))));
router.post('/recommendations/:id/reject', h((req, res) => res.json(found(training.rejectRecommendation(req.params.id), 'Recomendación'))));
router.get('/analytics', h((req, res) => res.json(training.analytics({ days: parseInt(req.query.days, 10) || 30 }))));
router.get('/changelog', h((req, res) => res.json({ entries: training.getChangelog({ limit: parseInt(req.query.limit, 10) || 100 }) })));

module.exports = router;
