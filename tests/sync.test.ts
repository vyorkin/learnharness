/**
 * Cross-machine sync (2026-10-26): deletion tombstones + the merge engine +
 * the CLI, end to end over two data dirs.
 *
 * The point of this suite: a deletion must SURVIVE a union. A rewrite (how one
 * machine forgets) is invisible to a merge, so the append-only tombstone is
 * what makes it travel — for graph ids (deleted.jsonl, filtered by createdAt)
 * and for chats (data/chats/deleted.jsonl, permanent).
 *
 * Ledger isolation: the data dir seam is set BEFORE any config-loading import
 * and every app-module import is dynamic.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { getGraph } = await import("../src/core/graph.ts");
const { deleteChatTraces, deleteNodeTraces } = await import("../src/core/graph-deletion.ts");
const { mergeBundles } = await import("../src/core/sync-merge.ts");
import type { SyncBundle } from "../src/core/sync-merge.ts";
const { CHAT_TOMBSTONES_FILE } = await import("../config.ts");
const { CURRENT_GRAPH_FORMAT_VERSION } = await import("../src/core/contracts/graph.ts");

const repoRoot = path.resolve(import.meta.dirname, "..");

function node(id: string, statement: string, createdAt: string, chatId = "chat_sync_a") {
	return {
		id,
		name: "Sync node",
		statement,
		aliases: [],
		createdAt,
		provenance: [{ chatId, messageId: "" }],
	};
}

describe("graph deletion tombstones (format v3)", () => {
	it("a node deletion leaves a tombstone that hides the node from every read", () => {
		graphStore.rewriteLedgers({ nodes: [], chains: [], deletions: [] });
		graphStore.appendNode(node("n_live", "A claim that stays.", "2026-01-01T00:00:00.000Z"));
		graphStore.appendNode(node("n_doomed", "A claim the user deletes.", "2026-01-01T00:00:00.000Z"));
		assert.equal(getGraph(graphStore).nodes.length, 2);

		const stats = deleteNodeTraces(graphStore, "n_doomed");
		assert.deepEqual(stats, { chainsRemoved: 0 });
		assert.deepEqual(
			graphStore.readDeletions().map((tombstone) => tombstone.id),
			["n_doomed"],
			"the destructive seam also stamped a tombstone",
		);
		assert.deepEqual(
			getGraph(graphStore).nodes.map((line) => line.id),
			["n_live"],
			"the derivation filters the tombstoned id",
		);
		assert.equal(getGraph(graphStore).nodes.length, 1);
	});

	it("re-learning the fact AFTER the deletion brings it back (the stamp is the cutoff, not a blacklist)", () => {
		const deletedAt = graphStore.readDeletions().find((tombstone) => tombstone.id === "n_doomed")!.deletedAt;
		const later = new Date(new Date(deletedAt).getTime() + 60_000).toISOString();
		graphStore.appendNode(node("n_doomed", "A claim the user deletes.", later));
		assert.ok(
			getGraph(graphStore).nodes.some((line) => line.id === "n_doomed"),
			"a line created after the tombstone survives it",
		);
	});

	it("a chat cascade tombstones only what died completely", () => {
		graphStore.rewriteLedgers({ nodes: [], chains: [], deletions: [] });
		graphStore.appendNode(node("n_shared", "Shared by two sessions.", "2026-01-01T00:00:00.000Z", "chat_sync_a"));
		graphStore.appendNode(node("n_shared", "Shared by two sessions.", "2026-01-01T00:00:00.000Z", "chat_sync_b"));
		graphStore.appendNode(node("n_orphan", "Only session A's.", "2026-01-01T00:00:00.000Z", "chat_sync_a"));
		graphStore.appendChain({
			id: "arg_sync",
			premises: ["n_shared"],
			conclusion: "n_orphan",
			createdAt: "2026-01-01T00:00:00.000Z",
			provenance: [{ chatId: "chat_sync_a", messageId: "" }],
		});

		deleteChatTraces(graphStore, "chat_sync_a", "delete-nodes");
		const tombstoned = new Set(graphStore.readDeletions().map((tombstone) => tombstone.id));
		assert.equal(tombstoned.has("n_orphan"), true, "the orphan died completely");
		assert.equal(tombstoned.has("arg_sync"), true, "its argument died with it");
		assert.equal(tombstoned.has("n_shared"), false, "a node with a surviving line is never tombstoned");
		assert.deepEqual(
			getGraph(graphStore).nodes.map((line) => line.id),
			["n_shared"],
			"the shared identity survives with session B's provenance",
		);
	});

	it("preserve-graph tombstones nothing — only bookkeeping dies", () => {
		const before = graphStore.readDeletions().length;
		graphStore.appendCoverage({ chatId: "chat_sync_b", fp: "fp", tokens: 1, foldedAt: "2026-01-01T00:00:00.000Z" });
		const stats = deleteChatTraces(graphStore, "chat_sync_b", "preserve-graph");
		assert.equal(stats.nodesRemoved, 0);
		assert.equal(graphStore.readDeletions().length, before, "no graph id died, so no tombstone");
	});
});

describe("chat deletion tombstones", () => {
	it("a deleted chat is hidden even when its record comes back from a peer", () => {
		const chat = chatStore.createChat("Tombstoned session");
		assert.ok(chatStore.getChat(chat.id));
		assert.ok(chatStore.listChats().some((summary) => summary.id === chat.id));

		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(chatStore.getChat(chat.id), null);
		assert.equal(chatStore.listChats().some((summary) => summary.id === chat.id), false);
		const tombstones = fs
			.readFileSync(CHAT_TOMBSTONES_FILE, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { id: string });
		assert.deepEqual(tombstones.map((tombstone) => tombstone.id), [chat.id]);

		// The peer still has the record: a union without the tombstone would
		// resurrect it. The adapter must refuse it on read.
		fs.writeFileSync(
			path.join(TMP_DATA, "chats", `${chat.id}.json`),
			JSON.stringify({ ...chat, messages: [], version: 1 }, null, "\t"),
			"utf-8",
		);
		assert.equal(chatStore.getChat(chat.id), null, "a tombstoned id never comes back");
	});
});

describe("the merge engine (pure)", () => {
	const emptyBundle = (): SyncBundle => ({
		nodes: [],
		chains: [],
		coverage: [],
		checkpoints: [],
		deletions: [],
		chats: [],
		chatTombstones: [],
		positions: {},
		positionsUpdatedAt: undefined,
		renderSettings: undefined,
		sources: [],
	});

	it("unions ledgers, dedupes identical lines and keeps differing link-appends", () => {
		const local = emptyBundle();
		local.nodes = [node("n_one", "One fact.", "2026-01-01T00:00:00.000Z")];
		local.coverage = [{ chatId: "chat_a", fp: "fp1", tokens: 10, foldedAt: "2026-01-01T00:00:00.000Z" }];
		const incoming = emptyBundle();
		incoming.nodes = [
			node("n_one", "One fact.", "2026-01-01T00:00:00.000Z"), // exact same line
			node("n_one", "One fact, said again.", "2026-01-02T00:00:00.000Z", "chat_b"), // a link-append
			node("n_two", "Another fact.", "2026-01-02T00:00:00.000Z", "chat_b"),
		];
		incoming.coverage = [
			{ chatId: "chat_a", fp: "fp1", tokens: 10, foldedAt: "2026-01-01T00:00:00.000Z" }, // dup
			{ chatId: "chat_b", fp: "fp2", tokens: 12, foldedAt: "2026-01-02T00:00:00.000Z" },
		];

		const { bundle, report } = mergeBundles(local as never, incoming as never);
		assert.equal(bundle.nodes.length, 3, "one duplicate dropped, the link-append kept");
		assert.equal(report.nodes, 2);
		assert.deepEqual(
			bundle.coverage.map((entry) => entry.fp).sort(),
			["fp1", "fp2"],
			"coverage is content-addressed: the same fingerprint is one row",
		);
	});

	it("merges a chat both sides continued, ordering by message id", () => {
		const local = emptyBundle();
		const incoming = emptyBundle();
		const base = { title: "Shared session", createdAt: "2026-01-01T00:00:00.000Z", version: 1, messages: [] };
		const m1 = { id: "msg_m1_aaaaaaaa", role: "user" };
		const m2 = { id: "msg_m2_bbbbbbbb", role: "assistant" };
		const m3 = { id: "msg_m3_cccccccc", role: "user" };
		local.chats = [{ ...base, id: "chat_sync_merge", updatedAt: "2026-01-01T00:01:00.000Z", messages: [m1, m3] } as never];
		incoming.chats = [{ ...base, id: "chat_sync_merge", updatedAt: "2026-01-01T00:02:00.000Z", messages: [m1, m2] } as never];

		const { bundle, report } = mergeBundles(local as never, incoming as never);
		assert.equal(report.conflicts.length, 0);
		assert.deepEqual(
			bundle.chats[0]!.messages.map((message) => (message as { id: string }).id),
			[m1.id, m2.id, m3.id],
			"union by message id, in write order",
		);
		assert.equal(report.chatsMerged, 1);
	});

	it("reports a genuine conflict instead of guessing when one message differs", () => {
		const local = emptyBundle();
		const incoming = emptyBundle();
		const base = { title: "Conflicting", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", version: 1 };
		local.chats = [{ ...base, id: "chat_sync_conflict", messages: [{ id: "msg_m1_aaaaaaaa", text: "mine" }] } as never];
		incoming.chats = [{ ...base, id: "chat_sync_conflict", messages: [{ id: "msg_m1_aaaaaaaa", text: "theirs" }] } as never];

		const { report, bundle } = mergeBundles(local as never, incoming as never);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]!.messageId, "msg_m1_aaaaaaaa");
		assert.equal(
			(bundle.chats[0]!.messages[0] as unknown as { text: string }).text,
			"mine",
			"the local message survives; the incoming copy is parked by the caller",
		);
	});

	it("takes positions last-write-wins and drops chats tombstoned on either side", () => {
		const local = emptyBundle();
		const incoming = emptyBundle();
		local.positions = { n_a: { x: 1, y: 1 } };
		local.positionsUpdatedAt = "2026-01-01T00:00:00.000Z";
		incoming.positions = { n_b: { x: 2, y: 2 } };
		incoming.positionsUpdatedAt = "2026-01-02T00:00:00.000Z";
		const base = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 1, messages: [] };
		local.chats = [{ ...base, id: "chat_sync_dead", title: "Dead" } as never];
		incoming.chatTombstones = [{ id: "chat_sync_dead", deletedAt: "2026-01-03T00:00:00.000Z" }];

		const { bundle, report } = mergeBundles(local as never, incoming as never);
		assert.equal(report.positionsFrom, "incoming");
		assert.deepEqual(bundle.positions, { n_b: { x: 2, y: 2 } });
		assert.equal(bundle.chats.length, 0, "a tombstoned chat never survives the union");
		assert.equal(report.chatTombstones, 1);
	});
});

describe("the CLI over two data dirs", () => {
	function dataDir(name: string): string {
		const dir = path.join(TMP_DATA, name);
		fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
		fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
		fs.writeFileSync(path.join(dir, "graph", "format.json"), JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }), "utf-8");
		return dir;
	}

	function writeNodeLine(dir: string, line: unknown): void {
		fs.appendFileSync(path.join(dir, "graph", "nodes.jsonl"), `${JSON.stringify(line)}\n`, "utf-8");
	}

	function writeChat(dir: string, id: string, messages: unknown[]): void {
		fs.writeFileSync(
			path.join(dir, "chats", `${id}.json`),
			JSON.stringify(
				{
					id,
					title: id,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					messages,
					version: 1,
				},
				null,
				"\t",
			),
			"utf-8",
		);
	}

	function sync(args: string[]): string {
		return execFileSync("npx", ["tsx", "scripts/lh-sync.ts", ...args], {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	it("pulls, merges, pushes; a second run is a no-op; a deletion travels", () => {
		const a = dataDir("peer-a");
		const b = dataDir("peer-b");
		writeNodeLine(a, node("n_a", "Only A knows this.", "2026-01-01T00:00:00.000Z", "chat_a"));
		writeNodeLine(b, node("n_b", "Only B knows this.", "2026-01-01T00:00:00.000Z", "chat_b"));
		writeChat(a, "chat_a", [{ id: "msg_m1_aaaaaaaa", text: "a" }]);
		writeChat(b, "chat_b", [{ id: "msg_m1_bbbbbbbb", text: "b" }]);
		// B deleted a chat that A still has.
		fs.writeFileSync(path.join(b, "chats", "deleted.jsonl"), `${JSON.stringify({ id: "chat_a", deletedAt: "2026-01-02T00:00:00.000Z" })}\n`, "utf-8");

		const first = sync(["--peer-dir", b, "--data", a]);
		assert.match(first, /\+1 node lines/);

		const nodesA = fs.readFileSync(path.join(a, "graph", "nodes.jsonl"), "utf-8");
		const nodesB = fs.readFileSync(path.join(b, "graph", "nodes.jsonl"), "utf-8");
		assert.match(nodesA, /n_a/);
		assert.match(nodesA, /n_b/, "A pulled B's node");
		assert.match(nodesB, /n_a/, "B received A's node on the push");
		assert.deepEqual(
			nodesA.trim().split("\n").length,
			2,
			"one line per node, no duplicates after the union",
		);

		const second = sync(["--peer-dir", b, "--data", a]);
		assert.match(second, /nothing new/);
		assert.equal(fs.readFileSync(path.join(a, "graph", "nodes.jsonl"), "utf-8"), nodesA, "a no-op sync rewrites nothing");
	});

	it("refuses to sync a peer that was never migrated to content-addressed ids", () => {
		const legacy = path.join(TMP_DATA, "legacy-peer");
		fs.mkdirSync(path.join(legacy, "graph"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "graph", "format.json"), JSON.stringify({ version: 1 }), "utf-8");
		const a = dataDir("migrated-local");
		assert.throws(
			() => sync(["--peer-dir", legacy, "--data", a]),
			(err: unknown) => String(err).includes("REFUSED") || String(err).includes("migrate"),
			"a v1 peer is refused loudly rather than duplicating its graph",
		);
		assert.equal(fs.existsSync(path.join(a, "graph", "nodes.jsonl")), false, "nothing was written");
	});
});
