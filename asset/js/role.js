// User/role helpers for the dashboard.

const STORAGE_KEYS = {
	username: "currentUserName",
	displayName: "currentUserDisplayName",
	role: "currentUserRole",
	userId: "currentUserId"
};

function normalizeRole(role) {
	if (!role) {
		return "Thành viên";
	}
	const trimmed = String(role).trim();
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function getCurrentUser() {
	const name = localStorage.getItem(STORAGE_KEYS.displayName) || localStorage.getItem(STORAGE_KEYS.username) || "Khách";
	const role = normalizeRole(localStorage.getItem(STORAGE_KEYS.role) || "Thành viên");
	const id = localStorage.getItem(STORAGE_KEYS.userId) || "";
	return { id, name, role };
}

export function ensureAuthenticated() {
	if (!localStorage.getItem(STORAGE_KEYS.username)) {
		window.location.href = "login.html";
	}
}

export function clearCurrentUser() {
	Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
}
