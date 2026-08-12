import WebSocket from "ws";
import twilio from "twilio";
import { OpenAIRealtime, HerramientaVoz } from "../openai/realtime";
import { config, urlPublicaHttps } from "../utils/config";
import { registrarTransferencia, tomarTransferencia } from "../api/transferencias";
import { obtenerVozPorNumero } from "../api/registro-voz";
import { FRAMES_TECLEO, FRAMES_AMBIENTE, MS_POR_FRAME, AMBIENTE_ACTIVO } from "../utils/sonidos";

// Campo adicional que el negocio definió para agendar un servicio concreto
// (ej. "Dirección de recolección"). La llave que se manda al backend es `id`
// (ej. "c1"), nunca el `label`.
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
  // Campos personalizados que hay que recolectar ANTES de agendar este
  // servicio. Puede venir vacío o ausente: en ese caso se agenda como siempre.
  camposAgenda?: CampoAgenda[];
}

interface HorarioDetallado {
  diaSemana: number; // 0=Dom, 1=Lun, ..., 6=Sab
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

// Método de pago que el negocio comunica al cliente para reservas con anticipo.
interface MetodoPagoNegocio {
  tipo: "transferencia" | "deposito" | "paypal" | "mercadopago" | "otro";
  datos: string;
  modalidad: "completo" | "anticipo";
  porcentajeAnticipo?: number;
  instrucciones?: string;
}

// Cálculo de costo de la reserva (lo provee Odin: precio unidad × noches).
interface PagoInfo {
  // El backend manda `dias` (días inclusive). Mantenemos `noches` como alias
  // para retrocompat — si llega cualquiera de los dos, lo usamos.
  noches?: number;
  dias?: number;
  precioTotal: number;
  montoPago: number;
  // Unidad del item (ej. "por noche", "por día", "por hora"). Se usa para
  // que el agente hable con el wording correcto en voz.
  unidad?: string | null;
}

// Receptor configurado por el dueño (sucursal/persona a la que se puede
// escalar). Lo provee Odin como receptoresEscalamiento en la config.
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
  tipo: string; // servicio | habitacion | producto | platillo
  duracionMinutos?: number | null;
  capacidad?: number | null;
  unidad?: string | null;
  // Dirección específica del ítem (terraza/salón en otra ubicación). Si null,
  // se usa la dirección general del negocio.
  direccion?: string | null;
  // Precios por día de la semana (0=Dom...6=Sáb). Si un día no está, se cobra
  // el precio base. El agente debe poder cotizar con esto.
  preciosPorDia?: Record<string, number> | null;
}

export interface ConfigNegocio {
  nombreAgente: string;
  personalidad: string;
  tonoAdicional?: string;
  nombreNegocio: string;
  tipoNegocio: string;
  vertical?: string; // servicios | hospedaje | restaurante | tienda | otro
  horario?: string;
  direccion?: string;
  telefono?: string;
  conocimiento: string;
  habilidades: string; // backward compat (comma-separated)
  // Datos extendidos
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
  // Reservas: si true (solo hospedaje), el agente verifica disponibilidad por
  // unidad/fechas antes de mandar la solicitud al admin. Si hay metodoPago,
  // además solicita el pago/anticipo y solo escala cuando el cliente confirma.
  verificarDisponibilidadReserva?: boolean;
  metodoPago?: MetodoPagoNegocio | null;
  // Todos los métodos de pago configurados (puede haber varios). Si vienen, el
  // agente los menciona todos al cobrar. `metodoPago` se mantiene para
  // retrocompat (es el primero del array).
  metodosPago?: MetodoPagoNegocio[];
  // CITAS con anticipo: si true, el negocio exige un depósito para APARTAR la
  // cita. El agente NO debe prometerla como confirmada: al llamar a agendar_cita
  // el backend la deja en `esperando_pago`, calcula el monto y manda los datos
  // de pago por WhatsApp al número que llamó. `anticipoCitas` trae la modalidad
  // y el % para que el agente pueda hablar del anticipo antes de cerrar.
  requiereAnticipoCitas?: boolean;
  anticipoCitas?: { modalidad: "completo" | "anticipo"; porcentaje?: number } | null;
  // Lista de sucursales/personas a las que el agente puede escalar. Si hay
  // varias, el agente le pregunta al cliente a cuál pasarlo. Si la llamada
  // entró por desvío desde una sucursal específica, esa se asume por defecto.
  receptoresEscalamiento?: ReceptorEscalamiento[];
  // Saludo inicial personalizado que dice el agente al contestar. Vacío = usa
  // el saludo genérico.
  saludoInicial?: string;
  // Temas/frases que disparan transferencia INMEDIATA a un humano: si el
  // cliente menciona alguno, el agente NO intenta resolver, llama directo a
  // escalar_humano.
  temasTransferencia?: string[];
  // URL de Google Maps del negocio (para reenviar por WhatsApp en la llamada).
  ubicacionUrl?: string;
  // GATE DE CRÉDITOS: true cuando el negocio se quedó sin saldo. Odin lo
  // manda desde config-llamada; el pipeline corta la llamada con un mensaje
  // corto en vez de atender gratis.
  bloqueado?: boolean;
  // Velocidad de reproducción de la voz (0.25–1.5, 1.0 default). Opcional:
  // si Odin algún día la manda en config-llamada, aquí ya se respeta.
  velocidadVoz?: number;
  // ── MOTOR DE NICHOS ───────────────────────────────────────────────────────
  // Odin manda estas tres desde config-llamada desde hace tiempo y este server
  // las ignoraba por completo. Consecuencia: por teléfono NO EXISTÍAN las
  // órdenes de servicio, los prospectos, los viajes, las membresías, los cupos
  // ni las reservas de mesa. Un taller cerraba una reparación por WhatsApp y
  // con el mismo asistente no podía por llamada.
  nichoActivo?: boolean;
  /** Bloque de prompt del giro (vocabulario, reglas, catálogo con IDs). */
  nichoPromptBloque?: string;
  /** Una entrada por operación que este negocio puede cerrar. Se registra una
   *  tool por cada una — no hay lista escrita a mano de motores aquí, para que
   *  un motor nuevo en Odin llegue al teléfono sin desplegar este repo. */
  accionesMotor?: AccionMotorVoz[];
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
  campos: { clave: string; tipo: string; requerido: boolean; descripcion: string }[];
  camposGiro: CampoMotorVoz[];
  camposDueno: CampoMotorVoz[];
}

interface TurnoHistorial {
  role: "user" | "assistant";
  content: string;
  itemId?: string;
  pending: boolean;
}

const DIAS_ES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS DE MOTOR — las que Odin declara por negocio (`accionesMotor`)
//
// Se construyen a partir de los datos que llegan, NO de una lista escrita aquí.
// Es la diferencia entre cerrar el hueco una vez y volver a abrirlo con cada
// motor nuevo: el día que Odin agregue el motor 13, el teléfono lo tendrá sin
// tocar este repo ni desplegarlo.
// ─────────────────────────────────────────────────────────────────────────────

/** Tipo del marcador → tipo de JSON Schema. Lo que no se reconozca va como
 *  texto: por teléfono todo llega como palabras y el backend valida al final. */
function tipoJson(tipo: string): Record<string, any> {
  switch (tipo) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string[]":
      return { type: "array", items: { type: "string" } };
    default:
      return { type: "string" };
  }
}

/** Los campos que agregan el giro y el dueño viven juntos en `camposMotor`,
 *  igual que `camposAgenda` en las citas. Las LLAVES son los ids (`c1`), nunca
 *  las etiquetas: es lo que `completarCamposDeAccion` espera del otro lado. */
function propiedadesCamposMotor(campos: CampoMotorVoz[]): Record<string, any> | null {
  if (campos.length === 0) return null;
  const props: Record<string, any> = {};
  for (const c of campos) {
    const desc = [
      c.label,
      c.requerido ? "(OBLIGATORIO)" : "(opcional)",
      c.opciones?.length ? `Opciones: ${c.opciones.join(", ")}.` : "",
      c.ayuda || "",
    ]
      .filter(Boolean)
      .join(" ");
    props[c.id] = c.opciones?.length
      ? { type: "string", enum: c.opciones, description: desc }
      : { type: "string", description: desc };
  }
  return props;
}

function herramientasDeMotor(acciones: AccionMotorVoz[]): HerramientaVoz[] {
  return acciones.map((a) => {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const c of a.campos) {
      properties[c.clave] = { ...tipoJson(c.tipo), description: c.descripcion };
      if (c.requerido) required.push(c.clave);
    }

    const extra = propiedadesCamposMotor([...a.camposGiro, ...a.camposDueno]);
    if (extra) {
      const obligatorios = [...a.camposGiro, ...a.camposDueno]
        .filter((c) => c.requerido)
        .map((c) => c.label);
      properties.camposMotor = {
        type: "object",
        description:
          "Datos adicionales que pide este negocio. Las LLAVES son los IDs de campo, NUNCA las etiquetas." +
          (obligatorios.length > 0
            ? ` Antes de llamar a esta función recolecta conversando: ${obligatorios.join(", ")}.`
            : ""),
        properties: extra,
      };
    }

    return {
      type: "function" as const,
      name: a.tool,
      // La hora en 24 h es un dato interno y el modelo tiende a repetirla en voz
      // alta. Se le recuerda aquí porque la descripción de la tool es lo único
      // que ve en el momento de llamarla.
      description: `${a.descripcion} Recolecta y confirma con el cliente todos los datos obligatorios ANTES de llamarla. Si algún dato incluye una hora, pásala en formato de 24 horas — pero cuando le HABLES al cliente dila siempre en 12 horas con am/pm. NO confirmes la operación hasta que la función responda con éxito.`,
      parameters: { type: "object", properties, required },
    };
  });
}

function construirHerramientas(cfg: ConfigNegocio): HerramientaVoz[] {
  const herramientas: HerramientaVoz[] = [];
  const agendaActiva = cfg.habilidadesActivas?.agenda_citas ?? cfg.habilidades.includes("agenda_citas");
  const escalamientoActivo = cfg.habilidadesActivas?.escalamiento ?? cfg.habilidades.includes("escalamiento");
  const solicitudReservaActiva = cfg.habilidadesActivas?.solicitud_reserva ?? cfg.habilidades.includes("solicitud_reserva");
  const pedidosActiva = cfg.habilidadesActivas?.pedidos ?? cfg.habilidades.includes("pedidos");

  if (agendaActiva) {
    herramientas.push({
      type: "function",
      name: "agendar_cita",
      description: "Agenda una nueva cita para el cliente. Llama esta función solo cuando el cliente haya confirmado el servicio, la fecha y la hora exacta. Si el servicio elegido tiene CAMPOS ADICIONALES (los verás en tu lista de servicios), antes de llamar a esta función debes haber recolectado al menos todos los campos obligatorios y pasarlos en camposAgenda.",
      parameters: {
        type: "object",
        properties: {
          servicioId: { type: "string", description: "ID exacto del servicio (usa los que aparecen en tu lista de servicios)" },
          fechaInicio: { type: "string", description: "Fecha y hora de inicio en formato ISO: YYYY-MM-DDTHH:MM:00" },
          clienteNombre: { type: "string", description: "Nombre del cliente. Pregúntaselo de forma natural ANTES de agendar ('¿A nombre de quién agendo la cita?') si aún no lo ha dicho en la llamada. Si ya lo dijo, úsalo sin volver a preguntar. Si no lo quiere dar, pasa 'Cliente'." },
          profesional: { type: "string", description: "Nombre EXACTO del profesional, solo si el cliente eligió uno que atiende ese servicio. Si no pidió a nadie, omítelo." },
          camposAgenda: {
            type: "object",
            description: "Datos adicionales que pide el servicio elegido. Las LLAVES deben ser los IDs de campo (ej. \"c1\", \"c2\"), NUNCA las etiquetas largas; los valores son lo que dijo el cliente. Inclúyelo SOLO si el servicio tiene campos adicionales; OMÍTELO por completo si el servicio no tiene ninguno.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["servicioId", "fechaInicio", "clienteNombre"],
      },
    });

    herramientas.push({
      type: "function",
      name: "cancelar_cita",
      description: "Cancela una cita existente del cliente. Confirma con el cliente antes de cancelar.",
      parameters: {
        type: "object",
        properties: {
          citaId: { type: "string", description: "ID exacto de la cita a cancelar" },
        },
        required: ["citaId"],
      },
    });

    herramientas.push({
      type: "function",
      name: "reagendar_cita",
      description: "Modifica la fecha, hora o servicio de una cita existente. Incluye solo los campos que cambian.",
      parameters: {
        type: "object",
        properties: {
          citaId: { type: "string", description: "ID exacto de la cita a modificar" },
          servicioId: { type: "string", description: "Nuevo ID de servicio (solo si cambia)" },
          fechaInicio: { type: "string", description: "Nueva fecha y hora ISO: YYYY-MM-DDTHH:MM:00 (solo si cambia)" },
          profesional: { type: "string", description: "Nombre EXACTO del nuevo profesional, solo si el cliente pide cambiarlo." },
        },
        required: ["citaId"],
      },
    });
  }

  if (solicitudReservaActiva) {
    const verificarDisp = cfg.verificarDisponibilidadReserva === true;
    if (verificarDisp) {
      // Modo hospedaje con verificación: la tool recibe fechas estructuradas y
      // el ID de la unidad. El resultado le dice al modelo qué responder
      // (disponibilidad, datos de pago, o escalamiento por pago confirmado).
      herramientas.push({
        type: "function",
        name: "solicitar_reserva",
        description: "Verifica disponibilidad de una reserva de hospedaje y, según el caso, pide el pago o avisa al negocio. NO confirmas tú la reserva — el resultado de esta función te dice EXACTAMENTE qué decirle al cliente (úsalo como tu respuesta). Llama esta función cuando el cliente ya te dio la unidad y las fechas. Si el negocio pide pago, vuelve a llamarla con pagoReportado=true SOLO cuando el cliente diga que ya pagó.",
        parameters: {
          type: "object",
          properties: {
            detalles: { type: "string", description: "Resumen claro para el negocio (unidad, fechas, personas si las hay)." },
            fechaEntrada: { type: "string", description: "Primer día de uso en formato YYYY-MM-DD." },
            fechaSalida: { type: "string", description: "Último día de uso (inclusive) en formato YYYY-MM-DD. Si es un solo día, igual a fechaEntrada." },
            servicioId: { type: "string", description: "ID exacto de la unidad (de tu lista). Omítelo si el cliente no eligió una específica." },
            personas: { type: "number", description: "Número de personas. OPCIONAL — omítelo si el cliente no lo menciona (en terrazas/salones puede no aplicar)." },
            itemNombre: { type: "string", description: "Nombre de la unidad para el negocio, si aplica." },
            clienteNombre: { type: "string", description: "Nombre del cliente. Pregúntaselo de forma natural antes de reservar ('¿A nombre de quién hago la reserva?') si aún no lo dijo. Si ya lo dijo, úsalo sin volver a preguntar." },
            pagoReportado: { type: "boolean", description: "false la primera vez (verificar disponibilidad). Ponlo true ÚNICAMENTE cuando el cliente diga de forma EXPLÍCITA E INEQUÍVOCA que YA realizó el pago (por ejemplo: 'ya transferí', 'ya hice el depósito', 'ya pagué', 'ya te mandé el comprobante'). NUNCA lo pongas true por un 'gracias', 'ok', 'va', 'perfecto', 'ahí va', un silencio o ruido. Si tienes la más mínima duda de si ya pagó, déjalo en false y pregúntale: '¿Ya realizaste el pago?'." },
          },
          required: ["detalles", "fechaEntrada", "fechaSalida"],
        },
      });
    } else {
      // Modo legacy: solo recolecta y manda al admin, sin verificar nada.
      herramientas.push({
        type: "function",
        name: "solicitar_reserva",
        description: "Envía una solicitud de reserva al negocio para que un humano la valide y confirme. Úsalo cuando el cliente quiera reservar (habitación, mesa, evento, etc.). NO confirmas tú la reserva — solo recolectas los datos y los mandas. Despídete del cliente diciendo que el negocio le confirmará en breve por WhatsApp.",
        parameters: {
          type: "object",
          properties: {
            detalles: {
              type: "string",
              description: "Resumen completo y claro de lo que pide el cliente (qué quiere reservar, fechas, cantidad de personas, preferencias). Escribe esto como si fuera un mensaje a un recepcionista humano.",
            },
            fechaSolicitada: {
              type: "string",
              description: "Fecha o rango de fechas que pidió el cliente (formato libre: '15 de mayo', 'del 10 al 12', 'mañana a las 8pm')",
            },
            personas: { type: "number", description: "Número de personas si aplica" },
            itemNombre: { type: "string", description: "Habitación, mesa, servicio o ítem específico que pidió, si aplica" },
            clienteNombre: { type: "string", description: "Nombre del cliente. Pregúntaselo de forma natural antes de enviar la solicitud ('¿A nombre de quién?') si aún no lo dijo." },
          },
          required: ["detalles"],
        },
      });
    }
  }

  if (pedidosActiva) {
    herramientas.push({
      type: "function",
      name: "crear_pedido",
      description: "Registra un pedido de productos/platillos del catálogo. Llama esta función solo cuando el cliente confirmó qué quiere, las cantidades y si es a domicilio, para recoger o en mesa. Usa los IDs EXACTOS del catálogo. NO inventes productos ni precios: el sistema calcula el total.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Lista de productos pedidos.",
            items: {
              type: "object",
              properties: {
                servicioId: { type: "string", description: "ID exacto del producto del catálogo" },
                cantidad: { type: "number", description: "Cantidad pedida (entero >= 1)" },
              },
              required: ["servicioId", "cantidad"],
            },
          },
          tipo: { type: "string", enum: ["domicilio", "recoger", "mesa"], description: "Modalidad de entrega" },
          direccion: { type: "string", description: "Dirección de entrega (solo si es a domicilio)" },
          notas: { type: "string", description: "Indicaciones especiales del cliente, si las hay" },
          clienteNombre: { type: "string", description: "Nombre del cliente. Pregúntaselo de forma natural antes de registrar el pedido ('¿A nombre de quién es el pedido?') si aún no lo dijo." },
        },
        required: ["items", "tipo"],
      },
    });
  }

  if (escalamientoActivo) {
    herramientas.push({
      type: "function",
      name: "escalar_humano",
      description: "Notifica al dueño del negocio para atención humana. Úsalo cuando: el cliente lo pida directamente, haya emergencia, o no puedas resolver el problema. Si hay varias sucursales/personas configuradas, debes especificar cuál (sucursalEtiqueta) según lo que diga el cliente.",
      parameters: {
        type: "object",
        properties: {
          tipo: {
            type: "string",
            enum: ["directo", "emergencia", "no_sabe"],
            description: "directo=cliente pide persona, emergencia=urgencia médica o crítica, no_sabe=agente no puede ayudar",
          },
          resumen: { type: "string", description: "Breve descripción de la situación para el dueño" },
          sucursalEtiqueta: {
            type: "string",
            description: "Etiqueta EXACTA de la sucursal o persona a la que pasar (debe coincidir con una de las opciones de la lista del sistema). Opcional — si solo hay una, omitir; si hay varias, preguntar al cliente y pasar la elegida.",
          },
        },
        required: ["tipo", "resumen"],
      },
    });
  }

  // Aprendizaje siempre activo
  herramientas.push({
    type: "function",
    name: "registrar_pregunta",
    description: "Registra una pregunta del cliente que no pudiste responder por no tener la información. El dueño del negocio la responderá después. Llama esta función cuando digas que no tienes esa información.",
    parameters: {
      type: "object",
      properties: {
        pregunta: { type: "string", description: "Las palabras EXACTAS del cliente, tal como las escuchaste. NO interpretes, NO parafrasees, NO 'mejores' la pregunta. Si la transcripción fue confusa, escribe lo más cercano a lo que escuchaste literalmente." },
        categoria: {
          type: "string",
          enum: ["precios", "horarios", "servicios", "ubicacion", "pagos", "politicas", "otro"],
          description: "Categoría que mejor describe la pregunta",
        },
      },
      required: ["pregunta", "categoria"],
    },
  });

  // Colgar llamada — siempre disponible. El modelo decide cuándo invocarla
  // por sí mismo al detectar despedida del cliente. NO se menciona en el
  // system prompt para no contaminarlo; basta con la descripción de la tool.
  herramientas.push({
    type: "function",
    name: "colgar_llamada",
    description: "Termina la llamada telefónica. Llama esta función SOLO cuando el cliente se haya despedido claramente (por ejemplo: 'gracias, adiós', 'ya con eso', 'hasta luego', 'bye') y no quede ninguna acción pendiente. Despídete brevemente ANTES de llamar a la función. NO la llames si el cliente sigue preguntando o si hay una acción a medias.",
    parameters: {
      type: "object",
      properties: {
        despedida: { type: "string", description: "Frase corta de despedida que ya dijiste o estás por decir" },
      },
      required: ["despedida"],
    },
  });

  // Enviar ubicación por WhatsApp — solo si el negocio tiene Maps/dirección.
  // En una llamada no se puede "pasar" un link, así que lo mandamos al WhatsApp
  // del cliente.
  if (cfg.ubicacionUrl || cfg.direccion) {
    herramientas.push({
      type: "function",
      name: "enviar_ubicacion",
      description: "Envía la ubicación (link de Google Maps / dirección) al WhatsApp del cliente. Úsalo cuando el cliente pida la ubicación o cómo llegar. Avísale que se la mandas por WhatsApp al número desde el que llama.",
      parameters: {
        type: "object",
        properties: {
          itemNombre: {
            type: "string",
            description: "Nombre de la terraza/sucursal específica si el cliente preguntó por una con dirección propia. Opcional.",
          },
        },
        required: [],
      },
    });
  }

  // Las de MOTOR van al final y solo las que Odin declaró para este negocio.
  // Se filtran las que chocan de nombre con una tool escrita a mano: si algún
  // día un motor se llamara `crear_pedido`, dos funciones con el mismo nombre
  // dejarían al modelo eligiendo al azar en mitad de una llamada.
  const yaExisten = new Set(herramientas.map((h) => h.name));
  const deMotor = herramientasDeMotor(cfg.accionesMotor || []).filter((h) => {
    if (yaExisten.has(h.name)) {
      console.warn(`[PIPELINE] Tool de motor "${h.name}" ignorada: ya existe una con ese nombre`);
      return false;
    }
    return true;
  });
  herramientas.push(...deMotor);

  console.log(`[PIPELINE] Herramientas cargadas: ${herramientas.map((h) => h.name).join(", ") || "(ninguna)"}`);
  return herramientas;
}

// Exportada para poder verificar el orden del prompt (ver el aviso de abajo
// sobre el caché) sin tener que levantar una llamada real.
export function buildSystemPrompt(
  cfg: ConfigNegocio,
  contextoExtra?: {
    receptorOrigen?: ReceptorEscalamiento | null;
    esRebote?: boolean;
  },
): string {
  // ⚠️ ORDEN DEL PROMPT — NO MOVER LO VOLÁTIL HACIA ARRIBA ⚠️
  //
  // OpenAI cachea automáticamente el PREFIJO del prompt: si dos llamadas
  // empiezan exactamente igual, esa parte común se cobra a $0.40/1M en vez de
  // $4/1M. Pero exige coincidencia exacta desde el primer carácter y un mínimo
  // de 1024 tokens, y el caché muere a los ~5-10 min de inactividad.
  //
  // Antes, `ahoraStr` (que incluye MINUTOS, o sea distinto en cada llamada) iba
  // arriba, a ~660 tokens del inicio. Eso dejaba el prefijo estable POR DEBAJO
  // del mínimo de 1024 → el caché no se activaba NUNCA y cada llamada pagaba
  // tarifa completa por los ~5-8k tokens de contexto.
  //
  // Por eso TODO lo que cambia entre llamadas del mismo negocio (fecha y hora,
  // contexto de rebote/sucursal, citas de quien llama, receptor por defecto)
  // vive ahora en un solo bloque === CONTEXTO DE ESTA LLAMADA === al FINAL del
  // prompt. Las secciones de arriba que lo necesitan apuntan a él.
  //
  // Si agregas algo que varíe por llamada o por cliente, va en ese bloque final
  // — no en medio del prompt. Se puede verificar en producción: la columna
  // `tokens_cacheados` de `conversaciones` debe ser > 0 en llamadas seguidas al
  // mismo negocio.
  const tz = cfg.zonaHoraria || "America/Mexico_City";
  const ahora = new Date();
  const ahoraStr = ahora.toLocaleString("es-MX", {
    timeZone: tz,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const agendaActiva = cfg.habilidadesActivas?.agenda_citas ?? cfg.habilidades.includes("agenda_citas");
  const escalamientoActivo = cfg.habilidadesActivas?.escalamiento ?? cfg.habilidades.includes("escalamiento");
  const solicitudReservaActiva = cfg.habilidadesActivas?.solicitud_reserva ?? cfg.habilidades.includes("solicitud_reserva");
  const pedidosActiva = cfg.habilidadesActivas?.pedidos ?? cfg.habilidades.includes("pedidos");
  const verificarDispReserva = cfg.verificarDisponibilidadReserva === true && solicitudReservaActiva;
  // CITAS con anticipo: el negocio exige depósito para apartar la cita. El
  // agente pide el anticipo y NO promete la cita confirmada (ver AGENDA DE
  // CITAS). El monto exacto lo calcula el backend al agendar.
  const requiereAnticipoCitas = cfg.requiereAnticipoCitas === true && agendaActiva;
  const anticipoCitasPctVoz =
    requiereAnticipoCitas && cfg.anticipoCitas?.modalidad === "anticipo"
      ? `anticipo del ${cfg.anticipoCitas.porcentaje || 50} por ciento`
      : requiereAnticipoCitas
        ? "pago completo por adelantado"
        : null;
  const metodoPago = cfg.metodoPago || null;
  // Lista completa de métodos. Si vienen, las usamos; si no, fallback al
  // único método legacy.
  const metodosPagoLista: MetodoPagoNegocio[] = cfg.metodosPago && cfg.metodosPago.length > 0
    ? cfg.metodosPago
    : (metodoPago ? [metodoPago] : []);
  const TIPO_LABEL_PAGO_VOZ: Record<string, string> = {
    transferencia: "transferencia bancaria",
    deposito: "depósito en efectivo",
    paypal: "PayPal",
    mercadopago: "Mercado Pago",
    otro: "otro método",
  };
  const metodosPagoTextoVoz = metodosPagoLista.length > 0
    ? metodosPagoLista.map((m, i) => `${i + 1}. ${TIPO_LABEL_PAGO_VOZ[m.tipo] || m.tipo}: ${m.datos}${m.instrucciones ? ` (${m.instrucciones})` : ""}`).join("\n")
    : null;
  const modalidadPagoTextoVoz = metodoPago
    ? (metodoPago.modalidad === "anticipo"
        ? `anticipo del ${metodoPago.porcentajeAnticipo || 50}%`
        : "pago completo")
    : null;

  // Catálogo adaptado al vertical: muestra el inventario con la etiqueta
  // correcta para que el agente hable con naturalidad ("habitaciones" vs
  // "servicios" vs "platillos"). Es aditivo al prompt original.
  const vertical = cfg.vertical || "servicios";
  const catalogo = cfg.catalogo || [];
  const itemsHospedaje = catalogo.filter((i) => i.tipo === "habitacion");
  const itemsPlatillos = catalogo.filter((i) => i.tipo === "platillo");
  const itemsProductos = catalogo.filter((i) => i.tipo === "producto");

  const formatearMoneda = (n: number) => `$${n.toLocaleString("es-MX")} MXN`;

  // Anota precios por día de la semana si difieren del base. El agente lo
  // dice tal cual cuando el cliente pregunta el costo de fechas específicas.
  const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const formatearPreciosPorDia = (precios: Record<string, number> | null | undefined, base: number): string => {
    if (!precios || typeof precios !== "object") return "";
    const parts: string[] = [];
    for (let i = 0; i < 7; i++) {
      const p = Number(precios[String(i)]);
      if (Number.isFinite(p) && p > 0) parts.push(`${DIAS_CORTOS[i]} ${formatearMoneda(p)}`);
    }
    return parts.length > 0 ? ` — Precios por día: ${parts.join(", ")} (días sin valor cobran el precio base)` : "";
  };

  const habitacionesTexto = vertical === "hospedaje" && itemsHospedaje.length > 0
    ? itemsHospedaje.map((h) =>
        `- ${h.nombre}${h.capacidad ? ` (capacidad ${h.capacidad})` : ""} — ${formatearMoneda(h.precio)}${h.unidad ? ` ${h.unidad}` : " por noche"}${h.descripcion ? ` — ${h.descripcion}` : ""}${h.direccion ? ` — Dirección: ${h.direccion}` : ""}${formatearPreciosPorDia(h.preciosPorDia, h.precio)}`
      ).join("\n")
    : null;

  // Cuando se verifica disponibilidad, el modelo necesita el ID de cada unidad
  // para pasarlo a solicitar_reserva. Esta variante incluye [ID:...].
  const habitacionesConId = itemsHospedaje.length > 0
    ? itemsHospedaje.map((h) =>
        `- ${h.nombre} [ID:${h.id}]${h.capacidad ? ` (capacidad ${h.capacidad})` : ""} — ${formatearMoneda(h.precio)}${h.unidad ? ` ${h.unidad}` : " por noche"}${h.descripcion ? ` — ${h.descripcion}` : ""}${h.direccion ? ` — Dirección: ${h.direccion}` : ""}${formatearPreciosPorDia(h.preciosPorDia, h.precio)}`
      ).join("\n")
    : null;

  const menuTexto = vertical === "restaurante" && itemsPlatillos.length > 0
    ? itemsPlatillos.map((p) => `- ${p.nombre} — ${formatearMoneda(p.precio)}${p.descripcion ? ` (${p.descripcion})` : ""}`).join("\n")
    : null;

  const productosTexto = vertical === "tienda" && itemsProductos.length > 0
    ? itemsProductos.map((p) => `- ${p.nombre} — ${formatearMoneda(p.precio)}${p.descripcion ? ` (${p.descripcion})` : ""}`).join("\n")
    : null;

  // Línea de campos adicionales de un servicio. Vacía si el servicio no pide
  // nada extra (se agenda como siempre). El [campo:ID] es el dato que va como
  // llave en camposAgenda — el cliente NUNCA debe escuchar el ID ni la palabra
  // "campo": el agente pregunta usando la etiqueta de forma natural.
  const formatearCamposAgenda = (campos: CampoAgenda[] | undefined): string => {
    if (!campos || campos.length === 0) return "";
    const parts = campos.map(
      (c) => `${c.label} [campo:${c.id}, ${c.requerido ? "OBLIGATORIO" : "opcional"}]`,
    );
    return `\n    Datos a recolectar antes de agendar: ${parts.join("; ")}`;
  };

  const serviciosTexto = cfg.servicios && cfg.servicios.length > 0
    ? cfg.servicios.map((s) =>
        `- ${s.nombre} [ID:${s.id}]${s.duracionMinutos ? ` — ${s.duracionMinutos} min` : ""}${s.precio ? ` — $${s.precio.toLocaleString("es-MX")} MXN` : ""}${s.descripcion ? ` (${s.descripcion})` : ""}${formatearCamposAgenda(s.camposAgenda)}`
      ).join("\n")
    : null;

  const profesionalesTexto = (cfg.profesionales ?? []).map((p) => {
    const nombres = p.atiendeTodosServicios
      ? "todos los servicios"
      : p.servicioIds.map((id) => cfg.servicios?.find((s) => s.id === id)?.nombre).filter(Boolean).join(", ");
    return `- ${p.nombre} — atiende ${nombres}`;
  }).join("\n");

  const horariosTexto = cfg.horarioDetallado && cfg.horarioDetallado.length > 0
    ? cfg.horarioDetallado.map((h) => `${DIAS_ES[h.diaSemana]}: ${h.horaInicio}–${h.horaFin}`).join(", ")
    : cfg.horario || null;

  const citasClienteTexto = cfg.citasCliente && cfg.citasCliente.length > 0
    ? cfg.citasCliente.map((c) => `- [ID:${c.id}] ${c.servicio} — ${c.fechaInicio} — ${c.estado}`).join("\n")
    : null;

  const habilidadesLista: string[] = [];
  if (agendaActiva) habilidadesLista.push("- agenda_citas");
  if (escalamientoActivo) habilidadesLista.push("- escalamiento");
  habilidadesLista.push("- aprendizaje");
  const habilidadesTexto = habilidadesLista.join("\n");

  // ── EL GIRO (motor de nichos) ─────────────────────────────────────────────
  // `nichoPromptBloque` lo arma Odin con la receta del giro: vocabulario
  // ("platillos", no "servicios"), reglas y catálogo con IDs. Llegaba en cada
  // llamada y este server ni lo leía, así que por teléfono el asistente hablaba
  // como si el negocio fuera genérico.
  //
  // Va en la parte ESTABLE del prompt —arriba del bloque de contexto— porque no
  // cambia entre llamadas del mismo negocio: ahí lo cachea OpenAI (ver el aviso
  // del orden del prompt). Meterlo abajo rompería el prefijo de todos.
  //
  // El bloque está redactado para CHAT y habla de marcadores `[ASÍ:{...}]`. Por
  // teléfono no hay dónde escribir uno: esas operaciones son tools. La nota de
  // abajo es lo que traduce una gramática a la otra, y sin ella el modelo
  // "emite" el marcador en voz alta y el cliente escucha un corchete.
  const accionesMotor = cfg.accionesMotor || [];
  const nichoBloque = (cfg.nichoPromptBloque || "").trim();
  const bloqueGiro = nichoBloque
    ? `
=== TU GIRO ===
${nichoBloque}
${
  accionesMotor.length > 0
    ? `
IMPORTANTE — ESTO ES UNA LLAMADA, NO UN CHAT:
Arriba se habla de "marcadores" entre corchetes. Eso es para los mensajes escritos. Por teléfono NO existen: cada una de esas operaciones es una FUNCIÓN que debes invocar.
${accionesMotor.map((a) => `- Para "${a.descripcion.replace(/\s+/g, " ").trim()}" llama a la función ${a.tool}.`).join("\n")}
NUNCA digas en voz alta un corchete, un nombre de marcador, un ID ni un JSON. Son internos.
`
    : ""
}`
    : "";

  // Bloque dinámico al inicio del prompt: si la llamada es un rebote o llegó
  // por desvío desde una sucursal específica, el agente se comporta distinto.
  const bloqueContextoLlamada = (() => {
    if (!contextoExtra) return "";
    if (contextoExtra.esRebote) {
      return `
🚨 CONTEXTO CRÍTICO — ESTA LLAMADA ES UN REBOTE:
El cliente acaba de pedir atención humana. Su llamada fue desviada al humano, pero NO contestó y la llamada rebotó hacia ti. NO saludes como sesión nueva. NO te presentes otra vez. Di directamente:
"Disculpa, parece que el equipo no pudo tomar tu llamada en este momento. ¿Quieres que tome tu recado o prefieres que yo te ayude con tu duda?"
Luego escucha y actúa. NO intentes escalar de nuevo en la misma llamada — el humano ya no contestó.
`;
    }
    if (contextoExtra.receptorOrigen) {
      const r = contextoExtra.receptorOrigen;
      return `
CÓMO LLEGÓ ESTA LLAMADA:
El cliente marcó al número de "${r.etiqueta}" y la llamada se desvió hacia ti porque ahí no contestaron. Menciona "${r.etiqueta}" si aplica para que el cliente se ubique. Si pide hablar con un humano, sugiere primero "${r.etiqueta}" como opción por defecto (pero no insistas si quiere otra).
`;
    }
    return "";
  })();

  // Lista de receptores para que el agente sepa entre cuáles puede elegir
  // al escalar. La pone como contexto separado, no como dato del negocio.
  const receptores = cfg.receptoresEscalamiento || [];
  const receptoresTexto = receptores.length > 0
    ? receptores.map((r) => `- ${r.etiqueta}${r.canal === "whatsapp" ? " (solo por WhatsApp)" : " (por llamada)"}`).join("\n")
    : null;

  // Temas que disparan transferencia INMEDIATA a humano (ej. servicio urgente).
  const temas = (cfg.temasTransferencia || []).filter((t) => typeof t === "string" && t.trim());
  const temasTexto = temas.length > 0 ? temas.map((t) => `- "${t}"`).join("\n") : null;

  return `Eres ${cfg.nombreAgente} de ${cfg.nombreNegocio} (${cfg.tipoNegocio}).
${cfg.personalidad}.${cfg.tonoAdicional ? ` ${cfg.tonoAdicional}` : ""}

FORMATO OBLIGATORIO — ESTÁS EN UNA LLAMADA TELEFÓNICA:
- HABLA, no escribas. Tus respuestas se convierten en voz.
- ABSOLUTAMENTE PROHIBIDO: asteriscos, guiones de lista, negritas (**texto**), numeración (1. 2. 3.), markdown de cualquier tipo.
- Si tienes varios servicios, dícelos como en una conversación: "tenemos limpieza, radiografía y valoración" — no en lista.
- Máximo 2 oraciones por respuesta. Directo y natural.

=== ACTUACIÓN DE VOZ — CÓMO SUENAS (tan importante como lo que dices) ===
Suenas como una recepcionista mexicana real, de carne y hueso, atendiendo el teléfono del negocio. Nadie debe notar que eres IA por tu forma de hablar.
- ENTREGA: cálida, segura, con una sonrisa que se escuche. Frases cortas, una idea por frase, ritmo ágil sin sonar apurada.
- NATURALIDAD: de vez en cuando (no siempre, máximo una por turno) abre con una micro-reacción natural: "claro", "va", "mmm, déjame ver", "perfecto", "ah, sí". Varía SIEMPRE tus arranques: jamás empieces dos turnos seguidos con la misma palabra.
- CONFIRMACIÓN HUMANA: cuando el cliente te dé un dato importante (fecha, hora, nombre, servicio), repítelo breve y natural antes de continuar: "El sábado a las cuatro, perfecto…". Así confirmas sin sonar a robot que lee un formulario.
- NÚMEROS EN VOZ ALTA: los teléfonos se dicen de dos en dos dígitos ("cincuenta y cinco… doce… treinta y cuatro…"); los precios con palabras ("quinientos pesos", nunca "500 pesos" leído en frío); las horas SIEMPRE con "de la mañana / de la tarde / de la noche".
- ADAPTACIÓN: si el cliente habla rápido y va al grano, tú también. Si suena mayor o confundido, baja el ritmo y sé más clara. Si está molesto, suaviza el tono y no lo interrumpas.
- BREVEDAD RADICAL (por teléfono lo largo desespera): máximo ~30 palabras por turno. Si tienes MUCHA información (una lista de servicios, varios horarios), da máximo TRES opciones y pregunta cuál le interesa — jamás recites el catálogo completo de corrido.
- IMPERFECCIÓN CONTROLADA: puedes reformular a media frase como un humano ("tenemos el… bueno, mira, lo que más piden es…") pero solo ocasionalmente y sin perder claridad.
- PROHIBIDO sonar a menú telefónico, a locutora de comercial o a asistente corporativo. Eres una persona del equipo del negocio.
${cfg.saludoInicial && cfg.saludoInicial.trim() ? `
SALUDO INICIAL OBLIGATORIO:
Tu PRIMER mensaje de la llamada debe transmitir esto (dilo natural, hablado, sin leerlo robótico): "${cfg.saludoInicial.trim()}"
` : ""}

DATOS DEL NEGOCIO (solo estos existen):
${cfg.horario ? `- Horario general: ${cfg.horario}` : ""}
${cfg.direccion ? `- Dirección: ${cfg.direccion}` : ""}
${cfg.telefono ? `- Teléfono: ${cfg.telefono}` : ""}

${cfg.conocimiento ? `BASE DE CONOCIMIENTO (esta es TODA la información que tienes, no existe más):\n${cfg.conocimiento}` : "NO TIENES BASE DE CONOCIMIENTO. No tienes información adicional sobre este negocio."}
${serviciosTexto ? `\nCATÁLOGO DE SERVICIOS Y PRODUCTOS:\n${serviciosTexto}` : ""}
${profesionalesTexto ? `\nPROFESIONALES (lista completa):\n${profesionalesTexto}\nSi el cliente pide a alguien, usa su nombre EXACTO en profesional. No ofrezcas a una persona para un servicio que no atiende. Si no pide a nadie, omite profesional y el sistema asignará a quien esté libre.` : ""}
${habitacionesTexto ? `\nLUGARES Y HABITACIONES DISPONIBLES:\n${verificarDispReserva && habitacionesConId ? habitacionesConId : habitacionesTexto}\n(Refiérete a cada uno por su NOMBRE; no digas "servicios" ni asumas que todo es "habitación" — puede ser terraza, salón o cabaña. Para reservar usa la función solicitar_reserva — el agente NO confirma disponibilidad, solo recolecta y manda la solicitud.${verificarDispReserva ? " Los [ID:...] son internos: NUNCA los digas en voz alta." : ""})` : ""}
${menuTexto ? `\nMENÚ:\n${menuTexto}\n(Cuando hables del menú di "platillos" o el nombre de cada uno, no "servicios".)` : ""}
${productosTexto ? `\nPRODUCTOS:\n${productosTexto}` : ""}
${metodosPagoTextoVoz ? `\nMÉTODOS DE PAGO QUE ACEPTA EL NEGOCIO (${modalidadPagoTextoVoz}):\n${metodosPagoTextoVoz}\n(Si te preguntan qué formas de pago aceptan ANTES de reservar, di los TIPOS hablados naturalmente — ej. "aceptamos transferencia bancaria y PayPal". NO dictes números de cuenta, CLABE ni links en voz: dile al cliente que te los envías por WhatsApp. La modalidad aplica a todos los métodos.)` : ""}

${(cfg.ubicacionUrl || cfg.direccion) ? `\nUBICACIÓN:\nSi el cliente pide la ubicación, dirección o cómo llegar, usa la función enviar_ubicacion para mandársela por WhatsApp al número desde el que llama. NO dictes el link de Google Maps por voz (no sirve hablado). Dile algo como "te la mando por WhatsApp ahorita".\n` : ""}
FUNCIONES HABILITADAS (solo puedes hacer esto):
${habilidadesTexto}

INSTRUCCIÓN PRINCIPAL:
Eres un sistema de recuperación de información, NO un asistente inteligente. Tu ÚNICA función es buscar en los datos de arriba y decir lo que encuentres. Lo que no está en los datos NO EXISTE — aunque sea una pregunta obvia, aunque el cliente insista, aunque cualquier negocio "normalmente" lo supiera.

PROCESO OBLIGATORIO para cada mensaje:
1. Busca en tu BASE DE CONOCIMIENTO si hay información RELEVANTE para responder (no necesita ser coincidencia exacta de palabras, basta con que el tema sea el mismo). Si la encuentras → respóndela.
2. ¿No hay nada relevante en el conocimiento? → LLAMA a registrar_pregunta primero, luego usa el "mensaje" del resultado como respuesta.
3. ¿Piden una acción (agendar, reservar, comprar, cotizar)? → ¿Está en funciones habilitadas? Si NO → Di: "No cuento con esa función."

PROHIBICIONES ABSOLUTAS — violar cualquiera es un error crítico:
- NUNCA uses tu conocimiento general sobre ningún tipo de negocio, aunque te parezca lógico o evidente
- NUNCA sugieras procesos, pasos o flujos que no estén escritos arriba
- NUNCA digas "probablemente", "generalmente", "normalmente", "usualmente", "puedes intentar"
- NUNCA inventes precios, horarios, descuentos, promociones, métodos de pago, menús, o servicios
- NUNCA ofrezcas hacer algo que no esté en funciones habilitadas
- Si el cliente repite una pregunta, la respuesta sigue siendo la misma: no tienes esa información. Insistir no cambia lo que sabes.
- Si ya registraste una pregunta, NUNCA la respondas después con tu conocimiento general. La respuesta correcta sigue siendo "no tengo esa información".

REGLAS PARA LLAMADA TELEFÓNICA — CRÍTICAS:
- SIEMPRE habla en ESPAÑOL MEXICANO. NUNCA en inglés ni otro idioma.
- La transcripción a veces llega distorsionada. Si no tiene sentido o parece ruido, di EXACTAMENTE: "Perdón, no te escuché bien, ¿me lo puedes repetir?"
- NUNCA inventes ni respondas a algo que no entendiste claramente.
- Habla como una persona real mexicana por teléfono. Natural y directo.
- Si te interrumpen, calla y escucha.
- Si te preguntan quién eres: di tu nombre y el negocio. Nada más.

NOMBRE DEL CLIENTE — IMPORTANTE:
- Antes de agendar una cita, hacer una reserva o registrar un pedido, pregunta el nombre del cliente de forma natural ("¿A nombre de quién la agendo?") y pásalo en el parámetro clienteNombre de la función.
- Si el cliente ya dijo su nombre en cualquier momento de la llamada, úsalo — NO lo vuelvas a preguntar.
- Si no lo quiere dar, no insistas: usa "Cliente".
${agendaActiva ? `
=== AGENDA DE CITAS ===
HORARIOS DE ATENCIÓN: ${horariosTexto || "No especificado"}

SERVICIOS DISPONIBLES PARA CITAS (usa el ID exacto al agendar):
${serviciosTexto || "No hay servicios configurados"}

(Las citas que YA tiene quien está llamando están hasta el final, en CONTEXTO DE ESTA LLAMADA. Consúltalas ahí antes de reagendar o cancelar.)

REGLAS AL HABLAR DE HORARIOS (obligatorias):
- Di TODA hora en formato de 12 horas con am/pm: "3:00 p.m.", "11:30 a.m."; el mediodía es "12:00 p.m.". NUNCA digas la hora en formato de 24 horas ni la pongas entre paréntesis.
- "El [día]" o "el próximo [día]" = la ocurrencia MÁS CERCANA de ese día. Si dudas, confirma repitiendo el día de la semana + el número antes de agendar (ej. "el martes 8, ¿correcto?").
- NO inventes ni enlistes horarios: no sabes cuáles están ocupados. Si el cliente pregunta "¿qué horarios tienes?", pregúntale a qué hora le gustaría y valida esa hora agendando; el sistema te dirá si está libre o te dará las horas cercanas.
- EN CUANTO el cliente diga una hora concreta, agéndala o reagéndala de inmediato; NO vuelvas a preguntar disponibilidad ni repitas la misma ventana (eso es un bucle).

INSTRUCCIONES PARA CITAS:
1. AGENDAR: El cliente debe confirmar servicio + fecha + hora EXACTA antes de que llames a agendar_cita.
   - Si el horario está ocupado (409), la función te devuelve un mensaje con SOLO las dos horas más cercanas en am/pm: ofréceselas tal cual ("te puedo a las 2:30 o a las 4, ¿cuál prefieres?"), máximo dos por frase. NUNCA recites listas de horarios. Solo si el cliente pide ver el panorama, menciona las ventanas libres como rangos ("tengo libre de 7 a 9 de la mañana"). Si la función no trae horas cercanas, pregúntale al cliente a qué otra hora le gustaría.
   - Solo agenda dentro del horario de atención: ${horariosTexto || "No especificado"}
   - INTERPRETACIÓN AM/PM: por teléfono la gente dice la hora en formato de 12h sin "am/pm". Interpreta SIEMPRE la hora que cae dentro del horario de atención. Ej.: si atiendes de 9 a 6 y el cliente dice "a las 3", es 15:00 (3 de la tarde), NO 03:00. Si la hora cabe en ambos turnos y es ambigua, pregunta "¿a las [hora] de la mañana o de la tarde?" antes de agendar. IMPORTANTE: a la función agendar_cita la hora va SIEMPRE en formato 24h (THH:MM) — ese es un dato interno; pero cuando le HABLES al cliente, di la hora SIEMPRE en 12h con am/pm ("las 3:00 p.m."), nunca en 24h ni entre paréntesis.
   - Usa la fecha y hora actual para calcular fechas relativas ("mañana", "el martes")
   - DATOS ADICIONALES DEL SERVICIO: algunos servicios de tu lista tienen una línea "Datos a recolectar antes de agendar". Si el servicio elegido la tiene:
     · ANTES de llamar a agendar_cita, recolecta conversando TODOS los campos marcados OBLIGATORIO. Pregunta de forma natural usando la etiqueta del campo (ej. para "Dirección de recolección" pregunta "¿En qué dirección recogemos?"). NUNCA digas el ID ni la palabra "campo".
     · Los campos "opcional" pregúntalos solo si fluye natural; si el cliente no los da, omítelos sin insistir.
     · Pasa lo recolectado en el parámetro camposAgenda usando como LLAVE el ID entre [campo:...] (ej. "c1"), nunca la etiqueta. Omite los campos opcionales que el cliente no haya dado.
     · Si el servicio NO tiene esa línea, agenda igual que siempre: NO mandes camposAgenda.
   - REGLA DE ORO: NUNCA confirmes la cita al cliente hasta que agendar_cita responda con éxito. Si la función te dice que faltan datos, pídeselos al cliente exactamente y vuelve a llamar a agendar_cita; no des la cita por hecha mientras falten.${requiereAnticipoCitas ? `
   - ANTICIPO OBLIGATORIO PARA APARTAR: este negocio pide un ${anticipoCitasPctVoz} para reservar la cita. NO prometas la cita como confirmada. Recolecta servicio + fecha + hora y llama a agendar_cita como siempre; el sistema aparta el horario, calcula el monto del anticipo y manda los datos de pago por WhatsApp a este mismo número. La función te devuelve un "mensaje" con el monto — dilo TAL CUAL. Deja claro que la cita SOLO queda confirmada cuando el cliente realice el pago; NO dictes números de cuenta ni links en voz (van por WhatsApp).` : ""}

2. CANCELAR: Confirma explícitamente con el cliente antes de llamar a cancelar_cita. El cliente debe pedir cancelar de forma clara y directa. Si hay ambigüedad, pregunta: "¿Quieres cancelar tu cita?"

3. MODIFICAR HORARIO: Si el cliente quiere cambiar la hora o fecha de una cita existente, usa SIEMPRE reagendar_cita. NUNCA canceles y crees una nueva cita para un cambio de horario.

REGLAS CRÍTICAS de citas:
- NO ejecutes cancelar_cita ni reagendar_cita si el cliente no lo pidió de forma explícita y clara
- Frases como "olvídenlo", "chiste", "cancillería", o cualquier frase ambigua NO son solicitudes de cita
- Ante la duda mínima de si el cliente quiere cancelar o no, pregunta antes de actuar
- NO confirmes una cita hasta tener servicio + fecha + hora exacta del cliente
- Los IDs deben ser exactamente los que aparecen entre [ID:...] arriba` : ""}
${escalamientoActivo ? `
=== ESCALAMIENTO HUMANO — ACCIÓN OBLIGATORIA ===
REGLA CRÍTICA: Cuando detectes cualquiera de estas situaciones, DEBES llamar a escalar_humano ANTES de responder. Solo después de recibir el resultado de la función puedes hablar. Si no llamas a la función, el equipo no se entera y el cliente queda sin atención.

Situaciones que ACTIVAN escalar_humano:
1. tipo="directo": El cliente pide explícitamente hablar con una persona, el dueño, un humano, el gerente, o atención personal.
2. tipo="emergencia": Detectas urgencia médica, amenaza, agresión sostenida, demanda legal, o falla crítica de un servicio ya contratado.
3. tipo="no_sabe": El cliente insiste en algo que ya registraste como pregunta sin respuesta y la situación requiere atención inmediata.
${temasTexto ? `
TRANSFERENCIA INMEDIATA POR TEMA — MÁXIMA PRIORIDAD:
Si el cliente menciona cualquiera de estos temas/situaciones, NO intentes resolverlo, NO pidas datos, NO ofrezcas reservar: llama a escalar_humano (tipo="directo") DE INMEDIATO y dile que lo comunicas con una persona ahora mismo.
${temasTexto}
` : ""}
${receptoresTexto ? `
SUCURSALES O PERSONAS A LAS QUE PUEDES ESCALAR:
${receptoresTexto}

Si hay varias opciones, pregunta al cliente: "¿Con cuál sucursal/persona quieres hablar?". Si solo hay una, úsala sin preguntar. (Si esta llamada llegó desviada desde una sucursal concreta, lo dice el CONTEXTO DE ESTA LLAMADA al final: ésa es la opción por defecto.)
Pasa la etiqueta EXACTA como parámetro "sucursalEtiqueta" en la función escalar_humano.
` : ""}

PROCEDIMIENTO:
1. ${receptoresTexto ? "Pregunta sucursal (si hay varias)." : ""}Llama a escalar_humano con tipo, resumen${receptoresTexto ? " y sucursalEtiqueta" : ""}
2. Usa el campo "mensaje" que devuelve la función como tu respuesta al cliente
3. NO improvises ni digas nada antes de recibir el resultado de la función` : ""}

${verificarDispReserva ? `
=== RESERVAS DE HOSPEDAJE (CON VERIFICACIÓN DE DISPONIBILIDAD) ===
${habitacionesConId ? `Las unidades y sus IDs están en HABITACIONES DISPONIBLES de arriba.` : "El negocio aún no tiene unidades cargadas; recolecta los datos sin ID."}

CÓMO FUNCIONA (tú NUNCA confirmas la reserva — la confirma el negocio):
1. Pregunta al cliente: qué unidad quiere, primer día y último día de uso (ambos inclusive; si es un solo día, son el mismo). El número de personas es OPCIONAL — no insistas si no lo menciona. Convierte las fechas a formato YYYY-MM-DD usando la fecha actual.
2. Cuando tengas la unidad y las fechas, llama a solicitar_reserva con pagoReportado=false.
3. La función te devuelve un "mensaje" — dilo TAL CUAL al cliente (puede ser que no hay disponibilidad${metodoPago ? ", o los datos de pago" : ""}, o que el equipo le confirmará).
${metodoPago ? `4. Como es una llamada y los datos de pago (números de cuenta, links) son difíciles de dictar, dile al cliente que se los ENVIARÁS POR WHATSAPP a este mismo número para que los tenga por escrito.
5. Llama a solicitar_reserva OTRA VEZ con pagoReportado=true SOLO si el cliente confirma de forma EXPLÍCITA E INEQUÍVOCA que YA hizo el pago ("ya transferí", "ya deposité", "ya pagué", "ya mandé el comprobante"). Recién entonces di el "mensaje" que devuelva.` : `4. Aclara siempre que la confirmación del equipo le llegará por WhatsApp a este mismo número.`}

REGLAS:
- NUNCA inventes disponibilidad, precios${metodoPago ? " ni datos de pago" : ""}. Eso lo da la función.
- NUNCA digas que la reserva ya quedó confirmada. Solo el equipo confirma.
- NUNCA digas los [ID:...] en voz alta — son internos.
- PRECIOS POR DÍA: si una unidad tiene "Precios por día" anotados arriba (Lun, Vie, Sáb, etc.), úsalos cuando el cliente pregunte el costo de un día específico ("¿cuánto cuesta el viernes?"). Días sin valor anotado cobran el PRECIO BASE. Si te piden el total de varios días, suma día por día con su precio correspondiente. El backend hace ese cálculo cuando llamas a solicitar_reserva, así que tu trabajo es solo informarlo bien si te lo preguntan ANTES de reservar.${metodoPago ? `
- NO asumas que el cliente ya pagó. Un "gracias", "ok", "va", "perfecto", "ahí va", un silencio o un ruido NO son confirmación de pago. Si dudas, deja pagoReportado en false y pregunta: "¿Ya realizaste el pago?".
- Después de dar los datos de pago, NO vuelvas a llamar a solicitar_reserva hasta que el cliente diga claramente que ya pagó.` : ""}
` : ""}
${bloqueGiro}
=== CONOCIMIENTO FALTANTE — ACCIÓN OBLIGATORIA ===
REGLA CRÍTICA: Cuando el cliente pregunta algo que NO está en tu base de conocimiento, DEBES llamar a registrar_pregunta ANTES de responder. La función confirma el registro y te da el mensaje para el cliente.

PROCEDIMIENTO:
1. Detecta que no tienes la información en tu base de conocimiento
2. Llama a registrar_pregunta con la pregunta exacta y su categoría
3. Usa el campo "mensaje" que devuelve la función como tu respuesta al cliente
4. NO digas "no tengo esa información" sin haber llamado primero a la función

REGLAS:
- Solo llama a registrar_pregunta cuando genuinamente no tengas la información
- No llames a registrar_pregunta por preguntas sobre citas o escalamientos
- Si el cliente repite una pregunta que ya registraste, NO la registres de nuevo. Di: "Ya lo anoté, el equipo te contactará."
- NUNCA intentes responder algo que ya quedó registrado como pregunta sin respuesta

=== CONTEXTO DE ESTA LLAMADA ===
Todo lo anterior es fijo para este negocio. Lo que sigue es de ESTA llamada en concreto y es lo que aplica ahora mismo.

FECHA Y HORA ACTUAL: ${ahoraStr}${bloqueContextoLlamada}${agendaActiva ? (citasClienteTexto ? `

CITAS VIGENTES DE QUIEN LLAMA:
${citasClienteTexto}` : `

CITAS VIGENTES DE QUIEN LLAMA: ninguna.`) : ""}${escalamientoActivo && receptoresTexto && contextoExtra?.receptorOrigen ? `

ESCALAMIENTO POR DEFECTO: si el cliente pide hablar con una persona y no dice con cuál, usa "${contextoExtra.receptorOrigen.etiqueta}" — fue al número que él marcó originalmente.` : ""}`;
}

// Palabras exclusivamente en inglés que nunca aparecen en español conversacional.
const ENGLISH_STOPWORDS = new Set([
  "the", "this", "that", "there", "their", "they", "these", "those",
  "have", "has", "had", "was", "were", "would", "could", "should",
  "your", "you're", "it's", "i'm", "we're", "can't", "don't", "won't",
  "thank", "thanks", "watching", "subscribe", "click", "like", "channel",
  "video", "please", "welcome", "enjoy", "follow", "visit", "website",
  "music", "provided", "copyright", "rights", "reserved",
]);

// Cabecera de autenticación que el voice server manda a Odin en cada petición.
// Odin la valida con verificarSecretoVoz() — sin ella devuelve 401.
function odinAuth(): Record<string, string> {
  return config.voiceServerSecret
    ? { Authorization: `Bearer ${config.voiceServerSecret}` }
    : {};
}

// Fetch con timeout largo + 1 reintento. Antes el timeout era 4s y
// con cold start de Vercel siempre fallaba → agente sin datos del negocio.
async function fetchConfigConRetry(url: string, timeoutMs: number = 10000): Promise<ConfigNegocio | null> {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const resp = await fetch(url, {
        headers: odinAuth(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) return await resp.json() as ConfigNegocio;
      const errBody = await resp.text().catch(() => "");
      console.warn(`[PIPELINE] config-llamada HTTP ${resp.status} (intento ${intento}): ${errBody}`);
      if (resp.status === 404) return null; // no existe → no reintentar
    } catch (err: any) {
      console.warn(`[PIPELINE] config-llamada falló (intento ${intento}): ${err?.message || err}`);
    }
  }
  return null;
}

// Mensaje hablado con los datos de pago. Igual al de Odin (lib/reservas.ts)
// para que WhatsApp y voz suenen idénticos. Usa "por ciento" en vez de "%"
// y "pesos" para que el TTS lo lea bien.
function mensajeDatosPagoVoz(
  mp: MetodoPagoNegocio | MetodoPagoNegocio[],
  info?: PagoInfo,
): string {
  const lista = Array.isArray(mp) ? mp : [mp];
  if (lista.length === 0) return "";
  const primero = lista[0];
  const cantidad = info?.dias ?? info?.noches ?? 0;
  const cantidadValida = typeof cantidad === "number" && isFinite(cantidad) && cantidad > 0 ? cantidad : null;
  const palabraUnidad = (() => {
    const u = (info?.unidad || "").toLowerCase();
    if (u.includes("noche")) return cantidadValida === 1 ? "noche" : "noches";
    if (u.includes("hora")) return cantidadValida === 1 ? "hora" : "horas";
    return cantidadValida === 1 ? "día" : "días";
  })();
  const porDias = cantidadValida ? ` por ${cantidadValida} ${palabraUnidad}` : "";

  const viaDe = (m: MetodoPagoNegocio): string =>
    m.tipo === "transferencia" ? "transferencia"
    : m.tipo === "deposito" ? "depósito"
    : m.tipo === "paypal" ? "PayPal"
    : m.tipo === "mercadopago" ? "Mercado Pago"
    : "otro método";

  // Encabezado con monto (igual que antes pero sin método específico).
  let encabezado = "";
  if (primero.modalidad === "anticipo") {
    const pct = primero.porcentajeAnticipo || 30;
    encabezado = info
      ? `Sí tenemos disponibilidad. El total son ${info.precioTotal.toLocaleString("es-MX")} pesos${porDias}. Para apartar tu reserva necesitas un anticipo del ${pct} por ciento, que son ${info.montoPago.toLocaleString("es-MX")} pesos.`
      : `Sí tenemos disponibilidad. Para apartar tu reserva necesitas un anticipo del ${pct} por ciento.`;
  } else {
    encabezado = info
      ? `Sí tenemos disponibilidad. El total son ${info.montoPago.toLocaleString("es-MX")} pesos${porDias}.`
      : `Sí tenemos disponibilidad.`;
  }

  if (lista.length === 1) {
    const m = lista[0];
    const via = viaDe(m);
    const extra = m.instrucciones ? ` ${m.instrucciones}` : "";
    return `${encabezado} Puedes pagarlo por ${via}: ${m.datos}.${extra} Te paso los datos por WhatsApp. Avísame cuando hayas pagado para confirmarlo con el equipo.`;
  }

  // Varios métodos: enumerar como opciones (en voz, sin números de cuenta).
  const opciones = lista.map(viaDe).join(", o ");
  return `${encabezado} Aceptamos varias formas de pago: ${opciones}. Te paso los datos completos por WhatsApp para que elijas la que prefieras. Avísame cuando hayas pagado para confirmarlo con el equipo.`;
}

// Mensaje hablado cuando una CITA queda apartada esperando el anticipo. En
// llamada NO se dictan datos de pago: el backend (/api/voice/citas) ya los
// mandó por WhatsApp al número que llamó. Aquí solo decimos el monto y que la
// cita se confirma al pagar — NUNCA que ya quedó confirmada.
function mensajeAnticipoCitaVoz(
  monto: number | undefined,
  esMercadoPago: boolean,
  whatsappEnviado: boolean,
): string {
  const montoTxt =
    typeof monto === "number" && isFinite(monto) && monto > 0
      ? ` de ${monto.toLocaleString("es-MX")} pesos`
      : "";
  const via = esMercadoPago ? "un link de pago" : "los datos de pago";
  const envio = whatsappEnviado
    ? `Te acabo de enviar ${via} por WhatsApp a este mismo número.`
    : `En un momento te llegan ${via} por WhatsApp a este mismo número.`;
  return `Para apartar tu cita necesitas un anticipo${montoTxt}. ${envio} En cuanto lo realices, tu cita queda confirmada y el equipo te avisa. ¿Hay algo más en lo que te pueda ayudar?`;
}

// ── Caché de config por número+cliente (TTL corto) ──────────────────────────
// La config del negocio tarda 1.5-3.5s en llegar de Odin (queries a Supabase);
// sin caché, la 2ª llamada seguida saludaba genérico otra vez. La clave incluye
// al CLIENTE porque la config trae SUS citas vigentes (no se comparte entre
// llamantes). El fetch de fondo siempre re-aplica datos frescos.
const configCache = new Map<string, { config: ConfigNegocio; ts: number }>();
const CONFIG_CACHE_TTL_MS = 60_000;

// Normaliza un número telefónico para comparación (solo dígitos, sin +).
function digitosDe(s: string): string {
  return String(s || "").replace(/[^\d]/g, "");
}

// Compara dos números telefónicos por sus últimos 10 dígitos (México).
// Tolera diferencias en el código de país y el "+".
function mismoNumero(a: string, b: string): boolean {
  const da = digitosDe(a);
  const db = digitosDe(b);
  if (!da || !db) return false;
  return da.slice(-10) === db.slice(-10);
}

// Convierte una hora en 24h ("15:00", "07:15") a 12h con am/pm en español
// ("3:00 p.m.", "7:15 a.m."). Mediodía → "12:00 p.m.", medianoche → "12:00 a.m.".
// Si el valor no es parseable lo regresa tal cual (defensivo: nunca truena).
function hora24aAmPm(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? "").trim());
  if (!m) return String(hhmm ?? "");
  const h = Number(m[1]);
  const min = m[2];
  if (!Number.isFinite(h) || h < 0 || h > 23) return String(hhmm ?? "");
  const sufijo = h < 12 ? "a.m." : "p.m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${sufijo}`;
}

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Formatea un "YYYY-MM-DDTHH:MM" (formato interno de fechaInicio) a algo hablable
// en 12h: "el 8 de julio a las 3:00 p.m.". Nunca dice la fecha ISO ni la hora en
// 24h. Si no matchea el patrón, cae a un reemplazo suave para no perder el dato.
function fechaHoraNatural(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}:\d{2})/.exec(String(iso ?? "").trim());
  if (!m) return String(iso ?? "").replace("T", " a las ");
  const dia = Number(m[3]);
  const mes = MESES_ES[Number(m[2]) - 1];
  const hora = hora24aAmPm(m[4]);
  return mes ? `el ${dia} de ${mes} a las ${hora}` : `a las ${hora}`;
}

type Recomendaciones = { antes?: string; despues?: string };
type VentanaLibre = { desde?: string; hasta?: string };

// Construye la respuesta de "horario ocupado" (409) para agendar/reagendar a
// partir del nuevo contrato del backend. Regla de negocio: al hablar NO se
// recitan listas (`slotsDisponibles` queda ignorado a propósito). Se ofrecen
// SOLO las dos horas más cercanas (`recomendaciones`) ya convertidas a 12h;
// las `ventanasLibres` se devuelven formateadas para que el modelo las use solo
// si el cliente pide el panorama. Si no llegan recomendaciones (backend viejo o
// sin cercanas), el fallback es preguntar la hora preferida.
function respuestaHorarioOcupado(data: {
  recomendaciones?: Recomendaciones;
  ventanasLibres?: VentanaLibre[];
}): { ok: false; mensaje: string; recomendaciones?: string[]; ventanasLibres?: string[] } {
  const cercanas: string[] = [];
  const antes = data?.recomendaciones?.antes;
  const despues = data?.recomendaciones?.despues;
  if (typeof antes === "string" && antes.trim()) cercanas.push(hora24aAmPm(antes));
  if (typeof despues === "string" && despues.trim()) cercanas.push(hora24aAmPm(despues));

  const ventanas = Array.isArray(data?.ventanasLibres)
    ? data.ventanasLibres
        .filter((v) => v && typeof v.desde === "string" && typeof v.hasta === "string")
        .map((v) => `de ${hora24aAmPm(v.desde!)} a ${hora24aAmPm(v.hasta!)}`)
    : [];

  let mensaje: string;
  if (cercanas.length === 2) {
    mensaje = `Ese horario ya está ocupado. ¿Te puedo agendar a las ${cercanas[0]} o a las ${cercanas[1]}?`;
  } else if (cercanas.length === 1) {
    mensaje = `Ese horario ya está ocupado. ¿Te sirve a las ${cercanas[0]}, o prefieres otra hora?`;
  } else {
    // Sin horas cercanas: NO recitamos slots. Preguntamos la hora preferida.
    mensaje = `Ese horario ya está ocupado. ¿A qué otra hora te gustaría? Yo reviso si está libre.`;
  }

  const out: { ok: false; mensaje: string; recomendaciones?: string[]; ventanasLibres?: string[] } = { ok: false, mensaje };
  if (cercanas.length > 0) out.recomendaciones = cercanas;
  if (ventanas.length > 0) out.ventanasLibres = ventanas;
  return out;
}

export class PipelineLlamada {
  private ws: WebSocket;
  private realtime: OpenAIRealtime;
  private streamSid: string = "";
  private callSid: string;
  private configNegocio: ConfigNegocio;
  private historialOrdenado: TurnoHistorial[] = [];
  private inicioLlamada: number;
  private negocioId: string;
  private numeroTwilio: string;
  private callerNumber: string;
  // Si la llamada llegó por desvío de Telcel/AT&T, ForwardedFrom dice el
  // número original que marcó el cliente (la sucursal). Lo usamos para dar
  // contexto al agente ("el cliente llamó a la Terraza A").
  private forwardedFrom: string;
  // Receptor que coincide con forwardedFrom (sucursal de origen). Si no hay
  // match o no vino forwarded, queda null.
  private receptorOrigen: ReceptorEscalamiento | null = null;
  // Anti-loop: si el número que llamó (From) coincide con un receptor de la
  // lista, asumimos que es un rebote del Dial que la IA acaba de hacer (el
  // humano no contestó y la llamada volvió por desvío condicional).
  private esRebote: boolean = false;
  private turnos: number = 0;
  // Nombre del cliente recolectado durante la llamada (lo pide el agente al
  // agendar/reservar/pedir). Reemplaza el "Llamada entrante" hardcodeado en
  // citas, conversaciones y notificaciones al gerente.
  private nombreCliente: string = "";
  // true = el negocio no tiene créditos: la llamada se rechazó con mensaje
  // corto y NO se manda webhook de cierre (no hay nada que cobrar/guardar).
  private saldoBloqueado: boolean = false;
  // ── TECLEO de espera ("está buscando en el sistema") ─────────────────────
  // Suena SOLO en la espera silenciosa: después de la frase de espera y
  // mientras el fetch de la herramienta sigue corriendo. Se corta al instante
  // si el cliente habla o cuando el agente retoma la palabra.
  private tecleoTimer: ReturnType<typeof setInterval> | null = null;
  private tecleoDesde: number = 0;
  private tecleoIdx: number = 0;
  /** Frames de tecleo REALMENTE enviados en esta espera (para decidir si hay
   *  que limpiar el buffer de Twilio al parar — ver detenerTecleo). */
  private tecleoFramesEnviados: number = 0;
  private static readonly TECLEO_MAX_MS = 15_000; // red de seguridad
  // ── ROOM TONE (opt-in: AMBIENTE_LLAMADA=on) ──────────────────────────────
  // "Aire" de oficina casi subliminal para matar el silencio digital muerto.
  // Va en cola DESPUÉS del audio del agente (Twilio reproduce en orden), así
  // que nunca ensucia la voz; en interrupciones el "clear" lo tira junto con
  // el resto del buffer.
  private ambienteTimer: ReturnType<typeof setInterval> | null = null;
  private ambienteIdx: number = 0;

  constructor(
    ws: WebSocket,
    negocioId: string,
    configNegocio: ConfigNegocio,
    callerNumber: string = "",
    numeroTwilio: string = "",
    callSid: string = "",
    forwardedFrom: string = "",
  ) {
    this.ws = ws;
    this.negocioId = negocioId;
    this.numeroTwilio = numeroTwilio;
    this.callSid = callSid;
    this.configNegocio = configNegocio;
    this.callerNumber = callerNumber;
    this.forwardedFrom = forwardedFrom;
    this.inicioLlamada = Date.now();

    const prompt = buildSystemPrompt(configNegocio);
    const herramientas = construirHerramientas(configNegocio);
    this.realtime = new OpenAIRealtime(prompt, herramientas, configNegocio.voz || "marin");
  }

  // Después de que llega la config completa, calculamos:
  //  - receptorOrigen: la sucursal a la que originalmente llamó el cliente
  //    (ForwardedFrom matchea un receptor) — para que el agente lo mencione.
  //  - esRebote: la llamada entrante viene de uno de los humanos a los que
  //    acabamos de escalar — el humano no contestó y la llamada rebotó.
  //    En este caso el agente NO debe saludar como sesión nueva: el cliente
  //    ya estaba esperando humano y necesita cierre (recado, otra opción).
  private calcularContextoSucursal() {
    const receptores = this.configNegocio.receptoresEscalamiento || [];
    if (this.forwardedFrom) {
      const match = receptores.find((r) => mismoNumero(r.numero, this.forwardedFrom));
      if (match) {
        this.receptorOrigen = match;
        console.log(`[PIPELINE] Sucursal de origen detectada: ${match.etiqueta} (${match.numero})`);
      }
    }
    // Anti-rebote: cuando hacemos <Dial> al humano usamos callerId=numeroTwilio.
    // Si ese humano tiene desvío condicional al Twilio y NO contesta, la llamada
    // rebota: entra una NUEVA llamada al Twilio cuyo `From` es el propio Twilio
    // number (porque el callerId del Dial era el Twilio). Esa es la firma
    // inequívoca del rebote. ForwardedFrom adicional confirma que vino por
    // desvío desde un receptor de la lista.
    if (
      this.callerNumber &&
      this.numeroTwilio &&
      mismoNumero(this.callerNumber, this.numeroTwilio) &&
      this.forwardedFrom
    ) {
      this.esRebote = true;
      const r = this.receptorOrigen;
      console.log(`[PIPELINE] Llamada detectada como REBOTE${r ? ` desde ${r.etiqueta} (${r.numero})` : ` (forwardedFrom=${this.forwardedFrom})`} — el humano no contestó al Dial`);
    }
  }

  private esTranscripcionValida(texto: string): boolean {
    const t = texto.trim();
    const tLower = t.toLowerCase();

    if (t.length < 4) return false;
    if (tLower.includes("www.") || tLower.includes("http") || tLower.includes(".com") || tLower.includes(".org")) return false;
    if (/^[\s.,!?¿¡0-9\-]+$/.test(t)) return false;

    const ruidoExacto = [
      "gracias.", "gracias", "un saludo.", "un saludo",
      "subs", "subtítulos", "suscríbete", "chau.", "chau",
      "ok.", "ok", "bye.", "bye", "...", ". . .",
    ];
    if (ruidoExacto.includes(tLower)) return false;

    const palabras = tLower.split(/\s+/);
    const inglesCount = palabras.filter((p) => ENGLISH_STOPWORDS.has(p.replace(/[^a-z']/g, ""))).length;
    if (inglesCount >= 2) {
      console.log(`[STT] Descartado (inglés, ${inglesCount} palabras): "${t}"`);
      return false;
    }

    if (palabras.length > 30) {
      console.log(`[STT] Descartado (muy largo, ${palabras.length} palabras): "${t}"`);
      return false;
    }

    return true;
  }

  private async colgarTwilioCall(): Promise<void> {
    if (!this.callSid) {
      console.warn("[FUNCIÓN] colgar_llamada: no hay callSid, cerrando WebSocket");
      try { this.ws.close(); } catch {}
      return;
    }
    try {
      const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
      await client.calls(this.callSid).update({ status: "completed" });
      console.log(`[FUNCIÓN] colgar_llamada: llamada ${this.callSid} colgada vía Twilio API`);
    } catch (err: any) {
      console.error("[FUNCIÓN] colgar_llamada: error con Twilio API, cerrando WS:", err?.message || err);
      try { this.ws.close(); } catch {}
    }
  }

  // GATE DE CRÉDITOS: el negocio no tiene saldo. Cortamos la llamada con un
  // mensaje corto de Twilio (<Say>) en vez de atender gratis con OpenAI
  // Realtime corriendo. Sin webhook de cierre (saldoBloqueado lo omite).
  private async rechazarPorSaldo(): Promise<void> {
    this.saldoBloqueado = true;
    this.detenerTecleo();
    this.detenerAmbiente();
    console.warn(`[PIPELINE] Negocio ${this.negocioId || "?"} SIN créditos — rechazando llamada ${this.callSid}`);
    try { this.realtime.cerrar(); } catch {}
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Polly.Mia">Lo sentimos, por el momento no podemos atender su llamada. Por favor intente más tarde o escríbanos por WhatsApp.</Say>
  <Hangup/>
</Response>`;
    try {
      const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
      await client.calls(this.callSid).update({ twiml });
    } catch (e: any) {
      console.error("[PIPELINE] No se pudo aplicar TwiML de rechazo:", e?.message || e);
      try { this.ws.close(); } catch {}
    }
  }

  private async manejarFuncion(nombre: string, args: any, callId: string): Promise<any> {
    const odinUrl = config.odinAppUrl;
    const negocioId = this.configNegocio.negocioId || this.negocioId;
    const callerNumber = this.callerNumber;

    console.log(`[FUNCIÓN] ${nombre}:`, args);

    // Capturar el nombre del cliente venga de la función que venga: se usa en
    // TODAS las llamadas a Odin y en el webhook de cierre (adiós "Llamada
    // entrante"). "Cliente" es el placeholder cuando no lo quiso dar.
    if (typeof args?.clienteNombre === "string" && args.clienteNombre.trim()) {
      const nom = args.clienteNombre.trim().slice(0, 80);
      if (nom.toLowerCase() !== "cliente") this.nombreCliente = nom;
    }
    const nombreClienteFinal = this.nombreCliente || "Llamada entrante";

    try {
      switch (nombre) {
        case "agendar_cita": {
          const body: Record<string, any> = {
            negocioId,
            servicioId: args.servicioId,
            fechaInicio: args.fechaInicio,
            clienteNombre: nombreClienteFinal,
            clienteTelefono: callerNumber || "desconocido",
            profesional: args.profesional,
          };
          // Campos personalizados del servicio: solo los mandamos si el modelo
          // recolectó al menos uno. La llave es el id del campo (c1, c2…),
          // nunca la etiqueta. Servicios sin camposAgenda → no mandamos la
          // llave y el backend se comporta como siempre.
          if (
            args.camposAgenda &&
            typeof args.camposAgenda === "object" &&
            !Array.isArray(args.camposAgenda)
          ) {
            const entradas = Object.entries(args.camposAgenda).filter(
              ([, v]) => v != null && String(v).trim().length > 0,
            );
            if (entradas.length > 0) {
              body.camposAgenda = Object.fromEntries(
                entradas.map(([k, v]) => [k, String(v)]),
              );
            }
          }

          const resp = await fetch(`${odinUrl}/api/voice/citas`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
          });
          const data = (await resp.json().catch(() => ({}))) as {
            error?: string;
            faltantes?: string[];
            slotsDisponibles?: string[];      // legacy: NO usar al hablar
            recomendaciones?: Recomendaciones;
            ventanasLibres?: VentanaLibre[];
            citaId?: string;
            // Camino ANTICIPO: el negocio exige depósito. El backend NO confirmó
            // la cita; la apartó en `esperando_pago`, calculó el monto y mandó
            // los datos de pago por WhatsApp al número que llamó.
            esperandoPago?: boolean;
            montoAnticipo?: number;
            esMercadoPago?: boolean;
            mensajeWhatsappEnviado?: boolean;
          };
          if (!resp.ok) {
            // 400 FALTAN_CAMPOS: faltó un dato obligatorio del servicio. El
            // backend manda las ETIQUETAS de lo que falta en `faltantes`. Se
            // las pedimos al cliente y el modelo reintentará agendar_cita.
            if (
              data.error === "FALTAN_CAMPOS" &&
              Array.isArray(data.faltantes) &&
              data.faltantes.length > 0
            ) {
              return {
                ok: false,
                mensaje: `Antes de agendar necesito un par de datos más: ${data.faltantes.join(", ")}. ¿Me los puedes dar?`,
              };
            }
            // 409 Horario ocupado: ofrecemos SOLO las dos horas más cercanas
            // (recomendaciones) en 12h. Ya NO recitamos slotsDisponibles.
            if (resp.status === 409 || data.recomendaciones || data.ventanasLibres || data.slotsDisponibles) {
              return respuestaHorarioOcupado(data);
            }
            return { ok: false, mensaje: "No pude registrar la cita. Por favor intenta con otro horario." };
          }
          // 201 con anticipo: la cita NO está confirmada, quedó apartada
          // esperando el pago. Decimos el monto y que los datos van por WhatsApp
          // (el backend ya los envió). NO la damos por confirmada.
          if (data.esperandoPago) {
            return {
              ok: true,
              citaId: data.citaId,
              mensaje: mensajeAnticipoCitaVoz(
                data.montoAnticipo,
                data.esMercadoPago === true,
                data.mensajeWhatsappEnviado === true,
              ),
            };
          }
          // 201 ok: la cita quedó agendada. Recién aquí confirmamos al cliente.
          return { ok: true, citaId: data.citaId, mensaje: `Tu cita quedó registrada para ${fechaHoraNatural(args.fechaInicio)}. ¿Hay algo más en lo que te pueda ayudar?` };
        }

        case "cancelar_cita": {
          const resp = await fetch(`${odinUrl}/api/voice/citas`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            // clienteTelefono: el backend valida que la cita sea de ESTE
            // llamante antes de cancelar (impide cancelar la cita de otro).
            body: JSON.stringify({
              citaId: args.citaId,
              accion: "cancelar",
              clienteTelefono: callerNumber || "desconocido",
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) return { ok: false, mensaje: "No pude cancelar la cita. Por favor contacta al negocio directamente." };
          return { ok: true, mensaje: "Tu cita ha sido cancelada. ¿Hay algo más en lo que te pueda ayudar?" };
        }

        case "reagendar_cita": {
          const resp = await fetch(`${odinUrl}/api/voice/citas`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              citaId: args.citaId,
              accion: "reagendar",
              servicioId: args.servicioId,
              fechaInicio: args.fechaInicio,
              profesional: args.profesional,
              // clienteTelefono: el backend valida que la cita sea de ESTE
              // llamante antes de moverla (impide reagendar la cita de otro).
              clienteTelefono: callerNumber || "desconocido",
            }),
            signal: AbortSignal.timeout(8000),
          });
          const data = (await resp.json().catch(() => ({}))) as {
            slotsDisponibles?: string[];      // legacy: NO usar al hablar
            recomendaciones?: Recomendaciones;
            ventanasLibres?: VentanaLibre[];
          };
          if (!resp.ok) {
            // 409 Horario ocupado al reagendar: mismas dos horas cercanas en 12h.
            if (resp.status === 409 || data.recomendaciones || data.ventanasLibres || data.slotsDisponibles) {
              return respuestaHorarioOcupado(data);
            }
            return { ok: false, mensaje: "No pude modificar la cita. Por favor intenta con otro horario." };
          }
          return { ok: true, mensaje: "Tu cita ha sido actualizada. ¿Hay algo más en lo que te pueda ayudar?" };
        }

        case "solicitar_reserva": {
          const verificarDisponibilidad = this.configNegocio.verificarDisponibilidadReserva === true;
          const pagoReportado = args.pagoReportado === true;
          const resp = await fetch(`${odinUrl}/api/voice/reservar`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              nombreCliente: nombreClienteFinal,
              telefonoCliente: callerNumber || "desconocido",
              detalles: args.detalles,
              fechaSolicitada: args.fechaSolicitada,
              fechaEntrada: args.fechaEntrada,
              fechaSalida: args.fechaSalida,
              servicioId: args.servicioId,
              personas: args.personas,
              itemNombre: args.itemNombre,
              verificarDisponibilidad,
              pagoReportado,
              canal: "voz",
            }),
            signal: AbortSignal.timeout(8000),
          });
          const data = (await resp.json().catch(() => ({}))) as {
            disponible?: boolean;
            esperandoPago?: boolean;
            noDisponible?: boolean;
            metodoPago?: MetodoPagoNegocio;
            metodosPago?: MetodoPagoNegocio[];
            pagoInfo?: PagoInfo;
          };

          if (!resp.ok) {
            // 409 = sin disponibilidad: queremos que el agente lo diga, no que
            // lo trate como error técnico. Por eso ok:true con mensaje honesto.
            if (data.noDisponible || resp.status === 409) {
              return { ok: true, mensaje: "Verifiqué y no tenemos disponibilidad para esas fechas. ¿Quieres que revise otras fechas?" };
            }
            return { ok: false, mensaje: "No pude procesar tu reserva. Por favor intenta más tarde." };
          }

          // Hay disponibilidad pero falta el pago: dar los datos al cliente.
          const metodosListados = data.metodosPago && data.metodosPago.length > 0
            ? data.metodosPago
            : (data.metodoPago ? [data.metodoPago] : []);
          if (data.esperandoPago && metodosListados.length > 0) {
            // Si Odin no mandó las noches (bug conocido: llega undefined), las
            // calculamos desde las fechas para no perder ese dato en la voz.
            let pagoInfo = data.pagoInfo;
            const nochesOk = pagoInfo && typeof pagoInfo.noches === "number" && isFinite(pagoInfo.noches) && pagoInfo.noches > 0;
            if (pagoInfo && !nochesOk && args.fechaEntrada && args.fechaSalida) {
              const ms = Date.parse(args.fechaSalida) - Date.parse(args.fechaEntrada);
              const n = Math.round(ms / 86400000);
              if (Number.isFinite(n) && n > 0) pagoInfo = { ...pagoInfo, noches: n };
            }
            return { ok: true, mensaje: mensajeDatosPagoVoz(metodosListados, pagoInfo) };
          }
          // El cliente ya reportó el pago: el backend avisó al equipo.
          if (pagoReportado) {
            return { ok: true, mensaje: "Perfecto, ya avisé al equipo para que verifique tu pago. Te confirman la reserva en breve. ¿Algo más?" };
          }
          // Disponible y sin método de pago configurado.
          if (data.disponible) {
            return { ok: true, mensaje: "Sí tenemos disponibilidad para esas fechas. El equipo te confirma la reserva en breve. ¿Algo más?" };
          }
          // Legacy (verificar disponibilidad apagado): solo se mandó al admin.
          return { ok: true, mensaje: "Listo, tu solicitud quedó registrada. El negocio te confirmará en breve por WhatsApp. ¿Hay algo más?" };
        }

        case "crear_pedido": {
          const items = Array.isArray(args.items)
            ? args.items.map((x: any) => ({ servicioId: String(x?.servicioId || ""), cantidad: Number(x?.cantidad) || 1 }))
            : [];
          const resp = await fetch(`${odinUrl}/api/voice/pedidos`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              items,
              clienteNombre: nombreClienteFinal,
              clienteTelefono: callerNumber || "desconocido",
              tipo: args.tipo,
              direccion: args.direccion ?? null,
              notas: args.notas ?? null,
            }),
            signal: AbortSignal.timeout(8000),
          });
          const data = (await resp.json().catch(() => ({}))) as { error?: string; total?: number; resumen?: string };
          if (!resp.ok) {
            return { ok: false, mensaje: "Tuve un problema registrando el pedido. ¿Me lo confirmas otra vez, por favor?" };
          }
          return { ok: true, mensaje: `Listo, registré tu pedido por un total de ${data.total} pesos. El negocio te lo confirma en seguida. ¿Algo más?` };
        }

        case "enviar_ubicacion": {
          if (!callerNumber) {
            return { ok: false, mensaje: "No tengo tu número para mandártela por WhatsApp. ¿Me lo puedes dictar?" };
          }
          // Si preguntó por una terraza/sucursal puntual, resolvemos su id para
          // mandar la dirección específica de ese ítem.
          let servicioId: string | undefined;
          const catalogo = this.configNegocio.catalogo;
          if (args.itemNombre && Array.isArray(catalogo)) {
            const item = catalogo.find(
              (it) => it.nombre && it.nombre.toLowerCase().includes(String(args.itemNombre).toLowerCase()),
            );
            if (item && (item as { id?: string }).id) servicioId = (item as { id?: string }).id;
          }
          try {
            const respUbic = await fetch(`${odinUrl}/api/voice/enviar-ubicacion`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...odinAuth() },
              body: JSON.stringify({ negocioId, numero: callerNumber, servicioId }),
              signal: AbortSignal.timeout(8000),
            });
            if (respUbic.ok) {
              return { ok: true, mensaje: "Listo, te acabo de mandar la ubicación por WhatsApp. ¿Algo más?" };
            }
          } catch (e) { /* cae al mensaje de abajo */ }
          return { ok: false, mensaje: "Tuve un problema al mandártela por WhatsApp, pero con gusto te ayudo con otra cosa." };
        }

        case "escalar_humano": {
          // Anti-loop: si la llamada actual ya es un rebote (el humano ya no
          // contestó la primera vez), no intentamos escalar otra vez. Solo
          // notificamos por WhatsApp con el contexto.
          if (this.esRebote) {
            console.log("[FUNCIÓN] escalar_humano: llamada es rebote, no intentamos otro Dial");
            // Aun así notificamos por WhatsApp al gerente para que sepa.
            try {
              await fetch(`${odinUrl}/api/voice/escalar`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...odinAuth() },
                body: JSON.stringify({
                  negocioId,
                  tipo: args.tipo,
                  resumen: `[REBOTE] ${args.resumen}`,
                  telefonoCliente: callerNumber || "desconocido",
                  nombreCliente: nombreClienteFinal,
                  sucursalEtiqueta: args.sucursalEtiqueta,
                }),
                signal: AbortSignal.timeout(8000),
              });
            } catch (e) { /* no bloquear */ }
            return { ok: true, mensaje: "Ya quedó registrado. Avisé al equipo con el contexto de tu llamada para que te contacten." };
          }

          const respEscalar = await fetch(`${odinUrl}/api/voice/escalar`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              tipo: args.tipo,
              resumen: args.resumen,
              telefonoCliente: callerNumber || "desconocido",
              nombreCliente: nombreClienteFinal,
              sucursalEtiqueta: args.sucursalEtiqueta,
            }),
            signal: AbortSignal.timeout(8000),
          });

          // El endpoint puede devolver:
          //  - transferTo: número al que hacer <Dial> (cuando receptor.canal=llamada)
          //  - canalReceptor: "llamada" | "whatsapp" | null
          //  - receptorEtiqueta: nombre de la sucursal/persona avisada
          let transferTo: string | null = null;
          let canalReceptor: "llamada" | "whatsapp" | null = null;
          let receptorEtiqueta: string | null = null;
          if (!respEscalar.ok) {
            const errBody = await respEscalar.text().catch(() => "");
            console.error(`[FUNCIÓN] escalar_humano → HTTP ${respEscalar.status}: ${errBody}`);
          } else {
            console.log(`[FUNCIÓN] escalar_humano → HTTP ${respEscalar.status} OK`);
            const data = (await respEscalar.json().catch(() => ({}))) as {
              transferTo?: string;
              canalReceptor?: "llamada" | "whatsapp";
              receptorEtiqueta?: string;
            };
            transferTo = typeof data?.transferTo === "string" ? data.transferTo : null;
            canalReceptor = data?.canalReceptor || null;
            receptorEtiqueta = data?.receptorEtiqueta || null;
          }

          // Si el receptor elegido fue por WhatsApp (ej. el dueño marcó su
          // número como personal), NO hacemos Dial — el resumen ya se mandó
          // por WhatsApp con la sucursal incluida. Le decimos al cliente.
          if (canalReceptor === "whatsapp" && !transferTo) {
            const a = receptorEtiqueta ? `con ${receptorEtiqueta}` : "con el equipo";
            return { ok: true, mensaje: `Listo, ya le mandé un mensaje detallado a ${a} por WhatsApp con tu solicitud. Te van a contactar en breve. ¿Algo más en lo que te pueda ayudar?` };
          }

          if (transferTo && this.callSid) {
            try {
              // callerId DEBE ser un número que la cuenta Twilio posee — el
              // mismo número del negocio que recibió la llamada. Sin esto,
              // Twilio rechaza el <Dial> silenciosamente y el destino nunca
              // suena.
              const callerIdAttr = this.numeroTwilio
                ? ` callerId="${this.numeroTwilio}"`
                : "";
              // `statusCallback` sobre el <Number> es lo que cierra la fuga de
              // las transferencias: sin él nadie se enteraba de cuánto duró la
              // parte humana, que sigue facturando DOS piernas de Twilio
              // (entrante $0.0100/min + saliente a móvil $0.0473/min) con la IA
              // ya fuera de la línea.
              //
              // Va en el <Number> y NO como `action` del <Dial> a propósito: el
              // `action` solo se dispara si la llamada padre sigue viva cuando
              // termina el <Dial>. Si el CLIENTE cuelga primero — la mitad de
              // los casos — el padre muere y ese callback nunca llega. El
              // statusCallback de la pierna hija es del ciclo de vida de esa
              // llamada, así que dispara sin importar quién colgó.
              //
              // Al no usar `action`, el flujo de la llamada queda EXACTAMENTE
              // como estaba: al terminar el <Dial> sin más verbos, Twilio cuelga.
              const cbEstado = `${urlPublicaHttps()}/transferencia-estado`;
              // NO usamos <Say> de Twilio: cambiaba a Polly.Mia y se notaba
              // el corte de voz vs la del agente (marin/cedar/etc.).
              // En cambio, el AGENTE mismo dice "Te conecto con un asesor"
              // con su propia voz Realtime — eso lo logramos devolviendo
              // `mensaje` al modelo, y aplicando el TwiML después de un
              // pequeño delay para que el agente tenga tiempo de hablar.
              //
              // El delay debe ser suficiente para que termine la frase de
              // ~3s pero no tanto que el cliente se impaciente. 3500ms es
              // un buen middle ground.
              // timeout 25 → 15 s: cada segundo que el receptor no contesta es
              // pierna saliente facturándose para nada, y a los 15 s ya es obvio
              // que no va a contestar.
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${callerIdAttr} timeout="15" answerOnBridge="true"><Number statusCallback="${cbEstado}" statusCallbackEvent="completed" statusCallbackMethod="POST">${transferTo}</Number></Dial>
</Response>`;
              const callSidSnapshot = this.callSid;
              const negocioIdSnapshot = negocioId;
              console.log(`[FUNCIÓN] escalar_humano: programando transfer → ${transferTo} en 3500ms (callerId=${this.numeroTwilio || "default"})`);
              setTimeout(async () => {
                // Registrar ANTES de aplicar el TwiML: Twilio puede resolver el
                // <Dial> y disparar el statusCallback antes de que termine este
                // await, y si la transferencia no estuviera en el mapa todavía
                // el callback se descartaría y ese tramo no se cobraría.
                registrarTransferencia({
                  callSid: callSidSnapshot,
                  negocioId: negocioIdSnapshot,
                  destino: transferTo!,
                  inicioMs: Date.now(),
                });
                try {
                  const twClient = twilio(config.twilioAccountSid, config.twilioAuthToken);
                  const updated = await twClient.calls(callSidSnapshot).update({ twiml });
                  console.log(`[FUNCIÓN] escalar_humano: Twilio status=${updated.status} → ${transferTo}`);
                } catch (e: any) {
                  // Twilio rechazó el TwiML: no hay pierna saliente que cobrar y
                  // el callback nunca va a llegar. Desregistrar para no dejar
                  // basura en el mapa hasta que la purge el TTL.
                  tomarTransferencia(callSidSnapshot);
                  console.error("[FUNCIÓN] escalar_humano: fallo al aplicar TwiML:", e?.message || e, e?.code ? `(code=${e.code})` : "");
                }
              }, 3500);
              // El agente dice esto con su voz Realtime mientras esperamos
              // los 3500ms y Twilio aplica la transferencia. Cuando aplique,
              // Twilio cierra el stream y el cliente escucha el ringing.
              return { ok: true, mensaje: "Perfecto, te paso con un asesor. Un momento, no cuelgues." };
            } catch (e: any) {
              console.error("[FUNCIÓN] escalar_humano: fallo al programar transferencia:", e?.message || e, e?.code ? `(code=${e.code})` : "");
            }
          }

          const mensajes: Record<string, string> = {
            directo: "Listo, ya notifiqué al equipo. Alguien te contactará pronto.",
            emergencia: "Entendido. El equipo fue notificado de inmediato.",
            no_sabe: "Ya notifiqué al equipo para que te contacten con esa información.",
          };
          return { ok: true, mensaje: mensajes[args.tipo] || "Ya notifiqué al equipo." };
        }

        case "registrar_pregunta": {
          const respAprendizaje = await fetch(`${odinUrl}/api/voice/aprendizaje`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              pregunta: args.pregunta,
              categoria: args.categoria,
              telefonoCliente: callerNumber || "desconocido",
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (!respAprendizaje.ok) {
            const errBody = await respAprendizaje.text().catch(() => "");
            console.error(`[FUNCIÓN] registrar_pregunta → HTTP ${respAprendizaje.status}: ${errBody}`);
          } else {
            console.log(`[FUNCIÓN] registrar_pregunta → HTTP ${respAprendizaje.status} OK`);
          }
          return { ok: true, mensaje: "Anotado. El equipo te contactará con esa información." };
        }

        case "colgar_llamada": {
          // Esperar ~2s para que termine de hablar la despedida antes de colgar.
          // El modelo ya emitió la frase de despedida antes de invocar la función.
          setTimeout(() => { this.colgarTwilioCall(); }, 2000);
          return { ok: true, mensaje: "Hasta luego." };
        }

        default: {
          // ── TOOLS DE MOTOR ────────────────────────────────────────────────
          // No hay un `case` por operación a propósito: la lista la manda Odin
          // en `accionesMotor` y aquí solo se traduce a su marcador. Todo lo
          // demás —validar, completar los campos del giro, persistir y avisarle
          // al dueño— lo hace `/api/voice/accion-motor` con el MISMO núcleo que
          // WhatsApp y Meta. Duplicar aquí esa lógica es como los dos canales
          // se desincronizaron la vez pasada.
          const accion = (this.configNegocio.accionesMotor || []).find((a) => a.tool === nombre);
          if (!accion) return { ok: false, mensaje: "Función no reconocida." };

          // Los campos del giro y los del dueño viajan aplanados dentro de
          // `_extras`, que es la llave que `completarCamposDeAccion` conoce.
          const { camposMotor, ...datos } = (args || {}) as Record<string, any>;
          const cuerpo: Record<string, any> = { ...datos };
          if (camposMotor && typeof camposMotor === "object") cuerpo._extras = camposMotor;
          // El nombre lo captura el pipeline llamada a llamada; el marcador lo
          // pide con su propia clave (`nombre` en mesas, `nombreCliente` en las
          // demás), así que solo se rellena la que el esquema declaró y esté vacía.
          for (const clave of ["nombre", "nombreCliente"]) {
            if (accion.campos.some((c) => c.clave === clave) && !cuerpo[clave]) {
              cuerpo[clave] = nombreClienteFinal;
            }
          }
          if (accion.campos.some((c) => c.clave === "telefono") && !cuerpo.telefono) {
            cuerpo.telefono = callerNumber || "";
          }

          const respMotor = await fetch(`${odinUrl}/api/voice/accion-motor`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              telefonoCliente: callerNumber || "desconocido",
              nombreCliente: nombreClienteFinal,
              // Sin `conversacionId` a propósito: la conversación de una llamada
              // la crea Odin al CERRARLA (`/api/webhooks/voice`, dedupe por
              // callSid), así que mientras la llamada corre todavía no existe.
              // Es lo mismo que hacen agendar_cita y crear_pedido.
              marcador: accion.marcador,
              datos: cuerpo,
            }),
            signal: AbortSignal.timeout(10000),
          });

          const dataMotor: any = await respMotor.json().catch(() => ({}));
          if (!respMotor.ok) {
            console.error(`[FUNCIÓN] ${nombre} → HTTP ${respMotor.status}:`, dataMotor);
            return { ok: false, mensaje: "No pude registrarlo en el sistema. ¿Lo intentamos de nuevo?" };
          }

          // LA REGLA DE HONESTIDAD, aplicada al teléfono. Va ANTES que el caso
          // genérico a propósito: cuando el sistema se niega (no queda mesa a
          // esa hora, el grupo no cabe en ninguna), el motivo ya viene redactado
          // para el cliente en `error` y hay que decirlo TAL CUAL. Un "hubo un
          // problema" en su lugar deja al cliente sin saber que puede pedir otra
          // hora, que es la única salida que sí existe.
          //
          // Por chat este texto REEMPLAZA la confirmación que el modelo ya había
          // escrito; en una llamada nada se ha dicho todavía —la tool corre
          // antes de hablar—, así que basta con devolvérselo.
          const primero = Array.isArray(dataMotor?.resultados) ? dataMotor.resultados[0] : null;
          if (primero && primero.ok === false) {
            console.warn(`[FUNCIÓN] ${nombre} → rechazado: ${primero.error}`);
            return {
              ok: false,
              mensaje: primero.error
                ? `${primero.error}. Díselo al cliente con esas palabras y ofrécele otra opción.`
                : "No se pudo completar. Dile la verdad al cliente y ofrécele pasarlo con una persona.",
            };
          }

          // FALTAN DATOS: se le devuelven al modelo con su etiqueta para que se
          // los pida al cliente y vuelva a llamar. En una llamada no se puede
          // "guardar un borrador" — o se completa ahora o se pierde.
          const faltantes: string[] = Array.isArray(dataMotor?.faltantes) ? dataMotor.faltantes : [];
          if ((dataMotor?.ejecutadas ?? 0) === 0) {
            if (faltantes.length > 0) {
              return {
                ok: false,
                mensaje: `Faltan datos para registrarlo. Pregúntale al cliente: ${faltantes.join(", ")}. Después vuelve a llamar a esta función.`,
              };
            }
            console.error(`[FUNCIÓN] ${nombre} → sin ejecutar:`, dataMotor?.errores);
            return { ok: false, mensaje: "No pude registrarlo. Ofrécele pasarlo con una persona." };
          }

          console.log(`[FUNCIÓN] ${nombre} → OK (${accion.marcador})`);
          return { ok: true, mensaje: "Listo, quedó registrado. Confírmaselo al cliente." };
        }
      }
    } catch (err) {
      console.error(`[FUNCIÓN] Error en ${nombre}:`, err);
      return { ok: false, mensaje: "Hubo un problema procesando la acción. Por favor intenta de nuevo." };
    }
  }

  // ── Tecleo de espera ──────────────────────────────────────────────────────
  private iniciarTecleo() {
    if (this.tecleoTimer) return;
    // Arranca en un punto aleatorio del loop para que dos esperas seguidas
    // no suenen idénticas.
    this.tecleoIdx = Math.floor(Math.random() * FRAMES_TECLEO.length);
    this.tecleoDesde = Date.now();
    this.tecleoFramesEnviados = 0;
    this.tecleoTimer = setInterval(() => {
      if (Date.now() - this.tecleoDesde > PipelineLlamada.TECLEO_MAX_MS) {
        this.detenerTecleo();
        return;
      }
      this.tecleoFramesEnviados++;
      this.enviarFrameCrudo(FRAMES_TECLEO[this.tecleoIdx++ % FRAMES_TECLEO.length]);
    }, MS_POR_FRAME);
    console.log("[SONIDO] Tecleo de espera ON");
  }

  private detenerTecleo() {
    if (!this.tecleoTimer) return;
    clearInterval(this.tecleoTimer);
    this.tecleoTimer = null;
    // Limpiar el buffer de Twilio SOLO si se alcanzó a encolar bastante tecleo
    // (>1s): ahí sí conviene cortarlo para que la voz entre ya.
    //
    // BUG que esto corrige (visto en logs de producción): cuando el fetch
    // resolvía rápido, el tecleo llevaba ~70ms y el "clear" incondicional
    // tiraba TODO el buffer — incluida la COLA de la frase de espera que aún
    // se estaba reproduciendo → "Permíteme, reviso la agen—" y silencio seco.
    // Con poco tecleo encolado, mejor dejarlo sonar (termina en <1s solo).
    const limpiar = this.tecleoFramesEnviados > 50; // 50 frames ≈ 1 segundo
    if (limpiar) this.limpiarAudioTwilio();
    console.log(`[SONIDO] Tecleo de espera OFF (${this.tecleoFramesEnviados} frames${limpiar ? ", buffer limpiado" : ", sin limpiar"})`);
  }

  // ── Room tone (opt-in) ────────────────────────────────────────────────────
  private iniciarAmbiente() {
    if (!AMBIENTE_ACTIVO || this.ambienteTimer) return;
    this.ambienteTimer = setInterval(() => {
      // El tecleo manda: cuando suena, el ambiente se pausa (ya trae su aire).
      if (this.tecleoTimer) return;
      this.enviarFrameCrudo(FRAMES_AMBIENTE[this.ambienteIdx++ % FRAMES_AMBIENTE.length]);
    }, MS_POR_FRAME);
    console.log("[SONIDO] Room tone ON (AMBIENTE_LLAMADA=on)");
  }

  private detenerAmbiente() {
    if (!this.ambienteTimer) return;
    clearInterval(this.ambienteTimer);
    this.ambienteTimer = null;
  }

  // Frame μ-law pre-generado directo a Twilio (misma vía que la voz).
  private enviarFrameCrudo(base64Frame: string) {
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: base64Frame },
      }));
    }
  }

  private registrarCallbacks() {
    this.realtime.setOnAudioDelta((b) => {
      // Si el agente empieza a hablar con el tecleo activo (carrera muy
      // corta), el tecleo muere aquí — la voz SIEMPRE gana.
      if (this.tecleoTimer) this.detenerTecleo();
      this.enviarAudioTwilio(b);
    });
    this.realtime.setOnEspera((activa) => (activa ? this.iniciarTecleo() : this.detenerTecleo()));
    this.realtime.setOnInterrupcion(() => {
      this.detenerTecleo();
      this.limpiarAudioTwilio();
    });
    this.realtime.setOnFunctionCall((nombre, args, callId) => this.manejarFuncion(nombre, args, callId));
    this.realtime.setOnItemCreated((itemId) => {
      this.historialOrdenado.push({ role: "user", content: "", itemId, pending: true });
    });
    this.realtime.setOnTranscript((texto, role, itemId) => {
      if (role === "user") {
        const idx = itemId
          ? this.historialOrdenado.findIndex((t) => t.itemId === itemId && t.pending)
          : this.historialOrdenado.findLastIndex((t) => t.role === "user" && t.pending);
        if (!this.esTranscripcionValida(texto)) {
          if (idx !== -1) this.historialOrdenado.splice(idx, 1);
          console.log(`[STT] Descartado (ruido): "${texto}"`);
        } else {
          if (idx !== -1) {
            this.historialOrdenado[idx].content = texto;
            this.historialOrdenado[idx].pending = false;
          } else {
            this.historialOrdenado.push({ role: "user", content: texto, pending: false });
          }
          this.turnos++;
          console.log(`[USUARIO] "${texto}"`);
        }
      } else {
        this.historialOrdenado.push({ role: "assistant", content: texto, pending: false });
        console.log(`[AGENTE] "${texto}"`);
      }
    });
  }

  async iniciar() {
    this.registrarCallbacks();

    // VOZ: leer del registro local (push desde Odin cuando el dueño cambia voz).
    // Si está, usamos esa para el saludo. Si no, fallback a la voz que llegue
    // del fetch (si llega a tiempo) o "marin" por defecto. Es independiente
    // del fetch de config — la voz se decide ANTES del saludo siempre.
    const vozRegistrada = this.numeroTwilio ? obtenerVozPorNumero(this.numeroTwilio) : null;
    if (vozRegistrada) {
      this.configNegocio.voz = vozRegistrada;
    }

    // Iniciamos el fetch de config Y la conexión OpenAI EN PARALELO.
    // Antes esperaba race primero (1.5s) y después conexión (600ms) en serie.
    // Ahora ambos arrancan al mismo tiempo: cuando termine el más lento de
    // los dos, ya tenemos todo listo. Ahorra ~600ms en la mayoría de casos.
    const params = new URLSearchParams();
    if (this.negocioId) params.set("negocioId", this.negocioId);
    if (this.numeroTwilio) params.set("numeroTwilio", this.numeroTwilio);
    if (this.callerNumber) params.set("callerNumber", this.callerNumber);
    const url = `${config.odinAppUrl}/api/voice/config-llamada?${params.toString()}`;

    const fetchPromise = fetchConfigConRetry(url, 10000);
    // El fetch SIEMPRE refresca la caché al resolver (aunque llegue tarde):
    // la siguiente llamada del mismo cliente saluda con memoria al instante.
    const cacheKey = `${this.numeroTwilio}|${this.callerNumber}`;
    fetchPromise
      .then((c) => {
        if (c && !c.bloqueado && c.negocioId) {
          configCache.set(cacheKey, { config: c, ts: Date.now() });
        }
      })
      .catch(() => {});
    const conexionPromise = this.realtime.abrirConexion();

    // FAST-PATH DE CACHÉ: si este número+cliente llamó hace <60s (rellamadas,
    // cortes, pruebas), la config del negocio ya la tenemos — saludo CON
    // memoria sin esperar el fetch (en logs de prod tardaba 1.5-3.5s y el
    // saludo salía genérico). El fetch de fondo re-aplica datos frescos.
    const enCache = configCache.get(cacheKey);
    const configCacheada =
      enCache && Date.now() - enCache.ts < CONFIG_CACHE_TTL_MS ? enCache.config : null;

    let configRapida: ConfigNegocio | null;
    if (configCacheada) {
      await conexionPromise;
      configRapida = configCacheada;
      console.log(`[PIPELINE] Config desde CACHÉ (${Math.round((Date.now() - enCache!.ts) / 1000)}s) — saludo con memoria inmediato`);
      // Refresh de fondo: cuando llegue la config fresca, se re-aplica (citas
      // vigentes del cliente, cambios de catálogo) sin tocar la voz.
      fetchPromise.then((fresca) => {
        if (!fresca) return;
        if (fresca.bloqueado) {
          if (fresca.negocioId) this.negocioId = fresca.negocioId;
          this.rechazarPorSaldo().catch(() => {});
          return;
        }
        this.configNegocio = { ...this.configNegocio, ...fresca };
        if (fresca.negocioId) this.negocioId = fresca.negocioId;
        this.calcularContextoSucursal();
        this.realtime.actualizarConfiguracion(
          buildSystemPrompt(this.configNegocio, { receptorOrigen: this.receptorOrigen, esRebote: this.esRebote }),
          construirHerramientas(this.configNegocio),
        );
        console.log("[PIPELINE] Config fresca re-aplicada sobre la cacheada");
      });
    } else {
      // Race del fetch contra timeout 1.5s. La conexión OpenAI corre en paralelo.
      const [r] = await Promise.all([
        Promise.race([
          fetchPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]),
        conexionPromise,
      ]);
      configRapida = r;
    }

    if (configRapida) {
      // GATE DE CRÉDITOS: sin saldo → mensaje corto y colgar. Nada de OpenAI.
      if (configRapida.bloqueado) {
        if (configRapida.negocioId) this.negocioId = configRapida.negocioId;
        await this.rechazarPorSaldo();
        return;
      }
      // Llegó a tiempo: saludo con memoria. La voz priorizamos el registro
      // local (más reciente), si no la del fetch, si no marin.
      this.configNegocio = { ...this.configNegocio, ...configRapida };
      if (configRapida.negocioId) this.negocioId = configRapida.negocioId;
      if (vozRegistrada) this.configNegocio.voz = vozRegistrada;
      this.calcularContextoSucursal();

      const prompt = buildSystemPrompt(this.configNegocio, {
        receptorOrigen: this.receptorOrigen,
        esRebote: this.esRebote,
      });
      const tools = construirHerramientas(this.configNegocio);
      this.realtime.configurarSesion(prompt, tools, this.configNegocio.voz || "marin", (this.configNegocio as { velocidadVoz?: number }).velocidadVoz ?? null);
      console.log(`[PIPELINE] Saludo con memoria + voz=${this.configNegocio.voz || "marin"} — ${this.configNegocio.nombreNegocio}${this.receptorOrigen ? ` (origen=${this.receptorOrigen.etiqueta})` : ""}${this.esRebote ? " (REBOTE)" : ""}`);
    } else {
      const prompt = buildSystemPrompt(this.configNegocio);
      const tools = construirHerramientas(this.configNegocio);
      this.realtime.configurarSesion(prompt, tools, this.configNegocio.voz || "marin", (this.configNegocio as { velocidadVoz?: number }).velocidadVoz ?? null);
      console.log(`[PIPELINE] Saludo con defaults — config llegará en background (voz=${this.configNegocio.voz || "marin"})`);

      fetchPromise.then((configCompleta) => {
        if (!configCompleta) {
          console.warn("[PIPELINE] Config nunca llegó — agente seguirá con defaults");
          return;
        }
        // GATE DE CRÉDITOS (config tardía): cortar aunque el saludo ya sonó.
        if (configCompleta.bloqueado) {
          if (configCompleta.negocioId) this.negocioId = configCompleta.negocioId;
          this.rechazarPorSaldo().catch(() => {});
          return;
        }
        this.configNegocio = { ...this.configNegocio, ...configCompleta };
        if (configCompleta.negocioId) this.negocioId = configCompleta.negocioId;
        this.calcularContextoSucursal();

        const promptC = buildSystemPrompt(this.configNegocio, {
          receptorOrigen: this.receptorOrigen,
          esRebote: this.esRebote,
        });
        const toolsC = construirHerramientas(this.configNegocio);
        this.realtime.actualizarConfiguracion(promptC, toolsC);
        console.log(`[PIPELINE] Memoria del negocio aplicada (post-saludo): ${configCompleta.nombreNegocio}${this.receptorOrigen ? ` (origen=${this.receptorOrigen.etiqueta})` : ""}${this.esRebote ? " (REBOTE)" : ""}`);
      });
    }
  }

  recibirMensajeTwilio(mensaje: any) {
    switch (mensaje.event) {
      case "start":
        this.streamSid = mensaje.start?.streamSid || "";
        console.log(`[TWILIO] Stream iniciado: ${this.streamSid}`);
        // Room tone (si está activado por env): arranca con el stream.
        this.iniciarAmbiente();
        break;
      case "media":
        if (mensaje.media?.payload) this.realtime.enviarAudio(mensaje.media.payload);
        break;
      case "stop":
        console.log("[TWILIO] Stream detenido");
        this.finalizarLlamada();
        break;
    }
  }

  private enviarAudioTwilio(base64Audio: string) {
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: base64Audio },
      }));
    }
  }

  private limpiarAudioTwilio() {
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
      console.log("[TWILIO] Buffer limpiado (interrupción)");
    }
  }

  interrumpir() {
    this.realtime.cancelarRespuesta();
    this.limpiarAudioTwilio();
  }

  // Idempotencia del cierre: finalizarLlamada puede dispararse por el evento
  // "stop" de Twilio Y por el cierre del WebSocket (ver index.ts). Solo la
  // primera ejecución hace el trabajo.
  private finalizada: boolean = false;

  /** Cierre por caída/cierre del WS SIN evento "stop" previo. BUG visto en
   *  producción: cuando colgar_llamada fallaba con Twilio y cerrábamos el WS
   *  nosotros, "stop" jamás llegaba → la llamada NO se guardaba (sin
   *  transcripción, sin nombre, sin créditos). Ahora cualquier final llega a
   *  finalizarLlamada exactamente una vez. */
  finalizarPorCierreDeSocket() {
    if (this.finalizada) return;
    console.warn("[PIPELINE] WS cerrado sin evento stop → finalizando llamada igual");
    this.finalizarLlamada().catch((e) => console.error("[PIPELINE] Error finalizando por cierre de socket:", e));
  }

  private async finalizarLlamada() {
    if (this.finalizada) return;
    this.finalizada = true;
    this.detenerTecleo();
    this.detenerAmbiente();
    this.realtime.cerrar();

    // Llamada rechazada por falta de créditos: no hubo conversación real —
    // nada que guardar ni cobrar.
    if (this.saldoBloqueado) {
      console.log(`[PIPELINE] Llamada ${this.callSid} rechazada por saldo — webhook omitido`);
      return;
    }

    const duracionSegundos = Math.round((Date.now() - this.inicioLlamada) / 1000);

    const historial = this.historialOrdenado
      .filter((t) => !t.pending && t.content.trim().length > 0)
      .map((t) => ({ role: t.role === "user" ? "user" as const : "assistant" as const, content: t.content }));

    const transcripcion = historial
      .map((t) => `${t.role === "user" ? "Cliente" : "Agente"}: ${t.content}`)
      .join("\n");

    // Costo REAL de la llamada (antes se mandaba 0 y la voz salía "gratis" en los
    // márgenes). OpenAI Realtime se calcula de los tokens que la API reportó;
    // whisper-1 (transcribe el ~40% que habla el cliente, $0.006/min) se estima
    // por duración. costoUsd = costo del proveedor OpenAI (whisper incluido). El
    // minuto de Twilio se registra aparte (es infra, no proveedor de IA).
    const usoVoz = this.realtime.resumenUso();
    const minutos = duracionSegundos / 60;
    const costoWhisper = minutos * 0.4 * 0.006;
    const costoUsd = Number((usoVoz.costoUsd + costoWhisper).toFixed(6));
    // Twilio entrante MX ($0.0100/min) redondeado al minuto, que es como Twilio
    // factura de verdad. Una llamada de 8 s cuesta el minuto completo — por eso
    // el cobro al negocio tiene un mínimo.
    const costoTwilioAprox = Number((Math.ceil(minutos) * 0.01).toFixed(6));

    // ¿El agente alcanzó a hablar? Si OpenAI generó audio, hubo servicio. Si no
    // (sesión murió antes del saludo, TwiML de fallback), Odin no cobra.
    const huboContacto = usoVoz.audioOut > 0;
    console.log(
      `[PIPELINE] Costo voz — OpenAI $${costoUsd} (realtime $${usoVoz.costoUsd.toFixed(6)} + whisper $${costoWhisper.toFixed(6)}) · Twilio ~$${costoTwilioAprox} · tokens`,
      usoVoz,
    );

    console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${this.turnos} turnos`);
    console.log(`[PIPELINE] Enviando ${historial.length} mensajes a Odin`);
    if (historial.length > 0) console.log("[PIPELINE] Historial:\n" + transcripcion);

    // Solo enviar webhook si tenemos un negocioId real (no lookup fallido)
    if (!this.negocioId) {
      console.warn("[PIPELINE] No hay negocioId — webhook a Odin omitido");
      return;
    }

    // Webhook de cierre CON REINTENTOS: aquí viaja la transcripción y el
    // descuento de créditos — si Vercel está frío o falla, antes se perdía
    // todo con un solo intento. El backoff cubre cold starts y caídas cortas;
    // Odin dedupea por callSid, así que reintentar nunca duplica.
    const payload = JSON.stringify({
      negocioId: this.negocioId,
      callSid: this.callSid || null,
      telefonoCliente: this.callerNumber || "desconocido",
      nombreCliente: this.nombreCliente || "Llamada entrante",
      transcripcion,
      duracionSegundos,
      turnos: this.turnos,
      costoUsd,
      // Desglose para auditar margen por negocio en xambee-admin.
      costoOpenaiUsd: costoUsd,
      costoTwilioUsd: costoTwilioAprox,
      tokensEntrada: usoVoz.audioIn + usoVoz.textIn,
      tokensSalida: usoVoz.audioOut + usoVoz.textOut,
      tokensCacheados: usoVoz.cachedAudioIn + usoVoz.cachedTextIn,
      // Señales de cobro (ver calcularCreditosVoz en Odin).
      huboContacto,
      esRebote: this.esRebote,
      historial,
    });
    const ESPERAS_MS = [0, 4000, 15_000, 60_000];
    for (let intento = 1; intento <= ESPERAS_MS.length; intento++) {
      if (ESPERAS_MS[intento - 1] > 0) {
        await new Promise((r) => setTimeout(r, ESPERAS_MS[intento - 1]));
      }
      try {
        const resp = await fetch(`${config.odinAppUrl}/api/webhooks/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...odinAuth() },
          body: payload,
          signal: AbortSignal.timeout(20_000),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) {
          console.log(`[PIPELINE] Webhook Odin → ${resp.status} (intento ${intento}):`, data);
          return;
        }
        console.warn(`[PIPELINE] Webhook Odin HTTP ${resp.status} (intento ${intento}/${ESPERAS_MS.length}):`, data);
        // 4xx = payload/config mal (reintentar no ayuda); 5xx/timeout sí.
        if (resp.status >= 400 && resp.status < 500) return;
      } catch (err: any) {
        console.warn(`[PIPELINE] Webhook Odin falló (intento ${intento}/${ESPERAS_MS.length}):`, err?.message || err);
      }
    }
    console.error(`[PIPELINE] Webhook Odin AGOTÓ reintentos — llamada ${this.callSid} sin registrar`);
  }
}
