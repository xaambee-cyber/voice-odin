import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { config } from "../utils/config";
import { EventEmitter } from "events";

export class DeepgramSTT extends EventEmitter {
  private connection: any = null;
  private client: any;

  constructor() {
    super();
    this.client = createClient(config.deepgramApiKey);
  }

  async iniciar() {
    this.connection = this.client.listen.live({
      model: "nova-2",
      language: "es",
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      punctuate: true,
      interim_results: true,
      endpointing: 800,       // 800ms de silencio = fin de turno
      utterance_end_ms: 1200,  // 1.2s para marcar fin definitivo
      vad_events: true,        // Voice Activity Detection
    });

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      console.log("[DEEPGRAM STT] Conexión abierta");
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript || "";
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;

      if (transcript.trim()) {
        this.emit("transcripcion", {
          texto: transcript.trim(),
          esFinal: isFinal,
          finDeHabla: speechFinal,
        });
      }
    });

    this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      this.emit("finDeEnunciado");
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error("[DEEPGRAM STT] Error:", err);
      this.emit("error", err);
    });

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      console.log("[DEEPGRAM STT] Conexión cerrada");
      this.emit("cerrado");
    });
  }

  enviarAudio(audioBuffer: Buffer) {
    if (this.connection) {
      this.connection.send(audioBuffer);
    }
  }

  cerrar() {
    if (this.connection) {
      this.connection.finish();
      this.connection = null;
    }
  }
}
