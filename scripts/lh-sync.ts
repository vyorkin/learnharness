/**
 * Cross-machine sync — transport + write side (2026-10-26, owner design).
 *
 *   npm run lh:sync -- --peer bankai                  # pull, merge, write, push
 *   npm run lh:sync -- --peer bankai --skip-if-busy   # the timer's form: a busy app skips the tick
 *   npm run lh:sync -- --peer bankai --dry-run        # pull, merge, report, write nothing
 *   npm run lh:sync -- --peer-dir /tmp/other-data     # a local directory (tests, staging)
 *
 * SAFE TO RUN WHILE THE APP IS RUNNING (this is what makes a timer sound):
 *
 *   graph ledgers    APPEND ONLY, on both sides. A sync never rewrites
 *                    nodes/chains/coverage/sessions/deleted — it appends the
 *                    lines the other side lacks. A rewrite would be a
 *                    read-modify-write racing the app's own appends, and the
 *                    append it loses is a lesson or a fact.
 *   chats, sources,
 *   positions        whole-file writes, but only when the current bytes still
 *                    equal what this run read: if the app (or the peer) moved
 *                    the file meanwhile, the file is DEFERRED to the next tick
 *                    instead of being overwritten.
 *   render-settings  the local blob wins; the peer's only fills an empty side.
 *
 * Never synced: settings.json (machine-specific), jobs/ (ephemeral), .env.local
 * and auth.json (secrets).
 *
 * Refusals: a peer still at graph format < 2 (syncing un-migrated data would
 * duplicate every node); a conflicting chat message (parked under
 * .sync/conflicts/, nothing written or pushed, --force keeps the local copy).
 * A second concurrent run on this machine is refused by a lock directory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeBundles, syncLineKeys, type SyncBundle, type SyncReport } from "../src/core/sync-merge.ts";
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
// The app's own seam: LH_DATA_DIR names the data dir when --data is absent.
const DATA_DIR = path.resolve(argValue("--data") ?? process.env.LH_DATA_DIR ?? "data");
const APP_URL = argValue("--app-url") ?? "http://localhost:3300";
const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push");
const FORCE = process.argv.includes("--force");
const SKIP_IF_BUSY = process.argv.includes("--skip-if-busy");

if (!PEER && !PEER_DIR) {
	console.error("lh:sync needs a peer: --peer <ssh-host> or --peer-dir <data-dir>");
	process.exit(2);
}

const STAGING = path.join(path.dirname(DATA_DIR), ".sync", "incoming");
const CONFLICTS = path.join(path.dirname(DATA_DIR), ".sync", "conflicts");
const LOCK = path.join(path.dirname(DATA_DIR), ".sync", "run.lock");

// ─── the remote side: ssh (or a local directory), uniformly ──────────────────

const remoteBase = (): string => (PEER_DIR ? path.resolve(PEER_DIR) : REMOTE_DATA);

/** Read one file off the peer, or null when it does not exist. */
function remoteRead(relative: string): string | null {
	const target = `${remoteBase()}/${relative}`;
	if (PEER_DIR) {
		try {
			return fs.readFileSync(target, "utf-8");
		} catch {
			return null;
		}
	}
	const result = spawnSync("ssh", [PEER!, `cat '${target.replace(/'/g, `'\\''`)}' 2>/dev/null`], { encoding: "utf-8" });
	return result.status === 0 ? result.stdout : null;
}

/** Append bytes on the peer. O_APPEND writes of one line are atomic. */
function remoteAppend(relative: string, body: string): void {
	const target = `${remoteBase()}/${relative}`;
	if (PEER_DIR) {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.appendFileSync(target, body, "utf-8");
		return;
	}
	const result = spawnSync("ssh", [PEER!, `mkdir -p '${path.posix.dirname(target)}' && cat >> '${target.replace(/'/g, `'\\''`)}'`], {
		input: body,
		encoding: "utf-8",
	});
	if (result.status !== 0) throw new Error(`ssh append failed for ${relative}: ${result.stderr.trim() || result.status}`);
}

/** Replace one file on the peer (used only when the peer's bytes are known). */
function remoteWrite(relative: string, body: string): void {
	const target = `${remoteBase()}/${relative}`;
	if (PEER_DIR) {
		fs.mkdirSync(path.posix.dirname(target), { recursive: true });
		fs.writeFileSync(target, body, "utf-8");
		return;
	}
	const result = spawnSync("rsync", ["-a", "--files-from=-", `${DATA_DIR}/`, `${PEER}:${remoteBase()}/`], {
		input: `${relative}\n`,
		encoding: "utf-8",
	});
	if (result.status !== 0) throw new Error(`rsync ${relative} failed: ${result.stderr.trim() || result.status}`);
	void body;
}

// ─── local file reads (content is kept: it is the "did it change?" baseline) ─

function readFileOrNull(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

function jsonlLines<T>(raw: string | null): T[] {
	if (!raw) return [];
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as T);
		} catch {
			/* a torn append is skipped here too — same doctrine as the stores */
		}
	}
	return out;
}

function parseJson<T>(raw: string | null): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

interface BundleRead {
	bundle: SyncBundle;
	/** rel path → exact bytes read (the baseline for "unchanged?" checks). */
	contents: Map<string, string>;
}

function readBundle(dir: string): BundleRead {
	const contents = new Map<string, string>();
	const read = (relative: string): string | null => {
		const raw = readFileOrNull(path.join(dir, relative));
		if (raw !== null) contents.set(relative, raw);
		return raw;
	};
	const positions = parseJson<{ positions?: Record<string, Position>; updatedAt?: string }>(read("graph/positions.json"));
	const sources = parseJson<Record<string, NotesSource>>(read("graph/sources.json"));
	let chatNames: string[] = [];
	try {
		chatNames = fs.readdirSync(path.join(dir, "chats")).filter((name) => name.endsWith(".json"));
	} catch {
		chatNames = [];
	}
	const chats: ChatRecord[] = [];
	for (const name of chatNames) {
		const record = parseJson<ChatRecord>(read(`chats/${name}`));
		if (record && typeof record.id === "string") chats.push(record);
	}
	return {
		contents,
		bundle: {
			nodes: jsonlLines<GraphNode>(contents.get("graph/nodes.jsonl") ?? read("graph/nodes.jsonl")),
			chains: jsonlLines<GraphChain>(contents.get("graph/chains.jsonl") ?? read("graph/chains.jsonl")),
			coverage: jsonlLines<CoverageEntry>(contents.get("graph/coverage.jsonl") ?? read("graph/coverage.jsonl")),
			checkpoints: jsonlLines<SessionCheckpoint>(contents.get("graph/sessions.jsonl") ?? read("graph/sessions.jsonl")),
			deletions: jsonlLines<GraphTombstone>(contents.get("graph/deleted.jsonl") ?? read("graph/deleted.jsonl")),
			chats,
			chatTombstones: jsonlLines<ChatTombstone>(contents.get("chats/deleted.jsonl") ?? read("chats/deleted.jsonl")),
			positions: positions?.positions ?? {},
			positionsUpdatedAt: positions?.updatedAt,
			renderSettings: parseJson<unknown>(read("graph/render-settings.json")),
			sources: Object.values(sources ?? {}),
		},
	};
}

// ─── ledger appends (never rewrites) ─────────────────────────────────────────

interface Ledger {
	relative: string;
	records: unknown[];
	key: (record: never) => string;
}

function ledgerPlan(bundle: SyncBundle): Ledger[] {
	return [
		{ relative: "graph/nodes.jsonl", records: bundle.nodes, key: syncLineKeys.node as (record: never) => string },
		{ relative: "graph/chains.jsonl", records: bundle.chains, key: syncLineKeys.chain as (record: never) => string },
		{ relative: "graph/coverage.jsonl", records: bundle.coverage, key: syncLineKeys.coverage as (record: never) => string },
		{ relative: "graph/sessions.jsonl", records: bundle.checkpoints, key: syncLineKeys.checkpoint as (record: never) => string },
		{ relative: "graph/deleted.jsonl", records: bundle.deletions, key: syncLineKeys.deletion as (record: never) => string },
		{ relative: "chats/deleted.jsonl", records: bundle.chatTombstones, key: syncLineKeys.chatTombstone as (record: never) => string },
	];
}

/** The lines of `records` whose key is not present in `existing`. */
function missingLines(records: unknown[], existing: string | null, key: (record: never) => string): string[] {
	const known = new Set(jsonlLines<unknown>(existing).map((record) => key(record as never)));
	const out: string[] = [];
	for (const record of records) {
		const id = key(record as never);
		if (known.has(id)) continue;
		known.add(id);
		out.push(JSON.stringify(record));
	}
	return out;
}

function appendLocal(relative: string, records: unknown[], key: (record: never) => string, written: string[]): number {
	const file = path.join(DATA_DIR, relative);
	const body = missingLines(records, readFileOrNull(file), key);
	if (body.length === 0) return 0;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, body.join("\n") + "\n", "utf-8");
	written.push(file);
	return body.length;
}

// ─── local whole-file writes, guarded by the read baseline ───────────────────

function writeLocalIfUnchanged(relative: string, body: string, baseline: string | undefined, written: string[], deferred: string[]): void {
	const file = path.join(DATA_DIR, relative);
	const current = readFileOrNull(file);
	if (baseline !== undefined && current !== baseline) {
		deferred.push(relative); // the app (or another run) moved it — next tick
		return;
	}
	if (current === body) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.sync-${process.pid}`;
	fs.writeFileSync(tmp, body, "utf-8");
	fs.renameSync(tmp, file);
	written.push(file);
}

// ─── transport: pull / push ──────────────────────────────────────────────────

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

function pull(): void {
	fs.rmSync(STAGING, { recursive: true, force: true });
	fs.mkdirSync(STAGING, { recursive: true });
	const source = PEER_DIR ? path.resolve(PEER_DIR) : `${PEER}:${REMOTE_DATA}`;
	execFileSync(
		"rsync",
		["-a", "--delete", ...PULL_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]), `${source}/`, `${STAGING}/`],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
}

function pushLedgers(bundle: SyncBundle, staged: BundleRead): { appended: number; deferred: string[] } {
	let appended = 0;
	const deferred: string[] = [];
	for (const ledger of ledgerPlan(bundle)) {
		const body = missingLines(ledger.records, remoteRead(ledger.relative), ledger.key);
		if (body.length === 0) continue;
		// The peer's ledger is append-only too, so an append can never clobber
		// a line it wrote after our pull — no "unchanged" check needed.
		remoteAppend(ledger.relative, body.join("\n") + "\n");
		appended += body.length;
	}
	void staged;
	return { appended, deferred };
}

function pushWholeFiles(bundle: SyncBundle, staged: BundleRead, written: string[]): string[] {
	const deferred: string[] = [];
	const peerUnchanged = (relative: string): boolean =>
		(remoteRead(relative) ?? null) === (staged.contents.get(relative) ?? null);

	// positions: derived cache, but still only written over a known peer state
	const positionsBody = JSON.stringify(
		{ positions: bundle.positions, updatedAt: bundle.positionsUpdatedAt ?? new Date().toISOString() },
		null,
		"\t",
	);
	if (staged.contents.has("graph/positions.json") || Object.keys(bundle.positions).length > 0) {
		if (peerUnchanged("graph/positions.json")) remoteWrite("graph/positions.json", positionsBody);
		else deferred.push("graph/positions.json");
	}
	// sources: the notes bookkeeping
	if (bundle.sources.length > 0) {
		const body = JSON.stringify(Object.fromEntries(bundle.sources.map((source) => [source.id, source])), null, "\t");
		if (peerUnchanged("graph/sources.json")) remoteWrite("graph/sources.json", body);
		else deferred.push("graph/sources.json");
	}
	// chats: only over the exact bytes this run pulled
	for (const chat of bundle.chats) {
		const relative = `chats/${chat.id}.json`;
		const body = JSON.stringify(chat, null, "\t");
		if (staged.contents.get(relative) === body) continue;
		if (peerUnchanged(relative)) {
			remoteWrite(relative, body);
			written.push(relative);
		} else {
			deferred.push(relative);
		}
	}
	return deferred;
}

/**
 * Is the peer (as of the pull) already holding everything this run would push?
 * A pure in-memory comparison — the point is to skip the push entirely when a
 * tick found nothing to do, which is the common case (idle ticks then cost one
 * rsync pull instead of a dozen ssh round trips).
 */
function peerIsCurrent(bundle: SyncBundle, staged: BundleRead): boolean {
	const stagedBundle = staged.bundle;
	const superset = <T>(mine: ReadonlyArray<T>, theirs: ReadonlyArray<T>, key: (value: T) => string): boolean => {
		const known = new Set(theirs.map(key));
		return mine.every((item) => known.has(key(item)));
	};
	if (!superset(bundle.nodes, stagedBundle.nodes, (line) => syncLineKeys.node(line))) return false;
	if (!superset(bundle.chains, stagedBundle.chains, (line) => syncLineKeys.chain(line))) return false;
	if (!superset(bundle.coverage, stagedBundle.coverage, syncLineKeys.coverage)) return false;
	if (!superset(bundle.checkpoints, stagedBundle.checkpoints, syncLineKeys.checkpoint)) return false;
	if (!superset(bundle.deletions, stagedBundle.deletions, syncLineKeys.deletion)) return false;
	if (!superset(bundle.chatTombstones, stagedBundle.chatTombstones, syncLineKeys.chatTombstone)) return false;
	const stagedChats = new Map(stagedBundle.chats.map((chat) => [chat.id, JSON.stringify(chat, null, "\t")]));
	for (const chat of bundle.chats) {
		if (stagedChats.get(chat.id) !== JSON.stringify(chat, null, "\t")) return false;
	}
	const positions = JSON.stringify({ positions: bundle.positions, updatedAt: bundle.positionsUpdatedAt });
	const stagedPositions = JSON.stringify({ positions: stagedBundle.positions, updatedAt: stagedBundle.positionsUpdatedAt });
	if (positions !== stagedPositions) return false;
	const sources = JSON.stringify(Object.fromEntries(bundle.sources.map((source) => [source.id, source])));
	const stagedSources = JSON.stringify(Object.fromEntries(stagedBundle.sources.map((source) => [source.id, source])));
	return sources === stagedSources;
}

// ─── busy guard + lock ───────────────────────────────────────────────────────

async function appIsBusy(): Promise<boolean> {
	const get = async (route: string): Promise<unknown> => {
		try {
			const response = await fetch(`${APP_URL}${route}`, { signal: AbortSignal.timeout(5000) });
			return response.ok ? await response.json() : undefined;
		} catch {
			return undefined; // app not running → nothing can be mid-write
		}
	};
	const activity = (await get("/api/activity")) as { runs?: unknown[] } | undefined;
	if (Array.isArray(activity?.runs) && activity.runs.length > 0) return true;
	const graph = (await get("/api/graph/status")) as { runs?: unknown[] } | undefined;
	return Array.isArray(graph?.runs) && graph.runs.length > 0;
}

function takeLock(): boolean {
	try {
		fs.mkdirSync(path.dirname(LOCK), { recursive: true });
		fs.mkdirSync(LOCK);
		fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid), "utf-8");
		return true;
	} catch {
		// Stale lock from a killed run: a tick every few minutes must not wedge.
		try {
			const age = Date.now() - fs.statSync(LOCK).mtimeMs;
			if (age > 15 * 60_000) {
				fs.rmSync(LOCK, { recursive: true, force: true });
				fs.mkdirSync(LOCK);
				return true;
			}
		} catch {
			/* raced with the holder releasing it */
		}
		return false;
	}
}

function releaseLock(): void {
	try {
		fs.rmSync(LOCK, { recursive: true, force: true });
	} catch {
		/* nothing to release */
	}
}

// ─── main ────────────────────────────────────────────────────────────────────

function graphFormatVersion(dir: string): number {
	const stamped = parseJson<{ version?: number }>(readFileOrNull(path.join(dir, "graph", "format.json")));
	return typeof stamped?.version === "number" ? stamped.version : 0;
}

function reportLine(report: SyncReport, appended: number, pushed: number, written: string[], deferred: string[]): void {
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
	console.log(`[sync] wrote ${written.length} local file(s), appended ${appended} line(s) locally`);
	console.log(`[sync] pushed: ${pushed} appended line(s), ${report.positionsFrom === "incoming" ? "positions from peer" : "positions kept"}`);
	if (deferred.length > 0) console.log(`[sync] deferred to the next tick (${deferred.length}): ${deferred.slice(0, 5).join(", ")}`);
}

async function main(): Promise<void> {
	if (graphFormatVersion(DATA_DIR) < 2) {
		console.error(
			`[sync] REFUSED: ${DATA_DIR} is not content-addressed yet — run \`npx tsx scripts/migrate-hash-ids.ts --data <dir> --apply\` on BOTH machines first.`,
		);
		process.exit(1);
	}
	if (SKIP_IF_BUSY && (await appIsBusy())) {
		console.log("[sync] the app is mid-work — skipping this tick");
		return;
	}
	if (!takeLock()) {
		console.log("[sync] another sync is running — skipping this tick");
		return;
	}

	try {
		console.log(`[sync] pulling ${PEER_DIR ?? `${PEER}:${REMOTE_DATA}`} → ${STAGING}`);
		pull();

		const staged = readBundle(STAGING);
		if (graphFormatVersion(STAGING) < 2) {
			console.error("[sync] REFUSED: the peer's data is not content-addressed yet — migrate it first (the script lives in this tree).");
			process.exit(1);
		}

		const local = readBundle(DATA_DIR);
		const { bundle, report } = mergeBundles(local.bundle, staged.bundle);

		if (report.conflicts.length > 0) {
			fs.mkdirSync(CONFLICTS, { recursive: true });
			for (const conflict of report.conflicts) {
				fs.writeFileSync(
					path.join(CONFLICTS, `${conflict.chatId}-${conflict.messageId}.json`),
					JSON.stringify(conflict.incoming, null, "\t"),
					"utf-8",
				);
			}
			console.error(`[sync] ${report.conflicts.length} message conflict(s) — incoming copies parked in ${CONFLICTS}`);
			if (!FORCE) {
				console.error("[sync] nothing written, nothing pushed. Resolve by hand, or re-run with --force to keep the local copies.");
				process.exit(1);
			}
		}

		if (DRY_RUN) {
			reportLine(report, 0, 0, [], []);
			console.log("[sync] dry run — nothing written, nothing pushed");
			return;
		}

		// ── local side: append ledgers, guarded whole-file writes ────────────
		const written: string[] = [];
		const deferred: string[] = [];
		let appended = 0;
		for (const ledger of ledgerPlan(bundle)) appended += appendLocal(ledger.relative, ledger.records, ledger.key, written);

		for (const chat of bundle.chats) {
			const relative = `chats/${chat.id}.json`;
			writeLocalIfUnchanged(relative, JSON.stringify(chat, null, "\t"), local.contents.get(relative), written, deferred);
		}
		if (Object.keys(bundle.positions).length > 0 || local.contents.has("graph/positions.json")) {
			const body = JSON.stringify(
				{ positions: bundle.positions, updatedAt: bundle.positionsUpdatedAt ?? new Date().toISOString() },
				null,
				"\t",
			);
			writeLocalIfUnchanged("graph/positions.json", body, local.contents.get("graph/positions.json"), written, deferred);
		}
		if (bundle.renderSettings !== undefined && bundle.renderSettings !== null && !local.contents.has("graph/render-settings.json")) {
			writeLocalIfUnchanged(
				"graph/render-settings.json",
				JSON.stringify(bundle.renderSettings, null, "\t"),
				undefined,
				written,
				deferred,
			);
		}
		if (bundle.sources.length > 0) {
			const body = JSON.stringify(Object.fromEntries(bundle.sources.map((source) => [source.id, source])), null, "\t");
			writeLocalIfUnchanged("graph/sources.json", body, local.contents.get("graph/sources.json"), written, deferred);
		}

		reportLine(report, appended, 0, written, deferred);

		if (NO_PUSH) {
			console.log("[sync] --no-push: the peer was not updated");
			return;
		}

		// ── peer side: append ledgers, guarded whole-file writes ─────────────
		if (peerIsCurrent(bundle, staged)) {
			console.log("[sync] the peer already holds everything — push skipped");
			return;
		}
		const pushedLedgers = pushLedgers(bundle, staged);
		const pushedFiles = pushWholeFiles(bundle, staged, written);
		console.log(
			`[sync] pushed ${pushedLedgers.appended} ledger line(s), ${pushedFiles.length === 0 ? "no deferred peer files" : `${pushedFiles.length} peer file(s) deferred: ${pushedFiles.slice(0, 5).join(", ")}`}`,
		);
	} finally {
		releaseLock();
	}
}

await main();
