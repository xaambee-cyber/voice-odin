"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.config = {
    // Twilio
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
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
//# sourceMappingURL=config.js.map