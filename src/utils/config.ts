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

  // Odin
  odinAppUrl: process.env.ODIN_APP_URL || "https://odin-two-indol.vercel.app",

  // Server
  port: parseInt(process.env.PORT || "3001"),
  voiceServerUrl: process.env.VOICE_SERVER_URL || "wss://voice-odin.duckdns.org",
};
