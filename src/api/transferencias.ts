// ═══════════════════════════════════════════════════════════════════════════
// REGISTRO DE TRANSFERENCIAS EN VUELO
//
// Cuando el agente pasa una llamada a un humano, Twilio reemplaza el TwiML por
// un <Dial>. Eso cierra el media stream: el PipelineLlamada se finaliza y cobra
// solo el tramo con IA. Pero la llamada SIGUE VIVA — Twilio factura la pierna
// entrante del cliente ($0.0100/min) y la saliente al receptor ($0.0473/min)
// hasta que el humano cuelgue. Antes ese tramo no se cobraba a nadie.
//
// El <Dial> ahora lleva un `action`; cuando termina, Twilio pega a
// /transferencia-fin con DialCallDuration. Este mapa es lo que conecta ese
// callback con la llamada que lo originó: si el callSid no está aquí, la
// petición no salió de una transferencia nuestra y se ignora (protege contra
// requests forjados sin tener que validar la firma de Twilio detrás de Traefik).
//
// Es memoria de proceso a propósito: si el server reinicia a media transferencia
// se pierde el cobro de ese tramo. Falla a favor del cliente, que es el lado
// correcto para fallar.
// ═══════════════════════════════════════════════════════════════════════════

export interface TransferenciaActiva {
  callSid: string;
  negocioId: string;
  destino: string;
  inicioMs: number;
}

const activas = new Map<string, TransferenciaActiva>();

// Una transferencia que nunca recibió su callback (Twilio no pegó, la llamada
// murió raro) se queda colgada en el mapa. Se purgan a las 6 h — muy por encima
// de cualquier llamada real, así que nunca borra una viva.
const TTL_MS = 6 * 60 * 60 * 1000;

export function registrarTransferencia(t: TransferenciaActiva): void {
  activas.set(t.callSid, t);
}

/**
 * Devuelve la transferencia y la SACA del mapa (one-shot). Un segundo callback
 * con el mismo callSid — reintento de Twilio, request forjado — devuelve null y
 * no llega a cobrar. Odin dedupea aparte por `transferencia_segundos`.
 */
export function tomarTransferencia(callSid: string): TransferenciaActiva | null {
  const t = activas.get(callSid);
  if (!t) return null;
  activas.delete(callSid);
  return t;
}

export function purgarTransferenciasViejas(): void {
  const limite = Date.now() - TTL_MS;
  for (const [callSid, t] of activas) {
    if (t.inicioMs < limite) {
      console.warn(`[TRANSFER] Purgando transferencia sin callback: ${callSid}`);
      activas.delete(callSid);
    }
  }
}

export function transferenciasActivas(): number {
  return activas.size;
}
