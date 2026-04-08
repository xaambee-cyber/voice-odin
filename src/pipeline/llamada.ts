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
  itemId?: string;   // solo para turnos de usuario (para actualizar después)
  pending: boolean;  // true = Whisper aún no llegó
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

// Palabras que solo aparecen en inglés y nunca en español conversacional por teléfono.
// Si 2+ de estas aparecen en una transcripción, es alucinación de Whisper.
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
  // historialOrdenado mantiene el orden correcto usando placeholders para turnos de usuario
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

  // Detecta si la transcripción de Whisper es real o ruido / alucinación de teléfono
  private esTranscripcionValida(texto: string): boolean {
    const t = texto.trim();
    const tLower = t.toLowerCase();

    // Muy corta
    if (t.length < 4) return false;

    // Contiene URLs (alucinación frecuente de Whisper)
    if (tLower.includes("www.") || tLower.includes("http") || tLower.includes(".com") || tLower.includes(".org")) return false;

    // Solo signos de puntuación o números
    if (/^[\s.,!?¿¡0-9\-]+$/.test(t)) return false;

    // Frases concretas de ruido que Whisper genera con silencio
    const ruidoExacto = [
      "gracias.", "gracias", "un saludo.", "un saludo",
      "subs", "subtítulos", "suscríbete", "chau.", "chau",
      "ok.", "ok", "bye.", "bye", "...", ". . .",
    ];
    if (ruidoExacto.includes(tLower)) return false;

    // Detectar inglés: si 2+ palabras son stopwords en inglés, es alucinación
    const palabras = tLower.split(/\s+/);
    const inglesCount = palabras.filter(p => ENGLISH_STOPWORDS.has(p.replace(/[^a-z']/g, ""))).length;
    if (inglesCount >= 2) {
      console.log(`[STT] Descartado por inglés (${inglesCount} palabras en inglés): "${t}"`);
      return false;
    }

    // Texto sospechosamente largo para audio de teléfono (más de 30 palabras = probable alucinación)
    if (palabras.length > 30) {
      console.log(`[STT] Descartado por largo excesivo (${palabras.length} palabras): "${t}"`);
      return false;
    }

    return true;
  }

  async iniciar() {
    // Pedir config a Odin al inicio de la llamada (cache como fallback)
    try {
      const resp = await fetch(`${config.odinAppUrl}/api/voice/config-llamada?negocioId=${this.negocioId}`);
      if (resp.ok) {
        const data = await resp.json() as ConfigNegocio;
        this.configNegocio = data;
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

    // conversation.item.created: el turno del usuario fue detectado (ANTES de que Whisper transcriba).
    // Reservamos su slot en el historial en el orden correcto.
    this.realtime.setOnItemCreated((itemId) => {
      this.historialOrdenado.push({ role: "user", content: "", itemId, pending: true });
      console.log(`[PIPELINE] Slot reservado para usuario itemId=${itemId}`);
    });

    // Transcripciones
    this.realtime.setOnTranscript((texto, role, itemId) => {
      if (role === "user") {
        // Buscar el placeholder reservado por setOnItemCreated
        const idx = itemId
          ? this.historialOrdenado.findIndex(t => t.itemId === itemId && t.pending)
          : this.historialOrdenado.findLastIndex(t => t.role === "user" && t.pending);

        if (!this.esTranscripcionValida(texto)) {
          // Alucinación/ruido → eliminar el placeholder
          if (idx !== -1) this.historialOrdenado.splice(idx, 1);
          console.log(`[STT] Transcripción descartada (ruido): "${texto}"`);
        } else {
          // Llenar el placeholder con el texto real
          if (idx !== -1) {
            this.historialOrdenado[idx].content = texto;
            this.historialOrdenado[idx].pending = false;
          } else {
            // Sin placeholder (edge case): insertar al final
            this.historialOrdenado.push({ role: "user", content: texto, pending: false });
          }
          this.turnos++;
          console.log(`[USUARIO] "${texto}"`);
        }
      } else {
        // El agente siempre llega después del turno del usuario → orden correcto
        this.historialOrdenado.push({ role: "assistant", content: texto, pending: false });
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

    // Filtrar placeholders que nunca recibieron transcripción (Whisper tardó o llamada cortada)
    const historial = this.historialOrdenado
      .filter(t => !t.pending && t.content.trim().length > 0)
      .map(t => ({ role: t.role === "user" ? "user" as const : "assistant" as const, content: t.content }));

    // Transcripción legible para el campo transcripcion
    const transcripcion = historial
      .map(t => `${t.role === "user" ? "Cliente" : "Agente"}: ${t.content}`)
      .join("\n");

    console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${this.turnos} turnos`);
    console.log(`[PIPELINE] Enviando ${historial.length} mensajes a Odin`);
    if (historial.length > 0) {
      console.log("[PIPELINE] Historial final:\n" + transcripcion);
    }

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
