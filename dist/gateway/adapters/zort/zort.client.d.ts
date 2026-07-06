export interface ZortCredentials {
    storename: string;
    apikey: string;
    apisecret: string;
    baseUrl?: string;
}
export declare const zortClient: {
    get: <T>(creds: ZortCredentials, path: string, params?: Record<string, string>) => Promise<T>;
    postParams: <T>(creds: ZortCredentials, path: string, params: Record<string, string>) => Promise<T>;
    post: <T>(creds: ZortCredentials, path: string, body: unknown) => Promise<T>;
};
//# sourceMappingURL=zort.client.d.ts.map