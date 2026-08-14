export class QuickToggle {
    initializationProperties: Record<string, unknown> = {};
    destroyed = false;

    _init(properties: Record<string, unknown> = {}): void {
        this.initializationProperties = properties;
    }

    destroy(): void {
        this.destroyed = true;
    }
}

export class SystemIndicator {
    quickSettingsItems: QuickToggle[] = [];
    destroyed = false;

    _init(): void {
        this.quickSettingsItems = [];
    }

    destroy(): void {
        this.destroyed = true;
    }
}
