"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.urlPublicaHttps = urlPublicaHttps;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.config = {
    // Twilio
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
    // Telnyx (segundo proveedor de telefonía, en paralelo a Twilio). Un número de
    // Telnyx manda sus llamadas a /telnyx/webhook (Call Control); los de Twilio
    // siguen entrando por /twiml exactamente igual que siempre.
    //   TELNYX_API_KEY     llave v2 de la cuenta (contestar, colgar, transferir).
    //   TELNYX_PUBLIC_KEY  llave PÚBLICA ed25519 de la cuenta: verifica cada aviso.
    telnyxApiKey: process.env.TELNYX_API_KEY || "",
    telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY || "",
    // Deepgram
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
    // Claude
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    // OpenAI (GPT-4o-mini → baja latencia)
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    // Odin
    odinAppUrl: process.env.ODIN_APP_URL || "https://odin-two-indol.vercel.app",
    // Secret compartido con Odin — se envía en Authorization: Bearer <secret>
    // para que Odin valide que la petición viene del voice server legítimo.
    voiceServerSecret: process.env.VOICE_SERVER_SECRET || "",
    // Server
    port: parseInt(process.env.PORT || "3001"),
    voiceServerUrl: process.env.VOICE_SERVER_URL || "wss://voice-odin.duckdns.org",
};
/**
 * Base HTTPS pública de este server, derivada de VOICE_SERVER_URL (que viene en
 * wss://). Twilio la necesita para los callbacks que ejecuta él mismo — hoy el
 * `statusCallback` del <Number> de las transferencias a humano.
 */
function urlPublicaHttps() {
    const host = exports.config.voiceServerUrl
        .replace(/^wss:\/\//, "")
        .replace(/^ws:\/\//, "")
        .replace(/^https:\/\//, "")
        .replace(/^http:\/\//, "")
        .replace(/\/+$/, "");
    return `https://${host}`;
}
//# sourceMappingURL=config.js.map