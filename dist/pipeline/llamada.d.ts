import WebSocket from "ws";
import { HerramientaVoz } from "../openai/realtime";
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
    nichoActivo?: boolean;
    /** Bloque de prompt del giro (vocabulario, reglas, catálogo con IDs). */
    nichoPromptBloque?: string;
    /** Una entrada por operación que este negocio puede cerrar. Se registra una
     *  tool por cada una — no hay lista escrita a mano de motores aquí, para que
     *  un motor nuevo en Odin llegue al teléfono sin desplegar este repo. */
    accionesMotor?: AccionMotorVoz[];
    /** Los datos que el DUEÑO configuró de más para cita, reserva y pedido — las
     *  tres operaciones con tool escrita a mano aquí. Odin las mandaba desde hace
     *  tiempo y este server las ignoraba, así que en un negocio con datos propios
     *  configurados el backend rechazaba con FALTAN_CAMPOS y la cita, la reserva
     *  o el pedido NO SE PODÍAN CERRAR POR TELÉFONO: el agente preguntaba, el
     *  cliente contestaba y al final no quedaba registro de nada.
     *
     *  Las llaves son ids de campo (`c1`), nunca etiquetas. Viajan de vuelta en
     *  `camposAgenda` (citas) o `camposMotor` (reserva y pedido) — no es un
     *  capricho: es la llave que cada endpoint de Odin ya espera. */
    datosDuenoPorTipo?: Partial<Record<"cita" | "reserva" | "pedido", CampoMotorVoz[]>>;
    /** Lo que este negocio deja CONSULTAR, CAMBIAR y CANCELAR de lo ya creado, y
     *  con qué campos exactamente. La lista blanca la calcula Odin de sus motores
     *  encendidos: aquí no se decide nada, solo se declara la tool. Vacío = el
     *  negocio no tiene esos motores y no se registra ninguna. */
    operacionesCliente?: OperacionClienteVoz[];
    /** Lo que QUIEN LLAMA ya tiene abierto (máx. 6). Cambia por llamante, así que
     *  vive en el bloque de contexto del final del prompt — nunca arriba, o se
     *  tira el caché del prefijo de todas las llamadas del negocio. */
    operacionesClienteResumen?: FilaOperacionClienteVoz[];
}
/** Un campo que el cliente PUEDE cambiar de una operación ya creada. Espejo de
 *  `CampoEditableCliente` en `Odin/app/lib/motores/operaciones-cliente.ts`. */
interface CampoEditableVoz {
    clave: string;
    tipo: "texto" | "numero" | "si_no" | "fecha" | "fecha_hora";
    descripcion: string;
}
interface OperacionClienteVoz {
    /** `pedido`, `orden`, `viaje`… Es lo que se manda como `tipo`. */
    tipo: string;
    /** Cómo se llama en español, para que el agente lo diga natural. */
    etiqueta: string;
    /** Vacío = solo se puede consultar y cancelar. */
    camposEditables: CampoEditableVoz[];
}
interface FilaOperacionClienteVoz {
    tipo: string;
    etiqueta: string;
    /** Los 8 caracteres con los que el cliente la identifica. */
    referencia: string;
    resumen: string;
    estado: string;
}
/** Un dato que el agente tiene que recolectar. Espejo de `CampoVoz` en
 *  `Odin/app/lib/motores/voz.ts`. */
interface CampoMotorVoz {
    id: string;
    label: string;
    requerido: boolean;
    tipo: string;
    opciones?: string[];
    ayuda?: string;
}
interface AccionMotorVoz {
    /** Nombre de la función a registrar (`reservar_mesa`, `registrar_orden`…). */
    tool: string;
    /** Marcador equivalente. Es lo que se le manda a /api/voice/accion-motor. */
    marcador: string;
    descripcion: string;
    campos: {
        clave: string;
        tipo: string;
        requerido: boolean;
        descripcion: string;
    }[];
    camposGiro: CampoMotorVoz[];
    camposDueno: CampoMotorVoz[];
}
export declare function construirHerramientas(cfg: ConfigNegocio): HerramientaVoz[];
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