"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verificarFirmaTelnyx = verificarFirmaTelnyx;
exports.tokenStream = tokenStream;
exports.tokenStreamValido = tokenStreamValido;
exports.firmarSaliente = firmarSaliente;
exports.leerSaliente = leerSaliente;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../utils/config");
// ═══════════════════════════════════════════════════════════════════════════
// Seguridad del canal Telnyx.
//
// 1) Avisos HTTP (/telnyx/webhook): Telnyx los firma con ed25519. Firma
//    `${telnyx-timestamp}|${cuerpo crudo}` con SU llave privada; nosotros
//    verificamos con la pública de la cuenta (TELNYX_PUBLIC_KEY). Es la misma
//    verificación que Odin ya usa para el WhatsApp de Telnyx
//    (app/lib/whatsapp-cloud/firmas.ts).
//
// 2) WebSocket de audio (/ws-telnyx): Telnyx no firma el handshake del
//    WebSocket como Twilio. Lo cerramos nosotros: al contestar le damos a
//    Telnyx una URL con un token HMAC del call_control_id, firmado con nuestro
//    secreto. Solo quien vio ese `answer` (Telnyx) conoce la URL; un tercero no
//    puede abrir un stream contra nuestro OpenAI.
// ═══════════════════════════════════════════════════════════════════════════
// Prefijo DER de una llave pública ed25519 (SubjectPublicKeyInfo) para
// envolver los 32 bytes crudos que da el portal de Telnyx.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
function llavePublicaEd25519(texto) {
    try {
        const limpio = texto.trim();
        if (limpio.startsWith("-----BEGIN"))
            return crypto_1.default.createPublicKey(limpio);
        const bytes = Buffer.from(limpio, "base64");
        const der = bytes.length === 32 ? Buffer.concat([SPKI_ED25519, bytes]) : bytes;
        const llave = crypto_1.default.createPublicKey({ key: der, format: "der", type: "spki" });
        return llave.asymmetricKeyType === "ed25519" ? llave : null;
    }
    catch {
        return null;
    }
}
/**
 * Tolerancia de 5 min (la que recomienda Telnyx): un aviso de llamada que llega
 * más tarde ya no sirve para nada — la llamada se contestó o se cayó.
 */
function verificarFirmaTelnyx(cuerpoCrudo, firma, marcaDeTiempo, llavePublica, toleranciaSegundos = 300, ahoraMs = Date.now()) {
    if (!llavePublica || !firma || !marcaDeTiempo)
        return false;
    const t = marcaDeTiempo.trim();
    if (!/^\d+$/.test(t))
        return false;
    if (Math.abs(ahoraMs / 1000 - Number(t)) > toleranciaSegundos)
        return false;
    const llave = llavePublicaEd25519(llavePublica);
    if (!llave)
        return false;
    const bytesFirma = Buffer.from(firma.trim(), "base64");
    if (bytesFirma.length !== 64)
        return false;
    try {
        return crypto_1.default.verify(null, Buffer.from(`${t}|${cuerpoCrudo}`, "utf8"), llave, bytesFirma);
    }
    catch {
        return false;
    }
}
function secretoStream() {
    return config_1.config.voiceServerSecret || "";
}
/** Token del WebSocket para una llamada. Determinista: no hay que guardarlo. */
function tokenStream(callControlId, secreto = secretoStream()) {
    return crypto_1.default
        .createHmac("sha256", secreto || "dev-sin-secreto")
        .update(`ws-telnyx:${callControlId}`)
        .digest("base64url");
}
function tokenStreamValido(callControlId, token, secreto = secretoStream()) {
    if (!callControlId || !token)
        return false;
    const esperado = Buffer.from(tokenStream(callControlId, secreto));
    const recibido = Buffer.from(token);
    return esperado.length === recibido.length && crypto_1.default.timingSafeEqual(esperado, recibido);
}
const VIDA_SALIENTE_MS = 10 * 60_000;
function firmarSaliente(datos, ahoraMs = Date.now(), secreto = secretoStream()) {
    const pr = Buffer.from(JSON.stringify({ n: datos.n, c: datos.c, e: ahoraMs + VIDA_SALIENTE_MS, x: crypto_1.default.randomBytes(6).toString("hex") }), "utf8").toString("base64url");
    return { pr, t: tokenStream(`pr:${pr}`, secreto) };
}
function leerSaliente(pr, t, ahoraMs = Date.now(), secreto = secretoStream()) {
    if (!pr || !tokenStreamValido(`pr:${pr}`, t, secreto))
        return null;
    try {
        const d = JSON.parse(Buffer.from(pr, "base64url").toString("utf8"));
        if (typeof d?.n !== "string" || typeof d?.c !== "string" || typeof d?.e !== "number")
            return null;
        if (d.e < ahoraMs)
            return null;
        return { n: d.n, c: d.c };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=firma.js.map