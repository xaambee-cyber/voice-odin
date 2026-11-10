export interface TransferenciaActiva {
    callSid: string;
    negocioId: string;
    destino: string;
    inicioMs: number;
}
export declare function registrarTransferencia(t: TransferenciaActiva): void;
/**
 * Devuelve la transferencia y la saca del mapa. Un reintento de Twilio
 * devuelve null; Odin dedupea aparte por `transferencia_segundos`.
 */
export declare function tomarTransferencia(callSid: string): TransferenciaActiva | null;
export declare function purgarTransferenciasViejas(): void;
export declare function transferenciasActivas(): number;
//# sourceMappingURL=transferencias.d.ts.map