import WebSocket from "ws";
import { config } from "../utils/config";

export interface HerramientaVoz {
  type: "function";
  name: string;
  description: string;
  parameters: any;
}

// Voces disponibles en gpt-realtime (GA): alloy, ash, ballad, cedar, coral,
// echo, marin, sage, shimmer, verse. Default: marin (más natural en español).
const VOZ_DEFAULT = "marin";
const MODELO = "gpt-realtime";

export class OpenAIRealtime {
  private ws: WebSocket | null = null;
  private onAudioDelta: ((base64Audio: string) => void) | null = null;
  private onTranscript: ((texto: string, role: "user" | "assistant", itemId?: string) => void) | null = null;
  private onItemCreated: ((itemId: string) => void) | null = null;
  private onInterrupcion: (() => void) | null = null;
  private onFunctionCall: ((name: string, args: any, callId: string) => Promise<any>) | null = null;
  private conectado: boolean = false;
  private systemPrompt: string;
  private tools: HerramientaVoz[];
  private voz: string;
  private respondiendo: boolean = false;
  private graceUntil: number = 0;
  private saludoEnviado: boolean = false;
  private cancelacionEnCurso: boolean = false;

  // Acumulador de argumentos de la función en curso
  private funcionActual: { callId: string; name: string; args: string } | null = null;

  constructor(systemPrompt: string, tools: HerramientaVoz[] = [], voz: string = VOZ_DEFAULT) {
    this.systemPrompt = systemPrompt;
    this.tools = tools;
    this.voz = voz;
  }

  // Paso 1: abre la conexión WebSocket pero NO envía session.update todavía
  async abrirConexion(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${MODELO}`;

      this.ws = new WebSocket(url, {
        headers: {
          "Authorization": `Bearer ${config.openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        this.conectado = true;
        console.log(`[REALTIME] Conectado a OpenAI (${MODELO}, voz=${this.voz})`);
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

  // Configura la sesión y dispara el saludo. Si ya se envió saludo previamente
  // (por ejemplo, configurarSesion se llamó dos veces), solo actualiza
  // instrucciones/tools sin saludar de nuevo.
  configurarSesion(prompt: string, tools: HerramientaVoz[] = [], voz?: string) {
    this.systemPrompt = prompt;
    this.tools = tools;
    if (voz) this.voz = voz;

    if (!this.ws || !this.conectado) return;

    const sessionConfig: any = {
      modalities: ["text", "audio"],
      instructions: prompt,
      voice: this.voz,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      input_audio_transcription: {
        model: "whisper-1",
        language: "es",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
        // CRÍTICO: NO dejar que el server cancele respuestas automáticamente.
        // Antes esto causaba que el saludo se cancelara apenas el cliente
        // empezaba a respirar o hacer ruido.
        create_response: true,
        interrupt_response: false,
      },
      temperature: 0.7,
      max_response_output_tokens: "inf",
    };

    if (tools.length > 0) {
      sessionConfig.tools = tools;
      sessionConfig.tool_choice = "auto";
    }

    this.ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
  }

  // Actualiza prompt/tools sin disparar nuevo saludo (para cargar config tarde)
  actualizarConfiguracion(prompt: string, tools: HerramientaVoz[] = [], voz?: string) {
    this.configurarSesion(prompt, tools, voz);
  }

  async conectar(): Promise<void> {
    await this.abrirConexion();
    this.configurarSesion(this.systemPrompt, this.tools);
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case "session.created":
        console.log("[REALTIME] Sesión creada");
        break;

      case "session.updated":
        if (!this.saludoEnviado) {
          this.saludoEnviado = true;
          console.log("[REALTIME] Sesión configurada → enviando saludo");
          // Grace de 1.5s: durante el saludo no aceptamos interrupciones reales,
          // pero como interrupt_response=false, OpenAI tampoco cancela solo.
          this.graceUntil = Date.now() + 1500;
          if (this.ws && this.conectado) {
            this.ws.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text", "audio"],
                instructions: "Saluda brevemente al cliente en español mexicano. Una sola oración corta como: 'Hola, ¿en qué te puedo ayudar?' Nada más.",
              },
            }));
          }
        } else {
          console.log("[REALTIME] Configuración actualizada (sesión ya activa)");
        }
        break;

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
        // Solo cancelamos respuesta en curso si:
        // 1) Estamos respondiendo
        // 2) Ya pasó el grace period (saludo o respuesta inicial)
        // 3) No hay otra cancelación en curso
        if (this.respondiendo && this.ws && this.conectado && Date.now() > this.graceUntil && !this.cancelacionEnCurso) {
          console.log("[REALTIME] INTERRUPCIÓN → cancelando respuesta");
          this.cancelacionEnCurso = true;
          this.ws.send(JSON.stringify({ type: "response.cancel" }));
          if (this.onInterrupcion) this.onInterrupcion();
        }
        break;

      case "input_audio_buffer.speech_stopped":
        break;

      case "response.created":
        this.respondiendo = true;
        this.cancelacionEnCurso = false;
        break;

      case "response.done":
        this.respondiendo = false;
        this.cancelacionEnCurso = false;
        if (msg.response?.status === "cancelled") {
          console.log("[REALTIME] Respuesta cancelada");
        }
        break;

      // === FUNCTION CALLING ===
      case "response.output_item.added":
        if (msg.item?.type === "function_call") {
          this.funcionActual = {
            callId: msg.item.call_id || "",
            name: msg.item.name || "",
            args: "",
          };
          console.log(`[REALTIME] Función iniciada: ${msg.item.name}`);
        }
        break;

      case "response.function_call_arguments.delta":
        if (this.funcionActual && msg.delta) {
          this.funcionActual.args += msg.delta;
        }
        break;

      case "response.function_call_arguments.done":
        if (this.funcionActual && this.onFunctionCall) {
          const { callId, name } = this.funcionActual;
          const argsStr = msg.arguments || this.funcionActual.args;
          this.funcionActual = null;
          console.log(`[REALTIME] Función lista: ${name}(${argsStr})`);
          let args: any = {};
          try { args = JSON.parse(argsStr); } catch {}
          this.onFunctionCall(name, args, callId)
            .then((resultado) => this.enviarResultadoFuncion(callId, resultado))
            .catch((err) => {
              console.error("[REALTIME] Error en función:", err);
              this.enviarResultadoFuncion(callId, { error: "Error procesando la acción" });
            });
        }
        break;

      case "error":
        // response_cancel_not_active es inofensivo: ocurre cuando la respuesta
        // ya terminó justo cuando intentamos cancelarla
        if (msg.error?.code === "response_cancel_not_active") break;
        console.error("[REALTIME] Error:", JSON.stringify(msg.error));
        break;

      case "rate_limits.updated":
        break;
    }
  }

  enviarResultadoFuncion(callId: string, resultado: any) {
    if (!this.ws || !this.conectado) return;
    this.ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(resultado),
      },
    }));
    this.ws.send(JSON.stringify({ type: "response.create" }));
    console.log(`[REALTIME] Resultado función enviado (callId=${callId}):`, resultado);
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
  setOnFunctionCall(callback: (name: string, args: any, callId: string) => Promise<any>) { this.onFunctionCall = callback; }

  cerrar() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.conectado = false;
    }
  }

  get estaConectado() { return this.conectado; }
}
