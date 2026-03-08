/**
 * Carry strategy state persistence
 * SQLite storage with TEXT for financial values (avoids IEEE 754 drift)
 *
 * Separate database file (./data/carry.db), not shared with Telegram bot.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// ── Types ────────────────────────────────────────────

export const CARRY_PHASES = ["idle", "entering", "active", "exiting"] as const;
export type CarryPhase = (typeof CARRY_PHASES)[number];

export interface CarryState {
  id: number;
  phase: CarryPhase;
  updatedAt: number; // Unix ms

  // Leg completion tracking (critical for crash recovery)
  perpLegComplete: boolean;
  spotLegComplete: boolean;

  // Position data (TEXT bigint strings, nullable when idle)
  perpEntryPricePns: string | null;
  perpSizeLns: string | null;
  perpMarginCns: string | null;
  spotEntryPrice: string | null;
  spotSize: string | null;

  // Running totals (TEXT to prevent float accumulation drift)
  fundingEarnedCns: string;
  costsCns: string;
  initialCapitalCns: string | null;

  // Last tx hash for reconciliation
  lastTxHash: string | null;
}

/** Raw SQLite row */
interface CarryStateRow {
  id: number;
  phase: string;
  updated_at: number;
  perp_leg_complete: number;
  spot_leg_complete: number;
  perp_entry_price_pns: string | null;
  perp_size_lns: string | null;
  perp_margin_cns: string | null;
  spot_entry_price: string | null;
  spot_size: string | null;
  funding_earned_cns: string;
  costs_cns: string;
  initial_capital_cns: string | null;
  last_tx_hash: string | null;
}

function rowToState(row: CarryStateRow): CarryState {
  return {
    id: row.id,
    phase: row.phase as CarryPhase,
    updatedAt: row.updated_at,
    perpLegComplete: row.perp_leg_complete === 1,
    spotLegComplete: row.spot_leg_complete === 1,
    perpEntryPricePns: row.perp_entry_price_pns,
    perpSizeLns: row.perp_size_lns,
    perpMarginCns: row.perp_margin_cns,
    spotEntryPrice: row.spot_entry_price,
    spotSize: row.spot_size,
    fundingEarnedCns: row.funding_earned_cns,
    costsCns: row.costs_cns,
    initialCapitalCns: row.initial_capital_cns,
    lastTxHash: row.last_tx_hash,
  };
}

// ── Database ─────────────────────────────────────────

const SCHEMA_VERSION = 1;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS carry_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase TEXT NOT NULL DEFAULT 'idle'
      CHECK (phase IN ('idle', 'entering', 'active', 'exiting')),
    updated_at INTEGER NOT NULL,

    perp_leg_complete INTEGER NOT NULL DEFAULT 0,
    spot_leg_complete INTEGER NOT NULL DEFAULT 0,

    perp_entry_price_pns TEXT,
    perp_size_lns TEXT,
    perp_margin_cns TEXT,
    spot_entry_price TEXT,
    spot_size TEXT,

    funding_earned_cns TEXT NOT NULL DEFAULT '0',
    costs_cns TEXT NOT NULL DEFAULT '0',
    initial_capital_cns TEXT,

    last_tx_hash TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_carry_active
    ON carry_state(phase) WHERE phase != 'idle';
`;

export class CarryStateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(CREATE_TABLE);

    // Schema versioning
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < SCHEMA_VERSION) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** Load the most recent non-idle state, or null if idle */
  loadState(): CarryState | null {
    const row = this.db
      .prepare(
        "SELECT * FROM carry_state WHERE phase != 'idle' ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as CarryStateRow | undefined;

    return row ? rowToState(row) : null;
  }

  /** Save or update carry state. Returns the row id. */
  saveState(state: Omit<CarryState, "id"> & { id?: number }): number {
    const now = Date.now();

    if (state.id) {
      this.db
        .prepare(
          `UPDATE carry_state SET
            phase = ?, updated_at = ?,
            perp_leg_complete = ?, spot_leg_complete = ?,
            perp_entry_price_pns = ?, perp_size_lns = ?, perp_margin_cns = ?,
            spot_entry_price = ?, spot_size = ?,
            funding_earned_cns = ?, costs_cns = ?, initial_capital_cns = ?,
            last_tx_hash = ?
          WHERE id = ?`,
        )
        .run(
          state.phase,
          now,
          state.perpLegComplete ? 1 : 0,
          state.spotLegComplete ? 1 : 0,
          state.perpEntryPricePns,
          state.perpSizeLns,
          state.perpMarginCns,
          state.spotEntryPrice,
          state.spotSize,
          state.fundingEarnedCns,
          state.costsCns,
          state.initialCapitalCns,
          state.lastTxHash,
          state.id,
        );
      return state.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO carry_state (
          phase, updated_at,
          perp_leg_complete, spot_leg_complete,
          perp_entry_price_pns, perp_size_lns, perp_margin_cns,
          spot_entry_price, spot_size,
          funding_earned_cns, costs_cns, initial_capital_cns,
          last_tx_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.phase,
        now,
        state.perpLegComplete ? 1 : 0,
        state.spotLegComplete ? 1 : 0,
        state.perpEntryPricePns,
        state.perpSizeLns,
        state.perpMarginCns,
        state.spotEntryPrice,
        state.spotSize,
        state.fundingEarnedCns,
        state.costsCns,
        state.initialCapitalCns,
        state.lastTxHash,
      );

    return Number(result.lastInsertRowid);
  }

  /** Mark a position as closed (transition to idle) */
  markClosed(id: number, finalPnlCns: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE carry_state SET
            phase = 'idle', updated_at = ?,
            perp_leg_complete = 0, spot_leg_complete = 0,
            funding_earned_cns = ?
          WHERE id = ?`,
        )
        .run(Date.now(), finalPnlCns, id);
    })();
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  /** Get database instance (for testing) */
  getDb(): Database.Database {
    return this.db;
  }
}
