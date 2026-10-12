const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const grid = $("#mod-grid");
const toast = $("#toast");
let mods = [];
let currentUser = null;
let toastTimer;
let searchTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function token() { return localStorage.getItem("noomihub_token"); }
function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token()) headers.set("Authorization", `Bearer ${token()}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

function setView(view) {
  if (view === "moderation" && !currentUser?.is_moderator) view = "catalog";
  if (view === "upload" && !token()) {
    notify("Войди через Telegram, чтобы отправить мод.");
    startLogin();
  }
  $$("[data-view-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $$("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "profile") loadProfile();
  if (view === "moderation") loadModeration();
}

async function loadCatalog() {
  const params = new URLSearchParams();
  if ($("#search").value.trim()) params.set("q", $("#search").value.trim());
  if ($("#category-filter").value) params.set("tag", $("#category-filter").value);
  try {
    const { mods: found = [] } = await api(`/api/mods?${params}`);
    mods = found;
    const categories = [...new Set(mods.flatMap(mod => mod.tags || []))].sort((a, b) => a.localeCompare(b, "ru"));
    const selected = $("#category-filter").value;
    $("#category-filter").innerHTML = '<option value="">Все категории</option>' + categories.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("");
    if (categories.includes(selected)) $("#category-filter").value = selected;
    const sort = $("#sort-filter").value;
    if (sort === "name") mods.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    $("#result-count").textContent = `${mods.length} ${mods.length === 1 ? "мод" : "модов"}`;
    $("#catalog-empty").classList.toggle("hidden", mods.length > 0);
    grid.classList.toggle("hidden", mods.length === 0);
    grid.innerHTML = mods.map((mod, index) => {
      const glyph = escapeHtml((mod.title || "N").slice(0, 1).toUpperCase());
      const size = mod.file_size ? `${(mod.file_size / 1048576).toFixed(1)} МБ` : "Файл";
      return `<article class="mod-card" style="animation-delay:${Math.min(index * 45, 360)}ms"><div class="cover"><span class="cover-glyph">${glyph}</span></div><div class="card-top"><span class="tag">${escapeHtml(mod.tags?.[0] || "Мод")}</span><span class="version">${escapeHtml(mod.game_version || "")}</span></div><h2>${escapeHtml(mod.title)}</h2><p class="mod-description">${escapeHtml(mod.description || "")}</p><div class="card-bottom"><span class="author">${escapeHtml(mod.author || "Сообщество")} · ${size}</span>${mod.telegram_post_url ? `<a class="download-link" href="${escapeHtml(mod.telegram_post_url)}" target="_blank" rel="noreferrer">Скачать <span>↗</span></a>` : ""}</div></article>`;
    }).join("");
  } catch (error) {
    grid.classList.remove("hidden");
    grid.innerHTML = `<div class="empty-state"><h2>Не удалось загрузить каталог</h2><p>${escapeHtml(error.message)}</p></div>`;
    $("#result-count").textContent = "Ошибка загрузки";
  }
}

async function startLogin() {
  const popup = window.open("about:blank", "_blank");
  try {
    const { ticket, bot_url: botUrl } = await api("/api/auth/start", { method: "POST" });
    if (popup) popup.location = botUrl;
    else window.location.href = botUrl;
    notify("Нажми Start в Telegram, чтобы войти.");
    const expires = Date.now() + 10 * 60_000;
    const poll = async () => {
      if (Date.now() > expires) {
        if (popup && !popup.closed) popup.close();
        notify("Ссылка входа истекла. Попробуй ещё раз.");
        return;
      }
      try {
        const result = await api(`/api/auth/status/${encodeURIComponent(ticket)}`);
        if (result.linked) {
          localStorage.setItem("noomihub_token", result.token);
          if (popup && !popup.closed) popup.close();
          await loadUser();
          notify(`Вход выполнен: ${result.user}`);
          if ($("#view-upload").classList.contains("active")) setView("upload");
          return;
        }
      } catch (error) {
        if (error.message.includes("Ссылка истекла")) {
          if (popup && !popup.closed) popup.close();
          notify(error.message);
          return;
        }
      }
      setTimeout(poll, 1600);
    };
    poll();
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    notify(error.message);
  }
}

async function loadUser() {
  if (!token()) {
    currentUser = null;
    updateAccountUI();
    return;
  }
  try {
    const { user } = await api("/api/me");
    currentUser = user;
  } catch {
    localStorage.removeItem("noomihub_token");
    currentUser = null;
  }
  updateAccountUI();
}
function updateAccountUI() {
  const name = currentUser?.display_name || currentUser?.username || "Войти";
  const initial = currentUser ? name.slice(0, 1).toUpperCase() : "?";
  $("#user-short-name").textContent = currentUser ? name.split(" ")[0] : "Войти";
  $("#avatar").textContent = initial;
  $("#profile-avatar").textContent = initial;
  $("#profile-name").textContent = currentUser ? name : "Гость";
  $("#profile-handle").textContent = currentUser?.username ? `@${currentUser.username}` : currentUser ? "Аккаунт Telegram" : "Войди через Telegram";
  $("#profile-id").textContent = currentUser ? `Telegram ID · ${currentUser.telegram_id}` : "";
  $$(".moderator-only").forEach(item => item.classList.toggle("hidden", !currentUser?.is_moderator));
  if (!currentUser) $("#my-submissions").innerHTML = '<div class="list-empty"><button class="tonal-button" id="profile-login">Войти через Telegram</button></div>';
  else loadMySubmissions();
}

const statusNames = { pending: "На проверке", approved: "Опубликован", rejected: "Отклонён" };
function statusPill(status) { return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(statusNames[status] || status)}</span>`; }
async function loadMySubmissions() {
  if (!currentUser) return;
  try {
    const { submissions = [] } = await api("/api/submissions/mine");
    $("#my-submissions").innerHTML = submissions.length ? submissions.map(item => `<div class="submission-row"><div><h3>${escapeHtml(item.title)}</h3><small>${new Date(item.created_at).toLocaleDateString("ru-RU")}${item.rejection_reason ? ` · ${escapeHtml(item.rejection_reason)}` : ""}</small></div>${statusPill(item.status)}</div>`).join("") : '<div class="list-empty">Пока нет отправленных модов.</div>';
  } catch (error) { $("#my-submissions").innerHTML = `<div class="list-empty">${escapeHtml(error.message)}</div>`; }
}

async function loadModeration() {
  if (!currentUser?.is_moderator) return;
  try {
    const { submissions = [] } = await api("/api/moderation/pending");
    $("#queue-count").textContent = submissions.length;
    $("#pending-badge").classList.toggle("hidden", submissions.length === 0);
    $("#mobile-pending-badge").classList.toggle("hidden", submissions.length === 0);
    $("#moderation-list").innerHTML = submissions.length ? submissions.map(item => `<article class="review-card" data-id="${escapeHtml(item.submission_id)}"><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p><div class="review-meta"><span>${escapeHtml(item.author)}</span><span>${escapeHtml(item.game_version)}</span><span>${escapeHtml(item.file_name)} · ${item.file_size ? (item.file_size / 1048576).toFixed(1) + " МБ" : ""}</span><span>${new Date(item.created_at).toLocaleDateString("ru-RU")}</span></div><div class="review-actions"><button class="reject" data-action="reject">Отклонить</button><button class="approve" data-action="approve">Одобрить</button></div></article>`).join("") : '<div class="list-empty">Очередь пуста.</div>';
  } catch (error) { $("#moderation-list").innerHTML = `<div class="list-empty">${escapeHtml(error.message)}</div>`; }
}

for (const button of $$('[data-view]')) button.addEventListener("click", () => setView(button.dataset.view));
for (const link of $$('[data-nav]')) link.addEventListener("click", event => { event.preventDefault(); setView(link.dataset.nav); });
$("#profile-shortcut").addEventListener("click", () => token() ? setView("profile") : startLogin());
$("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadCatalog, 220); });
$("#category-filter").addEventListener("change", loadCatalog);
$("#sort-filter").addEventListener("change", loadCatalog);
$("#clear-filters").addEventListener("click", () => { $("#search").value = ""; $("#category-filter").value = ""; $("#sort-filter").value = "new"; loadCatalog(); });
$("#logout").addEventListener("click", () => { localStorage.removeItem("noomihub_token"); currentUser = null; updateAccountUI(); setView("catalog"); notify("Ты вышел из аккаунта."); });

document.addEventListener("click", event => {
  if (event.target.closest("#profile-login")) startLogin();
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const card = actionButton.closest("[data-id]");
  const action = actionButton.dataset.action;
  const reason = action === "reject" ? window.prompt("Причина отклонения (необязательно):") : "";
  if (action === "reject" && reason === null) return;
  actionButton.disabled = true;
  api(`/api/moderation/${encodeURIComponent(card.dataset.id)}/${action}`, { method: "POST", body: JSON.stringify({ reason }) })
    .then(() => { notify(action === "approve" ? "Мод опубликован." : "Заявка отклонена."); loadModeration(); })
    .catch(error => { actionButton.disabled = false; notify(error.message); });
});

const fileInput = $("#file-input");
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  $("#file-label").textContent = file?.name || "Выбери файл мода";
  $("#file-size").textContent = file ? `${(file.size / 1048576).toFixed(1)} МБ` : "ZIP, APK или другой файл · до 50 МБ";
});
const drop = $("#file-drop");
for (const eventName of ["dragenter", "dragover"]) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.add("dragover"); });
for (const eventName of ["dragleave", "drop"]) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.remove("dragover"); });
drop.addEventListener("drop", event => { if (event.dataTransfer.files.length) { fileInput.files = event.dataTransfer.files; fileInput.dispatchEvent(new Event("change")); } });

$("#upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = fileInput.files[0];
  const status = $("#upload-status");
  const submitButton = $(".filled-button", form);
  if (!file) { status.textContent = "Выбери файл."; status.className = "form-status error"; return; }
  if (file.size > 50 * 1024 * 1024) { status.textContent = "Файл больше лимита Telegram — 50 МБ."; status.className = "form-status error"; return; }
  const body = new FormData(form);
  submitButton.disabled = true;
  submitButton.innerHTML = "Загрузка…";
  status.textContent = "";
  status.className = "form-status";
  try {
    await api("/api/submissions", { method: "POST", body });
    form.reset();
    $("#file-label").textContent = "Выбери файл мода";
    $("#file-size").textContent = "ZIP, APK или другой файл · до 50 МБ";
    notify("Мод отправлен на проверку.");
    setView("profile");
    await loadMySubmissions();
  } catch (error) {
    status.textContent = error.message;
    status.className = "form-status error";
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Отправить на проверку <span>→</span>';
  }
});

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setView("catalog"); $("#search").focus(); }
});

loadUser().finally(loadCatalog);
