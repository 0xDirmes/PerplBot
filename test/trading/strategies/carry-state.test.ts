/**
 * Tests for carry state persistence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CarryStateStore, CARRY_PHASES } from "../../../src/sdk/trading/strategies/carry-state.js";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DB_PATH = join(tmpdir(), `carry-test-${process.pid}.db`);

describe("CarryStateStore", () => {
  let store: CarryStateStore;

  beforeEach(() => {
    // Clean up any previous test DB
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = TEST_DB_PATH + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
    store = new CarryStateStore(TEST_DB_PATH);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = TEST_DB_PATH + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
  });

  describe("loadState", () => {
    it("returns null when no active state exists", () => {
      const state = store.loadState();
      expect(state).toBeNull();
    });

    it("returns most recent non-idle state", () => {
      store.saveState({
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "900000",
        perpSizeLns: "10000",
        perpMarginCns: "50000000",
        spotEntryPrice: "900000",
        spotSize: "10000000",
        fundingEarnedCns: "0",
        costsCns: "0",
        initialCapitalCns: "100000000000",
        lastTxHash: null,
      });

      const state = store.loadState();
      expect(state).not.toBeNull();
      expect(state!.phase).toBe("active");
      expect(state!.perpLegComplete).toBe(true);
      expect(state!.spotLegComplete).toBe(true);
    });
  });

  describe("saveState", () => {
    it("creates new state and returns id", () => {
      const id = store.saveState({
        phase: "entering",
        updatedAt: Date.now(),
        perpLegComplete: false,
        spotLegComplete: false,
        perpEntryPricePns: null,
        perpSizeLns: null,
        perpMarginCns: null,
        spotEntryPrice: null,
        spotSize: null,
        fundingEarnedCns: "0",
        costsCns: "0",
        initialCapitalCns: "500000000000",
        lastTxHash: null,
      });

      expect(id).toBeGreaterThan(0);

      const state = store.loadState();
      expect(state).not.toBeNull();
      expect(state!.phase).toBe("entering");
      expect(state!.initialCapitalCns).toBe("500000000000");
    });

    it("updates existing state by id", () => {
      const id = store.saveState({
        phase: "entering",
        updatedAt: Date.now(),
        perpLegComplete: false,
        spotLegComplete: false,
        perpEntryPricePns: null,
        perpSizeLns: null,
        perpMarginCns: null,
        spotEntryPrice: null,
        spotSize: null,
        fundingEarnedCns: "0",
        costsCns: "0",
        initialCapitalCns: "500000000000",
        lastTxHash: null,
      });

      // Update to active
      store.saveState({
        id,
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "870000",
        perpSizeLns: "285000",
        perpMarginCns: "124500000000",
        spotEntryPrice: "870000",
        spotSize: "284000000",
        fundingEarnedCns: "0",
        costsCns: "290000000",
        initialCapitalCns: "500000000000",
        lastTxHash: "0xabc123",
      });

      const state = store.loadState();
      expect(state!.id).toBe(id);
      expect(state!.phase).toBe("active");
      expect(state!.perpEntryPricePns).toBe("870000");
      expect(state!.perpSizeLns).toBe("285000");
      expect(state!.costsCns).toBe("290000000");
      expect(state!.lastTxHash).toBe("0xabc123");
    });
  });

  describe("markClosed", () => {
    it("transitions state to idle", () => {
      const id = store.saveState({
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "870000",
        perpSizeLns: "285000",
        perpMarginCns: "124500000000",
        spotEntryPrice: "870000",
        spotSize: "284000000",
        fundingEarnedCns: "2847000000",
        costsCns: "380000000",
        initialCapitalCns: "500000000000",
        lastTxHash: null,
      });

      store.markClosed(id, "2467000000");

      // loadState returns null for idle
      const state = store.loadState();
      expect(state).toBeNull();
    });
  });

  describe("TEXT precision for financial values", () => {
    it("preserves exact bigint values as TEXT (no float drift)", () => {
      const largeFunding = "999999999999999999"; // Near max safe int

      store.saveState({
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "12345678901234",
        perpSizeLns: "98765432109876",
        perpMarginCns: null,
        spotEntryPrice: null,
        spotSize: null,
        fundingEarnedCns: largeFunding,
        costsCns: "0",
        initialCapitalCns: largeFunding,
        lastTxHash: null,
      });

      const state = store.loadState();
      expect(state!.fundingEarnedCns).toBe(largeFunding);
      expect(state!.initialCapitalCns).toBe(largeFunding);
      expect(state!.perpEntryPricePns).toBe("12345678901234");
      expect(state!.perpSizeLns).toBe("98765432109876");
    });
  });

  describe("SQLite pragmas", () => {
    it("uses WAL journal mode", () => {
      const db = store.getDb();
      const mode = db.pragma("journal_mode", { simple: true });
      expect(mode).toBe("wal");
    });

    it("uses FULL synchronous mode", () => {
      const db = store.getDb();
      const sync = db.pragma("synchronous", { simple: true });
      // FULL = 2
      expect(sync).toBe(2);
    });

    it("has schema version set", () => {
      const db = store.getDb();
      const version = db.pragma("user_version", { simple: true });
      expect(version).toBe(1);
    });
  });

  describe("phase validation", () => {
    it("only allows valid phases", () => {
      for (const phase of CARRY_PHASES) {
        const id = store.saveState({
          phase,
          updatedAt: Date.now(),
          perpLegComplete: false,
          spotLegComplete: false,
          perpEntryPricePns: null,
          perpSizeLns: null,
          perpMarginCns: null,
          spotEntryPrice: null,
          spotSize: null,
          fundingEarnedCns: "0",
          costsCns: "0",
          initialCapitalCns: null,
          lastTxHash: null,
        });
        expect(id).toBeGreaterThan(0);

        // Clean up for next iteration (mark closed to allow another non-idle)
        store.markClosed(id, "0");
      }
    });

    it("rejects invalid phase", () => {
      expect(() =>
        store.saveState({
          phase: "invalid_phase" as any,
          updatedAt: Date.now(),
          perpLegComplete: false,
          spotLegComplete: false,
          perpEntryPricePns: null,
          perpSizeLns: null,
          perpMarginCns: null,
          spotEntryPrice: null,
          spotSize: null,
          fundingEarnedCns: "0",
          costsCns: "0",
          initialCapitalCns: null,
          lastTxHash: null,
        }),
      ).toThrow();
    });
  });

  describe("unique active constraint", () => {
    it("prevents two non-idle states", () => {
      store.saveState({
        phase: "active",
        updatedAt: Date.now(),
        perpLegComplete: true,
        spotLegComplete: true,
        perpEntryPricePns: "870000",
        perpSizeLns: "285000",
        perpMarginCns: null,
        spotEntryPrice: null,
        spotSize: null,
        fundingEarnedCns: "0",
        costsCns: "0",
        initialCapitalCns: null,
        lastTxHash: null,
      });

      // Second active state should fail due to unique index
      expect(() =>
        store.saveState({
          phase: "active",
          updatedAt: Date.now(),
          perpLegComplete: true,
          spotLegComplete: true,
          perpEntryPricePns: "880000",
          perpSizeLns: "300000",
          perpMarginCns: null,
          spotEntryPrice: null,
          spotSize: null,
          fundingEarnedCns: "0",
          costsCns: "0",
          initialCapitalCns: null,
          lastTxHash: null,
        }),
      ).toThrow();
    });
  });
});
