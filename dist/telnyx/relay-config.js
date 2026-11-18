"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// Piezas PURAS del motor de voz de Telnyx (Conversation Relay). Sin red ni
// estado: se prueban solas en tests/relay.test.ts.
//
// Conversation Relay = Telnyx contesta, transcribe al cliente (Deepgram) y
// habla con SUS voces (Ultra); nosotros recibimos texto por un WebSocket y
// mandamos texto de vuelta. Quien piensa es Claude (src/telnyx/relay.ts).
// ═══════════════════════════════════════════════════════════════════════════
Object.defineProperty(exports, "__esModule", { value: true });
exports.TARIFA_RELAY_USD = exports.AJUSTES_RELAY_DEFAULT = exports.VOCES_OPENAI = void 0;
exports.esVozTelnyx = esVozTelnyx;
exports.vozParaOpenAI = vozParaOpenAI;
exports.velocidadTelnyx = velocidadTelnyx;
exports.normalizarAjustesRelay = normalizarAjustesRelay;
exports.configTranscripcion = configTranscripcion;
exports.configRelay = configRelay;
exports.intentosSupresion = intentosSupresion;
exports.costoRelayUsd = costoRelayUsd;
exports.textoParaVoz = textoParaVoz;
exports.normalizarParaComparar = normalizarParaComparar;
exports.mismoTurno = mismoTurno;
exports.pareceEco = pareceEco;
exports.msParaDecir = msParaDecir;
/** Voces de gpt-realtime que acepta el motor de OpenAI. */
exports.VOCES_OPENAI = new Set(["marin", "cedar", "alloy", "ash", "ballad", "echo", "sage", "verse"]);
/**
 * ¿Es una voz de Telnyx? ("Telnyx.Ultra.<uuid>", "Telnyx.KokoroTTS.ef_dora"…).
 * Es lo que decide el motor: una línea de Telnyx con voz de Telnyx usa
 * Conversation Relay; con voz de OpenAI, el motor de siempre.
 */
function esVozTelnyx(voz) {
    return typeof voz === "string" && /^Telnyx\.[A-Za-z0-9]+\.[A-Za-z0-9_.\-]{1,80}$/.test(voz);
}
/**
 * La voz que puede usar el motor de OpenAI. Si el dueño eligió una de Telnyx
 * pero la llamada entró por Twilio (o por el motor de OpenAI), se usa Marin: un
 * nombre que OpenAI no conoce tumbaría la sesión y el cliente oiría el aviso de
 * "no disponible".
 */
function vozParaOpenAI(voz) {
    return typeof voz === "string" && exports.VOCES_OPENAI.has(voz) ? voz : "marin";
}
/** Velocidad válida para las voces Ultra (0.6–1.5). null = la de la voz. */
function velocidadTelnyx(v) {
    const n = Number(v);
    if (v === null || v === undefined || !Number.isFinite(n) || n <= 0)
        return null;
    const acotada = Math.min(1.5, Math.max(0.6, n));
    return Math.abs(acotada - 1) < 0.01 ? null : Number(acotada.toFixed(2));
}
exports.AJUSTES_RELAY_DEFAULT = {
    velocidad: 1,
    idioma: "es",
    finDeTurno: "normal",
    interrupciones: true,
    reconocimiento: process.env.VOZ_RELAY_STT === "deepgram/nova-3" ? "nova3" : "flux",
    cerebro: "rapido",
    pensar: process.env.VOZ_RELAY_PENSAR === "1",
    teclado: true,
    palabrasClave: [],
};
const unoDe = (v, ok, def) => typeof v === "string" && ok.includes(v) ? v : def;
function normalizarAjustesRelay(raw) {
    const r = (raw && typeof raw === "object" ? raw : {});
    const d = exports.AJUSTES_RELAY_DEFAULT;
    const vel = Number(r.velocidad);
    return {
        velocidad: Number.isFinite(vel) && vel > 0 ? Math.min(1.25, Math.max(0.8, vel)) : d.velocidad,
        idioma: unoDe(r.idioma, ["es", "en", "auto"], d.idioma),
        finDeTurno: unoDe(r.finDeTurno, ["rapido", "normal", "paciente"], d.finDeTurno),
        interrupciones: typeof r.interrupciones === "boolean" ? r.interrupciones : d.interrupciones,
        reconocimiento: unoDe(r.reconocimiento, ["flux", "nova3"], d.reconocimiento),
        cerebro: unoDe(r.cerebro, ["rapido", "listo"], d.cerebro),
        pensar: typeof r.pensar === "boolean" ? r.pensar : d.pensar,
        teclado: typeof r.teclado === "boolean" ? r.teclado : d.teclado,
        palabrasClave: (Array.isArray(r.palabrasClave) ? r.palabrasClave : [])
            .map((p) => String(p ?? "").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 40))
            .filter((p) => p.length >= 2)
            .slice(0, 20),
    };
}
/** Umbrales de fin de turno de Flux: confianza para cerrar y para avisar temprano. */
const FIN_DE_TURNO = {
    rapido: { eot: 0.6, eager: 0.4, finMs: 450 },
    normal: { eot: 0.7, eager: 0.5, finMs: 600 },
    paciente: { eot: 0.8, eager: 0.6, finMs: 1000 },
};
/**
 * Reconocimiento de voz. Default: Deepgram **Flux multilenguaje**, que trae su
 * propio detector de fin de turno y avisa ANTES del texto final
 * ("eagerEndOfTurn") — con eso empezamos a pensar la respuesta mientras el
 * cliente termina la frase. Nova-3 es el plan B (ajuste "reconocimiento").
 * Las palabras clave (nombres del negocio, productos) van como `keyterms`.
 */
function configTranscripcion(ajustes = exports.AJUSTES_RELAY_DEFAULT) {
    const umbral = FIN_DE_TURNO[ajustes.finDeTurno];
    const keyterms = ajustes.palabrasClave.length ? { keyterms: ajustes.palabrasClave } : {};
    if (ajustes.reconocimiento === "nova3") {
        return {
            transcription_engine: "Deepgram",
            transcription_engine_config: {
                transcription_model: "deepgram/nova-3",
                language: ajustes.idioma === "auto" ? "auto_detect" : ajustes.idioma,
                // Nova-3 cierra el enunciado tras 1 s de silencio por default: es
                // latencia pura que el cliente oye.
                utterance_end_ms: Number(process.env.VOZ_RELAY_FIN_MS) || umbral.finMs,
                ...keyterms,
            },
        };
    }
    const eot = Math.min(0.9, Math.max(0.5, Number(process.env.VOZ_RELAY_EOT) || umbral.eot));
    const eager = Math.min(0.7, Math.max(0.3, Number(process.env.VOZ_RELAY_EOT_TEMPRANO) || umbral.eager));
    return {
        transcription_engine: "Deepgram",
        transcription_engine_config: {
            transcription_model: "deepgram/flux-multi",
            language: ajustes.idioma,
            eot_threshold: eot,
            eager_eot_threshold: Math.min(eager, eot),
            ...keyterms,
        },
    };
}
/**
 * El `conversation_relay_config` que va en el `answer` (entrantes) o en el
 * `dial` (llamada de prueba). `custom_parameters` regresa tal cual en el frame
 * `setup` del WebSocket: ahí viajan el número del negocio, quién llama y la
 * sucursal de desvío, igual que el client_state del motor de OpenAI.
 */
function configRelay(opts) {
    const ajustes = normalizarAjustesRelay(opts.ajustes);
    const velocidad = velocidadTelnyx(opts.ajustes ? ajustes.velocidad : opts.velocidad);
    const stt = configTranscripcion(ajustes);
    // La voz habla en el idioma del agente; con "auto" sigue en español (el
    // reconocimiento sí detecta y el modelo contesta en el idioma del cliente).
    const idiomaVoz = process.env.VOZ_RELAY_IDIOMA || (ajustes.idioma === "en" ? "en" : "es");
    // Solo la VOZ del cliente corta al agente (un tono del teclado no); con las
    // interrupciones apagadas, el agente termina su frase siempre.
    const interrumpe = ajustes.interrupciones ? "speech" : "none";
    return {
        url: opts.url,
        voice: opts.voz,
        tts_provider: "telnyx",
        ...(velocidad != null ? { voice_settings: { type: "telnyx", voice_speed: velocidad } } : {}),
        language: idiomaVoz,
        ...stt,
        interruptible: interrumpe,
        // El saludo no se corta: es una sola frase y su propio eco lo cortaba.
        interruptible_greeting: "none",
        dtmf_detection: ajustes.teclado,
        custom_parameters: opts.parametros,
    };
}
// ── Audio del cliente: eco y voz baja (17-nov-2026) ─────────────────────────
// Dos quejas de la primera llamada real: el agente se oía a sí mismo (su voz
// regresaba por el micrófono del cliente y se contestaba) y a quien habla
// bajito no lo entendía. Las dos se atacan ANTES de transcribir, con la
// supresión de ruido de Telnyx sobre la voz del cliente:
//  - "voice focus" de ai-coustics aísla a quien habla pegado al teléfono: el
//    eco del agente (que sale por la bocina y regresa más débil) se apaga.
//  - `voice_gain` sube la voz que sí pasa: quien habla bajito llega al
//    reconocimiento con volumen normal. ai-coustics está afinado para
//    reconocimiento de voz, no para oídos humanos (US$0.003/min).
// `direction: inbound` = el audio que ENTRA a Telnyx desde el cliente (así lo
// define la referencia de la API y la guía de SIP; la guía de Programmable
// Voice dice lo contrario: si algún día suena raro, `VOZ_SUPRESION_DIRECCION`).
// Si Telnyx rechaza la combinación, se intenta la siguiente: nunca tumba la llamada.
const acotar = (n, min, max) => Math.min(max, Math.max(min, n));
function intentosSupresion(env = process.env) {
    const motor = (env.VOZ_SUPRESION ?? "quail_voice_focus_s").trim();
    if (!motor || /^(0|no|off|apagado)$/i.test(motor))
        return [];
    const dir = env.VOZ_SUPRESION_DIRECCION;
    const direction = dir === "outbound" || dir === "both" ? dir : "inbound";
    const ganancia = Number(env.VOZ_SUPRESION_GANANCIA);
    const intensidad = Number(env.VOZ_SUPRESION_INTENSIDAD);
    const aic = {
        voice_gain: Number(acotar(Number.isFinite(ganancia) && ganancia > 0 ? ganancia : 1.6, 0.1, 4).toFixed(2)),
        enhancement_level: Number(acotar(Number.isFinite(intensidad) && intensidad >= 0 ? intensidad : 0.8, 0, 1).toFixed(2)),
    };
    const esAic = (m) => m === "AiCoustics" || m.startsWith("aic_") || m.startsWith("quail_");
    const intentos = [];
    const agregar = (m) => {
        if (esAic(m))
            intentos.push({ direction, noise_suppression_engine: m, noise_suppression_engine_config: aic });
        if (m === "Krisp") {
            intentos.push({
                direction,
                noise_suppression_engine: m,
                noise_suppression_engine_config: { model: "krisp-viva-tel-v2.kef", suppression_level: 90 },
            });
        }
        intentos.push({ direction, noise_suppression_engine: m });
    };
    agregar(motor);
    if (esAic(motor) && motor !== "AiCoustics")
        agregar("AiCoustics");
    return intentos;
}
// ── Costos (hoja pública de Telnyx, nov-2026) ───────────────────────────────
// Conversation Relay: $0.05/min de plataforma. La voz Ultra se cobra por
// carácter y el reconocimiento por minuto. Telnyx no aclara si Relay ya los
// incluye (el AI Assistant sí); registramos lo CONSERVADOR —todo sumado— hasta
// verlo en una factura real.
exports.TARIFA_RELAY_USD = {
    relayPorMinuto: 0.05,
    ttsUltraPorCaracter: 0.000032,
    sttPorMinuto: 0.0074,
    /** Limpieza de la voz del cliente (ai-coustics), si quedó encendida. */
    supresionPorMinuto: 0.003,
};
function costoRelayUsd(segundos, caracteresTts, supresion = false) {
    const minutos = Math.ceil(Math.max(0, segundos) / 60);
    const porMinuto = exports.TARIFA_RELAY_USD.relayPorMinuto + exports.TARIFA_RELAY_USD.sttPorMinuto + (supresion ? exports.TARIFA_RELAY_USD.supresionPorMinuto : 0);
    const total = minutos * porMinuto +
        Math.max(0, caracteresTts) * exports.TARIFA_RELAY_USD.ttsUltraPorCaracter;
    return Number(total.toFixed(6));
}
// ── Texto que se convierte en voz ───────────────────────────────────────────
/**
 * Limpia lo que el modelo escribe antes de mandarlo al TTS: markdown, emojis y
 * acotaciones entre corchetes se leerían en voz alta ("asterisco asterisco").
 * Se aplica por fragmento, así que no puede depender de ver la frase completa.
 */
function textoParaVoz(fragmento) {
    return fragmento
        .replace(/[*_#`>|]+/g, "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/‍|️/g, "");
}
/** Normaliza para comparar el texto "temprano" con el final (eager vs final). */
function normalizarParaComparar(texto) {
    return texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9ñ ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/** ¿El final dice lo mismo que el temprano? Entonces la respuesta que ya preparamos sirve. */
function mismoTurno(temprano, final) {
    const a = normalizarParaComparar(temprano);
    const b = normalizarParaComparar(final);
    return a.length > 0 && a === b;
}
// ── Eco: el agente oyéndose a sí mismo (17-nov-2026) ──────────────────────
// En una llamada (sobre todo en altavoz o celular) parte de la voz del agente
// regresa por el micrófono del cliente. Telnyx la transcribe como si la
// hubiera dicho el cliente y el agente se contestaba solo: dijo "buenas
// noches, habla Sofía", oyó "Ya, buenas noches. Habla Sophie" y respondió
// "Hola Sophie, mucho gusto". Un texto que llega MIENTRAS el agente habla (o
// justo al terminar) y que repite SUS palabras es eco y se descarta.
/** Forma "fonética" mínima para comparar palabras transcritas (Sophie ≈ Sofía). */
function fonetica(p) {
    return p.replace(/ph/g, "f").replace(/h/g, "").replace(/v/g, "b").replace(/z/g, "s").replace(/ll/g, "y").replace(/c([ei])/g, "s$1");
}
function distancia(a, b) {
    if (Math.abs(a.length - b.length) > 2)
        return 3;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++)
        d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}
function mismaPalabra(a, b) {
    if (a === b)
        return true;
    const fa = fonetica(a);
    const fb = fonetica(b);
    if (fa === fb)
        return true;
    return fa.length >= 4 && fb.length >= 4 && distancia(fa, fb) <= 1;
}
/** Muletillas que la transcripción mete solas ("Ya, buenas noches…"). */
const MULETILLAS = new Set(["ya", "eh", "em", "mm", "mmm", "ah", "oh", "este", "pues", "aja"]);
/** Palabras de RESPUESTA: si el cliente las dice y el agente no, es el cliente. */
const RESPUESTAS = new Set(["si", "no", "ok", "okay", "va", "sale", "claro", "exacto", "correcto", "perfecto", "gracias", "orale", "nel"]);
/**
 * ¿Lo que "dijo el cliente" es la voz del propio agente regresando por la
 * línea? El eco repite las palabras del agente EN ORDEN y llega mientras habla
 * o justo al terminar.
 *  - `hablando`: el agente seguía hablando (o Telnyx lo acababa de callar).
 *    Basta con 3 palabras suyas en orden, o con 1–2 si son el PRINCIPIO de lo
 *    que dijo (el eco de "Buenas noches" llega mientras suena el resto).
 *  - `cola`: ya había terminado hace un instante. Ahí el cliente ya puede estar
 *    contestando, y contestar una pregunta de opciones repite sus palabras
 *    ("¿martes o jueves?" → "El martes"), así que se exige más: 3+ palabras y
 *    casi todas en orden.
 * Si el cliente dice una palabra de respuesta ("sí", "no", "claro") que el
 * agente no dijo, nunca es eco.
 */
function pareceEco(cliente, agente, modo = "hablando") {
    const pc = normalizarParaComparar(cliente).split(" ").filter((p) => p && !MULETILLAS.has(p));
    const pa = normalizarParaComparar(agente).split(" ").filter(Boolean);
    if (pc.length === 0 || pa.length === 0)
        return false;
    if (pc.some((p) => RESPUESTAS.has(p) && !pa.includes(p)))
        return false;
    // Cuántas palabras del cliente aparecen en lo del agente, en el mismo orden.
    let j = 0;
    let coinciden = 0;
    let ultimaPos = -1;
    for (const p of pc) {
        for (let k = j; k < pa.length; k++) {
            if (mismaPalabra(p, pa[k])) {
                coinciden++;
                ultimaPos = k;
                j = k + 1;
                break;
            }
        }
    }
    if (pc.length <= 2) {
        // Eco del principio: "buenas noches" de "Buenas noches, habla Sofía…".
        return modo === "hablando" && coinciden === pc.length && ultimaPos <= pc.length;
    }
    if (coinciden < 3)
        return false;
    const permitidas = modo === "hablando" ? Math.floor(pc.length * 0.3) : pc.length >= 6 ? 1 : 0;
    return pc.length - coinciden <= permitidas;
}
/** Milisegundos aproximados que tarda en decirse un texto (≈14 caracteres por segundo). */
function msParaDecir(texto) {
    return Math.round((texto.trim().length / 14) * 1000);
}
//# sourceMappingURL=relay-config.js.map