"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineLlamada = void 0;
exports.aliasServicio = aliasServicio;
exports.aliasCita = aliasCita;
exports.resolverServicioId = resolverServicioId;
exports.resolverCitaId = resolverCitaId;
exports.horarioCompacto = horarioCompacto;
exports.calendarioVoz = calendarioVoz;
exports.construirHerramientas = construirHerramientas;
exports.buildSystemPrompt = buildSystemPrompt;
exports.esSinCreditoOpenAI = esSinCreditoOpenAI;
const ws_1 = __importDefault(require("ws"));
const twilio_1 = __importDefault(require("twilio"));
const realtime_1 = require("../openai/realtime");
const config_1 = require("../utils/config");
const transferencias_1 = require("../api/transferencias");
const registro_voz_1 = require("../api/registro-voz");
const sonidos_1 = require("../utils/sonidos");
const normalizar_hora_1 = require("../utils/normalizar-hora");
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
function tipoJson(tipo) {
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
function propiedadesCamposMotor(campos) {
    if (campos.length === 0)
        return null;
    const props = {};
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
function herramientasDeMotor(acciones) {
    return acciones.map((a) => {
        const properties = {};
        const required = [];
        for (const c of a.campos) {
            properties[c.clave] = { ...tipoJson(c.tipo), description: c.descripcion };
            if (c.requerido)
                required.push(c.clave);
        }
        const extra = propiedadesCamposMotor([...a.camposGiro, ...a.camposDueno]);
        if (extra) {
            const obligatorios = [...a.camposGiro, ...a.camposDueno]
                .filter((c) => c.requerido)
                .map((c) => c.label);
            properties.camposMotor = {
                type: "object",
                description: "Datos adicionales que pide este negocio. Las LLAVES son los IDs de campo, NUNCA las etiquetas." +
                    (obligatorios.length > 0
                        ? ` Antes de llamar a esta función recolecta conversando: ${obligatorios.join(", ")}.`
                        : ""),
                properties: extra,
            };
        }
        return {
            type: "function",
            name: a.tool,
            // La hora en 24 h es un dato interno y el modelo tiende a repetirla en voz
            // alta. Se le recuerda aquí porque la descripción de la tool es lo único
            // que ve en el momento de llamarla.
            description: `${a.descripcion} Recolecta y confirma con el cliente todos los datos obligatorios ANTES de llamarla. Si algún dato incluye una hora, pásala en formato de 24 horas — pero cuando le HABLES al cliente dila siempre en 12 horas con am/pm. NO confirmes la operación hasta que la función responda con éxito.`,
            parameters: { type: "object", properties, required },
        };
    });
}
/**
 * El bloque de esquema para los datos que el dueño pide de más en una operación
 * con tool escrita a mano (cita, reserva, pedido).
 *
 * Devuelve `null` cuando el negocio no configuró nada, y entonces la tool se
 * declara EXACTAMENTE como siempre: ni una propiedad de más en el esquema que
 * viaja en cada llamada.
 */
function propiedadDatosDueno(campos) {
    const props = propiedadesCamposMotor(campos || []);
    if (!props)
        return null;
    const obligatorios = (campos || []).filter((c) => c.requerido).map((c) => c.label);
    return {
        type: "object",
        description: "Datos que este negocio pide SIEMPRE para esta operación. Las LLAVES son los IDs de campo, NUNCA las etiquetas." +
            (obligatorios.length > 0
                ? ` Antes de llamar a esta función recolecta conversando: ${obligatorios.join(", ")}.`
                : ""),
        properties: props,
    };
}
/**
 * Las tools del CICLO DE VIDA de lo ya creado: consultar, cambiar y cancelar.
 *
 * Son tres genéricas con el `tipo` acotado por enum, no tres por cada operación:
 * un negocio con cinco motores encendidos tendría quince funciones y el modelo
 * las lee ENTERAS en cada turno de la llamada. La lista de tipos y la de campos
 * modificables las manda Odin (`operacionesCliente`), que las saca de la misma
 * lista blanca que aplica el cambio — aquí no se decide qué se puede tocar.
 */
function herramientasDeCicloVida(operaciones) {
    if (operaciones.length === 0)
        return [];
    const tipos = operaciones.map((o) => o.tipo);
    const comoSeLlaman = operaciones.map((o) => `${o.tipo} = ${o.etiqueta}`).join("; ");
    const editables = operaciones.filter((o) => o.camposEditables.length > 0);
    const herramientas = [
        {
            type: "function",
            name: "consultar_operacion",
            description: `Consulta lo que el cliente que está llamando ya tiene registrado (${comoSeLlaman}). Sin referencia te devuelve su lista; con referencia te da el detalle de esa. Úsala cuando pregunte "¿cómo va lo mío?", "¿qué pedí?", "¿ya está lista mi orden?" o antes de cambiar o cancelar algo, para ubicar cuál es. El resultado trae un "texto" — dilo TAL CUAL, no inventes ni completes datos.`,
            parameters: {
                type: "object",
                properties: {
                    tipo: { type: "string", enum: tipos, description: `Qué está consultando. ${comoSeLlaman}` },
                    referencia: {
                        type: "string",
                        description: "Código INTERNO de la solicitud, sacado de SOLICITUDES VIGENTES DE QUIEN LLAMA. NUNCA se lo digas ni se lo pidas al cliente. Omítelo para que te devuelva su lista.",
                    },
                },
                required: ["tipo"],
            },
        },
        {
            type: "function",
            name: "cancelar_operacion",
            description: `Cancela algo que el cliente ya tiene registrado (${comoSeLlaman}). Llámala SOLO si el cliente lo pidió de forma explícita y clara, y solo después de haber confirmado hablando con él CUÁL es (descríbesela: qué era y para cuándo). El resultado trae un "texto" — dilo TAL CUAL; si el sistema no la canceló, NO le digas al cliente que quedó cancelada.`,
            parameters: {
                type: "object",
                properties: {
                    tipo: { type: "string", enum: tipos, description: `Qué está cancelando. ${comoSeLlaman}` },
                    referencia: { type: "string", description: "Código INTERNO de lo que se cancela, sacado de SOLICITUDES VIGENTES DE QUIEN LLAMA. OBLIGATORIO. Jamás se dice en voz alta." },
                },
                required: ["tipo", "referencia"],
            },
        },
    ];
    if (editables.length > 0) {
        const queSePuedeCambiar = editables
            .map((o) => `En ${o.tipo}: ${o.camposEditables.map((c) => `${c.clave} (${c.descripcion})`).join(", ")}`)
            .join(". ");
        herramientas.push({
            type: "function",
            name: "modificar_operacion",
            description: `Cambia datos de algo que el cliente ya tiene registrado. SOLO estos campos, cada uno en su tipo — cualquier otro el sistema lo rechaza: ${queSePuedeCambiar}. Manda ÚNICAMENTE lo que cambia. Si el cliente quiere cambiar productos de un pedido, no uses esta función: se cancela y se registra uno nuevo. El resultado trae un "texto" — dilo TAL CUAL y NO confirmes el cambio antes de recibirlo.`,
            parameters: {
                type: "object",
                properties: {
                    tipo: {
                        type: "string",
                        enum: editables.map((o) => o.tipo),
                        description: `Qué está modificando. ${editables.map((o) => `${o.tipo} = ${o.etiqueta}`).join("; ")}`,
                    },
                    referencia: { type: "string", description: "Referencia de 8 caracteres de lo que se modifica. OBLIGATORIA." },
                    cambios: {
                        type: "object",
                        description: `Solo los campos que cambian, con su nombre exacto. ${queSePuedeCambiar}. Las horas van en formato de 24 horas; al cliente le hablas siempre en 12 horas con am/pm.`,
                        additionalProperties: { type: "string" },
                    },
                },
                required: ["tipo", "referencia", "cambios"],
            },
        });
    }
    return herramientas;
}
// ─────────────────────────────────────────────────────────────────────────────
// IDs CORTOS — s1, s2… para servicios y c1, c2… para citas
//
// Un UUID son ~25 tokens que viajan en CADA turno de la llamada (el prompt se
// vuelve a leer completo en cada respuesta), y el modelo los copia mal: un
// carácter cambiado era un 404 "servicio no encontrado" que el agente le
// contaba al cliente como "no pude agendar, intenta con otro horario". El alias
// se traduce aquí, en el servidor; a Odin siempre le llega el id real. Un id
// real que llegue tal cual se respeta.
// ─────────────────────────────────────────────────────────────────────────────
function aliasServicio(i) {
    return `s${i + 1}`;
}
function aliasCita(i) {
    return `c${i + 1}`;
}
function resolverServicioId(cfg, id) {
    const s = String(id ?? "").trim();
    const m = /^s(\d+)$/i.exec(s);
    return (m && cfg.servicios?.[Number(m[1]) - 1]?.id) || s;
}
function resolverCitaId(cfg, id) {
    const s = String(id ?? "").trim();
    const m = /^c(\d+)$/i.exec(s);
    return (m && cfg.citasCliente?.[Number(m[1]) - 1]?.id) || s;
}
// ─────────────────────────────────────────────────────────────────────────────
// HORARIO Y CALENDARIO, dichos como se dicen
// ─────────────────────────────────────────────────────────────────────────────
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0]; // lunes primero, como lo dice la gente
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/**
 * "lunes a viernes de 7:00 a.m. a 7:00 p.m.; sábado de 7:00 a.m. a 2:00 p.m.;
 * domingo cerrado". Antes iban los siete días en 24 h ("Domingo: 07:00–23:00,
 * Lunes: …") DOS veces, y los días cerrados simplemente no aparecían: el
 * modelo tenía que deducir que "no está" quería decir "cerrado".
 */
function horarioCompacto(horario) {
    const porDia = new Map(horario.map((h) => [h.diaSemana, h]));
    const desc = (d) => {
        const h = porDia.get(d);
        return h ? `de ${hora24aAmPm(h.horaInicio)} a ${hora24aAmPm(h.horaFin)}` : "cerrado";
    };
    const grupos = [];
    for (const d of ORDEN_SEMANA) {
        const ult = grupos[grupos.length - 1];
        if (ult && ult.desc === desc(d))
            ult.dias.push(d);
        else
            grupos.push({ dias: [d], desc: desc(d) });
    }
    const nombre = (d) => DIAS_ES[d].toLowerCase();
    return grupos
        .map((g) => {
        const dias = g.dias.length === 1
            ? nombre(g.dias[0])
            : g.dias.length === 2
                ? `${nombre(g.dias[0])} y ${nombre(g.dias[1])}`
                : `${nombre(g.dias[0])} a ${nombre(g.dias[g.dias.length - 1])}`;
        return `${dias} ${g.desc}`;
    })
        .join("; ");
}
/**
 * Dos semanas de "día = fecha", en la zona del negocio. El modelo no sabe qué
 * día de la semana cae el 12; lo estima y se equivoca ("mañana martes" un
 * lunes). WhatsApp ya le daba esta tabla y la voz no. Vive en el bloque del
 * final porque cambia cada día.
 */
function calendarioVoz(ahora, tz, dias = 14) {
    const [y, m, d] = ahora.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number);
    const partes = [];
    for (let i = 0; i < dias; i++) {
        const f = new Date(Date.UTC(y, m - 1, d + i));
        const iso = f.toISOString().slice(0, 10);
        partes.push(`${DIAS_ES[f.getUTCDay()].toLowerCase()} ${f.getUTCDate()} ${MESES_CORTOS[f.getUTCMonth()]}=${iso}${i === 0 ? " (hoy)" : ""}`);
    }
    return partes.join(", ");
}
/** Lo que el agente sabe hacer en ESTA llamada, sacado de las tools reales. */
function capacidadesTexto(cfg, herramientas) {
    const n = new Set(herramientas.map((h) => h.name));
    const lista = [];
    if (n.has("agendar_cita"))
        lista.push("agendar citas, revisar horarios libres y cambiar o cancelar citas");
    if (n.has("solicitar_reserva"))
        lista.push("tomar reservas");
    if (n.has("crear_pedido"))
        lista.push("tomar pedidos");
    for (const a of cfg.accionesMotor || []) {
        if (!n.has(a.tool))
            continue;
        const primera = a.descripcion.replace(/\s+/g, " ").trim().split(/(?<=\.)\s/)[0].replace(/\.$/, "");
        lista.push(`${primera.charAt(0).toLowerCase()}${primera.slice(1)} (${a.tool})`);
    }
    if (n.has("consultar_operacion"))
        lista.push("consultar, cambiar o cancelar lo que el cliente ya registró");
    if (n.has("enviar_ubicacion"))
        lista.push("mandar la ubicación por WhatsApp");
    if (n.has("escalar_humano"))
        lista.push("pasar el caso a una persona del equipo");
    lista.push("anotar las preguntas que no sepas para que el negocio las conteste");
    return lista.join("; ");
}
// Marcadores que un bloque de giro viejo (Odin sin `nichoBloqueParaVoz`) puede
// nombrar, con la función que los hace por teléfono.
const FUNCION_POR_MARCADOR_LEGADO = {
    AGENDAR_CITA: "agendar_cita",
    REAGENDAR_CITA: "reagendar_cita",
    CANCELAR_CITA: "cancelar_cita",
    CONSULTAR_DISPONIBILIDAD: "consultar_disponibilidad",
    SOLICITUD_RESERVA: "solicitar_reserva",
    CREAR_PEDIDO: "crear_pedido",
};
// Exportada por el mismo motivo que `buildSystemPrompt`: poder verificar qué
// funciones se le declaran a un negocio —y sobre todo, cuáles NO— sin levantar
// una llamada real. Una tool de más es una puerta que el modelo puede abrir por
// error, y por teléfono un error no se edita ni se borra: ya se dijo en voz alta.
function construirHerramientas(cfg, opts = {}) {
    const herramientas = [];
    const agendaActiva = cfg.habilidadesActivas?.agenda_citas ?? cfg.habilidades.includes("agenda_citas");
    const escalamientoActivo = cfg.habilidadesActivas?.escalamiento ?? cfg.habilidades.includes("escalamiento");
    const solicitudReservaActiva = cfg.habilidadesActivas?.solicitud_reserva ?? cfg.habilidades.includes("solicitud_reserva");
    const pedidosActiva = cfg.habilidadesActivas?.pedidos ?? cfg.habilidades.includes("pedidos");
    const datosDueno = cfg.datosDuenoPorTipo || {};
    // `profesional` solo se declara si el negocio tiene a quién elegir: en uno de
    // calendario único es una propiedad que el modelo lee en cada turno para nada.
    const hayProfesionales = (cfg.profesionales || []).length > 0;
    if (agendaActiva) {
        // Los datos del dueño para CITAS viajan en el MISMO `camposAgenda` que los
        // del servicio: para el cliente son la misma pregunta, y así es como
        // /api/voice/citas los fusiona del otro lado (ver LLAVE_CAMPOS en Odin).
        // Se conserva `additionalProperties` para los que trae el servicio elegido
        // (y los del giro), que varían y no se pueden enumerar aquí.
        const propsCita = propiedadesCamposMotor(datosDueno.cita || []);
        const obligatoriosCita = (datosDueno.cita || []).filter((c) => c.requerido).map((c) => c.label);
        const profesionalProp = hayProfesionales
            ? { profesional: { type: "string", description: "Nombre EXACTO del profesional, solo si el cliente pidió a alguien que atiende ese servicio." } }
            : {};
        herramientas.push({
            type: "function",
            name: "consultar_disponibilidad",
            description: "Horarios REALES libres de un día para un servicio. Úsala cuando el cliente pregunte qué horarios hay o si hay espacio un día, y di el \"mensaje\" tal cual. Si ya dijo una hora concreta, no la uses: agenda directo.",
            parameters: {
                type: "object",
                properties: {
                    servicioId: { type: "string", description: "ID del servicio de tu lista (s1, s2…)." },
                    fecha: { type: "string", description: "Día a revisar, YYYY-MM-DD, copiado del CALENDARIO." },
                    ...profesionalProp,
                },
                required: ["servicioId", "fecha"],
            },
        });
        herramientas.push({
            type: "function",
            name: "agendar_cita",
            description: "Agenda una cita nueva cuando el cliente ya confirmó servicio, fecha y hora (y los datos obligatorios del servicio, si tiene). Si la hora está ocupada o fuera de horario, el \"mensaje\" trae las alternativas: dilo tal cual.",
            parameters: {
                type: "object",
                properties: {
                    servicioId: { type: "string", description: "ID del servicio de tu lista (s1, s2…)." },
                    fechaInicio: { type: "string", description: "YYYY-MM-DDTHH:MM:00, hora local en 24 h." },
                    clienteNombre: { type: "string", description: "Nombre del cliente; \"Cliente\" si no lo quiso dar." },
                    ...profesionalProp,
                    camposAgenda: {
                        type: "object",
                        description: "Solo si el servicio (o el negocio) pide datos extra: llave = id del campo (c1…), valor = lo que dijo el cliente." +
                            (obligatoriosCita.length > 0 ? ` Este negocio pide SIEMPRE: ${obligatoriosCita.join(", ")}.` : ""),
                        ...(propsCita ? { properties: propsCita } : {}),
                        additionalProperties: { type: "string" },
                    },
                },
                required: ["servicioId", "fechaInicio", "clienteNombre"],
            },
        });
        herramientas.push({
            type: "function",
            name: "cancelar_cita",
            description: "Cancela una cita del cliente. Solo si lo pidió de forma clara y ya confirmaste cuál es.",
            parameters: {
                type: "object",
                properties: {
                    citaId: { type: "string", description: "ID de la cita (c1, c2… de CITAS VIGENTES)." },
                },
                required: ["citaId"],
            },
        });
        herramientas.push({
            type: "function",
            name: "reagendar_cita",
            description: "Cambia fecha, hora o servicio de una cita existente. Manda solo lo que cambia.",
            parameters: {
                type: "object",
                properties: {
                    citaId: { type: "string", description: "ID de la cita (c1, c2… de CITAS VIGENTES)." },
                    servicioId: { type: "string", description: "Nuevo servicio (s1…), solo si cambia." },
                    fechaInicio: { type: "string", description: "Nueva fecha y hora YYYY-MM-DDTHH:MM:00 en 24 h, solo si cambia." },
                    ...(hayProfesionales
                        ? { profesional: { type: "string", description: "Nombre EXACTO del nuevo profesional, solo si el cliente pide cambiarlo." } }
                        : {}),
                },
                required: ["citaId"],
            },
        });
    }
    if (solicitudReservaActiva) {
        const verificarDisp = cfg.verificarDisponibilidadReserva === true;
        // Los datos que el dueño pide de más en TODAS sus reservas. Sin esto,
        // /api/voice/reservar respondía 400 FALTAN_CAMPOS y la reserva no se podía
        // cerrar por teléfono aunque sí por WhatsApp.
        const camposMotorReserva = propiedadDatosDueno(datosDueno.reserva);
        if (verificarDisp) {
            // Modo hospedaje con verificación: la tool recibe fechas estructuradas y
            // el ID de la unidad. El resultado le dice al modelo qué responder
            // (disponibilidad, datos de pago, o escalamiento por pago confirmado).
            herramientas.push({
                type: "function",
                name: "solicitar_reserva",
                description: "Verifica disponibilidad de una reserva de hospedaje y, según el caso, pide el pago o avisa al negocio. Llámala cuando tengas la unidad y las fechas, y di el \"mensaje\" tal cual: tú no confirmas la reserva. Si el negocio pide pago, vuelve a llamarla con pagoReportado=true SOLO cuando el cliente diga que ya pagó.",
                parameters: {
                    type: "object",
                    properties: {
                        detalles: { type: "string", description: "Resumen para el negocio (unidad, fechas, personas si las hay)." },
                        fechaEntrada: { type: "string", description: "Primer día de uso, YYYY-MM-DD." },
                        fechaSalida: { type: "string", description: "Último día de uso (inclusive), YYYY-MM-DD. Si es un solo día, igual a fechaEntrada." },
                        servicioId: { type: "string", description: "ID exacto de la unidad (de tu lista). Omítelo si no eligió una." },
                        personas: { type: "number", description: "Número de personas, solo si lo mencionó." },
                        itemNombre: { type: "string", description: "Nombre de la unidad, si aplica." },
                        clienteNombre: { type: "string", description: "Nombre del cliente." },
                        pagoReportado: { type: "boolean", description: "false la primera vez. true ÚNICAMENTE si el cliente dice de forma explícita que YA pagó ('ya transferí', 'ya pagué', 'ya mandé el comprobante'). Un 'gracias', 'ok', 'va', silencio o ruido NO es pago; ante la duda, false y pregúntale '¿Ya realizaste el pago?'." },
                        ...(camposMotorReserva ? { camposMotor: camposMotorReserva } : {}),
                    },
                    required: ["detalles", "fechaEntrada", "fechaSalida"],
                },
            });
        }
        else {
            // Modo legacy: solo recolecta y manda al admin, sin verificar nada.
            herramientas.push({
                type: "function",
                name: "solicitar_reserva",
                description: "Manda una solicitud de reserva al negocio para que una persona la valide (habitación, mesa, evento…). Tú no la confirmas: recolecta los datos, mándala y dile que el negocio le confirma por WhatsApp.",
                parameters: {
                    type: "object",
                    properties: {
                        detalles: { type: "string", description: "Resumen claro de lo que pide (qué, fechas, personas, preferencias), como mensaje para un recepcionista." },
                        fechaSolicitada: { type: "string", description: "Fecha o rango que pidió, en texto libre." },
                        personas: { type: "number", description: "Número de personas, si aplica." },
                        itemNombre: { type: "string", description: "Lo que quiere reservar, si es algo específico." },
                        clienteNombre: { type: "string", description: "Nombre del cliente." },
                        ...(camposMotorReserva ? { camposMotor: camposMotorReserva } : {}),
                    },
                    required: ["detalles"],
                },
            });
        }
    }
    if (pedidosActiva) {
        // Igual que en reservas: sin estos campos /api/voice/pedidos rechazaba con
        // FALTAN_CAMPOS y el pedido no se registraba nunca.
        const camposMotorPedido = propiedadDatosDueno(datosDueno.pedido);
        herramientas.push({
            type: "function",
            name: "crear_pedido",
            description: "Registra un pedido cuando el cliente confirmó qué quiere, cuántos y si es a domicilio, para recoger o en mesa. Usa los IDs EXACTOS del catálogo; el sistema calcula el total.",
            parameters: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        description: "Productos pedidos.",
                        items: {
                            type: "object",
                            properties: {
                                servicioId: { type: "string", description: "ID exacto del producto del catálogo" },
                                cantidad: { type: "number", description: "Cantidad (entero >= 1)" },
                            },
                            required: ["servicioId", "cantidad"],
                        },
                    },
                    tipo: { type: "string", enum: ["domicilio", "recoger", "mesa"], description: "Modalidad de entrega" },
                    direccion: { type: "string", description: "Dirección de entrega (solo a domicilio)" },
                    notas: { type: "string", description: "Indicaciones especiales, si las hay" },
                    clienteNombre: { type: "string", description: "Nombre del cliente." },
                    ...(camposMotorPedido ? { camposMotor: camposMotorPedido } : {}),
                },
                required: ["items", "tipo"],
            },
        });
    }
    if (escalamientoActivo) {
        herramientas.push({
            type: "function",
            name: "escalar_humano",
            description: "Avisa al equipo del negocio para que una persona atienda al cliente. Si hay varias sucursales/personas, pasa la elegida en sucursalEtiqueta.",
            parameters: {
                type: "object",
                properties: {
                    tipo: {
                        type: "string",
                        enum: ["directo", "emergencia", "no_sabe"],
                        description: "directo=pide una persona, emergencia=urgencia real, no_sabe=no puedes ayudarle",
                    },
                    resumen: { type: "string", description: "Breve descripción de la situación para el dueño" },
                    sucursalEtiqueta: {
                        type: "string",
                        description: "Etiqueta EXACTA de la lista de sucursales/personas. Omítela si solo hay una.",
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
        description: "Anota una pregunta del cliente que no puedes responder con tu información; el negocio la contestará después. Llámala ANTES de decir que no tienes el dato y usa su \"mensaje\".",
        parameters: {
            type: "object",
            properties: {
                pregunta: { type: "string", description: "Las palabras EXACTAS del cliente, sin parafrasear." },
                categoria: {
                    type: "string",
                    enum: ["precios", "horarios", "servicios", "ubicacion", "pagos", "politicas", "otro"],
                    description: "Categoría de la pregunta",
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
        description: "Termina la llamada. SOLO cuando el cliente se despidió claramente ('gracias, adiós', 'ya con eso', 'bye') y no queda nada a medias. Despídete brevemente ANTES de llamarla.",
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
            description: "Manda la ubicación (Google Maps / dirección) al WhatsApp del número desde el que llama. Úsala cuando pida la ubicación o cómo llegar, y avísale que se la mandas por WhatsApp.",
            parameters: {
                type: "object",
                properties: {
                    itemNombre: {
                        type: "string",
                        description: "Terraza/sucursal específica con dirección propia, si preguntó por una. Opcional.",
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
            if (!opts.silencioso)
                console.warn(`[PIPELINE] Tool de motor "${h.name}" ignorada: ya existe una con ese nombre`);
            return false;
        }
        return true;
    });
    herramientas.push(...deMotor);
    // Y el ciclo de vida de lo YA creado. Va al final por la misma razón: son
    // datos que manda Odin, no una lista escrita aquí.
    herramientas.push(...herramientasDeCicloVida(cfg.operacionesCliente || []));
    if (!opts.silencioso) {
        console.log(`[PIPELINE] Herramientas cargadas: ${herramientas.map((h) => h.name).join(", ") || "(ninguna)"}`);
    }
    return herramientas;
}
// Exportada para poder verificar el orden del prompt (ver el aviso de abajo
// sobre el caché) sin tener que levantar una llamada real.
function buildSystemPrompt(cfg, contextoExtra) {
    // ⚠️ ORDEN DEL PROMPT — NO MOVER LO VOLÁTIL HACIA ARRIBA ⚠️
    //
    // OpenAI cachea el PREFIJO del prompt (exacto desde el primer carácter, con
    // mínimo de 1024 tokens): lo cacheado se cobra a $0.40/1M en vez de $4/1M, y
    // el prompt se vuelve a leer completo en CADA respuesta de la llamada. Todo
    // lo que cambia entre llamadas del mismo negocio (fecha y hora, calendario,
    // contexto de rebote/sucursal, citas y solicitudes de quien llama) vive en
    // el bloque === CONTEXTO DE ESTA LLAMADA === del FINAL. Si agregas algo que
    // varíe por llamada o por cliente, va ahí. Se verifica en producción: la
    // columna `tokens_cacheados` de `conversaciones` debe ser > 0 en llamadas
    // seguidas al mismo negocio.
    //
    // Y cada renglón de aquí se paga en cada turno de cada llamada: antes de
    // agregar uno, revisa que no esté ya dicho en otra sección o en la
    // descripción de una tool (esas también se leen en cada turno).
    const tz = cfg.zonaHoraria || "America/Mexico_City";
    const ahora = new Date();
    const ahoraStr = ahora.toLocaleString("es-MX", {
        timeZone: tz,
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
    });
    const herramientas = construirHerramientas(cfg, { silencioso: true });
    const agendaActiva = cfg.habilidadesActivas?.agenda_citas ?? cfg.habilidades.includes("agenda_citas");
    const escalamientoActivo = cfg.habilidadesActivas?.escalamiento ?? cfg.habilidades.includes("escalamiento");
    const solicitudReservaActiva = cfg.habilidadesActivas?.solicitud_reserva ?? cfg.habilidades.includes("solicitud_reserva");
    const verificarDispReserva = cfg.verificarDisponibilidadReserva === true && solicitudReservaActiva;
    const reservaConfirmaAgente = cfg.confirmaAgentePorTipo?.reserva === true;
    // CITAS con anticipo: el negocio exige depósito para apartar la cita. El
    // agente pide el anticipo y NO promete la cita confirmada. El monto exacto lo
    // calcula el backend al agendar.
    const requiereAnticipoCitas = cfg.requiereAnticipoCitas === true && agendaActiva;
    const anticipoCitasPctVoz = requiereAnticipoCitas && cfg.anticipoCitas?.modalidad === "anticipo"
        ? `anticipo del ${cfg.anticipoCitas.porcentaje || 50} por ciento`
        : requiereAnticipoCitas
            ? "pago completo por adelantado"
            : null;
    const metodoPago = cfg.metodoPago || null;
    // Lista completa de métodos. Si vienen, las usamos; si no, fallback al
    // único método legacy.
    const metodosPagoLista = cfg.metodosPago && cfg.metodosPago.length > 0
        ? cfg.metodosPago
        : (metodoPago ? [metodoPago] : []);
    const TIPO_LABEL_PAGO_VOZ = {
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
    // "servicios" vs "platillos").
    const vertical = cfg.vertical || "servicios";
    const catalogo = cfg.catalogo || [];
    const itemsHospedaje = catalogo.filter((i) => i.tipo === "habitacion");
    const itemsPlatillos = catalogo.filter((i) => i.tipo === "platillo");
    const itemsProductos = catalogo.filter((i) => i.tipo === "producto");
    const formatearMoneda = (n) => `$${n.toLocaleString("es-MX")} MXN`;
    // Anota precios por día de la semana si difieren del base. El agente lo
    // dice tal cual cuando el cliente pregunta el costo de fechas específicas.
    const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const formatearPreciosPorDia = (precios) => {
        if (!precios || typeof precios !== "object")
            return "";
        const parts = [];
        for (let i = 0; i < 7; i++) {
            const p = Number(precios[String(i)]);
            if (Number.isFinite(p) && p > 0)
                parts.push(`${DIAS_CORTOS[i]} ${formatearMoneda(p)}`);
        }
        return parts.length > 0 ? ` — Precios por día: ${parts.join(", ")} (días sin valor cobran el precio base)` : "";
    };
    // Con verificación de disponibilidad el modelo necesita el ID de cada unidad
    // para pasarlo a solicitar_reserva; sin ella, el ID solo gasta tokens.
    const habitacionesTexto = vertical === "hospedaje" && itemsHospedaje.length > 0
        ? itemsHospedaje.map((h) => `- ${h.nombre}${verificarDispReserva ? ` [ID:${h.id}]` : ""}${h.capacidad ? ` (capacidad ${h.capacidad})` : ""} — ${formatearMoneda(h.precio)}${h.unidad ? ` ${h.unidad}` : " por noche"}${h.descripcion ? ` — ${h.descripcion}` : ""}${h.direccion ? ` — Dirección: ${h.direccion}` : ""}${formatearPreciosPorDia(h.preciosPorDia)}`).join("\n")
        : null;
    const menuTexto = vertical === "restaurante" && itemsPlatillos.length > 0
        ? itemsPlatillos.map((p) => `- ${p.nombre} — ${formatearMoneda(p.precio)}${p.descripcion ? ` (${p.descripcion})` : ""}`).join("\n")
        : null;
    const productosTexto = vertical === "tienda" && itemsProductos.length > 0
        ? itemsProductos.map((p) => `- ${p.nombre} — ${formatearMoneda(p.precio)}${p.descripcion ? ` (${p.descripcion})` : ""}`).join("\n")
        : null;
    // Línea de campos adicionales de un servicio. Vacía si el servicio no pide
    // nada extra. El [campo:ID] es la llave en camposAgenda — el cliente NUNCA
    // debe escuchar el ID ni la palabra "campo".
    const formatearCamposAgenda = (campos) => {
        if (!campos || campos.length === 0)
            return "";
        const parts = campos.map((c) => `${c.label} [campo:${c.id}, ${c.requerido ? "OBLIGATORIO" : "opcional"}]`);
        return `\n    Datos a recolectar: ${parts.join("; ")}`;
    };
    const servicios = cfg.servicios || [];
    const hayCamposServicio = servicios.some((s) => (s.camposAgenda || []).length > 0);
    // Lo que se AGENDA: nombre, ID corto y duración. Precio y descripción ya van
    // en el catálogo; antes viajaban dos veces en cada turno.
    const serviciosAgendaTexto = servicios.length > 0
        ? servicios.map((s, i) => `- ${s.nombre} [ID:${aliasServicio(i)}]${s.duracionMinutos ? ` — ${s.duracionMinutos} min` : ""}${formatearCamposAgenda(s.camposAgenda)}`).join("\n")
        : null;
    // El catálogo que el agente RECITA cuando le preguntan qué hay. Odin lo manda
    // completo y ya formateado (`ofertaTexto`); lo agendable con precio queda de
    // respaldo para una versión de Odin anterior a ese campo.
    const catalogoTexto = (cfg.ofertaTexto || "").trim() || (servicios.length > 0
        ? servicios.map((s) => `- ${s.nombre}${s.precio ? ` — $${s.precio.toLocaleString("es-MX")} MXN` : ""}${s.descripcion ? ` (${s.descripcion})` : ""}`).join("\n")
        : null);
    const profesionalesTexto = (cfg.profesionales ?? []).map((p) => {
        const nombres = p.atiendeTodosServicios
            ? "todos los servicios"
            : p.servicioIds.map((id) => cfg.servicios?.find((s) => s.id === id)?.nombre).filter(Boolean).join(", ");
        return `- ${p.nombre} — atiende ${nombres}`;
    }).join("\n");
    // Un solo horario, el que usa la agenda. Antes iban el texto libre del dueño
    // ("Horario general") Y la tabla, y cuando no coincidían (Dentinova: 7 a 7
    // en uno, 7 a 11 de la noche en otro) el agente decía uno y agendaba con el
    // otro. El texto queda solo para el negocio que no tiene tabla.
    const horarioTexto = cfg.horarioDetallado && cfg.horarioDetallado.length > 0
        ? horarioCompacto(cfg.horarioDetallado)
        : (cfg.horario || "").trim() || null;
    const citasClienteTexto = cfg.citasCliente && cfg.citasCliente.length > 0
        ? cfg.citasCliente.map((c, i) => `- [ID:${aliasCita(i)}] ${c.servicio} — ${c.fechaInicio} — ${c.estado}`).join("\n")
        : null;
    // Lo que quien llama ya tiene abierto. Se pinta como [REF:...] a propósito:
    // es la marca que el modelo reconoce como "interno, no se dice". Antes decía
    // "referencia ABC12345" y el agente se la dictaba al cliente y se la pedía.
    const operacionesResumenTexto = (cfg.operacionesClienteResumen || []).length > 0
        ? (cfg.operacionesClienteResumen || [])
            .map((o) => `- [REF:${o.referencia}] ${o.etiqueta} (tipo ${o.tipo}): ${o.resumen}`)
            .join("\n")
        : null;
    // ── EL GIRO (motor de nichos) ─────────────────────────────────────────────
    // `nichoPromptBloque` lo arma Odin con la receta del giro (vocabulario,
    // reglas, catálogo con IDs). Va en la parte ESTABLE del prompt porque no
    // cambia entre llamadas del mismo negocio.
    //
    // Odin ya lo manda redactado para llamada (`nichoBloqueParaVoz`): funciones
    // en vez de marcadores, sin el JSON de cada marcador. Con un Odin anterior
    // llega en versión chat y se le pega la traducción — SIEMPRE, no solo cuando
    // hay tools de motor: la versión chat de "cita por turno" pide "usa el
    // marcador [AGENDAR_CITA]", y sin traducción el agente concluía que por
    // teléfono no podía agendar.
    const accionesMotor = cfg.accionesMotor || [];
    const nichoBloque = (cfg.nichoPromptBloque || "").trim();
    const traduccionLegado = (() => {
        if (cfg.nichoBloqueParaVoz)
            return "";
        const pares = [
            ...accionesMotor.map((a) => `[${a.marcador}] = ${a.tool}`),
            ...Object.entries(FUNCION_POR_MARCADOR_LEGADO)
                .filter(([, fn]) => herramientas.some((h) => h.name === fn))
                .map(([m, fn]) => `[${m}] = ${fn}`),
        ];
        return `\nPOR TELÉFONO NO HAY MARCADORES: donde arriba diga "marcador" o "emite [ALGO]", llama a la función equivalente (${pares.join(", ")}). Ignora el formato JSON de los marcadores. Nunca digas en voz alta un corchete, un ID ni un JSON.`;
    })();
    const bloqueGiro = nichoBloque ? `\n=== TU GIRO ===\n${nichoBloque}${traduccionLegado}\n` : "";
    // ── DATOS QUE ESTE NEGOCIO PIDE SIEMPRE ───────────────────────────────────
    // Lo que el dueño configuró de más para cita, reserva y pedido. Las tools ya
    // lo llevan en su esquema; esto es para que el agente lo pregunte
    // CONVERSANDO y no lo descubra cuando el backend le diga que faltan datos.
    const datosDuenoCfg = cfg.datosDuenoPorTipo || {};
    const NOMBRE_OPERACION_DUENO = {
        cita: "agendar una cita",
        reserva: "hacer una reserva",
        pedido: "registrar un pedido",
    };
    const LLAVE_DUENO = {
        cita: "camposAgenda",
        reserva: "camposMotor",
        pedido: "camposMotor",
    };
    const pedidosActiva = cfg.habilidadesActivas?.pedidos ?? cfg.habilidades.includes("pedidos");
    const bloqueDatosDueno = (() => {
        const partes = ["cita", "reserva", "pedido"]
            .filter((t) => (t === "cita" ? agendaActiva : t === "reserva" ? solicitudReservaActiva : pedidosActiva))
            .map((t) => {
            const campos = datosDuenoCfg[t] || [];
            if (campos.length === 0)
                return "";
            const lista = campos
                .map((c) => `${c.label} [campo:${c.id}, ${c.requerido ? "OBLIGATORIO" : "opcional"}]${c.opciones?.length ? ` — opciones: ${c.opciones.join(", ")}` : ""}${c.ayuda ? ` — ${c.ayuda}` : ""}`)
                .join("; ");
            return `- Para ${NOMBRE_OPERACION_DUENO[t]}: ${lista}. Van en ${LLAVE_DUENO[t]}.`;
        })
            .filter(Boolean);
        if (partes.length === 0)
            return "";
        return `
=== DATOS QUE ESTE NEGOCIO PIDE SIEMPRE ===
${partes.join("\n")}
Pregúntalos conversando con la etiqueta natural ("Dirección de recolección" → "¿En qué dirección recogemos?"); la llave es el ID entre [campo:...] y nunca se dice. Los opcionales, solo si fluye.
`;
    })();
    // ── CICLO DE VIDA: consultar, cambiar y cancelar lo ya creado ─────────────
    // Estable por negocio (qué operaciones y qué campos). Lo que tiene ESTE
    // llamante va abajo, en CONTEXTO DE ESTA LLAMADA.
    const operacionesCliente = cfg.operacionesCliente || [];
    const bloqueCicloVida = operacionesCliente.length > 0
        ? `
=== LO QUE EL CLIENTE YA TIENE REGISTRADO ===
Puede consultar, cambiar o cancelar: ${operacionesCliente.map((o) => o.etiqueta).join(", ")}.
- Ubícalo hablando, por lo que es y para cuándo ("tu pedido de dos playeras"). El [REF:...] es interno: va en las funciones y nunca se dice, deletrea ni se le pide.
- Si no dice cuál, llama a consultar_operacion sin referencia y ofrécele máximo dos opciones con palabras. Confirma cuál es ANTES de cambiar o cancelar.
- Di el "texto" de la función TAL CUAL. Nunca confirmes un cambio o cancelación que la función no hizo; si no se pudo, dilo y ofrece pasarlo con una persona.
- Solo puedes tocar lo de este número: si pide algo de otra persona, dile que por seguridad solo ves lo de este número. "Olvídalo" o "ya no" no son una cancelación: pregunta.
`
        : "";
    // Si la llamada es un rebote o llegó por desvío desde una sucursal
    // específica, el agente se comporta distinto. Es de ESTA llamada: va abajo.
    const bloqueContextoLlamada = (() => {
        if (!contextoExtra)
            return "";
        if (contextoExtra.esRebote) {
            return `
🚨 ESTA LLAMADA ES UN REBOTE: el cliente pidió una persona, se le desvió y nadie contestó. NO saludes ni te presentes otra vez. Di directamente:
"Disculpa, parece que el equipo no pudo tomar tu llamada en este momento. ¿Quieres que tome tu recado o prefieres que yo te ayude con tu duda?"
NO intentes escalar de nuevo en esta llamada.`;
        }
        if (contextoExtra.receptorOrigen) {
            const r = contextoExtra.receptorOrigen;
            return `
CÓMO LLEGÓ: el cliente marcó a "${r.etiqueta}" y se desvió hacia ti porque ahí no contestaron. Menciónalo si aplica. Si pide una persona y no dice cuál, usa "${r.etiqueta}".`;
        }
        return "";
    })();
    // Lista de receptores para que el agente sepa entre cuáles puede elegir.
    const receptores = cfg.receptoresEscalamiento || [];
    const receptoresTexto = receptores.length > 0
        ? receptores.map((r) => `- ${r.etiqueta}${r.canal === "whatsapp" ? " (solo por WhatsApp)" : " (por llamada)"}`).join("\n")
        : null;
    // Temas que disparan transferencia INMEDIATA a humano (ej. servicio urgente).
    const temas = (cfg.temasTransferencia || []).filter((t) => typeof t === "string" && t.trim());
    const temasTexto = temas.length > 0 ? temas.map((t) => `- "${t}"`).join("\n") : null;
    // El calendario solo si hay algo que se agenda o se fecha.
    const usaFechas = agendaActiva || solicitudReservaActiva || accionesMotor.length > 0 || operacionesCliente.length > 0;
    return `Eres ${cfg.nombreAgente} de ${cfg.nombreNegocio} (${cfg.tipoNegocio}).
${cfg.personalidad}.${cfg.tonoAdicional ? ` ${cfg.tonoAdicional}` : ""}

ESTÁS EN UNA LLAMADA TELEFÓNICA: todo lo que dices se convierte en voz.
- Nada de markdown, listas, asteriscos ni numeración: varias opciones van en una frase ("tenemos limpieza, radiografía y valoración").
- Máximo 2 oraciones (~30 palabras) por turno. Con mucha información da máximo tres opciones y pregunta cuál le interesa; nunca recites el catálogo completo.

CÓMO SUENAS: una recepcionista mexicana real, cálida y segura; nadie debe notar que eres IA.
- Frases cortas, una idea por frase, ritmo ágil. A veces (máximo una por turno) abre con "claro", "va", "mmm, déjame ver" o "perfecto"; nunca empieces dos turnos igual.
- Cuando te den un dato importante (fecha, hora, nombre, servicio), repítelo breve antes de seguir: "El sábado a las cuatro, perfecto…".
- Teléfonos de dos en dos dígitos; precios con palabras ("quinientos pesos"); horas con "de la mañana / de la tarde / de la noche".
- Si va al grano, tú también; si suena mayor o confundido, más despacio y claro; si está molesto, suaviza y no lo interrumpas.
- Nunca suenes a menú telefónico, locutora ni asistente corporativo: eres del equipo del negocio.
${cfg.saludoInicial && cfg.saludoInicial.trim() ? `
SALUDO INICIAL: tu PRIMER mensaje debe transmitir esto, dicho natural: "${cfg.saludoInicial.trim()}"
` : ""}
DATOS DEL NEGOCIO (solo estos existen):
${horarioTexto ? `- Horario de atención: ${horarioTexto}\n` : ""}${cfg.direccion ? `- Dirección: ${cfg.direccion}\n` : ""}${cfg.telefono ? `- Teléfono: ${cfg.telefono}\n` : ""}
${cfg.conocimiento ? `BASE DE CONOCIMIENTO (esta es TODA la información que tienes, no existe más):\n${cfg.conocimiento}` : "NO TIENES BASE DE CONOCIMIENTO. No tienes información adicional sobre este negocio."}
${catalogoTexto ? `\nCATÁLOGO DE SERVICIOS Y PRODUCTOS:\n${catalogoTexto}` : ""}${profesionalesTexto ? `\n\nPROFESIONALES (lista completa):\n${profesionalesTexto}\nSi el cliente pide a alguien, usa su nombre EXACTO en profesional y no se lo ofrezcas para un servicio que no atiende. Si no pide a nadie, omítelo: el sistema asigna a quien esté libre.` : ""}${habitacionesTexto ? `\n\nLUGARES Y HABITACIONES:\n${habitacionesTexto}\n(Llama a cada uno por su NOMBRE: puede ser terraza, salón o cabaña. Para reservar usa solicitar_reserva; solo su resultado dice si quedó confirmada o pendiente.${verificarDispReserva ? " Los [ID:...] son internos: nunca los digas." : ""})` : ""}${menuTexto ? `\n\nMENÚ:\n${menuTexto}\n(Di "platillos" o el nombre de cada uno, no "servicios".)` : ""}${productosTexto ? `\n\nPRODUCTOS:\n${productosTexto}` : ""}${metodosPagoTextoVoz ? `\n\nMÉTODOS DE PAGO (${modalidadPagoTextoVoz}):\n${metodosPagoTextoVoz}\n(Si preguntan cómo pagar, di los TIPOS hablados — "aceptamos transferencia y PayPal". Nunca dictes cuentas, CLABE ni links: se los mandas por WhatsApp.)` : ""}${(cfg.ubicacionUrl || cfg.direccion) ? `\n\nUBICACIÓN: si pide la dirección o cómo llegar, mándasela con enviar_ubicacion por WhatsApp a este número ("te la mando por WhatsApp ahorita"); nunca dictes el link.` : ""}

LO QUE PUEDES HACER POR TELÉFONO: ${capacidadesTexto(cfg, herramientas)}. Si te piden otra cosa, dilo con honestidad${escalamientoActivo ? " y ofrece pasarlo con una persona" : ""}.

REGLAS (romper una es un error grave):
- Responde SOLO con los datos de arriba: lo que no está ahí no existe, aunque parezca obvio o el cliente insista. Nunca uses conocimiento general ni digas "probablemente", "normalmente" o "puedes intentar". Nunca inventes precios, horarios, promociones, métodos de pago ni servicios.
- Si no tienes la respuesta, llama primero a registrar_pregunta y di su "mensaje". Si repite algo que ya anotaste, di "Ya lo anoté, el equipo te contactará." y no lo contestes después por tu cuenta. No la uses para citas ni para pasar con una persona.
- Cada acción la hace una función: llámala y di lo que devuelva. Nunca des algo por hecho (cita, reserva, pedido, cambio, cancelación) antes de que la función lo confirme.
- Antes de registrar algo, pregunta el nombre natural ("¿a nombre de quién?") si no lo ha dicho; si no lo quiere dar, usa "Cliente". Su teléfono ya lo tienes: nunca lo pidas.
- Habla siempre en español mexicano. Si la transcripción no tiene sentido, di "Perdón, no te escuché bien, ¿me lo puedes repetir?" y no adivines. Si te interrumpen, calla y escucha. Si preguntan quién eres: tu nombre y el negocio.
${agendaActiva ? `
=== AGENDA DE CITAS ===
SERVICIOS PARA CITAS (el [ID:...] va en las funciones; nunca lo digas):
${serviciosAgendaTexto || "No hay servicios configurados"}

HORARIOS LIBRES: nunca los inventes ni los deduzcas del horario de atención (no sabes qué está ocupado).
- Pregunta abierta ("¿qué horarios tienes?", "¿tienes espacio el jueves?", "dame otro horario") → consultar_disponibilidad con servicio y día, y di su "mensaje" tal cual. Si no sabes el servicio, pregúntalo primero.
- Hora concreta ("el jueves a las 4", "esa de las 11") → NO consultes: agenda (o reagenda) directo. Si está ocupada o fuera de horario, la función te da las opciones: ofrécelas tal cual.
- Nunca consultes dos veces lo mismo: si eligió una hora de las que te dio el sistema, agéndala. Un rango ("entre 10:00 a.m. y 6:00 p.m.") incluye todas las horas de en medio.

HORAS Y FECHAS:
- Al cliente, horas en 12 h; en las funciones, 24 h. Nunca digas una hora en 24 h ni la pongas entre paréntesis.
- ${normalizar_hora_1.REGLA_NORMALIZACION_HORARIA}
- Sin am/pm, es la que cae dentro del horario de atención ("a las 3" con horario de 9 a 6 = 3 de la tarde); si caben las dos, pregunta.
- Copia la fecha exacta del CALENDARIO (al final); nunca calcules el día de la semana. "El [día]" = el más cercano. Antes de agendar confirma día y número ("el martes 8, ¿correcto?").

AGENDAR: con servicio, fecha y hora confirmados, llama a agendar_cita. Si responde que faltan datos, pídeselos y vuelve a llamarla.${hayCamposServicio ? `
DATOS DEL SERVICIO: si el servicio elegido tiene "Datos a recolectar", pregunta los OBLIGATORIOS con su etiqueta natural (nunca digas el ID ni "campo") y pásalos en camposAgenda con la clave [campo:...] como llave; los opcionales, solo si fluye.` : ""}${requiereAnticipoCitas ? `
ANTICIPO: este negocio pide ${anticipoCitasPctVoz} para apartar la cita. Llama a agendar_cita como siempre: el sistema aparta el horario y manda los datos de pago por WhatsApp a este número. Di el "mensaje" con el monto TAL CUAL y deja claro que la cita queda confirmada solo al pagar; no dictes cuentas ni links.` : ""}
CAMBIAR: reagendar_cita (nunca canceles para crear otra). CANCELAR: cancelar_cita solo si lo pide claro; ante algo ambiguo ("olvídalo", "ya no") pregunta "¿Quieres cancelar tu cita?". Sus citas están en CONTEXTO DE ESTA LLAMADA.
` : ""}${escalamientoActivo ? `
=== PASAR CON UNA PERSONA ===
Llama a escalar_humano ANTES de contestar y luego di su "mensaje" (si no la llamas, el equipo nunca se entera):
- tipo "directo": pide hablar con una persona, el dueño o el gerente.
- tipo "emergencia": urgencia médica, amenaza, agresión, demanda o falla grave de algo ya contratado.
- tipo "no_sabe": insiste en algo que ya anotaste sin respuesta y necesita atención inmediata.${temasTexto ? `
Si menciona cualquiera de estos temas, no lo resuelvas ni pidas datos: escala DE INMEDIATO (tipo "directo") y dile que lo comunicas con una persona:
${temasTexto}` : ""}${receptoresTexto ? `
Puedes pasarlo con:
${receptoresTexto}
Si hay varias y no dice cuál, pregúntale; pasa la etiqueta EXACTA en sucursalEtiqueta.` : ""}
` : ""}${verificarDispReserva ? `
=== RESERVAS DE HOSPEDAJE ===
${habitacionesTexto ? "" : "El negocio aún no tiene unidades cargadas; recolecta los datos sin ID.\n"}No prometas el resultado antes de llamar a la función (${reservaConfirmaAgente ? "si hay lugar y no falta pago, el sistema puede confirmarla" : "la decisión final la toma el negocio"}).
1. Pregunta la unidad y el primer y último día de uso (inclusive; si es un día, son el mismo). Las personas son opcionales. Copia las fechas del CALENDARIO.
2. Llama a solicitar_reserva con pagoReportado=false y di su "mensaje" TAL CUAL: distingue "registrada y pendiente" de "confirmada", nunca cambies una por la otra.
${metodoPago ? `3. Los datos de pago se los mandas por WHATSAPP a este número; no los dictes.
4. Vuelve a llamarla con pagoReportado=true SOLO cuando diga explícitamente que YA pagó; un "gracias", "ok" o silencio no es pago. Mientras no lo diga, no la vuelvas a llamar.` : `3. Aclara que la confirmación del equipo le llega por WhatsApp a este número.`}
- Nunca inventes disponibilidad ni precios. Si pregunta el costo de un día con "Precios por día", usa ese precio (los días sin valor cobran el base; para varios días, suma día por día).
` : ""}${bloqueGiro}${bloqueDatosDueno}${bloqueCicloVida}
=== CONTEXTO DE ESTA LLAMADA ===
Lo anterior es fijo del negocio; esto es de esta llamada.
FECHA Y HORA ACTUAL: ${ahoraStr}${usaFechas ? `
CALENDARIO (copia de aquí la fecha exacta): ${calendarioVoz(ahora, tz)}` : ""}${bloqueContextoLlamada}${agendaActiva ? (citasClienteTexto ? `

CITAS VIGENTES DE QUIEN LLAMA:
${citasClienteTexto}` : `

CITAS VIGENTES DE QUIEN LLAMA: ninguna.`) : ""}${operacionesCliente.length > 0 ? (operacionesResumenTexto ? `

SOLICITUDES VIGENTES DE QUIEN LLAMA (ya verificadas contra su número; los [REF:...] son internos):
${operacionesResumenTexto}` : `

SOLICITUDES VIGENTES DE QUIEN LLAMA: ninguna con este número. Si insiste, dile que a este número no le aparece nada y ofrécele una persona; no le pidas códigos.`) : ""}`;
}
// ─────────────────────────────────────────────────────────────────────────────
// OPENAI SIN CRÉDITO → aviso al equipo
//
// Cuando la cuenta de OpenAI se queda sin crédito se caen TODAS las llamadas de
// todos los negocios, y el 1-nov-2026 nadie se enteró hasta probar. El correo
// lo manda Odin (`/api/voice/alerta-proveedor`, con su propio freno de un
// aviso cada 6 h); aquí solo se evita pegarle en cada llamada fallida.
// ─────────────────────────────────────────────────────────────────────────────
function esSinCreditoOpenAI(texto) {
    return /insufficient_quota|credit_balance_exhausted|exceeded your current quota|no credits remaining/i.test(String(texto ?? ""));
}
const MIN_ENTRE_REPORTES_MS = 10 * 60_000;
let ultimoReporteSinCredito = 0;
function reportarSiSinCredito(detalle) {
    if (!esSinCreditoOpenAI(detalle))
        return;
    const ahora = Date.now();
    if (ahora - ultimoReporteSinCredito < MIN_ENTRE_REPORTES_MS)
        return;
    ultimoReporteSinCredito = ahora;
    console.error(`[PIPELINE] OpenAI SIN CRÉDITO — avisando al equipo: ${detalle.slice(0, 200)}`);
    fetch(`${config_1.config.odinAppUrl}/api/voice/alerta-proveedor`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...odinAuth() },
        body: JSON.stringify({ proveedor: "openai", detalle: detalle.slice(0, 1000) }),
        signal: AbortSignal.timeout(8000),
    }).catch((e) => {
        // Si no llegó, que el siguiente fallo lo vuelva a intentar.
        ultimoReporteSinCredito = 0;
        console.error("[PIPELINE] No se pudo avisar a Odin del crédito de OpenAI:", e?.message || e);
    });
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
function odinAuth() {
    return config_1.config.voiceServerSecret
        ? { Authorization: `Bearer ${config_1.config.voiceServerSecret}` }
        : {};
}
// Hasta dos intentos antes de dar el mensaje de indisponibilidad.
async function fetchConfigConRetry(url) {
    for (let intento = 1; intento <= 2; intento++) {
        try {
            const resp = await fetch(url, {
                headers: odinAuth(),
                signal: AbortSignal.timeout(5000),
            });
            if (resp.ok)
                return await resp.json();
            const errBody = await resp.text().catch(() => "");
            console.warn(`[PIPELINE] config-llamada HTTP ${resp.status} (intento ${intento}): ${errBody}`);
            if (resp.status === 404)
                return null; // no existe → no reintentar
        }
        catch (err) {
            console.warn(`[PIPELINE] config-llamada falló (intento ${intento}): ${err?.message || err}`);
        }
    }
    return null;
}
// Mensaje hablado con los datos de pago. Igual al de Odin (lib/reservas.ts)
// para que WhatsApp y voz suenen idénticos. Usa "por ciento" en vez de "%"
// y "pesos" para que el TTS lo lea bien.
function mensajeDatosPagoVoz(mp, info) {
    const lista = Array.isArray(mp) ? mp : [mp];
    if (lista.length === 0)
        return "";
    const primero = lista[0];
    const cantidad = info?.dias ?? info?.noches ?? 0;
    const cantidadValida = typeof cantidad === "number" && isFinite(cantidad) && cantidad > 0 ? cantidad : null;
    const palabraUnidad = (() => {
        const u = (info?.unidad || "").toLowerCase();
        if (u.includes("noche"))
            return cantidadValida === 1 ? "noche" : "noches";
        if (u.includes("hora"))
            return cantidadValida === 1 ? "hora" : "horas";
        return cantidadValida === 1 ? "día" : "días";
    })();
    const porDias = cantidadValida ? ` por ${cantidadValida} ${palabraUnidad}` : "";
    const viaDe = (m) => m.tipo === "transferencia" ? "transferencia"
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
    }
    else {
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
function mensajeAnticipoCitaVoz(monto, esMercadoPago, whatsappEnviado) {
    const montoTxt = typeof monto === "number" && isFinite(monto) && monto > 0
        ? ` de ${monto.toLocaleString("es-MX")} pesos`
        : "";
    const via = esMercadoPago ? "un link de pago" : "los datos de pago";
    const envio = whatsappEnviado
        ? `Te acabo de enviar ${via} por WhatsApp a este mismo número.`
        : `En un momento te llegan ${via} por WhatsApp a este mismo número.`;
    return `Para apartar tu cita necesitas un anticipo${montoTxt}. ${envio} En cuanto lo realices, tu cita queda confirmada y el equipo te avisa. ¿Hay algo más en lo que te pueda ayudar?`;
}
// Normaliza un número telefónico para comparación (solo dígitos, sin +).
/**
 * Los datos del dueño tal como los recolectó el modelo, listos para viajar.
 *
 * Devuelve `undefined` cuando no hay nada: mandar `{}` haría que el endpoint
 * viera un objeto vacío en vez de "no vino la llave", que es lo mismo hoy pero
 * no tiene por qué seguir siéndolo. Los valores se pasan a texto porque las
 * llaves son ids de campo y del otro lado se guardan como texto.
 */
function limpiarCamposDueno(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const entradas = Object.entries(raw).filter(([, v]) => v != null && String(v).trim().length > 0);
    if (entradas.length === 0)
        return undefined;
    return Object.fromEntries(entradas.map(([k, v]) => [k, String(v).trim()]));
}
/**
 * La referencia que el cliente dictó, normalizada.
 *
 * Por teléfono llega con espacios, guiones y comas de la transcripción ("a, ele,
 * siete - dos"). Del otro lado se compara contra el id sin guiones, así que
 * cualquier cosa que no sea letra o número sobra. Se conserva TAL CUAL en
 * mayúsculas: la comparación de Odin es case-insensitive.
 */
function limpiarReferencia(raw) {
    return String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 40);
}
function digitosDe(s) {
    return String(s || "").replace(/[^\d]/g, "");
}
// Compara dos números telefónicos por sus últimos 10 dígitos (México).
// Tolera diferencias en el código de país y el "+".
function mismoNumero(a, b) {
    const da = digitosDe(a);
    const db = digitosDe(b);
    if (!da || !db)
        return false;
    return da.slice(-10) === db.slice(-10);
}
// Convierte una hora en 24h ("15:00", "07:15") a 12h con am/pm en español
// ("3:00 p.m.", "7:15 a.m."). Mediodía → "12:00 p.m.", medianoche → "12:00 a.m.".
// Si el valor no es parseable lo regresa tal cual (defensivo: nunca truena).
function hora24aAmPm(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? "").trim());
    if (!m)
        return String(hhmm ?? "");
    const h = Number(m[1]);
    const min = m[2];
    if (!Number.isFinite(h) || h < 0 || h > 23)
        return String(hhmm ?? "");
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
function fechaHoraNatural(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}:\d{2})/.exec(String(iso ?? "").trim());
    if (!m)
        return String(iso ?? "").replace("T", " a las ");
    const dia = Number(m[3]);
    const mes = MESES_ES[Number(m[2]) - 1];
    const hora = hora24aAmPm(m[4]);
    return mes ? `el ${dia} de ${mes} a las ${hora}` : `a las ${hora}`;
}
// Construye la respuesta de "horario ocupado" (409) para agendar/reagendar a
// partir del nuevo contrato del backend. Regla de negocio: al hablar NO se
// recitan listas (`slotsDisponibles` queda ignorado a propósito). Se ofrecen
// SOLO las dos horas más cercanas (`recomendaciones`) ya convertidas a 12h;
// las `ventanasLibres` se devuelven formateadas para que el modelo las use solo
// si el cliente pide el panorama. Si no llegan recomendaciones (backend viejo o
// sin cercanas), el fallback es preguntar la hora preferida.
//
// Odin ya manda el texto armado (`mensaje`, el MISMO que WhatsApp, que sabe
// ofrecer "esa persona más tarde u otra persona a esa hora"); cuando viene, se
// usa ése y lo de abajo queda para un Odin anterior.
function respuestaHorarioOcupado(data) {
    if (typeof data?.mensaje === "string" && data.mensaje.trim()) {
        return { ok: false, mensaje: data.mensaje.trim() };
    }
    const cercanas = [];
    const antes = data?.recomendaciones?.antes;
    const despues = data?.recomendaciones?.despues;
    if (typeof antes === "string" && antes.trim())
        cercanas.push(hora24aAmPm(antes));
    if (typeof despues === "string" && despues.trim())
        cercanas.push(hora24aAmPm(despues));
    const ventanas = Array.isArray(data?.ventanasLibres)
        ? data.ventanasLibres
            .filter((v) => v && typeof v.desde === "string" && typeof v.hasta === "string")
            .map((v) => `de ${hora24aAmPm(v.desde)} a ${hora24aAmPm(v.hasta)}`)
        : [];
    let mensaje;
    if (cercanas.length === 2) {
        mensaje = `Ese horario ya está ocupado. ¿Te puedo agendar a las ${cercanas[0]} o a las ${cercanas[1]}?`;
    }
    else if (cercanas.length === 1) {
        mensaje = `Ese horario ya está ocupado. ¿Te sirve a las ${cercanas[0]}, o prefieres otra hora?`;
    }
    else {
        // Sin horas cercanas: NO recitamos slots. Preguntamos la hora preferida.
        mensaje = `Ese horario ya está ocupado. ¿A qué otra hora te gustaría? Yo reviso si está libre.`;
    }
    const out = { ok: false, mensaje };
    if (cercanas.length > 0)
        out.recomendaciones = cercanas;
    if (ventanas.length > 0)
        out.ventanasLibres = ventanas;
    return out;
}
class PipelineLlamada {
    ws;
    realtime;
    streamSid = "";
    callSid;
    configNegocio;
    historialOrdenado = [];
    inicioLlamada;
    negocioId;
    numeroTwilio;
    callerNumber;
    // Si la llamada llegó por desvío de Telcel/AT&T, ForwardedFrom dice el
    // número original que marcó el cliente (la sucursal). Lo usamos para dar
    // contexto al agente ("el cliente llamó a la Terraza A").
    forwardedFrom;
    // Receptor que coincide con forwardedFrom (sucursal de origen). Si no hay
    // match o no vino forwarded, queda null.
    receptorOrigen = null;
    // Anti-loop: si el número que llamó (From) coincide con un receptor de la
    // lista, asumimos que es un rebote del Dial que la IA acaba de hacer (el
    // humano no contestó y la llamada volvió por desvío condicional).
    esRebote = false;
    turnos = 0;
    // Nombre del cliente recolectado durante la llamada (lo pide el agente al
    // agendar/reservar/pedir). Reemplaza el "Llamada entrante" hardcodeado en
    // citas, conversaciones y notificaciones al gerente.
    nombreCliente = "";
    // Solo se guarda/cobra una llamada que Odin autorizó.
    llamadaAutorizada = false;
    // ── TECLEO de espera ("está buscando en el sistema") ─────────────────────
    // Suena SOLO en la espera silenciosa: después de la frase de espera y
    // mientras el fetch de la herramienta sigue corriendo. Se corta al instante
    // si el cliente habla o cuando el agente retoma la palabra.
    tecleoTimer = null;
    tecleoDesde = 0;
    tecleoIdx = 0;
    /** Frames de tecleo REALMENTE enviados en esta espera (para decidir si hay
     *  que limpiar el buffer de Twilio al parar — ver detenerTecleo). */
    tecleoFramesEnviados = 0;
    static TECLEO_MAX_MS = 15_000; // red de seguridad
    // ── ROOM TONE (opt-in: AMBIENTE_LLAMADA=on) ──────────────────────────────
    // "Aire" de oficina casi subliminal para matar el silencio digital muerto.
    // Va en cola DESPUÉS del audio del agente (Twilio reproduce en orden), así
    // que nunca ensucia la voz; en interrupciones el "clear" lo tira junto con
    // el resto del buffer.
    ambienteTimer = null;
    ambienteIdx = 0;
    constructor(ws, negocioId, configNegocio, callerNumber = "", numeroTwilio = "", callSid = "", forwardedFrom = "") {
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
        this.realtime = new realtime_1.OpenAIRealtime(prompt, herramientas, configNegocio.voz || "marin");
    }
    // Después de que llega la config completa, calculamos:
    //  - receptorOrigen: la sucursal a la que originalmente llamó el cliente
    //    (ForwardedFrom matchea un receptor) — para que el agente lo mencione.
    //  - esRebote: la llamada entrante viene de uno de los humanos a los que
    //    acabamos de escalar — el humano no contestó y la llamada rebotó.
    //    En este caso el agente NO debe saludar como sesión nueva: el cliente
    //    ya estaba esperando humano y necesita cierre (recado, otra opción).
    calcularContextoSucursal() {
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
        if (this.callerNumber &&
            this.numeroTwilio &&
            mismoNumero(this.callerNumber, this.numeroTwilio) &&
            this.forwardedFrom) {
            this.esRebote = true;
            const r = this.receptorOrigen;
            console.log(`[PIPELINE] Llamada detectada como REBOTE${r ? ` desde ${r.etiqueta} (${r.numero})` : ` (forwardedFrom=${this.forwardedFrom})`} — el humano no contestó al Dial`);
        }
    }
    esTranscripcionValida(texto) {
        const t = texto.trim();
        const tLower = t.toLowerCase();
        if (t.length < 4)
            return false;
        if (tLower.includes("www.") || tLower.includes("http") || tLower.includes(".com") || tLower.includes(".org"))
            return false;
        if (/^[\s.,!?¿¡0-9\-]+$/.test(t))
            return false;
        const ruidoExacto = [
            "gracias.", "gracias", "un saludo.", "un saludo",
            "subs", "subtítulos", "suscríbete", "chau.", "chau",
            "ok.", "ok", "bye.", "bye", "...", ". . .",
        ];
        if (ruidoExacto.includes(tLower))
            return false;
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
    async colgarTwilioCall() {
        if (!this.callSid) {
            console.warn("[FUNCIÓN] colgar_llamada: no hay callSid, cerrando WebSocket");
            try {
                this.ws.close();
            }
            catch { }
            return;
        }
        try {
            const client = (0, twilio_1.default)(config_1.config.twilioAccountSid, config_1.config.twilioAuthToken);
            await client.calls(this.callSid).update({ status: "completed" });
            console.log(`[FUNCIÓN] colgar_llamada: llamada ${this.callSid} colgada vía Twilio API`);
        }
        catch (err) {
            console.error("[FUNCIÓN] colgar_llamada: error con Twilio API, cerrando WS:", err?.message || err);
            try {
                this.ws.close();
            }
            catch { }
        }
    }
    // Si Odin rechaza la llamada o falla OpenAI, Twilio reproduce el aviso y cuelga.
    agenteCaido = false;
    async atenderSinAgente(motivo) {
        if (this.agenteCaido || this.finalizada)
            return;
        this.agenteCaido = true;
        this.detenerTecleo();
        this.detenerAmbiente();
        console.warn(`[PIPELINE] Agente no disponible (${motivo}) — despidiendo la llamada ${this.callSid}`);
        try {
            this.realtime.cerrar();
        }
        catch { }
        if (!this.callSid) {
            try {
                this.ws.close();
            }
            catch { }
            return;
        }
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="es-MX" voice="Polly.Mia">Lo sentimos, en este momento no podemos atender su llamada. Por favor intente de nuevo en unos minutos o escríbanos por WhatsApp.</Say>
  <Hangup/>
</Response>`;
        try {
            const client = (0, twilio_1.default)(config_1.config.twilioAccountSid, config_1.config.twilioAuthToken);
            await client.calls(this.callSid).update({ twiml });
        }
        catch (e) {
            console.error("[PIPELINE] No se pudo aplicar TwiML de despedida:", e?.message || e);
            try {
                this.ws.close();
            }
            catch { }
        }
    }
    async manejarFuncion(nombre, args, callId) {
        const odinUrl = config_1.config.odinAppUrl;
        const negocioId = this.configNegocio.negocioId || this.negocioId;
        const callerNumber = this.callerNumber;
        console.log(`[FUNCIÓN] ${nombre}:`, args);
        // Capturar el nombre del cliente venga de la función que venga: se usa en
        // TODAS las llamadas a Odin y en el webhook de cierre (adiós "Llamada
        // entrante"). "Cliente" es el placeholder cuando no lo quiso dar.
        if (typeof args?.clienteNombre === "string" && args.clienteNombre.trim()) {
            const nom = args.clienteNombre.trim().slice(0, 80);
            if (nom.toLowerCase() !== "cliente")
                this.nombreCliente = nom;
        }
        const nombreClienteFinal = this.nombreCliente || "Llamada entrante";
        try {
            switch (nombre) {
                case "consultar_disponibilidad": {
                    // El [CONSULTAR_DISPONIBILIDAD] de WhatsApp: mismo cálculo en Odin
                    // (lib/citas-agenda) y mismo texto. Antes la voz no podía contestar
                    // "¿tienen el jueves?" sin crear la cita.
                    const resp = await fetch(`${odinUrl}/api/voice/disponibilidad`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...odinAuth() },
                        body: JSON.stringify({
                            negocioId,
                            servicioId: resolverServicioId(this.configNegocio, args.servicioId),
                            fecha: args.fecha,
                            profesional: args.profesional,
                        }),
                        signal: AbortSignal.timeout(8000),
                    });
                    const data = (await resp.json().catch(() => ({})));
                    if (!resp.ok || !data.mensaje) {
                        console.error(`[FUNCIÓN] consultar_disponibilidad → HTTP ${resp.status}:`, data);
                        return { ok: false, mensaje: "No pude revisar la agenda en este momento. Pregúntale a qué hora le gustaría y prueba agendarla, o ofrécele pasarlo con una persona." };
                    }
                    return { ok: data.ok !== false, mensaje: data.mensaje };
                }
                case "agendar_cita": {
                    const body = {
                        negocioId,
                        servicioId: resolverServicioId(this.configNegocio, args.servicioId),
                        fechaInicio: args.fechaInicio,
                        clienteNombre: nombreClienteFinal,
                        clienteTelefono: callerNumber || "desconocido",
                        profesional: args.profesional,
                    };
                    // Campos personalizados del servicio: solo los mandamos si el modelo
                    // recolectó al menos uno. La llave es el id del campo (c1, c2…),
                    // nunca la etiqueta. Servicios sin camposAgenda → no mandamos la
                    // llave y el backend se comporta como siempre.
                    if (args.camposAgenda &&
                        typeof args.camposAgenda === "object" &&
                        !Array.isArray(args.camposAgenda)) {
                        const entradas = Object.entries(args.camposAgenda).filter(([, v]) => v != null && String(v).trim().length > 0);
                        if (entradas.length > 0) {
                            body.camposAgenda = Object.fromEntries(entradas.map(([k, v]) => [k, String(v)]));
                        }
                    }
                    const resp = await fetch(`${odinUrl}/api/voice/citas`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...odinAuth() },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(8000),
                    });
                    const data = (await resp.json().catch(() => ({})));
                    if (!resp.ok) {
                        // 400 FALTAN_CAMPOS: faltó un dato obligatorio del servicio. El
                        // backend manda las ETIQUETAS de lo que falta en `faltantes`. Se
                        // las pedimos al cliente y el modelo reintentará agendar_cita.
                        if (data.error === "FALTAN_CAMPOS" &&
                            Array.isArray(data.faltantes) &&
                            data.faltantes.length > 0) {
                            return {
                                ok: false,
                                mensaje: `Antes de agendar necesito un par de datos más: ${data.faltantes.join(", ")}. ¿Me los puedes dar?`,
                            };
                        }
                        // 409 ocupado: las alternativas que da Odin (mismo texto que WhatsApp).
                        if (resp.status === 409 || data.recomendaciones || data.ventanasLibres || data.slotsDisponibles) {
                            return respuestaHorarioOcupado(data);
                        }
                        // 422 fuera de horario / en el pasado, 404 servicio que no existe:
                        // Odin ya dice qué pasó y qué ofrecer.
                        if (data.mensaje)
                            return { ok: false, mensaje: data.mensaje };
                        // Lo demás es una falla NUESTRA, no del horario. Antes se le decía
                        // al cliente "intenta con otro horario", y él probaba otra hora
                        // sobre un sistema caído.
                        console.error(`[FUNCIÓN] agendar_cita → HTTP ${resp.status}:`, data);
                        return { ok: false, mensaje: "Tuve un problema con el sistema y no pude registrar la cita. Dile al cliente la verdad y ofrécele intentarlo de nuevo o pasarlo con una persona." };
                    }
                    // La cita nueva entra a la lista de esta llamada con su ID corto, por
                    // si en la misma llamada quiere moverla o cancelarla.
                    const citas = (this.configNegocio.citasCliente = [...(this.configNegocio.citasCliente || [])]);
                    let aliasNueva;
                    if (data.citaId) {
                        const servicioNombre = (this.configNegocio.servicios || []).find((s) => s.id === body.servicioId)?.nombre || "Cita";
                        citas.push({ id: data.citaId, servicio: servicioNombre, fechaInicio: fechaHoraNatural(args.fechaInicio), estado: data.estado || "agendada" });
                        aliasNueva = aliasCita(citas.length - 1);
                    }
                    // 201 con anticipo: la cita NO está confirmada, quedó apartada
                    // esperando el pago. Decimos el monto y que los datos van por WhatsApp
                    // (el backend ya los envió). NO la damos por confirmada.
                    if (data.esperandoPago) {
                        return {
                            ok: true,
                            citaId: aliasNueva,
                            mensaje: mensajeAnticipoCitaVoz(data.montoAnticipo, data.esMercadoPago === true, data.mensajeWhatsappEnviado === true),
                        };
                    }
                    const detalle = fechaHoraNatural(args.fechaInicio);
                    return data.requiereConfirmacion
                        ? { ok: true, citaId: aliasNueva, mensaje: `Tu solicitud de cita para ${detalle} quedó registrada, pero todavía está pendiente de confirmación del negocio. Te avisaremos por WhatsApp cuando respondan. ¿Algo más?` }
                        : { ok: true, citaId: aliasNueva, mensaje: `Tu cita quedó confirmada para ${detalle}. ¿Hay algo más en lo que te pueda ayudar?` };
                }
                case "cancelar_cita": {
                    const resp = await fetch(`${odinUrl}/api/voice/citas`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json", ...odinAuth() },
                        // clienteTelefono: el backend valida que la cita sea de ESTE
                        // llamante antes de cancelar (impide cancelar la cita de otro).
                        body: JSON.stringify({
                            citaId: resolverCitaId(this.configNegocio, args.citaId),
                            negocioId,
                            accion: "cancelar",
                            clienteTelefono: callerNumber || "desconocido",
                        }),
                        signal: AbortSignal.timeout(8000),
                    });
                    if (resp.status === 404)
                        return { ok: false, mensaje: "No encontré esa cita a tu nombre. ¿Me dices para qué día era?" };
                    if (!resp.ok)
                        return { ok: false, mensaje: "Tuve un problema con el sistema y no pude cancelar la cita. Dile al cliente la verdad y ofrécele pasarlo con una persona." };
                    return { ok: true, mensaje: "Tu cita ha sido cancelada. ¿Hay algo más en lo que te pueda ayudar?" };
                }
                case "reagendar_cita": {
                    const resp = await fetch(`${odinUrl}/api/voice/citas`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json", ...odinAuth() },
                        body: JSON.stringify({
                            citaId: resolverCitaId(this.configNegocio, args.citaId),
                            negocioId,
                            accion: "reagendar",
                            servicioId: args.servicioId ? resolverServicioId(this.configNegocio, args.servicioId) : undefined,
                            fechaInicio: args.fechaInicio,
                            profesional: args.profesional,
                            // clienteTelefono: el backend valida que la cita sea de ESTE
                            // llamante antes de moverla (impide reagendar la cita de otro).
                            clienteTelefono: callerNumber || "desconocido",
                        }),
                        signal: AbortSignal.timeout(8000),
                    });
                    const data = (await resp.json().catch(() => ({})));
                    if (!resp.ok) {
                        if (resp.status === 409 || data.recomendaciones || data.ventanasLibres || data.slotsDisponibles) {
                            return respuestaHorarioOcupado(data);
                        }
                        if (data.mensaje)
                            return { ok: false, mensaje: data.mensaje };
                        if (resp.status === 404)
                            return { ok: false, mensaje: "No encontré esa cita a tu nombre. ¿Me dices para qué día era?" };
                        console.error(`[FUNCIÓN] reagendar_cita → HTTP ${resp.status}:`, data);
                        return { ok: false, mensaje: "Tuve un problema con el sistema y no pude mover la cita. Dile al cliente la verdad y ofrécele intentarlo de nuevo o pasarlo con una persona." };
                    }
                    return {
                        ok: true,
                        mensaje: args.fechaInicio
                            ? `Listo, tu cita quedó cambiada para ${fechaHoraNatural(args.fechaInicio)}. ¿Algo más?`
                            : "Tu cita ha sido actualizada. ¿Hay algo más en lo que te pueda ayudar?",
                    };
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
                            // Los datos que el dueño pide de más en TODAS sus reservas. La
                            // llave es el id del campo (c1, c2…), nunca la etiqueta.
                            camposMotor: limpiarCamposDueno(args.camposMotor),
                        }),
                        signal: AbortSignal.timeout(8000),
                    });
                    const data = (await resp.json().catch(() => ({})));
                    if (!resp.ok) {
                        // 400 FALTAN_CAMPOS: faltó un dato que este negocio pide siempre.
                        // Se le devuelven las ETIQUETAS al modelo para que se las pida al
                        // cliente y reintente — igual que en agendar_cita.
                        if (data.error === "FALTAN_CAMPOS" && Array.isArray(data.faltantes) && data.faltantes.length > 0) {
                            return {
                                ok: false,
                                mensaje: `Antes de mandar la reserva necesito un par de datos más: ${data.faltantes.join(", ")}. ¿Me los puedes dar?`,
                            };
                        }
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
                            if (Number.isFinite(n) && n > 0)
                                pagoInfo = { ...pagoInfo, noches: n };
                        }
                        return { ok: true, mensaje: mensajeDatosPagoVoz(metodosListados, pagoInfo) };
                    }
                    // El cliente ya reportó el pago: el backend avisó al equipo.
                    if (pagoReportado) {
                        return { ok: true, mensaje: "Perfecto, ya avisé al equipo para que verifique tu pago. Te confirman la reserva en breve. ¿Algo más?" };
                    }
                    // Disponible y sin método de pago configurado.
                    if (data.disponible && data.requiereConfirmacion === false) {
                        return { ok: true, mensaje: "Sí tenemos disponibilidad para esas fechas. Tu reserva quedó confirmada. ¿Algo más?" };
                    }
                    return { ok: true, mensaje: "Tu solicitud de reserva quedó registrada, pero todavía está pendiente de confirmación del negocio. Te avisaremos por WhatsApp cuando respondan. ¿Algo más?" };
                }
                case "crear_pedido": {
                    const items = Array.isArray(args.items)
                        ? args.items.map((x) => ({ servicioId: String(x?.servicioId || ""), cantidad: Number(x?.cantidad) || 1 }))
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
                            camposMotor: limpiarCamposDueno(args.camposMotor),
                        }),
                        signal: AbortSignal.timeout(8000),
                    });
                    const data = (await resp.json().catch(() => ({})));
                    if (!resp.ok) {
                        if (data.error === "FALTAN_CAMPOS" && Array.isArray(data.faltantes) && data.faltantes.length > 0) {
                            return {
                                ok: false,
                                mensaje: `Antes de registrar el pedido necesito un par de datos más: ${data.faltantes.join(", ")}. ¿Me los puedes dar?`,
                            };
                        }
                        return { ok: false, mensaje: "Tuve un problema registrando el pedido. ¿Me lo confirmas otra vez, por favor?" };
                    }
                    return data.requiereConfirmacion
                        ? { ok: true, mensaje: `Tu solicitud de pedido por ${data.total} pesos quedó registrada, pero todavía no está confirmada. Te avisaremos por WhatsApp cuando el negocio responda. ¿Algo más?` }
                        : { ok: true, mensaje: `Tu pedido quedó confirmado por un total de ${data.total} pesos. ¿Algo más?` };
                }
                case "enviar_ubicacion": {
                    if (!callerNumber) {
                        return { ok: false, mensaje: "No tengo tu número para mandártela por WhatsApp. ¿Me lo puedes dictar?" };
                    }
                    // Si preguntó por una terraza/sucursal puntual, resolvemos su id para
                    // mandar la dirección específica de ese ítem.
                    let servicioId;
                    const catalogo = this.configNegocio.catalogo;
                    if (args.itemNombre && Array.isArray(catalogo)) {
                        const item = catalogo.find((it) => it.nombre && it.nombre.toLowerCase().includes(String(args.itemNombre).toLowerCase()));
                        if (item && item.id)
                            servicioId = item.id;
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
                    }
                    catch (e) { /* cae al mensaje de abajo */ }
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
                        }
                        catch (e) { /* no bloquear */ }
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
                    let transferTo = null;
                    let canalReceptor = null;
                    let receptorEtiqueta = null;
                    if (!respEscalar.ok) {
                        const errBody = await respEscalar.text().catch(() => "");
                        console.error(`[FUNCIÓN] escalar_humano → HTTP ${respEscalar.status}: ${errBody}`);
                    }
                    else {
                        console.log(`[FUNCIÓN] escalar_humano → HTTP ${respEscalar.status} OK`);
                        const data = (await respEscalar.json().catch(() => ({})));
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
                            const cbEstado = `${(0, config_1.urlPublicaHttps)()}/transferencia-estado`;
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
                                (0, transferencias_1.registrarTransferencia)({
                                    callSid: callSidSnapshot,
                                    negocioId: negocioIdSnapshot,
                                    destino: transferTo,
                                    inicioMs: Date.now(),
                                });
                                try {
                                    const twClient = (0, twilio_1.default)(config_1.config.twilioAccountSid, config_1.config.twilioAuthToken);
                                    const updated = await twClient.calls(callSidSnapshot).update({ twiml });
                                    console.log(`[FUNCIÓN] escalar_humano: Twilio status=${updated.status} → ${transferTo}`);
                                }
                                catch (e) {
                                    // Twilio rechazó el TwiML: no hay pierna saliente que cobrar y
                                    // el callback nunca va a llegar. Desregistrar para no dejar
                                    // basura en el mapa hasta que la purge el TTL.
                                    (0, transferencias_1.tomarTransferencia)(callSidSnapshot);
                                    console.error("[FUNCIÓN] escalar_humano: fallo al aplicar TwiML:", e?.message || e, e?.code ? `(code=${e.code})` : "");
                                }
                            }, 3500);
                            // El agente dice esto con su voz Realtime mientras esperamos
                            // los 3500ms y Twilio aplica la transferencia. Cuando aplique,
                            // Twilio cierra el stream y el cliente escucha el ringing.
                            return { ok: true, mensaje: "Perfecto, te paso con un asesor. Un momento, no cuelgues." };
                        }
                        catch (e) {
                            console.error("[FUNCIÓN] escalar_humano: fallo al programar transferencia:", e?.message || e, e?.code ? `(code=${e.code})` : "");
                        }
                    }
                    // POR DÓNDE le va a llegar la respuesta, dicho tal cual.
                    //
                    // Cuando alguien del negocio contesta este pendiente, Odin le manda la
                    // respuesta al cliente POR WHATSAPP, al número desde el que llamó (ver
                    // `responderPendiente` en app/lib/pendientes.ts). Decir "alguien te
                    // contactará" a secas dejaba a la persona esperando una llamada que no
                    // iba a llegar, y el WhatsApp le aparecía después sin contexto.
                    //
                    // Y si la llamada entró con el identificador oculto no hay número al
                    // cual escribirle: Odin no crea el pendiente, así que NADIE va a poder
                    // contestarle. Ahí no se promete nada — se le pide un contacto. Misma
                    // regla de honestidad que los marcadores: si la acción no se pudo
                    // hacer, no se finge que sí.
                    const hayNumeroParaResponder = !!callerNumber && callerNumber.replace(/\D/g, "").length >= 10;
                    const mensajes = {
                        directo: hayNumeroParaResponder
                            ? "Listo, ya notifiqué al equipo. Te escriben por WhatsApp a este mismo número."
                            : "Listo, ya notifiqué al equipo. ¿Me compartes un número de WhatsApp para que te contacten?",
                        emergencia: "Entendido. El equipo fue notificado de inmediato.",
                        no_sabe: hayNumeroParaResponder
                            ? "Ya notifiqué al equipo. En cuanto me confirmen, te llega la respuesta por WhatsApp a este número."
                            : "Ya notifiqué al equipo. ¿Me compartes un número de WhatsApp para mandarte la respuesta?",
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
                        // No se registró nada: nadie va a poder contestarle. Prometer que
                        // "el equipo te contactará" seria mentir.
                        return { ok: true, mensaje: "Tomo nota. ¿Te parece si lo revisas directamente con el equipo?" };
                    }
                    console.log(`[FUNCIÓN] registrar_pregunta → HTTP ${respAprendizaje.status} OK`);
                    // Odin crea el pendiente solo si hay número al cual escribirle (ver
                    // /api/voice/aprendizaje). Sin número, la pregunta queda registrada
                    // para el dueño pero no hay forma de devolverle la respuesta a quien
                    // llamó, así que se le pide un contacto en vez de prometerle algo.
                    const puedenResponderle = !!callerNumber && callerNumber.replace(/\D/g, "").length >= 10;
                    return {
                        ok: true,
                        mensaje: puedenResponderle
                            ? "Anotado. En cuanto el equipo me confirme, te llega la respuesta por WhatsApp a este número."
                            : "Anotado. ¿Me compartes un número de WhatsApp para mandarte la respuesta?",
                    };
                }
                case "consultar_operacion":
                case "modificar_operacion":
                case "cancelar_operacion": {
                    // ── CICLO DE VIDA DE LO YA CREADO ─────────────────────────────────
                    // Las tres van al MISMO endpoint porque son la misma operación con
                    // distinta acción, y ese endpoint corre el MISMO núcleo que WhatsApp
                    // (`ejecutarOperacionCliente`): las mismas reglas de qué se puede
                    // tocar según el estado, la misma validación por teléfono y los
                    // mismos textos. Reimplementar aquí cualquier parte de eso es como
                    // los canales se desincronizaron la vez pasada.
                    //
                    // Sin número de quien llama no se intenta siquiera: la autorización
                    // ES el teléfono, y "desconocido" no autoriza nada.
                    if (!callerNumber) {
                        return {
                            ok: false,
                            mensaje: "No alcanzo a ver tu número desde esta llamada, así que no puedo consultar ni mover tus solicitudes. Dile al cliente que lo puede hacer por WhatsApp o pásalo con una persona.",
                        };
                    }
                    const accion = nombre === "consultar_operacion"
                        ? (limpiarReferencia(args?.referencia) ? "consultar" : "listar")
                        : nombre === "modificar_operacion"
                            ? "modificar"
                            : "cancelar";
                    const respOp = await fetch(`${odinUrl}/api/voice/operacion-cliente`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...odinAuth() },
                        body: JSON.stringify({
                            negocioId,
                            // NO sale de `args`: el modelo no elige de quién son los datos
                            // que puede ver o mover. Es el número desde el que entró la
                            // llamada, y punto.
                            telefonoCliente: callerNumber,
                            accion,
                            tipo: args?.tipo,
                            referencia: limpiarReferencia(args?.referencia) || undefined,
                            cambios: args?.cambios && typeof args.cambios === "object" ? args.cambios : undefined,
                        }),
                        signal: AbortSignal.timeout(10000),
                    });
                    const dataOp = await respOp.json().catch(() => ({}));
                    if (!respOp.ok) {
                        console.error(`[FUNCIÓN] ${nombre} → HTTP ${respOp.status}:`, dataOp);
                        return { ok: false, mensaje: "No pude consultarlo en el sistema ahorita. Dile al cliente la verdad y ofrécele pasarlo con una persona." };
                    }
                    // El equipo tiene que revisarlo (ya está pagado, ya está en proceso).
                    // Se avisa por el MISMO camino que escalar_humano — no se inventa uno
                    // nuevo — y solo si el negocio tiene escalamiento encendido, que es
                    // lo que Odin decidió en `escalar`.
                    if (dataOp?.escalar === true) {
                        try {
                            await fetch(`${odinUrl}/api/voice/escalar`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", ...odinAuth() },
                                body: JSON.stringify({
                                    negocioId,
                                    tipo: "no_sabe",
                                    resumen: `El cliente pidió ${accion === "cancelar" ? "cancelar" : "cambiar"} su ${String(args?.tipo || "solicitud")} por teléfono y el sistema no lo permitió: ${String(dataOp?.texto || "").slice(0, 500)}`,
                                    telefonoCliente: callerNumber,
                                    nombreCliente: nombreClienteFinal,
                                }),
                                signal: AbortSignal.timeout(8000),
                            });
                        }
                        catch (e) {
                            console.error(`[FUNCIÓN] ${nombre}: no se pudo avisar al equipo`, e);
                        }
                    }
                    // LA REGLA DE HONESTIDAD: `aplicado` es lo único que autoriza al
                    // agente a confirmar. Si el sistema no lo hizo, el texto ya explica
                    // por qué y se dice TAL CUAL — nunca un "listo" de cortesía.
                    const textoOp = typeof dataOp?.texto === "string" && dataOp.texto.trim()
                        ? dataOp.texto.trim()
                        : "No pude obtener esa información.";
                    return {
                        ok: dataOp?.aplicado === true,
                        mensaje: dataOp?.aplicado === true
                            ? textoOp
                            : `${textoOp} Díselo al cliente con esas palabras; NO le confirmes nada que el sistema no haya hecho.`,
                    };
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
                    if (!accion)
                        return { ok: false, mensaje: "Función no reconocida." };
                    // Los campos del giro y los del dueño conservan la misma llave que
                    // usan WhatsApp y Meta. Odin los valida y después los normaliza a
                    // `datos.extras`; aplanarlos aquí hacía que aparecieran como faltantes.
                    const { camposMotor, ...datos } = (args || {});
                    const cuerpo = { ...datos };
                    if (camposMotor && typeof camposMotor === "object")
                        cuerpo.camposMotor = camposMotor;
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
                    const dataMotor = await respMotor.json().catch(() => ({}));
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
                    const faltantes = Array.isArray(dataMotor?.faltantes) ? dataMotor.faltantes : [];
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
                    const mensajeCliente = typeof primero?.mensajeCliente === "string" && primero.mensajeCliente.trim()
                        ? primero.mensajeCliente.trim()
                        : "La solicitud quedó registrada. El negocio revisará lo pendiente y te responderá por WhatsApp.";
                    return { ok: true, mensaje: mensajeCliente };
                }
            }
        }
        catch (err) {
            console.error(`[FUNCIÓN] Error en ${nombre}:`, err);
            return { ok: false, mensaje: "Hubo un problema procesando la acción. Por favor intenta de nuevo." };
        }
    }
    // ── Tecleo de espera ──────────────────────────────────────────────────────
    iniciarTecleo() {
        if (this.tecleoTimer)
            return;
        // Arranca en un punto aleatorio del loop para que dos esperas seguidas
        // no suenen idénticas.
        this.tecleoIdx = Math.floor(Math.random() * sonidos_1.FRAMES_TECLEO.length);
        this.tecleoDesde = Date.now();
        this.tecleoFramesEnviados = 0;
        this.tecleoTimer = setInterval(() => {
            if (Date.now() - this.tecleoDesde > PipelineLlamada.TECLEO_MAX_MS) {
                this.detenerTecleo();
                return;
            }
            this.tecleoFramesEnviados++;
            this.enviarFrameCrudo(sonidos_1.FRAMES_TECLEO[this.tecleoIdx++ % sonidos_1.FRAMES_TECLEO.length]);
        }, sonidos_1.MS_POR_FRAME);
        console.log("[SONIDO] Tecleo de espera ON");
    }
    detenerTecleo() {
        if (!this.tecleoTimer)
            return;
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
        if (limpiar)
            this.limpiarAudioTwilio();
        console.log(`[SONIDO] Tecleo de espera OFF (${this.tecleoFramesEnviados} frames${limpiar ? ", buffer limpiado" : ", sin limpiar"})`);
    }
    // ── Room tone (opt-in) ────────────────────────────────────────────────────
    iniciarAmbiente() {
        if (!sonidos_1.AMBIENTE_ACTIVO || this.ambienteTimer)
            return;
        this.ambienteTimer = setInterval(() => {
            // El tecleo manda: cuando suena, el ambiente se pausa (ya trae su aire).
            if (this.tecleoTimer)
                return;
            this.enviarFrameCrudo(sonidos_1.FRAMES_AMBIENTE[this.ambienteIdx++ % sonidos_1.FRAMES_AMBIENTE.length]);
        }, sonidos_1.MS_POR_FRAME);
        console.log("[SONIDO] Room tone ON (AMBIENTE_LLAMADA=on)");
    }
    detenerAmbiente() {
        if (!this.ambienteTimer)
            return;
        clearInterval(this.ambienteTimer);
        this.ambienteTimer = null;
    }
    // Frame μ-law pre-generado directo a Twilio (misma vía que la voz).
    enviarFrameCrudo(base64Frame) {
        if (this.ws.readyState === ws_1.default.OPEN && this.streamSid) {
            this.ws.send(JSON.stringify({
                event: "media",
                streamSid: this.streamSid,
                media: { payload: base64Frame },
            }));
        }
    }
    registrarCallbacks() {
        this.realtime.setOnAudioDelta((b) => {
            // Si el agente empieza a hablar con el tecleo activo (carrera muy
            // corta), el tecleo muere aquí — la voz SIEMPRE gana.
            if (this.tecleoTimer)
                this.detenerTecleo();
            this.enviarAudioTwilio(b);
        });
        this.realtime.setOnEspera((activa) => (activa ? this.iniciarTecleo() : this.detenerTecleo()));
        this.realtime.setOnInterrupcion(() => {
            this.detenerTecleo();
            this.limpiarAudioTwilio();
        });
        this.realtime.setOnFunctionCall((nombre, args, callId) => this.manejarFuncion(nombre, args, callId));
        this.realtime.setOnCaida((motivo) => {
            reportarSiSinCredito(motivo);
            this.atenderSinAgente(motivo).catch(() => { });
        });
        this.realtime.setOnErrorOpenAI((detalle) => reportarSiSinCredito(detalle));
        this.realtime.setOnItemCreated((itemId) => {
            this.historialOrdenado.push({ role: "user", content: "", itemId, pending: true });
        });
        this.realtime.setOnTranscript((texto, role, itemId) => {
            if (role === "user") {
                const idx = itemId
                    ? this.historialOrdenado.findIndex((t) => t.itemId === itemId && t.pending)
                    : this.historialOrdenado.findLastIndex((t) => t.role === "user" && t.pending);
                if (!this.esTranscripcionValida(texto)) {
                    if (idx !== -1)
                        this.historialOrdenado.splice(idx, 1);
                    console.log(`[STT] Descartado (ruido): "${texto}"`);
                }
                else {
                    if (idx !== -1) {
                        this.historialOrdenado[idx].content = texto;
                        this.historialOrdenado[idx].pending = false;
                    }
                    else {
                        this.historialOrdenado.push({ role: "user", content: texto, pending: false });
                    }
                    this.turnos++;
                    console.log(`[USUARIO] "${texto}"`);
                }
            }
            else {
                this.historialOrdenado.push({ role: "assistant", content: texto, pending: false });
                console.log(`[AGENTE] "${texto}"`);
            }
        });
    }
    async iniciar() {
        const params = new URLSearchParams();
        if (this.negocioId)
            params.set("negocioId", this.negocioId);
        if (this.numeroTwilio)
            params.set("numeroTwilio", this.numeroTwilio);
        if (this.callerNumber)
            params.set("callerNumber", this.callerNumber);
        // Odin comprueba el interruptor del agente y el saldo en cada llamada.
        const url = `${config_1.config.odinAppUrl}/api/voice/config-llamada?${params.toString()}`;
        const configActual = await fetchConfigConRetry(url);
        if (this.finalizada || this.ws.readyState !== ws_1.default.OPEN)
            return;
        if (configActual?.bloqueado) {
            await this.atenderSinAgente("negocio desactivado o sin saldo");
            return;
        }
        if (!configActual?.negocioId || typeof configActual.habilidades !== "string") {
            await this.atenderSinAgente("configuración del negocio no disponible");
            return;
        }
        this.llamadaAutorizada = true;
        this.negocioId = configActual.negocioId;
        this.configNegocio = { ...this.configNegocio, ...configActual };
        const vozRegistrada = this.numeroTwilio ? (0, registro_voz_1.obtenerVozPorNumero)(this.numeroTwilio) : null;
        if (vozRegistrada)
            this.configNegocio.voz = vozRegistrada;
        this.calcularContextoSucursal();
        const prompt = buildSystemPrompt(this.configNegocio, {
            receptorOrigen: this.receptorOrigen,
            esRebote: this.esRebote,
        });
        const tools = construirHerramientas(this.configNegocio);
        this.registrarCallbacks();
        try {
            await this.realtime.abrirConexion();
        }
        catch (err) {
            const motivo = err instanceof Error ? err.message : String(err);
            reportarSiSinCredito(motivo);
            await this.atenderSinAgente(`OpenAI no conectó: ${motivo}`);
            return;
        }
        if (this.finalizada || this.ws.readyState !== ws_1.default.OPEN)
            return;
        const voz = this.configNegocio.voz || "marin";
        this.realtime.configurarSesion(prompt, tools, voz, this.configNegocio.velocidadVoz);
        console.log(`[PIPELINE] Saludo con memoria + voz=${voz} — ${this.configNegocio.nombreNegocio}`);
    }
    recibirMensajeTwilio(mensaje) {
        switch (mensaje.event) {
            case "start":
                this.streamSid = mensaje.start?.streamSid || "";
                console.log(`[TWILIO] Stream iniciado: ${this.streamSid}`);
                // Room tone (si está activado por env): arranca con el stream.
                this.iniciarAmbiente();
                break;
            case "media":
                if (mensaje.media?.payload)
                    this.realtime.enviarAudio(mensaje.media.payload);
                break;
            case "stop":
                console.log("[TWILIO] Stream detenido");
                this.finalizarLlamada();
                break;
        }
    }
    enviarAudioTwilio(base64Audio) {
        if (this.ws.readyState === ws_1.default.OPEN && this.streamSid) {
            this.ws.send(JSON.stringify({
                event: "media",
                streamSid: this.streamSid,
                media: { payload: base64Audio },
            }));
        }
    }
    limpiarAudioTwilio() {
        if (this.ws.readyState === ws_1.default.OPEN && this.streamSid) {
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
    finalizada = false;
    /** Cierre por caída/cierre del WS SIN evento "stop" previo. BUG visto en
     *  producción: cuando colgar_llamada fallaba con Twilio y cerrábamos el WS
     *  nosotros, "stop" jamás llegaba → la llamada NO se guardaba (sin
     *  transcripción, sin nombre, sin créditos). Ahora cualquier final llega a
     *  finalizarLlamada exactamente una vez. */
    finalizarPorCierreDeSocket() {
        if (this.finalizada)
            return;
        console.warn("[PIPELINE] WS cerrado sin evento stop → finalizando llamada igual");
        this.finalizarLlamada().catch((e) => console.error("[PIPELINE] Error finalizando por cierre de socket:", e));
    }
    async finalizarLlamada() {
        if (this.finalizada)
            return;
        this.finalizada = true;
        this.detenerTecleo();
        this.detenerAmbiente();
        this.realtime.cerrar();
        if (!this.llamadaAutorizada)
            return;
        const duracionSegundos = Math.round((Date.now() - this.inicioLlamada) / 1000);
        const historial = this.historialOrdenado
            .filter((t) => !t.pending && t.content.trim().length > 0)
            .map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.content }));
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
        console.log(`[PIPELINE] Costo voz — OpenAI $${costoUsd} (realtime $${usoVoz.costoUsd.toFixed(6)} + whisper $${costoWhisper.toFixed(6)}) · Twilio ~$${costoTwilioAprox} · tokens`, usoVoz);
        console.log(`[PIPELINE] Llamada finalizada — ${duracionSegundos}s, ${this.turnos} turnos`);
        console.log(`[PIPELINE] Enviando ${historial.length} mensajes a Odin`);
        if (historial.length > 0)
            console.log("[PIPELINE] Historial:\n" + transcripcion);
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
                const resp = await fetch(`${config_1.config.odinAppUrl}/api/webhooks/voice`, {
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
                if (resp.status >= 400 && resp.status < 500)
                    return;
            }
            catch (err) {
                console.warn(`[PIPELINE] Webhook Odin falló (intento ${intento}/${ESPERAS_MS.length}):`, err?.message || err);
            }
        }
        console.error(`[PIPELINE] Webhook Odin AGOTÓ reintentos — llamada ${this.callSid} sin registrar`);
    }
}
exports.PipelineLlamada = PipelineLlamada;
//# sourceMappingURL=llamada.js.map