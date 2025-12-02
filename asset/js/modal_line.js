import { getEventById, updateEvent, deleteEvent } from "./data_store.js";
import { getCurrentUser } from "./role.js";
import { openEditModal, realignTimelineAfterDeletion } from "./modal_edit.js";
import { isLo1Furnace, isLo2Furnace } from "./furnace.js";
import {
	STATUS_FLOW,
	deriveLo2EventStatus,
	normalizeStatusKey,
	buildTimeline,
	VOLTAGE_RULES,
	harmonizeLo2Timelines,
	refreshEventMetadata,
	getHighestVoltage
} from "./modal_register.js";
import { confirmDialog } from "./dialogs.js";

const STATUS_ACTIONS = {
	"Kế hoạch": { label: "Đăng ký", next: "Đã đăng ký" },
	"Đã đăng ký": { label: "Thực hiện", next: "Đang thực hiện" },
	"Đang thực hiện": { label: "Kết thúc", next: "Kết thúc" }
};
const DELAY_RETURNABLE_VARIANTS = new Set(["kehoach", "dadangky"]);
const LINE_LOCKED_VARIANTS = new Set(["dangthuchien", "ketthuc"]);

const state = {
	scheduleId: "",
	eventId: "",
	lineIndex: null,
	event: null,
	detail: null
};

let modalEl = null;
let lineLabelInput = null;
let serialInput = null;
let voltageInput = null;
let registrantInput = null;
let statusInput = null;
let historyList = null;
let statusBtn = null;
let editBtn = null;
let deleteBtn = null;
let delayBtn = null;
let planBtn = null;
let actionsContainer = null;

function collectLo2LineDetails() {
	if (!state.event || !Array.isArray(state.event.serialDetails)) {
		return [];
	}
	return state.event.serialDetails.slice(0, 2).filter(Boolean);
}

function getLineStatusVariant(detail) {
	return normalizeStatusKey(detail?.status || "");
}

function getDelayReturnStatus(detail) {
	if (!detail) {
		return "";
	}
	return detail._prevStatus || state.event?._prevStatus || "";
}

function isDelayReturnable(status) {
	if (!status) {
		return false;
	}
	return DELAY_RETURNABLE_VARIANTS.has(normalizeStatusKey(status));
}

function shouldRestrictToDeleteOnly(detail) {
	if (!detail || !state.event) {
		return false;
	}
	const furnaceLabel = state.event.furnace || state.event.furnaceLabel || "";
	if (!isLo2Furnace(furnaceLabel)) {
		return false;
	}
	if (normalizeStatusKey(detail.status || "") !== "kehoach") {
		return false;
	}
	const details = collectLo2LineDetails();
	return details.some(other => other !== detail && normalizeStatusKey(other.status || "") === "dangthuchien");
}

export function setupLineDetailModal() {
	if (modalEl) {
		return;
	}
	modalEl = document.getElementById("modalLineDetail");
	if (!modalEl) {
		return;
	}
	lineLabelInput = document.getElementById("lineDetailLineLabel");
	serialInput = document.getElementById("lineDetailSerial");
	voltageInput = document.getElementById("lineDetailVoltage");
	registrantInput = document.getElementById("lineDetailRegistrant");
	statusInput = document.getElementById("lineDetailStatus");
	historyList = document.getElementById("lineDetailHistory");
	statusBtn = document.getElementById("lineDetailStatusBtn");
	editBtn = document.getElementById("lineDetailEditBtn");
	deleteBtn = document.getElementById("lineDetailDeleteBtn");
	delayBtn = document.getElementById("lineDetailDelayBtn");
	planBtn = document.getElementById("lineDetailPlanBtn");
	actionsContainer = document.getElementById("modalLineDetailActions");

	modalEl.querySelectorAll("[data-modal-dismiss]").forEach(btn => {
		btn.addEventListener("click", closeModal);
	});
	statusBtn?.addEventListener("click", handleStatusAdvance);
	editBtn?.addEventListener("click", handleEditClick);
	deleteBtn?.addEventListener("click", handleDeleteLine);
	delayBtn?.addEventListener("click", handleDelayLine);
	planBtn?.addEventListener("click", handlePlanRevert);
}

export function openLineDetailModal({ scheduleId, eventId, lineIndex }) {
	if (!modalEl) {
		setupLineDetailModal();
	}
	if (!modalEl) {
		return;
	}
	const event = getEventById(scheduleId, eventId);
	if (!event) {
		return;
	}
	const normalizedIndex = Number(lineIndex) || 1;
	const detail = findLineDetail(event, normalizedIndex);
	if (!detail) {
		openEditModal({ scheduleId, eventId });
		return;
	}

	state.scheduleId = scheduleId;
	state.eventId = eventId;
	state.lineIndex = normalizedIndex;
	state.event = event;
	state.detail = detail;

	renderLineDetail();

	modalEl.hidden = false;
	modalEl.classList.add("is-open");
	document.body.classList.add("modal-open");
}

function closeModal() {
	if (!modalEl) {
		return;
	}
	modalEl.classList.remove("is-open");
	modalEl.hidden = true;
	document.body.classList.remove("modal-open");
	state.scheduleId = "";
	state.eventId = "";
	state.lineIndex = null;
	state.event = null;
	state.detail = null;
}

function renderLineDetail() {
	if (!state.detail) {
		return;
	}
	const detail = state.detail;
	if (lineLabelInput) {
		const furnaceLabel = state.event?.furnace || state.event?.furnaceLabel || "";
		const labelText = furnaceLabel ? `${furnaceLabel} • Line ${state.lineIndex}` : `Line ${state.lineIndex}`;
		lineLabelInput.value = labelText;
	}
	if (serialInput) {
		serialInput.value = detail.serial || "";
	}
	if (voltageInput) {
		voltageInput.value = detail.voltageLabel || (detail.voltageValue ? `${detail.voltageValue} kV` : "");
	}
	if (registrantInput) {
		registrantInput.value = detail.registrant || state.event?.registrant || "";
	}
	if (statusInput) {
		statusInput.value = detail.status || STATUS_FLOW[0];
	}
	renderHistory(detail);
	updateActionButtons(detail);
	updateDelayButtonState();
	updatePlanButtonState(detail);
}

function renderHistory(detail) {
	if (!historyList) {
		return;
	}
	historyList.innerHTML = "";
	const entries = Array.isArray(detail.history) ? detail.history : [];
	if (!entries.length) {
		const empty = document.createElement("p");
		empty.className = "history-log__empty";
		empty.textContent = "Chưa có thay đổi.";
		historyList.appendChild(empty);
		return;
	}
	entries.forEach(entry => {
		const item = document.createElement("div");
		item.className = "history-log__item";

		const statusSpan = document.createElement("span");
		statusSpan.className = "history-log__status";
		statusSpan.textContent = entry.status || "";

		const meta = document.createElement("span");
		meta.className = "history-log__meta";
		const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;
		const formatted = timestamp
			? new Intl.DateTimeFormat("vi-VN", {
					day: "2-digit",
					month: "2-digit",
					year: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit"
			  }).format(timestamp)
			: "";
		meta.textContent = `${entry.actor || ""} • ${formatted}`.trim();

		item.appendChild(statusSpan);
		item.appendChild(meta);
		historyList.appendChild(item);
	});
}

function updateActionButtons(detail) {
	if (!actionsContainer) {
		return;
	}
	const deleteOnly = shouldRestrictToDeleteOnly(detail);
	updateDeleteButtonState(detail);
	updateEditButtonMode(detail, deleteOnly);
	if (!statusBtn) {
		return;
	}
	const variant = normalizeStatusKey(detail.status || STATUS_FLOW[0]);
	if (deleteOnly || variant === "ketthuc" || variant === "delay") {
		statusBtn.hidden = true;
		actionsContainer.classList.toggle("modal__actions--single", true);
		if (deleteOnly && delayBtn) {
			delayBtn.hidden = true;
		}
		return;
	}
	const action = STATUS_ACTIONS[detail.status];
	if (!action) {
		statusBtn.hidden = true;
		return;
	}
	statusBtn.textContent = action.label;
	statusBtn.hidden = false;
	actionsContainer.classList.toggle("modal__actions--single", false);
}

function updateEditButtonMode(detail, deleteOnly = false) {
	if (!editBtn) {
		return;
	}
	if (deleteOnly) {
		editBtn.hidden = true;
		delete editBtn.dataset.mode;
		delete editBtn.dataset.returnStatus;
		return;
	}
	const variant = normalizeStatusKey(detail.status || STATUS_FLOW[0]);
	if (LINE_LOCKED_VARIANTS.has(variant)) {
		editBtn.hidden = true;
		delete editBtn.dataset.mode;
		delete editBtn.dataset.returnStatus;
		return;
	}
	editBtn.hidden = false;
	if (variant === "delay") {
		const prevStatus = getDelayReturnStatus(detail);
		if (isDelayReturnable(prevStatus)) {
			editBtn.textContent = prevStatus;
			editBtn.dataset.mode = "delay-return";
			editBtn.dataset.returnStatus = prevStatus;
			return;
		}
	}
	editBtn.textContent = "Sửa";
	delete editBtn.dataset.mode;
	delete editBtn.dataset.returnStatus;
}

function updateDeleteButtonState(detail) {
	if (!deleteBtn) {
		return;
	}
	const variant = normalizeStatusKey(detail.status || STATUS_FLOW[0]);
	const locked = LINE_LOCKED_VARIANTS.has(variant);
	deleteBtn.hidden = locked;
}

function updateDelayButtonState() {
	if (!delayBtn) {
		return;
	}
	if (shouldRestrictToDeleteOnly(state.detail)) {
		delayBtn.hidden = true;
		return;
	}
	const allowed = new Set(["kehoach", "dadangky"]);
	const variant = normalizeStatusKey(state.event?.status || "");
	delayBtn.hidden = !allowed.has(variant);
}

function updatePlanButtonState(detail) {
	if (!planBtn) {
		return;
	}
	const show = detail && normalizeStatusKey(detail.status || "") === "dadangky";
	planBtn.hidden = !show;
	planBtn.disabled = !show;
}

function handleStatusAdvance() {
	if (!state.detail) {
		return;
	}
	const currentStatus = state.detail.status || STATUS_FLOW[0];
	const action = STATUS_ACTIONS[currentStatus];
	if (!action) {
		return;
	}
	applyStatusChange(action.next);
}

function handleEditClick() {
	if (!state.scheduleId || !state.eventId) {
		return;
	}
	const currentVariant = normalizeStatusKey(state.detail?.status || "");
	if (currentVariant === "delay") {
		const returnStatus = getDelayReturnStatus(state.detail);
		if (isDelayReturnable(returnStatus)) {
			restoreDelayStatus(returnStatus);
			return;
		}
	}
	const furnaceLabel = state.event?.furnace || state.event?.furnaceLabel || "";
	const forceEditable = isLo1Furnace(furnaceLabel);
	const params = { scheduleId: state.scheduleId, eventId: state.eventId, forceEditable };
	closeModal();
	openEditModal(params);
}

async function handleDeleteLine() {
	if (!state.event || !state.detail) {
		return;
	}
	let confirmDelete = true;
	try {
		if (typeof confirmDialog === "function") {
			confirmDelete = await confirmDialog("Bạn có chắc muốn xóa line này không?");
		} else if (typeof window !== "undefined" && typeof window.confirm === "function") {
			confirmDelete = window.confirm("Bạn có chắc muốn xóa line này không?");
		}
	} catch (err) {
		confirmDelete = true;
	}
	if (!confirmDelete) {
		return;
	}
	const deleted = deleteCurrentLineDetail();
	if (deleted) {
		try {
			if (typeof window !== "undefined" && typeof window.showToast === "function") {
				window.showToast("Đã xóa line thành công", { type: "success" });
			}
		} catch (err) {
			// ignore toast error
		}
		closeModal();
	}
}

function handleDelayLine() {
	if (!state.event) {
		return;
	}
	const currentStatus = state.event.status || "";
	if (!(currentStatus === "Kế hoạch" || currentStatus === "Đã đăng ký")) {
		try {
			if (typeof window !== "undefined" && typeof window.showToast === "function") {
				window.showToast("Chỉ có thể Delay khi trạng thái là Kế hoạch hoặc Đã đăng ký", { type: "info" });
			}
		} catch (err) {
			// ignore toast errors
		}
		return;
	}
	state.event._prevStatus = currentStatus;
	state.event.status = "Delay";
	if (state.detail) {
		const linePrevStatus = state.detail.status || currentStatus || STATUS_FLOW[0];
		state.detail._prevStatus = linePrevStatus;
		state.detail.status = "Delay";
	}
	const actor = getCurrentUser().name;
	const entry = {
		status: "Delay",
		actor,
		timestamp: new Date().toISOString()
	};
	if (Array.isArray(state.event.history)) {
		state.event.history = [...state.event.history, entry];
	} else {
		state.event.history = [entry];
	}
	if (state.detail) {
		if (Array.isArray(state.detail.history)) {
			state.detail.history = [...state.detail.history, entry];
		} else {
			state.detail.history = [entry];
		}
	}
	persistEvent();
	refreshTimelineBars();
	updateDelayButtonState();
	try {
		if (typeof window !== "undefined" && typeof window.showToast === "function") {
			window.showToast("Đã chuyển lịch sang Delay", { type: "success" });
		}
	} catch (err) {
		// ignore toast errors
	}
	closeModal();
}

function handlePlanRevert() {
	if (!state.detail || !state.event) {
		return;
	}
	const variant = normalizeStatusKey(state.detail.status || "");
	if (variant !== "dadangky") {
		return;
	}
	const actor = getCurrentUser().name || state.detail.registrant || state.event.registrant || "";
	const timestamp = new Date().toISOString();
	applyStatusChangeToDetail(state.detail, "Kế hoạch", actor, timestamp);
	recalculateEventStatus();
	const furnaceLabel = state.event.furnace || state.event.furnaceLabel || "";
	if (!isLo2Furnace(furnaceLabel)) {
		state.event.status = "Kế hoạch";
	}
	const currentStatus = state.event.status || "Kế hoạch";
	const eventEntry = { status: currentStatus, actor, timestamp };
	if (Array.isArray(state.event.history)) {
		state.event.history = [...state.event.history, eventEntry];
	} else {
		state.event.history = [eventEntry];
	}
	persistEvent();
	renderLineDetail();
	refreshTimelineBars();
	refreshAllTimelineBars();
	updateDelayButtonState();
	try {
		if (typeof window !== "undefined" && typeof window.showToast === "function") {
			window.showToast("Đã chuyển line về trạng thái Kế hoạch", { type: "success" });
		}
	} catch (err) {
		// ignore toast errors
	}
	closeModal();
}

function restoreDelayStatus(targetStatus) {
	if (!state.event || !state.detail) {
		return;
	}
	if (!isDelayReturnable(targetStatus)) {
		return;
	}
	state.detail.status = targetStatus;
	delete state.detail._prevStatus;
	const actor = getCurrentUser().name;
	const timestamp = new Date().toISOString();
	const detailEntry = { status: targetStatus, actor, timestamp };
	if (Array.isArray(state.detail.history)) {
		state.detail.history = [...state.detail.history, detailEntry];
	} else {
		state.detail.history = [detailEntry];
	}
	delete state.event._prevStatus;
	recalculateEventStatus();
	const eventEntry = { status: state.event.status, actor, timestamp };
	if (Array.isArray(state.event.history)) {
		state.event.history = [...state.event.history, eventEntry];
	} else {
		state.event.history = [eventEntry];
	}
	persistEvent();
	renderLineDetail();
	refreshTimelineBars();
	updateDelayButtonState();
	try {
		if (typeof window !== "undefined" && typeof window.showToast === "function") {
			window.showToast("Đã khôi phục trạng thái trước Delay", { type: "success" });
		}
	} catch (err) {
		// ignore toast errors
	}
	closeModal();
}

function applyStatusChange(newStatus) {
	if (!state.detail || !state.event) {
		return;
	}
	const actor = getCurrentUser().name;
	const timestamp = new Date().toISOString();
	const shouldCouple = shouldCoupleStatusChange(newStatus);
	const detailsToUpdate = shouldCouple ? collectLo2LineDetails() : [state.detail];
	detailsToUpdate.forEach(detail => applyStatusChangeToDetail(detail, newStatus, actor, timestamp));
	recalculateEventStatus();
	persistEvent();
	renderLineDetail();
	refreshTimelineBars();
	if (shouldCouple) {
		refreshAllTimelineBars();
	}

	try {
		if (typeof window !== "undefined" && typeof window.showToast === "function") {
			window.showToast("Cập nhật trạng thái line thành công", { type: "success" });
		}
	} catch (err) {
		// ignore toast errors
	}
	closeModal();
}

function shouldCoupleStatusChange(newStatus) {
	if (!state.event) {
		return false;
	}
	const furnaceLabel = state.event.furnace || state.event.furnaceLabel || "";
	if (!isLo2Furnace(furnaceLabel)) {
		return false;
	}
	const normalized = normalizeStatusKey(newStatus);
	const requiredCurrent = (() => {
		if (normalized === "dangthuchien") return "dadangky";
		if (normalized === "ketthuc") return "dangthuchien";
		return null;
	})();
	if (!requiredCurrent) {
		return false;
	}
	const details = collectLo2LineDetails();
	if (details.length < 2) {
		return false;
	}
	return details.every(detail => getLineStatusVariant(detail) === requiredCurrent);
}

function applyStatusChangeToDetail(detail, newStatus, actor, timestamp) {
	if (!detail) {
		return;
	}
	const safeActor = actor || detail.registrant || state.event?.registrant || "";
	const safeTimestamp = timestamp || new Date().toISOString();
	detail.status = newStatus;
	const entry = { status: newStatus, actor: safeActor, timestamp: safeTimestamp };
	if (Array.isArray(detail.history)) {
		detail.history = [...detail.history, entry];
	} else {
		detail.history = [entry];
	}
}

function recalculateEventStatus() {
	if (!state.event) {
		return;
	}
	state.event.status = deriveLo2EventStatus(state.event.serialDetails, state.event.status);
}

function deleteCurrentLineDetail() {
	if (!state.event || !Array.isArray(state.event.serialDetails)) {
		return false;
	}
	const targetIndex = state.lineIndex;
	const details = state.event.serialDetails.slice();
	const removeIndex = details.findIndex(detail => Number(detail.lineIndex) === targetIndex);
	const actualIndex = removeIndex >= 0 ? removeIndex : Math.max(0, targetIndex - 1);
	if (details.length === 0 || actualIndex < 0 || actualIndex >= details.length) {
		return false;
	}
	details.splice(actualIndex, 1);
	state.event.serialDetails = details.map((detail, idx) => ({ ...detail, lineIndex: idx + 1 }));
	state.event.serials = state.event.serialDetails.map(detail => {
		const voltageLabel = detail.voltageLabel || (detail.voltageValue ? `${detail.voltageValue} kV` : "");
		return [detail.serial, voltageLabel ? `(${voltageLabel})` : ""].filter(Boolean).join(" ");
	});
	state.event.quantity = state.event.serialDetails.length;
	state.event.slots = state.event.quantity;
	const furnaceLabel = state.event.furnace || state.event.furnaceLabel || "";
	const isLo2 = isLo2Furnace(furnaceLabel);

	recalculateEventStatus();

	if (state.event.serialDetails.length === 0) {
		removeAllTimelineBarsForEvent(state.event.id);
		removeEventFromStore();
		return true;
	}

	rebuildTimelineForRemainingLines(isLo2);
	persistEvent();
	if (isLo2 && state.scheduleId) {
		try {
			harmonizeLo2Timelines(state.scheduleId);
		} catch (err) {
			console.warn("deleteCurrentLineDetail: harmonizeLo2Timelines failed", err);
		}
	}
	removeTimelineBarsForLine(targetIndex);
	return true;
}

function rebuildTimelineForRemainingLines(isLo2Event) {
	if (!state.event) {
		return;
	}
	const details = Array.isArray(state.event.serialDetails) ? state.event.serialDetails : [];
	if (!details.length) {
		return;
	}
	const baseStartISO = state.event.timeline?.start || state.event.date;
	if (!baseStartISO) {
		return;
	}
	const highestVoltage = getHighestVoltage(details);
	const durationKey = highestVoltage === "220" ? "220" : "110";
	const durationRules = VOLTAGE_RULES[durationKey] || VOLTAGE_RULES["110"];
	if (!durationRules) {
		return;
	}
	const options = isLo2Event ? { allowSundaySecondHalfStart: true } : {};
	try {
		state.event.timeline = buildTimeline(baseStartISO, durationRules, options);
		state.event.voltageLabel = highestVoltage === "220" ? "220 kV" : "< 220 kV";
		refreshEventMetadata(state.event);
	} catch (err) {
		console.warn("rebuildTimelineForRemainingLines failed", err);
	}
}


function removeTimelineBarsForLine(lineIndex, { removePlaceholders = false } = {}) {
	if (!state.eventId || !lineIndex) {
		return;
	}
	const bars = document.querySelectorAll(`[data-event-id="${state.eventId}"][data-line-index="${lineIndex}"]`);
	bars.forEach(bar => {
		const isPlaceholder = bar.dataset.placeholder === "true";
		if (!removePlaceholders && isPlaceholder) {
			return;
		}
		bar.remove();
	});
}

function removeAllTimelineBarsForEvent(eventId) {
	if (!eventId) {
		return;
	}
	document.querySelectorAll(`[data-event-id="${eventId}"]`).forEach(bar => bar.remove());
}

function removeEventFromStore() {
	if (!state.scheduleId || !state.event) {
		return;
	}
	const eventId = state.event.id;
	const snapshot = state.event;
	try {
		const removed = deleteEvent(state.scheduleId, eventId) || snapshot;
		try {
			realignTimelineAfterDeletion(state.scheduleId, removed);
		} catch (err) {
			console.warn("removeEventFromStore: realignTimelineAfterDeletion failed", err);
		}
	} catch (err) {
		console.error("Không thể xóa sự kiện sau khi xóa toàn bộ line:", err);
	}
	state.detail = null;
	state.event = null;
	state.eventId = "";
	state.lineIndex = null;
	document.dispatchEvent(new CustomEvent("registration:deleted", { detail: { scheduleId: state.scheduleId, eventId } }));
}

function persistEvent() {
	try {
		const updated = updateEvent(state.scheduleId, state.event);
		if (updated) {
			state.event = updated;
			state.detail = findLineDetail(state.event, state.lineIndex) || state.detail;
		}
		document.dispatchEvent(new CustomEvent("registration:saved", { detail: state.event }));
	} catch (err) {
		console.error("Không thể lưu trạng thái line:", err);
	}
}

function refreshTimelineBars() {
	if (!state.eventId || !state.lineIndex) {
		return;
	}
	const variant = normalizeStatusKey(state.detail?.status || STATUS_FLOW[0]);
	const furnaceLabel = state.event?.furnace || state.event?.furnaceLabel || "";
	const tone = isLo2Furnace(furnaceLabel) ? "lo2" : "lo1";
	const bars = document.querySelectorAll(`[data-event-id="${state.eventId}"][data-line-index="${state.lineIndex}"]`);
	bars.forEach(bar => {
		const classesToRemove = Array.from(bar.classList).filter(cls => cls.startsWith("timeline-bar--status-"));
		classesToRemove.forEach(cls => bar.classList.remove(cls));
		bar.classList.add(`timeline-bar--status-${variant}-${tone}`);
		updateTimelineBarLabel(bar, state.detail?.status || STATUS_FLOW[0]);
	});
}

function refreshAllTimelineBars() {
	if (!state.event || !state.eventId) {
		return;
	}
	const furnaceLabel = state.event.furnace || state.event.furnaceLabel || "";
	const tone = isLo2Furnace(furnaceLabel) ? "lo2" : "lo1";
	const bars = document.querySelectorAll(`[data-event-id="${state.eventId}"][data-line-index]`);
	bars.forEach(bar => {
		const lineIndex = Number(bar.dataset.lineIndex);
		const detail = findLineDetail(state.event, lineIndex);
		if (!detail) {
			return;
		}
		const variant = normalizeStatusKey(detail.status || STATUS_FLOW[0]);
		const classesToRemove = Array.from(bar.classList).filter(cls => cls.startsWith("timeline-bar--status-"));
		classesToRemove.forEach(cls => bar.classList.remove(cls));
		bar.classList.add(`timeline-bar--status-${variant}-${tone}`);
		updateTimelineBarLabel(bar, detail.status || STATUS_FLOW[0]);
	});
}

function updateTimelineBarLabel(bar, statusLabel) {
	if (!bar || !statusLabel) {
		return;
	}
	const title = bar.title || "";
	if (!title.includes("•")) {
		return;
	}
	const segments = title.split("•").map(part => part.trim());
	if (segments.length < 4) {
		return;
	}
	segments[3] = statusLabel;
	const nextLabel = segments.join(" • ");
	bar.title = nextLabel;
	if (bar.dataset.hasLabel === "true") {
		bar.textContent = nextLabel;
	}
}

function findLineDetail(event, lineIndex) {
	if (!event || !Array.isArray(event.serialDetails)) {
		return null;
	}
	const byIndex = event.serialDetails.find(detail => Number(detail.lineIndex) === lineIndex);
	if (byIndex) {
		return byIndex;
	}
	return event.serialDetails[lineIndex - 1] || null;
}
