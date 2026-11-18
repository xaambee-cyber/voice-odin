import test from "node:test";
import assert from "node:assert/strict";
import {
  configRelay,
  costoRelayUsd,
  intentosSupresion,
  normalizarAjustesRelay,
  pareceEco,
  esVozTelnyx,
  mismoTurno,
  textoParaVoz,
  velocidadTelnyx,
  vozParaOpenAI,
} from "../src/telnyx/relay-config";
import {
  bloquesSistema,
  costoClaudeUsd,
  herramientasClaude,
  MODELO_RELAY_LISTO,
  MotorRelayTelnyx,
  _reiniciarRelayCaido,
  motivoRelayNoDisponible,
  parametrosRazonamiento,
  relayDisponible,
} from "../src/telnyx/relay";
import { config } from "../src/utils/config";
import { limpiarAudio } from "../src/telnyx/api";
import { costoTelefoniaTelnyxUsd } from "../src/telnyx/eventos";
import { firmarSaliente, leerSaliente } from "../src/telnyx/firma";
import { urlRelayTelnyx, urlSalienteTelnyx } from "../src/telnyx/webhook";

// ── Piezas puras ────────────────────────────────────────────────────────────

test("voz de Telnyx vs voz de OpenAI: decide el motor y nunca rompe a OpenAI", () => {
  assert.equal(esVozTelnyx("Telnyx.Ultra.b4b8e2af-6139-466e-a93a-30c20d2e1fc5"), true);
  assert.equal(esVozTelnyx("Telnyx.KokoroTTS.ef_dora"), true);
  assert.equal(esVozTelnyx("marin"), false);
  assert.equal(esVozTelnyx("Telnyx.Ultra.<script>"), false);
  assert.equal(esVozTelnyx(undefined), false);
  // Una línea de Twilio con voz de Telnyx elegida suena con Marin, no truena.
  assert.equal(vozParaOpenAI("Telnyx.Ultra.b4b8e2af-6139-466e-a93a-30c20d2e1fc5"), "marin");
  assert.equal(vozParaOpenAI("cedar"), "cedar");
});

test("velocidad de las voces Ultra: acotada a 0.6–1.5 y 1 = la de la voz", () => {
  assert.equal(velocidadTelnyx(1), null);
  assert.equal(velocidadTelnyx(null), null);
  assert.equal(velocidadTelnyx(0.2), 0.6);
  assert.equal(velocidadTelnyx(3), 1.5);
  assert.equal(velocidadTelnyx(1.15), 1.15);
});

test("config del relay: voz, idioma, Flux en español con aviso temprano y parámetros de la llamada", () => {
  const c = configRelay({
    url: "wss://voz.example/relay-telnyx?ccid=a&t=b",
    voz: "Telnyx.Ultra.abc",
    velocidad: 1.2,
    parametros: { n: "+524611234567", c: "524619876543", f: "" },
  });
  assert.equal(c.url, "wss://voz.example/relay-telnyx?ccid=a&t=b");
  assert.equal(c.voice, "Telnyx.Ultra.abc");
  assert.deepEqual(c.voice_settings, { type: "telnyx", voice_speed: 1.2 });
  assert.equal(c.interruptible, "speech");
  assert.equal(c.transcription_engine, "Deepgram");
  const stt = c.transcription_engine_config as Record<string, unknown>;
  assert.equal(stt.transcription_model, "deepgram/flux-multi");
  assert.equal(stt.language, "es");
  assert.ok((stt.eager_eot_threshold as number) <= (stt.eot_threshold as number));
  assert.deepEqual(c.custom_parameters, { n: "+524611234567", c: "524619876543", f: "" });
});

test("costos del motor de Telnyx: relay + reconocimiento por minuto + voz por carácter, sin stream", () => {
  // 61 s = 2 minutos; 1,000 caracteres de voz Ultra.
  assert.equal(costoRelayUsd(61, 1000), Number((2 * (0.05 + 0.0074) + 1000 * 0.000032).toFixed(6)));
  assert.equal(costoTelefoniaTelnyxUsd(61, "local", false), Number((2 * (0.005 + 0.002)).toFixed(6)));
  assert.equal(costoTelefoniaTelnyxUsd(61), Number((2 * (0.005 + 0.002 + 0.0035)).toFixed(6)));
});

test("costo de Claude por modelo (desconocido = tarifa conservadora)", () => {
  const uso = { entrada: 1_000_000, salida: 1_000_000, cacheLeido: 0, cacheEscrito: 0 };
  assert.equal(costoClaudeUsd("claude-haiku-5-5", uso), 0.6);
  assert.equal(costoClaudeUsd("modelo-raro", uso), 18);
});

test("lo que va a la voz no lleva markdown ni emojis", () => {
  assert.equal(textoParaVoz("**Claro**, te espero 😊"), "Claro, te espero ");
  assert.equal(textoParaVoz("# Hola"), " Hola");
  assert.equal(textoParaVoz("¿A las 4:30?"), "¿A las 4:30?");
});

test("texto temprano vs final: mismo turno aunque cambien acentos y puntuación", () => {
  assert.equal(mismoTurno("Quiero una cita mañana", "quiero una cita, mañana."), true);
  assert.equal(mismoTurno("Quiero una cita", "Quiero una cita para el jueves"), false);
  assert.equal(mismoTurno("", ""), false);
});

test("llamada saliente: número y destino firmados, con caducidad, imposibles de alterar", () => {
  const ahora = Date.UTC(2026, 10, 16, 20, 0, 0);
  const f = firmarSaliente({ n: "+18708785364", c: "524611234567" }, ahora, "secreto");
  assert.deepEqual(leerSaliente(f.pr, f.t, ahora + 1000, "secreto"), { n: "+18708785364", c: "524611234567" });
  assert.equal(leerSaliente(f.pr, f.t, ahora + 11 * 60_000, "secreto"), null); // caducó
  assert.equal(leerSaliente(f.pr, f.t, ahora, "otro"), null); // otro secreto
  const alterado = Buffer.from(JSON.stringify({ n: "+18708785364", c: "5299999999", e: ahora + 60_000, x: "a" })).toString("base64url");
  assert.equal(leerSaliente(alterado, f.t, ahora, "secreto"), null);
});

test("URLs del relay: wss, ruta propia y token", () => {
  const u = new URL(urlRelayTelnyx("v3:abc"));
  assert.equal(u.protocol, "wss:");
  assert.equal(u.pathname, "/relay-telnyx");
  assert.equal(u.searchParams.get("ccid"), "v3:abc");
  assert.ok(u.searchParams.get("t"));
  const s = new URL(urlSalienteTelnyx("relay-telnyx", { pr: "xyz", t: "tok" }));
  assert.equal(s.searchParams.get("pr"), "xyz");
  assert.equal(s.searchParams.has("ccid"), false);
});

test("herramientas: mismas del motor de OpenAI, en formato de Claude", () => {
  const h = herramientasClaude([
    { type: "function", name: "agendar_cita", description: "Agenda", parameters: { type: "object", properties: { fecha: { type: "string" } }, required: ["fecha"] } },
  ]);
  assert.deepEqual(h, [{ name: "agendar_cita", description: "Agenda", input_schema: { type: "object", properties: { fecha: { type: "string" } }, required: ["fecha"] } }]);
});

test("prompt: lo estable se cachea entre llamadas; contexto y reglas de voz van al final", () => {
  const b = bloquesSistema("REGLAS DEL NEGOCIO\n=== CONTEXTO DE ESTA LLAMADA ===\nHoy es lunes");
  assert.equal(b.length, 2);
  assert.equal(b[0].text, "REGLAS DEL NEGOCIO");
  assert.ok(b[1].text.startsWith("=== CONTEXTO DE ESTA LLAMADA ==="));
  assert.ok(b[1].text.includes("TU TEXTO SE CONVIERTE EN VOZ"));
  assert.ok(b.every((x) => x.cache_control?.type === "ephemeral"));
});

test("razonamiento por modelo: apagado donde se puede, sin parámetros que den 400", () => {
  assert.deepEqual(parametrosRazonamiento("claude-haiku-5-5", false), { thinking: { type: "disabled" }, output_config: { effort: "low" } });
  assert.deepEqual(parametrosRazonamiento("claude-sonnet-5-5", false), { thinking: { type: "between_tools" }, output_config: { effort: "low" } });
  assert.deepEqual(parametrosRazonamiento("claude-opus-5-5", false), { output_config: { effort: "low" } });
  assert.deepEqual(parametrosRazonamiento("claude-haiku-4-5", false), {});
  assert.deepEqual(parametrosRazonamiento("claude-haiku-5-5", true), { output_config: { effort: "low" } });
});

// ── El motor con un Claude falso (sin red, sin costo) ───────────────────────

type Guion = {
  deltas?: string[];
  content?: any[];
  stop?: string;
  retrasoMs?: number;
  pausaMs?: number;
};

class StreamFalso {
  private oyentes: ((d: string) => void)[] = [];
  private abortado = false;
  currentMessage = { usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  private promesa: Promise<any>;
  constructor(g: Guion, signal?: AbortSignal) {
    signal?.addEventListener("abort", () => { this.abortado = true; });
    const deltas = g.deltas ?? [];
    this.promesa = new Promise((resolve, reject) => {
      let i = 0;
      const tick = () => {
        if (this.abortado) return reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" }));
        if (i < deltas.length) {
          const d = deltas[i++];
          this.oyentes.forEach((o) => o(d));
          setTimeout(tick, g.pausaMs ?? 2);
          return;
        }
        resolve({
          content: g.content ?? [{ type: "text", text: deltas.join("") }],
          stop_reason: g.stop ?? "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        });
      };
      setTimeout(tick, g.retrasoMs ?? 2);
    });
    this.promesa.catch(() => {});
  }
  on(ev: string, cb: (d: string) => void) { if (ev === "text") this.oyentes.push(cb); return this; }
  finalMessage() { return this.promesa; }
  abort() { this.abortado = true; }
}

function claudeFalso(guiones: Guion[]) {
  const pedidos: any[] = [];
  const cliente = {
    messages: {
      stream(params: any, opts: { signal?: AbortSignal }) {
        pedidos.push(JSON.parse(JSON.stringify(params)));
        const g = guiones.shift() ?? { deltas: ["(sin guion)"] };
        return new StreamFalso(g, opts?.signal);
      },
    },
  };
  return { cliente: cliente as any, pedidos };
}

function wsFalso() {
  const enviados: any[] = [];
  return { ws: { readyState: 1, send: (d: string) => enviados.push(JSON.parse(d)), close: () => {} } as any, enviados };
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textoDicho = (frames: any[]) => frames.filter((f) => f.type === "text").map((f) => f.token).join("");

async function motorListo(guiones: Guion[]) {
  const { cliente, pedidos } = claudeFalso(guiones);
  const { ws, enviados } = wsFalso();
  const motor = new MotorRelayTelnyx(ws, { cliente });
  const transcripcion: [string, string][] = [];
  const llamadas: [string, any][] = [];
  motor.setOnTranscript((t, r) => transcripcion.push([r, t]));
  motor.setOnFunctionCall(async (n, a) => {
    llamadas.push([n, a]);
    return { ok: true, mensaje: "Hay espacio el jueves a las 16:00." };
  });
  await motor.abrirConexion();
  return { motor, pedidos, enviados, transcripcion, llamadas };
}

test("saluda solo al configurarse y cierra el turno de voz con last:true", async () => {
  const m = await motorListo([{ deltas: ["Hola, ", "¿en qué te ayudo?"] }]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(40);
  assert.equal(textoDicho(m.enviados), "Hola, ¿en qué te ayudo?");
  assert.equal(m.enviados[m.enviados.length - 1].last, true);
  assert.deepEqual(m.transcripcion, [["assistant", "Hola, ¿en qué te ayudo?"]]);
  // El saludo es una nota interna: no aparece como algo que dijo el cliente.
  assert.equal(m.pedidos[0].messages[0].role, "user");
  assert.ok(m.pedidos[0].messages[0].content.startsWith("[La llamada acaba de conectarse"));
});

test("respuesta anticipada: se prepara con el aviso temprano y sale en cuanto llega el texto final", async () => {
  const m = await motorListo([{ deltas: ["Hola"] }, { deltas: ["Claro, ", "con gusto."], retrasoMs: 1 }]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  const antes = m.enviados.length;
  m.motor.recibirFrame({ type: "eagerEndOfTurn", voicePrompt: "Quiero una cita" });
  await esperar(30);
  // Ya se escribió, pero NO se mandó a la voz: el cliente podría seguir hablando.
  assert.equal(m.enviados.length, antes);
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "quiero una cita.", last: true });
  await esperar(30);
  assert.equal(textoDicho(m.enviados.slice(antes)), "Claro, con gusto.");
  assert.equal(m.pedidos.length, 2); // no se volvió a pedir
  assert.deepEqual(m.transcripcion.slice(-2), [["user", "quiero una cita."], ["assistant", "Claro, con gusto."]]);
  const lat = m.motor.resumenLatencia();
  assert.equal(lat.turnos, 1);
  assert.ok((lat.medianaMs ?? 999) < 20);
});

test("si el cliente siguió hablando, la respuesta anticipada se tira y se contesta lo que de verdad dijo", async () => {
  const m = await motorListo([{ deltas: ["Hola"] }, { deltas: ["Respuesta vieja"] }, { deltas: ["Para el jueves, ", "perfecto."] }]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  const antes = m.enviados.length;
  m.motor.recibirFrame({ type: "eagerEndOfTurn", voicePrompt: "Quiero una cita" });
  await esperar(20);
  m.motor.recibirFrame({ type: "turnResumed" });
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "Quiero una cita para el jueves", last: true });
  await esperar(40);
  const dicho = textoDicho(m.enviados.slice(antes));
  assert.equal(dicho, "Para el jueves, perfecto.");
  // La frase descartada nunca entró al historial que ve el modelo.
  const ultimo = m.pedidos[m.pedidos.length - 1].messages;
  assert.equal(JSON.stringify(ultimo).includes("Respuesta vieja"), false);
  assert.equal(JSON.stringify(ultimo).includes("Quiero una cita para el jueves"), true);
});

test("herramienta lenta sin texto previo: frase de espera, corre la MISMA función del pipeline y el resultado va justo después", async () => {
  const m = await motorListo([
    { deltas: ["Hola"] },
    { content: [{ type: "tool_use", id: "tu_1", name: "consultar_disponibilidad", input: { fecha: "2026-11-19" } }], stop: "tool_use" },
    { deltas: ["El jueves hay espacio a las cuatro."] },
  ]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  const antes = m.enviados.length;
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "¿Tienen el jueves?", last: true });
  await esperar(60);
  assert.deepEqual(m.llamadas, [["consultar_disponibilidad", { fecha: "2026-11-19" }]]);
  const dicho = textoDicho(m.enviados.slice(antes));
  assert.ok(dicho.startsWith("Permíteme, reviso la agenda."), dicho);
  assert.ok(dicho.endsWith("El jueves hay espacio a las cuatro."), dicho);
  const msgs = m.pedidos[2].messages;
  const ultimo = msgs[msgs.length - 1];
  assert.equal(ultimo.role, "user");
  assert.equal(ultimo.content[0].type, "tool_result");
  assert.equal(ultimo.content[0].tool_use_id, "tu_1");
  assert.equal(msgs[msgs.length - 2].content[0].type, "tool_use");
});

test("una respuesta anticipada NO ejecuta herramientas hasta que el cliente termina de verdad", async () => {
  const m = await motorListo([
    { deltas: ["Hola"] },
    { content: [{ type: "tool_use", id: "tu_9", name: "agendar_cita", input: { fechaInicio: "2026-11-19T16:00" } }], stop: "tool_use" },
  ]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  m.motor.recibirFrame({ type: "eagerEndOfTurn", voicePrompt: "Agéndame el jueves a las cuatro" });
  await esperar(40);
  assert.equal(m.llamadas.length, 0);
  m.motor.recibirFrame({ type: "turnResumed" });
  await esperar(20);
  assert.equal(m.llamadas.length, 0);
});

test("si el cliente interrumpe, se deja de escribir y el historial guarda solo lo que alcanzó a oír", async () => {
  const m = await motorListo([
    { deltas: ["Hola"] },
    { deltas: ["Tenemos ", "limpieza, ", "valoración, ", "blanqueamiento ", "y ortodoncia."], pausaMs: 15 },
    { deltas: ["Va, la limpieza."] },
  ]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "¿Qué servicios tienen?", last: true });
  await esperar(25);
  m.motor.recibirFrame({ type: "interrupt", utteranceUntilInterrupt: "Tenemos limpieza", durationUntilInterruptMs: 900 });
  await esperar(10);
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "La limpieza", last: true });
  await esperar(40);
  const msgs = m.pedidos[2].messages;
  const respuestaCortada = msgs.find((x: any) => x.role === "assistant" && JSON.stringify(x.content).includes("Tenemos limpieza"));
  assert.ok(respuestaCortada, JSON.stringify(msgs));
  assert.equal(JSON.stringify(msgs).includes("ortodoncia"), false);
});

test("consumo: se cobra lo que habló el agente y avisa si hubo contacto", async () => {
  const m = await motorListo([{ deltas: ["Hola, buenas tardes."] }]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  const u = m.motor.resumenUso();
  assert.equal(u.huboContacto, true);
  assert.equal(u.caracteresTts, "Hola, buenas tardes.".length);
  assert.ok(u.costoUsd > 0);
  assert.equal(u.cachedTextIn, 100);
});

// ── Ajustes del panel (Empleado → "Ajustes de la voz") ──────────────────────

test("ajustes del panel → relay: velocidad, idioma, fin de turno, interrupciones, teclado y palabras clave", () => {
  const c = configRelay({
    url: "wss://x/relay-telnyx?ccid=a&t=b",
    voz: "Telnyx.Ultra.abc",
    parametros: { n: "+1", c: "52", f: "" },
    ajustes: { velocidad: 1.1, idioma: "en", finDeTurno: "rapido", interrupciones: false, teclado: false, palabrasClave: ["UTEC", "Gaspar Almanza"] },
  });
  assert.deepEqual(c.voice_settings, { type: "telnyx", voice_speed: 1.1 });
  assert.equal(c.language, "en");
  assert.equal(c.interruptible, "none");
  assert.equal(c.dtmf_detection, false);
  const stt = c.transcription_engine_config as Record<string, unknown>;
  assert.equal(stt.language, "en");
  assert.equal(stt.eot_threshold, 0.6);
  assert.equal(stt.eager_eot_threshold, 0.4);
  assert.deepEqual(stt.keyterms, ["UTEC", "Gaspar Almanza"]);
});

test("reconocimiento Nova-3 y detección automática de idioma", () => {
  const c = configRelay({ url: "wss://x", voz: "Telnyx.Ultra.abc", parametros: {}, ajustes: { reconocimiento: "nova3", idioma: "auto", finDeTurno: "paciente" } });
  const stt = c.transcription_engine_config as Record<string, unknown>;
  assert.equal(stt.transcription_model, "deepgram/nova-3");
  assert.equal(stt.language, "auto_detect");
  assert.equal(stt.utterance_end_ms, 1000);
  assert.equal(c.language, "es"); // la voz habla español; el modelo contesta en el idioma del cliente
});

test("ajustes basura no rompen la llamada: todo cae a lo de fábrica", () => {
  const a = normalizarAjustesRelay({ velocidad: 9, idioma: "fr", finDeTurno: "ya", interrupciones: "si", cerebro: "gpt", palabrasClave: ["<script>", "x", "Ok Ok"] });
  assert.equal(a.velocidad, 1.25);
  assert.equal(a.idioma, "es");
  assert.equal(a.finDeTurno, "normal");
  assert.equal(a.interrupciones, true);
  assert.equal(a.cerebro, "rapido");
  assert.deepEqual(a.palabrasClave, ["script", "Ok Ok"]);
});

test("cerebro 'más listo' y 'pensar' cambian el modelo y el razonamiento de la llamada", async () => {
  const m = await motorListo([{ deltas: ["Hello!"] }]);
  m.motor.aplicarAjustes({ cerebro: "listo", pensar: true, idioma: "en" });
  m.motor.configurarSesion("PROMPT\n=== CONTEXTO DE ESTA LLAMADA ===\nHoy", []);
  await esperar(30);
  assert.equal(m.pedidos[0].model, MODELO_RELAY_LISTO);
  assert.equal(m.pedidos[0].thinking, undefined); // pensando: adaptive (no se apaga)
  assert.ok(JSON.stringify(m.pedidos[0].system).includes("habla SIEMPRE en inglés"));
  assert.ok(m.pedidos[0].messages[0].content.includes("en inglés"));
  assert.equal(m.motor.resumenUso().modelo, MODELO_RELAY_LISTO);
});

// ── Llamadas mudas (17-nov-2026): sin Claude, contesta OpenAI ───────────────

test("sin llave de Claude el motor de Telnyx no se usa (contesta OpenAI, no una llamada muda)", () => {
  const antes = config.anthropicApiKey;
  try {
    _reiniciarRelayCaido();
    config.anthropicApiKey = "";
    assert.equal(relayDisponible(), false);
    assert.match(motivoRelayNoDisponible(), /ANTHROPIC_API_KEY/);
    config.anthropicApiKey = "sk-ant-prueba";
    assert.equal(relayDisponible(), true);
  } finally {
    config.anthropicApiKey = antes;
    _reiniciarRelayCaido();
  }
});

test("Claude con llave inválida pausa el motor de Telnyx 10 minutos y avisa la caída", async () => {
  const antes = config.anthropicApiKey;
  config.anthropicApiKey = "sk-ant-prueba";
  _reiniciarRelayCaido();
  try {
    const cliente = {
      messages: {
        stream() {
          const err = Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { name: "AuthenticationError" });
          return { on() { return this; }, finalMessage: () => Promise.reject(err), abort() {}, currentMessage: undefined };
        },
      },
    };
    const { ws } = wsFalso();
    const motor = new MotorRelayTelnyx(ws, { cliente: cliente as any });
    let caida = "";
    motor.setOnCaida((m) => { caida = m; });
    await motor.abrirConexion();
    motor.configurarSesion("PROMPT", []);
    await esperar(30);
    assert.match(caida, /Claude no responde/);
    assert.equal(relayDisponible(), false);
    assert.equal(relayDisponible(Date.now() + 11 * 60_000), true);
  } finally {
    config.anthropicApiKey = antes;
    _reiniciarRelayCaido();
  }
});

test("no vuelve a saludar cuando el cliente solo responde el saludo (doble saludo, 17-nov-2026)", () => {
  const texto = bloquesSistema("REGLAS\n=== CONTEXTO DE ESTA LLAMADA ===\nHoy")[1].text;
  assert.ok(texto.includes("NUNCA vuelvas a saludar"));
});

// ── Eco y voz baja (17-nov-2026) ────────────────────────────────────────────
// Primera llamada real al número de México: el agente dijo "Buenas noches,
// habla Sofía", su propia voz regresó por el teléfono como "Ya, buenas noches.
// Habla Sophie" y se contestó "Hola Sophie, mucho gusto".

test("eco: reconoce la voz del agente aunque la transcripción la deforme", () => {
  const saludo = "Buenas noches, habla Sofía de la clínica, ¿en qué te puedo ayudar?";
  assert.equal(pareceEco("Ya, buenas noches. Habla Sophie.", saludo, "hablando"), true);
  assert.equal(pareceEco("Ya, buenas noches. Habla Sophie.", saludo, "cola"), true);
  // El principio de lo que dijo, mientras sigue hablando.
  assert.equal(pareceEco("Buenas noches", saludo, "hablando"), true);
  assert.equal(pareceEco("Buenas noches", saludo, "cola"), false);
});

test("eco: NO se come las respuestas del cliente que repiten palabras del agente", () => {
  const pregunta = "¿Lo quieres el martes o el jueves?";
  assert.equal(pareceEco("El martes", pregunta, "cola"), false);
  assert.equal(pareceEco("El martes", pregunta, "hablando"), false);
  assert.equal(pareceEco("Sí, el martes a las cuatro", "¿Te queda el martes a las cuatro?", "hablando"), false);
  assert.equal(pareceEco("No, mejor el jueves", pregunta, "cola"), false);
  assert.equal(pareceEco("Quiero agendar una limpieza", "Buenas noches, habla Sofía", "hablando"), false);
  assert.equal(pareceEco("Ya", "Ya quedó tu cita", "hablando"), false);
  assert.equal(pareceEco("", "Hola", "hablando"), false);
});

test("motor: el eco del saludo no abre un turno ni hace que el agente se conteste", async () => {
  const m = await motorListo([{ deltas: ["Buenas noches, ", "habla Sofía de la clínica, ", "¿en qué te puedo ayudar?"] }]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(40);
  m.motor.recibirFrame({ type: "eagerEndOfTurn", voicePrompt: "Ya, buenas noches. Habla Sophie." });
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "Ya, buenas noches. Habla Sophie.", last: true });
  await esperar(40);
  assert.equal(m.pedidos.length, 1, "no debió pedirle otra respuesta a Claude");
  assert.equal(m.transcripcion.some(([r]) => r === "user"), false);
});

test("motor: lo que de verdad dice el cliente mientras el agente habla sí pasa", async () => {
  const m = await motorListo([{ deltas: ["Buenas noches, habla Sofía de la clínica."] }, { deltas: ["Claro, te ayudo."] }]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "Quiero agendar una limpieza", last: true });
  await esperar(40);
  assert.equal(m.pedidos.length, 2);
  assert.ok(textoDicho(m.enviados).includes("Claro, te ayudo."));
});

test("motor: si el eco cortó al agente a media frase, termina la idea (no se queda callado)", async () => {
  const m = await motorListo([
    { deltas: ["Hola"] },
    { deltas: ["Tenemos limpieza, ", "valoración y ", "ortodoncia; ", "la limpieza cuesta quinientos pesos."], pausaMs: 15 },
    { deltas: ["La limpieza cuesta quinientos pesos."] },
  ]);
  m.motor.configurarSesion("PROMPT", []);
  await esperar(30);
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "¿Qué servicios tienen?", last: true });
  await esperar(40);
  m.motor.recibirFrame({ type: "interrupt", utteranceUntilInterrupt: "Tenemos limpieza, valoración", durationUntilInterruptMs: 1500 });
  await esperar(5);
  m.motor.recibirFrame({ type: "prompt", voicePrompt: "Tenemos limpieza, valoración", last: true });
  await esperar(40);
  assert.equal(m.pedidos.length, 3);
  const ultimo = JSON.stringify(m.pedidos[2].messages);
  assert.ok(ultimo.includes("Ruido en la línea"), ultimo);
  assert.equal(ultimo.includes('"Tenemos limpieza, valoración"}'), false, "el eco no entra como si lo hubiera dicho el cliente");
});

test("limpieza de voz: voice focus con ganancia, y planes B si Telnyx rechaza la combinación", () => {
  const d = intentosSupresion({});
  assert.deepEqual(d[0], {
    direction: "inbound",
    noise_suppression_engine: "quail_voice_focus_s",
    noise_suppression_engine_config: { voice_gain: 1.6, enhancement_level: 0.8 },
  });
  assert.deepEqual(d[1], { direction: "inbound", noise_suppression_engine: "quail_voice_focus_s" });
  assert.equal(d[2].noise_suppression_engine, "AiCoustics");
  assert.equal(d[d.length - 1].noise_suppression_engine, "AiCoustics");
  assert.deepEqual(intentosSupresion({ VOZ_SUPRESION: "0" }), []);
  const k = intentosSupresion({ VOZ_SUPRESION: "Krisp", VOZ_SUPRESION_DIRECCION: "both" });
  assert.equal(k[0].direction, "both");
  assert.deepEqual(k[0].noise_suppression_engine_config, { model: "krisp-viva-tel-v2.kef", suppression_level: 90 });
  // Ganancia fuera de rango se acota al máximo de Telnyx (4×).
  const g = intentosSupresion({ VOZ_SUPRESION_GANANCIA: "9", VOZ_SUPRESION_DIRECCION: "x" });
  assert.equal((g[0].noise_suppression_engine_config as any).voice_gain, 4);
  assert.equal(g[0].direction, "inbound");
});

test("limpieza de voz: prueba la siguiente combinación si Telnyx rechaza una, y nunca lanza", async () => {
  const llaveAntes = config.telnyxApiKey;
  const fetchAntes = globalThis.fetch;
  (config as any).telnyxApiKey = "llave-de-prueba";
  const cuerpos: any[] = [];
  try {
    globalThis.fetch = (async (_url: string, init: any) => {
      cuerpos.push(JSON.parse(init.body));
      return cuerpos.length === 1
        ? new Response(JSON.stringify({ errors: [{ code: "90015", title: "Invalid parameter" }] }), { status: 422 })
        : new Response("{}", { status: 200 });
    }) as any;
    const r = await limpiarAudio("v3:abc", intentosSupresion({}));
    assert.equal(r.motor, "quail_voice_focus_s");
    assert.equal(cuerpos.length, 2);
    assert.equal(cuerpos[1].noise_suppression_engine_config, undefined);
    globalThis.fetch = (async () => { throw new Error("red caída"); }) as any;
    const caido = await limpiarAudio("v3:abc", intentosSupresion({}));
    assert.equal(caido.motor, null);
  } finally {
    globalThis.fetch = fetchAntes;
    (config as any).telnyxApiKey = llaveAntes;
  }
});

test("costo: la limpieza de voz se suma solo si quedó encendida; el saludo no se corta", () => {
  assert.equal(Number((costoRelayUsd(61, 0, true) - costoRelayUsd(61, 0)).toFixed(6)), 0.006);
  const c = configRelay({ url: "wss://x", voz: "Telnyx.Ultra.abc", parametros: {} });
  assert.equal(c.interruptible_greeting, "none");
  assert.equal(c.interruptible, "speech");
});
