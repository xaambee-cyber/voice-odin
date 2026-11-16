"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// Piezas PURAS del canal Telnyx (sin red, sin estado): se prueban solas en
// tests/telnyx.test.ts.
//
// Telnyx no habla TwiML aquí: usamos su Call Control (la API nativa). Cada
// llamada manda avisos JSON firmados a /telnyx/webhook y nosotros respondemos
// con comandos (answer, hangup, transfer...). Lo que Twilio nos daba como
// parámetros del <Stream> (número, quién llama, desde qué sucursal se desvió)
// viaja aquí dentro de `client_state`: un base64 que Telnyx nos devuelve en
// cada aviso siguiente y en el mensaje "start" del WebSocket.
// ═══════════════════════════════════════════════════════════════════════════
Object.defineProperty(exports, "__esModule", { value: true });
exports.TARIFA_TELNYX_MX_USD = void 0;
exports.codificarEstado = codificarEstado;
exports.decodificarEstado = decodificarEstado;
exports.normalizarE164 = normalizarE164;
exports.numeroLlamante = numeroLlamante;
exports.numeroDeDiversion = numeroDeDiversion;
exports.costoTelefoniaTelnyxUsd = costoTelefoniaTelnyxUsd;
exports.debeRechazarSinContestar = debeRechazarSinContestar;
exports.msDe = msDe;
exports.segundosConHumano = segundosConHumano;
function codificarEstado(estado) {
    return Buffer.from(JSON.stringify(estado), "utf8").toString("base64");
}
function decodificarEstado(b64) {
    if (typeof b64 !== "string" || !b64)
        return null;
    try {
        const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        if (obj && typeof obj === "object" && typeof obj.k === "string")
            return obj;
    }
    catch {
        // client_state ajeno (otro sistema) o corrupto: se ignora.
    }
    return null;
}
/**
 * El número en E.164 con "+", que es como Odin lo guarda en
 * `config_voz.numero_twilio` (y con lo que `config-llamada` busca el negocio).
 * Telnyx ya manda "+52…", pero si llegara sin "+" la búsqueda fallaría en
 * silencio y la llamada se despediría como "no disponible".
 */
function normalizarE164(numero) {
    const s = String(numero ?? "").trim();
    if (!s)
        return "";
    if (s.startsWith("+"))
        return s;
    const digitos = s.replace(/\D/g, "");
    return digitos.length >= 10 && digitos === s ? `+${digitos}` : s;
}
/** Quién llama, sin "+", igual que el `From.replace("+","")` del lado Twilio. */
function numeroLlamante(from) {
    return String(from ?? "").trim().replace("+", "");
}
/**
 * El equivalente del `ForwardedFrom` de Twilio. Cuando el dueño activa el
 * desvío (`**61*…`), Telcel/AT&T/Movistar mandan la llamada con una cabecera
 * SIP `Diversion` que trae el número que el cliente marcó originalmente, p.ej.
 *   <sip:+524611234567@10.0.0.1;user=phone>;reason=no-answer;counter=1
 *   <tel:+524611234567>;reason=unconditional
 * Telnyx la entrega en `payload.sip_headers` de `call.initiated`. Devolvemos los
 * dígitos SIN "+" (como Twilio entregaba ForwardedFrom ya limpio), o "" si no
 * vino desviada.
 */
function numeroDeDiversion(sipHeaders) {
    if (!Array.isArray(sipHeaders))
        return "";
    const cab = sipHeaders.find((h) => typeof h?.name === "string" && h.name.toLowerCase() === "diversion");
    if (!cab || typeof cab.value !== "string")
        return "";
    // Si hubo desvíos encadenados vienen varias, y la PRIMERA es quien desvió más
    // recientemente (RFC 5806). Es la misma semántica que el ForwardedFrom de
    // Twilio ("el número de quien desvió"), y la que necesita el anti-rebote: el
    // humano que no contestó es quien nos regresa la llamada.
    const primera = cab.value.split(/,(?=\s*<)/)[0] ?? "";
    const m = primera.match(/(?:sip|sips|tel):\+?([0-9]{7,15})/i);
    return m ? m[1] : "";
}
/**
 * Tarifa de Telnyx para México (hoja pública, nov-2026), en USD por minuto:
 * entrada a número local + cargo de Voice API + audio en vivo al agente.
 * Se redondea al minuto por llamada, igual que el cálculo de Twilio, para que
 * el costo registrado sea conservador mientras no confirmemos el redondeo real.
 */
exports.TARIFA_TELNYX_MX_USD = {
    entradaLocal: 0.005,
    entradaMovil: 0.009,
    voiceApi: 0.002,
    streaming: 0.0035,
};
function costoTelefoniaTelnyxUsd(segundos, tipo = "local") {
    const minutos = Math.ceil(Math.max(0, segundos) / 60);
    const entrada = tipo === "movil" ? exports.TARIFA_TELNYX_MX_USD.entradaMovil : exports.TARIFA_TELNYX_MX_USD.entradaLocal;
    const porMinuto = entrada + exports.TARIFA_TELNYX_MX_USD.voiceApi + exports.TARIFA_TELNYX_MX_USD.streaming;
    return Number((minutos * porMinuto).toFixed(6));
}
function debeRechazarSinContestar(gate) {
    if (!gate?.bloqueado)
        return false;
    return gate.motivo === "agente_apagado" || gate.motivo === "linea_apagada";
}
/** Milisegundos de una fecha ISO de Telnyx, o null. */
function msDe(iso) {
    if (typeof iso !== "string")
        return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}
/** Segundos que habló el humano: desde que contestó hasta que colgó. */
function segundosConHumano(contestoMs, colgoMs) {
    if (contestoMs == null || colgoMs == null || colgoMs <= contestoMs)
        return 0;
    return Math.round((colgoMs - contestoMs) / 1000);
}
//# sourceMappingURL=eventos.js.map