import WebSocket from "ws";
import { OpenAIRealtime } from "../openai/realtime";
import { config } from "../utils/config";

interface ConfigNegocio {
  nombreAgente: string;
  personalidad: string;
  tonoAdicional?: string;
  nombreNegocio: string;
  tipoNegocio: string;
  horario?: string;
  direccion?: string;
  telefono?: string;
  conocimiento: string;
  habilidades: string;
}

function buildSystemPrompt(configNegocio: ConfigNegocio): string {
  return `Eres ${configNegocio.nombreAgente} de ${configNegocio.nombreNegocio} (${configNegocio.tipoNegocio}).
${configNegocio.personalidad}.${configNegocio.tonoAdicional ? ` ${configNegocio.tonoAdicional}` : ""}
Horario: ${configNegocio.horario || "no especificado"}.
Dirección: ${configNegocio.direccion || "no especificada"}.
${configNegocio.conocimiento}
${configNegocio.habilidades || ""}

REGLAS CRÍTICAS:
- SIEMPRE habla en ESPAÑOL MEXICANO. NUNCA respondas en inglés ni otro idioma.
- Estás en una llamada telefónica. El audio puede sonar distorsionado, pero el usuario SIEMPRE habla español.
- Si la transcripción parece inglés o sin sentido, IGNÓRALA y responde naturalmente en español como si entendieras.
- Respuestas cortas: 1-3 oraciones máximo. No des discursos.
- Habla natural, como una persona real mexicana por teléfono.
- Sin URLs, emojis, ni formato de texto.
- No inventes datos que no tengas.
- Si te interrumpen, detente y escucha.
- Cuando el usuario te salude, salúdalo de vuelta brevemente y pregunta en qué le ayudas.
- NO repitas la misma respuesta si te vuelven a preguntar algo similar. Varía tus respuestas.`;
}

export class PipelineLlamada {
  private ws: WebSocket;
  private realtime: OpenAIRealtime;
  private streamSid: string = "";
  private configNegocio: ConfigNegocio;
  private transcripcionCompleta: string[] = [];
  private inicioLlamada: number;
  private negocioId: string;
  private callerNumber: string;
  private turnos: number = 0;

  constructor(ws: WebSocket, negocioId: string, configNegocio: ConfigNegocio, callerNumber: string = "") {
    this.ws = ws;
    this.negocioId = negocioId;
    this.configNegocio = configNegocio;
    this.callerNumber = callerNumber;
    this.inicioLlamada = Date.now();

    const prompt = buildSystemPrompt(configNegocio);
    this.realtime = new OpenAIRealtime(prompt);
  }

  async iniciar() {
    // Pedir config a Odin al inicio de la llamada (cache como fallback)
    try {
      const resp = await fetch(`${config.odinAppUrl}/api/voice/config-llamada?negocioId=${this.negocioId}`);
      if (resp.ok) {
        const data = await resp.json() as ConfigNegocio;
        this.configNegocio = data;
        // Recrear realtime con el prompt actualizado
        const prompt = buildSystemPrompt(data);
        this.realtime = new OpenAIRealtime(prompt);
        console.log(`[PIPELINE] Config cargada desde Odin para negocioId: ${this.negocioId}`);
      }
    } catch (err) {
      console.warn(`[PIPELINE] No se pudo cargar config de Odin, usando cache: ${err}`);
    }

    await this.realtime.conectar();

    // Audio de OpenAI → Twilio
    this.realtime.setOnAudioDelta((base64Audio) => {
      this.enviarAudioTwilio(base64Audio);
    });

    // Cuando el usuario interrumpe → limpiar buffer de audio de Twilio
    this.realtime.setOnInterrupcion(() => {
      this.limpiarAudioTwilio();
    });

    // Transcripciones para logging e historial
    this.realtime.setOnTranscript((texto, role) => {
      if (role === "user") {
        this.transcripcionCompleta.push(`Cliente: ${texto}`);
        this.turnos++;
      } else {
        this.transcripcionCompleta.push(`Agente: ${texto}`);
        console.log(`[AGENTE] "${texto}"`);
      }
    });

    console.log(`[PIPELINE] Llamada iniciada — negocioId: ${this.negocioId}, caller: ${this.callerNumber || "desconocido"} — modo: REALTIME`);
  }

  recibirMensajeTwilio(mensaje: any) {
    switch (mensaje.event) {
      case "start":
        this.streamSid = mensaje.start?.streamSid || "";
        console.log(`[TWILIO] Stream iniciado: ${this.streamSid}`);
        break;

      case "media":
        if (mensaje.media?.payload) {
          this.realtime.enviarAudio(mensaje.media.payload);
        }
        break;

      case "stop":
        console.log("[TWILIO] Stream detenido");
        this.finalizarLlamada();
        break;
    }
  }

  private enviarAudioTwilio(base64Audio: string) {
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: base64Audio },
      }));
    }
  }

  private limpiarAudioTwilio() {
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({
        event: "clear",
        streamSid: this.streamSid,
      }));
      console.log("[TWILIO] Buffer de audio limpiado (interrupción)");
    }
  }

  interrumpir() {
    this.realtime.cancelarRespuesta();
    this.limpiarAudioTwilio();
  }

  private async finalizarLlamada() {
    this.realtime.cerrar();

    const duracionSegundos = Math.round((Date.now() - this.inicioLlamada) / 1000);
    console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${this.turnos} turnos`);

    // Construir historial desde transcripción completa
    const historial = this.transcripcionCompleta
      .map(line => {
        if (line.startsWith("Cliente: ")) {
          return { role: "user" as const, content: line.substring(9) };
        } else if (line.startsWith("Agente: ")) {
          return { role: "assistant" as const, content: line.substring(8) };
        }
        return null;
      })
      .filter((item): item is { role: "user" | "assistant"; content: string } => item !== null);

    console.log(`[PIPELINE] Enviando ${historial.length} mensajes a Odin`);

    try {
      const resp = await fetch(`${config.odinAppUrl}/api/webhooks/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          negocioId: this.negocioId,
          telefonoCliente: this.callerNumber || "desconocido",
          nombreCliente: "Llamada entrante",
          transcripcion: this.transcripcionCompleta.join("\n"),
          duracionSegundos,
          turnos: this.turnos,
          costoUsd: 0,
          historial,
        }),
      });
      const data = await resp.json();
      console.log(`[PIPELINE] Webhook Odin → ${resp.status}:`, data);
    } catch (err) {
      console.error("[PIPELINE] Error notificando a Odin:", err);
    }
  }
}
