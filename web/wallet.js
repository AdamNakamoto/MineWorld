// Browser wallet discovery and login. Uses EIP-6963 so every installed wallet
// (MetaMask, Robinhood Wallet, Rabby, ...) shows up by name, and falls back to the
// injected window.ethereum (e.g. a wallet's in-app browser on a phone).

const found = new Map(); // uuid -> { info: { uuid, name, icon, rdns }, provider }

window.addEventListener("eip6963:announceProvider", (e) => {
  const { info, provider } = e.detail ?? {};
  if (info?.uuid && provider) found.set(info.uuid, { info, provider });
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

/// Wallets available in this browser, best first.
export function wallets() {
  const list = [...found.values()];
  if (!list.length && window.ethereum) {
    list.push({
      info: { uuid: "injected", name: window.ethereum.isRabby ? "Rabby" : window.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: "", rdns: "injected" },
      provider: window.ethereum,
    });
  }
  return list;
}

const LAST = "mwc:wallet";
export function lastWallet() {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}
export function rememberWallet(rdns) {
  try {
    if (rdns) localStorage.setItem(LAST, rdns);
    else localStorage.removeItem(LAST);
  } catch {}
}

/// Show the wallet picker and resolve with the chosen wallet (or null if dismissed).
export function pickWallet() {
  const box = document.getElementById("wallets");
  const list = document.getElementById("walletList");
  // Wallets announce asynchronously; ask again so late ones are listed too.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((resolve) => {
    const options = wallets();
    list.innerHTML = options.length
      ? options
          .map(
            (w, i) => `<button class="wallet" data-i="${i}">${w.info.icon ? `<img src="${w.info.icon}" alt="">` : `<span class="wicon">◆</span>`}<b>${escapeHtml(w.info.name)}</b></button>`,
          )
          .join("")
      : `<p class="note">No browser wallet found. Install MetaMask or Robinhood Wallet, or open this page in your wallet app's browser.</p>`;
    box.hidden = false;
    const done = (value) => {
      box.hidden = true;
      box.removeEventListener("click", onClick);
      resolve(value);
    };
    const onClick = (e) => {
      const b = e.target.closest("[data-i]");
      if (b) return done(options[Number(b.dataset.i)]);
      if (e.target.closest("[data-close]") || e.target === box) done(null);
    };
    box.addEventListener("click", onClick);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
