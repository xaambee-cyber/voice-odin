"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MotorRelayTelnyx = exports.MODELO_RELAY_LISTO = exports.MODELO_RELAY = void 0;
exports.relayDisponible = relayDisponible;
exports.motivoRelayNoDisponible = motivoRelayNoDisponible;
exports.marcarRelayCaido = marcarRelayCaido;
exports._reiniciarRelayCaido = _reiniciarRelayCaido;
exports.costoClaudeUsd = costoClaudeUsd;
exports.parametrosRazonamiento = parametrosRazonamiento;
exports.herramientasClaude = herramientasClaude;
exports.reglaIdioma = reglaIdioma;
exports.bloquesSistema = bloquesSistema;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const ws_1 = __importDefault(require("ws"));
const config_1 = require("../utils/config");
const realtime_1 = require("../openai/realtime");
const normalizar_hora_1 = require("../utils/normalizar-hora");
const motor_1 = require("../voz/motor");
const relay_config_1 = require("./relay-config");
/** Tras callarse, cuánto tiempo un texto que repite al agente aún puede ser su eco. */
const COLA_ECO_MS = 1500;
// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE VOZ DE TELNYX (Conversation Relay + Claude)
//
// Telnyx contesta, transcribe al cliente y habla con sus voces premium. Por el
// WebSocket nos llega TEXTO (lo que dijo el cliente) y mandamos TEXTO (lo que
// el agente contesta, en fragmentos conforme Claude los escribe, para que la
// voz arranque con la primera palabra y no al final de la respuesta).
//
// Mismo contrato que OpenAIRealtime (MotorVoz): las herramientas las ejecuta el
// pipeline con manejarFuncion, así que agendar, cancelar, transferir, cobrar,
// motores, ubicación… son EXACTAMENTE las mismas que en el motor de siempre.
//
// LATENCIA — lo que más importa aquí:
//   1. Flux (el reconocimiento por default) avisa "probablemente ya terminó"
//      ANTES del texto final (eagerEndOfTurn). En ese momento ya le pedimos la
//      respuesta a Claude, guardando lo que escriba sin mandarlo. Si el texto
//      final coincide, se suelta de golpe: la respuesta sale casi sin espera.
//      Si el cliente siguió hablando (turnResumed) o dijo otra cosa, se tira.
//   2. Cada fragmento de texto sale en cuanto llega (la voz no espera la frase).
//   3. El prompt va con caché: tools + reglas del negocio se leen del caché en
//      cada turno (más rápido y ~10× más barato).
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Modelo que piensa. Haiku 5.5 por la meta de ~1 s por turno: es el de menor
 * tiempo al primer token y en una llamada cada décima de segundo se oye.
 * Para probar otro sin tocar código: VOZ_RELAY_MODELO=claude-sonnet-5-5.
 */
exports.MODELO_RELAY = process.env.VOZ_RELAY_MODELO || "claude-haiku-5-5";
/** Cerebro "más listo" del panel: mejor razonamiento, ~+0.3–0.5 s por turno. */
exports.MODELO_RELAY_LISTO = process.env.VOZ_RELAY_MODELO_LISTO || "claude-sonnet-5-5";
// ── ¿Puede contestar el motor de Telnyx? ────────────────────────────────────
// El 17-nov-2026 las primeras llamadas con voz premium se quedaron MUDAS: el
// motor arrancaba y se apagaba al segundo porque Claude no podía pensar (llave
// faltante o inválida en el voice server). El motor de OpenAI nunca la había
// necesitado, así que nadie lo notó hasta que la línea contestó en silencio.
// Ahora: sin llave, o con Claude fallando por llave/crédito, las llamadas
// contestan con el motor de OpenAI (voz clásica) durante 10 min y se reintenta.
// Peor que una voz menos bonita es una llamada en silencio.
let relayCaidoHasta = 0;
let motivoRelayCaido = "";
const PAUSA_RELAY_CAIDO_MS = 10 * 60_000;
function relayDisponible(ahora = Date.now()) {
    return !!config_1.config.anthropicApiKey && ahora >= relayCaidoHasta;
}
function motivoRelayNoDisponible() {
    if (!config_1.config.anthropicApiKey)
        return "falta ANTHROPIC_API_KEY en el voice server";
    return motivoRelayCaido;
}
/** Claude no puede pensar (llave/crédito): las siguientes llamadas van por OpenAI un rato. */
function marcarRelayCaido(motivo, ahora = Date.now()) {
    relayCaidoHasta = ahora + PAUSA_RELAY_CAIDO_MS;
    motivoRelayCaido = motivo.slice(0, 200);
    console.error(`[RELAY] Motor de Telnyx en pausa 10 min (se usará OpenAI): ${motivoRelayCaido}`);
}
/** Solo pruebas. */
function _reiniciarRelayCaido() {
    relayCaidoHasta = 0;
    motivoRelayCaido = "";
}
/** USD por 1M de tokens (hoja de Anthropic, nov-2026). */
const PRECIOS_CLAUDE = {
    "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
};
function costoClaudeUsd(modelo, uso) {
    const p = PRECIOS_CLAUDE[modelo] ?? PRECIOS_CLAUDE["claude-sonnet-4-6"]; // desconocido → conservador
    const total = uso.entrada * p.in + uso.salida * p.out + uso.cacheLeido * p.cacheRead + uso.cacheEscrito * p.cacheWrite;
    return Number((total / 1_000_000).toFixed(6));
}
/**
 * Parámetros de razonamiento por modelo. En una llamada no hay tiempo para
 * "pensar" antes de hablar: se apaga donde se puede y el esfuerzo va bajo
 * (respuestas cortas, menos preámbulo). Cada familia lo acepta distinto:
 *  - Haiku 5.5: `disabled` se acepta con esfuerzo high o menor.
 *  - Sonnet 5.5: `disabled` da 400; lo equivalente es `between_tools`.
 *  - Opus 5.5: no se puede apagar; solo se baja el esfuerzo.
 *  - Haiku 4.5 / Sonnet 4.6: sin `thinking` no piensa; no aceptan `effort`… salvo Sonnet 4.6.
 */
function parametrosRazonamiento(modelo, 
// VOZ_RELAY_PENSAR=1: razonamiento oculto (adaptive). Medido el 16-nov-2026:
// respuestas más pulidas pero ~+400 ms por turno (≈1.0 s vs ≈0.4–0.6 s al
// primer texto). Con el prompt real (trae calendario) no hizo falta.
pensar = process.env.VOZ_RELAY_PENSAR === "1") {
    if (pensar) {
        // Los 5.x piensan solos si no se dice nada; Sonnet 4.6 hay que pedírselo.
        if (modelo.startsWith("claude-sonnet-4-6"))
            return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
        if (/^claude-(haiku|sonnet|opus)-5/.test(modelo))
            return { output_config: { effort: "low" } };
        return {};
    }
    if (modelo.startsWith("claude-haiku-5"))
        return { thinking: { type: "disabled" }, output_config: { effort: "low" } };
    if (modelo.startsWith("claude-sonnet-5-5"))
        return { thinking: { type: "between_tools" }, output_config: { effort: "low" } };
    if (modelo.startsWith("claude-opus-5"))
        return { output_config: { effort: "low" } };
    if (modelo.startsWith("claude-sonnet-4-6"))
        return { output_config: { effort: "low" } };
    return {};
}
/** Las herramientas del motor de OpenAI, en el formato de Claude (mismo esquema JSON). */
function herramientasClaude(tools) {
    return tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: (t.parameters && typeof t.parameters === "object"
            ? t.parameters
            : { type: "object", properties: {} }),
    }));
}
const MARCA_CONTEXTO = "\n=== CONTEXTO DE ESTA LLAMADA ===";
/** Reglas propias de este motor: aquí el agente ESCRIBE y una voz lo lee tal cual. */
const REGLAS_TEXTO_A_VOZ = `
=== TU TEXTO SE CONVIERTE EN VOZ ===
Escribes texto y una voz lo dice tal cual por teléfono.
- Escribe solo lo que dirías en voz alta: sin markdown, emojis, viñetas, acotaciones ni texto entre corchetes.
- Piensa en silencio. NUNCA digas tus cálculos ni deducciones ("hoy es lunes, así que mañana es…") ni fechas en formato técnico (2026-11-18): el cliente solo oye la respuesta.
- No menciones la fecha ni la hora de hoy salvo que te las pregunten: contesta directo a lo que preguntó.
  Ejemplo — cliente: "¿a qué hora abren mañana?" → tú: "Mañana abrimos a las nueve de la mañana. ¿Te aparto un horario?" (NO: "Hoy es lunes, así que mañana es martes…").
- Ya saludaste al contestar: NUNCA vuelvas a saludar ni a presentarte. Si el cliente solo responde el saludo ("hola", "buenas", "¿bueno?"), contesta algo muy corto para que hable ("Sí, dime." o "Claro, cuéntame.") sin repetir "¿en qué te puedo ayudar?".
- Una o dos frases por turno (máximo unas 35 palabras). Si necesitas un dato, termina con la pregunta.
- Horas y fechas como se dicen: "a las cuatro de la tarde", "el jueves veinte de noviembre". Precios: "trescientos cincuenta pesos".
- Antes de usar una herramienta di, a lo mucho, algo muy corto ("déjame ver") y llámala; nunca prometas un resultado antes de tenerlo.
- Lo que va entre corchetes en los mensajes del cliente son notas del sistema, no palabras suyas: úsalas pero nunca las leas ni las menciones.
- La transcripción del teléfono puede venir con errores: si algo no tiene sentido, pide que lo repita con naturalidad.`;
/**
 * El prompt del negocio partido en dos bloques para el caché: lo estable
 * (reglas, catálogo, horarios) y el contexto de ESTA llamada (fecha, citas de
 * quien llama). El primero se reutiliza entre llamadas del mismo negocio.
 * Las reglas de voz van AL FINAL, después del contexto: es lo último que lee el
 * modelo antes de hablar y donde más pesan (son cortas; no importa que no se
 * reutilicen entre llamadas).
 */
/** Regla de idioma según el ajuste del panel (las instrucciones siguen en español). */
function reglaIdioma(idioma) {
    if (idioma === "en")
        return "\n- IDIOMA: habla SIEMPRE en inglés con el cliente, aunque estas instrucciones estén en español.";
    if (idioma === "auto")
        return "\n- IDIOMA: contesta en el idioma en que te hable el cliente (español o inglés) y no lo cambies sin motivo.";
    return "";
}
function bloquesSistema(prompt, idioma = "es") {
    const i = prompt.indexOf(MARCA_CONTEXTO);
    const estable = i >= 0 ? prompt.slice(0, i) : prompt;
    const volatil = `${i >= 0 ? prompt.slice(i).trim() : ""}\n${REGLAS_TEXTO_A_VOZ}${reglaIdioma(idioma)}`.trim();
    return [
        { type: "text", text: estable, cache_control: { type: "ephemeral" } },
        { type: "text", text: volatil, cache_control: { type: "ephemeral" } },
    ];
}
const ESTILOS_SALUDO = [
    "con energía cálida, como si te alegrara la llamada",
    "sonriendo (que se note amable)",
    "tranquila y profesional",
    "con tono servicial y ágil",
];
class MotorRelayTelnyx {
    ws;
    cliente = null;
    sistema = [];
    herramientas = [];
    mensajes = [];
    cadena = Promise.resolve();
    contador = 0;
    turnoVivo = null;
    cerrado = false;
    saludoPedido = false;
    /** Ajustes del panel para ESTA llamada (cerebro, pensar, idioma, reconocimiento). */
    modelo = exports.MODELO_RELAY;
    pensar = process.env.VOZ_RELAY_PENSAR === "1";
    ajustes = (0, relay_config_1.normalizarAjustesRelay)(null);
    errores = 0;
    colgarPedido = false;
    /** Telnyx acepta `token: ""` para cerrar el turno; si algún día no, se manda " ". */
    tokenVacioOk = true;
    /** Cuándo termina (aprox.) de hablar la voz lo que ya le mandamos. */
    finHablaMs = 0;
    /** Lo que el agente dijo en el tramo actual (para reconocer su propio eco). */
    dichoReciente = "";
    fraseCerrada = true;
    /** Telnyx calló al agente porque "oyó" al cliente: cuándo, y si estaba a media frase. */
    corte = null;
    ecosDescartados = 0;
    horaExplicita = null;
    teclas = "";
    teclasTimer = null;
    uso = { entrada: 0, salida: 0, cacheLeido: 0, cacheEscrito: 0, caracteres: 0 };
    latencias = [];
    aprovechados = 0;
    descartados = 0;
    onTranscript = null;
    onItemCreated = null;
    onInterrupcion = null;
    onFunctionCall = null;
    onCaida = null;
    onErrorModelo = null;
    /** `cliente` solo se inyecta en pruebas (un Claude falso que no cuesta). */
    constructor(ws, opciones = {}) {
        this.ws = ws;
        if (opciones.cliente)
            this.cliente = opciones.cliente;
    }
    // ── MotorVoz ─────────────────────────────────────────────────────────────
    setOnAudioDelta() { }
    setOnEspera() { }
    setOnTranscript(cb) { this.onTranscript = cb; }
    setOnItemCreated(cb) { this.onItemCreated = cb; }
    setOnInterrupcion(cb) { this.onInterrupcion = cb; }
    setOnFunctionCall(cb) { this.onFunctionCall = cb; }
    setOnCaida(cb) { this.onCaida = cb; }
    setOnErrorOpenAI(cb) { this.onErrorModelo = cb; }
    async abrirConexion() {
        if (this.cliente)
            return;
        if (!config_1.config.anthropicApiKey)
            throw new Error("Falta ANTHROPIC_API_KEY en el voice server");
        // Reintenta una vez (429/5xx) y corta a los 15 s: en una llamada, esperar
        // más que eso es peor que decir "¿me repites?".
        this.cliente = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey, maxRetries: 1, timeout: 15_000 });
    }
    configurarSesion(prompt, tools = []) {
        this.sistema = bloquesSistema(prompt, this.ajustes.idioma);
        this.herramientas = herramientasClaude(tools);
        if (this.saludoPedido)
            return;
        this.saludoPedido = true;
        const estilo = ESTILOS_SALUDO[Math.floor(Math.random() * ESTILOS_SALUDO.length)];
        this.iniciarTurno(`[La llamada acaba de conectarse. Saluda al cliente ${this.ajustes.idioma === "en" ? "en inglés" : "en español mexicano"}, ${estilo}. Si tus instrucciones traen un SALUDO INICIAL, transmítelo con tus palabras; si no, algo breve tipo "Hola, ¿en qué te puedo ayudar?". UNA sola oración corta y natural.]`, { interno: true });
        console.log(`[RELAY] Sesión lista — modelo ${this.modelo}${this.pensar ? " (pensando)" : ""}, ${tools.length} herramientas, ` +
            `STT ${this.etiquetaStt()}, idioma ${this.ajustes.idioma}`);
    }
    enviarAudio() { }
    cancelarRespuesta() {
        const t = this.turnoVivo;
        if (t)
            this.abortar(t);
    }
    cerrar() {
        if (this.cerrado)
            return;
        this.cerrado = true;
        if (this.teclasTimer)
            clearTimeout(this.teclasTimer);
        if (this.turnoVivo)
            this.abortar(this.turnoVivo);
        try {
            if (this.ws.readyState === ws_1.default.OPEN) {
                this.ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ motivo: "fin" }) }));
                this.ws.close();
            }
        }
        catch { /* ya cerrado */ }
    }
    resumenUso() {
        return {
            audioIn: 0,
            textIn: this.uso.entrada,
            cachedAudioIn: 0,
            cachedTextIn: this.uso.cacheLeido,
            audioOut: 0,
            textOut: this.uso.salida,
            cacheWrite: this.uso.cacheEscrito,
            caracteresTts: this.uso.caracteres,
            modelo: this.modelo,
            costoUsd: costoClaudeUsd(this.modelo, this.uso),
            huboContacto: this.uso.caracteres > 0,
        };
    }
    resumenLatencia() {
        const total = this.latencias.map((l) => l.totalMs);
        if (this.latencias.length > 0) {
            console.log(`[RELAY] Respuestas anticipadas aprovechadas: ${this.aprovechados} · descartadas: ${this.descartados}`);
        }
        if (this.ecosDescartados > 0)
            console.log(`[RELAY] Ecos descartados en la llamada: ${this.ecosDescartados}`);
        return {
            turnos: this.latencias.length,
            medianaMs: (0, motor_1.mediana)(total),
            promedioMs: total.length ? Math.round(total.reduce((a, b) => a + b, 0) / total.length) : null,
            maximaMs: total.length ? Math.max(...total) : null,
            esperaMedianaMs: (0, motor_1.mediana)(this.latencias.map((l) => l.esperaMs)),
            modeloMedianaMs: (0, motor_1.mediana)(this.latencias.map((l) => l.modeloMs)),
            modeloTranscripcion: `telnyx/${this.etiquetaStt()}+${this.modelo}`,
        };
    }
    // ── Extras del relay (los usa el pipeline) ───────────────────────────────
    /**
     * Ajustes del panel (Empleado → "Ajustes de la voz") para esta llamada. Lo
     * llama el pipeline con la config de Odin ANTES de configurarSesion. Lo que
     * toca a Telnyx (voz, velocidad, reconocimiento, interrupciones) ya se fijó
     * al contestar; aquí va lo que decide el que piensa.
     */
    aplicarAjustes(raw) {
        this.ajustes = (0, relay_config_1.normalizarAjustesRelay)(raw);
        this.modelo = this.ajustes.cerebro === "listo" ? exports.MODELO_RELAY_LISTO : exports.MODELO_RELAY;
        this.pensar = this.ajustes.pensar;
    }
    etiquetaStt() {
        return String((0, relay_config_1.configTranscripcion)(this.ajustes).transcription_engine_config.transcription_model);
    }
    /** Cuánto le falta (aprox.) a la voz para terminar lo que ya se le mandó. */
    msHablaPendiente() {
        return Math.max(0, this.finHablaMs - Date.now());
    }
    /** Decir un texto fijo (despedida) fuera de la conversación del modelo. */
    decir(texto) {
        this.enviarTexto(null, texto, true);
    }
    /** El modelo pidió colgar: no se encadena otra respuesta después. */
    marcarColgado() {
        this.colgarPedido = true;
    }
    /** Un frame del WebSocket de Telnyx (el `setup` ya lo consumió index.ts). */
    recibirFrame(msg) {
        if (this.cerrado || !msg || typeof msg !== "object")
            return;
        switch (msg.type) {
            case "prompt":
                if (msg.last === false)
                    return; // parcial: esperamos el final
                this.alTextoFinal(String(msg.voicePrompt || ""));
                return;
            case "eagerEndOfTurn":
                this.alFinTemprano(String(msg.voicePrompt || ""));
                return;
            case "turnResumed":
                this.alReanudar();
                return;
            case "interrupt":
                this.alInterrumpir(String(msg.utteranceUntilInterrupt || ""));
                return;
            case "dtmf":
                this.alTecla(String(msg.digit || ""));
                return;
            case "error":
                console.error("[RELAY] Telnyx reportó error:", String(msg.description || JSON.stringify(msg)).slice(0, 300));
                if (/token/i.test(String(msg.description || "")) && this.tokenVacioOk) {
                    this.tokenVacioOk = false;
                    console.warn("[RELAY] Telnyx no acepta token vacío para cerrar turnos — se usará un espacio");
                }
                return;
            default:
                return;
        }
    }
    // ── Turnos del cliente ───────────────────────────────────────────────────
    /**
     * ¿Este "texto del cliente" es la voz del agente regresando por la línea?
     * Solo se pregunta mientras el agente habla o en el instante en que acaba de
     * callarse: pasado eso, todo lo que llega es del cliente.
     */
    esEco(texto) {
        if (!this.dichoReciente)
            return false;
        const ahora = Date.now();
        const recienCortado = this.corte != null && ahora - this.corte.en <= COLA_ECO_MS;
        const hablando = ahora <= this.finHablaMs + 400 || recienCortado;
        if (!hablando && ahora > this.finHablaMs + COLA_ECO_MS)
            return false;
        return (0, relay_config_1.pareceEco)(texto, this.dichoReciente, hablando ? "hablando" : "cola");
    }
    /**
     * Fue eco. Si ese eco además hizo que Telnyx callara al agente a media frase,
     * el cliente se quedó con una idea cortada y en silencio: el agente la termina.
     */
    alDescartarEco(texto) {
        this.ecosDescartados++;
        console.log(`[RELAY] Eco descartado (el agente se oyó a sí mismo): "${texto.slice(0, 80)}"`);
        const corte = this.corte;
        this.corte = null;
        const vivo = this.turnoVivo;
        const respondiendo = vivo != null && vivo.confirmado && !vivo.abort.signal.aborted;
        if (!corte?.aMediaFrase || respondiendo || this.colgarPedido)
            return;
        this.iniciarTurno("[Ruido en la línea cortó lo que estabas diciendo; el cliente NO dijo nada. Termina tu idea en una sola frase corta, sin repetir lo que ya dijiste ni disculparte.]", { interno: true });
    }
    alFinTemprano(texto) {
        if (!texto.trim() || this.colgarPedido)
            return;
        if (this.esEco(texto))
            return; // el texto final decide si hay que retomar
        const vivo = this.turnoVivo;
        if (vivo?.especulativo && !vivo.confirmado) {
            if ((0, relay_config_1.mismoTurno)(vivo.texto, texto))
                return; // mismo aviso repetido
            this.descartar(vivo);
        }
        this.iniciarTurno(texto, { especulativo: true });
    }
    alReanudar() {
        const vivo = this.turnoVivo;
        if (vivo?.especulativo && !vivo.confirmado)
            this.descartar(vivo);
    }
    alTextoFinal(texto) {
        // Tras pedir colgar, un "gracias" del cliente no debe abrir otra respuesta.
        if (!texto.trim() || this.colgarPedido)
            return;
        if (this.esEco(texto)) {
            const vivoEco = this.turnoVivo;
            if (vivoEco?.especulativo && !vivoEco.confirmado)
                this.descartar(vivoEco);
            this.alDescartarEco(texto);
            return;
        }
        this.corte = null;
        const vivo = this.turnoVivo;
        if (vivo?.especulativo && !vivo.confirmado) {
            if ((0, relay_config_1.mismoTurno)(vivo.texto, texto)) {
                this.confirmar(vivo, texto);
                return;
            }
            this.descartar(vivo);
        }
        this.iniciarTurno(texto, {});
    }
    alInterrumpir(dicho) {
        this.onInterrupcion?.();
        const ahora = Date.now();
        this.corte = { en: ahora, aMediaFrase: this.finHablaMs - ahora > 300 };
        this.finHablaMs = ahora;
        const vivo = this.turnoVivo;
        if (vivo && !vivo.especulativo && vivo.stream) {
            // Telnyx ya calló la voz: no tiene caso seguir escribiendo encima del cliente.
            vivo.interrumpido = true;
            if (dicho.trim())
                vivo.textoEnviado = dicho.trim();
            this.abortar(vivo);
            return;
        }
        // La respuesta ya había terminado de escribirse, pero no de decirse: el
        // historial se queda con lo que el cliente alcanzó a oír.
        if (dicho.trim())
            this.recortarUltimaRespuesta(dicho.trim());
    }
    alTecla(digito) {
        if (!/^[0-9*#A-D]$/.test(digito))
            return;
        this.teclas += digito;
        if (this.teclasTimer)
            clearTimeout(this.teclasTimer);
        this.teclasTimer = setTimeout(() => {
            const marcado = this.teclas;
            this.teclas = "";
            this.teclasTimer = null;
            if (marcado)
                this.iniciarTurno(`[El cliente marcó en el teclado: ${marcado}]`, {});
        }, 1200);
    }
    iniciarTurno(texto, opts) {
        const anterior = this.turnoVivo;
        if (anterior)
            this.abortar(anterior);
        let resolver = () => { };
        const confirmacion = new Promise((r) => { resolver = r; });
        const especulativo = opts.especulativo === true;
        const turno = {
            id: ++this.contador,
            texto,
            interno: opts.interno === true,
            especulativo,
            confirmado: !especulativo,
            usuarioComprometido: false,
            confirmacion,
            resolverConfirmacion: resolver,
            buffer: "",
            abort: new AbortController(),
            stream: null,
            esperaDesdeMs: Date.now(),
            streamDesdeMs: null,
            primerTextoMs: null,
            textoEnviado: "",
            textoAbierto: false,
            interrumpido: false,
        };
        if (!especulativo)
            resolver(true);
        this.turnoVivo = turno;
        this.cadena = this.cadena
            .then(() => this.correrTurno(turno))
            .catch((e) => console.error("[RELAY] Error en el turno:", e instanceof Error ? e.message : e));
    }
    /** El texto final confirmó lo que ya estábamos preparando: se suelta. */
    confirmar(turno, textoFinal) {
        turno.texto = textoFinal;
        turno.confirmado = true;
        turno.esperaDesdeMs = Date.now();
        // Solo si su turno ya está corriendo (la cola llegó a él): si no, una
        // herramienta de un turno anterior podría seguir en curso y su resultado
        // tiene que entrar al historial ANTES que estas palabras (la API exige
        // tool_result inmediatamente después del tool_use). correrTurno lo mete al
        // arrancar.
        if (turno.streamDesdeMs != null)
            this.comprometerUsuario(turno);
        this.aprovechados++;
        if (turno.buffer) {
            const pendiente = turno.buffer;
            turno.buffer = "";
            this.enviarTexto(turno, pendiente, false);
        }
        turno.resolverConfirmacion(true);
    }
    descartar(turno) {
        this.descartados++;
        this.abortar(turno);
        turno.resolverConfirmacion(false);
        if (this.turnoVivo === turno)
            this.turnoVivo = null;
    }
    abortar(turno) {
        // Una respuesta anticipada que nadie confirmará no puede dejar la cola
        // esperando para siempre.
        if (!turno.confirmado)
            turno.resolverConfirmacion(false);
        if (turno.abort.signal.aborted)
            return;
        turno.abort.abort();
        try {
            turno.stream?.abort();
        }
        catch { /* ya terminó */ }
    }
    /** Mete al historial lo que dijo el cliente (una sola vez por turno). */
    comprometerUsuario(turno) {
        if (turno.usuarioComprometido)
            return;
        turno.usuarioComprometido = true;
        let contenido = turno.texto;
        if (!turno.interno) {
            const hora = (0, normalizar_hora_1.ultimaHoraExplicita)(turno.texto);
            if (hora)
                this.horaExplicita = { hora, detectadaEl: Date.now() };
            const anotacion = (0, normalizar_hora_1.anotacionHorariaParaAgente)(turno.texto);
            if (anotacion)
                contenido += `\n${anotacion}`;
            const itemId = `relay-${turno.id}`;
            this.onItemCreated?.(itemId);
            this.onTranscript?.(turno.texto, "user", itemId);
        }
        this.agregarMensaje({ role: "user", content: contenido });
    }
    /** Agrega al historial; dos del mismo rol seguidos se funden en uno. */
    agregarMensaje(m) {
        const ultimo = this.mensajes[this.mensajes.length - 1];
        if (ultimo && ultimo.role === m.role) {
            const aBloques = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : c);
            ultimo.content = [...aBloques(ultimo.content), ...aBloques(m.content)];
            return;
        }
        this.mensajes.push(m);
    }
    recortarUltimaRespuesta(dicho) {
        const ultimo = this.mensajes[this.mensajes.length - 1];
        if (!ultimo || ultimo.role !== "assistant" || typeof ultimo.content === "string")
            return;
        const bloques = ultimo.content;
        if (!bloques.every((b) => b.type === "text"))
            return; // con herramientas no se toca
        ultimo.content = [{ type: "text", text: `${dicho}…` }];
    }
    // ── El turno: Claude escribe, la voz lo dice, las herramientas corren ────
    async correrTurno(turno) {
        if (this.cerrado || !this.cliente)
            return;
        if (turno.confirmado)
            this.comprometerUsuario(turno);
        if (turno.abort.signal.aborted)
            return;
        for (let vuelta = 0; vuelta < 6; vuelta++) {
            if (turno.abort.signal.aborted || this.cerrado)
                return;
            const mensajes = turno.confirmado
                ? this.mensajes
                : [...this.mensajes, { role: "user", content: turno.texto }];
            turno.textoEnviado = "";
            turno.streamDesdeMs = Date.now();
            let mensaje;
            try {
                const stream = this.cliente.messages.stream({
                    model: this.modelo,
                    max_tokens: 1024,
                    system: this.sistema,
                    tools: this.herramientas,
                    messages: mensajes,
                    // Caché automático del historial: cada turno relee lo anterior del caché.
                    cache_control: { type: "ephemeral" },
                    ...parametrosRazonamiento(this.modelo, this.pensar),
                }, { signal: turno.abort.signal });
                turno.stream = stream;
                stream.on("text", (delta) => this.escribir(turno, delta));
                mensaje = await stream.finalMessage();
                this.errores = 0;
            }
            catch (e) {
                this.contarUsoParcial(turno);
                if (turno.abort.signal.aborted) {
                    this.cerrarAbortado(turno);
                    return;
                }
                this.alFallarModelo(turno, e);
                return;
            }
            finally {
                turno.stream = null;
            }
            this.contarUso(mensaje.usage);
            // Respuesta anticipada: se escribió antes de saber si el cliente terminó.
            // Las herramientas NO corren hasta confirmarlo (podrían agendar algo que
            // el cliente no terminó de pedir).
            if (!turno.confirmado) {
                const ok = await Promise.race([
                    turno.confirmacion,
                    new Promise((r) => setTimeout(() => r(false), 5000)),
                ]);
                if (!ok || turno.abort.signal.aborted) {
                    if (!turno.confirmado)
                        this.descartar(turno);
                    return;
                }
            }
            const texto = mensaje.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
                .trim();
            const herramientas = mensaje.content.filter((b) => b.type === "tool_use");
            // El SDK instalado aún no tipa "refusal" (los modelos 5.x sí lo devuelven).
            if (mensaje.stop_reason === "refusal") {
                const aviso = "Perdón, con eso no te puedo ayudar por aquí. ¿Te ayudo con otra cosa?";
                this.cerrarTexto(turno);
                this.enviarTexto(turno, aviso, true);
                this.agregarMensaje({ role: "assistant", content: aviso });
                this.onTranscript?.(aviso, "assistant");
                return;
            }
            const contenido = mensaje.content.filter((b) => b.type !== "text" || b.text.trim().length > 0);
            if (contenido.length > 0)
                this.agregarMensaje({ role: "assistant", content: contenido });
            if (texto)
                this.onTranscript?.(texto, "assistant");
            this.cerrarTexto(turno);
            if (herramientas.length === 0 || mensaje.stop_reason !== "tool_use")
                return;
            // Frase de espera si el modelo no dijo nada antes de una herramienta lenta.
            if (!texto) {
                const lenta = herramientas.find((h) => realtime_1.FUNCIONES_CON_ESPERA.has(h.name));
                if (lenta)
                    this.enviarTexto(turno, (0, realtime_1.fraseEspera)(lenta.name, lenta.input), true);
            }
            const resultados = [];
            for (const h of herramientas) {
                resultados.push(await this.ejecutar(h));
            }
            this.agregarMensaje({ role: "user", content: resultados });
            // Colgar cierra la conversación: nada de una segunda despedida encima.
            if (this.colgarPedido || herramientas.some((h) => h.name === "colgar_llamada"))
                return;
            // El cliente habló mientras corría la herramienta: su nuevo turno (en
            // cola) verá los resultados y contestará a ambos.
            if (turno.abort.signal.aborted || turno.interrumpido)
                return;
        }
        console.warn(`[RELAY] Turno ${turno.id}: demasiadas vueltas de herramientas — se corta`);
    }
    async ejecutar(h) {
        if (!this.onFunctionCall) {
            return { type: "tool_result", tool_use_id: h.id, is_error: true, content: "Herramienta no disponible" };
        }
        let args = h.input && typeof h.input === "object" && !Array.isArray(h.input) ? h.input : null;
        if (!args) {
            return { type: "tool_result", tool_use_id: h.id, is_error: true, content: "Argumentos inválidos: vuelve a intentarlo con un objeto JSON." };
        }
        if (this.horaExplicita && Date.now() - this.horaExplicita.detectadaEl < 120_000) {
            args = (0, normalizar_hora_1.normalizarArgumentosConHora)(args, this.horaExplicita.hora);
        }
        console.log(`[RELAY] Herramienta ${h.name}(${JSON.stringify(args).slice(0, 300)})`);
        try {
            const resultado = await this.onFunctionCall(h.name, args, h.id);
            return { type: "tool_result", tool_use_id: h.id, content: JSON.stringify(resultado ?? { ok: true }).slice(0, 8000) };
        }
        catch (e) {
            console.error(`[RELAY] Error en ${h.name}:`, e instanceof Error ? e.message : e);
            return { type: "tool_result", tool_use_id: h.id, is_error: true, content: JSON.stringify({ error: "Error procesando la acción" }) };
        }
    }
    alFallarModelo(turno, e) {
        const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        console.error(`[RELAY] Claude falló (turno ${turno.id}):`, detalle.slice(0, 400));
        this.onErrorModelo?.(detalle);
        this.errores++;
        if (!turno.confirmado) {
            // Anticipada: se tira y el texto final abre un turno normal que reintenta.
            this.descartar(turno);
            return;
        }
        if (this.errores >= 3 || /credit balance|insufficient|authentication|invalid x-api-key|permission/i.test(detalle)) {
            // Llave o crédito: no se arregla solo en esta llamada ni en la siguiente.
            if (/credit balance|insufficient|authentication|invalid x-api-key|permission/i.test(detalle))
                marcarRelayCaido(detalle);
            this.onCaida?.(`Claude no responde: ${detalle.slice(0, 200)}`);
            return;
        }
        this.cerrarTexto(turno);
        this.enviarTexto(turno, "Perdón, se me fue la señal un segundo. ¿Me lo repites?", true);
    }
    /** Abortado a media respuesta: el historial guarda lo que sí se alcanzó a decir. */
    cerrarAbortado(turno) {
        if (!turno.confirmado)
            return;
        const dicho = turno.textoEnviado.trim();
        if (dicho) {
            this.agregarMensaje({ role: "assistant", content: `${dicho}…` });
            this.onTranscript?.(dicho, "assistant");
        }
        if (!turno.interrumpido)
            this.cerrarTexto(turno);
        else
            turno.textoAbierto = false; // Telnyx ya cortó esa frase
    }
    // ── Salida a la voz ──────────────────────────────────────────────────────
    escribir(turno, delta) {
        if (turno.abort.signal.aborted)
            return;
        const limpio = (0, relay_config_1.textoParaVoz)(delta);
        if (!limpio)
            return;
        if (!turno.confirmado) {
            turno.buffer += limpio;
            return;
        }
        this.enviarTexto(turno, limpio, false);
    }
    enviarTexto(turno, token, last) {
        if (this.cerrado || this.ws.readyState !== ws_1.default.OPEN)
            return;
        try {
            this.ws.send(JSON.stringify({ type: "text", token, last }));
        }
        catch {
            return;
        }
        this.uso.caracteres += token.length;
        const ahora = Date.now();
        // Un tramo nuevo de voz (tras un silencio) empieza su propio registro de eco.
        if (ahora > this.finHablaMs + COLA_ECO_MS)
            this.dichoReciente = "";
        const separador = this.fraseCerrada && this.dichoReciente ? " " : "";
        this.dichoReciente = (this.dichoReciente + separador + token).slice(-600);
        this.fraseCerrada = last;
        this.finHablaMs = Math.max(this.finHablaMs, ahora) + (0, relay_config_1.msParaDecir)(token);
        if (!turno)
            return;
        turno.textoEnviado += token;
        turno.textoAbierto = !last;
        if (turno.primerTextoMs == null && token.trim() && !turno.interno) {
            turno.primerTextoMs = Date.now();
            this.registrarLatencia(turno);
        }
    }
    cerrarTexto(turno) {
        if (!turno.textoAbierto)
            return;
        this.enviarTexto(turno, this.tokenVacioOk ? "" : " ", true);
    }
    registrarLatencia(t) {
        const fin = t.primerTextoMs;
        const fila = {
            totalMs: Math.max(0, fin - t.esperaDesdeMs),
            esperaMs: Math.max(0, (t.streamDesdeMs ?? fin) - t.esperaDesdeMs),
            modeloMs: Math.max(0, fin - (t.streamDesdeMs ?? fin)),
            temprano: t.especulativo,
        };
        this.latencias.push(fila);
        console.log(`[LATENCIA] turno ${this.latencias.length}: ${fila.totalMs} ms desde el texto final` +
            `${fila.temprano ? " (respuesta anticipada)" : ""} · modelo hasta primer texto ${fila.modeloMs} ms`);
    }
    // ── Consumo ──────────────────────────────────────────────────────────────
    contarUso(u) {
        if (!u)
            return;
        this.uso.entrada += u.input_tokens || 0;
        this.uso.salida += u.output_tokens || 0;
        this.uso.cacheLeido += u.cache_read_input_tokens || 0;
        this.uso.cacheEscrito += u.cache_creation_input_tokens || 0;
    }
    /** Una respuesta abortada también se cobra: lo que alcanzó a leer y escribir. */
    contarUsoParcial(turno) {
        try {
            this.contarUso(turno.stream?.currentMessage?.usage);
        }
        catch { /* sin datos */ }
    }
}
exports.MotorRelayTelnyx = MotorRelayTelnyx;
//# sourceMappingURL=relay.js.map