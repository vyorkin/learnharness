/**
 * The opening message rides beside the navigation, never in the URL.
 *
 * Home and the new-session draft used to push `/chat/<id>?prompt=<text>`.
 * Node's default max HTTP header size is 16KB. A long paste (a syllabus)
 * makes that GET return 431, and Electron commits an empty document: the
 * window stays the native background and looks frozen. The chat record
 * already exists, with an empty transcript, because POST /api/chats
 * succeeded first.
 *
 * sessionStorage holds the trimmed text under `lh.openingPrompt.<id>`.
 * The push target stays `/chat/<id>`. The chat page still honors a
 * `?prompt=` search param for an old link; when that param is absent it
 * reads this stash and sends it once. The stash survives until that send
 * resolves, so a reload before the POST lands can retry. Absent storage
 * (node tests, a thrown access) is a no-op — the short path still returns.
 */

const keyFor = (id: string) => `lh.openingPrompt.${id}`;

function store(): Storage | null {
	try {
		if (typeof sessionStorage === "undefined" || sessionStorage == null) return null;
		return sessionStorage;
	} catch {
		return null;
	}
}

export function stashOpeningPrompt(id: string, text: string): void {
	store()?.setItem(keyFor(id), text);
}

export function readOpeningPrompt(id: string): string | undefined {
	const value = store()?.getItem(keyFor(id));
	return value && value.length > 0 ? value : undefined;
}

export function clearOpeningPrompt(id: string): void {
	store()?.removeItem(keyFor(id));
}
