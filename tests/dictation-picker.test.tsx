import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { setDictationActive } from "../components/dictation-state.ts";
import { DICTATION_LANGUAGES, type UserSettings } from "../src/core/index.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const byTest = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const trigger = () => byTest("dictation-language");
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Search dictation languages"]')!;
const menu = () => document.querySelector('[data-testid="dictation-language-menu"]');
const click = async (element: HTMLElement) => { assert(element); await act(async () => { element.click(); }); };
async function key(element: HTMLElement, value: string) {
	await act(async () => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: value });
		element.dispatchEvent(event);
	});
}
async function search(value: string) {
	await act(async () => {
		const element = input();
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

async function fixture(failRead = false) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	Object.assign(doc, { oninput: null });
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.scrollIntoView = () => {};
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30, x: 400, y: 200, toJSON() {} });
	const state = {
		record: { version: 1, dictation: { language: "en" } } as UserSettings,
		writes: [] as string[], failWrite: false, outerEscapes: 0,
		failRead,
		nextWrite: undefined as Promise<Response> | undefined,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return state.failRead ? Response.json({}, { status: 500 }) : Response.json({ settings: state.record });
			assert.equal(url, "/api/settings/dictation");
			const body = JSON.parse(init!.body as string);
			state.writes.push(body.language);
			if (state.nextWrite) { const next = state.nextWrite; state.nextWrite = undefined; return next; }
			if (state.failWrite) return Response.json({}, { status: 500 });
			state.record = { ...state.record, dictation: body };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	// Register the outer dialog listener first: one Escape must close only
	// the language menu, even when the settings dialog owns another listener.
	doc.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") state.outerEscapes++; });
	const { createRoot } = await import("react-dom/client");
	const { DictationLanguageSetting } = await import("../components/dictation-language.tsx");
	let root = createRoot(doc.getElementById("root")!);
	const mount = async () => { await act(async () => { root.render(<DictationLanguageSetting />); }); };
	dispose = async () => { await act(async () => { setDictationActive(false); root.unmount(); }); };
	await mount();
	return { state, remount: async () => { await dispose!(); root = createRoot(doc.getElementById("root")!); await mount(); } };
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("an initial load failure is visible and opening the menu again can retry", async () => {
	const f = await fixture(true);
	await click(trigger());
	assert.match(menu()!.querySelector('[role="alert"]')!.textContent!, /Could not load/);
	f.state.failRead = false;
	await click(trigger());
	await click(trigger());
	assert.equal(menu()!.querySelector('[role="alert"]'), null);
	await search("Polish");
	await key(input(), "Enter");
	assert.match(trigger().textContent!, /Polish/);
});

test("the real picker searches by language, chooses with Arrow/Enter, and restores focus", async () => {
	const f = await fixture();
	assert.match(trigger().textContent!, /English/);
	assert.equal(trigger().getAttribute("data-variant"), "outline");
	await click(trigger());
	assert.equal(input().getAttribute("data-slot"), "input");
	assert.equal(input().getAttribute("role"), "combobox");
	assert.equal(document.activeElement, input());
	assert.equal(document.querySelector("[cmdk-item]")!.textContent, "Multilingual");
	await search("Polish");
	assert.equal(document.querySelectorAll("[cmdk-item]").length, 1);
	await key(input(), "ArrowDown");
	await key(input(), "Enter");
	assert.deepEqual(f.state.writes, ["pl"]);
	assert.match(trigger().textContent!, /Polish/);
	assert.equal(menu(), null);
	assert.equal(document.activeElement, trigger());
	await f.remount();
	assert.match(trigger().textContent!, /Polish/);
});

test("empty results cannot save; Escape and outside click close the menu without closing settings", async () => {
	const f = await fixture();
	await click(trigger());
	await search("zzzz-no-language");
	assert.match(document.querySelector("[cmdk-empty]")!.textContent!, /No languages match/);
	await key(input(), "Enter");
	assert.deepEqual(f.state.writes, []);
	await key(input(), "Escape");
	assert.equal(menu(), null);
	assert.equal(f.state.outerEscapes, 0);
	await click(trigger());
	await key(trigger(), "Escape");
	assert.equal(menu(), null);
	assert.equal(f.state.outerEscapes, 0);
	await click(trigger());
	await act(async () => { document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); });
	assert.equal(menu(), null);
});

test("failed saves retain the confirmed choice and the same menu can retry", async () => {
	const f = await fixture();
	f.state.failWrite = true;
	await click(trigger());
	await search("Polish");
	await key(input(), "Enter");
	assert.match(trigger().textContent!, /English/);
	assert.match(menu()!.querySelector('[role="alert"]')!.textContent!, /Could not save/);
	f.state.failWrite = false;
	await click(byTest("dictation-language-pl"));
	assert.equal(menu(), null);
	assert.match(trigger().textContent!, /Polish/);
	assert.deepEqual(f.state.writes, ["pl", "pl"]);
});

test("a remounted picker stays disabled throughout an outstanding save", async () => {
	const f = await fixture();
	let complete!: (response: Response) => void;
	f.state.nextWrite = new Promise((resolve) => { complete = resolve; });
	await click(trigger());
	await click(byTest("dictation-language-multi"));
	assert.equal(trigger().disabled, true);
	await f.remount();
	assert.equal(trigger().disabled, true);
	await click(trigger());
	assert.equal(menu(), null);
	f.state.record.dictation = { language: "multi" };
	await act(async () => { complete(Response.json({ settings: f.state.record })); });
	assert.equal(trigger().disabled, false);
	assert.match(trigger().textContent!, /Multilingual/);
	assert.deepEqual(f.state.writes, ["multi"]);
});

test("capture locks the row and dismisses an open language menu until capture ends", async () => {
	await fixture();
	await click(trigger());
	await act(async () => { setDictationActive(true); });
	assert.equal(trigger().disabled, true);
	assert.match(byTest("row-dictation-language").className, /opacity-40/);
	assert.equal(menu(), null);
	await act(async () => { setDictationActive(false); });
	assert.equal(trigger().disabled, false);
	await click(trigger());
	assert(menu());
});

test("clearing each search restores the complete catalog order with Multilingual first", async () => {
	await fixture();
	await click(trigger());
	const order = () => [...document.querySelectorAll("[cmdk-item]")].map((item) => item.getAttribute("data-value"));
	const expected = DICTATION_LANGUAGES.map((item) => item.code);
	assert.deepEqual(order(), expected);
	for (const query of ["en", "multi", "Polish", "zzzzz"]) {
		await search(query);
		await search("");
		assert.deepEqual(order(), expected, `catalog order after clearing ${query}`);
	}
});
