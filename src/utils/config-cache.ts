import type { ConfigNegocio } from "../pipeline/llamada";

// Cache local de configs de negocio en el voice server. Cuando un cliente
// llama, en lugar de hacer fetch a Vercel (~700-1100ms cold/warm), leemos
// el cache local (instantáneo).
//
// TTL 5 minutos: si el dueño cambia conocimiento, voz, etc. en Odin, los
// cambios se ven en la próxima llamada que entre después del TTL. Es un
// trade-off razonable para ganar 700-1100ms en cada saludo.

interface Entrada {
  config: ConfigNegocio;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;

// Indexado por dos claves para soportar ambos modos de lookup:
// - "tw:+15086257292"   → cuando llega lookup por número Twilio
// - "id:cc019960-..."   → cuando llega lookup por negocioId
const cache = new Map<string, Entrada>();

function clavesPara(config: ConfigNegocio, numeroTwilio?: string): string[] {
  const claves: string[] = [];
  if (config.negocioId) claves.push(`id:${config.negocioId}`);
  if (numeroTwilio) claves.push(`tw:${numeroTwilio}`);
  return claves;
}

export function obtenerCache(numeroTwilio: string, negocioId: string): ConfigNegocio | null {
  const ahora = Date.now();
  const candidatos = [
    numeroTwilio ? `tw:${numeroTwilio}` : "",
    negocioId ? `id:${negocioId}` : "",
  ].filter(Boolean);

  for (const clave of candidatos) {
    const entrada = cache.get(clave);
    if (entrada && entrada.expiresAt > ahora) {
      return entrada.config;
    }
    if (entrada && entrada.expiresAt <= ahora) {
      cache.delete(clave); // expirada
    }
  }
  return null;
}

export function guardarEnCache(config: ConfigNegocio, numeroTwilio?: string): void {
  const expiresAt = Date.now() + TTL_MS;
  const entrada: Entrada = { config, expiresAt };
  for (const clave of clavesPara(config, numeroTwilio)) {
    cache.set(clave, entrada);
  }
}

// Forzar invalidación (usado cuando Odin notifica un cambio)
export function invalidarCache(numeroTwilio?: string, negocioId?: string): void {
  if (numeroTwilio) cache.delete(`tw:${numeroTwilio}`);
  if (negocioId) cache.delete(`id:${negocioId}`);
}

export function tamanoCache(): number {
  return cache.size;
}
