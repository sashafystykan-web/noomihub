const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const grid = $("#mod-grid");
const toast = $("#toast");
let mods = [];
let currentUser = null;
let toastTimer;
let searchTimer;
let submissionBotUrl = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
const icon = (name) => {
  const paths = {
    mod: '<path d="M5 7.5 12 4l7 3.5v9L12 20l-7-3.5z"/><path d="m5.5 7.8 6.5 3.3 6.5-3.3M12 11v8.5"/>',
    download: '<path d="M12 4v11m-4-4 4 4 4-4M5 19h14"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.4 3.2-5 7-5s6.4 1.6 7 5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.mod}</svg>`;
};
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
  $$("[data-view-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $$("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "profile" && currentUser) loadMySubmissions();
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
      const size = mod.file_size ? `${(mod.file_size / 1048576).toFixed(1)} МБ` : "Файл";
      const cover = mod.cover_url ? `<img class="cover-image" src="${escapeHtml(mod.cover_url)}" alt="" loading="lazy">` : `<span class="cover-glyph">${icon("mod")}</span>`;
      const avatar = mod.author_avatar_url ? `<img class="mini-avatar" src="${escapeHtml(mod.author_avatar_url)}" alt="" loading="lazy">` : `<span class="mini-avatar avatar-fallback">${icon("user")}</span>`;
      return `<article class="mod-card" data-mod-id="${escapeHtml(mod.mod_id)}" tabindex="0" role="link" aria-label="Открыть мод ${escapeHtml(mod.title)}" style="animation-delay:${Math.min(index * 45, 360)}ms"><div class="cover">${cover}</div><div class="card-top"><span class="tag">${escapeHtml(mod.tags?.[0] || "Мод")}</span><span class="version">${escapeHtml(mod.game_version || "")}</span></div><h2>${escapeHtml(mod.title)}</h2><p class="mod-description">${escapeHtml(mod.description || "")}</p><div class="card-bottom"><span class="card-author">${avatar}<span>${escapeHtml(mod.author || "Сообщество")} · ${size}</span></span>${mod.telegram_post_url ? `<a class="download-link" href="${escapeHtml(mod.telegram_post_url)}" target="_blank" rel="noreferrer" aria-label="Скачать ${escapeHtml(mod.title)}" title="Скачать">${icon("download")}</a>` : ""}</div></article>`;
    }).join("");
    $$(".mini-avatar img").forEach(image => image.addEventListener("error", () => { image.replaceWith(Object.assign(document.createElement("span"), { className: "mini-avatar avatar-fallback", innerHTML: icon("user") })); }, { once: true }));
    $$(".cover-image").forEach(image => image.addEventListener("error", () => { image.replaceWith(Object.assign(document.createElement("span"), { className: "cover-glyph", innerHTML: icon("mod") })); }, { once: true }));
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
  const fallback = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.4 3.2-5 7-5s6.4 1.6 7 5"/></svg>';
  const initial = currentUser ? escapeHtml(name.slice(0, 1).toUpperCase()) : fallback;
  $("#user-short-name").textContent = currentUser ? name.split(" ")[0] : "Войти";
  $("#avatar").innerHTML = currentUser?.avatar_url ? `<img src="${escapeHtml(currentUser.avatar_url)}" alt="" class="avatar-image">` : initial;
  $("#profile-avatar").innerHTML = currentUser?.avatar_url ? `<img src="${escapeHtml(currentUser.avatar_url)}" alt="" class="avatar-image">` : initial;
  for (const el of [$("#avatar"), $("#profile-avatar")]) el.querySelector("img")?.addEventListener("error", () => { el.innerHTML = fallback; }, { once: true });
  $("#profile-name").textContent = currentUser ? name : "Гость";
  $("#profile-handle").textContent = currentUser?.username ? `@${currentUser.username}` : "";
  $("#profile-id").textContent = currentUser ? `Telegram ID · ${currentUser.telegram_id}` : "";
  $$(".moderator-only").forEach(item => item.classList.toggle("hidden", !currentUser?.is_moderator));
  if (!currentUser) $("#my-submissions").innerHTML = '<div class="list-empty"><button class="tonal-button" id="profile-login">Войти через Telegram</button></div>';
  else loadMySubmissions();
}

let activeMod = null;
let activeScreenshot = 0;
async function openMod(modId, push = true) {
  if (push) history.pushState({ fromCatalog: true }, "", `#/mods/${encodeURIComponent(modId)}`);
  setView("mod");
  $("#detail-title").textContent = "Загрузка…";
  $("#detail-thumbs").innerHTML = "";
  $("#gallery-placeholder").hidden = false;
  $("#detail-image").hidden = true;
  try {
    const { mod } = await api(`/api/mods/${encodeURIComponent(modId)}`);
    activeMod = mod;
    activeScreenshot = 0;
    $("#detail-category").textContent = mod.tags?.[0] || "Мод";
    $("#detail-tags").innerHTML = (mod.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    $("#detail-title").textContent = mod.title;
    $("#detail-author-name").textContent = mod.author || "Сообщество";
    $("#detail-description").textContent = mod.description || "";
    $("#detail-version").textContent = mod.game_version || "—";
    $("#detail-size").textContent = mod.file_size ? `${(mod.file_size / 1048576).toFixed(1)} МБ` : "—";
    $("#detail-download").href = mod.telegram_post_url || "#";
    const avatar = mod.author_avatar_url ? `<img src="${escapeHtml(mod.author_avatar_url)}" alt="" class="avatar-image">` : icon("user");
    $("#detail-avatar").innerHTML = avatar;
    const avatarImage = $("#detail-avatar img");
    if (avatarImage) avatarImage.addEventListener("error", () => { $("#detail-avatar").innerHTML = icon("user"); }, { once: true });
    const urls = mod.screenshot_urls || [];
    $("#detail-thumbs").innerHTML = urls.map((url, index) => `<button class="gallery-thumb${index === 0 ? " active" : ""}" data-screenshot="${index}" aria-label="Скриншот ${index + 1}"><img src="${escapeHtml(url)}" alt="" loading="lazy"></button>`).join("");
    $("#gallery-main").classList.toggle("has-image", urls.length > 0);
    $("#gallery-placeholder").hidden = urls.length > 0;
    $("#gallery-prev").classList.toggle("hidden", urls.length < 2);
    $("#gallery-next").classList.toggle("hidden", urls.length < 2);
    if (urls.length) showScreenshot(0);
  } catch (error) {
    $("#detail-title").textContent = error.message;
  }
}

function showScreenshot(index) {
  const urls = activeMod?.screenshot_urls || [];
  if (!urls.length) return;
  activeScreenshot = (index + urls.length) % urls.length;
  const image = $("#detail-image");
    image.src = urls[activeScreenshot];
    image.alt = `${activeMod.title} — скриншот ${activeScreenshot + 1}`;
    image.onerror = () => { image.hidden = true; $("#gallery-placeholder").hidden = false; };
  image.hidden = false;
  $("#gallery-placeholder").hidden = true;
  $$(".gallery-thumb").forEach((thumb, i) => thumb.classList.toggle("active", i === activeScreenshot));
}

function syncHashRoute() {
  const match = location.hash.match(/^#\/mods\/(.+)$/);
  if (match) {
    openMod(decodeURIComponent(match[1]), false);
    return;
  }
  const view = location.hash.replace(/^#/, "");
  setView(["profile", "upload", "moderation"].includes(view) ? view : "catalog");
}

const statusNames = { pending: "На проверке", approved: "Опубликован", rejected: "Отклонён" };
function statusPill(status) { return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(statusNames[status] || status)}</span>`; }
async function loadMySubmissions() {
  if (!currentUser) return;
  try {
    const { submissions = [] } = await api("/api/submissions/mine");
    $("#my-submissions").innerHTML = submissions.length ? submissions.map(item => `<div class="submission-row"><div><h3>${escapeHtml(item.title)}</h3><small>${new Date(item.created_at).toLocaleDateString("ru-RU")}${item.rejection_reason ? ` · ${escapeHtml(item.rejection_reason)}` : ""}</small></div>${statusPill(item.status)}</div>`).join("") : '<div class="list-empty">Пока пусто</div>';
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

for (const button of $$('[data-view]')) button.addEventListener("click", () => {
  const view = button.dataset.view;
  if (location.hash.startsWith("#/mods/")) history.pushState({}, "", `#${view}`);
  setView(view);
});
for (const link of $$('[data-nav]')) link.addEventListener("click", event => {
  event.preventDefault();
  if (location.hash.startsWith("#/mods/")) history.pushState({}, "", `#${link.dataset.nav}`);
  setView(link.dataset.nav);
});
document.addEventListener("click", event => {
  const card = event.target.closest("[data-mod-id]");
  if (card && !event.target.closest("a,button")) openMod(card.dataset.modId);
  const thumb = event.target.closest("[data-screenshot]");
  if (thumb) showScreenshot(Number(thumb.dataset.screenshot));
});
document.addEventListener("keydown", event => {
  const card = event.target.closest("[data-mod-id]");
  if (card && !event.target.closest("a,button") && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openMod(card.dataset.modId); }
});
$("#detail-back").addEventListener("click", () => {
  if (history.state?.fromCatalog) history.back();
  else { history.replaceState({}, "", "#catalog"); setView("catalog"); }
});
$("#gallery-prev").addEventListener("click", () => showScreenshot(activeScreenshot - 1));
$("#gallery-next").addEventListener("click", () => showScreenshot(activeScreenshot + 1));
window.addEventListener("popstate", syncHashRoute);
window.addEventListener("hashchange", syncHashRoute);
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

async function loadConfig() {
  const link = $("#submit-via-bot");
  const status = $("#bot-submit-status");
  try {
    const config = await api("/api/config");
    submissionBotUrl = config.submission_bot_url;
    if (submissionBotUrl) link.href = submissionBotUrl;
    if (!config.bot_ready) {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
      link.classList.add("disabled");
      status.textContent = "Бот пока не подключён.";
    }
  } catch {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.classList.add("disabled");
    status.textContent = "Не удалось подключиться к боту.";
  }
}

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setView("catalog"); $("#search").focus(); }
});

loadConfig();
loadUser().finally(async () => {
  await loadCatalog();
  syncHashRoute();
});
