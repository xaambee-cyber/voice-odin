import dotenv from "dotenv";
dotenv.config();

export const config = {
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

/**
 * Base HTTPS pública de este server, derivada de VOICE_SERVER_URL (que viene en
 * wss://). Twilio la necesita para los callbacks que ejecuta él mismo — hoy el
 * `statusCallback` del <Number> de las transferencias a humano.
 */
export function urlPublicaHttps(): string {
  const host = config.voiceServerUrl
    .replace(/^wss:\/\//, "")
    .replace(/^ws:\/\//, "")
    .replace(/^https:\/\//, "")
    .replace(/^http:\/\//, "")
    .replace(/\/+$/, "");
  return `https://${host}`;
}
