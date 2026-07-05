export interface ZetpyCredentials {
    apiKey: string;
}
export declare const zetpyClient: {
    get: <T>(creds: ZetpyCredentials, path: string, params?: Record<string, string>) => Promise<T>;
    post: <T>(creds: ZetpyCredentials, path: string, body: unknown) => Promise<T>;
};
//# sourceMappingURL=zetpy.client.d.ts.map