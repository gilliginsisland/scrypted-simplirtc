import { z } from 'zod';

export class TemplateUrl {
    readonly #url: URL;
    readonly #keys: readonly string[];

    constructor(private readonly template: string) {
        const match = /\{[?&]([^}]*)\}$/.exec(template);
        this.#url = new URL(match ? template.slice(0, match.index) : template);
        this.#keys = match?.[1].split(',') ?? [];
    }

    keys(): string[] {
        return [...this.#keys];
    }

    render(values: Readonly<Record<string, string | number | boolean | undefined>> = {}): URL {
        const url = new URL(this.#url);
        for (const [key, value] of Object.entries(values)) {
            if (value !== undefined)
                url.searchParams.set(key, value.toString());
        }
        return url;
    }

    toString(): string {
        return this.template;
    }
}

export const simpliSafeMediaSchema = z.looseObject({
    href: z.string().url(),
});
export type SimpliSafeMedia = z.output<typeof simpliSafeMediaSchema>;
