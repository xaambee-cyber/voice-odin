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
exports.costoRelayUsd = costoRelayUsd;
exports.textoParaVoz = textoParaVoz;
exports.normalizarParaComparar = normalizarParaComparar;
exports.mismoTurno = mismoTurno;
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
        interruptible_greeting: interrumpe,
        dtmf_detection: ajustes.teclado,
        custom_parameters: opts.parametros,
    };
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
};
function costoRelayUsd(segundos, caracteresTts) {
    const minutos = Math.ceil(Math.max(0, segundos) / 60);
    const total = minutos * (exports.TARIFA_RELAY_USD.relayPorMinuto + exports.TARIFA_RELAY_USD.sttPorMinuto) +
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
/** Milisegundos aproximados que tarda en decirse un texto (≈14 caracteres por segundo). */
function msParaDecir(texto) {
    return Math.round((texto.trim().length / 14) * 1000);
}
//# sourceMappingURL=relay-config.js.map