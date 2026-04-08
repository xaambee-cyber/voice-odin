import WebSocket from "ws";
import { config } from "../utils/config";

export class OpenAIRealtime {
  private ws: WebSocket | null = null;
  private onAudioDelta: ((base64Audio: string) => void) | null = null;
  private onTranscript: ((texto: string, role: "user" | "assistant") => void) | null = null;
  private onInterrupcion: (() => void) | null = null;
  private conectado: boolean = false;
  private systemPrompt: string;
  private respondiendo: boolean = false;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  async conectar(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview";

      this.ws = new WebSocket(url, {
        headers: {
          "Authorization": `Bearer ${config.openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        this.conectado = true;
        console.log("[REALTIME] Conectado a OpenAI");

        this.ws!.send(JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: this.systemPrompt,
            voice: "shimmer",
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: "whisper-1",
              language: "es",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
            temperature: 0.7,
            max_response_output_tokens: 300,
          },
        }));

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {}
      });

      this.ws.on("error", (err) => {
        console.error("[REALTIME] Error:", err.message);
        this.conectado = false;
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[REALTIME] Cerrado: ${code} ${reason}`);
        this.conectado = false;
      });
    });
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case "session.created":
        console.log("[REALTIME] Sesión creada");
        break;

      case "session.updated":
        console.log("[REALTIME] Sesión configurada → enviando saludo");
        if (this.ws && this.conectado) {
          this.ws.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: "Saluda brevemente al usuario en español mexicano. Di algo como 'Hola, buenas tardes, ¿en qué te puedo ayudar?' de forma natural y corta.",
            },
          }));
        }
        break;

      case "response.audio.delta":
        if (msg.delta && this.onAudioDelta) {
          this.onAudioDelta(msg.delta);
        }
        break;

      case "response.audio_transcript.done":
        if (msg.transcript && this.onTranscript) {
          this.onTranscript(msg.transcript, "assistant");
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript && this.onTranscript) {
          this.onTranscript(msg.transcript, "user");
          console.log(`[REALTIME] Usuario: "${msg.transcript}"`);
        }
        break;

      case "input_audio_buffer.speech_started":
        console.log("[REALTIME] Usuario empezó a hablar");
        if (this.respondiendo) {
          console.log("[REALTIME] INTERRUPCIÓN detectada → cancelando respuesta");
          this.cancelarRespuesta();
          if (this.onInterrupcion) {
            this.onInterrupcion();
          }
        }
        break;

      case "input_audio_buffer.speech_stopped":
        console.log("[REALTIME] Usuario dejó de hablar");
        break;

      case "response.created":
        this.respondiendo = true;
        console.log("[REALTIME] Generando respuesta...");
        break;

      case "response.done":
        this.respondiendo = false;
        const status = msg.response?.status;
        if (status === "cancelled") {
          console.log("[REALTIME] Respuesta cancelada (interrupción)");
        } else {
          console.log("[REALTIME] Respuesta completa");
        }
        break;

      case "error":
        console.error("[REALTIME] Error:", JSON.stringify(msg.error));
        break;

      case "rate_limits.updated":
        // Ignorar silenciosamente
        break;
    }
  }

  enviarAudio(base64Audio: string) {
    if (this.ws && this.conectado) {
      this.ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Audio,
      }));
    }
  }

  cancelarRespuesta() {
    if (this.ws && this.conectado && this.respondiendo) {
      this.ws.send(JSON.stringify({ type: "response.cancel" }));
    }
  }

  setOnAudioDelta(callback: (base64Audio: string) => void) {
    this.onAudioDelta = callback;
  }

  setOnTranscript(callback: (texto: string, role: "user" | "assistant") => void) {
    this.onTranscript = callback;
  }

  setOnInterrupcion(callback: () => void) {
    this.onInterrupcion = callback;
  }

  cerrar() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.conectado = false;
    }
  }

  get estaConectado() { return this.conectado; }
}
