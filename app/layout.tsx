import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { prePaintScript, modeClassName, resolveSettings } from "@/src/core";
import { readSettingsRecord } from "@/src/server";
import UpdateBanner from "@/components/update-banner";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

// THE MODE IS READ PER REQUEST (light-theme wave, 2026-10-26): the palette
// class must be on <html> in the served HTML or the first frame paints the
// wrong theme. That means the whole shell is dynamic — the app is a local
// server (desktop bundle or dev), and / already forces dynamic for the same
// kind of reason.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	// The record is the one source of truth; resolveSettings fills every
	// absent field with the factory default (no appearance section = dark).
	const appearance = resolveSettings(readSettingsRecord() ?? null).appearance;
	// Explicit dark/light is final on the server. "system" cannot be known
	// here, so it is served as light and the pre-paint script below flips
	// the class before anything paints.
	const firstPaint = appearance.mode === "dark" ? "dark" : "light";
	const modeClass = modeClassName(firstPaint);
	const prePaint = prePaintScript(appearance.mode);
	return (
		// suppressHydrationWarning: the system-mode script may have added
		// `dark` before React hydrates (the class is not in the server HTML).
		<html lang="en" suppressHydrationWarning className={`${modeClass} ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* Pre-paint only for the system mode — the one answer the server
			    cannot give. No-op (null) for explicit dark/light. */}
			{prePaint ? <script dangerouslySetInnerHTML={{ __html: prePaint }} /> : null}
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider initialAppearance={appearance}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
