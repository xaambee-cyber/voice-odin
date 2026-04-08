import WebSocket from "ws";
import { config } from "../utils/config";

export class OpenAIRealtime {
  private ws: WebSocket | null = null;
  private onAudioDelta: ((base64Audio: string) => void) | null = null;
  private onTranscript: ((texto: string, role: "user" | "assistant", itemId?: string) => void) | null = null;
  private onItemCreated: ((itemId: string) => void) | null = null;
  private onInterrupcion: (() => void) | null = null;
  private conectado: boolean = false;
  private systemPrompt: string;
  private respondiendo: boolean = false;
  private graceUntil: number = 0;
  private saludoEnviado: boolean = false; // evita doble saludo si actualizamos instrucciones

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
              // Subido de 0.7 a 0.85: reduce falsas interrupciones por ruido de línea
              threshold: 0.85,
              prefix_padding_ms: 300,
              // Subido de 800 a 1000: espera más antes de asumir que el usuario terminó
              silence_duration_ms: 1000,
            },
            temperature: 0.7,
            // Subido de 150 a 300: evita cortes a media oración
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

  // Actualiza instrucciones sin reenviar el saludo (para cuando config de Odin llega tarde)
  actualizarInstrucciones(prompt: string) {
    this.systemPrompt = prompt;
    if (this.ws && this.conectado) {
      this.ws.send(JSON.stringify({
        type: "session.update",
        session: { instructions: prompt },
      }));
      console.log("[REALTIME] Instrucciones actualizadas");
    }
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case "session.created":
        console.log("[REALTIME] Sesión creada");
        break;

      case "session.updated":
        // Solo mandar saludo UNA vez (al inicio), no en actualizaciones posteriores
        if (!this.saludoEnviado) {
          this.saludoEnviado = true;
          console.log("[REALTIME] Sesión configurada → enviando saludo");
          // Grace period: 5 segundos para que el saludo no sea interrumpido por ruido de conexión
          this.graceUntil = Date.now() + 5000;
          if (this.ws && this.conectado) {
            this.ws.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
                instructions: "Saluda brevemente al usuario en español mexicano. Una sola oración corta como: 'Hola, ¿en qué te puedo ayudar?' Nada más.",
              },
            }));
          }
        } else {
          console.log("[REALTIME] Instrucciones actualizadas (sesión ya activa)");
        }
        break;

      // conversation.item.created fires cuando el turno del usuario se confirma,
      // ANTES de que Whisper transcriba. Reservamos su slot en el historial.
      case "conversation.item.created":
        if (msg.item?.role === "user" && msg.item?.id && this.onItemCreated) {
          this.onItemCreated(msg.item.id);
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
          this.onTranscript(msg.transcript, "user", msg.item_id);
          console.log(`[REALTIME] Usuario: "${msg.transcript}"`);
        }
        break;

      case "input_audio_buffer.speech_started":
        console.log("[REALTIME] Usuario empezó a hablar");
        if (this.respondiendo && this.ws && this.conectado && Date.now() > this.graceUntil) {
          console.log("[REALTIME] INTERRUPCIÓN → cancelando respuesta");
          this.ws.send(JSON.stringify({ type: "response.cancel" }));
          this.respondiendo = false;
          if (this.onInterrupcion) this.onInterrupcion();
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
        if (msg.response?.status === "cancelled") {
          console.log("[REALTIME] Respuesta cancelada (interrupción)");
        } else {
          console.log("[REALTIME] Respuesta completa");
        }
        break;

      case "error":
        console.error("[REALTIME] Error:", JSON.stringify(msg.error));
        break;

      case "rate_limits.updated":
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
      this.respondiendo = false;
    }
  }

  setOnAudioDelta(callback: (base64Audio: string) => void) { this.onAudioDelta = callback; }
  setOnTranscript(callback: (texto: string, role: "user" | "assistant", itemId?: string) => void) { this.onTranscript = callback; }
  setOnItemCreated(callback: (itemId: string) => void) { this.onItemCreated = callback; }
  setOnInterrupcion(callback: () => void) { this.onInterrupcion = callback; }

  cerrar() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.conectado = false;
    }
  }

  get estaConectado() { return this.conectado; }
}
