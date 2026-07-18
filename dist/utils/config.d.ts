export declare const config: {
    twilioAccountSid: string;
    twilioAuthToken: string;
    twilioPhoneNumber: string;
    deepgramApiKey: string;
    anthropicApiKey: string;
    openaiApiKey: string;
    odinAppUrl: string;
    voiceServerSecret: string;
    port: number;
    voiceServerUrl: string;
};
/**
 * Base HTTPS pública de este server, derivada de VOICE_SERVER_URL (que viene en
 * wss://). Twilio la necesita para los callbacks que ejecuta él mismo — hoy el
 * `statusCallback` del <Number> de las transferencias a humano.
 */
export declare function urlPublicaHttps(): string;
//# sourceMappingURL=config.d.ts.map