export class Extension {
    getSettings(): never {
        throw new Error('getSettings() must be mocked by the test');
    }
}

export function gettext(message: string): string {
    return message;
}
