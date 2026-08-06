import WebSocket from "ws";
interface CampoAgenda {
    id: string;
    label: string;
    requerido: boolean;
}
interface Servicio {
    id: string;
    nombre: string;
    duracionMinutos: number;
    precio: number;
    descripcion?: string;
    camposAgenda?: CampoAgenda[];
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
    pedidos?: boolean;
}
interface MetodoPagoNegocio {
    tipo: "transferencia" | "deposito" | "paypal" | "mercadopago" | "otro";
    datos: string;
    modalidad: "completo" | "anticipo";
    porcentajeAnticipo?: number;
    instrucciones?: string;
}
interface ReceptorEscalamiento {
    etiqueta: string;
    numero: string;
    operadora?: string;
    canal: "llamada" | "whatsapp";
    esPersonal?: boolean;
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
    direccion?: string | null;
    preciosPorDia?: Record<string, number> | null;
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
    profesionales?: Array<{
        id: string;
        nombre: string;
        atiendeTodosServicios: boolean;
        servicioIds: string[];
    }>;
    horarioDetallado?: HorarioDetallado[];
    citasCliente?: CitaCliente[];
    habilidadesActivas?: HabilidadesActivas;
    verificarDisponibilidadReserva?: boolean;
    metodoPago?: MetodoPagoNegocio | null;
    metodosPago?: MetodoPagoNegocio[];
    requiereAnticipoCitas?: boolean;
    anticipoCitas?: {
        modalidad: "completo" | "anticipo";
        porcentaje?: number;
    } | null;
    receptoresEscalamiento?: ReceptorEscalamiento[];
    saludoInicial?: string;
    temasTransferencia?: string[];
    ubicacionUrl?: string;
    bloqueado?: boolean;
    velocidadVoz?: number;
}
export declare function buildSystemPrompt(cfg: ConfigNegocio, contextoExtra?: {
    receptorOrigen?: ReceptorEscalamiento | null;
    esRebote?: boolean;
}): string;
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
    private forwardedFrom;
    private receptorOrigen;
    private esRebote;
    private turnos;
    private nombreCliente;
    private saldoBloqueado;
    private tecleoTimer;
    private tecleoDesde;
    private tecleoIdx;
    /** Frames de tecleo REALMENTE enviados en esta espera (para decidir si hay
     *  que limpiar el buffer de Twilio al parar — ver detenerTecleo). */
    private tecleoFramesEnviados;
    private static readonly TECLEO_MAX_MS;
    private ambienteTimer;
    private ambienteIdx;
    constructor(ws: WebSocket, negocioId: string, configNegocio: ConfigNegocio, callerNumber?: string, numeroTwilio?: string, callSid?: string, forwardedFrom?: string);
    private calcularContextoSucursal;
    private esTranscripcionValida;
    private colgarTwilioCall;
    private rechazarPorSaldo;
    private manejarFuncion;
    private iniciarTecleo;
    private detenerTecleo;
    private iniciarAmbiente;
    private detenerAmbiente;
    private enviarFrameCrudo;
    private registrarCallbacks;
    iniciar(): Promise<void>;
    recibirMensajeTwilio(mensaje: any): void;
    private enviarAudioTwilio;
    private limpiarAudioTwilio;
    interrumpir(): void;
    private finalizada;
    /** Cierre por caída/cierre del WS SIN evento "stop" previo. BUG visto en
     *  producción: cuando colgar_llamada fallaba con Twilio y cerrábamos el WS
     *  nosotros, "stop" jamás llegaba → la llamada NO se guardaba (sin
     *  transcripción, sin nombre, sin créditos). Ahora cualquier final llega a
     *  finalizarLlamada exactamente una vez. */
    finalizarPorCierreDeSocket(): void;
    private finalizarLlamada;
}
export {};
//# sourceMappingURL=llamada.d.ts.map