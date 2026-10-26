/**
 * Cross-machine sync — the transport + write side (2026-10-26, owner design).
 *
 *   npm run lh:sync -- --peer bankai                 # pull, merge, push
 *   npm run lh:sync -- --peer bankai --dry-run       # pull, merge, report, write nothing
 *   npm run lh:sync -- --peer-dir /tmp/other-data    # a local directory (tests, staging)
 *
 * What moves: the graph ledgers (nodes, chains, coverage, checkpoints,
 * deletions, positions, render-settings, sources) and the chat records with
 * their deletion tombstones. What never moves: settings.json (machine
 * specific), jobs/ (ephemeral background work), .env.local / auth.json
 * (secrets).
 *
 * The merge itself is pure and lives in src/core/sync-merge.ts; this script is
 * the composition root — rsync the other side in, read both sides off disk,
 * merge, write the local files that changed, rsync the merged set back.
 *
 * Refusals (a sync must never make things worse):
 *   - the local graph is not at content-addressed ids yet (format < 2):
 *     run `npx tsx scripts/migrate-hash-ids.ts --apply` first, on BOTH sides;
 *   - a chat message id exists on both sides with different content: the
 *     incoming message is parked under .sync/conflicts/ and NOTHING is written
 *     or pushed (--force overrides, keeping the local message);
 *   - rsync/ssh fails: nothing is written.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeBundles, type SyncBundle, type SyncReport } from "../src/core/sync-merge.ts";
import type {
	ChatRecord,
	ChatTombstone,
	CoverageEntry,
	GraphChain,
	GraphNode,
	GraphTombstone,
	NotesSource,
	Position,
	SessionCheckpoint,
} from "../src/core/contracts.ts";

// ─── args ────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
	const at = process.argv.indexOf(flag);
	if (at < 0) return undefined;
	const value = process.argv[at + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

const PEER = argValue("--peer");
const PEER_DIR = argValue("--peer-dir");
const REMOTE_DATA = argValue("--remote-data") ?? ".local/share/learnharness/data";
const DATA_DIR = path.resolve(argValue("--data") ?? "data");
const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push");
const FORCE = process.argv.includes("--force");

if (!PEER && !PEER_DIR) {
	console.error("lh:sync needs a peer: --peer <ssh-host> or --peer-dir <data-dir>");
	process.exit(2);
}

const STAGING = path.join(path.dirname(DATA_DIR), ".sync", "incoming");
const CONFLICTS = path.join(path.dirname(DATA_DIR), ".sync", "conflicts");

// ─── read one side off disk (tolerant: a missing file is an empty list) ──────

function readJsonl<T>(file: string): T[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as T);
		} catch {
			// A torn append is skipped here too — same doctrine as the stores.
		}
	}
	return out;
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

/** The graph-family format version stamped in a data dir (0 = unstamped). */
function graphFormatVersion(dir: string): number {
	const stamped = readJson<{ version?: number }>(path.join(dir, "graph", "format.json"));
	return typeof stamped?.version === "number" ? stamped.version : 0;
}

function readBundle(dir: string): SyncBundle {
	const graph = path.join(dir, "graph");
	const chatsDir = path.join(dir, "chats");
	const positions = readJson<{ positions?: Record<string, Position>; updatedAt?: string }>(path.join(graph, "positions.json"));
	const renderSettings = readJson<unknown>(path.join(graph, "render-settings.json"));
	const sources = readJson<Record<string, NotesSource>>(path.join(graph, "sources.json"));
	let chatFiles: string[] = [];
	try {
		chatFiles = fs.readdirSync(chatsDir).filter((name) => name.endsWith(".json"));
	} catch {
		chatFiles = [];
	}
	return {
		nodes: readJsonl<GraphNode>(path.join(graph, "nodes.jsonl")),
		chains: readJsonl<GraphChain>(path.join(graph, "chains.jsonl")),
		coverage: readJsonl<CoverageEntry>(path.join(graph, "coverage.jsonl")),
		checkpoints: readJsonl<SessionCheckpoint>(path.join(graph, "sessions.jsonl")),
		deletions: readJsonl<GraphTombstone>(path.join(graph, "deleted.jsonl")),
		chats: chatFiles
			.map((name) => readJson<ChatRecord>(path.join(chatsDir, name)))
			.filter((record): record is ChatRecord => record !== undefined && typeof record.id === "string"),
		chatTombstones: readJsonl<ChatTombstone>(path.join(chatsDir, "deleted.jsonl")),
		positions: positions?.positions ?? {},
		positionsUpdatedAt: positions?.updatedAt,
		renderSettings,
		// sources.json is one map (id -> NotesSource); the bundle carries a list.
		sources: Object.values(sources ?? {}),
	};
}

// ─── write one side (only files whose content changed) ───────────────────────

const jsonl = (records: ReadonlyArray<unknown>): string =>
	records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");

function writeIfChanged(file: string, body: string, written: string[]): void {
	let current: string | undefined;
	try {
		current = fs.readFileSync(file, "utf-8");
	} catch {
		current = undefined;
	}
	if (current === body) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.sync-${process.pid}`;
	fs.writeFileSync(tmp, body, "utf-8");
	fs.renameSync(tmp, file);
	written.push(file);
}

function writeBundle(dir: string, bundle: SyncBundle): string[] {
	const graph = path.join(dir, "graph");
	const chatsDir = path.join(dir, "chats");
	const written: string[] = [];
	// An empty collection never CREATES a ledger: a family that has never
	// emitted something must stay "nothing yet", not gain an empty file.
	const writeLedger = (file: string, body: string): void => {
		if (body === "" && !fs.existsSync(file)) return;
		writeIfChanged(file, body, written);
	};
	writeLedger(path.join(graph, "nodes.jsonl"), jsonl(bundle.nodes));
	writeLedger(path.join(graph, "chains.jsonl"), jsonl(bundle.chains));
	writeLedger(path.join(graph, "coverage.jsonl"), jsonl(bundle.coverage));
	writeLedger(path.join(graph, "sessions.jsonl"), jsonl(bundle.checkpoints));
	writeLedger(path.join(graph, "deleted.jsonl"), jsonl(bundle.deletions));
	writeIfChanged(
		path.join(graph, "positions.json"),
		JSON.stringify({ positions: bundle.positions, updatedAt: bundle.positionsUpdatedAt ?? new Date().toISOString() }, null, "\t"),
		written,
	);
	if (bundle.renderSettings !== undefined && bundle.renderSettings !== null) {
		writeIfChanged(path.join(graph, "render-settings.json"), JSON.stringify(bundle.renderSettings, null, "\t"), written);
	}
	if (bundle.sources.length > 0) {
		const map = Object.fromEntries(bundle.sources.map((source) => [source.id, source]));
		writeIfChanged(path.join(graph, "sources.json"), JSON.stringify(map, null, "\t"), written);
	}
	for (const chat of bundle.chats) {
		writeIfChanged(path.join(chatsDir, `${chat.id}.json`), JSON.stringify(chat, null, "\t"), written);
	}
	if (bundle.chatTombstones.length > 0) {
		writeIfChanged(path.join(chatsDir, "deleted.jsonl"), jsonl(bundle.chatTombstones), written);
	}
	return written;
}

// ─── transport ───────────────────────────────────────────────────────────────

const PULL_EXCLUDES = [
	"settings.json",
	"jobs/",
	".env.local",
	"auth.json",
	".fresh-data/",
	"*pre-hashids*",
	"*.migrate-*",
	"*.tmp-*",
	"*.sync-*",
];

const PUSH_FILES = [
	"graph/nodes.jsonl",
	"graph/chains.jsonl",
	"graph/coverage.jsonl",
	"graph/sessions.jsonl",
	"graph/deleted.jsonl",
	"graph/positions.json",
	"graph/render-settings.json",
	"graph/sources.json",
	"graph/format.json",
	"chats/deleted.jsonl",
];

function remoteSource(): string {
	if (PEER_DIR) return path.resolve(PEER_DIR);
	return `${PEER}:${REMOTE_DATA}`;
}

function pull(): void {
	fs.rmSync(STAGING, { recursive: true, force: true });
	fs.mkdirSync(STAGING, { recursive: true });
	const args = ["-a", "--delete", ...PULL_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]), `${remoteSource()}/`, `${STAGING}/`];
	execFileSync("rsync", args, { stdio: ["ignore", "inherit", "inherit"] });
}

function push(): void {
	// Only files that EXIST: rsync --files-from treats a missing entry as an
	// error, and an empty ledger family is a normal first-boot state.
	const files = PUSH_FILES.filter((relative) => fs.existsSync(path.join(DATA_DIR, relative)));
	try {
		files.push(...fs.readdirSync(path.join(DATA_DIR, "chats")).filter((name) => name.endsWith(".json")).map((name) => `chats/${name}`));
	} catch {
		/* no chats yet */
	}
	const result = spawnSync("rsync", ["-a", "--files-from=-", `${DATA_DIR}/`, `${remoteSource()}/`], {
		input: files.join("\n") + "\n",
		encoding: "utf-8",
	});
	if (result.status !== 0) throw new Error(`rsync push failed: ${result.stderr.trim() || result.status}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

function reportLine(report: SyncReport, written: string[]): void {
	const added = [
		report.nodes ? `+${report.nodes} node lines` : "",
		report.chains ? `+${report.chains} chain lines` : "",
		report.coverage ? `+${report.coverage} coverage` : "",
		report.checkpoints ? `+${report.checkpoints} checkpoints` : "",
		report.deletions ? `+${report.deletions} graph tombstones` : "",
		report.chatsTaken ? `+${report.chatsTaken} chats` : "",
		report.chatsMerged ? `${report.chatsMerged} chats merged` : "",
		report.chatTombstones ? `+${report.chatTombstones} chat tombstones` : "",
		report.sources ? `+${report.sources} sources` : "",
	].filter(Boolean);
	console.log(`[sync] ${added.length > 0 ? added.join(", ") : "nothing new"}`);
	console.log(`[sync] positions: ${report.positionsFrom} · render-settings: ${report.renderSettingsFrom}`);
	console.log(`[sync] wrote ${written.length} local file(s)${written.length > 0 && written.length <= 6 ? `: ${written.map((file) => path.relative(DATA_DIR, file)).join(", ")}` : ""}`);
}

function main(): void {
	const localVersion = graphFormatVersion(DATA_DIR);
	if (localVersion < 2) {
		console.error(
			`[sync] REFUSED: ${DATA_DIR} is at graph format ${localVersion || "unstamped"} — ids are not content-addressed yet.\n` +
				"[sync] Run `npx tsx scripts/migrate-hash-ids.ts --data <dir> --apply` on BOTH machines first, then sync.",
		);
		process.exit(1);
	}
	const remote = PEER_DIR ? path.resolve(PEER_DIR) : undefined;
	if (remote && graphFormatVersion(remote) < 2) {
		console.error(
			`[sync] REFUSED: ${remote} is at graph format ${graphFormatVersion(remote) || "unstamped"} — migrate that side first.`,
		);
		process.exit(1);
	}

	console.log(`[sync] pulling ${remoteSource()} → ${STAGING}`);
	pull();

	// A remote that is not migrated is caught after the pull too (ssh peers).
	const stagedVersion = graphFormatVersion(STAGING);
	if (stagedVersion < 2) {
		console.error(
			`[sync] REFUSED: the peer's data is at graph format ${stagedVersion || "unstamped"} — migrate it first (the migration script lives in this tree).`,
		);
		process.exit(1);
	}

	const local = readBundle(DATA_DIR);
	const incoming = readBundle(STAGING);
	const { bundle, report } = mergeBundles(local, incoming);

	if (report.conflicts.length > 0) {
		fs.mkdirSync(CONFLICTS, { recursive: true });
		for (const conflict of report.conflicts) {
			const file = path.join(CONFLICTS, `${conflict.chatId}-${conflict.messageId}.json`);
			fs.writeFileSync(file, JSON.stringify(conflict.incoming, null, "\t"), "utf-8");
		}
		console.error(`[sync] ${report.conflicts.length} message conflict(s) — incoming copies parked in ${CONFLICTS}`);
		if (!FORCE) {
			console.error("[sync] nothing written, nothing pushed. Resolve by hand, or re-run with --force to keep the local copies.");
			process.exit(1);
		}
	}

	if (DRY_RUN) {
		reportLine(report, []);
		console.log("[sync] dry run — nothing written, nothing pushed");
		return;
	}

	const written = writeBundle(DATA_DIR, bundle);
	reportLine(report, written);

	if (NO_PUSH) {
		console.log("[sync] --no-push: the peer was not updated");
		return;
	}
	push();
	console.log(`[sync] pushed the merged set to ${remoteSource()}`);
}

main();
