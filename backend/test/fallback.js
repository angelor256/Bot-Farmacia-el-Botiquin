'use strict';
/** Prueba de la cadena de fallback con proveedores simulados (sin red real). */
process.env.GEMINI_API_KEY = 'fake-key';
process.env.GROQ_API_KEY = 'fake-groq';
process.env.OPENROUTER_API_KEY = '';
const assert = require('assert');
const axios = require('axios');

let scenario = [];   // cola de resultados del escenario actual
let calls = [];      // URLs efectivamente invocadas
axios.post = async (url) => {
  calls.push(url);
  const r = scenario.shift();
  if (!r) throw Object.assign(new Error('sin respuesta simulada'), { code: 'ECONNABORTED' });
  if (r.status >= 400) { const e = new Error('http'); e.response = { status: r.status, data: r.body }; throw e; }
  return { data: r.body };
};
let ai = require('../services/aiService');
const geminiModel = (u) => u.split('/models/')[1].split(':')[0];
const run = () => ai.generateReply({ userMessage: 'hola', history: [], context: {} });

/** El gateway abre su circuit-breaker al detectar credenciales rotas; para que
 *  cada prueba parta limpia, recargamos el módulo y reasignamos la referencia. */
function freshGateway() {
  delete require.cache[require.resolve('../services/aiService')];
  ai = require('../services/aiService');
}

(async () => {
  // 1) Gemini modelo A -> 404 (modelo retirado): descarta A sin reintentos y prueba B.
  calls = []; scenario = [
    { status: 404, body: { error: { message: 'Model gemini-3.8-flash is not found for api version v1beta' } } },
    { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Hola desde Gemini 2.0 Flash' }] } }] } },
  ];
  let out = await run();
  assert.strictEqual(out.text, 'Hola desde Gemini 2.0 Flash');
  assert.strictEqual(out.provider, 'gemini');
  assert.strictEqual(out.model, 'gemini-2.0-flash');
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(calls.length, 2);
  console.log('OK  404 en modelo retirado -> pasa al siguiente:', calls.map(geminiModel).join(' -> '));

  // 2) Key invalida (Gemini la devuelve como HTTP 400 + reason API_KEY_INVALID,
  //    Groq/OpenRouter como 401) -> NO reintenta ningún modelo más de ese
  //    proveedor y cae directo a Groq.
  freshGateway(); // breaker reseteado
  calls = []; scenario = [
    { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } } },
    { status: 200, body: { choices: [{ message: { content: 'Respuesta desde Groq' } }] } },
  ];
  out = await run();
  assert.strictEqual(out.provider, 'groq');
  assert.strictEqual(out.text, 'Respuesta desde Groq');
  assert.strictEqual(calls.filter((u) => u.includes('googleapis')).length, 1, 'auth(400 API_KEY_INVALID) = 1 sola llamada a Gemini');
  assert.strictEqual(calls.length, 2);
  console.log('OK  key inválida (400/API_KEY_INVALID) -> sin reintentos inútiles, cae a Groq (' + calls.length + ' llamadas)');

  // 2b) Regresión: Gemini con HTTP 401 clásico también debe saltar inmediato.
  freshGateway();
  calls = []; scenario = [
    { status: 401, body: { error: { message: 'Unauthorized' } } },
    { status: 200, body: { choices: [{ message: { content: 'Groq salvó la conversación' } }] } },
  ];
  out = await run();
  assert.strictEqual(out.provider, 'groq');
  assert.strictEqual(calls.filter((u) => u.includes('googleapis')).length, 1);
  console.log('OK  401 clásico ->also salto inmediato a Groq');

  // 3) Saturo todos los destinos -> el cliente SIEMPRE recibe un texto de respaldo.
  freshGateway();
  calls = []; scenario = Array.from({ length: 60 }, () => ({ status: 503, body: { error: { message: 'overloaded' } } }));
  out = await run();
  assert.strictEqual(out.provider, 'fallback-local');
  assert.ok(out.text.length > 20, 'el fallback siempre devuelve texto util');
  console.log('OK  Proveedores caidos -> fallback local garantizado:', JSON.stringify(out.text.slice(0, 48)));

  // 4) El historial filtrado por telefono llega a Gemini en formato valido.
  const contents = ai.toGeminiContents([{ role: 'model', text: 'saludo' }, { role: 'user', text: 'hola' }], 'gracias');
  assert.strictEqual(contents[0].role, 'user', 'recorta turnos "model" huerfanos del inicio');
  assert.strictEqual(contents.at(-1).parts[0].text, 'gracias');
  const msgs = ai.toOpenAiMessages('SYS', [{ role: 'model', text: 'a' }, { role: 'user', text: 'b' }], 'c');
  assert.deepStrictEqual(msgs.map((m) => m.role), ['system', 'assistant', 'user', 'user']);
  console.log('OK  Historial -> contents de Gemini y mensajes OpenAI correctos');

  console.log('\nCADENA DE FALLBACK VERIFICADA: Gemini(N modelos) -> Groq -> OpenRouter -> local');
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
