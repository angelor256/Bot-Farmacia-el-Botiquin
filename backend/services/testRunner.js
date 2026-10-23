'use strict';
/**
 * services/testRunner.js — Banco de pruebas (equivale a "Test" de Fin).
 * Pasa cada pregunta por el MISMO orden de decisión que una conversación real
 * (seguridad → reglas de escalado → procedimiento → IA) pero sin tocar chats reales.
 */
const training = require('./trainingService');
const kb = require('./knowledgeService');
const ai = require('./aiService');
const bot = require('./botController');

/** Valoración automática si la pregunta trae expectativas; null = sin valorar (manual). */
function autoRate(question, result) {
  if (question.expectOutcome) return result.outcome === question.expectOutcome ? 'good' : 'poor';
  if (question.expect && question.expect.length) {
    const a = training.norm(result.answer);
    return question.expect.every((k) => a.includes(training.norm(k))) ? 'good' : 'poor';
  }
  return null;
}

async function answerQuestion(text) {
  const base = { at: new Date().toISOString(), intent: training.classifyIntent(text), sources: [], rules: [] };
  const safety = training.checkSafety(text);
  if (safety) return { ...base, outcome: 'escalado', answer: safety.message, provider: 'seguridad', model: '-', rules: ['Safety Guard: ' + safety.id] };

  const rule = training.evaluateRules(text, { intent: base.intent, misroutes: 0 });
  if (rule) return { ...base, outcome: 'escalado', answer: rule.message || bot.MSG_HUMAN_TAKEOVER, provider: 'regla', model: '-', rules: ['Regla de escalado: ' + rule.policy] };

  const pol = kb.detectEscalation(text, { policies: kb.getKnowledge().policies, fsm: {} });
  if (pol) return { ...base, outcome: 'escalado', answer: bot.MSG_HUMAN_TAKEOVER, provider: 'politica', model: '-', rules: ['Política: ' + pol.policy] };

  const proc = training.findProcedure(text, base.intent);
  if (proc) {
    const r = training.startProcedure(proc);
    return { ...base, outcome: 'procedimiento', answer: r.out.join('\n\n'), provider: 'procedimiento', model: '-', rules: ['Procedimiento: ' + proc.name] };
  }

  const hits = kb.retrieve(text, { topK: 3 });
  const res = await ai.generateReply({ userMessage: text, history: [], context: { ...bot.getBusinessConfig(), branch: 'Pavas Centro', option: 'Prueba' } });
  const escalated = /\[\[ESCALAR_HUMANO\]\]/.test(res.text);
  return {
    ...base,
    outcome: escalated ? 'escalado' : res.provider === 'fallback-local' && res.model === 'none' ? 'fallback' : 'ia',
    answer: res.text.replace(/\s*\[\[ESCALAR_HUMANO\]\]\s*/g, '').trim(),
    provider: res.provider, model: res.model,
    sources: hits.map((h) => ({ id: h.id, title: h.title })),
  };
}

/** Ejecuta UNA pregunta del grupo, guarda el resultado y devuelve la pregunta actualizada. */
async function runQuestion(groupId, qid) {
  const q = training.getTestGroup(groupId)?.questions.find((x) => x.id === qid);
  if (!q) return null;
  const result = await answerQuestion(q.q);
  result.autoRating = autoRate(q, result);
  return training.saveResult(groupId, qid, result);
}

const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
/** Informe CSV (pregunta, respuesta, valoración, nota…) como el de "Manage" en Test. */
function exportCsv(groupId) {
  const g = training.getTestGroup(groupId);
  if (!g) return null;
  const rows = [['Pregunta', 'Respuesta', 'Resultado', 'Intención', 'Fuentes y reglas', 'Valoración manual', 'Valoración automática', 'Nota']];
  for (const q of g.questions) {
    const l = q.last || {};
    rows.push([q.q, l.answer || '', l.outcome || '', l.intent || '', [...(l.sources || []).map((s) => s.title), ...(l.rules || [])].join(' | '), q.rating || '', l.autoRating || '', q.note || '']);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

module.exports = { runQuestion, answerQuestion, exportCsv, autoRate };
