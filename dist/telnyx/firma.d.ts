/**
 * Tolerancia de 5 min (la que recomienda Telnyx): un aviso de llamada que llega
 * más tarde ya no sirve para nada — la llamada se contestó o se cayó.
 */
export declare function verificarFirmaTelnyx(cuerpoCrudo: string, firma: string | undefined | null, marcaDeTiempo: string | undefined | null, llavePublica: string, toleranciaSegundos?: number, ahoraMs?: number): boolean;
/** Token del WebSocket para una llamada. Determinista: no hay que guardarlo. */
export declare function tokenStream(callControlId: string, secreto?: string): string;
export declare function tokenStreamValido(callControlId: string, token: string | null | undefined, secreto?: string): boolean;
export type DatosSaliente = {
    n: string;
    c: string;
};
export declare function firmarSaliente(datos: DatosSaliente, ahoraMs?: number, secreto?: string): {
    pr: string;
    t: string;
};
export declare function leerSaliente(pr: string | null | undefined, t: string | null | undefined, ahoraMs?: number, secreto?: string): DatosSaliente | null;
//# sourceMappingURL=firma.d.ts.map