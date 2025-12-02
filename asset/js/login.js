(function () {
    const COMPANY_NAME = "Tổng công ty thiết bị điện Đông Anh - EEMC";
    const BLUE = "#1877f2";

    function injectStyles() {
        if (document.getElementById("auth-styles")) return;
        const css = `
        :root { --auth-blue:${BLUE}; --auth-green:#42b72a; --auth-bg:#f0f2f5; --auth-card:#fff; --auth-text:#1c1e21; }
        html, body { height: 100%; }
        body.auth-page { margin:0; background: var(--auth-bg); color: var(--auth-text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
        .auth-wrap { min-height:100%; display:grid; grid-template-columns: 1fr minmax(360px, 396px); align-items:center; justify-content:center; gap: 48px; padding: 40px 24px; max-width: 980px; margin: 0 auto; }
        .auth-brand { user-select:none; }
        .auth-brand__title { font-size: 56px; font-weight: 700; color: var(--auth-blue); line-height: 56px; letter-spacing: -0.02em; margin: 0 0 12px; }        
        .auth-card { background: var(--auth-card); border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.08), 0 8px 32px rgba(0,0,0,0.06); padding: 16px;
                     width: 100%; max-width: 350px; height: 350px; max-height:350px; margin-left: auto; margin-right: auto; overflow: hidden; } /* ensure inputs stay inside */
        .auth-card form { display: flex; flex-direction: column; } /* vertical layout */
        .auth-input { width:100%; box-sizing: border-box; height: 52px; border: 1px solid #dddfe2; border-radius: 6px; padding: 0 14px; font-size: 17px; outline: none; }
        .auth-input + .auth-input { margin-top: 12px; }
        .auth-input:focus { border-color: var(--auth-blue); box-shadow: 0 0 0 2px rgba(24,119,242,0.15); }
        .auth-btn { width:100%; height: 48px; border: none; border-radius: 6px; font-weight: 700; font-size: 20px; cursor: pointer; }
        .auth-btn--login { background: var(--auth-blue); color: #fff; margin-top: 14px; }
        .auth-link { display:block; text-align:center; color: var(--auth-blue); font-size: 14px; margin: 14px 0; text-decoration: none; }
        .auth-divider { height: 1px; background: #dadde1; margin: 16px 0; }
        .auth-btn--create { background: var(--auth-green); color: #fff; width: auto; padding: 0 16px; margin: 10px auto 6px; display:block; }
        .auth-foot { text-align:center; font-size: 12px; color: #606770; margin-top: 16px; }
        .auth-error { color: #d93025; font-size: 14px; text-align:center; min-height: 18px; margin-top: 8px; }
        @media (max-width: 900px) { .auth-wrap { grid-template-columns: 1fr; gap: 24px; } .auth-brand { text-align:center; } .auth-brand__title { font-size: 42px; line-height: 44px; } }
        `;
        const style = document.createElement("style");
        style.id = "auth-styles";
        style.textContent = css;
        document.head.appendChild(style);
    }

    let cachedUsers = null;
    async function loadUsersFromFile() {
        if (cachedUsers) return cachedUsers;
        // Try a few likely paths depending on where the HTML is served from.
        const candidates = [
            "asset/txt/user.txt", // when HTML is at project root (we moved login.html)
            "txt/user.txt",       // possible root-relative txt folder
            "../txt/user.txt"     // legacy: when HTML stayed in asset/html
        ];

        let txt = null;
        for (const path of candidates) {
            try {
                const resp = await fetch(path, { cache: "no-store" });
                if (!resp.ok) continue;
                txt = await resp.text();
                break;
            } catch (e) {
                // try next candidate
            }
        }

        if (!txt) {
            cachedUsers = [];
            return cachedUsers;
        }

        try {
            cachedUsers = txt
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean)
                .map(l => {
                    const parts = l.split(/\s*-\s*/);
                    if (parts.length >= 5) {
                        return { id: parts[0], email: parts[1].toLowerCase(), password: parts[2], name: parts[3], role: parts[4] };
                    }
                    if (parts.length >= 4) {
                        return { id: parts[0], email: parts[1].toLowerCase(), password: parts[2], name: parts[3], role: "Thành viên" };
                    }
                    if (parts.length >= 3) {
                        return { id: parts[0], email: parts[1].toLowerCase(), password: parts[2], name: "", role: "Thành viên" };
                    }
                    return null;
                })
                .filter(Boolean);
        } catch (e) {
            cachedUsers = [];
        }
        return cachedUsers;
    }

    function setCurrentUserName(name) {
        localStorage.setItem("currentUserName", name);
    }

    async function handleLogin(e) {
        e.preventDefault();
        const emailEl = document.getElementById("authEmail");
        const passEl = document.getElementById("authPassword");
        const error = document.getElementById("authError");
        error.textContent = "";
        const email = emailEl.value.trim().toLowerCase();
        const password = passEl.value;

        if (!email || !password) {
            error.textContent = "Sai tài khoản hoặc mật khẩu";
            return;
        }

        const users = await loadUsersFromFile();
        const found = users.find(u => u.email === email && u.password === password);

        if (!found) {
            error.textContent = "Sai tài khoản hoặc mật khẩu";
            return;
        }

        error.style.color = "#2f8110";
        error.textContent = "Đăng nhập thành công";
        setCurrentUserName(email);
        const displayName = (found.name || email).trim();
        const role = (found.role || "Thành viên").trim() || "Thành viên";
        localStorage.setItem("currentUserId", (found.id || "").trim());
        localStorage.setItem("currentUserDisplayName", displayName);
        localStorage.setItem("currentUserRole", role);
        setTimeout(() => window.location.href = "index.html", 800);
    }

    function render() {
        if (localStorage.getItem("currentUserName")) {
            window.location.href = "index.html";
            return;
        }

        document.body.className = "auth-page";
        injectStyles();

        const root = document.createElement("div");
        root.className = "auth-wrap";
        root.innerHTML = `
            <section class="auth-brand">
                <h1 class="auth-brand__title">${COMPANY_NAME}</h1>
            </section>
            <section class="auth-card" role="form" aria-label="Đăng nhập">
                <form id="authForm" novalidate>
                    <input id="authEmail" class="auth-input" type="email" placeholder="Email công ty (@eemc.com.vn)" autocomplete="username" />
                    <input id="authPassword" class="auth-input" type="password" placeholder="Mật khẩu" autocomplete="current-password" />
                    <button class="auth-btn auth-btn--login" type="submit">Đăng nhập</button>
                    <div id="authError" class="auth-error"></div>
                    <a class="auth-link" href="#" id="forgotLink">Quên mật khẩu?</a>
                </form>
                <div class="auth-foot">Trang nội bộ EEMC</div>
            </section>
        `;
        document.body.innerHTML = "";
        document.body.appendChild(root);

        document.getElementById("authForm").addEventListener("submit", handleLogin);
        document.getElementById("forgotLink").addEventListener("click", (e) => {
            e.preventDefault();
            const error = document.getElementById("authError");
            error.style.color = "#d93025";
            error.textContent = "Liên hệ email admin duchx@eemc.com.vn để đặt lại mật khẩu.";
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", render);
    } else {
        render();
    }
})();
