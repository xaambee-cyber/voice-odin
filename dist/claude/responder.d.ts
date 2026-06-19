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
interface TurnoHistorial {
    role: "user" | "assistant";
    content: string;
}
export declare function generarRespuesta(textoCliente: string, configNegocio: ConfigNegocio, historial: TurnoHistorial[]): Promise<{
    texto: string;
    costoUsd: number;
}>;
export {};
//# sourceMappingURL=responder.d.ts.map