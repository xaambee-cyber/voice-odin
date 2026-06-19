import WebSocket from "ws";
import twilio from "twilio";
import { OpenAIRealtime, HerramientaVoz } from "../openai/realtime";
import { config } from "../utils/config";
import { obtenerVozPorNumero } from "../api/registro-voz";

interface Servicio {
  id: string;
  nombre: string;
  duracionMinutos: number;
  precio: number;
  descripcion?: string;
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
}

// Método de pago que el negocio comunica al cliente para reservas con anticipo.
interface MetodoPagoNegocio {
  tipo: "transferencia" | "paypal" | "mercadopago" | "otro";
  datos: string;
  modalidad: "completo" | "anticipo";
  porcentajeAnticipo?: number;
  instrucciones?: string;
}

// Cálculo de costo de la reserva (lo provee Odin: precio unidad × noches).
interface PagoInfo {
  noches: number;
  precioTotal: number;
  montoPago: number;
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

  if (agendaActiva) {
    herramientas.push({
      type: "function",
      name: "agendar_cita",
      description: "Agenda una nueva cita para el cliente. Llama esta función solo cuando el cliente haya confirmado el servicio, la fecha y la hora exacta.",
      parameters: {
        type: "object",
        properties: {
          servicioId: { type: "string", description: "ID exacto del servicio (usa los que aparecen en tu lista de servicios)" },
          fechaInicio: { type: "string", description: "Fecha y hora de inicio en formato ISO: YYYY-MM-DDTHH:MM:00" },
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

  if (escalamientoActivo) {
    herramientas.push({
      type: "function",
      name: "escalar_humano",
      description: "Notifica al dueño del negocio para atención humana. Úsalo cuando: el cliente lo pida directamente, haya emergencia, o no puedas resolver el problema.",
      parameters: {
        type: "object",
        properties: {
          tipo: {
            type: "string",
            enum: ["directo", "emergencia", "no_sabe"],
            description: "directo=cliente pide persona, emergencia=urgencia médica o crítica, no_sabe=agente no puede ayudar",
          },
          resumen: { type: "string", description: "Breve descripción de la situación para el dueño" },
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

  console.log(`[PIPELINE] Herramientas cargadas: ${herramientas.map((h) => h.name).join(", ") || "(ninguna)"}`);
  return herramientas;
}

function buildSystemPrompt(cfg: ConfigNegocio): string {
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
  const verificarDispReserva = cfg.verificarDisponibilidadReserva === true && solicitudReservaActiva;
  const metodoPago = cfg.metodoPago || null;

  // Catálogo adaptado al vertical: muestra el inventario con la etiqueta
  // correcta para que el agente hable con naturalidad ("habitaciones" vs
  // "servicios" vs "platillos"). Es aditivo al prompt original.
  const vertical = cfg.vertical || "servicios";
  const catalogo = cfg.catalogo || [];
  const itemsHospedaje = catalogo.filter((i) => i.tipo === "habitacion");
  const itemsPlatillos = catalogo.filter((i) => i.tipo === "platillo");
  const itemsProductos = catalogo.filter((i) => i.tipo === "producto");

  const formatearMoneda = (n: number) => `$${n.toLocaleString("es-MX")} MXN`;

  const habitacionesTexto = vertical === "hospedaje" && itemsHospedaje.length > 0
    ? itemsHospedaje.map((h) =>
        `- ${h.nombre}${h.capacidad ? ` (capacidad ${h.capacidad})` : ""} — ${formatearMoneda(h.precio)}${h.unidad ? ` ${h.unidad}` : " por noche"}${h.descripcion ? ` — ${h.descripcion}` : ""}`
      ).join("\n")
    : null;

  // Cuando se verifica disponibilidad, el modelo necesita el ID de cada unidad
  // para pasarlo a solicitar_reserva. Esta variante incluye [ID:...].
  const habitacionesConId = itemsHospedaje.length > 0
    ? itemsHospedaje.map((h) =>
        `- ${h.nombre} [ID:${h.id}]${h.capacidad ? ` (capacidad ${h.capacidad})` : ""} — ${formatearMoneda(h.precio)}${h.unidad ? ` ${h.unidad}` : " por noche"}${h.descripcion ? ` — ${h.descripcion}` : ""}`
      ).join("\n")
    : null;

  const menuTexto = vertical === "restaurante" && itemsPlatillos.length > 0
    ? itemsPlatillos.map((p) => `- ${p.nombre} — ${formatearMoneda(p.precio)}${p.descripcion ? ` (${p.descripcion})` : ""}`).join("\n")
    : null;

  const productosTexto = vertical === "tienda" && itemsProductos.length > 0
    ? itemsProductos.map((p) => `- ${p.nombre} — ${formatearMoneda(p.precio)}${p.descripcion ? ` (${p.descripcion})` : ""}`).join("\n")
    : null;

  const serviciosTexto = cfg.servicios && cfg.servicios.length > 0
    ? cfg.servicios.map((s) =>
        `- ${s.nombre} [ID:${s.id}]${s.duracionMinutos ? ` — ${s.duracionMinutos} min` : ""}${s.precio ? ` — $${s.precio.toLocaleString("es-MX")} MXN` : ""}${s.descripcion ? ` (${s.descripcion})` : ""}`
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

  return `Eres ${cfg.nombreAgente} de ${cfg.nombreNegocio} (${cfg.tipoNegocio}).
${cfg.personalidad}.${cfg.tonoAdicional ? ` ${cfg.tonoAdicional}` : ""}

FORMATO OBLIGATORIO — ESTÁS EN UNA LLAMADA TELEFÓNICA:
- HABLA, no escribas. Tus respuestas se convierten en voz.
- ABSOLUTAMENTE PROHIBIDO: asteriscos, guiones de lista, negritas (**texto**), numeración (1. 2. 3.), markdown de cualquier tipo.
- Si tienes varios servicios, dícelos como en una conversación: "tenemos limpieza, radiografía y valoración" — no en lista.
- Máximo 2 oraciones por respuesta. Directo y natural.

FECHA Y HORA ACTUAL: ${ahoraStr}

DATOS DEL NEGOCIO (solo estos existen):
${cfg.horario ? `- Horario general: ${cfg.horario}` : ""}
${cfg.direccion ? `- Dirección: ${cfg.direccion}` : ""}
${cfg.telefono ? `- Teléfono: ${cfg.telefono}` : ""}

${cfg.conocimiento ? `BASE DE CONOCIMIENTO (esta es TODA la información que tienes, no existe más):\n${cfg.conocimiento}` : "NO TIENES BASE DE CONOCIMIENTO. No tienes información adicional sobre este negocio."}
${serviciosTexto ? `\nCATÁLOGO DE SERVICIOS Y PRODUCTOS:\n${serviciosTexto}` : ""}
${habitacionesTexto ? `\nLUGARES Y HABITACIONES DISPONIBLES:\n${verificarDispReserva && habitacionesConId ? habitacionesConId : habitacionesTexto}\n(Refiérete a cada uno por su NOMBRE; no digas "servicios" ni asumas que todo es "habitación" — puede ser terraza, salón o cabaña. Para reservar usa la función solicitar_reserva — el agente NO confirma disponibilidad, solo recolecta y manda la solicitud.${verificarDispReserva ? " Los [ID:...] son internos: NUNCA los digas en voz alta." : ""})` : ""}
${menuTexto ? `\nMENÚ:\n${menuTexto}\n(Cuando hables del menú di "platillos" o el nombre de cada uno, no "servicios".)` : ""}
${productosTexto ? `\nPRODUCTOS:\n${productosTexto}` : ""}

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
   - Usa la fecha y hora actual para calcular fechas relativas ("mañana", "el martes")

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

PROCEDIMIENTO:
1. Llama a escalar_humano con tipo y resumen de la situación
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
- NUNCA digas los [ID:...] en voz alta — son internos.${metodoPago ? `
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
function mensajeDatosPagoVoz(mp: MetodoPagoNegocio, info?: PagoInfo): string {
  const via =
    mp.tipo === "transferencia" ? "transferencia"
    : mp.tipo === "paypal" ? "PayPal"
    : mp.tipo === "mercadopago" ? "Mercado Pago"
    : "el método indicado";
  const extra = mp.instrucciones ? ` ${mp.instrucciones}` : "";
  // Defensa: si las noches no vienen (o vienen inválidas) NO decimos "undefined
  // noches"; simplemente omitimos esa parte. El total sigue siendo correcto.
  const noches = info && typeof info.noches === "number" && isFinite(info.noches) && info.noches > 0
    ? info.noches : null;
  const porNoches = noches ? ` por ${noches} ${noches === 1 ? "noche" : "noches"}` : "";

  if (mp.modalidad === "anticipo") {
    const pct = mp.porcentajeAnticipo || 30;
    if (info) {
      return `Sí tenemos disponibilidad. El total son ${info.precioTotal.toLocaleString("es-MX")} pesos${porNoches}. Para apartar tu reserva necesitas un anticipo del ${pct} por ciento, que son ${info.montoPago.toLocaleString("es-MX")} pesos, por ${via}: ${mp.datos}.${extra} Avísame cuando hayas hecho el pago para confirmarlo con el equipo.`;
    }
    return `Sí tenemos disponibilidad. Para apartar tu reserva necesitas un anticipo del ${pct} por ciento por ${via}: ${mp.datos}.${extra} Avísame cuando hayas hecho el pago para confirmarlo con el equipo.`;
  }

  if (info) {
    return `Sí tenemos disponibilidad. El total son ${info.montoPago.toLocaleString("es-MX")} pesos${porNoches}. Para apartar tu reserva realiza el pago por ${via}: ${mp.datos}.${extra} Avísame cuando hayas pagado para confirmarlo con el equipo.`;
  }
  return `Sí tenemos disponibilidad. Para apartar tu reserva realiza el pago por ${via}: ${mp.datos}.${extra} Avísame cuando hayas pagado para confirmarlo con el equipo.`;
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
  private turnos: number = 0;

  constructor(
    ws: WebSocket,
    negocioId: string,
    configNegocio: ConfigNegocio,
    callerNumber: string = "",
    numeroTwilio: string = "",
    callSid: string = "",
  ) {
    this.ws = ws;
    this.negocioId = negocioId;
    this.numeroTwilio = numeroTwilio;
    this.callSid = callSid;
    this.configNegocio = configNegocio;
    this.callerNumber = callerNumber;
    this.inicioLlamada = Date.now();

    const prompt = buildSystemPrompt(configNegocio);
    const herramientas = construirHerramientas(configNegocio);
    this.realtime = new OpenAIRealtime(prompt, herramientas, configNegocio.voz || "marin");
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
          const resp = await fetch(`${odinUrl}/api/voice/citas`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              servicioId: args.servicioId,
              fechaInicio: args.fechaInicio,
              clienteNombre: "Llamada entrante",
              clienteTelefono: callerNumber || "desconocido",
            }),
            signal: AbortSignal.timeout(8000),
          });
          const data = await resp.json() as { slotsDisponibles?: string[]; citaId?: string };
          if (!resp.ok) {
            if (data.slotsDisponibles) {
              return {
                ok: false,
                mensaje: `Ese horario está ocupado. Los horarios disponibles ese día son: ${data.slotsDisponibles.join(", ")}. ¿Cuál te conviene?`,
              };
            }
            return { ok: false, mensaje: "No pude registrar la cita. Por favor intenta con otro horario." };
          }
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
          if (data.esperandoPago && data.metodoPago) {
            // Si Odin no mandó las noches (bug conocido: llega undefined), las
            // calculamos desde las fechas para no perder ese dato en la voz.
            let pagoInfo = data.pagoInfo;
            const nochesOk = pagoInfo && typeof pagoInfo.noches === "number" && isFinite(pagoInfo.noches) && pagoInfo.noches > 0;
            if (pagoInfo && !nochesOk && args.fechaEntrada && args.fechaSalida) {
              const ms = Date.parse(args.fechaSalida) - Date.parse(args.fechaEntrada);
              const n = Math.round(ms / 86400000);
              if (Number.isFinite(n) && n > 0) pagoInfo = { ...pagoInfo, noches: n };
            }
            return { ok: true, mensaje: mensajeDatosPagoVoz(data.metodoPago, pagoInfo) };
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

        case "escalar_humano": {
          const respEscalar = await fetch(`${odinUrl}/api/voice/escalar`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...odinAuth() },
            body: JSON.stringify({
              negocioId,
              tipo: args.tipo,
              resumen: args.resumen,
              telefonoCliente: callerNumber || "desconocido",
              nombreCliente: "Llamada entrante",
            }),
            signal: AbortSignal.timeout(8000),
          });

          // El endpoint /api/voice/escalar puede devolver { transferTo: "+52…" }
          // cuando el dueño configuró un número de transferencia en el panel
          // de Xambee y el tipo de escalamiento es "directo" o "emergencia".
          // Si está presente, transferimos la llamada al humano en lugar de
          // solo decir "ya notifiqué al equipo".
          let transferTo: string | null = null;
          if (!respEscalar.ok) {
            const errBody = await respEscalar.text().catch(() => "");
            console.error(`[FUNCIÓN] escalar_humano → HTTP ${respEscalar.status}: ${errBody}`);
          } else {
            console.log(`[FUNCIÓN] escalar_humano → HTTP ${respEscalar.status} OK`);
            const data = (await respEscalar.json().catch(() => ({}))) as { transferTo?: string };
            transferTo = typeof data?.transferTo === "string" ? data.transferTo : null;
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

      const prompt = buildSystemPrompt(this.configNegocio);
      const tools = construirHerramientas(this.configNegocio);
      this.realtime.configurarSesion(prompt, tools, this.configNegocio.voz || "marin");
      console.log(`[PIPELINE] Saludo con memoria + voz=${this.configNegocio.voz || "marin"} — ${this.configNegocio.nombreNegocio}`);
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

        const promptC = buildSystemPrompt(this.configNegocio);
        const toolsC = construirHerramientas(this.configNegocio);
        this.realtime.actualizarConfiguracion(promptC, toolsC);
        console.log(`[PIPELINE] Memoria del negocio aplicada (post-saludo): ${configCompleta.nombreNegocio}`);
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
