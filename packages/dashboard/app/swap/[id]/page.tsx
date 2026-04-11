"use client";

/**
 * packages/dashboard/app/swap/[id]/page.tsx
 *
 * Individual swap detail page — a full block-explorer-style view of
 * one atomic swap from negotiation through settlement.
 *
 * Data source: GET /swap/:id on the Express server.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { SERVER_URL, type CriteriaScores } from "../../../hooks/useSSE.js";
import { ArbitratorPanel } from "../../../components/ArbitratorPanel.js";
import {
  getEtherscanUrl,
  getLightningExplorerUrl,
  formatSats,
  formatWei,
  truncateHash,
  formatUnixTimestamp,
  formatISOTime,
} from "../../../lib/explorerLinks.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SwapDetailRecord {
  id:    string;
  state: string;
  proposal?: {
    id:               string;
    taskDescription:  string;
    btcAmountSats:    string;
    ethAmountWei:     string;
    timelock_btc_hours: number;
    timelock_eth_hours: number;
    preimageHash:     string;
    createdAt:        string;
    updatedAt:        string;
  };
  btcReceipt?: {
    chain:         "btc";
    txId:          string;
    lockTime:      number;
    amount:        string;
    preimageHash:  string;
    invoice?:      string;
  };
  ethReceipt?: {
    chain:           "eth";
    txId:            string;
    lockTime:        number;
    amount:          string;
    preimageHash:    string;
    contractAddress?: string;
  };
  arbitratorReasoning?: string;
  qualityScore?:        number;
  criteriaScores?:      CriteriaScores;
  settledAt?:           number;
  verdict?: {
    approved:     boolean;
    qualityScore: number;
    reasoning:    string;
    preimage?:    string;
    timestamp:    string;
  };
  messages: {
    role:      string;
    content:   string;
    timestamp: string;
    swapId:    string;
  }[];
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#444] pb-1 border-b" style={{ borderColor: "#1e1e1e" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function KVRow({ label, value, mono = true, accent }: { label: string; value: string; mono?: boolean; accent?: string }) {
  return (
    <div className="flex items-start justify-between gap-6 py-1 border-b" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
      <span className="text-[10px] uppercase tracking-widest text-[#444] flex-shrink-0 pt-0.5">{label}</span>
      <span
        className={`text-right break-all ${mono ? "stat-mono" : ""} text-[12px] leading-relaxed`}
        style={{ color: accent ?? "#bbb" }}
      >
        {value}
      </span>
    </div>
  );
}

function StateBadgeLarge({ state }: { state: string }) {
  const cfg: Record<string, { color: string; bg: string }> = {
    SETTLED:     { color: "#22c55e",  bg: "rgba(34,197,94,0.12)" },
    REFUNDED:    { color: "#ef4444",  bg: "rgba(239,68,68,0.12)" },
    EVALUATING:  { color: "#F59E0B",  bg: "rgba(245,158,11,0.12)" },
    LOCKED:      { color: "#F7931A",  bg: "rgba(247,147,26,0.12)" },
    NEGOTIATING: { color: "#7F77DD",  bg: "rgba(127,119,221,0.12)" },
    APPROVED:    { color: "#22c55e",  bg: "rgba(34,197,94,0.08)" },
  };
  const s = cfg[state] ?? { color: "#666", bg: "rgba(255,255,255,0.05)" };

  return (
    <span
      className="text-sm font-bold font-mono px-4 py-1.5 rounded-full"
      style={{ color: s.color, background: s.bg, border: `1px solid ${s.color}35` }}
    >
      {state}
    </span>
  );
}

function RoleColor(role: string): string {
  const map: Record<string, string> = {
    buyer:      "#7F77DD",
    seller:     "#1D9E75",
    arbitrator: "#F59E0B",
    system:     "#6b7280",
  };
  return map[role] ?? "#888";
}

// ── MessageThread ─────────────────────────────────────────────────────────────

function MessageThread({ messages }: { messages: SwapDetailRecord["messages"] }) {
  if (messages.length === 0) {
    return <p className="text-[#444] text-sm italic">No messages recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {messages.map((msg, i) => {
        const color = RoleColor(msg.role);
        const isArbitrator = msg.role === "arbitrator";

        return (
          <div
            key={`${msg.timestamp}-${i}`}
            className="rounded-lg border px-4 py-3"
            style={{
              background:  isArbitrator ? "rgba(245,158,11,0.04)" : "rgba(255,255,255,0.025)",
              borderColor: isArbitrator ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.06)",
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest" style={{ color }}>
                  {msg.role}
                </span>
              </div>
              <span className="text-[10px] font-mono text-[#444]">{formatISOTime(msg.timestamp)}</span>
            </div>
            <p className="text-sm text-[#bbb] whitespace-pre-wrap break-words leading-relaxed">
              {msg.content}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ── HTLCCard ──────────────────────────────────────────────────────────────────

function HTLCCard({
  title,
  color,
  icon,
  txId,
  amount,
  chain,
  lockTime,
  preimageHash,
  contractAddress,
  invoice,
}: {
  title:            string;
  color:            string;
  icon:             string;
  txId:             string;
  amount:           string;
  chain:            "btc" | "eth";
  lockTime:         number;
  preimageHash:     string;
  contractAddress?: string;
  invoice?:         string;
}) {
  const explorerHref = chain === "eth"
    ? getEtherscanUrl(txId, "sepolia")
    : getLightningExplorerUrl(txId);
  const explorerLabel = chain === "eth" ? "Etherscan ↗" : "1ML ↗";

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: `${color}07`, borderColor: `${color}25` }}
    >
      <div
        className="px-4 py-2.5 flex items-center justify-between border-b"
        style={{ background: `${color}10`, borderColor: `${color}20` }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-7 w-7 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ background: `${color}20`, color }}
          >
            {icon}
          </span>
          <span className="font-bold text-sm" style={{ color }}>{title}</span>
        </div>
        <a
          href={explorerHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] px-2.5 py-0.5 rounded-lg font-semibold transition-opacity hover:opacity-80"
          style={{ color, background: `${color}15`, border: `1px solid ${color}30` }}
        >
          {explorerLabel}
        </a>
      </div>

      <div className="px-4 py-1">
        <KVRow label="Tx / Lock ID"   value={txId}           />
        <KVRow label="Amount"         value={chain === "btc" ? formatSats(amount) : formatWei(amount)} />
        <KVRow label="Preimage Hash"  value={truncateHash(preimageHash, 20)} />
        <KVRow label="Expires"        value={formatUnixTimestamp(lockTime)} />
        {contractAddress && <KVRow label="Contract"      value={contractAddress} />}
        {invoice         && <KVRow label="Invoice"       value={truncateHash(invoice, 30)} />}
      </div>
    </div>
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────────

const STATE_ORDER = ["NEGOTIATING", "LOCKED", "EVALUATING", "APPROVED", "SETTLED"];
const REFUND_ORDER = ["NEGOTIATING", "LOCKED", "REFUNDED"];

function Timeline({ state }: { state: string }) {
  const isRefunded = state === "REFUNDED";
  const order = isRefunded ? REFUND_ORDER : STATE_ORDER;
  const currentIdx = order.indexOf(state === "APPROVED" ? "APPROVED" : state);

  const colors: Record<string, string> = {
    NEGOTIATING: "#7F77DD",
    LOCKED:      "#F7931A",
    EVALUATING:  "#F59E0B",
    APPROVED:    "#84cc16",
    SETTLED:     "#22c55e",
    REFUNDED:    "#ef4444",
  };

  return (
    <div className="flex items-center gap-0">
      {order.map((s, i) => {
        const isDone   = i < currentIdx || (i === currentIdx && ["SETTLED", "REFUNDED"].includes(state));
        const isActive = i === currentIdx && !isDone;
        const color    = colors[s] ?? "#666";

        return (
          <div key={s} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1 flex-shrink-0">
              <div
                className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold"
                style={{
                  background:  isDone ? `${color}20` : isActive ? `${color}18` : "rgba(255,255,255,0.04)",
                  border:      isDone ? `1.5px solid ${color}70` : isActive ? `2px solid ${color}` : "1.5px solid rgba(255,255,255,0.1)",
                  color:       isDone || isActive ? color : "#555",
                }}
              >
                {isDone ? "✓" : i + 1}
              </div>
              <span
                className="text-[9px] font-mono font-semibold uppercase"
                style={{ color: isDone || isActive ? color : "#444" }}
              >
                {s.slice(0, 8)}
              </span>
            </div>
            {i < order.length - 1 && (
              <div
                className="flex-1 h-px mx-1"
                style={{
                  background: isDone
                    ? `linear-gradient(90deg, ${color}60, ${colors[order[i + 1] as string] ?? "#666"}40)`
                    : "rgba(255,255,255,0.07)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SwapDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;

  const [record,  setRecord]  = useState<SwapDetailRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;

    fetch(`${SERVER_URL}/swap/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<SwapDetailRecord>;
      })
      .then((data) => { setRecord(data); setLoading(false); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [id]);

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "#0f0f0f" }}>
        <div className="text-center space-y-3">
          <div className="stat-mono text-2xl font-black text-[#333] breathe">⚡</div>
          <p className="text-sm text-[#444]">Loading swap {id.slice(0, 8)}…</p>
        </div>
      </div>
    );
  }

  if (error || !record) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4" style={{ background: "#0f0f0f" }}>
        <p className="text-sm text-[#ef4444]">⚠️ {error ?? "Swap not found"}</p>
        <Link href="/" className="text-[11px] text-[#7F77DD] hover:opacity-80 transition-opacity">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const hasVerdict = !!(
    (record.arbitratorReasoning || record.verdict?.reasoning) &&
    (record.qualityScore !== undefined || record.verdict?.qualityScore !== undefined)
  );

  const score    = record.qualityScore ?? record.verdict?.qualityScore ?? 0;
  const reasoning = record.arbitratorReasoning ?? record.verdict?.reasoning ?? "";
  const approved = record.state === "SETTLED" || record.verdict?.approved === true;

  const durationSec = record.settledAt && record.proposal?.createdAt
    ? Math.round((record.settledAt - new Date(record.proposal.createdAt).getTime()) / 1000)
    : null;

  return (
    <div className="min-h-screen" style={{ background: "#0f0f0f" }}>

      {/* ── Top nav ── */}
      <nav
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b"
        style={{ background: "#0d0d0d", borderColor: "#1e1e1e" }}
      >
        <Link
          href="/"
          className="flex items-center gap-2 text-[11px] text-[#555] hover:text-[#888] transition-colors"
        >
          <span>←</span>
          <span>Dashboard</span>
        </Link>

        <div className="flex items-center gap-3">
          <span className="stat-mono text-[11px] text-[#444]">{id}</span>
          <StateBadgeLarge state={record.state} />
        </div>

        {durationSec !== null && (
          <div className="text-[11px] font-mono text-[#444]">
            {durationSec}s end-to-end
          </div>
        )}
      </nav>

      {/* ── Content ── */}
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-10">

        {/* ── Overview ── */}
        <Section title="Swap Overview">
          <div className="grid grid-cols-2 gap-4">
            <div
              className="rounded-xl border p-4 space-y-1"
              style={{ background: "var(--color-bg-card)", borderColor: "#272727" }}
            >
              <KVRow label="Swap ID"  value={record.id ?? id} />
              <KVRow label="State"    value={record.state} accent={
                record.state === "SETTLED" ? "#22c55e" :
                record.state === "REFUNDED" ? "#ef4444" : "#888"
              } />
              {record.proposal?.taskDescription && (
                <KVRow label="Task" value={record.proposal.taskDescription} mono={false} />
              )}
              {record.proposal?.createdAt && (
                <KVRow label="Created" value={new Date(record.proposal.createdAt).toLocaleString()} mono={false} />
              )}
              {record.settledAt && (
                <KVRow label="Settled" value={new Date(record.settledAt).toLocaleString()} mono={false} />
              )}
            </div>

            {/* Timeline */}
            <div
              className="rounded-xl border p-4 flex flex-col justify-center"
              style={{ background: "var(--color-bg-card)", borderColor: "#272727" }}
            >
              <div className="text-[10px] uppercase tracking-widest text-[#444] mb-4">State Timeline</div>
              <Timeline state={record.state} />
            </div>
          </div>
        </Section>

        {/* ── Proposal ── */}
        {record.proposal && (
          <Section title="Agreed Proposal">
            <div
              className="rounded-xl border p-4"
              style={{ background: "var(--color-bg-card)", borderColor: "#272727" }}
            >
              <KVRow label="BTC Amount"       value={formatSats(record.proposal.btcAmountSats)} />
              <KVRow label="ETH Amount"       value={formatWei(record.proposal.ethAmountWei)} />
              <KVRow label="BTC Timelock"     value={`${record.proposal.timelock_btc_hours}h`} />
              <KVRow label="ETH Timelock"     value={`${record.proposal.timelock_eth_hours}h`} />
              <KVRow label="Preimage Hash"    value={truncateHash(record.proposal.preimageHash, 20)} />
            </div>
          </Section>
        )}

        {/* ── HTLC Details ── */}
        {(record.btcReceipt || record.ethReceipt) && (
          <Section title="HTLC Parameters">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {record.btcReceipt && (
                <HTLCCard
                  title          ="Bitcoin Lightning"
                  color          ="#F7931A"
                  icon           ="₿"
                  chain          ="btc"
                  txId           ={record.btcReceipt.txId}
                  amount         ={record.btcReceipt.amount}
                  lockTime       ={record.btcReceipt.lockTime}
                  preimageHash   ={record.btcReceipt.preimageHash}
                  invoice        ={record.btcReceipt.invoice}
                />
              )}
              {record.ethReceipt && (
                <HTLCCard
                  title           ="Ethereum"
                  color           ="#627EEA"
                  icon            ="Ξ"
                  chain           ="eth"
                  txId            ={record.ethReceipt.txId}
                  amount          ={record.ethReceipt.amount}
                  lockTime        ={record.ethReceipt.lockTime}
                  preimageHash    ={record.ethReceipt.preimageHash}
                  contractAddress ={record.ethReceipt.contractAddress}
                />
              )}
            </div>
          </Section>
        )}

        {/* ── Preimage (settled only) ── */}
        {(record.state === "SETTLED" && record.verdict?.preimage) && (
          <Section title="Settlement Preimage">
            <div
              className="rounded-xl border p-4"
              style={{
                background:  "rgba(34,197,94,0.04)",
                borderColor: "rgba(34,197,94,0.25)",
                boxShadow:   "0 0 20px rgba(34,197,94,0.06)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="h-2 w-2 rounded-full bg-[#22c55e]" style={{ boxShadow: "0 0 6px #22c55e" }} />
                <span className="text-[11px] text-[#22c55e] uppercase tracking-widest">
                  Preimage Revealed — Both chains unlocked simultaneously
                </span>
              </div>
              <div className="stat-mono text-sm text-[#22c55e] break-all select-all leading-relaxed">
                {record.verdict.preimage}
              </div>
              <p className="text-[10px] text-[#555] mt-2 leading-relaxed">
                This 32-byte secret was generated by the buyer before funds were locked.
                The same secret unlocks the Lightning HTLC (via SHA-256 preimage) and
                the Ethereum HTLC (via keccak256 preimage), proving both settlements are atomic.
              </p>
            </div>
          </Section>
        )}

        {/* ── Arbitrator Verdict ── */}
        {hasVerdict && (
          <Section title="Arbitrator Evaluation">
            <ArbitratorPanel
              approved  ={approved}
              score     ={score}
              reasoning ={reasoning}
              criteria  ={record.criteriaScores}
              visible   ={true}
            />
          </Section>
        )}

        {/* ── Agent Conversation ── */}
        <Section title={`Agent Conversation (${record.messages.length} messages)`}>
          <MessageThread messages={record.messages} />
        </Section>

      </div>
    </div>
  );
}
