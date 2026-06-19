"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pcmToMulaw = pcmToMulaw;
exports.base64ToBuffer = base64ToBuffer;
exports.bufferToBase64 = bufferToBase64;
// Tabla de conversión linear16 → mulaw
const MULAW_MAX = 0x1fff;
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
function linearToMulaw(sample) {
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0)
        sample = -sample;
    if (sample > MULAW_CLIP)
        sample = MULAW_CLIP;
    sample += MULAW_BIAS;
    let exponent = 7;
    let mask = 0x4000;
    for (; exponent > 0; exponent--) {
        if ((sample & mask) !== 0)
            break;
        mask >>= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
    return mulawByte;
}
// Convertir buffer PCM linear16 a mulaw 8kHz (lo que Twilio espera)
function pcmToMulaw(pcmBuffer) {
    const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
    for (let i = 0; i < pcmBuffer.length; i += 2) {
        const sample = pcmBuffer.readInt16LE(i);
        mulawBuffer[i / 2] = linearToMulaw(sample);
    }
    return mulawBuffer;
}
// Convertir base64 mulaw audio a Buffer
function base64ToBuffer(base64) {
    return Buffer.from(base64, "base64");
}
// Convertir Buffer a base64
function bufferToBase64(buffer) {
    return buffer.toString("base64");
}
//# sourceMappingURL=audio.js.map