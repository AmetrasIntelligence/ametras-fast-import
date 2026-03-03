interface OdooSession {
    baseUrl: string;
    db: string;
    uid: number;
    sessionId: string;
    serverVersion: string;
    lastActivity: number;
    createdAt: number;
}
export declare function getSession(baseUrl: string, db?: string): OdooSession | undefined;
export declare function clearSessions(): void;
/**
 * Cleanup on app quit - clear all sessions and stop interval.
 */
export declare function shutdownSessions(): void;
export {};
