// ═══════════════════════════════════════════════════════════════════════════
// SONIDOS PROCEDURALES para la llamada (μ-law 8kHz, formato Twilio).
//
// Efecto "recepcionista real": mientras el agente espera el resultado de una
// herramienta lenta (verificar agenda, crear reserva), en vez de silencio
// muerto se escucha un TECLEO suave — como si la recepcionista estuviera
// buscando en su computadora. Retell lo ofrece como feature premium; aquí lo
// generamos por código (sin samples, sin copyright, $0).
//
// También hay un "room tone" (ruido de sala muy tenue) opcional para matar el
// silencio digital absoluto que delata a los bots. Va detrás de un flag
// (AMBIENTE_LLAMADA=on) hasta validarlo con el oído — el tecleo sí va por
// default porque suena en ventanas cortas y controladas.
//
// Todo se PRE-GENERA al cargar el módulo: en llamada solo se hace shift de un
// arreglo de frames base64 (0 CPU en caliente).
// ═══════════════════════════════════════════════════════════════════════════

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20 ms por frame (el estándar de Twilio Media Streams)

// ── G.711 μ-law ─────────────────────────────────────────────────────────────
// Codificación estándar PCM lineal 16-bit → μ-law 8-bit (misma que usa Twilio).
function linearAMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    /* buscar el bit más alto */
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// PCM Int16Array → frames base64 de 160 bytes μ-law (20 ms c/u).
function pcmAFrames(pcm: Int16Array): string[] {
  const frames: string[] = [];
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
    const bytes = Buffer.alloc(FRAME_SAMPLES);
    for (let j = 0; j < FRAME_SAMPLES; j++) bytes[j] = linearAMulaw(pcm[i + j]);
    frames.push(bytes.toString("base64"));
  }
  return frames;
}

// RNG determinista (mulberry32): mismos sonidos en cada arranque del server,
// útil para depurar («¿cambió el tecleo?» → no, es idéntico byte a byte).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── TECLEO ──────────────────────────────────────────────────────────────────
// Cada tecla = golpe de ruido con ataque instantáneo y caída exponencial
// (~8-14 ms), con énfasis en agudos (diferencia de ruido blanco ≈ high-pass:
// el "clac" plástico del teclado). Ritmo de mecanografía real: ráfagas de
// 3-7 teclas con micro-pausas, pausa de "pensar" de vez en cuando y algún
// golpe doble. Amplitud moderada: se OYE pero no compite con la voz.
function generarTecleo(durSegundos: number, seed: number): Int16Array {
  const rand = rng(seed);
  const total = Math.floor(durSegundos * SAMPLE_RATE);
  const pcm = new Int16Array(total); // silencio por default

  const AMP_BASE = 5200; // ~-16 dBFS pico: presente pero discreto

  let t = Math.floor(0.08 * SAMPLE_RATE); // primer golpe casi de inmediato
  let teclasEnRafaga = 0;
  let rafagaObjetivo = 3 + Math.floor(rand() * 5); // 3-7 teclas por ráfaga

  while (t < total - 200) {
    // Un golpe de tecla
    const durGolpe = Math.floor((0.008 + rand() * 0.006) * SAMPLE_RATE); // 8-14 ms
    const amp = AMP_BASE * (0.55 + rand() * 0.45); // variación humana
    let prev = 0;
    for (let i = 0; i < durGolpe && t + i < total; i++) {
      const blanco = rand() * 2 - 1;
      const agudo = blanco - prev; // diferenciador ≈ high-pass (clac plástico)
      prev = blanco;
      const envolvente = Math.exp((-5.5 * i) / durGolpe);
      pcm[t + i] += Math.round(agudo * envolvente * amp);
    }
    teclasEnRafaga++;

    if (teclasEnRafaga >= rafagaObjetivo) {
      // Pausa de "leer/pensar": 260-700 ms
      t += Math.floor((0.26 + rand() * 0.44) * SAMPLE_RATE);
      teclasEnRafaga = 0;
      rafagaObjetivo = 3 + Math.floor(rand() * 5);
    } else {
      // Gap entre teclas de la ráfaga: 55-150 ms (mecanógrafa ágil)
      t += Math.floor((0.055 + rand() * 0.095) * SAMPLE_RATE);
      // Golpe doble ocasional (tecla + espacio) — 18% de las veces
      if (rand() < 0.18) t -= Math.floor(0.03 * SAMPLE_RATE);
    }
  }
  return pcm;
}

// ── ROOM TONE ───────────────────────────────────────────────────────────────
// Ruido rosa aproximado (filtro Voss simplificado sobre ruido blanco) con una
// modulación MUY lenta de amplitud, a nivel casi subliminal (~-42 dBFS). Es el
// "aire" de una oficina; mata el silencio digital absoluto entre frases.
function generarAmbiente(durSegundos: number, seed: number): Int16Array {
  const rand = rng(seed);
  const total = Math.floor(durSegundos * SAMPLE_RATE);
  const pcm = new Int16Array(total);
  const AMP = 260; // ~-42 dBFS: presencia, no ruido molesto
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < total; i++) {
    const blanco = rand() * 2 - 1;
    // Aproximación de ruido rosa (Paul Kellet, versión económica)
    b0 = 0.99765 * b0 + blanco * 0.099046;
    b1 = 0.963 * b1 + blanco * 0.2965164;
    b2 = 0.57 * b2 + blanco * 1.0526913;
    const rosa = (b0 + b1 + b2 + blanco * 0.1848) * 0.18;
    // Respiración lenta de la sala (periodo ~7 s)
    const mod = 0.85 + 0.15 * Math.sin((2 * Math.PI * i) / (7 * SAMPLE_RATE));
    pcm[i] = Math.round(rosa * AMP * mod);
  }
  return pcm;
}

// ── Frames pre-generados (se calculan UNA vez al cargar el módulo) ──────────
// 6 s de tecleo y 8 s de ambiente; en reproducción se recorren en loop.
export const FRAMES_TECLEO: string[] = pcmAFrames(generarTecleo(6, 20260717));
export const FRAMES_AMBIENTE: string[] = pcmAFrames(generarAmbiente(8, 999331));

export const MS_POR_FRAME = 20;

/** Flag del room tone: apagado por default hasta validarlo con el oído.
 *  Activar con AMBIENTE_LLAMADA=on en el env del voice server. */
export const AMBIENTE_ACTIVO = (process.env.AMBIENTE_LLAMADA || "").toLowerCase() === "on";
