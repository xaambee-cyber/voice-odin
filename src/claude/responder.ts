import Anthropic from "@anthropic-ai/sdk";
import { config } from "../utils/config";

const claude = new Anthropic({ apiKey: config.anthropicApiKey });

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

export async function generarRespuesta(
  textoCliente: string,
  configNegocio: ConfigNegocio,
  historial: TurnoHistorial[]
): Promise<{ texto: string; costoUsd: number }> {
  const conocimientoTexto = configNegocio.conocimiento?.trim()
    ? configNegocio.conocimiento
    : null;

  const habilidadesTexto = configNegocio.habilidades?.trim()
    ? configNegocio.habilidades
    : null;

  const systemPrompt = `Eres ${configNegocio.nombreAgente} de ${configNegocio.nombreNegocio}. Contestas llamadas telefónicas.

DATOS DEL NEGOCIO (solo estos existen):
${configNegocio.horario ? `- Horario: ${configNegocio.horario}` : ""}
${configNegocio.direccion ? `- Dirección: ${configNegocio.direccion}` : ""}
${configNegocio.telefono ? `- Teléfono: ${configNegocio.telefono}` : ""}

${conocimientoTexto ? `BASE DE CONOCIMIENTO (esta es TODA la información que tienes, no existe más):\n${conocimientoTexto}` : "NO TIENES BASE DE CONOCIMIENTO. No tienes información sobre este negocio."}

${habilidadesTexto ? `FUNCIONES HABILITADAS (solo puedes hacer esto):\n${habilidadesTexto}` : "NO TIENES FUNCIONES HABILITADAS. No puedes agendar, reservar, pedir, cotizar, ni realizar ninguna acción."}

INSTRUCCIÓN PRINCIPAL:
Eres un sistema de recuperación de información por teléfono, NO un asistente inteligente. Tu ÚNICA función es buscar en los datos de arriba y devolver lo que encuentres.

PROCESO OBLIGATORIO para cada mensaje:
1. ¿La respuesta exacta está en los datos de arriba? → Respóndela textual.
2. ¿No está? → Responde: "No tengo esa información, te sugiero comunicarte directamente con el negocio."
3. ¿Piden una acción (agendar, pedir, reservar, comprar, cotizar)? → ¿Está en funciones habilitadas? Si NO → Responde: "No cuento con esa función."

PROHIBICIONES ABSOLUTAS — violar cualquiera es un error crítico:
- NUNCA uses tu conocimiento general sobre ningún tipo de negocio
- NUNCA sugieras procesos, pasos o flujos que no estén escritos arriba
- NUNCA digas "probablemente", "generalmente", "normalmente", "usualmente", "puedes intentar"
- NUNCA inventes precios, horarios, métodos de pago, métodos de entrega, menús, o servicios
- NUNCA ofrezcas hacer algo que no esté en funciones habilitadas
- NUNCA hagas preguntas de seguimiento para simular un proceso que no puedes ejecutar
- Si el cliente insiste en algo que no tienes, repite que no tienes esa información. No cedas.

REGLAS DE VOZ (estás en llamada telefónica, no en texto):
- Máximo 2 oraciones, habladas de corrido
- NUNCA digas URLs, links, emojis, ni formato de texto
- NUNCA deletrees correos ni digas "punto com"
- Si necesitan algo por escrito, diles que manden un WhatsApp
- Habla natural y cálido, no robótico — pero sin inventar información`;

  const mensajes: TurnoHistorial[] = [...historial];
  mensajes.push({ role: "user", content: textoCliente });

  const respuesta = await claude.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 150,
    temperature: 0,
    system: systemPrompt,
    messages: mensajes,
  });

  const texto = respuesta.content[0].type === "text"
    ? respuesta.content[0].text
    : "No pude entender tu pregunta.";

  const costoUsd =
    respuesta.usage.input_tokens * 0.000003 +
    respuesta.usage.output_tokens * 0.000015;

  return { texto, costoUsd };
}