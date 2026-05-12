import { Request, Response } from "express";
import WebSocket from "ws";
import { config } from "../utils/config";

const VOCES_VALIDAS = new Set([
  "marin", "cedar", "alloy", "ash", "ballad", "echo", "sage", "verse",
]);

const PROMPT_PREVIEW =
  "Habla en español mexicano de forma natural y profesional. " +
  "Di EXACTAMENTE: 'Hola, soy tu asistente virtual. Así sonaré al contestar tus llamadas.' " +
  "No agregues nada más. Habla con tono cálido, natural y a velocidad normal.";

// Cache simple en memoria: voz → buffer WAV. Las voces no cambian, así que
// la primera vez generamos el preview y luego lo servimos directo.
const cache = new Map<string, Buffer>();

export async function previewVoz(req: Request, res: Response) {
  const voz = String(req.query.voz || "marin");
  if (!VOCES_VALIDAS.has(voz)) {
    return res.status(400).json({ error: "Voz no válida" });
  }

  try {
    let wav = cache.get(voz);
    if (!wav) {
      const mulaw = await generarPreview(voz);
      wav = construirWAV(mulaw);
      cache.set(voz, wav);
      console.log(`[PREVIEW] Generado y cacheado preview de "${voz}" (${wav.length} bytes)`);
    } else {
      console.log(`[PREVIEW] Sirviendo preview cacheado de "${voz}"`);
    }

    res.set({
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(wav.length),
    });
    res.send(wav);
  } catch (err: any) {
    console.error("[PREVIEW] Error:", err?.message || err);
    res.status(500).json({ error: err?.message || "Error generando preview" });
  }
}

function generarPreview(voz: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
    const ws = new WebSocket(url, {
      headers: {
        "Authorization": `Bearer ${config.openaiApiKey}`,
      },
    });

    const chunks: Buffer[] = [];
    let configurada = false;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      reject(new Error("Timeout generando preview"));
    }, 20000);

    const finalizar = (err: Error | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: "Eres una voz demo. Habla en español mexicano.",
          voice: voz,
          output_audio_format: "g711_ulaw",
          turn_detection: null,
        },
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "session.updated" && !configurada) {
          configurada = true;
          ws.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: PROMPT_PREVIEW,
            },
          }));
        }

        if (msg.type === "response.audio.delta" && msg.delta) {
          chunks.push(Buffer.from(msg.delta, "base64"));
        }

        if (msg.type === "response.done") {
          finalizar(null);
        }

        if (msg.type === "error") {
          finalizar(new Error(msg.error?.message || "OpenAI error"));
        }
      } catch {}
    });

    ws.on("error", (err) => finalizar(err));
    ws.on("close", () => finalizar(chunks.length > 0 ? null : new Error("WS cerrado sin audio")));
  });
}

// Envuelve audio mu-law (G.711) crudo en un contenedor WAV que cualquier
// navegador moderno reproduce nativamente. 8kHz mono — calidad telefónica
// (es exactamente lo que el cliente escucha en la llamada real).
function construirWAV(mulawData: Buffer): Buffer {
  const dataSize = mulawData.length;
  const header = Buffer.alloc(44);

  let o = 0;
  header.write("RIFF", o); o += 4;
  header.writeUInt32LE(36 + dataSize, o); o += 4;
  header.write("WAVE", o); o += 4;
  header.write("fmt ", o); o += 4;
  header.writeUInt32LE(16, o); o += 4;       // fmt chunk size
  header.writeUInt16LE(7, o);  o += 2;       // audioFormat: 7 = mu-law
  header.writeUInt16LE(1, o);  o += 2;       // channels: mono
  header.writeUInt32LE(8000, o); o += 4;     // sampleRate: 8 kHz
  header.writeUInt32LE(8000, o); o += 4;     // byteRate
  header.writeUInt16LE(1, o);  o += 2;       // blockAlign
  header.writeUInt16LE(8, o);  o += 2;       // bitsPerSample
  header.write("data", o); o += 4;
  header.writeUInt32LE(dataSize, o);

  return Buffer.concat([header, mulawData]);
}
