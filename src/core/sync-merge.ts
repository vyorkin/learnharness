/**
 * Cross-machine sync: the MERGE ENGINE (2026-10-26, owner design).
 *
 * Two machines run the same app against the same learning data. The transport
 * (scripts/lh-sync.ts) copies the other side's data dir into a staging
 * directory; THIS module — pure, no fs, no network — turns (local, incoming)
 * into the records that should be written back.
 *
 * What the merge can decide without guessing:
 *
 *   graph ledgers     union. Node and chain ids are content-addressed (format
 *                     v2), so the same fact minted on both machines is the
 *                     same line; identical lines dedupe, differing lines (a
 *                     link-append, a later assertion) both stay and the read
 *                     path merges them. Coverage is keyed by
 *                     (chatId, message fingerprint) and checkpoints by
 *                     (chatId, foldedAt) — both unions are meaningful.
 *   tombstones        union (graph deletions by id+stamp, chat deletions by
 *                     id). The derivation filters tombstoned lines; a chat
 *                     adapter hides tombstoned ids.
 *   positions         last-write-wins by the file's own `updatedAt`
 *                     (a derived cache; the next layout settle re-prunes it).
 *   render-settings   last-write-wins (a UI preference, either answer is fine).
 *   sources           union by source id; the usage logs union by startedAt.
 *   chats             per-record merge by message id. A record one side has
 *                     and the other does not is simply taken. When both
 *                     changed, the messages union (ordered by their ids, which
 *                     carry the write timestamp); a message id that exists on
 *                     both sides with DIFFERENT content is a genuine conflict:
 *                     it is reported, the incoming copy is set aside, and the
 *                     local message survives — a head-to-head edit inside one
 *                     turn must be looked at, never guessed.
 *
 * Never merged: settings.json (machine-specific), jobs/ (ephemeral background
 * work), .env.local (secrets).
 */

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
} from "./contracts.ts";

/** One side's syncable records, already read off disk. */
export interface SyncBundle {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
	deletions: GraphTombstone[];
	chats: ChatRecord[];
	chatTombstones: ChatTombstone[];
	positions: Record<string, Position>;
	positionsUpdatedAt?: string;
	renderSettings: unknown;
	sources: NotesSource[];
}

/** What the merge did — the CLI prints this and refuses on conflicts. */
export interface SyncReport {
	nodes: number;
	chains: number;
	coverage: number;
	checkpoints: number;
	deletions: number;
	chatsTaken: number;
	chatsMerged: number;
	chatTombstones: number;
	positionsFrom: "local" | "incoming";
	renderSettingsFrom: "local" | "incoming";
	sources: number;
	conflicts: SyncConflict[];
}

export interface SyncConflict {
	kind: "chat-message";
	chatId: string;
	messageId: string;
	/** The incoming message, so the caller can park it instead of losing it. */
	incoming: unknown;
}

/** The local write plan: what the CLI persists after a conflict-free merge. */
export interface SyncResult {
	bundle: SyncBundle;
	report: SyncReport;
}

const stable = (value: unknown): string => JSON.stringify(value);

/** A node line's identity for dedupe: the exact record (link-appends differ). */
const nodeKey = (line: GraphNode): string =>
	stable({
		id: line.id,
		name: line.name,
		statement: line.statement,
		aliases: line.aliases,
		createdAt: line.createdAt,
		provenance: [...line.provenance].sort((a, b) => `${a.chatId}|${a.messageId}`.localeCompare(`${b.chatId}|${b.messageId}`)),
	});

const chainKeyOf = (line: GraphChain): string =>
	stable({
		id: line.id,
		premises: [...line.premises].sort(),
		conclusion: line.conclusion,
		createdAt: line.createdAt,
		provenance: [...line.provenance].sort((a, b) => `${a.chatId}|${a.messageId}`.localeCompare(`${b.chatId}|${b.messageId}`)),
	});

/**
 * The line-identity keys the merge dedupes by — exported because the CLI also
 * uses them to APPEND only lines the other side lacks (a rewrite would race
 * the running app; an append cannot lose its work).
 */
export const syncLineKeys = {
	node: nodeKey,
	chain: chainKeyOf,
	coverage: (entry: CoverageEntry): string => `${entry.chatId}|${entry.fp}`,
	checkpoint: (row: SessionCheckpoint): string => `${row.chatId}|${row.foldedAt}`,
	deletion: (row: GraphTombstone): string => `${row.id}|${row.deletedAt}`,
	chatTombstone: (row: ChatTombstone): string => row.id,
};

function unionBy<T>(local: ReadonlyArray<T>, incoming: ReadonlyArray<T>, key: (value: T) => string): T[] {
	const out = new Map<string, T>();
	for (const item of local) out.set(key(item), item);
	for (const item of incoming) {
		const existing = out.get(key(item));
		if (existing === undefined) out.set(key(item), item);
	}
	return [...out.values()];
}

/** Merge two usage logs where BOTH copies of a run are useful (each machine
 *  billed its own turns): union by the log's own idempotency key. TurnUsage
 *  keys on the request id, extraction runs on startedAt. */
function unionRuns<T>(local: T[] | undefined, incoming: T[] | undefined, keyOf: (run: T) => string, stampOf: (run: T) => string): T[] | undefined {
	const out = new Map<string, T>();
	for (const run of [...(local ?? []), ...(incoming ?? [])]) {
		const key = keyOf(run);
		if (!out.has(key)) out.set(key, run);
	}
	return out.size > 0 ? [...out.values()].sort((a, b) => stampOf(a).localeCompare(stampOf(b))) : undefined;
}

/**
 * A message's place in a conversation: message ids are `msg_<base36 millis>_<rand>`,
 * so the id itself carries the write time. Unknown shapes fall back to the
 * position they already had (stable sort keeps the input order).
 */
function messageOrder(id: string): number {
	const match = /^msg_([0-9a-z]+)_/.exec(id);
	if (!match) return Number.MAX_SAFE_INTEGER;
	const parsed = Number.parseInt(match[1]!, 36);
	return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/** Merge one chat both sides have. Returns null when a message conflicts. */
function mergeChat(local: ChatRecord, incoming: ChatRecord): { record: ChatRecord } | SyncConflict {
	const byId = new Map<string, unknown>();
	for (const message of local.messages as ReadonlyArray<{ id?: string }>) {
		if (typeof message.id === "string") byId.set(message.id, message);
	}
	const extra: Array<{ id?: string }> = [];
	for (const message of incoming.messages as ReadonlyArray<{ id?: string }>) {
		if (typeof message.id !== "string") {
			// No id: keep it only when the incoming record is the whole story.
			extra.push(message);
			continue;
		}
		const existing = byId.get(message.id);
		if (existing === undefined) {
			byId.set(message.id, message);
			extra.push(message);
			continue;
		}
		if (stable(existing) !== stable(message)) {
			return { kind: "chat-message", chatId: local.id, messageId: message.id, incoming: message };
		}
	}
	const messages = [...byId.values()].sort((a, b) => {
		const left = (a as { id?: string }).id ?? "";
		const right = (b as { id?: string }).id ?? "";
		return messageOrder(left) - messageOrder(right);
	});
	// Session-level scalars follow the NEWER record (title, settings, tree,
	// phase inputs); usage logs union so no billed run is forgotten.
	const newer = incoming.updatedAt > local.updatedAt ? incoming : local;
	const older = newer === local ? incoming : local;
	return {
		record: {
			...older,
			...newer,
			messages: messages as ChatRecord["messages"],
			createdAt: local.createdAt < incoming.createdAt ? local.createdAt : incoming.createdAt,
			updatedAt: local.updatedAt > incoming.updatedAt ? local.updatedAt : incoming.updatedAt,
			turns: unionRuns(local.turns, incoming.turns, (run) => run.id, (run) => run.at) as ChatRecord["turns"],
			extractions: unionRuns(
				local.extractions,
				incoming.extractions,
				(run) => String(run.startedAt),
				(run) => run.at,
			) as ChatRecord["extractions"],
		},
	};
}

function mergeChats(local: ChatRecord[], incoming: ChatRecord[], tombstones: Set<string>, report: SyncReport): ChatRecord[] {
	const byId = new Map<string, ChatRecord>();
	for (const chat of local) if (!tombstones.has(chat.id)) byId.set(chat.id, chat);
	for (const chat of incoming) {
		if (tombstones.has(chat.id)) continue;
		const existing = byId.get(chat.id);
		if (existing === undefined) {
			byId.set(chat.id, chat);
			report.chatsTaken++;
			continue;
		}
		if (stable(existing) === stable(chat)) continue;
		const merged = mergeChat(existing, chat);
		if ("kind" in merged) {
			report.conflicts.push(merged);
			continue;
		}
		byId.set(chat.id, merged.record);
		report.chatsMerged++;
	}
	return [...byId.values()];
}

function mergeSources(local: NotesSource[], incoming: NotesSource[]): { sources: NotesSource[]; added: number } {
	const byId = new Map<string, NotesSource>();
	let added = 0;
	for (const source of local) byId.set(source.id, source);
	for (const source of incoming) {
		const existing = byId.get(source.id);
		if (existing === undefined) {
			byId.set(source.id, source);
			added++;
			continue;
		}
		// The usage log unions; everything else follows the record that has
		// seen more (a later import re-stamps filePath/importedAt).
		const extractions = unionRuns(
			existing.extractions,
			source.extractions,
			(run) => String(run.startedAt),
			(run) => run.at,
		);
		const winner = (source.extractions?.length ?? 0) > (existing.extractions?.length ?? 0) ? source : existing;
		byId.set(source.id, { ...winner, ...(extractions ? { extractions } : {}) });
	}
	return { sources: [...byId.values()], added };
}

/**
 * Merge the two sides. Pure: the caller owns reading and writing.
 *
 * `local` is the authority for ties (equal timestamps, equal records);
 * `incoming` only wins where it is strictly newer or strictly richer.
 */
export function mergeBundles(local: SyncBundle, incoming: SyncBundle): SyncResult {
	const report: SyncReport = {
		nodes: 0,
		chains: 0,
		coverage: 0,
		checkpoints: 0,
		deletions: 0,
		chatsTaken: 0,
		chatsMerged: 0,
		chatTombstones: 0,
		positionsFrom: "local",
		renderSettingsFrom: "local",
		sources: 0,
		conflicts: [],
	};

	const nodes = unionBy(local.nodes, incoming.nodes, nodeKey);
	const chains = unionBy(local.chains, incoming.chains, chainKeyOf);
	const coverage = unionBy(local.coverage, incoming.coverage, syncLineKeys.coverage);
	const checkpoints = unionBy(local.checkpoints, incoming.checkpoints, syncLineKeys.checkpoint);
	const deletions = unionBy(local.deletions, incoming.deletions, syncLineKeys.deletion);
	const chatTombstones = unionBy(local.chatTombstones, incoming.chatTombstones, syncLineKeys.chatTombstone);
	report.nodes = nodes.length - local.nodes.length;
	report.chains = chains.length - local.chains.length;
	report.coverage = coverage.length - local.coverage.length;
	report.checkpoints = checkpoints.length - local.checkpoints.length;
	report.deletions = deletions.length - local.deletions.length;
	report.chatTombstones = chatTombstones.length - local.chatTombstones.length;

	const tombstoned = new Set(chatTombstones.map((row) => row.id));
	const chats = mergeChats(local.chats, incoming.chats, tombstoned, report);

	// LWW for the two derived/preference blobs. An absent stamp reads as the
	// oldest possible write, so a stamped file always wins over an unstamped.
	const localPositionsStamp = local.positionsUpdatedAt ?? "";
	const incomingPositionsStamp = incoming.positionsUpdatedAt ?? "";
	const positions = incomingPositionsStamp > localPositionsStamp ? incoming.positions : local.positions;
	const positionsUpdatedAt =
		incomingPositionsStamp > localPositionsStamp ? incoming.positionsUpdatedAt : local.positionsUpdatedAt;
	report.positionsFrom = incomingPositionsStamp > localPositionsStamp ? "incoming" : "local";

	// render-settings carries no stamp of its own, so it does NOT take the
	// peer's copy on every sync (that would silently overwrite a local UI
	// preference): the local blob wins, and the incoming one only fills an
	// empty side.
	const takeIncomingRenderSettings = local.renderSettings === undefined || local.renderSettings === null;
	const renderSettings = takeIncomingRenderSettings ? incoming.renderSettings : local.renderSettings;
	report.renderSettingsFrom = takeIncomingRenderSettings ? "incoming" : "local";

	const merged = mergeSources(local.sources, incoming.sources);
	report.sources = merged.added;

	return {
		bundle: {
			nodes,
			chains,
			coverage,
			checkpoints,
			deletions,
			chats,
			chatTombstones,
			positions,
			positionsUpdatedAt,
			renderSettings,
			sources: merged.sources,
		},
		report,
	};
}
