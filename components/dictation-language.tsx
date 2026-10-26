"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Command } from "cmdk";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
	DICTATION_LANGUAGES, fuzzyScore, type DictationLanguage,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Hint } from "@/components/ui/hint";
import { SettingsRow } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

type LanguagePreference = ReturnType<typeof useDictationLanguage>;

export function DictationLanguageSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	return <SettingsRow label="Language" testid="row-dictation-language" dimmed={active}>
		<DictationLanguagePicker preference={preference} disabled={active} />
	</SettingsRow>;
}

function DictationLanguagePicker({ preference, disabled }: {
	preference: LanguagePreference;
	disabled: boolean;
}) {
	const { language, saving, error, load, save } = preference;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const triggerRef = useRef<HTMLButtonElement>(null);
	const label = DICTATION_LANGUAGES.find((item) => item.code === language)?.label ?? "—";
	// Own ordering so clearing a search restores the catalog's order.
	// cmdk handles keyboard/ARIA, but its DOM sorting retains old ranks.
	const results = query.trim() ? DICTATION_LANGUAGES
		.map((item) => ({ item, score: fuzzyScore(query, item.code, item.label) }))
		.filter((item) => item.score !== null)
		.sort((a, b) => b.score! - a.score!)
		.map(({ item }) => item) : DICTATION_LANGUAGES;

	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="dictation-language-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open]);
	const closeOnEscape = (event: ReactKeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setOpen(false);
		triggerRef.current?.focus();
	};
	const pick = async (code: DictationLanguage) => {
		if (disabled || saving || language === undefined) return;
		if (await save(code)) {
			setOpen(false);
			triggerRef.current?.focus();
		}
	};

	return <>
		<Hint label={error ?? `Dictation language: ${label}`} side="top">
			<Button
				ref={triggerRef}
				type="button"
				variant="outline"
				size="xs"
				data-testid="dictation-language"
				aria-label={`Dictation language: ${label}`}
				aria-expanded={open && !disabled}
				aria-haspopup="listbox"
				disabled={disabled || saving}
				onKeyDown={(event) => { if (open) closeOnEscape(event); }}
				onClick={() => {
					setQuery("");
					setOpen((value) => !value);
					if (language === undefined || error) void load().catch(() => {});
				}}
				className="h-8 min-w-0 max-w-[65%] px-2.5 font-normal"
			>
				<span className="truncate">{label}</span>
				<ChevronDownIcon aria-hidden className="size-3" />
			</Button>
		</Hint>
		{open && !disabled && <MenuShell
			anchorRef={triggerRef}
			testid="dictation-language-menu"
			preferredSide="down"
			menuClass="flex w-72 max-w-[calc(100vw-1rem)] flex-col rounded-xl border bg-card p-2 text-xs shadow-xl"
		>
			{error && <div role="alert" className="mb-1.5 text-destructive">{error}</div>}
			<Command
				label="Dictation languages"
				vimBindings={false}
				shouldFilter={false}
				onKeyDown={(event) => {
					closeOnEscape(event);
					// Keep menu navigation out of the composer's submit/shortcut
					// handlers. cmdk owns selection, scrolling and ARIA state.
					if (["ArrowDown", "ArrowUp", "Enter", "Home", "End"].includes(event.key)) event.stopPropagation();
				}}
			>
				<Command.Input asChild disabled={saving} value={query} onValueChange={setQuery}>
					<Input aria-label="Search dictation languages" placeholder="Search languages…" className="mb-1.5 h-8 bg-background px-2 text-xs md:text-xs" />
				</Command.Input>
				<Command.List className="max-h-72 overflow-y-auto px-1">
					<Command.Empty className="px-2 py-3 text-center text-muted-foreground">No languages match.</Command.Empty>
					{results.map((item) => <Command.Item
						key={item.code}
						value={item.code}
						disabled={saving || language === undefined}
						onSelect={() => { void pick(item.code); }}
						asChild
					>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							tabIndex={-1}
							disabled={saving || language === undefined}
							data-testid={`dictation-language-${item.code}`}
							className="h-auto w-full justify-between whitespace-normal rounded-lg px-2 py-1.5 text-left text-xs font-normal text-card-foreground data-[selected=true]:bg-accent/40"
						>
							{item.label}
							{language === item.code && <CheckIcon aria-hidden className="size-3.5" />}
						</Button>
					</Command.Item>)}
				</Command.List>
			</Command>
		</MenuShell>}
	</>;
}
