export interface TransferenciaActiva {
    callSid: string;
    negocioId: string;
    destino: string;
    inicioMs: number;
}
export declare function registrarTransferencia(t: TransferenciaActiva): void;
/**
 * Devuelve la transferencia y la SACA del mapa (one-shot). Un segundo callback
 * con el mismo callSid — reintento de Twilio, request forjado — devuelve null y
 * no llega a cobrar. Odin dedupea aparte por `transferencia_segundos`.
 */
export declare function tomarTransferencia(callSid: string): TransferenciaActiva | null;
export declare function purgarTransferenciasViejas(): void;
export declare function transferenciasActivas(): number;
//# sourceMappingURL=transferencias.d.ts.map