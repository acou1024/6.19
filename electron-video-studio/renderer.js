const accounts = Array.from({ length: 10 }, (_, index) => `tt${index + 1}`);
const defaultPassword = "13579";
const defaults = {
  clientName: "",
  birthday: ""
};

const els = {
  loginPanel: document.getElementById("loginPanel"),
  workbench: document.getElementById("workbench"),
  accountInput: document.getElementById("accountInput"),
  passwordInput: document.getElementById("passwordInput"),
  loginButton: document.getElementById("loginButton"),
  loginStatus: document.getElementById("loginStatus"),
  currentAccount: document.getElementById("currentAccount"),
  resetButton: document.getElementById("resetButton"),
  logoutButton: document.getElementById("logoutButton"),
  clientNameInput: document.getElementById("clientNameInput"),
  birthdayInput: document.getElementById("birthdayInput"),
  generateButton: document.getElementById("generateButton"),
  statusText: document.getElementById("statusText"),
  logList: document.getElementById("logList")
};

let activeAccount = "";
let logs = [];
let jobQueue = [];
let isProcessingQueue = false;
const CPU_COUNT = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
const MAX_CONCURRENT = 1;
let activeJobs = 0;
let failedJobs = [];
let failedAlertTimer = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function friendlyError(message) {
  const text = String(message || "生成失败，请联系管理员。");
  if (text.includes("错误日志.txt")) return text;
  return "生成失败，请联系管理员。";
}

function init() {
  els.accountInput.innerHTML = accounts.map((account) => `<option value="${account}">${account}</option>`).join("");
  els.accountInput.value = localStorage.getItem("guoxue-video-account") || "tt1";
  els.clientNameInput.value = defaults.clientName;
  els.birthdayInput.value = defaults.birthday;
  const saved = localStorage.getItem("guoxue-video-account");
  if (saved && accounts.includes(saved)) {
    showWorkbench(saved);
  }
  renderLogs();

  document.getElementById("failedModalClose").addEventListener("click", closeFailedModal);
  document.getElementById("failedModalConfirm").addEventListener("click", closeFailedModal);
  document.getElementById("failedModal").addEventListener("click", handleModalOverlayClick);
}

function showWorkbench(account) {
  activeAccount = account;
  localStorage.setItem("guoxue-video-account", account);
  els.currentAccount.textContent = `当前账号 ${account}`;
  els.loginPanel.classList.add("hidden");
  els.workbench.classList.remove("hidden");
  setStatus("等待生成");
}

function showLogin(message = "请先登录员工账号") {
  activeAccount = "";
  localStorage.removeItem("guoxue-video-account");
  els.passwordInput.value = "";
  els.loginStatus.textContent = message;
  els.workbench.classList.add("hidden");
  els.loginPanel.classList.remove("hidden");
  resetFailedAlert();
}

function newJobId() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function login() {
  const account = els.accountInput.value;
  const password = els.passwordInput.value;
  if (!accounts.includes(account) || password !== defaultPassword) {
    els.loginStatus.textContent = "账号或密码不正确";
    return;
  }
  logs = [];
  jobQueue = [];
  failedJobs = [];
  activeJobs = 0;
  isProcessingQueue = false;
  resetFailedAlert();
  renderLogs();
  showWorkbench(account);
}

function resetDraft() {
  els.clientNameInput.value = defaults.clientName;
  els.birthdayInput.value = defaults.birthday;
  els.clientNameInput.focus();
  setStatus("已清空填写内容");
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function renderLogs() {
  if (!logs.length) {
    els.logList.innerHTML = '<p class="log-empty">提交后会进入后台生成记录。</p>';
    return;
  }
  els.logList.innerHTML = logs
    .map((log) => {
      const action = log.savedPath ? `<button data-path="${encodeURIComponent(log.savedPath)}">打开位置</button>` : "";
      const detail = log.error
        ? `<p class="log-path log-error">${escapeHtml(log.error)}</p>`
        : log.savedPath
          ? `<p class="log-path">${escapeHtml(log.savedPath)}</p>`
          : "";
      return `<div class="log-item">
        <div>
          <p class="log-title">${escapeHtml(log.time)} · ${escapeHtml(log.status)} · ${escapeHtml(log.summary)}</p>
          ${detail}
        </div>
        ${action}
      </div>`;
    })
    .join("");
}

function updateLog(id, patch) {
  logs = logs.map((log) => (log.id === id ? { ...log, ...patch } : log));
  renderLogs();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueue() {
  while (jobQueue.length > 0 && activeJobs < MAX_CONCURRENT) {
    const job = jobQueue.shift();
    if (!job) break;
    activeJobs += 1;
    processOneJob(job);
  }
}

async function processOneJob(job) {
  updateLog(job.id, { status: "生成中" });
  if (MAX_CONCURRENT >= 2 && activeJobs >= 2) {
    setStatus(`后台正在生成：${job.summary}（并发 ${activeJobs} 个）`);
  } else {
    setStatus(`后台正在生成：${job.summary}`);
  }

  try {
    const result = await window.videoStudio.generateVideo({
      account: job.account,
      clientName: job.clientName,
      birthday: job.birthday
    });
    if (result?.error) {
      throw new Error(result.error);
    }
    updateLog(job.id, { status: "已完成", savedPath: result.savedPath });
    setStatus('生成完成，已保存到桌面"国学视频成品"文件夹');
  } catch (error) {
    const message = friendlyError(error?.message);
    updateLog(job.id, { status: "失败", error: message });
    setStatus(message);
    failedJobs.push({
      summary: job.summary,
      time: job.time,
      error: message
    });
  } finally {
    activeJobs -= 1;

    if (jobQueue.length > 0) {
      setStatus("上一条已处理，正在释放文件占用，马上继续下一条");
      await sleep(600);
      processQueue();
      return;
    }

    if (activeJobs === 0) {
      scheduleFailedAlert();
      setStatus("后台任务已处理完，可以继续填写下一单");
    }
  }
}

function scheduleFailedAlert() {
  if (failedAlertTimer) clearTimeout(failedAlertTimer);
  failedAlertTimer = setTimeout(function () {
    failedAlertTimer = null;
    checkFailedAndAlert();
  }, 800);
}

function checkFailedAndAlert() {
  if (activeJobs > 0 || jobQueue.length > 0 || failedJobs.length === 0) return;

  const total = failedJobs.length;
  const listItems = failedJobs
    .map(function (j) { return "\x3cli\x3e" + escapeHtml(j.time) + " \xb7 " + escapeHtml(j.summary) + "\x3c/li\x3e"; })
    .join("");

  document.getElementById("failedModalBody").innerHTML =
    "\x3cp\x3e以下 \x3cstrong\x3e" + total + "\x3c/strong\x3e 条视频生成\x3cstrong style='color:#a13a2b;'\x3e失败\x3c/strong\x3e，请检查后重新提交：\x3c/p\x3e" +
    "\x3cul\x3e" + listItems + "\x3c/ul\x3e";
  document.getElementById("failedModal").classList.remove("hidden");
}

function closeFailedModal() {
  document.getElementById("failedModal").classList.add("hidden");
  document.getElementById("failedModalBody").innerHTML = "";
  failedJobs = [];
}

function resetFailedAlert() {
  if (failedAlertTimer) {
    clearTimeout(failedAlertTimer);
    failedAlertTimer = null;
  }
  failedJobs = [];
  closeFailedModal();
  var body = document.getElementById("failedModalBody");
  if (body) body.innerHTML = "";
}

function handleModalOverlayClick(event) {
  if (event.target === event.currentTarget) {
    closeFailedModal();
  }
}

function generate() {
  const clientName = els.clientNameInput.value.trim();
  const birthday = els.birthdayInput.value.trim();
  if (!activeAccount || !clientName || !birthday) {
    setStatus("请填写完整客户信息");
    return;
  }

  const id = newJobId();
  const summary = `${clientName} · ${birthday}`;
  const job = { id, time: nowLabel(), account: activeAccount, clientName, birthday, summary };
  jobQueue.push(job);
  logs = [{ id, time: job.time, status: "排队中", summary }, ...logs];
  els.clientNameInput.value = "";
  els.birthdayInput.value = "";
  renderLogs();
  els.clientNameInput.focus();
  setStatus(`已加入后台生成：${summary}，可以继续填写下一单`);
  processQueue();
}

function generateOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  generate();
}

els.loginButton.addEventListener("click", login);
els.passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
els.logoutButton.addEventListener("click", () => showLogin());
els.resetButton.addEventListener("click", resetDraft);
els.generateButton.addEventListener("click", generate);
els.clientNameInput.addEventListener("keydown", generateOnEnter);
els.birthdayInput.addEventListener("keydown", generateOnEnter);
els.logList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-path]");
  if (!button) return;
  window.videoStudio.openOutputFolder(decodeURIComponent(button.dataset.path));
});

init();
