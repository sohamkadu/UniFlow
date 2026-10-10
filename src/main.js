// UniFlow — unified cross-chain USDC dashboard
// Built on Circle App Kit + Arc Testnet
// Arc docs: https://docs.arc.io  |  Circle Gateway: https://developers.circle.com/gateway

import "./style.css";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, http } from "viem";

// ---------------------------------------------------------------------------
// Chain configs
// All RPC URLs and chain IDs sourced from https://docs.arc.io/arc/references/
// Arc Testnet chain ID: 5042002 (0x4CEF52)
// Arc uses USDC as native gas — 18-decimal native view, 6-decimal ERC-20 view.
// Never sum or swap the two views: they are the same asset.
// ---------------------------------------------------------------------------
const CHAINS = {
  Arc_Testnet: {
    label: "Arc Testnet",
    // Chain ID 5042002 per https://docs.arc.io — hex 0x4CEF52
    chainId: 5042002,
    chainIdHex: "0x4CEF52",
    viemChain: {
      id: 5042002,
      name: "Arc Testnet",
      // USDC is native gas on Arc — 18-decimal native view only for gas math
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      // Canonical RPC from Arc docs — wss also available at wss://rpc.testnet.arc.io
      rpcUrls: {
        default: { http: ["https://rpc.testnet.arc.io"] },
        webSocket: { http: ["wss://rpc.testnet.arc.io"] },
      },
      blockExplorers: {
        default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
      },
    },
  },
  Base_Sepolia: {
    label: "Base Sepolia",
    chainId: 84532,
    chainIdHex: "0x14A34",
    viemChain: {
      id: 84532,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
      blockExplorers: {
        default: { name: "BaseScan", url: "https://sepolia.basescan.org" },
      },
    },
  },
  Arbitrum_Sepolia: {
    label: "Arbitrum Sepolia",
    chainId: 421614,
    chainIdHex: "0x66EEE",
    viemChain: {
      id: 421614,
      name: "Arbitrum Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      // Use the official Arbitrum Sepolia RPC first — it provides the most
      // accurate fee history. The others are fallbacks.
      rpcUrls: {
        default: {
          http: [
            "https://sepolia-rollup.arbitrum.io/rpc",
            "https://arbitrum-sepolia.drpc.org",
            "https://rpc.ankr.com/arbitrum_sepolia",
          ],
        },
      },
      blockExplorers: {
        default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" },
      },
      // fees: override viem's default fee estimation to add a 30% buffer
      // on top of the fetched baseFee. Arbitrum Sepolia base fees fluctuate
      // and a tight estimate triggers FeeCapTooLowError.
      fees: {
        estimateFeesPerGas: async ({ client }) => {
          const block = await client.getBlock({ blockTag: "latest" });
          const baseFee = block.baseFeePerGas ?? 100_000_000n;
          // 130% of baseFee to stay above the block base fee
          const maxFeePerGas = (baseFee * 130n) / 100n;
          const maxPriorityFeePerGas = 1_000_000n; // 0.001 gwei tip
          return { maxFeePerGas, maxPriorityFeePerGas };
        },
      },
    },
  },
};

// SDK-level chain name strings required by @circle-fin/app-kit
// These exact strings come from the Circle SDK's supported chains table.
const CHAIN_SDK_NAME = {
  Arc_Testnet: "Arc_Testnet",
  Base_Sepolia: "Base_Sepolia",
  Arbitrum_Sepolia: "Arbitrum_Sepolia",
};

// Spend always settles on Arc Testnet — USDC as native gas means instant finality
const SPEND_DESTINATION_CHAIN = "Arc_Testnet";

// Balance polling
// Source-chain receipt: poll every 2 s for up to 2 min.
const RECEIPT_POLL_INTERVAL_MS = 2_000;
const RECEIPT_POLL_ATTEMPTS = 60;
// Gateway balance: with CCTP V2 Fast Transfer the credit arrives in ~8-20 s
// after the source tx confirms. Poll every 3 s for up to 90 s.
const GATEWAY_POLL_INTERVAL_MS = 3_000;
const GATEWAY_POLL_ATTEMPTS = 30;
const AUTO_REFRESH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
// App Kit singleton — no kit key required for unified balance operations
const kit = new AppKit();
const LEDGER_STORAGE_KEY = "arc-unified-balance-ledger";

let userAddress = null;
let currentBalances = null;
const ledger = [];
let autoRefreshTimer = null;
let _countUpRaf = null;

// ---------------------------------------------------------------------------
// Count-up animation (visual only)
// ---------------------------------------------------------------------------
function animateCountUp(el, targetValue, durationMs = 800) {
  if (_countUpRaf) cancelAnimationFrame(_countUpRaf);
  const startValue = parseFloat(el.textContent.replace(/[^0-9.\-]/g, "")) || 0;
  const endValue = typeof targetValue === "number" ? targetValue : parseFloat(targetValue) || 0;
  const delta = endValue - startValue;
  if (Math.abs(delta) < 0.0001) { el.textContent = fmt(endValue); return; }
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / durationMs, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = fmt(startValue + delta * eased);
    if (progress < 1) _countUpRaf = requestAnimationFrame(tick);
  }
  _countUpRaf = requestAnimationFrame(tick);
}

function showBalanceShimmer() {
  document.querySelector(".balance-wrap")?.classList.add("loading");
}
function hideBalanceShimmer() {
  document.querySelector(".balance-wrap")?.classList.remove("loading");
}

// ---------------------------------------------------------------------------
// Ledger persistence
// ---------------------------------------------------------------------------
function saveLedger() {
  try { localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger)); }
  catch (err) { console.warn("Failed to save ledger", err); }
}

function loadLedger() {
  try {
    const raw = localStorage.getItem(LEDGER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) ledger.splice(0, ledger.length, ...parsed);
  } catch (err) { console.warn("Failed to load ledger", err); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getConfirmedBalanceTotal(balances) {
  let total = parseFloat(balances?.totalConfirmedBalance ?? "0") || 0;
  if (total === 0) {
    for (const account of balances?.breakdown ?? []) {
      for (const chainEntry of account.breakdown ?? []) {
        total += parseFloat(chainEntry.confirmedBalance ?? "0") || 0;
      }
    }
  }
  return total;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortAddr(a) {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function setStatus(msg) {
  const el = $("networkStatus");
  if (el) el.textContent = msg;
}

// ---------------------------------------------------------------------------
// Chain switching — switch the EIP-1193 wallet to a specific chain.
// Arc docs recommend wallet_switchEthereumChain + wallet_addEthereumChain fallback.
// ---------------------------------------------------------------------------
async function ensureChain(chainKey) {
  if (!window.ethereum) throw new Error("No EIP-1193 wallet found");
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chain.chainIdHex }],
    });
  } catch (err) {
    if (err.code === 4902) {
      // Chain not in wallet — add it first
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chain.chainIdHex,
          chainName: chain.label,
          nativeCurrency: chain.viemChain.nativeCurrency,
          rpcUrls: chain.viemChain.rpcUrls.default.http,
          blockExplorerUrls: [chain.viemChain.blockExplorers.default.url],
        }],
      });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// Create a fresh adapter after every chain switch.
// getPublicClient is overridden to inject our fee-buffered chain definitions
// so the SDK's internal fee estimation uses the correct baseFee + 30% buffer
// rather than a stale estimate that triggers FeeCapTooLowError on Arb Sepolia.
// ---------------------------------------------------------------------------
async function getAdapter(chainKey) {
  if (!window.ethereum) throw new Error("No EIP-1193 wallet found");
  await ensureChain(chainKey);
  return await createViemAdapterFromProvider({
    provider: window.ethereum,
    getPublicClient: ({ chain }) => {
      // Look up our augmented chain definition by chain ID.
      // This ensures fee overrides (e.g., Arbitrum Sepolia's 130% buffer) apply.
      const ourChain = Object.values(CHAINS).find(
        (c) => c.viemChain.id === chain.id
      );
      const resolvedChain = ourChain ? ourChain.viemChain : chain;
      return createPublicClient({
        chain: resolvedChain,
        transport: http(resolvedChain.rpcUrls.default.http[0]),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Auto-refresh: 10 s while any row is pending, 30 s otherwise.
// Calling startAutoRefresh() re-evaluates the current pending state and
// restarts the timer at the right interval.
// ---------------------------------------------------------------------------
function hasPendingLedgerRow() {
  return ledger.some((r) => r.status === "pending");
}

function startAutoRefresh() {
  stopAutoRefresh();
  const interval = hasPendingLedgerRow() ? 10_000 : AUTO_REFRESH_INTERVAL_MS;
  autoRefreshTimer = setInterval(async () => {
    if (userAddress) {
      try {
        await refreshBalances();
        // Re-check interval after each refresh: if pending rows cleared,
        // relax back to 30 s to avoid unnecessary API load.
        const wantFast = hasPendingLedgerRow();
        const currentInterval = wantFast ? 10_000 : AUTO_REFRESH_INTERVAL_MS;
        if (currentInterval !== interval) startAutoRefresh(); // restart with new cadence
      } catch (err) {
        console.warn("Auto-refresh failed", err);
      }
    }
  }, interval);
}

function stopAutoRefresh() {
  if (autoRefreshTimer != null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Wallet connection
// ---------------------------------------------------------------------------
async function connectWallet() {
  const btn = $("connectBtn");
  if (!window.ethereum) {
    btn.textContent = "No wallet found";
    setTimeout(() => (btn.textContent = "Connect wallet"), 2000);
    return;
  }

  try {
    // Default to Arc Testnet on connect
    await ensureChain("Arc_Testnet");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    userAddress = accounts[0];

    btn.textContent = shortAddr(userAddress);
    btn.classList.add("connected");
    $("addressValue").textContent = shortAddr(userAddress);
    setStatus("Connected — ready");

    loadLedger();
    renderLedger();
    await refreshBalances();
    startAutoRefresh();

    // React to external account / chain changes
    window.ethereum.removeAllListeners?.("accountsChanged");
    window.ethereum.removeAllListeners?.("chainChanged");
    window.ethereum.on("accountsChanged", (accounts) => {
      if (!accounts?.length) { disconnectWallet(); return; }
      userAddress = accounts[0];
      btn.textContent = shortAddr(userAddress);
      btn.classList.add("connected");
      $("addressValue").textContent = shortAddr(userAddress);
      setStatus("Account changed — refreshing");
      refreshBalances();
    });
    window.ethereum.on("chainChanged", () => {
      setStatus("Network changed — refreshing balance");
      refreshBalances();
    });
  } catch (err) {
    console.error("Connect failed", err);
    setStatus("Connection failed — check your wallet");
  }
}

let disconnectTimeout = null;

function revertDisconnectMode() {
  if (disconnectTimeout) clearTimeout(disconnectTimeout);
  const btn = $("connectBtn");
  if (userAddress && btn.classList.contains("disconnect-mode")) {
    btn.classList.remove("disconnect-mode");
    btn.textContent = shortAddr(userAddress);
  }
}

function disconnectWallet() {
  userAddress = null;
  stopAutoRefresh();
  const btn = $("connectBtn");
  btn.textContent = "Connect wallet";
  btn.classList.remove("connected", "disconnect-mode");
  $("addressValue").textContent = "—";
  setStatus("Wallet disconnected");
  $("balanceNumber").textContent = "—";
  $("confirmedValue").textContent = "—";
  $("pendingValue").textContent = "—";
  $("segBase").style.width = "0%";
  $("segArb").style.width = "0%";
  $("segArc").style.width = "0%";
  $("baseLegendVal").textContent = "—";
  $("arbLegendVal").textContent = "—";
  $("arcLegendVal").textContent = "—";
  ledger.length = 0;
  renderLedger();
}

async function handleConnectClick() {
  const btn = $("connectBtn");
  if (userAddress) {
    if (btn.classList.contains("disconnect-mode")) {
      disconnectWallet();
    } else {
      btn.classList.add("disconnect-mode");
      btn.textContent = "Disconnect";
      if (disconnectTimeout) clearTimeout(disconnectTimeout);
      disconnectTimeout = setTimeout(revertDisconnectMode, 3000);
      const clickOutsideHandler = (e) => {
        if (e.target !== btn) {
          revertDisconnectMode();
          document.removeEventListener("click", clickOutsideHandler);
        }
      };
      setTimeout(() => document.addEventListener("click", clickOutsideHandler), 50);
    }
  } else {
    await connectWallet();
  }
}

async function restoreWalletSession() {
  if (!window.ethereum) return;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accounts?.length) return;
    userAddress = accounts[0];
    const btn = $("connectBtn");
    btn.textContent = shortAddr(userAddress);
    btn.classList.add("connected");
    $("addressValue").textContent = shortAddr(userAddress);
    setStatus("Connected — ready");
    loadLedger();
    renderLedger();
    await refreshBalances();
    startAutoRefresh();
  } catch (err) {
    console.warn("Failed to restore wallet session", err);
  }
}

// ---------------------------------------------------------------------------
// Balance read
// Uses getBalances() with correct SDK params shape per Circle docs.
// IMPORTANT — Arc USDC duality rules:
//   • Show one USDC balance only (6-decimal ERC-20 view from the SDK).
//   • Never read native balance and ERC-20 balance as two separate assets.
//   • totalConfirmedBalance is already in 6-decimal USDC units.
// ---------------------------------------------------------------------------
async function refreshBalances() {
  if (!userAddress) return;

  showBalanceShimmer();
  try {
    // Build a read-only adapter. getBalances needs no chain switch.
    // We still supply getPublicClient so fee estimation is consistent.
    const provider = window.ethereum;
    const adapter = await createViemAdapterFromProvider({
      provider,
      getPublicClient: ({ chain }) => {
        const ourChain = Object.values(CHAINS).find((c) => c.viemChain.id === chain.id);
        const resolvedChain = ourChain ? ourChain.viemChain : chain;
        return createPublicClient({
          chain: resolvedChain,
          transport: http(resolvedChain.rpcUrls.default.http[0]),
        });
      },
    });

    // getBalances params per Circle SDK docs:
    //   sources: { adapter } — resolves the depositor address from the adapter
    //   networkType: "testnet" — required to scope to testnet chains
    const balances = await kit.unifiedBalance.getBalances({
      sources: { adapter },
      networkType: "testnet",
    });

    // Log the raw API response so we can see exactly what Circle Gateway returns.
    // This is the ground truth — if the number is wrong here, it is a backend
    // delay on Circle's side, not a frontend bug.
    console.log("[UniFlow] getBalances raw response:", JSON.stringify(balances, null, 2));

    currentBalances = balances;
    await reconcileLedgerWithPendingTransactions(balances);
    renderLedger();

    // Use totalConfirmedBalance directly from the SDK — it is the authoritative
    // sum. The manual breakdown sum can miss entries if chain key names differ.
    const confirmed = parseFloat(balances?.totalConfirmedBalance ?? "0") || 0;

    // Build stable pending from unique tx hashes to avoid SDK over-reporting
    let pending = 0;
    const seenPendingTx = new Set();
    for (const account of balances?.breakdown ?? []) {
      for (const chainEntry of account.breakdown ?? []) {
        for (const tx of chainEntry.pendingTransactions ?? []) {
          const hash = (tx?.transactionHash ?? "").toLowerCase();
          if (!hash || seenPendingTx.has(hash)) continue;
          seenPendingTx.add(hash);
          pending += parseFloat(tx.amount ?? "0") || 0;
        }
      }
    }
    // Fall back to totalPendingBalance only when no per-tx data exists
    if (pending === 0) {
      pending = parseFloat(balances?.totalPendingBalance ?? "0") || 0;
    }

    hideBalanceShimmer();
    animateCountUp($("balanceNumber"), confirmed);
    $("confirmedValue").textContent = fmt(confirmed);
    $("pendingValue").textContent = fmt(pending);

    // Per-chain breakdown for the tributary bar
    const perChain = {};
    for (const account of balances?.breakdown ?? []) {
      for (const chainEntry of account.breakdown ?? []) {
        perChain[chainEntry.chain] = parseFloat(chainEntry.confirmedBalance ?? "0");
      }
    }

    function findChain(...names) {
      for (const n of names) { if (perChain[n] != null) return perChain[n]; }
      return 0;
    }

    const baseVal = findChain("Base", "Base_Sepolia");
    const arbVal  = findChain("Arbitrum", "Arbitrum_Sepolia");
    const arcVal  = findChain("Arc", "Arc_Testnet");
    const total   = baseVal + arbVal + arcVal || 1;

    $("segBase").style.width = `${(baseVal / total) * 100}%`;
    $("segArb").style.width  = `${(arbVal  / total) * 100}%`;
    $("segArc").style.width  = `${(arcVal  / total) * 100}%`;
    $("baseLegendVal").textContent = fmt(baseVal);
    $("arbLegendVal").textContent  = fmt(arbVal);
    $("arcLegendVal").textContent  = fmt(arcVal);
  } catch (err) {
    console.error("Balance refresh failed:", err);
    hideBalanceShimmer();
    setStatus("Balance update failed — retrying shortly");
  }
}

// ---------------------------------------------------------------------------
// Deposit
// Uses allowanceStrategy: 'authorize' (EIP-3009 transferWithAuthorization)
// for a single-step, gas-efficient deposit — no separate approve tx needed.
// ---------------------------------------------------------------------------
async function depositToUnifiedBalance(chainKey, amount) {
  const adapter = await getAdapter(chainKey);

  addLedgerRow({ action: "Deposit", chain: chainKey, amount, status: "pending" });
  renderLedger();
  showBalanceShimmer();
  const depositRow = ledger[0];
  const startingConfirmed = getConfirmedBalanceTotal(currentBalances);
  depositRow.startingConfirmed = startingConfirmed;
  depositRow.expectedConfirmed = startingConfirmed + parseFloat(amount ?? "0");
  saveLedger();

  // Run both watchers CONCURRENTLY from the moment deposit() returns.
  //
  // Phase A — receipt watcher: polls the source-chain RPC every 2 s.
  //   As soon as the tx receipt arrives, flip the ledger row to "Confirmed".
  //   The user sees this in the activity table immediately — same signal as
  //   the block explorer.
  //
  // Phase B — balance watcher: polls getBalances() every 3 s.
  //   With CCTP V2 Fast Transfer the Gateway credits the unified balance
  //   ~8-20 s after the source burn. This updates the big dollar number.
  //   Runs in parallel with Phase A — no waiting for the receipt first.
  //
  // Both start immediately; neither blocks the other.
  const watchDepositSettlement = async (txHash) => {
    const depositTarget = startingConfirmed + parseFloat(amount ?? "0") - 0.000001;

    // Phase A: source-chain receipt → ledger status
    const phaseA = async () => {
      if (!txHash) return;
      for (let i = 0; i < RECEIPT_POLL_ATTEMPTS; i++) {
        if (i > 0) await sleep(RECEIPT_POLL_INTERVAL_MS);
        const confirmed = await isTxConfirmedOnChain(chainKey, txHash);
        if (confirmed) {
          if (depositRow && depositRow.status !== "confirmed") {
            depositRow.status = "confirmed";
            saveLedger();
            renderLedger();
          }
          hideBalanceShimmer();
          return;
        }
      }
    };

    // Phase B: gateway balance → balance number
    const phaseB = async () => {
      for (let i = 0; i < GATEWAY_POLL_ATTEMPTS; i++) {
        if (i > 0) await sleep(GATEWAY_POLL_INTERVAL_MS);
        await refreshBalances();
        const latest = getConfirmedBalanceTotal(currentBalances);
        if (latest >= depositTarget) {
          setStatus("Unified balance updated ✓");
          hideBalanceShimmer();
          return;
        }
        setStatus("CCTP Fast Transfer in progress — balance updating…");
      }
      // Timed out: balance update is still coming, just slower than 90 s.
      // Keep auto-refresh running — it will pick it up in the next 30 s cycle.
      setStatus("Balance settling — will refresh automatically");
      hideBalanceShimmer();
    };

    // Fire both in parallel — don't await either from the caller
    void Promise.all([phaseA(), phaseB()]);
  };

  try {
    // config.transferSpeed: 'FAST' — CCTP V2 prepaid-forward path.
    // This is the correct param shape per the SDK's DepositParams type:
    //   config: { transferSpeed: 'FAST' }   <-- nested under config, uppercase
    // NOT a top-level transferSpeed field.
    //
    // FAST mode burns on the source chain and mints via Circle's GenericExecutor
    // on Arc_Testnet in ~8-20 s. The default ('STANDARD') takes ~15-19 minutes.
    //
    // allowanceStrategy must NOT be set when using FAST — per SDK docs:
    //   "Must not be set when config.transferSpeed is 'FAST'"
    //   (FAST cross-chain deposits do not use an allowance strategy)
    const result = await kit.unifiedBalance.deposit({
      from: { adapter, chain: CHAIN_SDK_NAME[chainKey] },
      amount: amount.toString(),
      token: "USDC",
      config: { transferSpeed: "FAST" },
    });

    updateLedgerStatus(result?.txHash, "pending", result?.explorerUrl);
    renderLedger();
    // Tighten the auto-refresh cadence to 10 s now that a row is pending.
    startAutoRefresh();
    await refreshBalances();
    // Run receipt + balance watchers concurrently.
    void watchDepositSettlement(result?.txHash);
    setStatus("Deposit submitted — CCTP V2 Fast Transfer active, expect ~8-20s…");
    return result;
  } catch (err) {
    console.error("Deposit failed", err);
    hideBalanceShimmer();

    const trace = err?.cause?.trace ?? err?.cause ?? null;
    const attestation = trace?.attestation;
    const signature = trace?.signature;

    if (attestation && signature) {
      // Burn succeeded but mint failed — save credentials for retry
      if (ledger.length > 0) {
        ledger[0].status = "failed";
        ledger[0].attestation = attestation;
        ledger[0].signature = signature;
        saveLedger();
        renderLedger();
      }
    } else {
      // Failed before burn (e.g. user rejected) — remove the pending row
      if (ledger.length > 0) {
        ledger.shift();
        saveLedger();
        renderLedger();
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Spend
// Uses the Forwarding Service (useForwarder: true) — Circle's relayer fetches
// the attestation and submits the destination mint so the user only signs once
// (the burn on the source chain). No destination adapter needed.
// Destination is always Arc Testnet: USDC-as-gas means near-instant finality.
//
// Allocation logic: distribute spend proportionally across chains with
// confirmed balance, then fix up remainder with integer arithmetic.
// ---------------------------------------------------------------------------
async function spendFromUnifiedBalance(toAddress, amount) {
  // Spend always burns from whichever chain(s) hold confirmed balance.
  // We need the adapter on the chain we'll sign the burn on — use Arc Testnet
  // first; we'll refine if only non-Arc chains have balance.
  const primaryChain = determinePrimarySourceChain();
  const adapter = await getAdapter(primaryChain);

  addLedgerRow({ action: "Spend", chain: primaryChain, amount, status: "pending" });
  renderLedger();
  showBalanceShimmer();

  // Build allocations in atomic USDC units (6 decimals) to avoid floating
  // point drift in the allocation sum.
  const USDC_DECIMALS = 6;
  const SCALE = 10 ** USDC_DECIMALS;

  function decimalToAtomic(value) {
    const str = String(value ?? "0").trim();
    if (!str) return 0;
    const negative = str.startsWith("-");
    const clean = negative ? str.slice(1) : str;
    const [wholeRaw, fracRaw = ""] = clean.split(".");
    const whole = Number(wholeRaw || "0");
    const fracPadded = (fracRaw + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
    const frac = Number(fracPadded);
    const atomic = whole * SCALE + frac;
    return negative ? -atomic : atomic;
  }

  function atomicToDecimal(atomic) {
    return (atomic / SCALE).toFixed(USDC_DECIMALS);
  }

  const entries = [];
  let totalAtomic = 0;
  for (const account of currentBalances?.breakdown ?? []) {
    for (const chainEntry of account.breakdown ?? []) {
      const chainAtomic = decimalToAtomic(chainEntry.confirmedBalance ?? "0");
      if (chainAtomic > 0) {
        entries.push({
          chain: chainEntry.chain,
          availableAtomic: chainAtomic,
          allocatedAtomic: 0,
        });
        totalAtomic += chainAtomic;
      }
    }
  }

  const spendAtomic = decimalToAtomic(amount);
  if (spendAtomic <= 0) throw new Error("Amount must be greater than 0");
  if (spendAtomic > totalAtomic) {
    throw new Error(
      `Insufficient confirmed balance. Available: ${atomicToDecimal(totalAtomic)}, requested: ${atomicToDecimal(spendAtomic)}`
    );
  }

  // Proportional allocation with deterministic remainder distribution
  let allocatedSum = 0;
  for (const entry of entries) {
    const proportional = Math.floor((spendAtomic * entry.availableAtomic) / totalAtomic);
    entry.allocatedAtomic = Math.min(proportional, entry.availableAtomic);
    allocatedSum += entry.allocatedAtomic;
  }
  let remainder = spendAtomic - allocatedSum;
  const byCapacity = [...entries].sort(
    (a, b) => (b.availableAtomic - b.allocatedAtomic) - (a.availableAtomic - a.allocatedAtomic)
  );
  for (const entry of byCapacity) {
    if (remainder <= 0) break;
    const capacity = entry.availableAtomic - entry.allocatedAtomic;
    if (capacity <= 0) continue;
    const add = Math.min(capacity, remainder);
    entry.allocatedAtomic += add;
    remainder -= add;
  }

  const allocations = entries
    .filter((e) => e.allocatedAtomic > 0)
    .map((e) => ({ amount: atomicToDecimal(e.allocatedAtomic), chain: e.chain }));

  console.log("Spend allocations:", allocations);

  try {
    // Forwarding Service (useForwarder: true):
    //   - User signs only the burn on the source chain.
    //   - Circle's relayer submits the mint on Arc Testnet.
    //   - recipientAddress is required when useForwarder is true.
    //   - The SDK polls Circle's Iris API for completion.
    const result = await kit.unifiedBalance.spend({
      from: {
        adapter,
        allocations: allocations.length > 0 ? allocations : undefined,
      },
      to: {
        chain: SPEND_DESTINATION_CHAIN,
        recipientAddress: toAddress,
        useForwarder: true,
      },
      token: "USDC",
      amount: amount.toString(),
    });

    updateLedgerStatus(result?.txHash, "pending", result?.explorerUrl);
    renderLedger();
    currentBalances = null;
    await refreshBalances();

    // Spend settles on Arc Testnet — mark confirmed after balance refreshes
    if (ledger.length > 0 && ledger[0].status === "pending") {
      ledger[0].status = "confirmed";
      saveLedger();
      renderLedger();
    }
    setStatus("Spend submitted — Circle Gateway settling on Arc Testnet");
    return result;
  } catch (err) {
    console.error("Spend failed", err);
    hideBalanceShimmer();
    if (ledger.length > 0) {
      ledger[0].status = "failed";
      saveLedger();
      renderLedger();
    }
    throw err;
  }
}

// Pick the source chain that has the most confirmed balance — prefer Arc Testnet
// when tied (USDC-as-gas means instant finality, no bridging needed).
function determinePrimarySourceChain() {
  if (!currentBalances?.breakdown) return "Arc_Testnet";
  const sdkToKey = {
    Arc_Testnet: "Arc_Testnet",
    Base_Sepolia: "Base_Sepolia",
    Arbitrum_Sepolia: "Arbitrum_Sepolia",
  };
  let best = "Arc_Testnet";
  let bestBalance = 0;
  for (const account of currentBalances.breakdown) {
    for (const chainEntry of account.breakdown ?? []) {
      const bal = parseFloat(chainEntry.confirmedBalance ?? "0") || 0;
      if (bal > bestBalance) {
        bestBalance = bal;
        best = sdkToKey[chainEntry.chain] ?? "Arc_Testnet";
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------
function addLedgerRow({ action, chain, amount, status }) {
  ledger.unshift({
    time: nowLabel(),
    action,
    chain,
    amount,
    status,
    hash: null,
    url: null,
    timestamp: Date.now(),
    seenPending: false,
  });
  saveLedger();
}

function updateLedgerStatus(hash, status, url) {
  if (!ledger.length) return;
  ledger[0].status = status;
  ledger[0].hash = hash;
  ledger[0].url = url;
  ledger[0].timestamp = Date.now();
  saveLedger();
}

async function isTxConfirmedOnChain(chainKey, txHash) {
  try {
    const chain = CHAINS[chainKey];
    if (!chain) return false;
    const rpcUrl = chain.viemChain.rpcUrls.default.http[0];
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_getTransactionReceipt",
        params: [txHash],
      }),
    });
    const json = await res.json();
    const receipt = json?.result;
    return receipt && (receipt.status === "0x1" || receipt.status === 1);
  } catch (err) {
    console.warn("Failed to check tx receipt for", txHash, err);
    return false;
  }
}

// Reconcile ledger rows that survived a page reload (stored in localStorage).
// These rows were never watched by watchDepositSettlement, so check their
// on-chain receipt here. We do NOT call isTxConfirmedOnChain during normal
// flow — the watcher already handles that faster and more accurately.
async function reconcileLedgerWithPendingTransactions(balances) {
  const currentConfirmed = getConfirmedBalanceTotal(balances);

  // Build a set of hashes that Gateway still considers pending
  const gatewayPendingHashes = new Set();
  for (const account of balances?.breakdown ?? []) {
    for (const chainEntry of account.breakdown ?? []) {
      for (const tx of chainEntry.pendingTransactions ?? []) {
        if (tx?.transactionHash) gatewayPendingHashes.add(tx.transactionHash.toLowerCase());
      }
    }
  }

  // Only check rows that have a hash AND are still pending AND are old enough
  // that the watcher is no longer running (heuristic: timestamp > 5 min ago).
  const NOW = Date.now();
  const STALE_MS = 5 * 60 * 1000;

  for (const row of ledger) {
    if (!row.hash || row.status !== "pending") continue;

    // If the balance already reflects the expected amount, confirm immediately.
    const expectedConfirmed = parseFloat(row.expectedConfirmed ?? "NaN");
    if (!Number.isNaN(expectedConfirmed) && currentConfirmed >= expectedConfirmed - 0.000001) {
      row.status = "confirmed";
      continue;
    }

    // Only do RPC receipt checks for stale rows (watcher is gone).
    const rowAge = NOW - (row.timestamp ?? 0);
    if (rowAge < STALE_MS) continue;

    const isOnChain = await isTxConfirmedOnChain(row.chain, row.hash);
    if (!isOnChain) continue;

    if (row.action === "Spend") {
      // Arc spends settle instantly
      row.status = "confirmed";
    } else if (row.action === "Deposit") {
      // Source tx is confirmed on-chain — mark confirmed regardless of
      // whether Gateway has credited the balance yet.
      row.status = "confirmed";
    }
  }
  saveLedger();
}

// ---------------------------------------------------------------------------
// Chain icons (inline SVG)
// ---------------------------------------------------------------------------
const baseIconSvg = `<svg class="chain-logo-svg" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="#0052FF"/><circle cx="12" cy="12" r="5" fill="none" stroke="#FFFFFF" stroke-width="2"/></svg>`;
const arbIconSvg  = `<svg class="chain-logo-svg" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="#28A0F0"/><path d="M12 6L6 15H18L12 6Z" fill="#FFFFFF"/><path d="M12 9L9 15H15L12 9Z" fill="#1C274C"/></svg>`;
// Arc uses USDC gold (#E2A93E) as accent — matching Arc's brand
const arcIconSvg  = `<svg class="chain-logo-svg" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="#111419" stroke="#E2A93E" stroke-width="1.5"/><path d="M12 7L16 12L12 17L8 12Z" fill="#E2A93E"/></svg>`;

function getChainIconHtml(chainKey) {
  if (chainKey === "Base_Sepolia")     return baseIconSvg;
  if (chainKey === "Arbitrum_Sepolia") return arbIconSvg;
  if (chainKey === "Arc_Testnet")      return arcIconSvg;
  return "";
}

// ---------------------------------------------------------------------------
// Ledger render
// ---------------------------------------------------------------------------
function renderLedger() {
  const body = $("ledgerBody");
  if (!body) return;
  if (!ledger.length) {
    body.innerHTML = `<tr class="ledger-empty"><td colspan="6">No activity yet — connect your wallet to get started.</td></tr>`;
    return;
  }

  body.innerHTML = ledger.map((row, idx) => {
    let statusHtml = "";
    if (row.status === "failed" && row.attestation && row.signature) {
      statusHtml = `<button class="btn-retry" data-index="${idx}">Retry Mint</button>`;
    } else {
      const chipClass = row.status === "pending" ? "status-pending"
        : row.status === "failed" ? "status-failed"
        : "status-confirmed";
      const chipLabel = row.status === "pending" ? "Pending"
        : row.status === "failed" ? "Failed"
        : "Confirmed";
      statusHtml = `<span class="status-chip ${chipClass}">${chipLabel}</span>`;
    }
    const txCell = row.hash
      ? `<div class="tx-cell"><span class="tx-label">Source tx</span><a class="tx-link" href="${row.url || "#"}" target="_blank" rel="noopener">${shortAddr(row.hash)}</a></div>`
      : "—";
    return `<tr>
      <td>${row.time}</td>
      <td>${row.action}</td>
      <td><div class="chain-cell">${getChainIconHtml(row.chain)}<span>${CHAINS[row.chain]?.label || row.chain}</span></div></td>
      <td>${fmt(row.amount)}</td>
      <td>${txCell}</td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Retry mint (failed deposit after burn but before mint)
// ---------------------------------------------------------------------------
async function retryDepositMint(index) {
  const row = ledger[index];
  if (!row || row.status !== "failed" || !row.attestation || !row.signature) return;

  row.status = "pending";
  saveLedger();
  renderLedger();
  showBalanceShimmer();

  try {
    const adapter = await getAdapter("Arc_Testnet");
    const result = await kit.unifiedBalance.spend({
      to: { adapter, chain: "Arc_Testnet" },
      token: "USDC",
      amount: row.amount.toString(),
      config: { retry: { attestation: row.attestation, signature: row.signature } },
    });
    row.status = "confirmed";
    row.hash = result?.txHash;
    row.url = result?.explorerUrl;
    delete row.attestation;
    delete row.signature;
    saveLedger();
    renderLedger();
    await refreshBalances();
  } catch (err) {
    console.error("Retry mint failed", err);
    hideBalanceShimmer();
    row.status = "failed";
    saveLedger();
    renderLedger();
    const trace = err?.cause?.trace ?? err?.cause ?? null;
    alert(
      (err?.message || "Retry failed") +
      (trace ? "\n\nDetails: " + JSON.stringify(trace, null, 2) : "\n\nSee console for details")
    );
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
$("connectBtn").addEventListener("click", handleConnectClick);

$("ledgerBody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-retry");
  if (!btn) return;
  const index = parseInt(btn.dataset.index, 10);
  if (!Number.isNaN(index)) await retryDepositMint(index);
});

$("depositForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const chain = $("depositChain").value;
  const amount = parseFloat($("depositAmount").value);
  if (!amount || amount <= 0) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Depositing…";
  try {
    await depositToUnifiedBalance(chain, amount);
    $("depositAmount").value = "";
  } catch (err) {
    console.error(err);
    hideBalanceShimmer();
    const trace = err?.cause?.trace ?? err?.cause ?? null;
    alert(
      (err?.message || "Deposit failed") +
      (trace ? "\n\nDetails: " + JSON.stringify(trace, null, 2) : "\n\nSee console for details")
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Deposit";
  }
});

$("depositChain").addEventListener("change", async (e) => {
  if (!userAddress) {
    setStatus(`Select ${CHAINS[e.target.value]?.label || e.target.value} and connect your wallet to switch networks`);
    return;
  }
  try {
    await ensureChain(e.target.value);
    setStatus(`Switched to ${CHAINS[e.target.value]?.label || e.target.value}`);
  } catch (err) {
    console.error("Chain switch failed", err);
    setStatus(`Could not switch to ${CHAINS[e.target.value]?.label || e.target.value} — approve in your wallet`);
  }
});

$("spendForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const to = $("spendTo").value.trim();
  const amount = parseFloat($("spendAmount").value);
  if (!amount || amount <= 0) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Spending…";
  try {
    await spendFromUnifiedBalance(to, amount);
    $("spendTo").value = "";
    $("spendAmount").value = "";
  } catch (err) {
    console.error(err);
    hideBalanceShimmer();
    const trace = err?.cause?.trace ?? err?.cause ?? null;
    alert(
      (err?.message || "Spend failed") +
      (trace ? "\n\nDetails: " + JSON.stringify(trace, null, 2) : "\n\nSee console for details")
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Spend";
  }
});

// FAQ Accordion
document.querySelectorAll(".faq-trigger").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const item = trigger.closest(".faq-item");
    const content = item.querySelector(".faq-content");
    const isActive = item.classList.contains("active");

    document.querySelectorAll(".faq-item").forEach((other) => {
      if (other !== item) {
        other.classList.remove("active");
        other.querySelector(".faq-content").style.maxHeight = null;
        other.querySelector(".faq-trigger").setAttribute("aria-expanded", "false");
      }
    });

    if (isActive) {
      item.classList.remove("active");
      content.style.maxHeight = null;
      trigger.setAttribute("aria-expanded", "false");
    } else {
      item.classList.add("active");
      content.style.maxHeight = content.scrollHeight + "px";
      trigger.setAttribute("aria-expanded", "true");
    }
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadLedger();
renderLedger();
document.body.classList.add("app-ready");
restoreWalletSession();
