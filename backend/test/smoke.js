'use strict';
/** Prueba de humo sin red: FSM + historial por telefono + pausa humana + fallback IA. */
process.env.GEMINI_API_KEY = '';           // fuerza el camino de fallback
const assert = require('assert');
const store = require('../services/store');
const bot = require('../services/botController');
const ai = require('../services/aiService');
const { normalize } = require('../utils/phone');

// Interceptamos el envio real a WhatsApp (no hay credenciales en el test).
const wa = require('../services/whatsappService');
const sent = [];
wa.sendText = async (to, body) => { sent.push({ to, body }); return { ok: true }; };

const PHONE = '+506 8888-0000';

(async () => {
  await bot.processIncoming({ from: PHONE, text: 'hola' });
  assert.ok(sent.at(-1).body.includes('digite'), 'debe pedir opcion del menu');

  await bot.processIncoming({ from: PHONE, text: '1' });      // compra
  assert.strictEqual(store.ensureShape(PHONE).fsm.state, 2);
  await bot.processIncoming({ from: PHONE, text: '2' });      // sucursal
  assert.strictEqual(store.ensureShape(PHONE).fsm.state, 3);
  assert.strictEqual(store.ensureShape(PHONE).fsm.branch, 'Lomas del Río');

  // Formatos distintos del mismo numero deben mapear a la MISMA clave
  assert.strictEqual(normalize('50688880000@c.us'), normalize(PHONE));

  const before = sent.length;
  await bot.processIncoming({ from: PHONE, text: '¿tienen ibuprofeno?' });
  assert.ok(sent.length > before, 'estado 3 debe responder');
  const hist = store.getRecentHistory(PHONE);
  assert.ok(hist.some((m) => m.role === 'user' && m.text.includes('ibuprofeno')), 'historial filtrado por telefono contiene el mensaje');
  assert.ok(ai.health().live === false, 'sin keys -> no live');
  assert.match(sent.at(-1).body, /IA|conexión|bot/u, 'fallback local servido cuando no hay proveedores');

  // OBJETIVO #3: humano toma el chat -> el bot calla pero guarda el mensaje
  store.pauseBot(PHONE, { pausedBy: 'agente-01' });
  assert.strictEqual(store.isBotEnabled(PHONE), false);
  const n = sent.length;
  const r = await bot.processIncoming({ from: PHONE, text: 'quiero paracetamol' });
  assert.strictEqual(r.handled, false);
  assert.strictEqual(r.reason, 'bot-paused-by-human');
  assert.strictEqual(sent.length, n, 'no debe enviar nada mientras esta pausado');
  assert.ok(store.getRecentHistory(PHONE).at(-1).text.includes('paracetamol'), 'mensaje capturado para el agente');

  store.resumeBot(PHONE);
  assert.strictEqual(store.isBotEnabled(PHONE), true);

  console.log('✅ SMOKE TEST OK — FSM, historial por teléfono, pausa humana y fallback verificados');
})().catch((e) => { console.error('❌ FALLO:', e.message); process.exit(1); });
