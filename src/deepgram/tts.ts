import { config } from "../utils/config";
import { pcmToMulaw, bufferToBase64 } from "../utils/audio";

// Deepgram TTS: texto → audio mulaw base64 (listo para Twilio)
export async function textoAVoz(texto: string): Promise<string[]> {
  const chunks: string[] = [];

  // Dividir texto largo en oraciones para reducir latencia
  const oraciones = texto
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);

  for (const oracion of oraciones) {
    try {
      const response = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-es&encoding=mulaw&sample_rate=8000&container=none", {
        method: "POST",
        headers: {
          "Authorization": `Token ${config.deepgramApiKey}`,
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
      const base64Audio = bufferToBase64(audioBuffer);
      chunks.push(base64Audio);
    } catch (err) {
      console.error("[DEEPGRAM TTS] Error procesando oración:", err);
    }
  }

  return chunks;
}

// Versión streaming: envía cada oración conforme esté lista
export async function textoAVozStreaming(
  texto: string,
  onChunk: (base64Audio: string) => void
): Promise<void> {
  const oraciones = texto
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);

  for (const oracion of oraciones) {
    try {
      const response = await fetch("https://api.deepgram.com/v1/speak?model=aura-asteria-es&encoding=mulaw&sample_rate=8000&container=none", {
        method: "POST",
        headers: {
          "Authorization": `Token ${config.deepgramApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: oracion }),
      });

      if (!response.ok) continue;

      const arrayBuffer = await response.arrayBuffer();
      const base64Audio = bufferToBase64(Buffer.from(arrayBuffer));
      onChunk(base64Audio);
    } catch (err) {
      console.error("[DEEPGRAM TTS] Error streaming:", err);
    }
  }
}
