import WebSocket from "ws";
import { DeepgramSTT } from "../deepgram/stt";
import { textoAVozStreaming } from "../deepgram/tts";
import { generarRespuesta } from "../claude/responder";
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

interface TurnoHistorial {
  role: "user" | "assistant";
  content: string;
}

export class PipelineLlamada {
  private ws: WebSocket;
  private stt: DeepgramSTT;
  private streamSid: string = "";
  private configNegocio: ConfigNegocio;
  private historial: TurnoHistorial[] = [];
  private transcripcionActual: string = "";
  private respondiendo: boolean = false;
  private transcripcionCompleta: string[] = [];
  private costoTotal: number = 0;
  private inicioLlamada: number;
  private negocioId: string;
  private callerNumber: string;

  constructor(ws: WebSocket, negocioId: string, configNegocio: ConfigNegocio, callerNumber: string = "") {
    this.ws = ws;
    this.negocioId = negocioId;
    this.configNegocio = configNegocio;
    this.callerNumber = callerNumber;
    this.stt = new DeepgramSTT();
    this.inicioLlamada = Date.now();
  }

  async iniciar() {
    // Pedir config a Odin al inicio de la llamada (Map como fallback)
    try {
      const resp = await fetch(`${config.odinAppUrl}/api/voice/config-llamada?negocioId=${this.negocioId}`);
      if (resp.ok) {
        const data = await resp.json() as ConfigNegocio;
        this.configNegocio = data;
        console.log(`[PIPELINE] Config cargada desde Odin para negocioId: ${this.negocioId}`);
      }
    } catch (err) {
      console.warn(`[PIPELINE] No se pudo cargar config de Odin, usando cache: ${err}`);
    }

    await this.stt.iniciar();

    // Cuando Deepgram transcribe texto parcial o final
    this.stt.on("transcripcion", ({ texto, esFinal, finDeHabla }) => {
      if (esFinal) {
        this.transcripcionActual += " " + texto;
        console.log(`[STT] Final: "${texto}"`);
      }

      // Si el cliente dejó de hablar, procesar
      if (finDeHabla && this.transcripcionActual.trim()) {
        this.procesarTurno(this.transcripcionActual.trim());
        this.transcripcionActual = "";
      }
    });

    // Fallback: si UtteranceEnd se dispara sin speech_final
    this.stt.on("finDeEnunciado", () => {
      if (this.transcripcionActual.trim() && !this.respondiendo) {
        this.procesarTurno(this.transcripcionActual.trim());
        this.transcripcionActual = "";
      }
    });

    this.stt.on("error", (err) => {
      console.error("[PIPELINE] Error STT:", err);
    });

    console.log(`[PIPELINE] Llamada iniciada — negocioId: ${this.negocioId}, caller: ${this.callerNumber || "desconocido"}`);
  }

  // Saludo inicial cuando el stream está listo
  private async saludar() {
    const saludo = `Hola, gracias por llamar a ${this.configNegocio.nombreNegocio}. Soy ${this.configNegocio.nombreAgente}. ¿En qué te puedo ayudar?`;
    console.log(`[PIPELINE] Enviando saludo: "${saludo}"`);

    this.transcripcionCompleta.push(`Agente: ${saludo}`);
    this.historial.push({ role: "assistant", content: saludo });

    try {
      await textoAVozStreaming(saludo, (base64Audio) => {
        if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
          this.ws.send(JSON.stringify({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: base64Audio },
          }));
        }
      });

      if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
        this.ws.send(JSON.stringify({
          event: "mark",
          streamSid: this.streamSid,
          mark: { name: "saludo_completo" },
        }));
      }
    } catch (err) {
      console.error("[PIPELINE] Error enviando saludo:", err);
    }
  }

  // Recibe mensaje de Twilio Media Stream
  recibirMensajeTwilio(mensaje: any) {
    switch (mensaje.event) {
      case "start":
        this.streamSid = mensaje.start?.streamSid || "";
        console.log(`[TWILIO] Stream iniciado: ${this.streamSid}`);
        // Enviar saludo inicial una vez que el stream está listo
        this.saludar();
        break;

      case "media":
        // Audio del cliente → Deepgram STT
        if (mensaje.media?.payload) {
          const audioBuffer = Buffer.from(mensaje.media.payload, "base64");
          this.stt.enviarAudio(audioBuffer);
        }
        break;

      case "stop":
        console.log("[TWILIO] Stream detenido");
        this.finalizarLlamada();
        break;
    }
  }

  // Cliente terminó de hablar → Claude → TTS → Twilio
  private async procesarTurno(textoCliente: string) {
    if (this.respondiendo) return;
    this.respondiendo = true;

    console.log(`[PIPELINE] Cliente dijo: "${textoCliente}"`);
    this.transcripcionCompleta.push(`Cliente: ${textoCliente}`);

    try {
      // Claude genera respuesta
      const { texto: respuestaTexto, costoUsd } = await generarRespuesta(
        textoCliente,
        this.configNegocio,
        this.historial
      );

      this.costoTotal += costoUsd;
      console.log(`[PIPELINE] Agente responde: "${respuestaTexto}"`);
      this.transcripcionCompleta.push(`Agente: ${respuestaTexto}`);

      // Actualizar historial
      this.historial.push({ role: "user", content: textoCliente });
      this.historial.push({ role: "assistant", content: respuestaTexto });

      // Mantener historial corto (últimos 8 turnos)
      if (this.historial.length > 16) {
        this.historial = this.historial.slice(-16);
      }

      // TTS: convertir texto a audio y enviar por Twilio
      await textoAVozStreaming(respuestaTexto, (base64Audio) => {
        if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
          this.ws.send(JSON.stringify({
            event: "media",
            streamSid: this.streamSid,
            media: {
              payload: base64Audio,
            },
          }));
        }
      });

      // Marcar TTS como completo (Twilio necesita esto)
      if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
        this.ws.send(JSON.stringify({
          event: "mark",
          streamSid: this.streamSid,
          mark: { name: "respuesta_completa" },
        }));
      }
    } catch (err) {
      console.error("[PIPELINE] Error procesando turno:", err);
    }

    this.respondiendo = false;
  }

  // Interrumpir respuesta del agente
  interrumpir() {
    if (this.respondiendo && this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({
        event: "clear",
        streamSid: this.streamSid,
      }));
      console.log("[PIPELINE] Respuesta interrumpida por el cliente");
    }
    this.respondiendo = false;
  }

  // Llamada terminó → notificar a Odin
  private async finalizarLlamada() {
    this.stt.cerrar();

    const duracionSegundos = Math.round((Date.now() - this.inicioLlamada) / 1000);
    const turnos = this.historial.length / 2;

    console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${turnos} turnos, $${this.costoTotal.toFixed(4)}`);

    // Notificar a Odin
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
          turnos,
          costoUsd: this.costoTotal,
          historial: this.historial,
        }),
      });
      const data = await resp.json();
      console.log(`[PIPELINE] Webhook Odin → ${resp.status}:`, data);
    } catch (err) {
      console.error("[PIPELINE] Error notificando a Odin:", err);
    }
  }
}
