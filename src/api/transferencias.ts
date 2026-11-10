// ═══════════════════════════════════════════════════════════════════════════
// REGISTRO DE TRANSFERENCIAS EN VUELO
//
// Cuando el agente pasa una llamada a un humano, Twilio reemplaza el TwiML por
// un <Dial>. Eso cierra el media stream: el PipelineLlamada se finaliza y cobra
// solo el tramo con IA. Pero la llamada SIGUE VIVA — Twilio factura la pierna
// entrante del cliente ($0.0100/min) y la saliente al receptor ($0.0473/min)
// hasta que el humano cuelgue. Antes ese tramo no se cobraba a nadie.
//
// Al terminar la pierna humana, Twilio manda un statusCallback firmado a
// /transferencia-estado. Este mapa lo liga a la llamada que lo originó.
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
 * Devuelve la transferencia y la saca del mapa. Un reintento de Twilio
 * devuelve null; Odin dedupea aparte por `transferencia_segundos`.
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
