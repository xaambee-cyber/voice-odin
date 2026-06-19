"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.textoAVoz = textoAVoz;
exports.textoAVozStreaming = textoAVozStreaming;
const config_1 = require("../utils/config");
const audio_1 = require("../utils/audio");
// Deepgram TTS: texto → audio mulaw base64 (listo para Twilio)
async function textoAVoz(texto) {
    const chunks = [];
    // Dividir texto largo en oraciones para reducir latencia
    const oraciones = texto
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 0);
    for (const oracion of oraciones) {
        try {
            const response = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-es&encoding=mulaw&sample_rate=8000&container=none", {
                method: "POST",
                headers: {
                    "Authorization": `Token ${config_1.config.deepgramApiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text: oracion }),
            });
            if (!response.ok) {
                console.error("[DEEPGRAM TTS] Error:", response.status, await response.text());
                continue;
            }
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = Buffer.from(arrayBuffer);
            // El audio ya viene en mulaw 8kHz (lo pedimos así en la URL)
            const base64Audio = (0, audio_1.bufferToBase64)(audioBuffer);
            chunks.push(base64Audio);
        }
        catch (err) {
            console.error("[DEEPGRAM TTS] Error procesando oración:", err);
        }
    }
    return chunks;
}
// Versión streaming: envía cada oración conforme esté lista
async function textoAVozStreaming(texto, onChunk) {
    const oraciones = texto
        .split(/(?<=[.!?])\s+/)
        .filter(s => s.trim().length > 0);
    for (const oracion of oraciones) {
        try {
            const response = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-es&encoding=mulaw&sample_rate=8000&container=none", {
                method: "POST",
                headers: {
                    "Authorization": `Token ${config_1.config.deepgramApiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text: oracion }),
            });
            if (!response.ok)
                continue;
            const arrayBuffer = await response.arrayBuffer();
            const base64Audio = (0, audio_1.bufferToBase64)(Buffer.from(arrayBuffer));
            onChunk(base64Audio);
        }
        catch (err) {
            console.error("[DEEPGRAM TTS] Error streaming:", err);
        }
    }
}
//# sourceMappingURL=tts.js.map