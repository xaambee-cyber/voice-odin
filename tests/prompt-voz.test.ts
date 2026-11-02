import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  calendarioVoz,
  construirHerramientas,
  esSinCreditoOpenAI,
  horarioCompacto,
  resolverCitaId,
  resolverServicioId,
  type ConfigNegocio,
} from "../src/pipeline/llamada";

const UUID_LIMPIEZA = "fe3bccb8-2214-48e9-8153-9929509b5bcf";
const UUID_CONSULTA = "7fcdec54-ad3c-4891-ab4d-8db26a878996";

// Un consultorio como Dentinova: motores, agenda y escalamiento, sin
// profesionales ni tools de motor.
function consultorio(extra: Partial<ConfigNegocio> = {}): ConfigNegocio {
  return {
    nombreAgente: "Laila",
    personalidad: "profesional",
    nombreNegocio: "Dentinova",
    tipoNegocio: "clínica dental",
    conocimiento: "• Atendemos urgencias.",
    habilidades: "agenda_citas, escalamiento",
    habilidadesActivas: { agenda_citas: true, escalamiento: true, aprendizaje: true },
    zonaHoraria: "America/Mexico_City",
    horario: "Domingo 07:00–19:00, Lunes 07:00–19:00",
    horarioDetallado: [1, 2, 3, 4, 5].map((d) => ({ diaSemana: d, horaInicio: "07:00", horaFin: "19:00" }))
      .concat([{ diaSemana: 6, horaInicio: "07:00", horaFin: "14:00" }]),
    servicios: [
      { id: UUID_CONSULTA, nombre: "Consulta Diagnóstica", duracionMinutos: 60, precio: 650 },
      { id: UUID_LIMPIEZA, nombre: "Limpieza dental", duracionMinutos: 60, precio: 800 },
    ],
    ofertaTexto: "- Consulta Diagnóstica: $650 MXN\n- Limpieza dental: $800 MXN",
    citasCliente: [{ id: "cita-real-1", servicio: "Limpieza dental", fechaInicio: "lunes 2 de noviembre, 3:00 p.m.", estado: "agendada" }],
    direccion: "Darío Vargas 39",
    nichoPromptBloque: "CAPACIDAD — CITA POR TURNO:\nUsa la función agendar_cita.",
    nichoBloqueParaVoz: true,
    ...extra,
  };
}

test("horario compacto: agrupa días iguales y dice los cerrados", () => {
  assert.equal(
    horarioCompacto(consultorio().horarioDetallado!),
    "lunes a viernes de 7:00 a.m. a 7:00 p.m.; sábado de 7:00 a.m. a 2:00 p.m.; domingo cerrado",
  );
});

test("calendario: el día de la semana sale de la fecha real, no se calcula", () => {
  // 1-nov-2026 es domingo; a las 3 a.m. UTC en CDMX todavía es 31 de octubre.
  const cal = calendarioVoz(new Date("2026-11-01T20:00:00Z"), "America/Mexico_City", 3);
  assert.equal(cal, "domingo 1 nov=2026-11-01 (hoy), lunes 2 nov=2026-11-02, martes 3 nov=2026-11-03");
  assert.match(calendarioVoz(new Date("2026-11-01T03:00:00Z"), "America/Mexico_City", 1), /^sábado 31 oct=2026-10-31/);
});

test("IDs cortos: s1/c1 se traducen al id real y un id real pasa tal cual", () => {
  const cfg = consultorio();
  assert.equal(resolverServicioId(cfg, "s2"), UUID_LIMPIEZA);
  assert.equal(resolverServicioId(cfg, UUID_CONSULTA), UUID_CONSULTA);
  assert.equal(resolverCitaId(cfg, "c1"), "cita-real-1");
  assert.equal(resolverCitaId(cfg, "c9"), "c9"); // no existe: Odin contesta 404, no se inventa
});

test("la voz puede consultar disponibilidad cuando agenda", () => {
  const nombres = construirHerramientas(consultorio(), { silencioso: true }).map((h) => h.name);
  assert.ok(nombres.includes("consultar_disponibilidad"));
  assert.ok(nombres.includes("agendar_cita"));
  const sinAgenda = construirHerramientas(
    consultorio({ habilidades: "", habilidadesActivas: { agenda_citas: false, escalamiento: false, aprendizaje: true } }),
    { silencioso: true },
  ).map((h) => h.name);
  assert.ok(!sinAgenda.includes("consultar_disponibilidad"));
});

test("sin profesionales no se declara el parámetro profesional", () => {
  const agendar = construirHerramientas(consultorio(), { silencioso: true }).find((h) => h.name === "agendar_cita")!;
  assert.equal(agendar.parameters.properties.profesional, undefined);
  const conProf = construirHerramientas(
    consultorio({ profesionales: [{ id: "r1", nombre: "Dra. Ana", atiendeTodosServicios: true, servicioIds: [] }] }),
    { silencioso: true },
  ).find((h) => h.name === "agendar_cita")!;
  assert.ok(conProf.parameters.properties.profesional);
});

test("el prompt ya no se contradice ni empuja a negar acciones", () => {
  const p = buildSystemPrompt(consultorio());
  // Lo que hizo decir "no cuento con esa función para revisar disponibilidad".
  assert.ok(!p.includes("FUNCIONES HABILITADAS"));
  assert.ok(!p.includes("No cuento con esa función"));
  assert.ok(!p.includes("valida esa hora agendando"));
  assert.match(p, /consultar_disponibilidad/);
  // Un solo horario: el de la tabla, no el texto libre que decía otra cosa.
  assert.ok(!p.includes("Domingo 07:00–19:00"));
  assert.equal((p.match(/de 7:00 a\.m\. a 7:00 p\.m\./g) || []).length, 1);
  // IDs cortos, no UUIDs, y el calendario al final.
  assert.ok(!p.includes(UUID_LIMPIEZA));
  assert.match(p, /\[ID:s2\]/);
  assert.match(p, /\[ID:c1\] Limpieza dental/);
  assert.ok(p.indexOf("CALENDARIO (copia") > p.indexOf("=== CONTEXTO DE ESTA LLAMADA ==="));
});

test("el prefijo estable no cambia entre llamadas del mismo negocio (caché)", () => {
  const a = buildSystemPrompt(consultorio());
  const b = buildSystemPrompt(consultorio({ citasCliente: [] }));
  const corte = (s: string) => s.slice(0, s.indexOf("=== CONTEXTO DE ESTA LLAMADA ==="));
  assert.equal(corte(a), corte(b));
});

test("un bloque de giro en versión chat se traduce aunque no haya tools de motor", () => {
  const legado = buildSystemPrompt(consultorio({
    nichoBloqueParaVoz: undefined,
    nichoPromptBloque: "Usa el marcador [AGENDAR_CITA] de la sección de citas.",
  }));
  assert.match(legado, /POR TELÉFONO NO HAY MARCADORES/);
  assert.match(legado, /\[AGENDAR_CITA\] = agendar_cita/);
  assert.ok(!buildSystemPrompt(consultorio()).includes("POR TELÉFONO NO HAY MARCADORES"));
});

test("OpenAI sin crédito se reconoce en cada forma en que llega (y un rate limit no)", () => {
  // Las tres formas reales del log del 1-nov: el evento "error", el motivo del
  // cierre y el mensaje con que falla la conexión.
  assert.ok(esSinCreditoOpenAI('{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining."}'));
  assert.ok(esSinCreditoOpenAI("1013 insufficient_quota.credit_balance_exhausted"));
  assert.ok(esSinCreditoOpenAI("WS cerrado antes de session.created (code 1013 insufficient_quota.credit_balance_exhausted)"));
  assert.ok(!esSinCreditoOpenAI('{"type":"rate_limit_exceeded"}'));
});
