// Verifies host hook cleanup behavior for session-store state.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginHostRegistryRetirement, runPluginHostCleanup } from "./host-hook-cleanup.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";

const mocks = vi.hoisted(() => ({ cleanupInfo: vi.fn(), snapshots: vi.fn() }));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "plugins/cleanup" ? { ...logger, info: mocks.cleanupInfo } : logger;
    },
  };
});

vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: (pathname: string) => {
      mocks.snapshots(pathname);
      return actual.prepareSqliteReadOnlyLocationSync(pathname);
    },
  };
});

describe("plugin host cleanup session stores", () => {
  let stateDir: string | undefined;
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
  });

  it("leaves entries unchanged when cleanup finds no plugin-owned state", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-noop-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
      sessionId: "session-id",
      updatedAt: Date.now(),
    } satisfies SessionEntry);
    const before = loadSessionEntry({ sessionKey: "agent:main:main", storePath });

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "noop-plugin",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toEqual(before);
  });

  it("cleans healthy agent state without opening a refused agent store", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cleanup-admission-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await replaceSessionEntry(scope, {
      sessionId: "healthy",
      updatedAt: 1,
      pluginExtensions: { fixture: { active: true } },
    });
    recordAgentDatabaseAdmissions([
      {
        agentId: "cleaner",
        paths: [path.join(stateDir, "cleaner.sqlite")],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
        reason: "Refused agent cleaner",
        repairHint: "Inspect the copy.",
      },
    ]);
    try {
      const result = await runPluginHostCleanup({
        cfg: {},
        registry: createEmptyPluginRegistry(),
        pluginId: "fixture",
        reason: "disable",
        sessionStoreTargets: [
          { agentId: "cleaner", storePath: path.join(stateDir, "cleaner.sqlite") },
          { agentId: "main", storePath },
        ],
      });
      expect(result).toEqual({ cleanupCount: 1, failures: [] });
      expect(loadSessionEntry(scope)?.pluginExtensions).toBeUndefined();
      await expect(fs.stat(path.join(stateDir, "cleaner.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      recordAgentDatabaseAdmissions([]);
    }
  });

  it("retires 16 plugins on a cold state handle without opening deleted agents' kept stores", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cleanup-deleted-agent-" },
      async (state) => {
        const scopeFor = (agentId: string) => ({
          agentId,
          sessionKey: `agent:${agentId}:main`,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
        });
        // Discovery sorts agent folders: the live "work" store follows both kept stores.
        const live = [scopeFor("main"), scopeFor("work")];
        const kept = [scopeFor("finished"), scopeFor("unfinished")];
        const pluginIds = Array.from({ length: 16 }, (_, index) => `fixture-${index}`);
        const pluginExtensions = Object.fromEntries(pluginIds.map((id) => [id, { active: true }]));
        for (const scope of [...live, ...kept]) {
          await replaceSessionEntry(scope, {
            sessionId: scope.agentId,
            updatedAt: 1,
            pluginExtensions,
          });
        }
        for (const { agentId } of kept) {
          const deletion = beginAgentDeletionJournal({
            agentId,
            operationId: `delete-${agentId}`,
            agentDir: state.agentDir(agentId),
            workspaceDir: state.path(`workspace-${agentId}`),
            sessionsDir: state.sessionsDir(agentId),
            deleteFiles: false,
          });
          if (agentId === "finished") {
            runOpenClawStateWriteTransaction((database) =>
              completeAgentDeletionJournalInDatabase(
                database,
                deletion.agentId,
                deletion.operationId,
              ),
            );
          }
        }
        closeOpenClawAgentDatabasesForTest();
        const hashKeptDatabases = () =>
          Promise.all(
            kept.map(async ({ agentId }) =>
              createHash("sha256")
                .update(
                  await fs.readFile(path.join(state.agentDir(agentId), "openclaw-agent.sqlite")),
                )
                .digest("hex"),
            ),
          );
        const keptHashes = await hashKeptDatabases();
        // Live agent handles stay open while the idle shared-state handle is retired.
        for (const scope of live) {
          loadSessionEntry(scope);
        }
        closeOpenClawStateDatabaseForTest();
        const registry = createEmptyPluginRegistry();
        const instances = pluginIds.map((id) => {
          const record = createPluginRecord({ id });
          registry.plugins.push(record);
          return new PluginInstance(record.id, { record, registry });
        });
        mocks.cleanupInfo.mockClear();
        mocks.snapshots.mockClear();

        const result = await createPluginHostRegistryRetirement({
          cfg: {},
          previousRegistry: registry,
        })();

        // No fence errors and no forced retirement after the 5 s shutdown budget.
        expect(result).toEqual({ cleanupCount: 32, failures: [] });
        expect(instances.every((instance) => instance.disposing)).toBe(true);
        // One cold journal read serves every plugin and store.
        expect(mocks.snapshots).toHaveBeenCalledOnce();
        expect(mocks.cleanupInfo.mock.calls).toEqual(
          kept.map(({ agentId }) => [
            expect.stringMatching(
              new RegExp(`^Skipping plugin session cleanup for deleted agent ${agentId} store `),
            ),
          ]),
        );
        expect(await hashKeptDatabases()).toEqual(keptHashes);
        closeOpenClawAgentDatabasesForTest();
        for (const scope of live) {
          expect(loadSessionEntry(scope)?.pluginExtensions).toBeUndefined();
        }
      },
    );
  });

  it.each(["cancelled", "already-cleared", "locked", "revoked", "committed"] as const)(
    "revalidates queued cleanup and counts only committed changes (%s)",
    async (mode) => {
      stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cleanup-queued-")),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cleanup-target",
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      };
      await replaceSessionEntry(scope, {
        sessionId: "cleanup-target",
        updatedAt: 100,
        pluginExtensions: { fixture: { state: true }, other: { state: true } },
      });
      const before = loadSessionEntry(scope);
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "fixture",
        source: "test",
        harness: {
          id: "fixture-harness",
          label: "Fixture harness",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused test harness");
          },
        },
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const blocker = patchSessionEntryCore(
        scope,
        async (entry) => {
          entered.resolve();
          await release.promise;
          if (mode === "already-cleared") {
            entry.pluginExtensions = { other: { state: true } };
            return entry;
          }
          if (mode === "locked") {
            entry.modelSelectionLocked = true;
            entry.agentHarnessId = "fixture-harness";
            return entry;
          }
          return null;
        },
        { replaceEntry: true, skipMaintenance: true },
      );
      await entered.promise;
      let current = true;
      const revoked = new Error("session reset authority changed");
      const cleanup = runPluginHostCleanup({
        cfg: {},
        registry,
        reason: mode === "revoked" ? "reset" : "disable",
        pluginId: "fixture",
        sessionKey: scope.sessionKey,
        sessionStoreTargets: [{ agentId: scope.agentId, storePath: scope.storePath }],
        shouldCleanup: () => {
          if (!current && mode === "revoked") {
            throw revoked;
          }
          return current;
        },
      });
      const settled = Promise.allSettled([blocker, cleanup]);
      try {
        expect(
          [...SQLITE_SESSION_WRITER_QUEUES.values()].reduce(
            (count, queue) => count + queue.pending.length,
            0,
          ),
        ).toBe(1);
        current = mode !== "cancelled" && mode !== "revoked";
        release.resolve();
        const [blockedWrite, result] = await settled;
        expect(blockedWrite.status).toBe("fulfilled");
        expect(result).toEqual(
          mode === "revoked"
            ? { status: "rejected", reason: revoked }
            : {
                status: "fulfilled",
                value: { cleanupCount: mode === "committed" ? 1 : 0, failures: [] },
              },
        );
        const after = loadSessionEntry(scope);
        if (mode === "committed") {
          expect(after?.pluginExtensions).toEqual({ other: { state: true } });
          expect(after?.updatedAt).toBeGreaterThan(100);
        } else if (mode === "already-cleared") {
          expect(after).toEqual({ ...before, pluginExtensions: { other: { state: true } } });
        } else if (mode === "locked") {
          expect(after).toEqual({
            ...before,
            modelSelectionLocked: true,
            agentHarnessId: "fixture-harness",
          });
        } else {
          expect(after).toEqual(before);
        }
      } finally {
        release.resolve();
        await settled;
      }
    },
  );

  it("can defer persistent session-state cleanup to an atomic owner", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-deferred-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
      sessionId: "session-id",
      updatedAt: Date.now(),
      pluginExtensions: {
        test: {
          state: { active: true },
        },
      },
    } satisfies SessionEntry);

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      reason: "reset",
      sessionKey: "agent:main:main",
      skipPersistentSessionState: true,
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.pluginExtensions,
    ).toEqual({
      test: {
        state: { active: true },
      },
    });
  });

  it.each([
    [
      "Matrix group",
      "agent:main:matrix:group:!Room:server",
      "agent:main:matrix:group:!room:server",
      "AGENT:MAIN:MATRIX:GROUP:!Room:server",
    ],
    [
      "Matrix channel",
      "agent:main:matrix:channel:!Room:server",
      "agent:main:matrix:channel:!room:server",
      "agent:main:matrix:channel:!Room:server",
    ],
    [
      "Matrix thread",
      "agent:main:matrix:group:!Room:server:thread:$Event",
      "agent:main:matrix:group:!Room:server:thread:$event",
      "agent:main:matrix:group:!Room:server:THREAD:$Event",
    ],
    [
      "Signal group",
      "agent:main:signal:group:AbCdEf==",
      "agent:main:signal:group:abcdef==",
      "AGENT:MAIN:SIGNAL:GROUP:AbCdEf==",
    ],
  ])(
    "clears only the selected %s session's plugin state",
    async (_, targetKey, siblingKey, filter) => {
      stateDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-opaque-"),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const storePath = path.join(stateDir, "sessions.json");
      for (const [sessionKey, sessionId] of [
        [targetKey, "target"],
        [siblingKey, "sibling"],
      ] as const) {
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId,
          updatedAt: Date.now(),
          pluginExtensions: {
            cleanup: { state: { sessionId } },
            other: { state: { preserved: true } },
          },
          pluginNextTurnInjections: {
            cleanup: [
              {
                id: sessionId,
                pluginId: "cleanup",
                text: sessionId,
                placement: "append_context",
                createdAt: Date.now(),
              },
            ],
          },
        } satisfies SessionEntry);
      }
      const siblingBefore = loadSessionEntry({ sessionKey: siblingKey, storePath });
      expect(siblingBefore?.sessionId).toBe("sibling");

      const result = await runPluginHostCleanup({
        cfg: { session: { store: storePath } },
        registry: createEmptyPluginRegistry(),
        pluginId: "cleanup",
        reason: "delete",
        sessionKey: filter,
      });

      expect(result).toEqual({ cleanupCount: 1, failures: [] });
      closeOpenClawAgentDatabasesForTest();
      const target = loadSessionEntry({ sessionKey: targetKey, storePath });
      expect(target?.pluginExtensions).toEqual({ other: { state: { preserved: true } } });
      expect(target?.pluginNextTurnInjections).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: siblingKey, storePath })).toEqual(siblingBefore);
    },
  );

  it.each(["shared-session", "signal:group: Opaque"])(
    "matches runtime session ID %s case-insensitively without interpreting it as a key",
    async (runtimeSessionId) => {
      stateDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-multistore-"),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const firstStorePath = path.join(stateDir, "agents", "a", "sessions", "sessions.json");
      const secondStorePath = path.join(stateDir, "agents", "b", "sessions", "sessions.json");
      const beforeUpdatedAt = 100;
      const unrelatedUpdatedAt = Date.now();
      const firstEntry: SessionEntry = {
        sessionId: runtimeSessionId,
        updatedAt: beforeUpdatedAt,
        pluginExtensions: {
          cleanup: { state: { active: true } },
          other: { state: { preserved: true } },
        },
        pluginNextTurnInjections: {
          cleanup: [
            {
              id: "remove",
              pluginId: "cleanup",
              text: "remove",
              placement: "append_context",
              createdAt: beforeUpdatedAt,
            },
          ],
        },
      };
      const secondEntry: SessionEntry = {
        sessionId: runtimeSessionId,
        updatedAt: beforeUpdatedAt,
        pluginExtensions: {
          cleanup: { state: { active: true } },
        },
      };
      const unrelatedEntry: SessionEntry = {
        sessionId: "unrelated-session",
        updatedAt: unrelatedUpdatedAt,
        delivery: { kind: "none" },
        pluginExtensions: {
          cleanup: { state: { keep: true } },
        },
      };
      await replaceSessionEntry(
        { sessionKey: "agent:a:telegram:group:shared-room", storePath: firstStorePath },
        firstEntry,
      );
      await replaceSessionEntry(
        { sessionKey: "agent:a:telegram:group:unrelated-room", storePath: firstStorePath },
        unrelatedEntry,
      );
      await replaceSessionEntry(
        { sessionKey: "agent:b:telegram:group:shared-room", storePath: secondStorePath },
        secondEntry,
      );

      const result = await runPluginHostCleanup({
        cfg: { session: { store: firstStorePath } },
        registry: createEmptyPluginRegistry(),
        pluginId: "cleanup",
        reason: "disable",
        sessionKey: runtimeSessionId.toUpperCase(),
        sessionStoreTargets: [
          { agentId: "a", storePath: firstStorePath },
          { agentId: "b", storePath: secondStorePath },
        ],
      });

      expect(result).toEqual({ cleanupCount: 2, failures: [] });
      const firstMain = loadSessionEntry({
        sessionKey: "agent:a:telegram:group:shared-room",
        storePath: firstStorePath,
      });
      const firstUnrelated = loadSessionEntry({
        sessionKey: "agent:a:telegram:group:unrelated-room",
        storePath: firstStorePath,
      });
      const secondOther = loadSessionEntry({
        sessionKey: "agent:b:telegram:group:shared-room",
        storePath: secondStorePath,
      });
      expect(firstMain?.pluginExtensions).toEqual({
        other: { state: { preserved: true } },
      });
      expect(firstMain?.pluginNextTurnInjections).toBeUndefined();
      expect(firstMain?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
      expect(firstUnrelated).toEqual(unrelatedEntry);
      expect(secondOther?.pluginExtensions).toBeUndefined();
      expect(secondOther?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    },
  );

  it("clears shared custom SQLite stores for each resolved agent", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-shared-custom-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const sharedStorePath = path.join(stateDir, "custom", "sessions.json");
    const beforeUpdatedAt = 100;
    const entry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
      },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath: sharedStorePath },
      entry,
    );
    await replaceSessionEntry(
      { agentId: "work", sessionKey: "agent:work:main", storePath: sharedStorePath },
      entry,
    );

    const result = await runPluginHostCleanup({
      cfg: {
        session: { store: sharedStorePath },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      registry: createEmptyPluginRegistry(),
      pluginId: "cleanup",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const main = loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: sharedStorePath,
    });
    const work = loadSessionEntry({
      agentId: "work",
      sessionKey: "agent:work:main",
      storePath: sharedStorePath,
    });
    expect(main?.pluginExtensions).toBeUndefined();
    expect(main?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(work?.pluginExtensions).toBeUndefined();
    expect(work?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });

  it("preserves locked sessions for every harness owned by a disabled plugin", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-locked-harness-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const updatedAt = 100;
    const registry = createEmptyPluginRegistry();
    for (const harnessId of ["fixture-harness-a", "fixture-harness-b"]) {
      registry.agentHarnesses.push({
        pluginId: "fixture-plugin",
        source: "test",
        harness: {
          id: harnessId,
          label: harnessId,
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused test harness");
          },
        },
      });
    }
    registry.agentHarnesses.push({
      pluginId: "other-plugin",
      source: "test",
      harness: {
        id: "other-harness",
        label: "other-harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused test harness");
        },
      },
    });
    const seedEntries: Record<string, SessionEntry> = {
      "agent:main:harness-a:locked": {
        sessionId: "locked-session-a",
        updatedAt,
        agentHarnessId: "fixture-harness-a",
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": {
            supervision: {
              sourceThreadId: "native-thread-a",
              modelLocked: true,
            },
          },
        },
      } satisfies SessionEntry,
      "agent:main:harness-b:locked": {
        sessionId: "locked-session-b",
        updatedAt,
        agentHarnessId: "fixture-harness-b",
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": {
            supervision: {
              sourceThreadId: "native-thread-b",
              modelLocked: true,
            },
          },
        },
      } satisfies SessionEntry,
      "agent:main:other-harness:locked": {
        sessionId: "other-locked-session",
        updatedAt,
        agentHarnessId: "other-harness",
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": { transient: true },
        },
      } satisfies SessionEntry,
      "agent:main:ordinary": {
        sessionId: "ordinary-session",
        updatedAt,
        pluginExtensions: {
          "fixture-plugin": { transient: true },
        },
      } satisfies SessionEntry,
    };
    for (const [sessionKey, entry] of Object.entries(seedEntries)) {
      await replaceSessionEntry({ storePath, sessionKey }, entry);
    }

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry,
      pluginId: "fixture-plugin",
      reason: "disable",
      sessionStoreTargets: [{ agentId: "main", storePath }],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const readEntry = (sessionKey: string) => loadSessionEntry({ storePath, sessionKey });
    expect(readEntry("agent:main:harness-a:locked")).toMatchObject({
      updatedAt,
      agentHarnessId: "fixture-harness-a",
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: "native-thread-a", modelLocked: true },
        },
      },
    });
    expect(readEntry("agent:main:harness-b:locked")).toMatchObject({
      updatedAt,
      agentHarnessId: "fixture-harness-b",
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: "native-thread-b", modelLocked: true },
        },
      },
    });
    expect(readEntry("agent:main:other-harness:locked")?.pluginExtensions).toBeUndefined();
    expect(readEntry("agent:main:ordinary")?.pluginExtensions).toBeUndefined();
  });
});
