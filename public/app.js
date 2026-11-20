/* JPJ PAY demo wallet. Simulated OTPs and demo money only. */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
  const money = (n) => inr.format(n || 0);
  const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
  const fullFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const initials = (name) =>
    (name || "JP")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("") || "JP";

  const maskMobile = (m) => (m && m.length === 10 ? `+91 ${m.slice(0, 2)}••••••${m.slice(-2)}` : `+91 ${m || ""}`);

  // ---------------- state ----------------
  const state = {
    user: null,
    recent: [],
    totals: { added: 0, withdrawn: 0, count: 0 },
    otp: JSON.parse(sessionStorage.getItem("jpj_otp") || "null"),
    hideBalance: localStorage.getItem("jpj_hide_balance") === "1",
    historyFilter: "all",
    lastTxn: null,
  };

  const saveOtp = (otp) => {
    state.otp = otp;
    if (otp) sessionStorage.setItem("jpj_otp", JSON.stringify(otp));
    else sessionStorage.removeItem("jpj_otp");
  };

  // ---------------- api ----------------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      /* empty body */
    }
    if (!res.ok) {
      const err = new Error(data.error || "Something went wrong. Please try again.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------------- ui helpers ----------------
  let toastTimer;
  function toast(msg, kind = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast " + kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  async function withLoading(btn, fn) {
    const label = btn.textContent;
    btn.classList.add("loading");
    btn.disabled = true;
    btn.textContent = "PLEASE WAIT…";
    try {
      return await fn();
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  const setError = (id, msg) => ($("#" + id).textContent = msg || "");

  const digitsOnly = (input, max) =>
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, max);
    });

  // ---------------- routing ----------------
  const AUTH_VIEWS = ["login", "signup", "otp"];
  const APP_PAGES = ["dashboard", "add", "withdraw", "history", "profile"];

  function showView(id) {
    $$("body > .screen, #view-app").forEach((v) => (v.hidden = v.id !== "view-" + id));
    window.scrollTo(0, 0);
  }

  function route() {
    const name = (location.hash.replace(/^#\/?/, "") || "").split("?")[0];

    if (state.user) {
      const page = APP_PAGES.includes(name) ? name : "dashboard";
      if (page !== name) return void history.replaceState(null, "", "#/" + page), route();
      showView("app");
      $$(".page").forEach((p) => (p.hidden = p.id !== "page-" + page));
      $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
      renderPage(page);
      return;
    }

    let view = AUTH_VIEWS.includes(name) ? name : "login";
    if (view === "otp" && !state.otp) view = "login";
    if (view !== name) return void history.replaceState(null, "", "#/" + view), route();
    showView(view);
    if (view === "otp") renderOtp();
    else stopOtpTimers();
  }

  window.addEventListener("hashchange", route);
  const go = (name) => {
    if (location.hash === "#/" + name) route();
    else location.hash = "#/" + name;
  };

  // ---------------- auth: login ----------------
  digitsOnly($("#loginMobile"), 10);
  digitsOnly($("#signupMobile"), 10);

  $$(".eye").forEach((btn) =>
    btn.addEventListener("click", () => {
      const input = $("#" + btn.dataset.toggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    }),
  );

  const validMobile = (m) => /^[6-9][0-9]{9}$/.test(m);

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("loginError");
    const mobile = $("#loginMobile").value.trim();
    const password = $("#loginPassword").value;
    if (!validMobile(mobile)) return setError("loginError", "Please enter a valid 10 digit mobile number.");
    if (!password) return setError("loginError", "Please enter your password.");

    const btn = e.submitter || $("#loginForm .btn");
    await withLoading(btn, async () => {
      try {
        const data = await api("/api/auth/login", { method: "POST", body: { mobile, password } });
        saveOtp({ ...data, remember: $("#remember").checked, issuedAt: Date.now() });
        $("#loginPassword").value = "";
        go("otp");
      } catch (err) {
        setError("loginError", err.message);
      }
    });
  });

  $("#forgot").addEventListener("click", (e) => {
    e.preventDefault();
    toast("Password recovery isn't available in this demo. Create a new demo account instead.");
  });

  // ---------------- auth: signup ----------------
  $("#signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("signupError");
    const name = $("#signupName").value.trim();
    const mobile = $("#signupMobile").value.trim();
    const password = $("#signupPassword").value;
    const confirm = $("#signupConfirm").value;

    if (name.length < 2) return setError("signupError", "Please enter your full name.");
    if (!validMobile(mobile)) return setError("signupError", "Please enter a valid 10 digit mobile number.");
    if (password.length < 6) return setError("signupError", "Password must be at least 6 characters.");
    if (password !== confirm) return setError("signupError", "Passwords do not match.");
    if (!$("#signupAgree").checked) return setError("signupError", "Please confirm you understand this is a demo.");

    const btn = e.submitter || $("#signupForm .btn");
    await withLoading(btn, async () => {
      try {
        const data = await api("/api/auth/signup", { method: "POST", body: { name, mobile, password } });
        saveOtp({ ...data, remember: true, issuedAt: Date.now() });
        $("#signupPassword").value = "";
        $("#signupConfirm").value = "";
        go("otp");
      } catch (err) {
        setError("signupError", err.message);
      }
    });
  });

  // ---------------- OTP ----------------
  const boxes = $$("#otpBoxes input");
  let expiryTimer, resendTimer;

  const otpValue = () => boxes.map((b) => b.value).join("");
  const clearBoxes = () => boxes.forEach((b) => (b.value = ""));

  function fillBoxes(str) {
    const digits = str.replace(/\D/g, "").slice(0, 6).split("");
    boxes.forEach((b, i) => (b.value = digits[i] || ""));
    (boxes[Math.min(digits.length, 5)] || boxes[0]).focus();
  }

  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      const v = box.value.replace(/\D/g, "");
      if (v.length > 1) return fillBoxes(otpValue().slice(0, i) + v);
      box.value = v;
      if (v && boxes[i + 1]) boxes[i + 1].focus();
      if (otpValue().length === 6) $("#verifyOtpBtn").focus();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !box.value && boxes[i - 1]) {
        boxes[i - 1].value = "";
        boxes[i - 1].focus();
        e.preventDefault();
      }
      if (e.key === "ArrowLeft" && boxes[i - 1]) boxes[i - 1].focus();
      if (e.key === "ArrowRight" && boxes[i + 1]) boxes[i + 1].focus();
    });
    box.addEventListener("paste", (e) => {
      e.preventDefault();
      fillBoxes((e.clipboardData || window.clipboardData).getData("text"));
    });
    box.addEventListener("focus", () => box.select());
  });

  function stopOtpTimers() {
    clearInterval(expiryTimer);
    clearInterval(resendTimer);
  }

  function startOtpTimers() {
    stopOtpTimers();
    const otp = state.otp;
    const expiresAt = otp.issuedAt + otp.expiresInSeconds * 1000;
    const resendAt = otp.issuedAt + otp.resendInSeconds * 1000;
    const resendBtn = $("#resendOtpBtn");

    const tickExpiry = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      $("#otpTimer").textContent = left
        ? `OTP expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
        : "OTP expired. Tap Resend OTP.";
      if (!left) clearInterval(expiryTimer);
    };
    const tickResend = () => {
      const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      resendBtn.disabled = left > 0;
      resendBtn.textContent = left > 0 ? `RESEND OTP IN ${left}s` : "RESEND OTP";
      if (!left) clearInterval(resendTimer);
    };
    tickExpiry();
    tickResend();
    expiryTimer = setInterval(tickExpiry, 1000);
    resendTimer = setInterval(tickResend, 1000);
  }

  function renderOtp() {
    const otp = state.otp;
    $("#otpMobile").textContent = maskMobile(otp.mobile);
    $("#otpSubtitle").textContent =
      otp.purpose === "signup" ? "Verify your mobile number to finish signing up" : "Confirm it's you to sign in";
    $("#demoOtpCode").textContent = otp.demoOtp;
    setError("otpError");
    clearBoxes();
    startOtpTimers();
    setTimeout(() => boxes[0].focus(), 50);
  }

  $("#otpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("otpError");
    const code = otpValue();
    if (code.length !== 6) return setError("otpError", "Enter the 6 digit OTP.");

    await withLoading($("#verifyOtpBtn"), async () => {
      try {
        const data = await api("/api/auth/verify-otp", {
          method: "POST",
          body: { challenge: state.otp.challenge, code, remember: !!state.otp.remember },
        });
        saveOtp(null);
        stopOtpTimers();
        state.user = data.user;
        await loadAccount();
        go("dashboard");
        toast(
          data.welcomeBonus ? `Mobile verified! ${money(5000)} demo balance added.` : `Welcome back, ${data.user.name}!`,
          "success",
        );
      } catch (err) {
        setError("otpError", err.message);
        clearBoxes();
        boxes[0].focus();
      }
    });
  });

  $("#resendOtpBtn").addEventListener("click", async () => {
    setError("otpError");
    const btn = $("#resendOtpBtn");
    btn.disabled = true;
    try {
      const data = await api("/api/auth/resend-otp", { method: "POST", body: { challenge: state.otp.challenge } });
      saveOtp({ ...state.otp, ...data, issuedAt: Date.now() });
      renderOtp();
      toast("New simulated OTP generated.", "success");
    } catch (err) {
      setError("otpError", err.message);
      if (err.status === 400) {
        saveOtp(null);
        setTimeout(() => go("login"), 1500);
      } else startOtpTimers();
    }
  });

  $("#otpBack").addEventListener("click", (e) => {
    e.preventDefault();
    const back = state.otp && state.otp.purpose === "signup" ? "signup" : "login";
    saveOtp(null);
    stopOtpTimers();
    go(back);
  });

  // ---------------- account data ----------------
  async function loadAccount() {
    const data = await api("/api/me");
    state.user = data.user;
    state.recent = data.recent;
    state.totals = data.totals;
    return data;
  }

  function txnMeta(t) {
    const incoming = t.type !== "withdraw";
    const title = t.type === "withdraw" ? "Withdrawn" : t.type === "bonus" ? "Welcome Credit" : "Money Added";
    return { incoming, title };
  }

  function txnRow(t) {
    const { incoming, title } = txnMeta(t);
    const d = new Date(t.createdAt);
    return `<li>
      <button type="button" class="txn" data-txn='${esc(JSON.stringify(t))}'>
        <span class="txn-ico ${incoming ? "in" : "out"}">${incoming ? "↓" : "↑"}</span>
        <span class="txn-main">
          <span class="txn-title">${esc(title)} <span class="tag">DEMO</span></span>
          <span class="txn-sub">${esc(t.method)} • ${dateFmt.format(d)}, ${timeFmt.format(d)}</span>
        </span>
        <span class="txn-amt ${incoming ? "pos" : "neg"}">${incoming ? "+" : "−"}${money(t.amount)}</span>
      </button>
    </li>`;
  }

  const emptyHtml = (msg) => `<div class="empty">${msg}</div>`;

  function renderHeader() {
    const u = state.user;
    $("#topAvatar").textContent = initials(u.name);
  }

  function renderBalance() {
    const shown = state.hideBalance ? "₹ ••••••" : money(state.user.balance);
    $("#balanceAmount").textContent = shown;
    $("#toggleBalance").textContent = state.hideBalance ? "Show balance" : "Hide balance";
  }

  function renderDashboard() {
    const u = state.user;
    $("#greetName").textContent = u.name.split(" ")[0];
    renderBalance();
    $("#statAdded").textContent = money(state.totals.added);
    $("#statWithdrawn").textContent = money(state.totals.withdrawn);
    $("#recentList").innerHTML = state.recent.length
      ? state.recent.map(txnRow).join("")
      : emptyHtml("No demo transactions yet.<br>Tap Add Money to try it out.");
  }

  async function renderHistory() {
    const list = $("#historyList");
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.filter === state.historyFilter));
    list.innerHTML = emptyHtml("Loading…");
    try {
      const q = state.historyFilter === "all" ? "" : "?type=" + state.historyFilter;
      const { transactions } = await api("/api/transactions" + q);
      if (!transactions.length) {
        list.innerHTML = emptyHtml("No demo transactions to show.");
        return;
      }
      let html = "";
      let lastDay = "";
      for (const t of transactions) {
        const day = dateFmt.format(new Date(t.createdAt));
        if (day !== lastDay) {
          if (lastDay) html += "</ul>";
          html += `<div class="date-group">${esc(day)}</div><ul class="txn-list">`;
          lastDay = day;
        }
        html += txnRow(t);
      }
      list.innerHTML = html + "</ul>";
    } catch (err) {
      handleAuthError(err);
      list.innerHTML = emptyHtml(esc(err.message));
    }
  }

  function renderProfile() {
    const u = state.user;
    $("#profileAvatar").textContent = initials(u.name);
    $("#profileName").textContent = u.name;
    $("#profileMobile").textContent = maskMobile(u.mobile);
    $("#profileBalance").textContent = money(u.balance);
    $("#profileCount").textContent = String(state.totals.count);
    $("#profileSince").textContent = dateFmt.format(new Date(u.memberSince));
    $("#profileNameInput").value = u.name;
    setError("profileError");
  }

  function renderPage(page) {
    renderHeader();
    if (page === "dashboard") {
      renderDashboard();
      refreshAccount(() => renderDashboard());
    } else if (page === "history") renderHistory();
    else if (page === "profile") {
      renderProfile();
      refreshAccount(() => renderProfile());
    } else if (page === "withdraw") {
      $("#withdrawAvailable").textContent = money(state.user.balance);
      setError("withdrawError");
    } else if (page === "add") setError("addError");
  }

  async function refreshAccount(then) {
    try {
      await loadAccount();
      then();
    } catch (err) {
      handleAuthError(err);
    }
  }

  function handleAuthError(err) {
    if (err.status === 401) {
      state.user = null;
      toast("Your session has ended. Please sign in again.", "error");
      go("login");
    }
  }

  $("#toggleBalance").addEventListener("click", () => {
    state.hideBalance = !state.hideBalance;
    localStorage.setItem("jpj_hide_balance", state.hideBalance ? "1" : "0");
    renderBalance();
  });

  $$(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      state.historyFilter = b.dataset.filter;
      renderHistory();
    }),
  );

  // ---------------- add / withdraw ----------------
  ["addAmount", "withdrawAmount"].forEach((id) => {
    const input = $("#" + id);
    input.addEventListener("input", () => {
      let v = input.value.replace(/[^\d.]/g, "");
      const [whole, ...rest] = v.split(".");
      v = rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
      input.value = v.slice(0, 9);
    });
  });

  $$(".chips").forEach((group) =>
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-amt]");
      if (!btn) return;
      const input = $("#" + group.dataset.target);
      input.value =
        btn.dataset.amt === "max"
          ? String(Math.min(state.user.balance, 50000))
          : btn.dataset.amt;
    }),
  );

  function wireMoneyForm(formId, kind) {
    const form = $("#" + formId);
    const amountInput = $("#" + kind + "Amount");
    const errId = kind + "Error";
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setError(errId);
      const amount = Number(amountInput.value);
      if (!amount || amount < 1) return setError(errId, "Enter an amount of at least ₹1.");
      if (amount > 50000) return setError(errId, "Maximum ₹50,000 per demo transaction.");
      if (kind === "withdraw" && amount > state.user.balance) return setError(errId, "Insufficient demo balance.");
      const method = $(`input[name="${kind}Method"]:checked`, form).value;

      await withLoading(e.submitter || $(".btn", form), async () => {
        try {
          const data = await api(`/api/wallet/${kind}`, { method: "POST", body: { amount, method } });
          state.user.balance = data.balance;
          amountInput.value = "";
          showReceipt(data.transaction);
        } catch (err) {
          handleAuthError(err);
          setError(errId, err.message);
        }
      });
    });
  }

  wireMoneyForm("addForm", "add");
  wireMoneyForm("withdrawForm", "withdraw");

  // ---------------- receipt ----------------
  function showReceipt(t, fromHistory = false) {
    const { incoming } = txnMeta(t);
    $("#receiptIcon").textContent = incoming ? "↓" : "↑";
    $("#receiptIcon").className = "receipt-icon" + (incoming ? "" : " out");
    $("#receiptTitle").textContent =
      t.type === "withdraw" ? "Demo withdrawal" : t.type === "bonus" ? "Demo welcome credit" : "Demo money added";
    $("#receiptAmount").textContent = (incoming ? "+" : "−") + money(t.amount);
    $("#receiptAmount").className = "receipt-amount " + (incoming ? "pos" : "neg");
    $("#receiptMethod").textContent = t.method;
    $("#receiptRef").textContent = t.reference;
    $("#receiptDate").textContent = fullFmt.format(new Date(t.createdAt));
    $("#receiptBalance").textContent = money(t.balanceAfter);
    $("#receiptClose").textContent = fromHistory ? "CLOSE" : "BACK TO DASHBOARD";
    state.lastTxn = { fromHistory };
    $("#receipt").hidden = false;
    $("#receiptClose").focus();
  }

  function closeReceipt() {
    $("#receipt").hidden = true;
    if (state.lastTxn && !state.lastTxn.fromHistory) go("dashboard");
    state.lastTxn = null;
  }

  $("#receiptClose").addEventListener("click", closeReceipt);
  $("#receipt").addEventListener("click", (e) => {
    if (e.target.id === "receipt") closeReceipt();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#receipt").hidden) closeReceipt();
  });

  document.addEventListener("click", (e) => {
    const row = e.target.closest(".txn[data-txn]");
    if (row) showReceipt(JSON.parse(row.dataset.txn), true);
  });

  // ---------------- profile / logout ----------------
  $("#profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("profileError");
    const name = $("#profileNameInput").value.trim();
    if (name.length < 2) return setError("profileError", "Please enter your full name.");
    await withLoading(e.submitter || $("#profileForm .btn"), async () => {
      try {
        const data = await api("/api/me", { method: "PATCH", body: { name } });
        state.user = data.user;
        renderProfile();
        renderHeader();
        toast("Profile updated.", "success");
      } catch (err) {
        handleAuthError(err);
        setError("profileError", err.message);
      }
    });
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await withLoading($("#logoutBtn"), async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch (_) {
        /* sign out locally regardless */
      }
      state.user = null;
      state.recent = [];
      go("login");
      toast("You have been logged out.");
    });
  });

  // ---------------- boot ----------------
  (async function init() {
    try {
      await loadAccount();
    } catch (_) {
      state.user = null;
    }
    route();
  })();
})();
