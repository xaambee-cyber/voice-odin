"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepgramSTT = void 0;
const sdk_1 = require("@deepgram/sdk");
const config_1 = require("../utils/config");
const events_1 = require("events");
class DeepgramSTT extends events_1.EventEmitter {
    connection = null;
    client;
    constructor() {
        super();
        this.client = (0, sdk_1.createClient)(config_1.config.deepgramApiKey);
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
            endpointing: 800, // 800ms de silencio = fin de turno
            utterance_end_ms: 1200, // 1.2s para marcar fin definitivo
            vad_events: true, // Voice Activity Detection
        });
        this.connection.on(sdk_1.LiveTranscriptionEvents.Open, () => {
            console.log("[DEEPGRAM STT] Conexión abierta");
        });
        this.connection.on(sdk_1.LiveTranscriptionEvents.Transcript, (data) => {
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
        this.connection.on(sdk_1.LiveTranscriptionEvents.UtteranceEnd, () => {
            this.emit("finDeEnunciado");
        });
        this.connection.on(sdk_1.LiveTranscriptionEvents.Error, (err) => {
            console.error("[DEEPGRAM STT] Error:", err);
            this.emit("error", err);
        });
        this.connection.on(sdk_1.LiveTranscriptionEvents.Close, () => {
            console.log("[DEEPGRAM STT] Conexión cerrada");
            this.emit("cerrado");
        });
    }
    enviarAudio(audioBuffer) {
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
exports.DeepgramSTT = DeepgramSTT;
//# sourceMappingURL=stt.js.map