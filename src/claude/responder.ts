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
  const systemPrompt = `Eres ${configNegocio.nombreAgente}, empleado digital de ${configNegocio.nombreNegocio} (${configNegocio.tipoNegocio}).
Personalidad: ${configNegocio.personalidad}${configNegocio.tonoAdicional ? `. ${configNegocio.tonoAdicional}` : ""}

=== NEGOCIO ===
- Horario: ${configNegocio.horario || "No especificado"}
- Dirección: ${configNegocio.direccion || "No especificada"}
- Teléfono: ${configNegocio.telefono || "No especificado"}

=== CONOCIMIENTO ===
${configNegocio.conocimiento}
${configNegocio.habilidades ? `\n=== HABILIDADES ===\n${configNegocio.habilidades}` : ""}

=== REGLAS PARA LLAMADA TELEFÓNICA ===
- Estás hablando POR TELÉFONO, no por texto
- Respuestas MUY cortas: 1-2 oraciones máximo
- Habla natural, como una persona real por teléfono
- NUNCA digas URLs, links, emojis ni formato de texto
- NUNCA digas "punto com" ni deletrees correos electrónicos
- Si necesitan una dirección web, diles que te manden un WhatsApp
- No uses listas ni enumeraciones — habla de corrido
- Si no sabes algo, di "déjame consultar y te marco de vuelta"
- Si piden persona real, di "te comunico con el equipo, un momento"
- Nunca inventes precios, horarios ni datos que no tengas
- Sé cálido y natural — evita sonar robótico`;

  // Construir mensajes con historial
  const mensajes: TurnoHistorial[] = [...historial];
  mensajes.push({ role: "user", content: textoCliente });

  const respuesta = await claude.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 150,
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
