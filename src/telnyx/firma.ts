import crypto from "crypto";
import { config } from "../utils/config";

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

function llavePublicaEd25519(texto: string): crypto.KeyObject | null {
  try {
    const limpio = texto.trim();
    if (limpio.startsWith("-----BEGIN")) return crypto.createPublicKey(limpio);
    const bytes = Buffer.from(limpio, "base64");
    const der = bytes.length === 32 ? Buffer.concat([SPKI_ED25519, bytes]) : bytes;
    const llave = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return llave.asymmetricKeyType === "ed25519" ? llave : null;
  } catch {
    return null;
  }
}

/**
 * Tolerancia de 5 min (la que recomienda Telnyx): un aviso de llamada que llega
 * más tarde ya no sirve para nada — la llamada se contestó o se cayó.
 */
export function verificarFirmaTelnyx(
  cuerpoCrudo: string,
  firma: string | undefined | null,
  marcaDeTiempo: string | undefined | null,
  llavePublica: string,
  toleranciaSegundos = 300,
  ahoraMs = Date.now(),
): boolean {
  if (!llavePublica || !firma || !marcaDeTiempo) return false;
  const t = marcaDeTiempo.trim();
  if (!/^\d+$/.test(t)) return false;
  if (Math.abs(ahoraMs / 1000 - Number(t)) > toleranciaSegundos) return false;
  const llave = llavePublicaEd25519(llavePublica);
  if (!llave) return false;
  const bytesFirma = Buffer.from(firma.trim(), "base64");
  if (bytesFirma.length !== 64) return false;
  try {
    return crypto.verify(null, Buffer.from(`${t}|${cuerpoCrudo}`, "utf8"), llave, bytesFirma);
  } catch {
    return false;
  }
}

function secretoStream(): string {
  return config.voiceServerSecret || "";
}

/** Token del WebSocket para una llamada. Determinista: no hay que guardarlo. */
export function tokenStream(callControlId: string, secreto = secretoStream()): string {
  return crypto
    .createHmac("sha256", secreto || "dev-sin-secreto")
    .update(`ws-telnyx:${callControlId}`)
    .digest("base64url");
}

export function tokenStreamValido(
  callControlId: string,
  token: string | null | undefined,
  secreto = secretoStream(),
): boolean {
  if (!callControlId || !token) return false;
  const esperado = Buffer.from(tokenStream(callControlId, secreto));
  const recibido = Buffer.from(token);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}
