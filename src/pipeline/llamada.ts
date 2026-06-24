import WebSocket from "ws";
import twilio from "twilio";
import { OpenAIRealtime, HerramientaVoz } from "../openai/realtime";
import { config } from "../utils/config";
import { obtenerVozPorNumero } from "../api/registro-voz";

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
}

interface TurnoHistorial {
  role: "user" | "assistant";
  content: string;
  itemId?: string;
  pending: boolean;
}

const DIAS_ES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

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
          camposAgenda: {
            type: "object",
            description: "Datos adicionales que pide el servicio elegido. Las LLAVES deben ser los IDs de campo (ej. \"c1\", \"c2\"), NUNCA las etiquetas largas; los valores son lo que dijo el cliente. Inclúyelo SOLO si el servicio tiene campos adicionales; OMÍTELO por completo si el servicio no tiene ninguno.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["servicioId", "fechaInicio"],
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

  console.log(`[PIPELINE] Herramientas cargadas: ${herramientas.map((h) => h.name).join(", ") || "(ninguna)"}`);
  return herramientas;
}

function buildSystemPrompt(
  cfg: ConfigNegocio,
  contextoExtra?: {
    receptorOrigen?: ReceptorEscalamiento | null;
    esRebote?: boolean;
  },
): string {
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
CONTEXTO DE ESTA LLAMADA:
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
${cfg.saludoInicial && cfg.saludoInicial.trim() ? `
SALUDO INICIAL OBLIGATORIO:
Tu PRIMER mensaje de la llamada debe transmitir esto (dilo natural, hablado, sin leerlo robótico): "${cfg.saludoInicial.trim()}"
` : ""}

FECHA Y HORA ACTUAL: ${ahoraStr}
${bloqueContextoLlamada}

DATOS DEL NEGOCIO (solo estos existen):
${cfg.horario ? `- Horario general: ${cfg.horario}` : ""}
${cfg.direccion ? `- Dirección: ${cfg.direccion}` : ""}
${cfg.telefono ? `- Teléfono: ${cfg.telefono}` : ""}

${cfg.conocimiento ? `BASE DE CONOCIMIENTO (esta es TODA la información que tienes, no existe más):\n${cfg.conocimiento}` : "NO TIENES BASE DE CONOCIMIENTO. No tienes información adicional sobre este negocio."}
${serviciosTexto ? `\nCATÁLOGO DE SERVICIOS Y PRODUCTOS:\n${serviciosTexto}` : ""}
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
${agendaActiva ? `
=== AGENDA DE CITAS ===
HORARIOS DE ATENCIÓN: ${horariosTexto || "No especificado"}

SERVICIOS DISPONIBLES PARA CITAS (usa el ID exacto al agendar):
${serviciosTexto || "No hay servicios configurados"}
${citasClienteTexto ? `\nCITAS VIGENTES DEL CLIENTE:\n${citasClienteTexto}` : "\nEste cliente no tiene citas vigentes."}

INSTRUCCIONES PARA CITAS:
1. AGENDAR: El cliente debe confirmar servicio + fecha + hora EXACTA antes de que llames a agendar_cita.
   - Si el sistema responde que el horario está ocupado, informa los horarios disponibles y pregunta cuál prefiere.
   - Solo agenda dentro del horario de atención: ${horariosTexto || "No especificado"}
   - INTERPRETACIÓN AM/PM: por teléfono la gente dice la hora en formato de 12h sin "am/pm". Interpreta SIEMPRE la hora que cae dentro del horario de atención. Ej.: si atiendes de 9 a 6 y el cliente dice "a las 3", es 15:00 (3 de la tarde), NO 03:00. Si la hora cabe en ambos turnos y es ambigua, pregunta "¿a las [hora] de la mañana o de la tarde?" antes de agendar. A agendar_cita la hora va SIEMPRE en formato 24h (THH:MM); cuando le confirmes la hora al cliente, dila con "de la mañana/tarde/noche" para que no haya confusión.
   - Usa la fecha y hora actual para calcular fechas relativas ("mañana", "el martes")
   - DATOS ADICIONALES DEL SERVICIO: algunos servicios de tu lista tienen una línea "Datos a recolectar antes de agendar". Si el servicio elegido la tiene:
     · ANTES de llamar a agendar_cita, recolecta conversando TODOS los campos marcados OBLIGATORIO. Pregunta de forma natural usando la etiqueta del campo (ej. para "Dirección de recolección" pregunta "¿En qué dirección recogemos?"). NUNCA digas el ID ni la palabra "campo".
     · Los campos "opcional" pregúntalos solo si fluye natural; si el cliente no los da, omítelos sin insistir.
     · Pasa lo recolectado en el parámetro camposAgenda usando como LLAVE el ID entre [campo:...] (ej. "c1"), nunca la etiqueta. Omite los campos opcionales que el cliente no haya dado.
     · Si el servicio NO tiene esa línea, agenda igual que siempre: NO mandes camposAgenda.
   - REGLA DE ORO: NUNCA confirmes la cita al cliente hasta que agendar_cita responda con éxito. Si la función te dice que faltan datos, pídeselos al cliente exactamente y vuelve a llamar a agendar_cita; no des la cita por hecha mientras falten.

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

Si hay varias opciones, pregunta al cliente: "¿Con cuál sucursal/persona quieres hablar?". Si solo hay una, úsala sin preguntar.${contextoExtra?.receptorOrigen ? ` Si el cliente no especifica, usa "${contextoExtra.receptorOrigen.etiqueta}" porque fue al que él llamó originalmente.` : ""}
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
- NUNCA intentes responder algo que ya quedó registrado como pregunta sin respuesta`;
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

  private async manejarFuncion(nombre: string, args: any, callId: string): Promise<any> {
    const odinUrl = config.odinAppUrl;
    const negocioId = this.configNegocio.negocioId || this.negocioId;
    const callerNumber = this.callerNumber;

    console.log(`[FUNCIÓN] ${nombre}:`, args);

    try {
      switch (nombre) {
        case "agendar_cita": {
          const body: Record<string, any> = {
            negocioId,
            servicioId: args.servicioId,
            fechaInicio: args.fechaInicio,
            clienteNombre: "Llamada entrante",
            clienteTelefono: callerNumber || "desconocido",
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
            slotsDisponibles?: string[];
            citaId?: string;
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
            // 409 Horario ocupado: ofrecer los horarios disponibles.
            if (data.slotsDisponibles) {
              return {
                ok: false,
                mensaje: `Ese horario está ocupado. Los horarios disponibles ese día son: ${data.slotsDisponibles.join(", ")}. ¿Cuál te conviene?`,
              };
            }
            return { ok: false, mensaje: "No pude registrar la cita. Por favor intenta con otro horario." };
          }
          // 201 ok: la cita quedó agendada. Recién aquí confirmamos al cliente.
          return { ok: true, citaId: data.citaId, mensaje: `Tu cita quedó registrada para ${args.fechaInicio.replace("T", " a las ")}. ¿Hay algo más en lo que te pueda ayudar?` };
        }

        case "cancelar_cita": {
          const resp = await fetch(`${odinUrl}/api/voice/citas`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({ citaId: args.citaId, accion: "cancelar" }),
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
            }),
            signal: AbortSignal.timeout(8000),
          });
          const data = await resp.json() as { slotsDisponibles?: string[] };
          if (!resp.ok) {
            if (data.slotsDisponibles) {
              return {
                ok: false,
                mensaje: `Ese horario está ocupado. Los horarios disponibles son: ${data.slotsDisponibles.join(", ")}. ¿Cuál prefieres?`,
              };
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
              nombreCliente: "Llamada entrante",
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
              clienteNombre: "Llamada entrante",
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
                  nombreCliente: "Llamada entrante",
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
              nombreCliente: "Llamada entrante",
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
              const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${callerIdAttr} timeout="25" answerOnBridge="true">${transferTo}</Dial>
</Response>`;
              const callSidSnapshot = this.callSid;
              console.log(`[FUNCIÓN] escalar_humano: programando transfer → ${transferTo} en 3500ms (callerId=${this.numeroTwilio || "default"})`);
              setTimeout(async () => {
                try {
                  const twClient = twilio(config.twilioAccountSid, config.twilioAuthToken);
                  const updated = await twClient.calls(callSidSnapshot).update({ twiml });
                  console.log(`[FUNCIÓN] escalar_humano: Twilio status=${updated.status} → ${transferTo}`);
                } catch (e: any) {
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

        default:
          return { ok: false, mensaje: "Función no reconocida." };
      }
    } catch (err) {
      console.error(`[FUNCIÓN] Error en ${nombre}:`, err);
      return { ok: false, mensaje: "Hubo un problema procesando la acción. Por favor intenta de nuevo." };
    }
  }

  private registrarCallbacks() {
    this.realtime.setOnAudioDelta((b) => this.enviarAudioTwilio(b));
    this.realtime.setOnInterrupcion(() => this.limpiarAudioTwilio());
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
    const conexionPromise = this.realtime.abrirConexion();

    // Race del fetch contra timeout 1.5s. La conexión OpenAI corre en paralelo.
    const [configRapida] = await Promise.all([
      Promise.race([
        fetchPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]),
      conexionPromise,
    ]);

    if (configRapida) {
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
      this.realtime.configurarSesion(prompt, tools, this.configNegocio.voz || "marin");
      console.log(`[PIPELINE] Saludo con memoria + voz=${this.configNegocio.voz || "marin"} — ${this.configNegocio.nombreNegocio}${this.receptorOrigen ? ` (origen=${this.receptorOrigen.etiqueta})` : ""}${this.esRebote ? " (REBOTE)" : ""}`);
    } else {
      const prompt = buildSystemPrompt(this.configNegocio);
      const tools = construirHerramientas(this.configNegocio);
      this.realtime.configurarSesion(prompt, tools, this.configNegocio.voz || "marin");
      console.log(`[PIPELINE] Saludo con defaults — config llegará en background (voz=${this.configNegocio.voz || "marin"})`);

      fetchPromise.then((configCompleta) => {
        if (!configCompleta) {
          console.warn("[PIPELINE] Config nunca llegó — agente seguirá con defaults");
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

  private async finalizarLlamada() {
    this.realtime.cerrar();

    const duracionSegundos = Math.round((Date.now() - this.inicioLlamada) / 1000);

    const historial = this.historialOrdenado
      .filter((t) => !t.pending && t.content.trim().length > 0)
      .map((t) => ({ role: t.role === "user" ? "user" as const : "assistant" as const, content: t.content }));

    const transcripcion = historial
      .map((t) => `${t.role === "user" ? "Cliente" : "Agente"}: ${t.content}`)
      .join("\n");

    console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${this.turnos} turnos`);
    console.log(`[PIPELINE] Enviando ${historial.length} mensajes a Odin`);
    if (historial.length > 0) console.log("[PIPELINE] Historial:\n" + transcripcion);

    // Solo enviar webhook si tenemos un negocioId real (no lookup fallido)
    if (!this.negocioId) {
      console.warn("[PIPELINE] No hay negocioId — webhook a Odin omitido");
      return;
    }

    try {
      const resp = await fetch(`${config.odinAppUrl}/api/webhooks/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...odinAuth() },
        body: JSON.stringify({
          negocioId: this.negocioId,
          telefonoCliente: this.callerNumber || "desconocido",
          nombreCliente: "Llamada entrante",
          transcripcion,
          duracionSegundos,
          turnos: this.turnos,
          costoUsd: 0,
          historial,
        }),
      });
      const data = await resp.json();
      console.log(`[PIPELINE] Webhook Odin → ${resp.status}:`, data);
    } catch (err) {
      console.error("[PIPELINE] Error notificando a Odin:", err);
    }
  }
}
