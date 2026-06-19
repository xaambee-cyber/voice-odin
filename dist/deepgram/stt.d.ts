import { EventEmitter } from "events";
export declare class DeepgramSTT extends EventEmitter {
    private connection;
    private client;
    constructor();
    iniciar(): Promise<void>;
    enviarAudio(audioBuffer: Buffer): void;
    cerrar(): void;
}
//# sourceMappingURL=stt.d.ts.map