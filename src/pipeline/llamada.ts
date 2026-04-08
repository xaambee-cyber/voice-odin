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

// Entrada en el historial ordenado.
// Los turnos del usuario se reservan cuando conversation.item.created llega,
// ANTES de que Whisper termine. Así el orden user→assistant siempre es correcto.
interface TurnoHistorial {
  role: "user" | "assistant";
  content: string;
  itemId?: string;
  pending: boolean;
}

function buildSystemPrompt(configNegocio: ConfigNegocio): string {
  return `Eres ${configNegocio.nombreAgente} de ${configNegocio.nombreNegocio} (${configNegocio.tipoNegocio}).
${configNegocio.personalidad}.${configNegocio.tonoAdicional ? ` ${configNegocio.tonoAdicional}` : ""}
Horario: ${configNegocio.horario || "no especificado"}.
Dirección: ${configNegocio.direccion || "no especificada"}.
${configNegocio.conocimiento}
${configNegocio.habilidades || ""}

REGLAS CRÍTICAS — LÉELAS CON ATENCIÓN:
- SIEMPRE habla en ESPAÑOL MEXICANO. NUNCA en inglés ni otro idioma.
- Estás en una LLAMADA TELEFÓNICA con audio comprimido. La transcripción a veces llega distorsionada.
- Si la transcripción no tiene sentido o parece ruido, di EXACTAMENTE: "Perdón, no te escuché bien, ¿me lo puedes repetir?"
- NUNCA inventes ni respondas a algo que no entendiste claramente.
- Respuestas de 1-2 oraciones máximo. Sin rodeos.
- Habla como una persona real mexicana por teléfono. Natural y directo.
- Sin URLs, emojis, listas, ni formato de texto.
- No inventes datos que no tengas.
- Si te preguntan quién eres: di tu nombre y el negocio. Nada más.
- Si te interrumpen, calla y escucha.`;
}

// Palabras exclusivamente en inglés que nunca aparecen en español conversacional.
// 2+ hits = alucinación de Whisper.
const ENGLISH_STOPWORDS = new Set([
  "the", "this", "that", "there", "their", "they", "these", "those",
  "have", "has", "had", "was", "were", "would", "could", "should",
  "your", "you're", "it's", "i'm", "we're", "can't", "don't", "won't",
  "thank", "thanks", "watching", "subscribe", "click", "like", "channel",
  "video", "please", "welcome", "enjoy", "follow", "visit", "website",
  "music", "provided", "copyright", "rights", "reserved",
]);

export class PipelineLlamada {
  private ws: WebSocket;
  private realtime: OpenAIRealtime;
  private streamSid: string = "";
  private configNegocio: ConfigNegocio;
  private historialOrdenado: TurnoHistorial[] = [];
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

  private esTranscripcionValida(texto: string): boolean {
    const t = texto.trim();
    const tLower = t.toLowerCase();

    if (t.length < 4) return false;
    if (tLower.includes("www.") || tLower.includes("http") || tLower.includes(".com") || tLower.includes(".org")) return false;
    if (/^[\s.,!?¿¡0-9\-]+$/.test(t)) return false;

    const ruidoExacto = [
      "gracias.", "gracias", "un saludo.", "un saludo",
      "subs", "subtítulos", "suscríbete", "chau.", "chau",
      "ok.", "ok", "bye.", "bye", "...", ". . .",
    ];
    if (ruidoExacto.includes(tLower)) return false;

    const palabras = tLower.split(/\s+/);
    const inglesCount = palabras.filter(p => ENGLISH_STOPWORDS.has(p.replace(/[^a-z']/g, ""))).length;
    if (inglesCount >= 2) {
      console.log(`[STT] Descartado (inglés, ${inglesCount} palabras): "${t}"`);
      return false;
    }

    if (palabras.length > 30) {
      console.log(`[STT] Descartado (muy largo, ${palabras.length} palabras): "${t}"`);
      return false;
    }

    return true;
  }

  // Registra todos los callbacks en el objeto realtime actual.
  // Se llama después de crear/recrear this.realtime.
  private registrarCallbacks() {
    this.realtime.setOnAudioDelta((b) => this.enviarAudioTwilio(b));
    this.realtime.setOnInterrupcion(() => this.limpiarAudioTwilio());
    this.realtime.setOnItemCreated((itemId) => {
      this.historialOrdenado.push({ role: "user", content: "", itemId, pending: true });
      console.log(`[PIPELINE] Slot reservado usuario itemId=${itemId}`);
    });
    this.realtime.setOnTranscript((texto, role, itemId) => {
      if (role === "user") {
        const idx = itemId
          ? this.historialOrdenado.findIndex(t => t.itemId === itemId && t.pending)
          : this.historialOrdenado.findLastIndex(t => t.role === "user" && t.pending);
        if (!this.esTranscripcionValida(texto)) {
          if (idx !== -1) this.historialOrdenado.splice(idx, 1);
          console.log(`[STT] Descartado (ruido): "${texto}"`);
        } else {
          if (idx !== -1) {
            this.historialOrdenado[idx].content = texto;
            this.historialOrdenado[idx].pending = false;
          } else {
            this.historialOrdenado.push({ role: "user", content: texto, pending: false });
          }
          this.turnos++;
          console.log(`[USUARIO] "${texto}"`);
        }
      } else {
        this.historialOrdenado.push({ role: "assistant", content: texto, pending: false });
        console.log(`[AGENTE] "${texto}"`);
      }
    });
  }

  async iniciar() {
    // 1. Obtener config fresca de Odin ANTES de conectar a OpenAI.
    //    Timeout de 4s para tolerar cold starts de Vercel.
    //    Si falla/timeout, usamos la config que llegó del constructor (cache local).
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const resp = await fetch(
        `${config.odinAppUrl}/api/voice/config-llamada?negocioId=${this.negocioId}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json() as ConfigNegocio;
        this.configNegocio = data;
        this.realtime = new OpenAIRealtime(buildSystemPrompt(data));
        console.log(`[PIPELINE] Config cargada: ${data.nombreNegocio}`);
      } else {
        console.warn(`[PIPELINE] config-llamada → ${resp.status}, usando cache local`);
      }
    } catch {
      console.warn("[PIPELINE] Config timeout/error, usando cache local");
    }

    // 2. Registrar callbacks en el objeto realtime definitivo (antes de conectar)
    this.registrarCallbacks();

    // 3. Conectar a OpenAI — el saludo se envía automáticamente al recibir session.updated
    await this.realtime.conectar();

    console.log(`[PIPELINE] Llamada iniciada — negocioId: ${this.negocioId}, caller: ${this.callerNumber || "desconocido"}`);
  }

  recibirMensajeTwilio(mensaje: any) {
    switch (mensaje.event) {
      case "start":
        this.streamSid = mensaje.start?.streamSid || "";
        console.log(`[TWILIO] Stream iniciado: ${this.streamSid}`);
        break;
      case "media":
        if (mensaje.media?.payload) this.realtime.enviarAudio(mensaje.media.payload);
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
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
      console.log("[TWILIO] Buffer limpiado (interrupción)");
    }
  }

  interrumpir() {
    this.realtime.cancelarRespuesta();
    this.limpiarAudioTwilio();
  }

  private async finalizarLlamada() {
    this.realtime.cerrar();

    const duracionSegundos = Math.round((Date.now() - this.inicioLlamada) / 1000);

    const historial = this.historialOrdenado
      .filter(t => !t.pending && t.content.trim().length > 0)
      .map(t => ({ role: t.role === "user" ? "user" as const : "assistant" as const, content: t.content }));

    const transcripcion = historial
      .map(t => `${t.role === "user" ? "Cliente" : "Agente"}: ${t.content}`)
      .join("\n");

    console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${this.turnos} turnos`);
    console.log(`[PIPELINE] Enviando ${historial.length} mensajes a Odin`);
    if (historial.length > 0) console.log("[PIPELINE] Historial:\n" + transcripcion);

    try {
      const resp = await fetch(`${config.odinAppUrl}/api/webhooks/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          negocioId: this.negocioId,
          telefonoCliente: this.callerNumber || "desconocido",
          nombreCliente: "Llamada entrante",
          transcripcion,
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
