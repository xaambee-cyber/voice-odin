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
/** ¿Esta llamada está pasando a un humano? (No la saca del mapa.) */
export declare function hayTransferencia(callSid: string): boolean;
export declare function transferenciasActivas(): number;
//# sourceMappingURL=transferencias.d.ts.map