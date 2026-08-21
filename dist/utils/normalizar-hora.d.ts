export interface HoraExplicita {
    original: string;
    hora12: number;
    minuto: number;
    hora24: number;
}
export declare const PREFIJO_ANOTACION_HORARIA = "[NORMALIZACI\u00D3N HORARIA DEL SISTEMA:";
export declare const REGLA_NORMALIZACION_HORARIA: string;
export declare function horasExplicitasAmPm(texto: string): HoraExplicita[];
export declare function anotacionHorariaParaAgente(texto: string): string | null;
export declare function esAnotacionHoraria(texto: unknown): boolean;
/** Última hora explícita del turno: es la que normalmente alimenta la función. */
export declare function ultimaHoraExplicita(texto: string): HoraExplicita | null;
/**
 * Red final para herramientas. Solo toca campos con semántica horaria y solo
 * cuando coinciden hora Y minuto con la lectura errónea de 12 horas.
 */
export declare function normalizarArgumentosConHora<T>(args: T, hora: HoraExplicita | null): T;
//# sourceMappingURL=normalizar-hora.d.ts.map