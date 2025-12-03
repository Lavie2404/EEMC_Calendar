import { getEventById, deleteEvent, getScheduleById, updateEvent } from "./data_store.js";
import { buildTimeline, VOLTAGE_RULES, resolvePhaseAnchorsForRegistration, harmonizeLo2Timelines } from "./modal_register.js";
import { alertDialog, confirmDialog } from "./dialogs.js";
import { getCurrentUser } from "./role.js";
import { isLo2Furnace, isLo1Furnace, normalizeFurnaceLabel } from "./furnace.js";

const VOLTAGE_OPTIONS = [
	{ value: "110", label: "110" },
	{ value: "220", label: "220" }
];

const STATUS_FLOW = ["Kế hoạch", "Đã đăng ký", "Đang thực hiện", "Kết thúc"];
const STATUS_ACTIONS = {
	"Kế hoạch": { label: "Đăng ký", next: "Đã đăng ký" },
	"Đã đăng ký": { label: "Thực hiện", next: "Đang thực hiện" },
	"Đang thực hiện": { label: "Kết thúc", next: "Kết thúc" }
};

const state = {
	initialized: false,
	event: null,
	scheduleId: "",
	forceEditable: false
};

let modalEl = null;
let formEl = null;
let dateInput = null;
let nameInput = null;
let furnaceInput = null;
let voltageInput = null;
let quantityInput = null;
let statusInput = null;
let historyList = null;
let serialGrid = null;
let actionsContainer = null;
let statusActionBtn = null;
let delayActionBtn = null;
let editActionBtn = null;

export function setupEditModal() {
	if (state.initialized) {
		return;
	}
	modalEl = document.getElementById("modalEdit");
	if (!modalEl) {
		return;
	}
	formEl = document.getElementById("modalEditForm");
	dateInput = document.getElementById("edit-date");
	nameInput = document.getElementById("edit-name");
	furnaceInput = document.getElementById("edit-furnace");
	quantityInput = document.getElementById("edit-quantity");
	statusInput = document.getElementById("edit-status");
	historyList = document.getElementById("edit-history");
	serialGrid = document.getElementById("edit-serial-container");
	actionsContainer = document.getElementById("modalEditActions");
	statusActionBtn = document.getElementById("modalEditStatusBtn");
	delayActionBtn = document.getElementById("modalEditDelayBtn");
	editActionBtn = document.getElementById("modalEditEditBtn");

	modalEl.querySelectorAll("[data-modal-dismiss]").forEach(btn => {
		btn.addEventListener("click", closeModal);
	});
	statusActionBtn?.addEventListener("click", handleStatusAdvance);
	delayActionBtn?.addEventListener("click", handleDelayToggle);
	editActionBtn?.addEventListener("click", handleEditToggle);

	// forward-register: nếu người dùng bấm "Lưu" ở modalRegister trong khi đang sửa modalEdit,
	// chuyển hành động đó thành commit edit cho modalEdit (theo yêu cầu)
	const regSaveBtn = document.getElementById("modalRegisterSubmit");
	regSaveBtn?.addEventListener("click", function (ev) {
		// only intercept when edit modal is open and editing mode active
		if (state.event && state.event._editing && modalEl && !modalEl.hidden) {
			ev.preventDefault();
			// collect newDate and serials from edit modal inputs
			const newDate = dateInput?.value || state.event.date;
			const serialInputs = Array.from(serialGrid.querySelectorAll(".serial-grid__row"));
			const newSerials = serialInputs.map(row => {
				const s = row.querySelector("input")?.value?.trim() || "";
				const v = row.querySelector("select")?.value || "";
				return { serial: s, voltageValue: v, voltageLabel: v ? `${v} kV` : "" };
			}).filter(s => s.serial);
			commitEditChanges(newDate, newSerials);
		}
	});

	state.initialized = true;
}

// Helpers: convert between ISO and display (DD-MM-YYYY)
function parseISODateEdit(iso) {
	if (!iso) return null;
	if (String(iso).includes("T")) return new Date(iso);
	return new Date(`${iso}T12:00:00`);
}
function isoToDisplayEdit(iso) {
	if (!iso) return "";
	const d = parseISODateEdit(iso);
	if (!d || isNaN(d.getTime())) return "";
	return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
function displayToISOEdit(display) {
	if (!display) return null;
	const s = String(display).trim();
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
	const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
	if (m) return `${m[3]}-${m[2]}-${m[1]}`;
	const p = Date.parse(s);
	if (!isNaN(p)) {
		const d = new Date(p);
		return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
	}
	return null;
}

export function openEditModal({ scheduleId, eventId, forceEditable = false }) {
	if (!state.initialized) {
		setupEditModal();
	}
	if (!modalEl) {
		return;
	}
	const event = getEventById(scheduleId, eventId);
	if (!event) {
		return;
	}
	state.event = event;
	state.scheduleId = scheduleId;
	state.forceEditable = Boolean(forceEditable);
	populateFields(event);

	modalEl.hidden = false;
	modalEl.classList.add("is-open");
	document.body.classList.add("modal-open");
	// notify inline page script to refresh the human-readable date label
	try {
		modalEl.dispatchEvent(new CustomEvent('show'));
	} catch (e) {
		// noop
	}
}

function populateFields(event) {
	// Use the canonical event date for the edit modal. Do not prefer the global
	// `#register-date` input because that can cause the edit modal to show a
	// different date unexpectedly when opened after a registration action.
	dateInput.value = event.date || "";
	nameInput.value = event.registrant || "";
	furnaceInput.value = event.furnace || "";
	quantityInput.value = event.quantity ?? "";
	statusInput.value = event.status || "";
	if (event) {
		delete event._editing;
	}
	renderSerialDetails(event.serialDetails, event.serials);
	// render edit/history entries (status changes, edits)
	renderHistoryDetails(Array.isArray(event.history) ? event.history : []);
	// pass the whole event so isDelay / _prevStatus are considered
	syncStatusActionUI(event);
	updateDelayButtonUI(event);
	const furnaceLabel = event.furnace || event.furnaceLabel || "";
	const forceEditable = Boolean(state.forceEditable);
	state.forceEditable = false;
	if (isLo1Furnace(furnaceLabel) && !forceEditable) {
		setDateInputReadonlyState(true);
		setSerialGridEditableState(false);
		updateEditButtonLabel();
	} else {
		enableInlineEditing();
	}
}

function enableInlineEditing() {
	if (!state.event) {
		return;
	}
	state.event._editing = true;
	if (!state.event._originalDate) {
		state.event._originalDate = state.event.date;
	}
	setDateInputReadonlyState(false);
	setSerialGridEditableState(true);
	if (editActionBtn) {
		editActionBtn.hidden = false;
		updateEditButtonLabel();
	}
}

function setDateInputReadonlyState(isReadonly) {
	if (!dateInput) {
		return;
	}
	if (isReadonly) {
		dateInput.readOnly = true;
		dateInput.classList.add("hide-picker");
	} else {
		dateInput.readOnly = false;
		dateInput.classList.remove("hide-picker");
	}
}

function updateEditButtonLabel() {
	if (!editActionBtn) {
		return;
	}
	const furnaceLabel = state.event?.furnace || state.event?.furnaceLabel || "";
	const isLo1 = isLo1Furnace(furnaceLabel);
	const isEditing = Boolean(state.event && state.event._editing);
	editActionBtn.textContent = isEditing ? "Lưu" : (isLo1 ? "Sửa" : "Lưu");
}

function renderSerialDetails(details = [], fallback = []) {
	if (!serialGrid) {
		return;
	}
	serialGrid.innerHTML = "";
	const rows = normalizeSerialDetails(details, fallback);
	if (!rows.length) {
		const empty = document.createElement("p");
		empty.className = "serial-grid__empty";
		empty.textContent = "Không có dữ liệu sê-ri.";
		serialGrid.appendChild(empty);
		return;
	}
	rows.forEach((detail, index) => {
		const row = document.createElement("div");
		row.className = "serial-grid__row";

		const serialInput = document.createElement("input");
		serialInput.type = "text";
		serialInput.value = detail.serial || "";
		serialInput.readOnly = true;
		row.appendChild(serialInput);

		const unitField = document.createElement("div");
		unitField.className = "serial-grid__unit-field";

		const voltageSelect = document.createElement("select");
		voltageSelect.disabled = true;

		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.hidden = true;
		placeholder.textContent = "Cấp điện áp";
		voltageSelect.appendChild(placeholder);

		VOLTAGE_OPTIONS.forEach(option => {
			const opt = document.createElement("option");
			opt.value = option.value;
			opt.textContent = option.label;
			if (option.value === (detail.voltageValue || "")) {
				opt.selected = true;
			}
			voltageSelect.appendChild(opt);
		});

		voltageSelect.value = detail.voltageValue || "";
		unitField.appendChild(voltageSelect);

		const unit = document.createElement("span");
		unit.className = "serial-grid__unit";
		unit.textContent = "kV";
		unitField.appendChild(unit);

		row.appendChild(unitField);
		serialGrid.appendChild(row);
	});

	setSerialGridEditableState(Boolean(state.event && state.event._editing));
}

function setSerialGridEditableState(isEditable) {
	if (!serialGrid) {
		return;
	}
	serialGrid.classList.toggle("serial-grid--readonly", !isEditable);
	const inputs = serialGrid.querySelectorAll(".serial-grid__row input");
	inputs.forEach(input => {
		input.readOnly = !isEditable;
		if (!isEditable) {
			input.setAttribute("aria-readonly", "true");
		} else {
			input.removeAttribute("aria-readonly");
		}
	});
	const selects = serialGrid.querySelectorAll(".serial-grid__row select");
	selects.forEach(select => {
		select.disabled = !isEditable;
		if (!isEditable) {
			select.setAttribute("aria-disabled", "true");
		} else {
			select.removeAttribute("aria-disabled");
		}
	});
}

function normalizeSerialDetails(details, fallbackSummary) {
	if (Array.isArray(details) && details.length) {
		return details.map(entry => ({
			serial: entry.serial || "",
			voltageValue: entry.voltageValue || deriveVoltageValue(entry.voltageLabel),
			voltageLabel: entry.voltageLabel || ""
		}));
	}
	if (!Array.isArray(fallbackSummary) || !fallbackSummary.length) {
		return [];
}
	return fallbackSummary.map(item => {
		const match = item.match(/^(.*?)\s*\(([^)]+)\)/);
		const serial = match ? match[1].trim() : item.trim();
		const voltageLabel = match ? match[2].trim() : "";
		return {
			serial,
			voltageValue: deriveVoltageValue(voltageLabel),
			voltageLabel
		};
	});
}

function deriveVoltageValue(label = "") {
	const match = label.match(/(\d+)/);
	return match ? match[1] : "";
}

function determineVoltageKeyFromDetails(details = [], fallbackLabel = "", fallbackSerials = []) {
	try {
		if (Array.isArray(details) && details.length) {
			const normalized = details.map(detail => {
				if (!detail) return "";
				if (typeof detail === "string") {
					const m = detail.match(/(\d{2,3})/);
					return m ? m[1] : "";
				}
				return String(detail.voltageValue || detail.voltageLabel || "");
			});
			if (normalized.some(v => String(v).trim() === "220")) return "220";
			if (normalized.some(v => String(v).trim() === "110")) return "110";
		}
	} catch (e) {
		// ignore serial detail parsing errors
	}
	try {
		if (Array.isArray(fallbackSerials) && fallbackSerials.length) {
			if (fallbackSerials.some(serial => /220/.test(String(serial || "")))) return "220";
			if (fallbackSerials.some(serial => /110/.test(String(serial || "")))) return "110";
		}
	} catch (e) {
		// ignore summary parsing issues
	}
	const labelText = String(fallbackLabel || "").toLowerCase();
	if (labelText.includes("220")) {
		if (labelText.includes("<") || labelText.includes("≤") || labelText.includes("less")) {
			return "110";
		}
		return "220";
	}
	if (labelText.includes("110")) return "110";
	return "110";
}

function formatVoltageLabelByKey(voltageKey = "110") {
	return voltageKey === "220" ? "220 kV" : "< 220 kV";
}

function closeModal() {
	if (!modalEl) {
		return;
	}
	modalEl.classList.remove("is-open");
	modalEl.hidden = true;
	document.body.classList.remove("modal-open");
	setSerialGridEditableState(false);
	if (state.event) {
		delete state.event._editing;
		delete state.event._originalDate;
	}
	state.event = null;
	state.scheduleId = "";
	state.forceEditable = false;
}

function renderHistoryDetails(history = []) {
	if (!historyList) return;
	historyList.innerHTML = "";
	if (!Array.isArray(history) || history.length === 0) {
		const empty = document.createElement("p");
		empty.className = "history-log__empty";
		empty.textContent = "Chưa có lịch sử chỉnh sửa.";
		historyList.appendChild(empty);
		return;
	}
	history.forEach(entry => {
		const item = document.createElement("div");
		item.className = "history-log__item";

		const statusSpan = document.createElement("span");
		statusSpan.className = "history-log__status";
		statusSpan.textContent = entry.status || "";

		const metaSpan = document.createElement("span");
		metaSpan.className = "history-log__meta";
		const actor = entry.actor || "";
		const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;
		const formatted = timestamp
			? new Intl.DateTimeFormat("vi-VN", {
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
					day: "2-digit",
					month: "2-digit",
					year: "numeric"
			  }).format(timestamp)
			: "";
		metaSpan.textContent = `${actor} • ${formatted}`;

		// Layout: Status - Actor - Timestamp
		item.appendChild(statusSpan);
		item.appendChild(metaSpan);
		historyList.appendChild(item);
	});
}

// ---- Status action helpers ----
function handleStatusAdvance() {
	if (!state.event) {
		return;
	}

	// If currently in Delay, then this button acts as "restore previous status"
	const currentVariant = getEventStatusVariantLocal(state.event);
	if (currentVariant === "delay") {
		// restore
		const prev = state.event._prevStatus || STATUS_FLOW[0];
		state.event.status = prev;
		delete state.event._prevStatus;
		statusInput.value = state.event.status;

		// record history
		if (!Array.isArray(state.event.history)) state.event.history = [];
		state.event.history.push({
			status: state.event.status,
			actor: getCurrentUser().name,
			timestamp: new Date().toISOString()
		});

		// persist into store
		try {
			const stored = getEventById(state.scheduleId, state.event.id);
			if (stored) {
				stored.status = state.event.status;
				stored.history = Array.isArray(state.event.history) ? [...state.event.history] : stored.history;
				stored.summary = state.event.summary;
				stored.tooltip = state.event.tooltip;
			}
			// update bars using authoritative object
			updateTimelineBarsForEvent(stored || state.event);
            // persist the updated event
            if (stored) {
                try { updateEvent(state.scheduleId, stored); } catch (e) { /* noop */ }
            }
		} catch (e) {
			updateTimelineBarsForEvent(state.event);
		}

		// refresh UI
		refreshEventMetadata(state.event);
		syncStatusActionUI(state.event.status);
		updateDelayButtonUI(state.event.status);
		renderHistoryDetails(state.event.history || []);
		document.dispatchEvent(new CustomEvent("registration:saved", { detail: state.event }));
		closeModal();
		return;
	}

	// existing flow for advancing status
	const action = STATUS_ACTIONS[state.event.status];
	if (!action) {
		return;
	}
	// apply status change to modal's event object
	state.event.status = action.next;
	statusInput.value = state.event.status;

	// record into event.history
	if (!Array.isArray(state.event.history)) {
		state.event.history = [];
	}
	state.event.history.push({
		status: state.event.status,
		actor: getCurrentUser().name,
		timestamp: new Date().toISOString()
	});

	// refresh metadata for the modal copy
	refreshEventMetadata(state.event);
	syncStatusActionUI(state.event.status);
	// update the history panel immediately
	renderHistoryDetails(Array.isArray(state.event.history) ? state.event.history : []);

	// --- persist changes into the authoritative store event object ---
	try {
		const stored = getEventById(state.scheduleId, state.event.id);
		if (stored) {
			// copy only the fields we changed
			stored.status = state.event.status;
			stored.isDelay = state.event.isDelay ?? stored.isDelay;
			stored.history = Array.isArray(state.event.history) ? [...state.event.history] : stored.history;
			stored.summary = state.event.summary;
			stored.tooltip = state.event.tooltip;
			stored.timeline = state.event.timeline;
		}

		// compute new variant & tone and apply directly to timeline bars
		const newVariant = getEventStatusVariantLocal(stored || state.event);
		const tone = isLo2Furnace((stored || state.event).furnace || (stored || state.event).furnaceLabel || "") ? "lo2" : "lo1";
		setTimelineBarStatus((stored || state.event).id, newVariant, tone);
	} catch (e) {
		// fallback: update bars using modal copy
		const newVariant = getEventStatusVariantLocal(state.event);
		const tone = isLo2Furnace(state.event.furnace || state.event.furnaceLabel || "") ? "lo2" : "lo1";
		setTimelineBarStatus(state.event.id, newVariant, tone);
	}

	// persist the authoritative stored event if available
	try {
		const stored = getEventById(state.scheduleId, state.event.id);
		if (stored) updateEvent(state.scheduleId, stored);
	} catch (e) {
		// noop
	}

	// persist change to app (listeners will refresh calendar as well)
	document.dispatchEvent(new CustomEvent("registration:saved", { detail: state.event }));

	// close modal after updating UI
	closeModal();
}

// NEW: handle Delay button toggle - set Delay status and remember previous state
function handleDelayToggle() {
	if (!state.event) return;
	const current = state.event.status || "";
	// Only allow Delay when current is Kế hoạch or Đã đăng ký
	if (!(current === "Kế hoạch" || current === "Đã đăng ký")) {
		return;
	}
	// store previous
	state.event._prevStatus = current;
	// set to Delay
	state.event.status = "Delay";
	statusInput.value = state.event.status;

	// record history
	if (!Array.isArray(state.event.history)) state.event.history = [];
 state.event.history.push({
	 status: "Delay",
	 actor: getCurrentUser().name,
	 timestamp: new Date().toISOString()
 });

	// persist into store
	try {
		const stored = getEventById(state.scheduleId, state.event.id);
		if (stored) {
			stored._prevStatus = state.event._prevStatus;
			stored.status = "Delay";
			stored.history = Array.isArray(state.event.history) ? [...state.event.history] : stored.history;
			stored.summary = state.event.summary;
			stored.tooltip = state.event.tooltip;
		}
		updateTimelineBarsForEvent(stored || state.event);
	} catch {
		updateTimelineBarsForEvent(state.event);
	}

	// persist the updated event to storage
	try {
		const stored = getEventById(state.scheduleId, state.event.id);
		if (stored) updateEvent(state.scheduleId, stored);
	} catch (e) {
		// noop
	}

	// refresh UI
	refreshEventMetadata(state.event);
	syncStatusActionUI(state.event.status);
	updateDelayButtonUI(state.event.status);
	renderHistoryDetails(state.event.history || []);
	document.dispatchEvent(new CustomEvent("registration:saved", { detail: state.event }));
	closeModal();
}

// Update Delay button visibility/state (keeps logic centralized)
function updateDelayButtonUI(statusOrEvent) {
	if (!delayActionBtn) return;
	// accept either a status string or an event object
	let variant = null;
	const targetEvent = (typeof statusOrEvent === "object" && statusOrEvent)
		? statusOrEvent
		: state.event;
	if (typeof statusOrEvent === "string") {
		variant = normalizeStatusKey(statusOrEvent);
	} else if (statusOrEvent && typeof statusOrEvent === "object") {
		variant = getEventStatusVariantLocal(statusOrEvent);
	} else if (state.event) {
		variant = getEventStatusVariantLocal(state.event);
	} else {
		variant = "kehoach";
	}

	const showFor = new Set(["kehoach", "dadangky"]);

	if (targetEvent && isLo2Furnace(targetEvent.furnace || targetEvent.furnaceLabel || "")) {
		// Lò 2 không dùng Delay
		delayActionBtn.hidden = true;
		return;
	}

	// show Delay only for Kế hoạch and Đã đăng ký variants
	delayActionBtn.hidden = !showFor.has(variant);
}

// Ensure modal action buttons reflect current status.
// Accept either a status string or an event object so delay flags are detected.
function syncStatusActionUI(statusOrEvent) {
	if (!actionsContainer || !statusActionBtn) {
		return;
	}
	actionsContainer.hidden = false;
	const eventObj = (typeof statusOrEvent === "object" && statusOrEvent) ? statusOrEvent : state.event;
	if (eventObj && isLo2Furnace(eventObj.furnace || eventObj.furnaceLabel || "")) {
		statusActionBtn.hidden = true;
		if (delayActionBtn) delayActionBtn.hidden = true;
		updateDelayButtonUI(eventObj);
		return;
	}

	let variant;
	let statusStr = "";

	// determine variant and status string from either an Event object or a raw status value
	if (statusOrEvent && typeof statusOrEvent === "object") {
		variant = getEventStatusVariantLocal(statusOrEvent);
		statusStr = statusOrEvent.status || "";
	} else {
		statusStr = String(statusOrEvent || "");
		variant = normalizeStatusKey(statusStr);
	}

	// explicitly hide status button for final state "Kết thúc"
	if (variant === "ketthuc") {
		statusActionBtn.hidden = true;
		if (delayActionBtn) delayActionBtn.hidden = true;
		return;
	}

	// Delay state: main button restores previous status
	if (variant === "delay") {
		const prev = (statusOrEvent && typeof statusOrEvent === "object" && statusOrEvent._prevStatus)
			? statusOrEvent._prevStatus
			: (state.event && state.event._prevStatus) || "Khôi phục";
		statusActionBtn.hidden = false;
		actionsContainer.hidden = false;
		statusActionBtn.textContent = prev;
		if (delayActionBtn) delayActionBtn.hidden = true;
		return;
	}

	const action = STATUS_ACTIONS[statusStr];
	if (!action) {
		statusActionBtn.hidden = true;
		if (delayActionBtn) delayActionBtn.hidden = true;
		return;
	}

	// normal actionable states
	statusActionBtn.hidden = false;
	actionsContainer.hidden = false;
	statusActionBtn.textContent = action.label;

	// show/hide Delay depending on normalized variant or event
	updateDelayButtonUI(statusOrEvent);
}

// helper: normalise status text to a stable key
function normalizeStatusKey(value = "") {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/gi, "d") // map Vietnamese đ -> d
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

// helper: derive timeline variant from an event object (used by modal actions)
function getEventStatusVariantLocal(event) {
	if (!event) return "kehoach";
	const statusValue = (event.status || "").toString();
	// detect explicit delay flags
	const delayFlag = event.isDelay === true
		|| event.delay === true
		|| String(event.delay || "").toLowerCase() === "true"
		|| /delay/i.test(statusValue);
	if (delayFlag) return "delay";
	const normalized = normalizeStatusKey(statusValue);
	const allowed = new Set(["kehoach", "dadangky", "dangthuchien", "ketthuc"]);
	return allowed.has(normalized) ? normalized : "kehoach";
}

// helper: format a stage/date range for tooltips
function formatRange(startISO, endISO) {
	if (!startISO || !endISO) return "";
	const formatter = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit" });
	const start = formatter.format(parseISODate(startISO));
	const end = formatter.format(parseISODate(endISO));
	return `${start} → ${end}`;
}

// use shared helper `isLo2Furnace` from `asset/js/furnace.js`

// build timeline status css class for an event
function buildTimelineStatusClassLocal(event) {
	const variant = getEventStatusVariantLocal(event);
	const tone = isLo2Furnace(event.furnace || event.furnaceLabel || "") ? "lo2" : "lo1";
	return `timeline-bar--status-${variant}-${tone}`;
}

// update DOM timeline bar elements for a single event object (in-place)
function updateTimelineBarsForEvent(event) {
	if (!event || !event.id) return;
	const newStatusClass = buildTimelineStatusClassLocal(event);
	const bars = Array.from(document.querySelectorAll(`[data-event-id="${event.id}"]`));
	if (!bars.length) return;
	bars.forEach(bar => {
		// remove existing timeline-bar--status-* classes
		const classesToRemove = Array.from(bar.classList).filter(c => c.startsWith("timeline-bar--status-"));
		classesToRemove.forEach(c => bar.classList.remove(c));
		// add new class
		bar.classList.add(newStatusClass);

		// update tooltip/summary if available
		if (event.tooltip) {
			bar.title = event.tooltip;
		} else if (event.summary) {
			bar.title = event.summary;
		}

		// update stored base date so other flows (placeholders / openRegisterModal) use fresh start
		bar.dataset.baseDate = (event.timeline && event.timeline.start) ? event.timeline.start : (event.date || "");

		// If this slice was the first label slice, attempt to refresh visible text to keep it informative.
		// We avoid complex recomputation of segment labels here; prefer updating title (tooltip).
		try {
			if (bar.dataset.hasLabel === "true") {
				// keep existing text unless we can derive a simple replacement from summary
				if (event.summary) {
					bar.textContent = event.summary;
				}
			}
		} catch (e) {
			// noop - defensive
		}
	});
}

// explicit setter by variant/tone (used elsewhere)
function setTimelineBarStatus(eventId, variant, tone = "lo1") {
	if (!eventId || !variant) return;
	const classToAdd = `timeline-bar--status-${variant}-${tone}`;
	const bars = Array.from(document.querySelectorAll(`[data-event-id="${eventId}"]`));
	if (!bars.length) return;
	bars.forEach(bar => {
		const classesToRemove = Array.from(bar.classList).filter(c => c.startsWith("timeline-bar--status-"));
		classesToRemove.forEach(c => bar.classList.remove(c));
		bar.classList.add(classToAdd);
		if (!bar.classList.contains("timeline-bar")) {
			bar.classList.add("timeline-bar");
		}
	});
}

// refresh event summary/tooltip (used by modal when editing an event)
function refreshEventMetadata(event) {
	if (!event) return;
	const furnaceLabel = event.furnace || event.furnaceLabel || "";
	const registrant = event.registrant || "";
	const serials = Array.isArray(event.serials) ? event.serials : [];
	const status = event.status || "Kế hoạch";
	const timeline = event.timeline;
	if (!timeline) {
		// still update summary minimal fields
		event.summary = `${furnaceLabel} - ${registrant} - ${status}`;
		event.tooltip = `${furnaceLabel}\n${registrant}\n${status}`;
		return;
	}
	// Ensure event.date matches the timeline's effective phase1 start so that
	// code relying on event.date observes the real scheduled start.
	try {
		const phase1Start = timeline?.stages?.find(s => s.id === 'phase1')?.start || null;
		if (phase1Start) {
			event.date = phase1Start;
		}
	} catch (e) {
		// noop
	}
	event.slots = event.quantity || serials.length;
	event.summary = [
		furnaceLabel,
		registrant,
		event.quantity ? `SL ${event.quantity}` : "",
		Array.isArray(event.serials) ? `Serial ${event.serials.join(", ")}` : "",
		event.voltageLabel || "",
		status
	].filter(Boolean).join(" - ");
	// build tooltip with stages
	const lines = [
		`Lò: ${furnaceLabel}`,
		`Người đăng ký: ${registrant}`,
		`Số lượng: ${event.quantity ?? ""}`,
		`Số serial: ${Array.isArray(event.serials) ? event.serials.join(", ") : ""}`,
		`Cấp điện áp: ${event.voltageLabel || ""}`,
		`Trạng thái: ${status || ""}`
	];
	event.timeline?.stages?.forEach(stage => {
		lines.push(`${stage.label}: ${formatRange(stage.start, stage.end)} (${stage.durationDays} ngày)`);
	});
	event.tooltip = lines.filter(Boolean).join("\n");
}

// Helpers for editing and date shifts
function parseISODate(iso) {
	if (!iso) return null;
	// Preserve explicit datetimes, otherwise default date-only to PM
	if (String(iso).includes("T")) return new Date(iso);
	return new Date(`${iso}T12:00:00`);
}
function toISO(date) {
	const d = new Date(date);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
function daysDiffISO(aISO, bISO) {
	const a = parseISODate(aISO);
	const b = parseISODate(bISO);
	return Math.round((b - a) / 86400000);
}

// <-- ADDED HELPERS: prevent ReferenceError in rebuildTimelineSegments -->
function addDays(date, amount) {
	if (!date) return null;
	const d = new Date(date);
	d.setDate(d.getDate() + Number(amount || 0));
	return d;
}
function daysBetween(startDate, endDate) {
	if (!startDate || !endDate) return 0;
	const s = new Date(startDate);
	const e = new Date(endDate);
	// strip time part to compare by full days
	s.setHours(0,0,0,0);
	e.setHours(0,0,0,0);
	return Math.round((e - s) / 86400000);
}
// <-- end added helpers -->

function shiftEventByDays(eventObj, days) {
	if (!eventObj || typeof days !== "number" || days === 0) return;
	const shiftISO = (iso) => {
		if (!iso) return iso;
		const d = parseISODate(iso);
		if (!d) return iso;
		d.setDate(d.getDate() + days);
		return toISO(d);
	};

	// Nếu có timeline -> dịch từng stage và đảm bảo event.date = phase1.start
	if (eventObj.timeline && Array.isArray(eventObj.timeline.stages) && eventObj.timeline.stages.length) {
		eventObj.timeline.stages.forEach(stage => {
			if (stage.start) stage.start = shiftISO(stage.start);
			if (stage.end) stage.end = shiftISO(stage.end);
		});
		// cập nhật timeline tổng thể
		eventObj.timeline.start = eventObj.timeline.stages[0].start;
		eventObj.timeline.end = eventObj.timeline.stages[eventObj.timeline.stages.length - 1].end;
		// rebuild segments so render uses updated slices
		rebuildTimelineSegments(eventObj);
		// canonical date = bắt đầu của phase1
		eventObj.date = eventObj.timeline.stages[0].start;
	} else {
		// fallback: chỉ dịch trường date nếu không có timeline
		if (eventObj.date) {
			eventObj.date = shiftISO(eventObj.date);
		}
	}

	// cập nhật metadata
	eventObj.updatedAt = new Date().toISOString();
	refreshEventMetadata(eventObj);
}

// ----------------- NEW: rebuildTimelineSegments -----------------
// Build timeline.segments from timeline.stages so rendering uses up-to-date segments
function rebuildTimelineSegments(eventObj) {
	if (!eventObj || !eventObj.timeline || !Array.isArray(eventObj.timeline.stages)) return;
	const stages = eventObj.timeline.stages;
	const segments = [];

	// Create segment entries for each stage
	stages.forEach((stage, idx) => {
		const startISO = stage.start;
		const endISO = stage.end;
		const durationDays = Number(stage.durationDays ?? (daysBetween(parseISODate(startISO), parseISODate(endISO)) + 1));
		segments.push({
			type: stage.id || `stage${idx+1}`,
			label: stage.label || (`Giai đoạn ${idx+1}`),
			start: startISO,
			end: endISO,
			days: durationDays,
			stageIndex: idx + 1
		});
		// Insert gap between stage1 and stage2 only when building after stage1
		if (idx === 0 && stages[1]) {
			const stage1End = parseISODate(stage.end);
			const stage2Start = parseISODate(stages[1].start);
			// gap = days between stage1End+1 and stage2Start-1
			const gapStart = addDays(stage1End, 1);
			const gapEnd = addDays(stage2Start, -1);
			const gapDays = Math.max(0, daysBetween(gapStart, gapEnd) + 1);
			if (gapDays > 0) {
				segments.push({
					type: "gap",
					label: `Gap ${gapDays} ngày`,
					start: toISO(gapStart),
					end: toISO(gapEnd),
					days: gapDays
				});
			}
		}
	});

	// attach to event timeline and update start/end/totalDays
	eventObj.timeline.segments = segments;
	eventObj.timeline.start = stages[0]?.start || eventObj.timeline.start;
	eventObj.timeline.end = stages[stages.length - 1]?.end || eventObj.timeline.end;
	eventObj.timeline.totalDays = segments.reduce((s, seg) => s + (seg.days || 0), 0);
}

// --- Thay thế shiftFollowingEvents bằng logic dùng start của phase1 để lọc và sắp xếp ---
// Lọc các event có start (phase1 start hoặc event.date) lớn hơn baseISO rồi dịch theo thứ tự thời gian.
function shiftFollowingEvents(scheduleId, baseISO, deltaDays) {
	if (!scheduleId || !baseISO || typeof deltaDays !== "number" || deltaDays === 0) return [];
	try {
		const schedule = getScheduleById(scheduleId);
		if (!schedule || !Array.isArray(schedule.events)) return [];

		const baseStart = parseISODate(baseISO);
		if (!baseStart) return [];

		// build list của candidates (bỏ event đang edit nếu trùng)
		const candidates = (schedule.events || []).filter(evt => {
			if (!evt) return false;
			if (state.event && evt.id === state.event.id) return false;

			// xác định start date của event: ưu tiên timeline.stage[0].start
			let evtStart = null;
			if (evt.timeline && Array.isArray(evt.timeline.stages) && evt.timeline.stages.length) {
				evtStart = parseISODate(evt.timeline.stages[0].start);
			} else if (evt.date) {
				evtStart = parseISODate(evt.date);
			}
			if (!evtStart) return false;

			// chỉ chọn event bắt đầu STRICTLY sau baseStart
			return evtStart.getTime() > baseStart.getTime();
		});

		// sắp xếp theo start asc
		candidates.sort((a, b) => {
			const aStart = a.timeline && Array.isArray(a.timeline.stages) && a.timeline.stages.length
				? parseISODate(a.timeline.stages[0].start).getTime()
				: parseISODate(a.date).getTime();
			const bStart = b.timeline && Array.isArray(b.timeline.stages) && b.timeline.stages.length
				? parseISODate(b.timeline.stages[0].start).getTime()
				: parseISODate(b.date).getTime();
			return aStart - bStart;
		});

		const shifted = [];
		for (const evt of candidates) {
			shiftEventByDays(evt, deltaDays);
			shifted.push(evt);
		}
		return shifted;
	} catch (e) {
		console.error("Error shifting following events:", e);
		return [];
	}
}

// Export helpers so other modules can reuse shifting logic
export { shiftEventByDays, shiftFollowingEvents };

// Keep Lo2 events chained so each phase1 begins immediately after previous phase1 ends.
function alignLo2Phase1Chain(scheduleId, anchorEvent) {
	if (!scheduleId || !anchorEvent || !isLo2Furnace(anchorEvent.furnace || anchorEvent.furnaceLabel || "")) {
		return [];
	}
	let schedule;
	try {
		schedule = getScheduleById(scheduleId);
	} catch (err) {
		console.warn("alignLo2Phase1Chain: schedule lookup failed", err);
		return [];
	}
	if (!schedule || !Array.isArray(schedule.events)) {
		return [];
	}
	const furnaceKey = normalizeFurnaceLabel(anchorEvent.furnace || anchorEvent.furnaceLabel || "");
	if (!furnaceKey) {
		return [];
	}
	const chain = (schedule.events || [])
		.filter(evt => evt && normalizeFurnaceLabel(evt.furnace || evt.furnaceLabel || "") === furnaceKey)
		.sort((a, b) => {
			const aISO = getEventStartISO(a);
			const bISO = getEventStartISO(b);
			if (!aISO && !bISO) return 0;
			if (!aISO) return -1;
			if (!bISO) return 1;
			return parseISODate(aISO) - parseISODate(bISO);
		});
	if (!chain.length) {
		return [];
	}
	let previousPhase1End = getPhase1EndISO(chain[0]);
	const updated = [];
	for (let idx = 1; idx < chain.length; idx += 1) {
		const evt = chain[idx];
		if (!evt) {
			continue;
		}
		if (!previousPhase1End) {
			previousPhase1End = getPhase1EndISO(evt);
			continue;
		}
		const currentPhase1 = evt.timeline?.stages?.find(stage => stage && stage.id === "phase1");
		const currentStartISO = currentPhase1?.start || evt.timeline?.start || evt.date;
		if (currentStartISO === previousPhase1End) {
			previousPhase1End = getPhase1EndISO(evt) || previousPhase1End;
			continue;
		}
		const voltageKey = determineVoltageKeyFromDetails(evt.serialDetails, evt.voltageLabel, evt.serials);
		const durations = VOLTAGE_RULES[voltageKey] || VOLTAGE_RULES["110"];
		let rebuilt = null;
		try {
			rebuilt = buildTimeline(previousPhase1End, durations, { allowSundaySecondHalfStart: true, allowForcedWithinMinGap: true });
		} catch (err) {
			console.warn("alignLo2Phase1Chain: buildTimeline failed", err);
		}
		if (!rebuilt) {
			previousPhase1End = getPhase1EndISO(evt) || previousPhase1End;
			continue;
		}
		evt.timeline = rebuilt;
		evt.date = rebuilt.stages?.[0]?.start || previousPhase1End;
		refreshEventMetadata(evt);
		try {
			updateEvent(scheduleId, evt);
		} catch (err) {
			console.warn("alignLo2Phase1Chain: updateEvent failed", err);
		}
		updated.push(evt);
		previousPhase1End = getPhase1EndISO(evt) || previousPhase1End;
	}
	return updated;
}

function getPhase1EndISO(evt) {
	if (!evt) {
		return null;
	}
	return evt.timeline?.stages?.find(stage => stage && stage.id === "phase1")?.end || null;
}

// Save edited date/serial/voltage directly
async function handleEditToggle() {
	if (!state.event || !serialGrid) return;
	const furnaceLabel = state.event.furnace || state.event.furnaceLabel || "";
	const isLo1 = isLo1Furnace(furnaceLabel);
	if (isLo1 && !state.event._editing) {
		enableInlineEditing();
		return;
	}
	state.event._editing = true;
	if (!state.event._originalDate) {
		state.event._originalDate = state.event.date;
	}
	const newDate = displayToISOEdit(dateInput?.value) || state.event.date;
	const serialRows = Array.from(serialGrid?.querySelectorAll(".serial-grid__row") || []);
	const newSerials = serialRows.map(row => {
		const serialValue = row.querySelector("input")?.value?.trim() || "";
		const voltageValue = row.querySelector("select")?.value || "";
		return { serial: serialValue, voltageValue, voltageLabel: voltageValue ? `${voltageValue} kV` : "" };
	}).filter(entry => entry.serial);
	const qty = Number(state.event.quantity || 0);
	if (qty > 0 && newSerials.length !== qty) {
		await alertDialog("Số sê-ri phải khớp với số lượng đăng ký.");
		return;
	}
	if (!newSerials.length) {
		await alertDialog("Vui lòng nhập ít nhất một số sê-ri hợp lệ.");
		return;
	}
	commitEditChanges(newDate, newSerials);
}

// commitEditChanges: chung cho luồng 'Lưu' khi sửa
function commitEditChanges(newDate, newSerials) {
	if (!state.event) return;

	const originalISO = state.event._originalDate || state.event.date;
	const delta = daysDiffISO(originalISO, newDate);

	try {
		// attempt to get authoritative stored event; if that fails fallback to state.event
		let stored = null;
		try {
			stored = getEventById(state.scheduleId, state.event.id);
		} catch (err) {
			// schedule lookup failed or other error — fallback to in-memory modal event
			stored = null;
		}
		if (!stored) {
			stored = state.event;
		}

		const previousVoltageKey = determineVoltageKeyFromDetails(
			stored.serialDetails,
			stored.voltageLabel,
			stored.serials
		);

		// apply serial details
		if (Array.isArray(newSerials) && newSerials.length) {
			stored.serialDetails = newSerials.map((d, i) => ({ ...d, lineIndex: i + 1 }));
			stored.serials = stored.serialDetails.map(s => `${s.serial} (${s.voltageLabel})`);
			stored.quantity = Math.max(Number(stored.quantity || 0), stored.serialDetails.length);
		}

		const updatedVoltageKey = determineVoltageKeyFromDetails(
			stored.serialDetails,
			stored.voltageLabel,
			stored.serials
		);
		stored.voltageLabel = formatVoltageLabelByKey(updatedVoltageKey);
		const furnaceLabel = stored.furnace || stored.furnaceLabel || "";
		const isLo2Event = isLo2Furnace(furnaceLabel);
		const allowSundayStarts = isLo2Event || isLo1Furnace(furnaceLabel);
		const baseStartISO = newDate || stored.timeline?.start || stored.timeline?.stages?.[0]?.start || stored.date;
		const rules = VOLTAGE_RULES[updatedVoltageKey] || VOLTAGE_RULES["110"];
		let forcedPhase2StartISO = null;
		const downgradedFrom220 = String(previousVoltageKey) === "220" && String(updatedVoltageKey) !== "220" && isLo1Furnace(furnaceLabel);

		// If serialDetails were updated rebuild the timeline to match the highest-voltage
		// found among the serials. Apply to any furnace (Lo1 or Lo2) so editing serials
		// corrects timeline durations if voltage changed.
		try {
			if (baseStartISO && rules) {
				const sundayOpts = allowSundayStarts ? { allowSundaySecondHalfStart: true } : {};
				stored.timeline = buildTimeline(baseStartISO, rules, sundayOpts);
			}
		} catch (e) {
			// non-fatal
		}

		// When a Lo1 event is upgraded to 220 kV, mirror the Lo2 logic by
		// forcing the previous event's phase2 start to align with the new
		// phase1 end and re-anchor this event's phase2 accordingly.
		if (String(updatedVoltageKey) === "220" && isLo1Furnace(furnaceLabel) && baseStartISO && stored.timeline) {
			try {
				const anchorResult = resolvePhaseAnchorsForRegistration({
					scheduleId: state.scheduleId,
					furnaceValue: furnaceLabel,
					newTimeline: stored.timeline,
					startISO: baseStartISO,
					newVoltage: updatedVoltageKey
				});

				forcedPhase2StartISO = anchorResult?.forcedPhase2StartISO || null;
			} catch (err) {
				console.warn('[edit] resolvePhaseAnchorsForRegistration failed', err);
			}
		}
		if (forcedPhase2StartISO && baseStartISO && rules) {
			try {
				const sundayOpts = allowSundayStarts ? { allowSundaySecondHalfStart: true } : {};
				stored.timeline = buildTimeline(baseStartISO, rules, { ...sundayOpts, forcedPhase2StartISO, allowForcedWithinMinGap: true });
			} catch (err) {
				console.warn('[edit] failed to rebuild timeline with forced phase2 start', err);
			}
		}

		if (downgradedFrom220) {
			restorePreviousLo1TimelineAfterDowngrade(state.scheduleId, furnaceLabel, stored.id);
		}

		// temporarily write date so downstream logic sees requested value
		stored.date = newDate || stored.date;
		const hasTimeline = Boolean(stored.timeline && Array.isArray(stored.timeline.stages) && stored.timeline.stages.length);
		const appliedExplicitDate = Boolean(newDate && baseStartISO === newDate);
		const shouldShiftCurrentEvent = delta !== 0 && !appliedExplicitDate;

		if (shouldShiftCurrentEvent) {
			shiftEventByDays(stored, delta);
		} else {
			// ensure metadata refreshed even when we do not shift via helper
			refreshEventMetadata(stored);
			if (hasTimeline) {
				rebuildTimelineSegments(stored);
			}
		}

		// ensure the canonical event.date is the start of phase1 when timeline exists
		if (hasTimeline) {
			const phase1Start = stored.timeline.stages[0].start;
			if (phase1Start) {
				stored.date = phase1Start;
			}
		}

		// keep modal state pointing to authoritative object
		state.event = stored;

		// shift following events by same delta (if any)
		let shifted = [];
		if (delta !== 0) {
			shifted = shiftFollowingEvents(state.scheduleId, originalISO, delta) || [];
		}

		let lo2Aligned = [];
		if (isLo2Event) {
			try {
				lo2Aligned = alignLo2Phase1Chain(state.scheduleId, stored);
			} catch (err) {
				console.warn('[edit] alignLo2Phase1Chain failed', err);
			}
		}

		// update timeline bars (best-effort) and trigger app-wide refresh
		updateTimelineBarsForEvent(state.event);
		shifted.forEach(ev => updateTimelineBarsForEvent(ev));
		lo2Aligned.forEach(ev => updateTimelineBarsForEvent(ev));

		// dispatch saved events: base + shifted (listeners will re-render the calendar)
		document.dispatchEvent(new CustomEvent("registration:saved", { detail: state.event }));
		shifted.forEach(ev => document.dispatchEvent(new CustomEvent("registration:saved", { detail: ev })));
		lo2Aligned.forEach(ev => document.dispatchEvent(new CustomEvent("registration:saved", { detail: ev })));
		// show success toast
		try { if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast('Lưu thay đổi thành công', { type: 'success' }); } catch (e) {}
	} catch (e) {
		// log full error for debugging and show user-friendly message
		console.error("Save edit failed — exception:", e && (e.stack || e.message || e));
		try { if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast('Lưu thay đổi thất bại', { type: 'error' }); } catch (ex) {}
		return;
	}

	// exit edit mode and restore UI
	if (state.event) {
		state.event._editing = false;
		delete state.event._originalDate;
		// persist authoritative changes to data store AFTER clearing transient flags
		try {
			if (typeof updateEvent === 'function') {
				updateEvent(state.scheduleId, state.event);
			}
		} catch (e) {
			console.warn('updateEvent failed', e);
		}
	}
	closeModal();
}

// New: delete handler for modal
async function handleDeleteEvent() {
    // confirm using custom popup
	if (!state.event || !state.scheduleId) return;
	const ok = await confirmDialog("Bạn có chắc muốn xóa sự kiện này không? Hành động sẽ không thể hoàn tác.");
	if (!ok) return;
	try {
		// remove from data store
		const removed = deleteEvent(state.scheduleId, state.event.id);
		// After a deletion, release any anchors introduced by overlap handling so
		// earlier events regain their original phase2 start dates.
		realignTimelineAfterDeletion(state.scheduleId, removed);
		// remove any timeline bar DOM nodes for this event
		document.querySelectorAll(`[data-event-id="${state.event.id}"]`).forEach(n => n.remove());
		document.dispatchEvent(new CustomEvent("registration:deleted", { detail: { scheduleId: state.scheduleId, eventId: state.event.id, event: removed } }));
	} catch (e) {
 		// best-effort: still remove DOM nodes
 		document.querySelectorAll(`[data-event-id="${state.event.id}"]`).forEach(n => n.remove());
 	}
	// close modal
	closeModal();
}

export function realignTimelineAfterDeletion(scheduleId, removedEvent) {
	if (!scheduleId || !removedEvent) return;
	const furnaceLabel = removedEvent.furnace || removedEvent.furnaceLabel || "";
	if (isLo1Furnace(furnaceLabel)) {
		realignLo1TimelineAfterDeletion(scheduleId, removedEvent);
		return;
	}
	if (isLo2Furnace(furnaceLabel)) {
		const removedVoltageKey = determineVoltageKeyFromDetails(
			removedEvent.serialDetails,
			removedEvent.voltageLabel,
			removedEvent.serials
		);
		if (String(removedVoltageKey) === "220") {
			restorePreviousLo2TimelineAfter220Deletion(scheduleId, removedEvent);
		}
		try {
			harmonizeLo2Timelines(scheduleId);
		} catch (err) {
			console.warn("realignTimelineAfterDeletion: harmonizeLo2Timelines failed", err);
		}
	}
}

// Khi xóa một bản ghi Lo2 220 kV, cần trả lại mốc pha 2 ban đầu của sự kiện đứng trước
// (giống như thao tác downgrade 220 -> 110) trước khi chạy harmonize.
function restorePreviousLo2TimelineAfter220Deletion(scheduleId, removedEvent) {
	if (!scheduleId || !removedEvent) return;
	let schedule;
	try {
		schedule = getScheduleById(scheduleId);
	} catch (err) {
		console.warn("restorePreviousLo2TimelineAfter220Deletion: schedule lookup failed", err);
		return;
	}
	if (!schedule || !Array.isArray(schedule.events)) {
		return;
	}
	const removedStartISO = getEventStartISO(removedEvent);
	const removedStart = removedStartISO ? parseISODate(removedStartISO) : null;
	if (!removedStart) {
		return;
	}
	const previousEvent = (schedule.events || [])
		.filter(evt => evt && evt.id !== removedEvent.id && isLo2Furnace(evt.furnace || evt.furnaceLabel || ""))
		.reduce((latest, evt) => {
			const evtStartISO = getEventStartISO(evt);
			if (!evtStartISO) return latest;
			const evtStartDate = parseISODate(evtStartISO);
			if (!evtStartDate || evtStartDate.getTime() >= removedStart.getTime()) return latest;
			if (!latest) return { event: evt, date: evtStartDate };
			return (evtStartDate.getTime() > latest.date.getTime()) ? { event: evt, date: evtStartDate } : latest;
		}, null);
	if (!previousEvent || !previousEvent.event) {
		return;
	}
	const target = previousEvent.event;
	const baseStartISO = getEventStartISO(target);
	if (!baseStartISO) {
		return;
	}
	const voltageKey = determineVoltageKeyFromDetails(target.serialDetails, target.voltageLabel, target.serials);
	const durationRules = VOLTAGE_RULES[voltageKey] || VOLTAGE_RULES["110"];
	if (!durationRules) {
		return;
	}
	const rebuilt = buildTimeline(baseStartISO, durationRules, { allowSundaySecondHalfStart: true });
	if (!rebuilt) {
		return;
	}
	target.timeline = rebuilt;
	refreshEventMetadata(target);
	try {
		updateEvent(scheduleId, target);
	} catch (err) {
		console.warn("restorePreviousLo2TimelineAfter220Deletion: updateEvent failed", err);
	}
	try {
		document.dispatchEvent(new CustomEvent("registration:saved", { detail: target }));
	} catch (err) {
		console.warn("restorePreviousLo2TimelineAfter220Deletion: dispatch failed", err);
	}
}

function realignLo1TimelineAfterDeletion(scheduleId, removedEvent) {
	if (!scheduleId || !removedEvent) return;
	if (!isLo1Furnace(removedEvent.furnace || removedEvent.furnaceLabel || "")) {
		return;
	}
	let schedule;
	try {
		schedule = getScheduleById(scheduleId);
	} catch (err) {
		console.warn("realignLo1TimelineAfterDeletion: schedule lookup failed", err);
		return;
	}
	if (!schedule || !Array.isArray(schedule.events)) {
		return;
	}
	const furnaceKey = normalizeFurnaceLabel(removedEvent.furnace || removedEvent.furnaceLabel || "");
	const removedStartISO = getEventStartISO(removedEvent);
	const removedStart = removedStartISO ? parseISODate(removedStartISO) : null;
	let previousEvent = null;
	let previousStartTime = null;
	(schedule.events || []).forEach(evt => {
		if (!evt) return;
		const evtFurnace = normalizeFurnaceLabel(evt.furnace || evt.furnaceLabel || "");
		if (evtFurnace !== furnaceKey) return;
		const evtStartISO = getEventStartISO(evt);
		if (!evtStartISO) return;
		const evtStartDate = parseISODate(evtStartISO);
		if (!evtStartDate) return;
		if (!removedStart || evtStartDate.getTime() < removedStart.getTime()) {
			if (!previousStartTime || evtStartDate.getTime() > previousStartTime) {
				previousEvent = evt;
				previousStartTime = evtStartDate.getTime();
			}
		}
	});
	if (!previousEvent) {
		return;
	}
	const baseStartISO = getEventStartISO(previousEvent);
	if (!baseStartISO) {
		return;
	}
	const voltageKey = deriveEventVoltageKey(previousEvent);
	const durationRules = VOLTAGE_RULES[voltageKey] || VOLTAGE_RULES["110"];
	if (!durationRules) {
		return;
	}
	const rebuilt = buildTimeline(baseStartISO, durationRules, { allowForcedWithinMinGap: true });
	if (!rebuilt) {
		return;
	}
	previousEvent.timeline = rebuilt;
	refreshEventMetadata(previousEvent);
	try {
		updateEvent(scheduleId, previousEvent);
	} catch (err) {
		console.warn("realignLo1TimelineAfterDeletion: updateEvent failed", err);
	}
	try {
		document.dispatchEvent(new CustomEvent("registration:saved", { detail: previousEvent }));
	} catch (err) {
		console.warn("realignLo1TimelineAfterDeletion: dispatch failed", err);
	}
}

function restorePreviousLo1TimelineAfterDowngrade(scheduleId, furnaceLabel, currentEventId) {
	if (!scheduleId || !furnaceLabel || !currentEventId) {
		return;
	}
	if (!isLo1Furnace(furnaceLabel)) {
		return;
	}
	let schedule;
	try {
		schedule = getScheduleById(scheduleId);
	} catch (err) {
		console.warn("restorePreviousLo1TimelineAfterDowngrade: schedule lookup failed", err);
		return;
	}
	if (!schedule || !Array.isArray(schedule.events)) {
		return;
	}
	const targetKey = (normalizeFurnaceLabel(furnaceLabel || "") || "").replace(/\s+/g, "");
	const sameFurnaceEvents = (schedule.events || [])
		.filter(evt => evt && (normalizeFurnaceLabel(evt.furnace || evt.furnaceLabel || "") || "").replace(/\s+/g, "") === targetKey)
		.sort((a, b) => {
			const aISO = getEventStartISO(a);
			const bISO = getEventStartISO(b);
			if (!aISO && !bISO) return 0;
			if (!aISO) return -1;
			if (!bISO) return 1;
			return parseISODate(aISO) - parseISODate(bISO);
		});
	const currentIndex = sameFurnaceEvents.findIndex(evt => evt && evt.id === currentEventId);
	if (currentIndex <= 0) {
		return;
	}
	const previousEvent = sameFurnaceEvents[currentIndex - 1];
	if (!previousEvent) {
		return;
	}
	const baseStartISO = getEventStartISO(previousEvent);
	if (!baseStartISO) {
		return;
	}
	const voltageKey = deriveEventVoltageKey(previousEvent);
	const durationRules = VOLTAGE_RULES[voltageKey] || VOLTAGE_RULES["110"];
	if (!durationRules) {
		return;
	}
	const rebuilt = buildTimeline(baseStartISO, durationRules, { allowForcedWithinMinGap: true });
	if (!rebuilt) {
		return;
	}
	previousEvent.timeline = rebuilt;
	refreshEventMetadata(previousEvent);
	try {
		updateEvent(scheduleId, previousEvent);
		if (typeof document !== "undefined") {
			document.dispatchEvent(new CustomEvent("registration:saved", { detail: previousEvent }));
		}
	} catch (err) {
		console.warn("restorePreviousLo1TimelineAfterDowngrade: persist failed", err);
	}
}

function getEventStartISO(evt) {
	if (!evt) return null;
	if (evt.timeline && evt.timeline.start) return evt.timeline.start;
	if (Array.isArray(evt.timeline?.stages) && evt.timeline.stages.length) {
		return evt.timeline.stages[0].start || null;
	}
	return evt.date || null;
}

function deriveEventVoltageKey(event) {
	if (!event) return "110";
	const detailSource = Array.isArray(event.serialDetails) && event.serialDetails.length
		? event.serialDetails
		: getEventSerialDetails(event);
	return determineVoltageKeyFromDetails(detailSource, event.voltageLabel, event.serials);
}

function getEventSerialDetails(event) {
	if (!event) return [];
	if (Array.isArray(event.serialDetails) && event.serialDetails.length) {
		return event.serialDetails.map(detail => ({
			serial: detail?.serial || "",
			voltageValue: String(detail?.voltageValue || "").trim(),
			voltageLabel: detail?.voltageLabel || ""
		}));
	}
	const serials = Array.isArray(event.serials) ? event.serials : [];
	return serials.map(serial => {
		const match = String(serial || "").match(/(\d{2,3})/);
		const voltageValue = match ? match[1] : "";
		return {
			serial: serial || "",
			voltageValue,
			voltageLabel: voltageValue ? `${voltageValue} kV` : ""
		};
	});
}

// --- Removed duplicate function: shiftFollowingEvents ---
// The original (duplicate) implementation of shiftFollowingEvents caused a
// "Identifier 'shiftFollowingEvents' has already been declared" SyntaxError.
// Keep shiftFollowingEventsCore + exported wrapper at the bottom of the file.
// (Original logic preserved via shiftFollowingEventsCore; this function removed.)
