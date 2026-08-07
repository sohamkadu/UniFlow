import "./style.css";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { Buffer } from "buffer";
window.Buffer = Buffer;

// ---------------------------------------------------------------------------
// Chain configs
//
// App Kit identifies chains by string name ("Arc_Testnet", "Base_Sepolia",
// "Arbitrum_Sepolia") at call-time. We still need viem chain objects + a
// wallet/public client per chain so the connected browser wallet can sign
// on whichever chain a given action targets.
// ---------------------------------------------------------------------------
const CHAINS = {
  Arc_Testnet: {
    label: "Arc Testnet",
    chainIdHex: "0x4cef52",
    viemChain: {
      id: 5042002,
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
      blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
    },
  },
  Base_Sepolia: {
    label: "Base Sepolia",
    chainIdHex: "0x14a34", // 84532
    viemChain: {
      id: 84532,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
      blockExplorers: { default: { name: "BaseScan", url: "https://sepolia.basescan.org" } },
    },
  },
  Arbitrum_Sepolia: {
    label: "Arbitrum Sepolia",
    chainIdHex: "0x66eee", // 421614
    viemChain: {
      id: 421614,
      name: "Arbitrum Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://sepolia-rollup.arbitrum.io/rpc", "https://rpc.ankr.com/arbitrum_sepolia", "https://arbitrum-sepolia.blockpi.network/v1/rpc/public"] } },
      blockExplorers: { default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" } },
    },
  },
};

const KIT_KEY = import.meta.env.VITE_KIT_KEY;
const POST_DEPOSIT_POLL_INTERVAL_MS = 60_000;
const POST_DEPOSIT_POLL_ATTEMPTS = 15;

const $ = (id) => document.getElementById(id);
const kit = new AppKit();
const LEDGER_STORAGE_KEY = "arc-unified-balance-ledger";

let userAddress = null;
let currentBalances = null;
const ledger = [];

// ---------------------------------------------------------------------------
// Count-up animation helper (visual only — does not affect logic)
// ---------------------------------------------------------------------------
let _countUpRaf = null;

function animateCountUp(el, targetValue, durationMs = 800) {
  if (_countUpRaf) cancelAnimationFrame(_countUpRaf);

  // Parse current displayed value as a number
  const currentText = el.textContent.replace(/[^0-9.\-]/g, "");
  const startValue = parseFloat(currentText) || 0;
  const endValue = typeof targetValue === "number" ? targetValue : parseFloat(targetValue) || 0;
  const delta = endValue - startValue;

  if (Math.abs(delta) < 0.0001) {
    el.textContent = fmt(endValue);
    return;
  }

  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = startValue + delta * eased;
    el.textContent = fmt(current);
    if (progress < 1) {
      _countUpRaf = requestAnimationFrame(tick);
    }
  }

  _countUpRaf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Shimmer helpers (visual only)
// ---------------------------------------------------------------------------
function showBalanceShimmer() {
  const wrap = document.querySelector(".balance-wrap");
  if (wrap) wrap.classList.add("loading");
}

function hideBalanceShimmer() {
  const wrap = document.querySelector(".balance-wrap");
  if (wrap) wrap.classList.remove("loading");
}

function saveLedger() {
  try {
    localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger));
  } catch (err) {
    console.warn("Failed to save ledger", err);
  }
}

function loadLedger() {
  try {
    const raw = localStorage.getItem(LEDGER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    ledger.splice(0, ledger.length, ...parsed);
  } catch (err) {
    console.warn("Failed to load ledger", err);
  }
}

function fmt(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfirmedBalanceTotal(balances) {
  let confirmed = parseFloat(balances?.totalConfirmedBalance ?? "0") || 0;

  if (confirmed === 0) {
    for (const account of balances?.breakdown ?? []) {
      for (const chainEntry of account.breakdown ?? []) {
        confirmed += parseFloat(chainEntry.confirmedBalance ?? "0") || 0;
      }
    }
  }

  return confirmed;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Build a ViemAdapter bound to a specific chain, switching the wallet first.
// MetaMask can only sign for whatever chain is currently active, so any
// action targeting chain X must switch the wallet to X immediately before
// building that chain's adapter.
// ---------------------------------------------------------------------------
async function ensureChain(chainKey) {
  const chain = CHAINS[chainKey];
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chain.chainIdHex }],
    });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chain.chainIdHex,
            chainName: chain.label,
            nativeCurrency: chain.viemChain.nativeCurrency,
            rpcUrls: chain.viemChain.rpcUrls.default.http,
            blockExplorerUrls: [chain.viemChain.blockExplorers.default.url],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

// A single adapter works across all chains — createViemAdapterFromProvider
// derives wallet/public clients per chain lazily and internally. We still
// call ensureChain() before any action that signs, because MetaMask itself
// can only sign for whatever chain is currently active in the extension.
let adapter = null;

async function getAdapter(chainKey) {
  if (chainKey) await ensureChain(chainKey);
  if (!adapter) {
    adapter = await createViemAdapterFromProvider({ provider: window.ethereum });
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Connect wallet
// ---------------------------------------------------------------------------
async function connectWallet() {
  const btn = $("connectBtn");

  if (!window.ethereum) {
    btn.textContent = "No wallet found";
    setTimeout(() => (btn.textContent = "Connect wallet"), 2000);
    return;
  }

  // Note: KIT_KEY is not required for unifiedBalance.deposit/spend/getBalances
  // (verified against the SDK's types — Gateway operations don't take a
  // config.kitKey). It's kept in .env for if you add kit.swap() or kit.bridge()
  // later, which do use it for developer-fee features.

  try {
    await ensureChain("Arc_Testnet");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    userAddress = accounts[0];
    adapter = await createViemAdapterFromProvider({ provider: window.ethereum });

    btn.textContent = shortAddr(userAddress);
    btn.classList.add("connected");
    $("addressValue").textContent = shortAddr(userAddress);
    $("networkStatus").textContent = "Connected — ready to go";

    loadLedger();
    renderLedger();

    await refreshBalances();

    window.ethereum.removeAllListeners?.("accountsChanged");
    window.ethereum.removeAllListeners?.("chainChanged");
    window.ethereum.on("accountsChanged", (accounts) => {
      if (!accounts || accounts.length === 0) {
        disconnectWallet();
        return;
      }
      userAddress = accounts[0];
      btn.textContent = shortAddr(userAddress);
      btn.classList.add("connected");
      $("addressValue").textContent = shortAddr(userAddress);
      $("networkStatus").textContent = "Connected — ready to go";
      refreshBalances();
    });
  } catch (err) {
    console.error("Connect failed", err);
    $("networkStatus").textContent = "Connection failed — check your wallet";
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
  const btn = $("connectBtn");
  btn.textContent = "Connect wallet";
  btn.classList.remove("connected");
  btn.classList.remove("disconnect-mode");
  $("addressValue").textContent = "—";
  $("networkStatus").textContent = "Wallet disconnected";
  
  // Reset balance display
  $("balanceNumber").textContent = "—";
  $("confirmedValue").textContent = "—";
  $("pendingValue").textContent = "—";
  
  // Reset tributary
  $("segBase").style.width = "0%";
  $("segArb").style.width = "0%";
  $("segArc").style.width = "0%";
  $("baseLegendVal").textContent = "—";
  $("arbLegendVal").textContent = "—";
  $("arcLegendVal").textContent = "—";
  
  // Hide recent activity ledger from screen, but preserve in localStorage
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
      
      // Auto-revert after 3 seconds of inactivity
      if (disconnectTimeout) clearTimeout(disconnectTimeout);
      disconnectTimeout = setTimeout(revertDisconnectMode, 3000);
      
      // Revert if clicking anywhere else
      const clickOutsideHandler = (e) => {
        if (e.target !== btn) {
          revertDisconnectMode();
          document.removeEventListener("click", clickOutsideHandler);
        }
      };
      setTimeout(() => {
        document.addEventListener("click", clickOutsideHandler);
      }, 50);
    }
  } else {
    await connectWallet();
  }
}

async function restoreWalletSession() {
  if (!window.ethereum) return;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) return;
    userAddress = accounts[0];
    const btn = $("connectBtn");
    btn.textContent = shortAddr(userAddress);
    btn.classList.add("connected");
    $("addressValue").textContent = shortAddr(userAddress);
    $("networkStatus").textContent = "Connected — ready to go";
    adapter = await createViemAdapterFromProvider({ provider: window.ethereum });
    
    loadLedger();
    renderLedger();

    await refreshBalances();
  } catch (err) {
    console.warn("Failed to restore wallet session", err);
  }
}

// ---------------------------------------------------------------------------
// Real balance read
//
// Shape verified directly against the installed @circle-fin/app-kit
// TypeScript definitions (index.d.ts) — not guessed from docs snippets,
// since Circle's own docs had inconsistent examples across pages.
// ---------------------------------------------------------------------------
async function refreshBalances() {
  if (!userAddress) return;

  try {
    const arcAdapter = await getAdapter("Arc_Testnet");

    // Real GetBalancesParams shape (verified against the installed SDK's
    // index.d.ts): token, sources: { adapter } | { address }, includePending.
    console.log("ADAPTER:", arcAdapter);

    const balances = await kit.unifiedBalance.getBalances({
      token: "USDC",
      sources: { adapter: arcAdapter },
      includePending: true,
      networkType: "testnet",
    });

    console.log("BALANCES:", balances);
    currentBalances = balances;
    await reconcileLedgerWithPendingTransactions(balances);
    renderLedger();

    const confirmed = getConfirmedBalanceTotal(balances);
    let pending = parseFloat(balances?.totalPendingBalance ?? "0") || 0;

    const ledgerPending = ledger
      .filter((row) => row.status === "pending")
      .reduce((sum, row) => sum + (parseFloat(row.amount ?? "0") || 0), 0);

    // Some provider responses can over-report totalPendingBalance. Build a
    // stable pending number from breakdown data and de-duplicate by tx hash.
    let pendingFromChains = 0;
    let pendingFromUniqueTx = 0;
    const seenPendingTx = new Set();
    for (const account of balances?.breakdown ?? []) {
      for (const chainEntry of account.breakdown ?? []) {
        pendingFromChains += parseFloat(chainEntry.pendingBalance ?? "0") || 0;
        for (const tx of chainEntry.pendingTransactions ?? []) {
          const hash = (tx?.transactionHash ?? "").toLowerCase();
          if (!hash || seenPendingTx.has(hash)) continue;
          seenPendingTx.add(hash);
          pendingFromUniqueTx += parseFloat(tx.amount ?? "0") || 0;
        }
      }
    }
    if (ledgerPending > 0) {
      pending = ledgerPending;
    } else if (pendingFromUniqueTx > 0) {
      pending = pendingFromUniqueTx;
    } else if (pendingFromChains > 0) {
      pending = pendingFromChains;
    }

    // Animate the balance number instead of snapping
    hideBalanceShimmer();
    animateCountUp($("balanceNumber"), confirmed);
    $("confirmedValue").textContent = fmt(confirmed);
    $("pendingValue").textContent = fmt(pending);

    // Real shape: breakdown[].breakdown[] is per-depositor -> per-chain.
    // We only have one depositor (the connected wallet), so flatten to
    // chain -> confirmedBalance for the tributary bar.
    const perChain = {};
    for (const account of balances?.breakdown ?? []) {
      for (const chainEntry of account.breakdown ?? []) {
        perChain[chainEntry.chain] = parseFloat(chainEntry.confirmedBalance ?? "0");
      }
    }

    // Helper to find a chain value under several possible canonical names
    function findChain(...names) {
      for (const n of names) {
        if (perChain[n] != null) return perChain[n];
      }
      return 0;
    }

    const baseVal = findChain("Base", "Base_Sepolia", "Base Sepolia", "Base_Sepolia");
    const arbVal = findChain("Arbitrum", "Arbitrum_Sepolia", "Arbitrum Sepolia", "Arbitrum_Sepolia");
    const arcVal = findChain("Arc", "Arc_Testnet", "Arc Testnet", "Arc_Testnet");
    const total = baseVal + arbVal + arcVal || 1;

    $("segBase").style.width = `${(baseVal / total) * 100}%`;
    $("segArb").style.width = `${(arbVal / total) * 100}%`;
    $("segArc").style.width = `${(arcVal / total) * 100}%`;
    $("baseLegendVal").textContent = fmt(baseVal);
    $("arbLegendVal").textContent = fmt(arbVal);
    $("arcLegendVal").textContent = fmt(arcVal);
  } catch (err) {
    console.error("Balance refresh failed:", err);
    hideBalanceShimmer();
    $("networkStatus").textContent = "Balance update failed — retrying shortly";
  }
}

// ---------------------------------------------------------------------------
// Real deposit: pulls USDC from a source chain into the unified balance
// ---------------------------------------------------------------------------
async function depositToUnifiedBalance(chainKey, amount) {
  const adapter = await getAdapter(chainKey);

  addLedgerRow({ action: "Deposit", chain: chainKey, amount, status: "pending" });
  renderLedger();
  showBalanceShimmer();
  const depositRow = ledger[0];
  const startingConfirmed = getConfirmedBalanceTotal(currentBalances);

  const watchDepositSettlement = async () => {
    const watchId = Date.now();

    for (let attempt = 0; attempt < POST_DEPOSIT_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(POST_DEPOSIT_POLL_INTERVAL_MS);
      }

      await refreshBalances();

      const latestConfirmed = getConfirmedBalanceTotal(currentBalances);
      const depositTarget = startingConfirmed + parseFloat(amount ?? "0") - 0.000001;

      if (depositRow?.status === "confirmed" || latestConfirmed >= depositTarget) {
        $("networkStatus").textContent = "Deposit credited — unified balance updated";
        return;
      }

      $("networkStatus").textContent = "Deposit submitted — unified balance can take 10–15 minutes to appear";
    }

    $("networkStatus").textContent = "Deposit is still settling — refresh again in a few minutes";
  };

  try {
    // Real DepositParams shape: from (adapter+chain), amount, token.
    const result = await kit.unifiedBalance.deposit({
      from: { adapter, chain: chainKey },
      amount: amount.toString(),
      token: "USDC",
    });

    updateLedgerStatus(result?.txHash, "pending", result?.explorerUrl);
    renderLedger();
    await refreshBalances();
    void watchDepositSettlement();
    $("networkStatus").textContent = "Deposit submitted on the source chain — unified balance can take 10–15 minutes to credit";
    return result;
  } catch (err) {
    console.error("Deposit failed", err);
    hideBalanceShimmer();

    const trace = err?.cause?.trace ?? err?.cause ?? null;
    const attestation = trace?.attestation;
    const signature = trace?.signature;

    if (attestation && signature) {
      // It's a mint failure! Mark row as failed and save CCTP credentials for retry.
      if (ledger.length > 0) {
        ledger[0].status = "failed";
        ledger[0].attestation = attestation;
        ledger[0].signature = signature;
        saveLedger();
        renderLedger();
      }
    } else {
      // Failed before burn (e.g. user rejected signature). Remove the pending ledger row.
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
// Real spend: pays out from the unified balance, settling on Arc Testnet
// ---------------------------------------------------------------------------
async function spendFromUnifiedBalance(toAddress, amount) {
  const adapter = await getAdapter("Arc_Testnet");

  addLedgerRow({ action: "Spend", chain: "Arc_Testnet", amount, status: "pending" });
  renderLedger();
  showBalanceShimmer();

  // Build allocations in exact atomic units (USDC = 6 decimals) so
  // allocation sum always exactly matches requested spend amount.
  const USDC_DECIMALS = 6;
  const SCALE = 10 ** USDC_DECIMALS;

  function decimalToAtomic(value) {
    const str = String(value ?? "0").trim();
    if (!str) return 0;
    const negative = str.startsWith("-");
    const clean = negative ? str.slice(1) : str;
    const [wholeRaw, fracRaw = ""] = clean.split(".");
    const whole = wholeRaw === "" ? 0 : Number(wholeRaw);
    const fracPadded = (fracRaw + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
    const frac = Number(fracPadded || "0");
    const atomic = whole * SCALE + frac;
    return negative ? -atomic : atomic;
  }

  function atomicToDecimal(atomic) {
    return (atomic / SCALE).toFixed(USDC_DECIMALS);
  }

  function toSdkChain(chain) {
    if (chain === "Base" || chain === "Base Sepolia" || chain === "Base_Sepolia") return "Base_Sepolia";
    if (chain === "Arbitrum" || chain === "Arbitrum Sepolia" || chain === "Arbitrum_Sepolia") return "Arbitrum_Sepolia";
    if (chain === "Ethereum" || chain === "Ethereum Sepolia" || chain === "Ethereum_Sepolia") return "Ethereum_Sepolia";
    if (chain === "Arc" || chain === "Arc_Testnet") return "Arc_Testnet";
    return chain;
  }

  const entries = [];
  let totalAtomic = 0;
  if (currentBalances?.breakdown?.[0]?.breakdown) {
    for (const chainEntry of currentBalances.breakdown[0].breakdown) {
      const chainAtomic = decimalToAtomic(chainEntry.confirmedBalance ?? "0");
      if (chainAtomic > 0) {
        entries.push({
          chain: toSdkChain(chainEntry.chain),
          availableAtomic: chainAtomic,
          allocatedAtomic: 0,
        });
        totalAtomic += chainAtomic;
      }
    }
  }

  const spendAtomic = decimalToAtomic(amount);
  if (spendAtomic <= 0) {
    throw new Error("Spend amount must be greater than 0");
  }
  if (spendAtomic > totalAtomic) {
    throw new Error(`Insufficient confirmed balance. Available: ${atomicToDecimal(totalAtomic)}, requested: ${atomicToDecimal(spendAtomic)}`);
  }

  let allocatedSum = 0;
  for (const entry of entries) {
    const proportional = Math.floor((spendAtomic * entry.availableAtomic) / totalAtomic);
    entry.allocatedAtomic = Math.min(proportional, entry.availableAtomic);
    allocatedSum += entry.allocatedAtomic;
  }

  // Distribute remainder deterministically so total equals spendAtomic exactly.
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

  // Real SpendParams shape: from (adapter, allocations), to (adapter+chain+recipientAddress), token, amount.
  const result = await kit.unifiedBalance.spend({
    from: { adapter, allocations: allocations.length > 0 ? allocations : undefined },
    to: { adapter, chain: "Arc_Testnet", recipientAddress: toAddress },
    token: "USDC",
    amount: amount.toString(),
  });

  updateLedgerStatus(result?.txHash, "pending", result?.explorerUrl);
  renderLedger();
  currentBalances = null;
  await refreshBalances();
  return result;
}

// ---------------------------------------------------------------------------
// Ledger
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
    seenPending: false 
  });
  saveLedger();
}

function updateLedgerStatus(hash, status, url) {
  if (ledger.length === 0) return;
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
        jsonrpc: "2.0",
        id: 1,
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

async function reconcileLedgerWithPendingTransactions(balances) {
  const pendingHashes = new Set();
  for (const account of balances?.breakdown ?? []) {
    for (const chainEntry of account.breakdown ?? []) {
      for (const tx of chainEntry.pendingTransactions ?? []) {
        if (tx?.transactionHash) pendingHashes.add(tx.transactionHash.toLowerCase());
      }
    }
  }

  for (const row of ledger) {
    if (!row.hash || row.status !== "pending") continue;
    const hashLower = row.hash.toLowerCase();

    // Check if transaction is confirmed on-chain
    const isConfirmedOnChain = await isTxConfirmedOnChain(row.chain, row.hash);
    if (!isConfirmedOnChain) {
      // Still mining or unconfirmed on the blockchain level
      continue;
    }

    if (row.action === "Spend") {
      // Outgoing spends settle instantly on Arc Testnet, no bridging logic required
      row.status = "confirmed";
    } else if (row.action === "Deposit") {
      if (pendingHashes.has(hashLower)) {
        row.seenPending = true;
      } else {
        // Not in the gateway's pending transactions list
        if (row.seenPending === true) {
          // Disappeared from pending list after being seen - confirmed
          row.status = "confirmed";
        }
      }
    }
  }

  saveLedger();
}

const baseIconSvg = `
<svg class="chain-logo-svg" viewBox="0 0 24 24" width="16" height="16">
  <circle cx="12" cy="12" r="10" fill="#0052FF" />
  <circle cx="12" cy="12" r="5" fill="none" stroke="#FFFFFF" stroke-width="2" />
</svg>
`;

const arbIconSvg = `
<svg class="chain-logo-svg" viewBox="0 0 24 24" width="16" height="16">
  <circle cx="12" cy="12" r="10" fill="#28A0F0" />
  <path d="M12 6L6 15H18L12 6Z" fill="#FFFFFF" />
  <path d="M12 9L9 15H15L12 9Z" fill="#1C274C" />
</svg>
`;

const arcIconSvg = `
<svg class="chain-logo-svg" viewBox="0 0 24 24" width="16" height="16">
  <circle cx="12" cy="12" r="10" fill="#111419" stroke="#E2A93E" stroke-width="1.5" />
  <path d="M12 7L16 12L12 17L8 12Z" fill="#E2A93E" />
</svg>
`;

function getChainIconHtml(chainKey) {
  if (chainKey === "Base_Sepolia") return baseIconSvg;
  if (chainKey === "Arbitrum_Sepolia") return arbIconSvg;
  if (chainKey === "Arc_Testnet") return arcIconSvg;
  return "";
}

function renderLedger() {
  const body = $("ledgerBody");
  if (ledger.length === 0) {
    body.innerHTML = `<tr class="ledger-empty"><td colspan="6">No activity yet — connect your wallet to get started.</td></tr>`;
    return;
  }

  body.innerHTML = ledger
    .map((row, idx) => {
      let statusHtml = "";
      if (row.status === "failed" && row.attestation && row.signature) {
        statusHtml = `<button class="btn-retry" data-index="${idx}">Retry Mint</button>`;
      } else {
        const chipClass = row.status === "pending" ? "status-pending" : row.status === "failed" ? "status-failed" : "status-confirmed";
        const chipLabel = row.status === "pending" ? "Pending" : row.status === "failed" ? "Failed" : "Confirmed";
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
    })
    .join("");
}

async function retryDepositMint(index) {
  const row = ledger[index];
  if (!row || row.status !== "failed" || !row.attestation || !row.signature) return;

  // Set row status to pending visually and in storage
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
      config: {
        retry: {
          attestation: row.attestation,
          signature: row.signature
        }
      }
    });

    row.status = "confirmed";
    row.hash = result?.txHash;
    row.url = result?.explorerUrl;
    // Clear credentials on successful completion
    delete row.attestation;
    delete row.signature;

    saveLedger();
    renderLedger();
    await refreshBalances();
  } catch (err) {
    console.error("Retry mint failed", err);
    hideBalanceShimmer();

    // Revert status to failed so they can click retry again
    row.status = "failed";
    saveLedger();
    renderLedger();

    const trace = err?.cause?.trace ?? err?.cause ?? null;
    alert((err && err.message ? err.message : 'Retry failed') + (trace ? '\n\nDetails: ' + JSON.stringify(trace, null, 2) : '\n\nSee console for details'));
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
$("connectBtn").addEventListener("click", handleConnectClick);

$("ledgerBody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-retry");
  if (!btn) return;
  const index = parseInt(btn.dataset.index, 10);
  if (Number.isNaN(index)) return;
  await retryDepositMint(index);
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
    alert((err && err.message ? err.message : 'Deposit failed') + (trace ? '\n\nDetails: ' + JSON.stringify(trace, null, 2) : '\n\nSee console for details'));
  } finally {
    btn.disabled = false;
    btn.textContent = "Deposit";
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
    alert((err && err.message ? err.message : 'Spend failed') + (trace ? '\n\nDetails: ' + JSON.stringify(trace, null, 2) : '\n\nSee console for details'));
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

    // Close other FAQ items
    document.querySelectorAll(".faq-item").forEach((otherItem) => {
      if (otherItem !== item) {
        otherItem.classList.remove("active");
        otherItem.querySelector(".faq-content").style.maxHeight = null;
        otherItem.querySelector(".faq-trigger").setAttribute("aria-expanded", "false");
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

loadLedger();
renderLedger();
document.body.classList.add("app-ready");
restoreWalletSession();
