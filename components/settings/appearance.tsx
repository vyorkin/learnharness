"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders.
 *
 * THE MODE (light-theme wave): the palette lives in two CSS blocks in
 * app/globals.css — light on :root, dark on `.dark`. The storable mode is
 * dark | light | system; system resolves against the OS
 * (prefers-color-scheme) with a live listener, so an OS appearance change
 * repaints immediately. The FIRST paint is server-resolved in
 * app/layout.tsx (the class is already on <html> in the served HTML; a
 * tiny inline script covers the system case, which the server cannot
 * know). This provider only KEEPS the class in step afterwards.
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	FACTORY_SETTINGS,
	SYSTEM_DARK_QUERY,
	resolveMode,
	type AppearanceSettings,
	type ResolvedMode,
} from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged).
 *  `mode` is the STORED value; `resolvedMode` is what the palette uses. */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		autoCollapseQuestions: delta?.autoCollapseQuestions ?? f.autoCollapseQuestions,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** One channel shifted on the palette's curve, clamped to [0, 255]. */
function shiftChannel(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.max(0, Math.min(255, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** The derived palette a chosen background implies, per mode.
 *
 *  DARK (unchanged, the hand-picked palette's own offsets): #141414 → card
 *  #1c1c1c (+8) → accent #2a2a2a (+22) → border #434343 (+47); primary is
 *  the inverted text, so primary-foreground is the background itself.
 *
 *  LIGHT (mirror of the same relationships, measured off the light
 *  palette): #f2f2f2 → card #ffffff (+13 toward white) → accent #e6e6e6
 *  (−12) → border #cfcfcf (−35); primary is the foreground, so
 *  primary-foreground takes the card (the surface primary sits on).
 *  A background near white cannot separate the card by lightening — the
 *  offset clamps at #ffffff, which is the owner's stated trade for one
 *  shared Background field. */
export function derivedPalette(background: string, mode: ResolvedMode): Record<string, string> {
	if (mode === "light") {
		const card = shiftChannel(background, 13);
		const accent = shiftChannel(background, -12);
		const border = shiftChannel(background, -35);
		return {
			"--background": background,
			"--card": card,
			"--popover": card,
			"--secondary": card,
			"--muted": card,
			"--accent": accent,
			"--border": border,
			"--input": border,
			"--primary-foreground": card,
		};
	}
	const card = shiftChannel(background, 8);
	const accent = shiftChannel(background, 22);
	const border = shiftChannel(background, 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  The background curve follows the RESOLVED mode (a system user gets the
 *  curve of the palette actually painted). Absent entries = leave the
 *  factory stylesheet value in place. Pure — exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	resolvedMode: ResolvedMode,
): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null) Object.assign(vars, derivedPalette(a.background, resolvedMode));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The palette actually painted: system already resolved against the OS. */
	resolvedMode: ResolvedMode;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	resolvedMode: "dark",
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initialAppearance,
}: {
	children: React.ReactNode;
	/** The stored appearance delta the server already rendered with
	 *  (app/layout.tsx). Starting from it keeps the first client render's
	 *  background vars identical to the served HTML — the fetch below then
	 *  only confirms the record. */
	initialAppearance?: AppearanceSettings;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(initialAppearance);
	const appliedRef = useRef<string>("");

	// The OS preference, read lazily on the client (the provider renders
	// children only, so the server/client first render can't mismatch).
	// Defaults to dark — the factory mode — until matchMedia answers.
	const [systemDark, setSystemDark] = useState<boolean>(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
		return window.matchMedia(SYSTEM_DARK_QUERY).matches;
	});

	const appearance = useMemo(() => resolveAppearance(delta), [delta]);
	const resolvedMode = resolveMode(appearance.mode, systemDark);

	// Follow the OS while (and only while) the stored mode is "system".
	useEffect(() => {
		if (appearance.mode !== "system" || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(SYSTEM_DARK_QUERY);
		const onChange = () => setSystemDark(query.matches);
		onChange();
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [appearance.mode]);

	// Keep <html> in step with the resolved mode. The server already emitted
	// the class for the first paint; this covers switches, the OS changing
	// under "system", and the native Electron chrome.
	useEffect(() => {
		document.documentElement.classList.toggle("dark", resolvedMode === "dark");
	}, [resolvedMode]);

	// The native shell's window background and title-bar controls cannot read
	// CSS variables — push the STORED mode over the preload bridge (main
	// resolves "system" itself and keeps nativeTheme.themeSource in step, so
	// the renderer's own prefers-color-scheme stays truthful).
	useEffect(() => {
		window.lh?.theme?.set?.(appearance.mode);
	}, [appearance.mode]);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(appearance, resolvedMode), [appearance, resolvedMode]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance, resolvedMode, onAppearanceChange }),
		[appearance, resolvedMode, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}