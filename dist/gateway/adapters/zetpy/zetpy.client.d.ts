export interface ZetpyCredentials {
    email: string;
    password: string;
}
export declare const zetpyClient: {
    get: <T>(creds: ZetpyCredentials, path: string, params?: Record<string, string>) => Promise<T>;
    post: <T>(creds: ZetpyCredentials, path: string, body: unknown) => Promise<T>;
    clearTokenCache: () => void;
};
//# sourceMappingURL=zetpy.client.d.ts.map