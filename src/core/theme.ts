/**
 * THEME RESOLUTION (light-theme wave, 2026-10-26) — the mode arithmetic
 * shared by the two places that must agree about it:
 *
 *  - `app/layout.tsx` (a server component) resolves the FIRST PAINT: it
 *    reads the settings record and puts the class on <html>. An explicit
 *    dark/light is final there; "system" cannot be known on the server, so
 *    it is served as light plus a pre-paint script (prePaintScript) that
 *    flips the class before the body paints.
 *  - `components/settings/appearance.tsx` (the client provider) keeps the
 *    class in step afterwards, following the OS while the stored mode is
 *    "system".
 *
 * Pure and client/server neutral on purpose: the palette blocks live in
 * app/globals.css (light on `:root`, dark on `.dark`), so the only shared
 * fact is which class means which palette.
 */

import type { AppearanceMode } from "./settings.ts";

/** The mode a palette is actually painted in (system already resolved). */
export type ResolvedMode = "dark" | "light";

/** The media query behind the System option. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** Resolve the stored mode against the OS preference. Pure. */
export function resolveMode(mode: AppearanceMode, systemPrefersDark: boolean): ResolvedMode {
	if (mode === "system") return systemPrefersDark ? "dark" : "light";
	return mode;
}

/** The class `<html>` carries for a resolved mode: Tailwind's `dark:`
 *  variant and the CSS palette both key off `.dark`; light is the bare
 *  `:root` palette (no class). Pure. */
export function modeClassName(mode: ResolvedMode): string {
	return mode === "dark" ? "dark" : "";
}

/** The palette's own background hex per mode — the value app/globals.css
 *  declares on `:root` (light) and `.dark`. Duplicated here because CSS
 *  tokens are literals; used by the settings UI to show the real default. */
export const MODE_DEFAULT_BACKGROUND: Record<ResolvedMode, string> = {
	light: "#f2f2f2",
	dark: "#141414",
};

/** The pre-paint script for the one mode the server cannot resolve, or
 *  null when the served class is already final. Runs synchronously as the
 *  first thing in <body>, so the dark palette is in place before the page
 *  paints. Pure — exported for tests. */
export function prePaintScript(mode: AppearanceMode): string | null {
	if (mode !== "system") return null;
	return `if(window.matchMedia&&window.matchMedia(${JSON.stringify(SYSTEM_DARK_QUERY)}).matches)document.documentElement.classList.add("dark")`;
}
