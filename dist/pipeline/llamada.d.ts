import WebSocket from "ws";
interface Servicio {
    id: string;
    nombre: string;
    duracionMinutos: number;
    precio: number;
    descripcion?: string;
}
interface HorarioDetallado {
    diaSemana: number;
    horaInicio: string;
    horaFin: string;
}
interface CitaCliente {
    id: string;
    servicio: string;
    fechaInicio: string;
    estado: string;
}
interface HabilidadesActivas {
    escalamiento: boolean;
    agenda_citas: boolean;
    aprendizaje: boolean;
    solicitud_reserva?: boolean;
}
interface MetodoPagoNegocio {
    tipo: "transferencia" | "paypal" | "mercadopago" | "otro";
    datos: string;
    modalidad: "completo" | "anticipo";
    porcentajeAnticipo?: number;
    instrucciones?: string;
}
interface ItemCatalogo {
    id: string;
    nombre: string;
    precio: number;
    descripcion?: string;
    tipo: string;
    duracionMinutos?: number | null;
    capacidad?: number | null;
    unidad?: string | null;
}
export interface ConfigNegocio {
    nombreAgente: string;
    personalidad: string;
    tonoAdicional?: string;
    nombreNegocio: string;
    tipoNegocio: string;
    vertical?: string;
    horario?: string;
    direccion?: string;
    telefono?: string;
    conocimiento: string;
    habilidades: string;
    negocioId?: string;
    zonaHoraria?: string;
    voz?: string;
    catalogo?: ItemCatalogo[];
    servicios?: Servicio[];
    horarioDetallado?: HorarioDetallado[];
    citasCliente?: CitaCliente[];
    habilidadesActivas?: HabilidadesActivas;
    verificarDisponibilidadReserva?: boolean;
    metodoPago?: MetodoPagoNegocio | null;
}
export declare class PipelineLlamada {
    private ws;
    private realtime;
    private streamSid;
    private callSid;
    private configNegocio;
    private historialOrdenado;
    private inicioLlamada;
    private negocioId;
    private numeroTwilio;
    private callerNumber;
    private turnos;
    constructor(ws: WebSocket, negocioId: string, configNegocio: ConfigNegocio, callerNumber?: string, numeroTwilio?: string, callSid?: string);
    private esTranscripcionValida;
    private colgarTwilioCall;
    private manejarFuncion;
    private registrarCallbacks;
    iniciar(): Promise<void>;
    recibirMensajeTwilio(mensaje: any): void;
    private enviarAudioTwilio;
    private limpiarAudioTwilio;
    interrumpir(): void;
    private finalizarLlamada;
}
export {};
//# sourceMappingURL=llamada.d.ts.map