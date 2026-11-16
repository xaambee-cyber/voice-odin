/**
 * Tolerancia de 5 min (la que recomienda Telnyx): un aviso de llamada que llega
 * más tarde ya no sirve para nada — la llamada se contestó o se cayó.
 */
export declare function verificarFirmaTelnyx(cuerpoCrudo: string, firma: string | undefined | null, marcaDeTiempo: string | undefined | null, llavePublica: string, toleranciaSegundos?: number, ahoraMs?: number): boolean;
/** Token del WebSocket para una llamada. Determinista: no hay que guardarlo. */
export declare function tokenStream(callControlId: string, secreto?: string): string;
export declare function tokenStreamValido(callControlId: string, token: string | null | undefined, secreto?: string): boolean;
//# sourceMappingURL=firma.d.ts.map