export function errorMessage(error: unknown): string {
    if (error instanceof Error)
        return error.message;

    if (typeof error === 'object' && error !== null && 'message' in error)
        return String(error.message);

    return String(error);
}

function errorDetails(error: unknown): string {
    return error instanceof Error && error.stack
        ? error.stack
        : errorMessage(error);
}

export function logError(context: string, error: unknown): void {
    console.error(`[BatteryBoost] ${context}: ${errorDetails(error)}`);
}

export function logDebug(context: string, error: unknown): void {
    console.debug(`[BatteryBoost] ${context}: ${errorDetails(error)}`);
}
