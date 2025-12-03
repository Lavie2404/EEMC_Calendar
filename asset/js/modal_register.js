import { getCurrentUser } from "./role.js";
import { saveRegistration, getScheduleById, getEventById, updateEvent, clearPersistedData } from "./data_store.js";
import { SECOND_HALF } from "./halves.js";
import { normalizeFurnaceLabel, isLo2Furnace, isLo1Furnace } from "./furnace.js";

function normalizeFurnaceKey(value) {
	return normalizeFurnaceLabel(value || "").replace(/\s+/g, "");
}

export const STATUS_FLOW = ["Kế hoạch", "Đã đăng ký", "Đang thực hiện", "Kết thúc"];
export const DELAY_LABEL = "Delay";
// GAP days now depend on voltage; keep a fallback default for legacy uses
const GAP_DAYS = 3;
// Minimum gap requirement: expressed in halves (half-day units).
// 4 halves = 2 full days minimum gap.
const MIN_GAP_HALVES = 4;
const MIN_GAP_DAYS = Math.ceil(MIN_GAP_HALVES / 2);
const TIMELINE_STAGES = [
	{ id: "phase1", label: "Sấy ghép tôn" },
	{ id: "phase2", label: "Sấy xuất xưởng" }
];
const VOLTAGE_RULES = {
	// Mappings: phase durations (in halves) and gapDays used to calculate half-day offsets
	// Updated rule set:
	// - 220 kV: phase1 = 6 halves, phase2 = 8 halves, gapDays = 2
	// - 110 kV: phase1 = 4 halves, phase2 = 6 halves, gapDays = 2
	"220": { phase1: 6, phase2: 8, gapDays: 2 },
	"110": { phase1: 4, phase2: 6, gapDays: 2 }
};
const VOLTAGE_OPTIONS = [
	{ value: "110", label: "110" },
	{ value: "220", label: "220" }
];
const DEFAULT_STATUS = "Kế hoạch";

function createLineHistoryEntry(statusLabel, actor) {
	return {
		status: statusLabel,
		actor,
		timestamp: new Date().toISOString()
	};
}

function buildLineDetail(entry, index, { registrant, status, actor }) {
	const statusLabel = status || DEFAULT_STATUS;
	return {
		serial: entry.serial,
		voltageValue: entry.voltageValue,
		voltageLabel: entry.voltageLabel,
		registrant,
		lineIndex: index + 1,
		status: statusLabel,
		history: [createLineHistoryEntry(statusLabel, actor)]
	};
}
const state = {
	initialized: false,
	currentDateISO: null,
	scheduleName: "",
	scheduleId: "",
	currentStatus: STATUS_FLOW[0],
	isDelay: false,
	history: [],
	lo1AllowedVoltages: new Set(VOLTAGE_OPTIONS.map(opt => opt.value)),
	lo2AllowedVoltages: {
		1: new Set(VOLTAGE_OPTIONS.map(opt => opt.value)),
		2: new Set(VOLTAGE_OPTIONS.map(opt => opt.value))
	},
	lockedFurnace: null,
	hiddenQuantityValues: new Set(),
	linkedEvent: null,
	enforcedDate: null,
	autoPlaceholderActive: false,
	autoPlaceholderInjectedQuantity: false
};

let modalEl = null;
let formEl = null;
let dateInput = null;
let nameInput = null;
let furnaceSelect = null;
let quantitySelect = null;
let serialContainer = null;
let statusStepsEl = null;
let statusHistoryEl = null;
let statusDelayBtn = null;
let hiddenStatusInput = null;
let hiddenDelayInput = null;

// Render the status step buttons into the `statusStepsEl` container.
// Creates interactive buttons for each entry in `STATUS_FLOW` and
// hooks them up to `handleStatusChange`. Calls `updateStatusVisuals`
// to reflect the current state after rendering.
function renderStatusSteps() {
	if (!statusStepsEl) return;
	try {
		statusStepsEl.innerHTML = "";
		STATUS_FLOW.forEach(label => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'status-step';
			btn.textContent = label;
			btn.setAttribute('data-status', label);
			btn.addEventListener('click', () => handleStatusChange(label));
			statusStepsEl.appendChild(btn);
		});
	} catch (e) {
		// defensive: if DOM operations fail, skip rendering
		try { console.warn('renderStatusSteps failed', e); } catch (err) {}
	}
	updateStatusVisuals();
}

const SLOT_OPTIONS = {
	lo1: ["1"],
	lo2: ["1", "2"]
};

export function setupRegisterModal() {
	if (state.initialized) {
		return;
	}
	modalEl = document.getElementById("modalRegister");
	if (!modalEl) {
		return;
	}
	formEl = document.getElementById("modalRegisterForm");
	dateInput = document.getElementById("register-date");
	nameInput = document.getElementById("register-name");
	furnaceSelect = document.getElementById("event-title");
	quantitySelect = document.getElementById("register-quantity");
	serialContainer = document.getElementById("register-serial-container");
	statusStepsEl = document.getElementById("statusSteps");
	statusHistoryEl = document.getElementById("statusHistory");
	statusDelayBtn = document.getElementById("statusDelayBtn");
	hiddenStatusInput = document.getElementById("register-status-value");
	hiddenDelayInput = document.getElementById("register-delay-value");

	renderStatusSteps();
	bindModalEvents();
	populateCurrentUser();
	state.initialized = true;
}

// Export helpers used by other modules (e.g., modal_edit) to rebuild timelines
export { buildTimeline, VOLTAGE_RULES, harmonizeLo2Timelines, resolvePhaseAnchorsForRegistration, refreshEventMetadata, getHighestVoltage };

function bindModalEvents() {
	if (!modalEl) return;
	modalEl.querySelectorAll("[data-modal-dismiss]").forEach(btn => {
		btn.addEventListener("click", closeModal);
	});

	if (formEl) {
		formEl.addEventListener("submit", handleSubmit);
		formEl.addEventListener("reset", () => {
			formEl.classList.remove("is-validated");
			populateCurrentUser();
			if (furnaceSelect) furnaceSelect.value = "";
			resetQuantitySelect();
			resetSerialInputs();
			resetStatusState();
		});
	}

	furnaceSelect?.addEventListener("change", handleFurnaceChange);
	quantitySelect?.addEventListener("change", handleQuantityChange);
	statusDelayBtn?.addEventListener("click", toggleDelayStatus);
	dateInput?.addEventListener("change", handleDateChange);

	document.addEventListener("keydown", handleEscape, { capture: true });
}

export function openRegisterModal({
	dateISO,
	scheduleName,
	scheduleId,
	lockedFurnace = null,
	hideQuantityValues = [],
	linkedEventId = null,
	enforcedDate = null,
	openedViaPlaceholder = false
}) {
	if (!state.initialized) {
		setupRegisterModal();
	}
	if (!modalEl) {
		return;
	}

	resetLinkedContext();
	state.currentDateISO = enforcedDate || dateISO;
	state.scheduleName = scheduleName;
	state.scheduleId = scheduleId || "";
	state.lockedFurnace = lockedFurnace;
	state.hiddenQuantityValues = new Set(hideQuantityValues);
	state.linkedEvent = linkedEventId ? { eventId: linkedEventId, scheduleId: state.scheduleId } : null;
	state.enforcedDate = enforcedDate;
	// mark whether this modal was opened via a timeline-bar placeholder
	state.openedViaTimelinePlaceholder = Boolean(openedViaPlaceholder);

	formEl.reset();
	formEl.classList.remove("is-validated");
	dateInput.value = state.currentDateISO;
	populateCurrentUser();
	updateSubtitle(dateISO, scheduleName);
	resetQuantitySelect();
	resetSerialInputs();
	resetStatusState();
	evaluateFurnaceAvailability();
	if (state.lockedFurnace) {
		furnaceSelect.value = state.lockedFurnace;
		furnaceSelect.disabled = true;
		handleFurnaceChange();
	} else {
		furnaceSelect.disabled = false;
	}

	modalEl.hidden = false;
	modalEl.classList.add("is-open");
	document.body.classList.add("modal-open");

	requestAnimationFrame(() => {
			furnaceSelect.focus();
		});
	}
function handleDateChange() {
	if (!dateInput) {
		return;
	}
	state.currentDateISO = dateInput.value || null;
	evaluateFurnaceAvailability();
	updateAutoLo2PlaceholderState();
}

function handleEscape(event) {
	if (event.key === "Escape" && modalEl?.classList.contains("is-open")) {
		event.preventDefault();
		closeModal();
	}
}

function handleFurnaceChange() {
	const value = furnaceSelect.value;
	resetQuantitySelect();
	if (!value) {
		disableAutoLo2PlaceholderMode();
		resetSerialInputs();
		applyQuantityAvailability();
		applyVoltageAvailability();
		return;
	}

	(SLOT_OPTIONS[value] || []).forEach(optionValue => {
		const opt = document.createElement("option");
		opt.value = optionValue;
		opt.textContent = optionValue;
		quantitySelect.appendChild(opt);
	});

	quantitySelect.disabled = false;
	const firstOption = SLOT_OPTIONS[value]?.[0] ?? "";
	if (firstOption) {
		quantitySelect.value = firstOption;
	}
	handleQuantityChange();
	quantitySelect.focus();
	applyQuantityAvailability();
	applyVoltageAvailability();

	if (isLo2Furnace(value)) {
		updateAutoLo2PlaceholderState();
	} else {
		disableAutoLo2PlaceholderMode();
	}
}

function handleSubmit(event) {
	event.preventDefault();
	if (!formEl) {
		return;
	}
	formEl.classList.add("is-validated");
	if (!formEl.checkValidity()) {
		const firstInvalid = formEl.querySelector(":invalid");
		firstInvalid?.focus();
		return;
	}

	const serialEntries = collectSerialNumbers();
	if (!serialEntries.length) {
		quantitySelect.focus();
		return;
	}

	const qty = Number(quantitySelect.value || 0);
	if (serialEntries.length !== qty) {
		alert("Số sê-ri phải khớp với số lượng đăng ký.");
		return;
	}

	// If this modal was opened from a timeline-bar placeholder for Lo2,
	// perform an in-place placeholder merge (replace the placeholder) and
	// skip the overlap/chain logic that would otherwise shift prior events.
	if (state.linkedEvent && state.openedViaTimelinePlaceholder) {
		const actor = getCurrentUser().name;
		const registrantValue = nameInput.value;
		const serialDetailsPlaceholder = serialEntries.map((entry, index) =>
			buildLineDetail(entry, index, {
				registrant: registrantValue,
				status: state.currentStatus,
				actor
			})
		);
		const mergedEvent = mergeLo2LineRegistration({
			scheduleId: state.linkedEvent.scheduleId || state.scheduleId || "mba",
			eventId: state.linkedEvent.eventId,
			newDetails: serialDetailsPlaceholder,
			isDelay: state.isDelay
		});
		if (mergedEvent) {
			document.dispatchEvent(new CustomEvent("registration:saved", { detail: mergedEvent }));
			try { if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast('Đã ghép bản ghi và lưu thành công', { type: 'success' }); } catch (e) {}
			setTimeout(() => closeModal(), 200);
		}
		return;
	}

	const isLo2Registration = isLo2Furnace(furnaceSelect?.value || "");
	const isLo1Registration = isLo1Furnace(furnaceSelect?.value || "");
	const allowSundayStarts = isLo1Registration || isLo2Registration;
	const applyTimelineOpts = (extra = {}) => (allowSundayStarts ? { ...extra, allowSundaySecondHalfStart: true } : { ...extra });
	const highestVoltage = getHighestVoltage(serialEntries);
	const has220 = highestVoltage === "220";
	const durations = VOLTAGE_RULES[has220 ? "220" : "110"];

	// Build timeline directly from the selected date. Overlap checks and forced-start
	// Before building timeline, check for existing phase2/phase1 overlaps and adjust registration
	// start or prior events if necessary so configured gapDays is preserved and phase2 won't overlap.
	let startISO = dateInput.value;

	// Determine whether the selected date falls into a relief/gap window for this furnace.
	let isInGapWindow = false;
	try {
		const nf = normalizeFurnaceLabel(furnaceSelect?.value || "");
		if (nf === 'lo1') {
			const r = getLo1ReliefAdjustmentForDate(startISO);
			isInGapWindow = r && r.reliefDayIndex !== null;
		} else if (nf === 'lo2') {
			const g = getLo2GapAdjustmentForDate(startISO);
			isInGapWindow = g && g.gapDayIndex !== null;
		}
	} catch (e) {
		isInGapWindow = false;
	}
	try { console.log('[register] startISO=', startISO, 'furnace=', furnaceSelect?.value, 'isInGapWindow=', isInGapWindow); } catch (e) {}
	// We'll build an initial timeline for B to inspect phase1/phase2 ranges,
	// then possibly adjust prior event A (for 220kV) or shift B's start so phases don't overlap.
	let timeline = buildTimeline(startISO, durations, applyTimelineOpts());
	let forcedPhase2StartISO = null;
	let helperAdjustedExisting = false;

	// No overlap checks or automatic shifting — build timeline as selected.

	// Default registration should be considered as starting in the second half of the selected day
	// Mark timeline and first stage explicitly so rendering logic can rely on this flag if needed
	try {
		timeline.startHalf = SECOND_HALF;
		if (Array.isArray(timeline.stages) && timeline.stages[0]) {
			timeline.stages[0].startHalf = SECOND_HALF;
		}
	} catch (e) {
		// noop
	}

	try {
		const anchorResult = resolvePhaseAnchorsForRegistration({
			scheduleId: state.scheduleId || "mba",
			furnaceValue: furnaceSelect?.value || "",
			newTimeline: timeline,
			startISO,
			newVoltage: highestVoltage
		});
		if (anchorResult) {
			forcedPhase2StartISO = anchorResult.forcedPhase2StartISO || null;
			helperAdjustedExisting = Boolean(anchorResult.updatedExisting);
		}
	} catch (err) {
		console.warn('resolvePhaseAnchorsForRegistration failed', err);
	}

	// --- Selective overlap handling (per examples):
	// If any stage of the new timeline overlaps an existing stage on the same furnace,
	// shift the LATER phase to begin at the earlier phase's end. Prefer shifting
	// phase2 starts (rebuild event timeline with forcedPhase2StartISO) when possible.
	try {
		const schedule = getScheduleById(state.scheduleId || "mba");
		const targetFurnaceKey = normalizeFurnaceKey(furnaceSelect?.value || "");
		let forcedPhase2StartForNew = forcedPhase2StartISO;
		let updatedAnyExisting = helperAdjustedExisting;

		const newStages = (timeline.stages || []).filter(s => s.id === 'phase1' || s.id === 'phase2');

		for (const evt of (schedule.events || [])) {
			if (normalizeFurnaceKey(evt.furnace || evt.furnaceLabel || "") !== targetFurnaceKey) continue;
			if (!evt.timeline || !Array.isArray(evt.timeline.stages)) continue;
			const existingStages = evt.timeline.stages.filter(s => s.id === 'phase1' || s.id === 'phase2');

			for (const newS of newStages) {
				const newStart = new Date(`${newS.start}T00:00:00`);
				const newEnd = new Date(`${newS.end}T00:00:00`);
				for (const exS of existingStages) {
					const exStart = new Date(`${exS.start}T00:00:00`);
					const exEnd = new Date(`${exS.end}T00:00:00`);
					// overlap if start < other.end && other.start < end (end exclusive semantics)
					if (!(newStart < exEnd && exStart < newEnd)) continue;
					// determine which phase starts earlier — keep earlier, shift later
					if (newStart.getTime() <= exStart.getTime()) {
						// new stage starts earlier; shift existing later stage to newEnd
						// prefer shifting existing phase2 if it's the later phase
						if (exS.id === 'phase2') {
							try {
								const priorVoltage = getHighestVoltage(extractSerialDetailsFromEvent(evt));
								const priorDur = VOLTAGE_RULES[priorVoltage === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
								const forcedForPrior = toISO(newEnd);
								const rebuilt = buildTimeline(evt.date || evt.timeline?.start || evt.date, priorDur, applyTimelineOpts({ forcedPhase2StartISO: forcedForPrior }));
								if (rebuilt) {
										const oldTimeline = evt.timeline;
										try {
											const oldStr = oldTimeline ? JSON.stringify(oldTimeline) : null;
											const newStr = JSON.stringify(rebuilt);
											evt.timeline = rebuilt;
											if (oldStr !== newStr) {
												updateEvent(state.scheduleId || schedule.id || 'mba', evt);
												updatedAnyExisting = true;
											}
										} catch (err) {
											// fallback: apply and persist
											evt.timeline = rebuilt;
											updateEvent(state.scheduleId || schedule.id || 'mba', evt);
											updatedAnyExisting = true;
										}
								}
							} catch (err) {
								console.warn('failed to shift existing phase2', err);
							}
						} else {
							// existing stage is phase1 (rare) — prefer to shift new phase2 instead when possible
							if (newS.id === 'phase2') {
								forcedPhase2StartForNew = forcedPhase2StartForNew || toISO(exEnd);
							}
						}
					} else {
						// existing starts earlier than new -> shift the later (new) phase to exEnd when possible
						if (newS.id === 'phase2') {
							// schedule new phase2 to start at existing end
							forcedPhase2StartForNew = forcedPhase2StartForNew || toISO(exEnd);
						} else if (exS.id === 'phase2') {
							// existing phase2 starts earlier than new phase1 — shift new phase2 instead
							forcedPhase2StartForNew = forcedPhase2StartForNew || toISO(exEnd);
						}
					}
				}
			}
		}

		// If we updated existing events, recompute their timelines may have changed ordering —
		// compute the latest phase2 end across same-furnace events and, if needed, force
		// the new event's phase2 to start at that end to avoid overlap with shifted events.
		if (updatedAnyExisting) {
			let latestEnd = null;
			const s = getScheduleById(state.scheduleId || "mba");
			for (const evt of (s.events || [])) {
				if (normalizeFurnaceKey(evt.furnace || evt.furnaceLabel || "") !== targetFurnaceKey) continue;
				const p2 = evt.timeline?.stages?.find(st => st.id === 'phase2');
				if (p2) {
					const p2End = stripTime(new Date(`${p2.end}T00:00:00`));
					if (!latestEnd || p2End.getTime() > latestEnd.getTime()) latestEnd = p2End;
				}
			}
			if (latestEnd) {
				// Prefer the latest end date across updated existing events. If a prior
				// forced date was set earlier in the loop, replace it when latestEnd is
				// strictly later so the new event's phase2 doesn't start before shifted events.
				try {
					const currentForcedDate = forcedPhase2StartForNew ? stripTime(new Date(`${forcedPhase2StartForNew}T00:00:00`)) : null;
					if (!currentForcedDate || latestEnd.getTime() > currentForcedDate.getTime()) {
						forcedPhase2StartForNew = toISO(latestEnd);
					}
				} catch (err) {
					forcedPhase2StartForNew = forcedPhase2StartForNew || toISO(latestEnd);
				}
			}
		}

		if (forcedPhase2StartForNew) {
			try {
				// rebuild timeline for new event so phase2 starts at forced date
				timeline = buildTimeline(startISO, durations, applyTimelineOpts({ forcedPhase2StartISO: forcedPhase2StartForNew }));
				if (timeline && Array.isArray(timeline.stages) && timeline.stages[0]) timeline.stages[0].startHalf = SECOND_HALF;
			} catch (err) {
				console.warn('failed to rebuild new timeline with forcedPhase2Start', err);
			}
		}
	} catch (e) {
		// don't block saving if overlap handling fails; keep timeline as built
		console.warn('selective overlap handling failed', e);
	}
	const furnaceLabel = furnaceSelect.selectedOptions[0]?.textContent?.trim() || furnaceSelect.value;
	const voltageLabel = has220 ? "220 kV" : "< 220 kV";
	const registrant = nameInput.value;
	const actor = getCurrentUser().name;
	const serialDetails = serialEntries.map((entry, index) => buildLineDetail(entry, index, {
		registrant,
		status: state.currentStatus,
		actor
	}));
	const serialSummary = serialEntries.map(entry => `${entry.serial} (${entry.voltageLabel})`);
	const aggregateStatus = isLo2Furnace(furnaceSelect?.value || "")
		? deriveLo2EventStatus(serialDetails, state.currentStatus)
		: state.currentStatus;

	if (state.linkedEvent) {
		const mergedEvent = mergeLo2LineRegistration({
			scheduleId: state.linkedEvent.scheduleId || state.scheduleId || "mba",
			eventId: state.linkedEvent.eventId,
			newDetails: serialDetails,
			isDelay: state.isDelay
		});
		if (mergedEvent) {
			document.dispatchEvent(new CustomEvent("registration:saved", { detail: mergedEvent }));
			try { if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast('Đã ghép bản ghi và lưu thành công', { type: 'success' }); } catch (e) {}
			setTimeout(() => closeModal(), 200);
		}
		return;
	}

	const summary = createSummary({
		furnaceLabel,
		registrant,
		quantity: qty,
		serials: serialSummary,
		voltageLabel,
		status: aggregateStatus,
		timeline
	});
	const tooltip = createTooltip({
		furnaceLabel,
		registrant,
		quantity: qty,
		serials: serialSummary,
		voltageLabel,
		status: aggregateStatus,
		timeline
	});

	const savedEvent = saveRegistration(state.scheduleId || "mba", {
		date: startISO,
		furnaceLabel,
		registrant,
		quantity: qty,
		serials: serialSummary,
		serialDetails,
		voltageLabel,
		status: aggregateStatus,
		isDelay: state.isDelay,
		timeline,
		summary,
		tooltip
	});

	// NOTE: harmonization will be triggered via the `registration:saved`
	// dispatch below which causes `renderCalendar()` to run and call
	// `harmonizeLo2Timelines`. Avoid calling harmonize here directly to
	// prevent double execution and potential race conditions.

	document.dispatchEvent(new CustomEvent("registration:saved", { detail: savedEvent }));
	try { if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast('Đăng ký thành công', { type: 'success' }); } catch (e) {}
	setTimeout(() => closeModal(), 200);
}

function closeModal() {
	if (!modalEl) {
		return;
	}
	if (formEl) {
		formEl.reset();
		formEl.classList.remove("is-validated");
	}
	if (furnaceSelect) {
		furnaceSelect.value = "";
	}
	resetQuantitySelect();
	resetSerialInputs();
	resetStatusState();
	resetLinkedContext();
	modalEl.classList.remove("is-open");
	modalEl.hidden = true;
	document.body.classList.remove("modal-open");
	state.scheduleId = "";
	state.currentDateISO = null;
}

function updateSubtitle(dateISO, scheduleName) {
	const subtitle = document.getElementById("modalRegisterSubtitle");
	if (!subtitle) {
		return;
	}
	const parts = [];
	if (scheduleName) {
		parts.push(scheduleName);
	}
	if (dateISO) {
		const date = new Date(`${dateISO}T00:00:00`);
		const formatted = new Intl.DateTimeFormat("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
		parts.push(formatted);
	}
	subtitle.textContent = parts.join(" • ");
}

function populateCurrentUser() {
	if (!nameInput) {
		return;
	}
	const user = getCurrentUser();
	nameInput.value = user.name;
}

function resetQuantitySelect() {
	if (!quantitySelect) {
		return;
	}
	quantitySelect.disabled = true;
	quantitySelect.innerHTML = '<option value="" hidden selected>Số lượng</option>';
}

function handleQuantityChange() {
	const qty = Number(quantitySelect.value || 0);
	renderSerialInputs(qty);
}

function resetSerialInputs() {
	renderSerialInputs(0);
}

function renderSerialInputs(count) {
	if (!serialContainer) {
		return;
	}
	serialContainer.innerHTML = "";
	if (!count) {
		const empty = document.createElement("p");
		empty.className = "serial-grid__empty";
		empty.textContent = "Chọn số lượng để nhập số sê-ri.";
		serialContainer.appendChild(empty);
		return;
	}
	for (let index = 1; index <= count; index += 1) {
		const row = document.createElement("div");
		row.className = "serial-grid__row";

		const input = document.createElement("input");
		input.type = "text";
		input.name = `registerSerialNumber${index}`;
		input.placeholder = `Sê-ri #${index}`;
		input.required = true;
		row.appendChild(input);

		const voltageField = document.createElement("div");
		voltageField.className = "serial-grid__unit-field";

		const select = document.createElement("select");
		select.name = `registerVoltage${index}`;
		select.required = true;

		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.hidden = true;
		placeholder.selected = true;
		placeholder.textContent = "Cấp điện áp";
		select.appendChild(placeholder);

		VOLTAGE_OPTIONS.forEach(option => {
			const opt = document.createElement("option");
			opt.value = option.value;
			opt.textContent = option.label;
			select.appendChild(opt);
		});

		voltageField.appendChild(select);
		row.appendChild(voltageField);
		serialContainer.appendChild(row);
	}

}

function collectSerialNumbers() {
	if (!serialContainer) {
		return [];
	}
	return Array.from(serialContainer.querySelectorAll(".serial-grid__row")).map(row => {
		const serialInput = row.querySelector("input");
		const voltageSelect = row.querySelector("select");
		const voltageValue = voltageSelect?.value || "";
		const voltageLabel = voltageSelect?.selectedOptions[0]?.textContent?.trim() || (voltageValue ? `${voltageValue} kV` : "");
		return {
			serial: serialInput?.value.trim() || "",
			voltageValue,
			voltageLabel
		};
	}).filter(entry => entry.serial && entry.voltageValue);
}

function validateLo1Availability({ startISO, voltageValue }) {
	// Only enforce capacity checks; remove special-case hiding/blocking rules.
	// Block if the selected start date falls within any existing event's phase1
	// occupied days. For half-day semantics: if an existing phase1 starts on day X
	// and ends on day Y (end is inclusive FH), then days X .. Y-1 are occupied
	// (e.g., start=3/11, end=5/11 => occupied 3/11 and 4/11; 5/11 allowed).
	try {
		const schedule = getScheduleById(state.scheduleId || "mba");
		if (schedule && Array.isArray(schedule.events)) {
			const target = new Date(`${startISO}T00:00:00`);
			for (const evt of schedule.events) {
				if (!isLo1Furnace(evt.furnace || evt.furnaceLabel || "")) continue;
				const stage1 = evt.timeline?.stages?.find(s => s.id === 'phase1');
				if (!stage1) continue;
				const st = new Date(`${stage1.start}T00:00:00`);
				const en = new Date(`${stage1.end}T00:00:00`);
				const lastBlocked = addDays(en, -1);
				if (target.getTime() >= st.getTime() && target.getTime() <= lastBlocked.getTime()) {
					// blocked because this date falls inside an existing event's phase1
					return { ok: false, message: "Lò 1 đang bận trong khoảng ngày này, vui lòng chọn ngày khác.", reason: 'phase1' };
				}
			}
		}
	} catch (e) {
		// fallback to capacity check if anything fails
		console.warn('validateLo1Availability fallback', e);
	}
	// Fallback to capacity-based check
	const busyRanges = collectFurnaceBusyRanges("lo1");
	const capacityOk = canScheduleFurnace(startISO, voltageValue, 1, busyRanges, 1);
	if (!capacityOk) {
		// capacity failure - return blocked but do NOT auto-hide; caller may decide
		return { ok: false, message: "Lò 1 đang bận, vui lòng chọn ngày hoặc lò khác.", reason: 'capacity' };
	}
	return { ok: true };
}

function validateLo2Availability({ startISO, voltageValue, quantity }) {
	// First, block if the selected start date falls within any existing event's phase1
	// For Lo2 we treat phase1 occupancy as blocking the whole furnace for that day
	try {
		const schedule = getScheduleById(state.scheduleId || "mba");
		if (schedule && Array.isArray(schedule.events)) {
			const target = new Date(`${startISO}T00:00:00`);
			for (const evt of schedule.events) {
				if (!isLo2Furnace(evt.furnace || evt.furnaceLabel || "")) continue;
				const stage1 = evt.timeline?.stages?.find(s => s.id === 'phase1');
				if (!stage1) continue;
				const st = new Date(`${stage1.start}T00:00:00`);
				const en = new Date(`${stage1.end}T00:00:00`);
				const lastBlocked = addDays(en, -1);
				if (target.getTime() >= st.getTime() && target.getTime() <= lastBlocked.getTime()) {
					return { ok: false, message: "Lò 2 đang bận trong khoảng ngày này, vui lòng chọn ngày khác.", reason: 'phase1' };
				}
			}
		}
	} catch (e) {
		console.warn('validateLo2Availability fallback', e);
	}

	// Fallback to capacity-based check
	const busyRanges = collectFurnaceBusyRanges("lo2");
	const capacityOk = canScheduleFurnace(startISO, voltageValue, quantity, busyRanges, 2);
	if (!capacityOk) {
		return { ok: false, message: "Lò 2 đang bận, vui lòng chọn thời gian/điện áp khác.", reason: 'capacity' };
	}
	return { ok: true };
}

// use shared furnace helpers from `asset/js/furnace.js`

// New helpers
function evaluateFurnaceAvailability() {
	// Recompute availability sets without hiding rules
	// clear any previous hidden state before recomputing
	hideFurnaceOption('lo1', false);
	hideFurnaceOption('lo2', false);
	updateLo1Availability();
	updateLo2Availability();
	const lo1Enabled = state.lo1AllowedVoltages.size > 0;
	applyFurnaceOptionState("lo1", lo1Enabled);
	const lo2HasCapacity = (state.lo2AllowedVoltages["1"]?.size || 0) > 0 || (state.lo2AllowedVoltages["2"]?.size || 0) > 0;
	applyFurnaceOptionState("lo2", lo2HasCapacity);
	applyQuantityAvailability();
	applyVoltageAvailability();

	// Additional: run validateLo1Availability for the currently selected date
	// and hide Lò 1 when it is explicitly blocked by phase1 occupancy or capacity.
	try {
		if (state.currentDateISO) {
			const r = validateLo1Availability({ startISO: state.currentDateISO, voltageValue: null });
			// only hide Lò 1 when the block reason is phase1 occupancy (we want
			// capacity failures to surface but not forcibly hide the option)
			if (r && r.ok === false && r.reason === 'phase1') {
				hideFurnaceOption('lo1', true);
			}
			const r2 = validateLo2Availability({ startISO: state.currentDateISO, voltageValue: null, quantity: quantitySelect?.value || '1' });
			if (r2 && r2.ok === false && r2.reason === 'phase1') {
				hideFurnaceOption('lo2', true);
			}
		}
	} catch (e) {
		// noop
	}
}

function updateLo1Availability() {
	// Do not disable Lò 1 based on overlap/relief windows. Allow all voltages by default
	// if a date is selected — capacity checks remain elsewhere if needed.
	const allowed = new Set();
	if (state.currentDateISO) {
		VOLTAGE_OPTIONS.forEach(option => allowed.add(option.value));
	}
	state.lo1AllowedVoltages = allowed;
	return { blockLo1: false, hideVoltage220: false, hideLo1Option: false, reliefDayIndex: null };

}

function updateLo2Availability() {
	// Do not disable Lò 2 based on overlap/gap windows. Allow all voltages for both quantities
	// when a date is selected so that users can always choose a furnace regardless of timeline overlaps.
	const availability = { 1: new Set(), 2: new Set() };
	if (state.currentDateISO) {
		["1", "2"].forEach(qtyKey => {
			VOLTAGE_OPTIONS.forEach(option => availability[qtyKey].add(option.value));
		});
	}
	state.lo2AllowedVoltages = availability;
}

function applyFurnaceOptionState(value, available) {
	if (!furnaceSelect) {
		return;
	}
	const option = furnaceSelect.querySelector(`option[value="${value}"]`);
	if (!option) {
		return;
	}
	// Do not hide furnace options; only disable when not available
	option.disabled = !available;
	// do not override explicit hidden state here; only clear when available
	if (available) option.hidden = false;
	if (!available && furnaceSelect.value === value) {
		furnaceSelect.value = "";
		resetQuantitySelect();
		resetSerialInputs();
	}
}

function hideFurnaceOption(value, hidden) {
	if (!furnaceSelect) return;
	const option = furnaceSelect.querySelector(`option[value="${value}"]`);
	if (!option) return;
	option.hidden = hidden;
	if (hidden && furnaceSelect.value === value) {
		// if currently selected, clear selection and reset dependent inputs
		furnaceSelect.value = "";
		resetQuantitySelect();
		resetSerialInputs();
	}
}

function collectFurnaceBusyRanges(furnaceValue) {
	try {
		const schedule = getScheduleById(state.scheduleId || "mba");
		const furnaceKey = normalizeFurnaceKey(furnaceValue);
		return (schedule.events || [])
			.filter(event => normalizeFurnaceKey(event.furnace || event.furnaceLabel || "") === furnaceKey)
			.flatMap(event => {
				const linesUsed = furnaceValue === "lo2" ? getEventLineCount(event) : 1;
				const voltageValue = getHighestVoltage(extractSerialDetailsFromEvent(event));
				return (event.timeline?.stages || [])
					.filter(stage => stage.id === "phase1" || stage.id === "phase2")
					.map(stage => {
						// represent busy ranges at half-day precision:
						// - start: if stage.startHalf === SECOND_HALF => start at 12:00, otherwise 00:00
						// - end: phase ends at FH (first half end) -> represent as 12:00 of end day
						const startTime = (stage.startHalf === SECOND_HALF) ? `${stage.start}T12:00:00` : `${stage.start}T00:00:00`;
						const endTime = `${stage.end}T12:00:00`;
						return {
							start: new Date(startTime),
							end: new Date(endTime),
							linesUsed,
							voltageValue
						};
					});
			});
	} catch {
		return [];
	}
}

function getEventLineCount(event) {
	const fromQuantity = Number(event?.quantity);
	const fromDetails = Array.isArray(event?.serialDetails) ? event.serialDetails.length : 0;
	const inferred = Math.max(fromQuantity || 0, fromDetails || 0);
	return Math.min(Math.max(inferred, 1), 2);
}

function canScheduleFurnace(startISO, voltageValue, quantity, busyRanges, capacity, options = {}) {
	if (!startISO) {
		return false;
	}
	const normalizedVoltage = voltageValue || "40";
	const intervals = computeStageIntervals(startISO, normalizedVoltage);
	const targetIntervals = options.phase === "phase1" ? intervals.slice(0, 1) : intervals;
	return targetIntervals.every(interval => hasCapacityForInterval(interval, quantity, busyRanges, capacity));
}

function computeStageIntervals(startISO, voltageValue) {
	const normalizedVoltage = voltageValue === "220" ? "220" : "110";
	const rules = VOLTAGE_RULES[normalizedVoltage] || VOLTAGE_RULES["110"];
	// rules.phaseX are expressed in halves; convert to days for interval math
	// When a phase is assumed to start on the SECOND_HALF (default for
	// registrations), apply the revised formula: days = ceil(halves/2 + 1).
	const phase1Days = Math.max(1, Math.ceil((rules.phase1 || 0) / 2 + 1));
	const phase2Days = Math.max(1, Math.ceil((rules.phase2 || 0) / 2 + 1));
	const stage1Start = new Date(`${startISO}T00:00:00`);
	const stage1End = addDays(stage1Start, phase1Days - 1);
	// Support gap expressed either as explicit days (`gapDays`) or as
	// a halves count (`gapHalves`). If `gapHalves` is provided we convert
	// using the same halves→days rule; otherwise fall back to gapDays.
	let gap = null;
	if (Number.isFinite(Number(rules.gapHalves))) {
		gap = Math.max(1, Math.ceil(Number(rules.gapHalves) / 2 + 1));
	} else {
		gap = Math.max(Number(rules.gapDays ?? GAP_DAYS) || 0, MIN_GAP_DAYS);
	}
	const stage2Start = addDays(stage1End, gap);
	const stage2End = addDays(stage2Start, phase2Days - 1);
	// represent intervals with half-day precision: phases start on SH and end on FH
	const toStartDateTime = date => new Date(`${toISO(date)}T12:00:00`); // SH
	const toEndDateTime = date => new Date(`${toISO(date)}T12:00:00`); // FH represented as 12:00
	return [
		{ start: toStartDateTime(stage1Start), end: toEndDateTime(stage1End) },
		{ start: toStartDateTime(stage2Start), end: toEndDateTime(stage2End) }
	];
}

function hasCapacityForInterval(interval, quantity, busyRanges, capacity) {
	let cursor = new Date(interval.start);
	// iterate in half-day (12 hour) steps and treat busy.end as exclusive
	const endLimit = new Date(interval.end);
	while (cursor < endLimit || cursor.getTime() === endLimit.getTime()) {
		const usage = busyRanges.reduce((sum, busy) => (
			// busy.end is exclusive: if cursor === busy.end it's allowed
			cursor >= busy.start && cursor < busy.end ? sum + (busy.linesUsed || 1) : sum
		), 0);
		if (usage + quantity > capacity) {
			return false;
		}
		cursor = addHours(cursor, 12);
		// safety guard against badly formed intervals
		if (cursor.getTime() - endLimit.getTime() > 1000 * 60 * 60 * 24 * 365) break;
	}
	return true;
}

function getHighestVoltage(entries = []) {
	if (entries.some(entry => String(entry && entry.voltageValue || '').trim() === "220")) {
		return "220";
	}
	if (entries.some(entry => String(entry && entry.voltageValue || '').trim() === "110")) {
		return "110";
	}
	// fallback to the lower available option
	return "110";
}



function getLo1ReliefAdjustmentForDate(dateISO) {
	if (!dateISO) {
		return { blockLo1: false, hideVoltage220: false, hideLo1Option: false, reliefDayIndex: null };
	}
	let schedule;
	try {
		schedule = getScheduleById(state.scheduleId || "mba");
	} catch {
		return { blockLo1: false, hideVoltage220: false, hideLo1Option: false, reliefDayIndex: null };
	}
	const targetDate = new Date(`${dateISO}T00:00:00`);
	const lo1Events = (schedule.events || []).filter(evt => isLo1Furnace(evt.furnace || evt.furnaceLabel || ""));
	for (const evt of lo1Events) {
		const stage1 = evt.timeline?.stages?.find(stage => stage.id === "phase1");
		const stage2 = evt.timeline?.stages?.find(stage => stage.id === "phase2");

		if (!stage1 || !stage2) {
			continue;
		}
		// Compute relief window using configured gapDays for this event's voltage
		const reliefStart = addDays(new Date(`${stage1.end}T00:00:00`), 1);
		// derive voltage key for rules (fall back to "110" for non-220)
		const evtVoltage = getHighestVoltage(extractSerialDetailsFromEvent(evt));
		const rulesKey = evtVoltage === "220" ? "220" : "110";
		let configuredGap = Number((VOLTAGE_RULES[rulesKey] && VOLTAGE_RULES[rulesKey].gapDays) ?? GAP_DAYS);
		configuredGap = Math.max(configuredGap || 0, MIN_GAP_DAYS);
		const reliefEnd = addDays(reliefStart, configuredGap - 1);
		if (targetDate < reliefStart || targetDate > reliefEnd) {
			continue;
		}
		const offset = getDayOffset(reliefStart, targetDate);
		if (offset === 0) {
			return { blockLo1: false, hideVoltage220: false, hideLo1Option: false, reliefDayIndex: 0 };
		}
		if (offset === 1) {
			return { blockLo1: false, hideVoltage220: true, hideLo1Option: false, reliefDayIndex: 1 };
		}
		return { blockLo1: true, hideVoltage220: false, hideLo1Option: true, reliefDayIndex: offset };
	}
	return { blockLo1: false, hideVoltage220: false, hideLo1Option: false, reliefDayIndex: null };

}

function handleStatusChange(nextStatus) {
	if (nextStatus === state.currentStatus) {
		return;
	}
	state.currentStatus = nextStatus;
	recordHistory(nextStatus);
	updateStatusHiddenInputs();
	updateStatusVisuals();
}

function toggleDelayStatus() {
	state.isDelay = !state.isDelay;
	recordHistory(state.isDelay ? DELAY_LABEL : "Bỏ Delay");
	updateStatusHiddenInputs();
	updateStatusVisuals();
}

function resetStatusState() {
	state.currentStatus = STATUS_FLOW[0];
	state.isDelay = false;
	state.history = [];
	recordHistory(state.currentStatus);
	updateStatusHiddenInputs();
	updateStatusVisuals();
}

function updateStatusHiddenInputs() {
	if (hiddenStatusInput) {
		hiddenStatusInput.value = state.currentStatus;
	}
	if (hiddenDelayInput) {
		hiddenDelayInput.value = state.isDelay ? "true" : "false";
	}
}

function updateStatusVisuals() {
	if (!statusStepsEl) {
		return;
	}
	const currentIndex = STATUS_FLOW.indexOf(state.currentStatus);
	Array.from(statusStepsEl.children).forEach((btn, index) => {
		btn.classList.toggle("is-active", index === currentIndex);
		btn.classList.toggle("is-completed", index < currentIndex);
	});
	if (statusDelayBtn) {
		statusDelayBtn.classList.toggle("is-active", state.isDelay);
		statusDelayBtn.setAttribute("aria-pressed", state.isDelay ? "true" : "false");
	}
	renderHistory();
}

function recordHistory(statusLabel) {
	const actor = getCurrentUser().name;
	state.history.push({
		status: statusLabel,
		actor,
		timestamp: new Date().toISOString()
	});
}

function renderHistory() {
	if (!statusHistoryEl) {
		return;
	}
	if (!state.history.length) {
		statusHistoryEl.innerHTML = "";
		const empty = document.createElement("p");
		empty.className = "history-log__empty";
		empty.textContent = "Chưa có thay đổi.";
		statusHistoryEl.appendChild(empty);
		return;
	}
	statusHistoryEl.innerHTML = "";
	state.history.forEach(entry => {
		const date = new Date(entry.timestamp);
		const formatted = new Intl.DateTimeFormat("vi-VN", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			day: "2-digit",
			month: "2-digit",
			year: "numeric"
		}).format(date);

		const item = document.createElement("div");
		item.className = "history-log__item";

		const statusSpan = document.createElement("span");
		statusSpan.className = "history-log__status";
		statusSpan.textContent = entry.status;

		const metaSpan = document.createElement("span");
		metaSpan.className = "history-log__meta";
		metaSpan.textContent = `${entry.actor} • ${formatted}`;

		item.appendChild(statusSpan);
		item.appendChild(metaSpan);
		statusHistoryEl.appendChild(item);
	});
}

function buildTimeline(startISO, durationRules, opts = {}) {
	const forcedPhase2StartISO = opts.forcedPhase2StartISO || null;
	const forceExactPhase2Start = opts.forceExactPhase2Start !== undefined
		? Boolean(opts.forceExactPhase2Start)
		: Boolean(forcedPhase2StartISO);
	const allowSundaySecondHalfStart = Boolean(opts.allowSundaySecondHalfStart);
	const stages = [];
	const segments = [];
	let cursor = new Date(`${startISO}T00:00:00`);
	// Interpret incoming durationRules.phase1/phase2 as counts in halves.
	// Convert halves -> days for calendar calculations (2 halves = 1 day).
	// Account for the configured start half: when a phase starts in the
	// SECOND_HALF of its start day, the visible day span increases because
	// the first half of that day is not available (effectively consuming one
	// half-day immediately). Example: 6 halves starting at SECOND_HALF span
	// 4 visible days rather than 3.
	const phase1Halves = Number(durationRules.phase1 || 0);
	const phase2Halves = Number(durationRules.phase2 || 0);
	const initialStartHalf = opts.startHalf || SECOND_HALF;
	function halvesToDays(halves, startHalf) {
		if (!Number.isFinite(Number(halves))) return 1;
		// New rule: when the phase starts on the SECOND_HALF (SH), treat the
		// visible day span as ceil(halves/2 + 1). This explicitly adds one
		// visible day (the consumed first half) before rounding.
		if (startHalf === SECOND_HALF) {
			return Math.max(1, Math.ceil(Number(halves) / 2 + 1));
		}
		return Math.max(1, Math.ceil(Number(halves) / 2));
	}
	const phase1Days = halvesToDays(phase1Halves, initialStartHalf);
	const phase2Days = halvesToDays(phase2Halves, SECOND_HALF);

	// Stage1: compute start/end from cursor using converted day durations
	const stage1Start = new Date(cursor);
	const stage1End = addDays(stage1Start, phase1Days - 1);
	const stage1Entry = {
		...TIMELINE_STAGES[0],
		start: toISO(stage1Start),
		end: toISO(stage1End),
		durationDays: phase1Days
	};
	// Per new rules, phase1 always starts on the second half of day x
	try {
		stage1Entry.startHalf = SECOND_HALF;
	} catch (e) {
		// noop
	}

	// Helper: if a phase start is on Sunday and marked SECOND_HALF, move it
	// forward by one day so it begins on Monday SECOND_HALF (advance by 2 halves).
	function shiftSundaySecondHalfForward(dateObj, allowSundaySecondHalf = false) {
		try {
			if (!dateObj || typeof dateObj.getDay !== 'function') return dateObj;
			if (dateObj.getDay() === 0 && !allowSundaySecondHalf) {
				return addDays(dateObj, 1);
			}
		} catch (e) {
			// ignore
		}
		return dateObj;
	}

	// Apply rule to stage1 start (cursor)
	try {
		const maybeShifted = shiftSundaySecondHalfForward(stage1Start, allowSundaySecondHalfStart);
		if (maybeShifted.getTime() !== stage1Start.getTime()) {
			// recompute end based on shifted start
			const shiftedEnd = addDays(maybeShifted, phase1Days - 1);
			stage1Entry.start = toISO(maybeShifted);
			stage1Entry.end = toISO(shiftedEnd);
			cursor = new Date(maybeShifted);
		}
	} catch (e) {
		// ignore
	}

	stages.push(stage1Entry);
	segments.push({
		type: TIMELINE_STAGES[0].id,
		label: TIMELINE_STAGES[0].label,
		start: stage1Entry.start,
		end: stage1Entry.end,
		days: stage1Entry.durationDays,
		stageIndex: 1,
		startHalf: stage1Entry.startHalf
	});

	// Compute gap and phase2 start using offsets relative to the original start (day x)
	// Support gap expressed either as explicit days (`gapDays`/`gap`) or as
	// a halves count (`gapHalves`). If `gapHalves` is provided convert using
	// the same halves→days rule (ceil(halves/2 + 1)). Otherwise fall back to
	// the configured gapDays and enforce minimum gap.
	let gapDays;
	if (Number.isFinite(Number(durationRules.gapHalves))) {
		gapDays = Math.max(1, Math.ceil(Number(durationRules.gapHalves) / 2 + 1));
	} else {
		gapDays = Number(durationRules.gapDays ?? durationRules.gap ?? GAP_DAYS);
		gapDays = Math.max(Number(gapDays || 0), MIN_GAP_DAYS);
	}
	// Start with configured gapDays; only increase if overlap detected
	let effectiveGap = gapDays;
	// Compute phase2 start using configured gap (in days) but enforce minimum gap
	// in halves (MIN_GAP_HALVES) via MIN_GAP_DAYS. If a forcedPhase2StartISO is
	// provided we respect it but still clamp to the minimum gap.
	let phase2StartDate;
	const allowForcedWithinMinGap = Boolean(opts.allowForcedWithinMinGap);
	if (forcedPhase2StartISO) {
		// If a forced start was provided (meaning someone explicitly registered
		// phase2 on a date), respect it. However, if that forced date falls
		// within the minimum gap window we will move the forced start earlier
		// to the second-half of stage1End to avoid overlap (user intent: place
		// phase2 but avoid overlapping). If forced date is beyond min-gap,
		// keep it as-is.
		phase2StartDate = new Date(`${forcedPhase2StartISO}T00:00:00`);
		const daysFromEnd = getDayOffset(stage1End, phase2StartDate);
		if (daysFromEnd < MIN_GAP_DAYS && !allowForcedWithinMinGap) {
			// Move forced start forward so it respects the configured minimum gap
			// (avoid forcing phase2 into the minimum-gap/overlap window).
			phase2StartDate = addDays(stage1End, MIN_GAP_DAYS);
		}
	} else {
		// No forced start — compute using converted phase1 days + effectiveGap
		phase2StartDate = addDays(stage1Start, phase1Days + effectiveGap - 1);
		// ensure minimum gap from stage1End
		if (getDayOffset(stage1End, phase2StartDate) < MIN_GAP_DAYS) {
			phase2StartDate = addDays(stage1End, MIN_GAP_DAYS);
		}
	}

	let phase2EndDate = addDays(phase2StartDate, phase2Days - 1);
	const stage2Entry = {
		...TIMELINE_STAGES[1],
		start: toISO(phase2StartDate),
		end: toISO(phase2EndDate),
		durationDays: phase2Days
	};
	// Per new rules, phase2 start should be on the second half of its start day
	try {
		stage2Entry.startHalf = SECOND_HALF;
	} catch (e) {
		// noop
	}

	// Apply Sunday-second-half shift to phase2 start as well: if phase2StartDate
	// falls on Sunday and phase2 is expected to start in SECOND_HALF, move it
	// forward by one day to Monday SECOND_HALF.
	if (!forceExactPhase2Start && !allowSundaySecondHalfStart) {
		try {
			const maybeShiftedP2 = shiftSundaySecondHalfForward(phase2StartDate);
			if (maybeShiftedP2.getTime() !== phase2StartDate.getTime()) {
				phase2StartDate = maybeShiftedP2;
				// recompute end based on shifted start
				phase2EndDate = addDays(phase2StartDate, phase2Days - 1);
				stage2Entry.start = toISO(phase2StartDate);
				stage2Entry.end = toISO(phase2EndDate);
			}
		} catch (e) {
			// ignore
		}
	}
	stages.push(stage2Entry);
	segments.push({
		type: TIMELINE_STAGES[1].id,
		label: TIMELINE_STAGES[1].label,
		start: stage2Entry.start,
		end: stage2Entry.end,
		days: stage2Entry.durationDays,
		stageIndex: 2,
		startHalf: stage2Entry.startHalf
	});

	// If not forced, include explicit gap segment as before; if forcedPhase2StartISO causes a negative/nil gap,
	// we include zero-length or no gap segment (keeps timeline consistent for display).
	// Build explicit gap segment between phase1 and phase2 according to new half-day mapping
	// Determine visible gap based on actual phase2StartDate. If phase2StartDate
	// is the same day as stage1End (startHalf=SECOND_HALF), visible gap is zero.
	const gapStart = addDays(stage1End, 1);
	const gapEnd = addDays(phase2StartDate, -1);
	const visibleGapDays = Math.max(0, getDayOffset(gapStart, gapEnd) + 1);
	if (visibleGapDays > 0) {
		segments.splice(1, 0, {
			type: "gap",
			label: `Gap ${visibleGapDays} ngày`,
			start: toISO(gapStart),
			end: toISO(gapEnd),
			days: visibleGapDays
		});
	}

	const totalDays = segments.reduce((sum, seg) => sum + seg.days, 0);
	// Determine explicit gapDay start/end (null when no visible gap)
	const explicitGapStart = addDays(stage1End, 1);
	const explicitGapEnd = addDays(phase2StartDate, -1);
	const visibleGapDaysFinal = Math.max(0, getDayOffset(explicitGapStart, explicitGapEnd) + 1);
	const gapDay_start = visibleGapDaysFinal > 0 ? toISO(explicitGapStart) : null;
	const gapDay_end = visibleGapDaysFinal > 0 ? toISO(explicitGapEnd) : null;

	return {
		gapDays: effectiveGap,
		gapDay_start,
		gapDay_end,
		stages,
		segments,
		totalDays,
		start: stages[0]?.start,
		end: stages[stages.length - 1]?.end,
		startHalf: stages[0]?.startHalf || null
	};
}

function createSummary({ furnaceLabel, registrant, quantity, serials, voltageLabel, status, timeline }) {
	const stageNames = timeline.stages.map(stage => stage.label).join(" / ");
	return `${furnaceLabel} - ${registrant} - SL ${quantity} - Serial ${serials.join(", ")} - ${voltageLabel} - ${status} - Giai đoạn: ${stageNames}`;
}

function createTooltip({ furnaceLabel, registrant, quantity, serials, voltageLabel, status, timeline }) {
	const lines = [
		`Lò: ${furnaceLabel}`,
		`Người đăng ký: ${registrant}`,
		`Số lượng: ${quantity}`,
		`Số serial: ${serials.join(", ")}`,
		`Cấp điện áp: ${voltageLabel}`,
		`Trạng thái: ${status}`
	];
	// Show half-day aware ranges in tooltip (startHalf may be present on stage)
	timeline.stages.forEach(stage => {
		const startHalfLabel = (stage.startHalf === SECOND_HALF) ? 'SH' : 'FH';
		const endHalfLabel = 'FH';
		const startLabel = `${toISO(new Date(`${stage.start}T00:00:00`))} ${startHalfLabel}`;
		const endLabel = `${toISO(new Date(`${stage.end}T00:00:00`))} ${endHalfLabel}`;
		lines.push(`${stage.label}: ${startLabel} → ${endLabel} (${stage.durationDays} ngày)`);
	});
	return lines.join("\n");
}

function addDays(date, amount) {
	const result = new Date(date);
	result.setDate(result.getDate() + amount);
	return result;
}

function addHours(date, amount) {
    const result = new Date(date);
    result.setHours(result.getHours() + amount);
    return result;
}

function toISO(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatRange(startISO, endISO) {
	const formatter = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit" });
	const start = formatter.format(new Date(`${startISO}T00:00:00`));
	const end = formatter.format(new Date(`${endISO}T00:00:00`));
	return `${start} → ${end}`;
}

function getDayOffset(startDate, endDate) {
	const startMs = stripTime(startDate).getTime();
	const endMs = stripTime(endDate).getTime();
	return Math.round((endMs - startMs) / 86400000);
}

// Backward compatibility for any legacy calls.
function daysBetweenDates(startDate, endDate) {
	return getDayOffset(startDate, endDate);
}

function applyQuantityAvailability() {
	if (!quantitySelect) {
		return;
	}
	const isLo2 = furnaceSelect?.value === "lo2";
	const options = Array.from(quantitySelect.options).filter(opt => opt.value);

	if (!isLo2) {
		options.forEach(option => {
			const hidden = state.hiddenQuantityValues.has(option.value);
			option.disabled = hidden;
			option.hidden = hidden;
		});
		if (state.hiddenQuantityValues.has(quantitySelect.value)) {
			quantitySelect.value = "";
			renderSerialInputs(0);
		}
		return;
	}

	const allowed = Object.entries(state.lo2AllowedVoltages || {})
		.filter(([, set]) => set?.size)
		.map(([qty]) => qty);

	options.forEach(option => {
		const hiddenByRequest = state.hiddenQuantityValues.has(option.value);
		const permitted = allowed.includes(option.value) && !hiddenByRequest;
		option.disabled = !permitted;
		option.hidden = !permitted;
	});

	const selectionIsValid = allowed.includes(quantitySelect.value) && !state.hiddenQuantityValues.has(quantitySelect.value);
	if (!selectionIsValid) {
		const nextQty = allowed.find(qty => !state.hiddenQuantityValues.has(qty)) || "";
		if (nextQty) {
			quantitySelect.value = nextQty;
			handleQuantityChange();
		} else {
			quantitySelect.value = "";
			renderSerialInputs(0);
		}
	}
}

function applyVoltageAvailability() {
	if (!serialContainer) {
		return;
	}
	const selects = serialContainer.querySelectorAll("select");
	if (!selects.length) {
		return;
	}

	const furnace = furnaceSelect?.value || "";
	let allowed = new Set(VOLTAGE_OPTIONS.map(opt => opt.value));

	if (isLo1Furnace(furnace)) {
		allowed = new Set(state.lo1AllowedVoltages || []);
	} else if (isLo2Furnace(furnace)) {
		const qtyKey = quantitySelect?.value || "";
		allowed = new Set(state.lo2AllowedVoltages?.[qtyKey] || []);
	}

	selects.forEach(select => {
		Array.from(select.options).forEach(option => {
			if (!option.value) {
				return;
			}
			const permitted = allowed.has(option.value);
			// Do not hide voltage options; only disable when not permitted
			option.disabled = !permitted;
			option.hidden = false;
		});
		if (select.value && !allowed.has(select.value)) {
			select.value = "";
		}
	});
}

function resetLinkedContext() {
	state.linkedEvent = null;
	state.hiddenQuantityValues = new Set();
	state.lockedFurnace = null;
	state.enforcedDate = null;
	state.autoPlaceholderActive = false;
	state.autoPlaceholderInjectedQuantity = false;
	state.openedViaTimelinePlaceholder = false;
}

function mergeLo2LineRegistration({ scheduleId, eventId, newDetails = [], isDelay }) {
	if (!scheduleId || !eventId) {
		return null;
	}
	const targetEvent = getEventById(scheduleId, eventId);
	if (!targetEvent) {
		return null;
	}
	const existingTimelineSnapshot = targetEvent.timeline ? JSON.parse(JSON.stringify(targetEvent.timeline)) : null;
	try { console.log('[mergeLo2] start', { scheduleId, eventId, targetId: targetEvent.id }); } catch (e) {}

	const normalizedExisting = extractSerialDetailsFromEvent(targetEvent);
	const normalizedIncoming = newDetails.map(normalizeMergedSerialDetail).filter(Boolean);
	try { console.log('[mergeLo2] normalizedExisting=', normalizedExisting, 'normalizedIncoming=', normalizedIncoming); } catch (e) {}
	const mergedDetails = mergeSerialDetailLists(normalizedExisting, normalizedIncoming);

	try { console.log('[mergeLo2] mergedDetails=', mergedDetails); } catch (e) {}

	if (!mergedDetails.length) {
		return null;
	}

	const existingVoltage = getHighestVoltage(normalizedExisting);
	const incomingHighest = normalizedIncoming.some(d => String(d.voltageValue || '').trim() === '220')
		? '220'
		: (normalizedIncoming.some(d => String(d.voltageValue || '').trim() === '110') ? '110' : existingVoltage);
	const isLo2 = isLo2Furnace(targetEvent.furnace || targetEvent.furnaceLabel || '');
	try { console.log('[mergeLo2] existingVoltage=', existingVoltage, 'incomingHighest=', incomingHighest, 'isLo2=', isLo2, 'openedViaPlaceholder=', state.openedViaTimelinePlaceholder, 'targetQty=', targetEvent.quantity); } catch (e) {}

	targetEvent.serialDetails = mergedDetails.slice(0, 2).map((detail, index) => ({
		...detail,
		lineIndex: index + 1
	}));
	targetEvent.serials = targetEvent.serialDetails.map(formatSerialSummary);
	const baselineQty = Number(targetEvent.quantity) || 0;
	targetEvent.quantity = Math.max(baselineQty, targetEvent.serialDetails.length);
	targetEvent.slots = targetEvent.quantity;
	targetEvent.status = deriveLo2EventStatus(targetEvent.serialDetails, targetEvent.status);
	targetEvent.isDelay = Boolean(isDelay);

	const highestVoltage = getHighestVoltage(extractSerialDetailsFromEvent(targetEvent));
	targetEvent.voltageLabel = highestVoltage === "220" ? "220 kV" : "< 220 kV";
	const baseStartISO = targetEvent.timeline?.start || targetEvent.date;
	const durationKey = highestVoltage === "220" ? "220" : "110";
	if (baseStartISO) {
		const timelineOptions = isLo2 ? { allowSundaySecondHalfStart: true } : {};
		targetEvent.timeline = buildTimeline(baseStartISO, VOLTAGE_RULES[durationKey], timelineOptions);
		if (isLo2 && highestVoltage === "220") {
			const anchorResult = resolveLo2AnchorsForUpgrade({
				scheduleId,
				targetEventId: targetEvent.id,
				furnaceValue: targetEvent.furnace || targetEvent.furnaceLabel || "",
				baseTimeline: targetEvent.timeline
			});
			if (anchorResult?.forcedPhase2StartISO) {
				targetEvent.timeline = buildTimeline(baseStartISO, VOLTAGE_RULES[durationKey], {
					...timelineOptions,
					forcedPhase2StartISO: anchorResult.forcedPhase2StartISO,
					allowForcedWithinMinGap: true
				});
			}
		}
	}

	// refresh metadata and persist the updated event so changes survive reload/logout
	refreshEventMetadata(targetEvent);
	try {
		const persisted = updateEvent(scheduleId, targetEvent);
		try { console.log('[mergeLo2] updateEvent persisted=', persisted && persisted.id); } catch (e) {}
		if (persisted) {
			if (isLo2 && existingVoltage !== '220' && highestVoltage === '220') {
				try {
					shiftLo2PeersForUpgradedVoltage({
						scheduleId,
						upgradedEvent: {
							originalTimeline: existingTimelineSnapshot,
							...persisted
						}
					});
				} catch (err) {
					console.warn('[mergeLo2] shiftLo2PeersForUpgradedVoltage failed', err);
				}
			}
			// After persisting the merged Lo2 event, ensure all Lo2 events
			// are harmonized so the furnace uses the longest duration and
			// later events are shifted to avoid overlap.
			try { console.log('[mergeLo2] calling harmonizeLo2Timelines (after updateEvent persisted)', { scheduleId, persistedId: persisted && persisted.id }); harmonizeLo2Timelines(scheduleId); } catch (err) { /* noop */ }
			return persisted;
		}
	} catch (e) {
		console.warn('mergeLo2LineRegistration: updateEvent failed', e);
	}
	try { console.log('[mergeLo2] calling harmonizeLo2Timelines (final fallback)', { scheduleId }); harmonizeLo2Timelines(scheduleId); } catch (err) { /* noop */ }
	return targetEvent;
}

// When Lo2 registrations change (lines merged/added), recompute timelines
// across all Lo2 events so the furnace uses the longest duration present
// (e.g., any 220kV will make the furnace use 220 rules) and shift later
// events to avoid overlaps. This harmonization is intentionally simple and
// relies on buildTimeline to apply the Sunday/second-half rules.
function harmonizeLo2Timelines(scheduleId) {
	try {
		try { console.log('[harmonize] start for schedule', scheduleId); } catch (e) {}
		try { console.log('[harmonize-debug] entering harmonizeLo2Timelines', { scheduleId }); } catch (e) {}
		const schedule = getScheduleById(scheduleId || "mba");
		if (!schedule || !Array.isArray(schedule.events)) return;
		const lo2Events = (schedule.events || []).filter(evt => isLo2Furnace(evt.furnace || evt.furnaceLabel || ""));
		try { console.log('[harmonize] found lo2Events count=', lo2Events.length, 'ids=', lo2Events.map(e=>e.id)); } catch (e) {}
		const buildLo2Timeline = (startISO, durations, extraOpts = {}) => {
			if (!startISO) return null;
			return buildTimeline(startISO, durations, { ...extraOpts, allowSundaySecondHalfStart: true });
		};
		// Debug: print extracted serial details and per-event highest voltage
		try {
			lo2Events.forEach(e => {
				try {
					const details = extractSerialDetailsFromEvent(e);
					const highest = getHighestVoltage(details);
					console.log('[harmonize-debug] evt', e.id || '(no-id)', 'date', e.date || e.timeline?.start, 'serials', Array.isArray(e.serials) ? e.serials : [], 'serialDetails', details, 'highest', highest);
				} catch (inner) { console.warn('[harmonize-debug] failed extract for evt', e && e.id, inner); }
			});
		} catch (e) {}
		if (!lo2Events.length) return;
		// Determine global longest voltage present across Lo2 events
		const globalLongest = lo2Events.some(e => getHighestVoltage(extractSerialDetailsFromEvent(e)) === '220') ? '220' : '110';
		const globalDurations = VOLTAGE_RULES[globalLongest] || VOLTAGE_RULES['110'];
		try { console.log('[harmonize-debug] globalLongest=', globalLongest, 'globalDurations=', globalDurations); } catch (e) {}

		// Sort by base start date (existing event.date / timeline.start)
		lo2Events.sort((a, b) => {
			const aStart = a.timeline?.start || a.date || '';
			const bStart = b.timeline?.start || b.date || '';
			return (aStart || '').localeCompare(bStart || '');
		});

		// Build provisional timelines
		const provisional = lo2Events.map(evt => {
			const baseStart = evt.date || evt.timeline?.start || evt.date;
			const built = baseStart ? buildLo2Timeline(baseStart, globalDurations) : null;
			// keep an immutable snapshot of the original provisional built timeline
			const originalBuilt = built ? JSON.parse(JSON.stringify(built)) : null;
			const stage1 = built?.stages?.find(s => s.id === 'phase1');
			const stage2 = built?.stages?.find(s => s.id === 'phase2');
			const stage2End = stage2 ? stage2.end : null;
			try { console.log('[harmonize] provisional for', evt.id || baseStart, { baseStart, stage1End: stage1?.end, stage2Start: stage2?.start, stage2End }); } catch (e) {}
			return {
				evt,
				baseStart,
				built,
				originalBuilt,
				stage1End: stage1 ? stage1.end : null,
				stage2Start: stage2 ? stage2.start : null,
				stage2End
			};
		});
		try { console.log('[harmonize-debug] provisional array built', provisional.map(p => ({ id: p.evt?.id, baseStart: p.baseStart, stage1End: p.stage1End, stage2Start: p.stage2Start, stage2End: p.stage2End }))); } catch (e) {}

		// Special-case pass: if an earlier event's provisional phase2 would
		// start before a later event's phase1 end, adjust the earlier event
		// by forcing its phase2 to start at the later event's phase1 end.
		// This mirrors the intended Lo1 adjustment behavior and prevents
		// the earlier event from overlapping the later event.
		{
			for (let i = 0; i < provisional.length; i += 1) {
				for (let j = i + 1; j < provisional.length; j += 1) {
					const a = provisional[i];
					const b = provisional[j];
					if (!a || !b || !a.built || !b.built) continue;
					// If the persisted phase2 end of A is already before the persisted phase1 start of B,
					// treat them as non-overlapping even if the provisional/global timelines would overlap.
					// This prevents artificial pushes when upgrading B to 220 kV stretches A's provisional
					// timeline even though the saved schedule shows A finishing earlier.
					try {
						const actualAP2End = isoToDayDate(a?.evt?.timeline?.stages?.find(stage => stage && stage.id === 'phase2')?.end);
						const actualBP1Start = isoToDayDate((b?.evt?.timeline?.stages?.find(stage => stage && stage.id === 'phase1')?.start) || b?.baseStart);
						if (actualAP2End && actualBP1Start && actualAP2End.getTime() < actualBP1Start.getTime()) {
							continue;
						}
					} catch (guardErr) {
						// ignore guard failures; fall back to provisional comparisons
					}
					const aP2Start = a.stage2Start ? new Date(`${a.stage2Start}T00:00:00`) : null;
					const aP2End = a.stage2End ? new Date(`${a.stage2End}T00:00:00`) : null;
					const bP1End = b.stage1End ? new Date(`${b.stage1End}T00:00:00`) : null;
					const bBaseStartDate = b.baseStart ? new Date(`${b.baseStart}T00:00:00`) : null;
					if (!aP2Start || !bP1End) continue;

					// Lo2 yêu cầu: khi một sự kiện phía sau (B) chứa ít nhất một máy 220 kV,
					// pha 2 của sự kiện trước (A) phải được dịch tới đúng thời điểm kết thúc pha 1 của B
					// để tránh trùng với lịch mới. Điều này mô phỏng điều chỉnh thủ công đã làm ở Lò 1.
					try {
						const bHighestVoltage = getHighestVoltage(extractSerialDetailsFromEvent(b.evt));
						const shouldAnchorB220 = Boolean(bBaseStartDate && aP2End && bBaseStartDate.getTime() <= aP2End.getTime());
						if (String(bHighestVoltage) === '220' && b.stage1End && shouldAnchorB220) {
							const anchorBPhase1End = new Date(`${b.stage1End}T00:00:00`);
							if (!aP2Start || aP2Start.getTime() < anchorBPhase1End.getTime()) {
								const aHighestVoltage = getHighestVoltage(extractSerialDetailsFromEvent(a.evt));
								const aDurations = VOLTAGE_RULES[aHighestVoltage === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
								const rebuiltAForB220 = buildLo2Timeline(a.baseStart, aDurations, {
									forcedPhase2StartISO: b.stage1End,
									allowForcedWithinMinGap: true
								});
								if (rebuiltAForB220) {
									a.built = rebuiltAForB220;
									a.stage1End = rebuiltAForB220.stages?.find(s => s.id === 'phase1')?.end || null;
									a.stage2Start = rebuiltAForB220.stages?.find(s => s.id === 'phase2')?.start || null;
									a.stage2End = rebuiltAForB220.stages?.find(s => s.id === 'phase2')?.end || null;
									try { console.log('[harmonize-220-anchor] forced A.phase2.start = B.phase1.end', { a: a.evt?.id || a.baseStart, b: b.evt?.id || b.baseStart, anchor: b.stage1End }); } catch (logErr) { /* noop */ }
								}
							}
						}
					} catch (anchorErr) {
						console.warn('[harmonize-220-anchor] failed to force previous phase2', anchorErr);
					}

					// New step: if B's registration/baseStart falls inside A's visible gap
					// (gapStart .. gapEnd) then apply the anchor chain described by the
					// user: align B.phase1.start -> anchor1 (B.baseStart), then
					// B.phase1.end -> anchor2 => force A.phase2.start = anchor2, then
					// A.phase2.end -> anchor3 => force B.phase2.start = anchor3.
					try {
						const aStage1End = a.stage1End ? new Date(`${a.stage1End}T00:00:00`) : null;
						const aStage2Start = a.stage2Start ? new Date(`${a.stage2Start}T00:00:00`) : null;
						if (aStage1End && aStage2Start && b.baseStart) {
							const gapStart = addDays(aStage1End, 1);
							const gapEnd = addDays(aStage2Start, -1);
							const bBaseDate = new Date(`${b.baseStart}T00:00:00`);
							if (bBaseDate.getTime() >= gapStart.getTime() && bBaseDate.getTime() <= gapEnd.getTime()) {
								try { console.log('[harmonize-gapchain] detected B.baseStart inside A gap', { a: a.evt?.id || a.baseStart, b: b.evt?.id || b.baseStart, gapStart: toISO(gapStart), gapEnd: toISO(gapEnd), bBase: b.baseStart }); } catch (e) {}
								// anchor1 = B.baseStart
								const anchor1ISO = toISO(bBaseDate);
								// rebuild B using anchor1 as its baseStart so B.phase1 starts at anchor1
								const bHighest = getHighestVoltage(extractSerialDetailsFromEvent(b.evt));
								const bDur = VOLTAGE_RULES[bHighest === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
								const rebuiltB1 = buildLo2Timeline(anchor1ISO, bDur, { allowForcedWithinMinGap: true });
								if (rebuiltB1) {
									b.built = rebuiltB1;
									b.stage1End = rebuiltB1.stages?.find(s => s.id === 'phase1')?.end || null;
									b.stage2Start = rebuiltB1.stages?.find(s => s.id === 'phase2')?.start || null;
									b.stage2End = rebuiltB1.stages?.find(s => s.id === 'phase2')?.end || null;
									try { console.log('[harmonize-gapchain] rebuilt B with anchor1', b.evt?.id || b.baseStart, { stage1End: b.stage1End, stage2Start: b.stage2Start }); } catch (e) {}
									// anchor2 = B.phase1.end
									const anchor2ISO = b.stage1End || null;
									if (anchor2ISO) {
										// rebuild A so its phase2 starts at anchor2
										const aHighest = getHighestVoltage(extractSerialDetailsFromEvent(a.evt));
										const aDur = VOLTAGE_RULES[aHighest === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
										const rebuiltA = buildLo2Timeline(a.baseStart, aDur, { forcedPhase2StartISO: anchor2ISO, allowForcedWithinMinGap: true });
										if (rebuiltA) {
											a.built = rebuiltA;
											a.stage1End = rebuiltA.stages?.find(s => s.id === 'phase1')?.end || null;
											a.stage2Start = rebuiltA.stages?.find(s => s.id === 'phase2')?.start || null;
											a.stage2End = rebuiltA.stages?.find(s => s.id === 'phase2')?.end || null;
											try { console.log('[harmonize-gapchain] rebuilt A with anchor2', a.evt?.id || a.baseStart, { stage2Start: a.stage2Start, stage2End: a.stage2End }); } catch (e) {}
											// anchor3 = A.phase2.end
											const anchor3ISO = a.stage2End || null;
												// Enforce A.phase1.end = anchor1ISO per requested anchor-chain
												try {
													if (anchor1ISO) {
														const phase1 = a.built.stages && a.built.stages.find(s => s.id === 'phase1');
														if (phase1) {
															phase1.end = anchor1ISO;
															// Recompute any gap segment between phase1 and phase2 for visibility
															const phase2 = a.built.stages && a.built.stages.find(s => s.id === 'phase2');
															if (phase2) {
																const gapStart = addDays(new Date(`${phase1.end}T00:00:00`), 1);
																const gapEnd = addDays(new Date(`${phase2.start}T00:00:00`), -1);
																const visibleGapDays = Math.max(0, getDayOffset(gapStart, gapEnd) + 1);
																if (Array.isArray(a.built.segments)) {
																	a.built.segments = a.built.segments.map(seg => {
																		if (seg.type === 'phase1') {
																			return Object.assign({}, seg, { end: phase1.end });
																		}
																		if (seg.type === 'gap') {
																			return Object.assign({}, seg, { start: toISO(gapStart), end: toISO(gapEnd), days: visibleGapDays, label: `Gap ${visibleGapDays} ngày` });
																		}
																		return seg;
																	});
																}
																a.built.gapDay_start = visibleGapDays > 0 ? toISO(gapStart) : null;
																a.built.gapDay_end = visibleGapDays > 0 ? toISO(gapEnd) : null;
																a.built.totalDays = (a.built.segments || []).reduce((sum, s) => sum + (s.days || 0), 0);
																a.built.start = a.built.stages && a.built.stages[0] && a.built.stages[0].start || a.built.start;
																a.built.end = a.built.stages && a.built.stages[a.built.stages.length - 1] && a.built.stages[a.built.stages.length - 1].end || a.built.end;
																a.stage1End = phase1.end;
															}
														}
													}
												} catch (err) {
													console.warn('[harmonize-gapchain] enforce A.phase1.end failed', err);
												}
												// Persist adjusted A timeline so changes are visible immediately
												try {
													if (a.built) {
														a.evt.timeline = a.built;
														refreshEventMetadata(a.evt);
														updateEvent(schedule.id || state.scheduleId || 'mba', a.evt);
													}
												} catch (err) {
													console.warn('[harmonize-gapchain] persist A adjusted timeline failed', err);
												}
											if (anchor3ISO) {
												// rebuild B final so its phase2 starts at anchor3, keep baseStart anchor1
												const rebuiltBFinal = buildLo2Timeline(anchor1ISO, bDur, { forcedPhase2StartISO: anchor3ISO, allowForcedWithinMinGap: true });
												if (rebuiltBFinal) {
													b.built = rebuiltBFinal;
													b.stage1End = rebuiltBFinal.stages?.find(s => s.id === 'phase1')?.end || null;
													b.stage2Start = rebuiltBFinal.stages?.find(s => s.id === 'phase2')?.start || null;
													b.stage2End = rebuiltBFinal.stages?.find(s => s.id === 'phase2')?.end || null;
													try { console.log('[harmonize-gapchain] rebuilt B final with anchor3', b.evt?.id || b.baseStart, { stage2Start: b.stage2Start, stage2End: b.stage2End }); } catch (e) {}
														// Persist adjusted B timeline so changes are visible immediately
														try {
															if (b.built) {
																b.evt.timeline = b.built;
																refreshEventMetadata(b.evt);
																updateEvent(schedule.id || state.scheduleId || 'mba', b.evt);
															}
														} catch (err) {
															console.warn('[harmonize-gapchain] persist B adjusted timeline failed', err);
														}
                                                    
													// Rebuild and persist A again to ensure A.phase2.start remains equal to anchor2 (B.phase1.end)
													try {
														if (anchor2ISO) {
															const aHighestEnsure = getHighestVoltage(extractSerialDetailsFromEvent(a.evt));
															const aDurEnsure = VOLTAGE_RULES[aHighestEnsure === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
															const rebuiltAEnsure = buildLo2Timeline(a.baseStart, aDurEnsure, { forcedPhase2StartISO: anchor2ISO, allowForcedWithinMinGap: true });
															if (rebuiltAEnsure) {
																a.built = rebuiltAEnsure;
																a.stage1End = rebuiltAEnsure.stages?.find(s => s.id === 'phase1')?.end || null;
																a.stage2Start = rebuiltAEnsure.stages?.find(s => s.id === 'phase2')?.start || null;
																a.stage2End = rebuiltAEnsure.stages?.find(s => s.id === 'phase2')?.end || null;
																// Persist A after ensuring phase2 anchor
																try {
																	a.evt.timeline = a.built;
																	refreshEventMetadata(a.evt);
																	updateEvent(schedule.id || state.scheduleId || 'mba', a.evt);
																} catch (err) {
																	console.warn('[harmonize-gapchain] persist A re-ensure failed', err);
																}
															}
														}
													} catch (err) {
														console.warn('[harmonize-gapchain] re-ensure A rebuild failed', err);
													}
														// Notify calendar to re-render after persisted adjustments
														try {
															if (typeof document !== 'undefined') {
																document.dispatchEvent(new CustomEvent('registration:saved'));
															}
														} catch (err) {
															console.warn('[harmonize-gapchain] dispatch registration:saved failed', err);
														}
														// mark provisional pair as processed by gap-chain so later
														// special-case logic does not undo our anchors by shifting
														// the earlier event forward.
														try {
															if (a && a.evt) a.evt._gapChainApplied = true;
															if (b && b.evt) b.evt._gapChainApplied = true;
														} catch (err) {
															// noop
														}
												}
											}
									}
								}


					// If A.phase2 start would overlap B.phase1 end, shift A forward
					// Move the earlier event's phase2 to start the day AFTER the
					// later event's phase1 end, then skip Sundays. This prevents
					// starting on the same day as the other event's phase1 end
					// (which would still overlap in half-day semantics).
					// Skip shifting earlier event when gap-chain anchors were applied
					if (!(a && a.evt && a.evt._gapChainApplied) && aP2Start.getTime() < bP1End.getTime()) {
						// align earlier phase2 start to the same day (second half) that the later
						// event finishes phase1 so Lo2 can reuse the furnace in SH immediately.
						const forcedAISO = toISO(bP1End);
						try { console.log('[harmonize-special] shifting earlier evt forward to avoid B.phase1 overlap', a.evt.id || a.baseStart, 'phase2->', forcedAISO); } catch (e) {}
						// Rebuild A using A's own configured durations so the
						// shifted phase2/end reflect the event's voltage rules
						// (avoids over-extending A because of globalDurations).
						const aHighest = getHighestVoltage(extractSerialDetailsFromEvent(a.evt));
						const aDur = VOLTAGE_RULES[aHighest === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
						const rebuiltA = buildLo2Timeline(a.baseStart, aDur, { forcedPhase2StartISO: forcedAISO, allowForcedWithinMinGap: true });
						try { console.log('[harmonize-special] rebuilt earlier evt stages', a.evt?.id || a.baseStart, rebuiltA && rebuiltA.stages); } catch (e) {}
						if (rebuiltA) {
							a.built = rebuiltA;
							a.stage1End = rebuiltA.stages?.find(s => s.id === 'phase1')?.end || null;
							a.stage2Start = rebuiltA.stages?.find(s => s.id === 'phase2')?.start || null;
							a.stage2End = rebuiltA.stages?.find(s => s.id === 'phase2')?.end || null;
							try { console.log('[harmonize-special] shifted earlier evt done', a.evt.id || a.baseStart, { stage2Start: a.stage2Start, stage2End: a.stage2End }); } catch (e) {}

							// Rebuild B to start at the same day as A.phase2 end.
							// Do NOT add an extra day here; allow buildTimeline to
							// apply SECOND_HALF/Sunday shifting rules as needed.
							const aP2EndAfter = a.stage2End ? new Date(`${a.stage2End}T00:00:00`) : null;
							if (aP2EndAfter) {
								const forcedBISO = toISO(aP2EndAfter);
								try { console.log('[harmonize-special] rebuilding later evt to start at A.phase2 end (preserve A)', b.evt.id || b.baseStart, 'phase2->', forcedBISO); } catch (e) {}
								// Rebuild B using B's own durations so its stage1/2
								// reflect its configured voltage rather than the global view.
								const bHighestForB2 = getHighestVoltage(extractSerialDetailsFromEvent(b.evt));
								const bDurForB2 = VOLTAGE_RULES[bHighestForB2 === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
								const rebuiltB2 = buildLo2Timeline(b.baseStart, bDurForB2, { forcedPhase2StartISO: forcedBISO, allowForcedWithinMinGap: true });
								if (rebuiltB2) {
									// If buildTimeline did not honor the forcedPhase2StartISO
									// for any reason, override the rebuilt phase2.start to
									// the forced date and recompute dependent fields so
									// the anchor is guaranteed.
									// Only perform override for 110kV events (user requested).
									try {
										if (String(bHighestForB2) === '110') {
											const forcedP2 = forcedBISO;
											const builtP2 = rebuiltB2.stages && rebuiltB2.stages.find(s => s.id === 'phase2');
											if (builtP2 && builtP2.start !== forcedP2) {
												try { console.log('[harmonize-special] overriding rebuiltB2.phase2.start to forced (110kV)', { evt: b.evt.id || b.baseStart, forcedP2, original: builtP2.start }); } catch (e) {}
												// Set start and startHalf to SECOND_HALF (visual convention)
												builtP2.start = forcedP2;
												builtP2.startHalf = SECOND_HALF;
												// Recompute phase2 end based on configured durations
												const phase2Halves = Number(bDurForB2.phase2 || 0);
												const phase2Days = Math.max(1, Math.ceil((phase2Halves + 1) / 2));
												const p2StartDate = new Date(`${builtP2.start}T00:00:00`);
												const p2EndDate = addDays(p2StartDate, phase2Days - 1);
												builtP2.end = toISO(p2EndDate);

												// Update segments array entries
												if (Array.isArray(rebuiltB2.segments)) {
													rebuiltB2.segments = rebuiltB2.segments.map(seg => {
														if (seg.type === 'phase2') {
															return Object.assign({}, seg, { start: builtP2.start, end: builtP2.end, days: phase2Days });
														}
														if (seg.type === 'gap') {
															// recompute gap between phase1.end +1 .. p2.start -1
															const phase1 = rebuiltB2.stages && rebuiltB2.stages.find(s => s.id === 'phase1');
															if (phase1) {
																const gapStart = addDays(new Date(`${phase1.end}T00:00:00`), 1);
																const gapEnd = addDays(new Date(`${builtP2.start}T00:00:00`), -1);
																const visibleGapDays = Math.max(0, getDayOffset(gapStart, gapEnd) + 1);
																return Object.assign({}, seg, { start: toISO(gapStart), end: toISO(gapEnd), days: visibleGapDays, label: `Gap ${visibleGapDays} ngày` });
															}
														}
														return seg;
													});
												}

												// Recompute overall metadata on rebuiltB2
												rebuiltB2.gapDay_start = (rebuiltB2.segments || []).find(s => s.type === 'gap')?.start || null;
												rebuiltB2.gapDay_end = (rebuiltB2.segments || []).find(s => s.type === 'gap')?.end || null;
												rebuiltB2.totalDays = (rebuiltB2.segments || []).reduce((sum, s) => sum + (s.days || 0), 0);
												rebuiltB2.start = rebuiltB2.stages && rebuiltB2.stages[0] && rebuiltB2.stages[0].start || rebuiltB2.start;
												rebuiltB2.end = builtP2.end || rebuiltB2.end;
											}
										}
									} catch (err) {
										console.warn('[harmonize-special] override rebuiltB2 failed', err);
									}

									b.built = rebuiltB2;
									b.stage1End = rebuiltB2.stages?.find(s => s.id === 'phase1')?.end || null;
									b.stage2Start = rebuiltB2.stages?.find(s => s.id === 'phase2')?.start || null;
									b.stage2End = rebuiltB2.stages?.find(s => s.id === 'phase2')?.end || null;
									try { console.log('[harmonize-special] adjusted later evt after preserving A', b.evt.id || b.baseStart, { stage2Start: b.stage2Start, stage2End: b.stage2End }); } catch (e) {}
								} else {
									console.warn('[harmonize-special] rebuild B (preserve A) failed');
								}
							}
						} else {
							console.warn('[harmonize-special] rebuilt earlier(evt) failed');
						}
					}

					// Prefer to adjust later event B backward if possible
					const aP2End = a.stage2End ? new Date(`${a.stage2End}T00:00:00`) : null;
					const bP2Start = b.stage2Start ? new Date(`${b.stage2Start}T00:00:00`) : null;
					if (aP2End && bP2Start && aP2End.getTime() >= bP2Start.getTime()) {
						const forcedISO = toISO(aP2End);
						try { console.log('[harmonize-special] adjusting later evt', b.evt.id || b.baseStart, 'phase2->', forcedISO, 'using earlier.p2.end (prefer-backward)'); } catch (e) {}
						// When adjusting a later event backward, rebuild using the
						// later event's own durations to correctly compute its
						// phase1/phase2 boundaries.
						const bHighestForPrefer = getHighestVoltage(extractSerialDetailsFromEvent(b.evt));
						const bDurPrefer = VOLTAGE_RULES[bHighestForPrefer === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
						const rebuiltB = buildLo2Timeline(b.baseStart, bDurPrefer, { forcedPhase2StartISO: forcedISO, allowForcedWithinMinGap: true });
						try { console.log('[harmonize-special] rebuilt later evt stages', b.evt?.id || b.baseStart, rebuiltB && rebuiltB.stages); } catch (e) {}
						if (rebuiltB) {
							b.built = rebuiltB;
							b.stage1End = rebuiltB.stages?.find(s => s.id === 'phase1')?.end || null;
							b.stage2Start = rebuiltB.stages?.find(s => s.id === 'phase2')?.start || null;
							b.stage2End = rebuiltB.stages?.find(s => s.id === 'phase2')?.end || null;
							try { console.log('[harmonize-special] adjusted later evt done', b.evt.id || b.baseStart); } catch (e) {}
							continue;
						} else {
							try { console.log('[harmonize-special] prefer-backward failed, will consider adjusting earlier evt if necessary'); } catch (e) {}
						}
					}
				}
			}
		}

				// Optional cleanup pass: if an earlier event was pushed forward during
				// provisional adjustments but its ORIGINAL provisional timeline would
				// still not overlap the next event, restore the earlier (original)
				// timeline. This prevents unnecessary lurches like A.phase2 -> 10/11
				// when A could safely remain at 08/11.
				try {
					for (let i = 0; i < provisional.length - 1; i += 1) {
						const cur = provisional[i];
						const next = provisional[i + 1];
						if (!cur || !next || !cur.originalBuilt || !next.built) continue;
						try {
							// Only apply cleanup/restore for earlier events that are 110kV
							const curHighest = getHighestVoltage(extractSerialDetailsFromEvent(cur.evt));
							if (String(curHighest) !== '110') continue;
							const curOrigP2End = cur.originalBuilt.stages && cur.originalBuilt.stages.find(s => s.id === 'phase2')?.end;
							const nextP1Start = next.built.stages && next.built.stages.find(s => s.id === 'phase1')?.start;
							if (curOrigP2End && nextP1Start) {
								const curEnd = new Date(`${curOrigP2End}T00:00:00`).getTime();
								const nextStart = new Date(`${nextP1Start}T00:00:00`).getTime();
								// If original A.phase2 end is <= next.phase1.start then no overlap
								if (curEnd <= nextStart) {
									// restore original built timeline
									cur.built = JSON.parse(JSON.stringify(cur.originalBuilt));
									cur.stage1End = cur.built.stages?.find(s => s.id === 'phase1')?.end || null;
									cur.stage2Start = cur.built.stages?.find(s => s.id === 'phase2')?.start || null;
									cur.stage2End = cur.built.stages?.find(s => s.id === 'phase2')?.end || null;
									try { console.log('[harmonize-cleanup] restored original earlier timeline for', cur.evt?.id || cur.baseStart, { stage2Start: cur.stage2Start, stage2End: cur.stage2End }); } catch (e) {}
								}
							}
						} catch (err) {
							// ignore per-pair failures
						}
					}
				} catch (err) {
					// noop
				}

				// Forward-only chaining: finalize events in chronological order and
				// only use the previous finalized event's phase1 end as the anchor to
				// force the current event's phase2 start when necessary. This avoids
				// broad comparisons to all events which caused cascading pushes.
				let previousFinal = null;
				// track whether any event was saved during harmonization
				let anySaved = false;
				for (const p of provisional) {
					// per-iteration state
					let finalBuilt = p.built || null;
					const provisionalP2StartISO = p.stage2Start || (p.built && p.built.stages?.find(s => s.id === 'phase2')?.start) || null;

					// Allow Lo2 lines to overlap: only anchor when other overlap guards detect conflicts.

			if (previousFinal && previousFinal.stage1End && provisionalP2StartISO) {
				const prevStage1EndDate = new Date(`${previousFinal.stage1End}T00:00:00`);
				const myP2StartDate = new Date(`${provisionalP2StartISO}T00:00:00`);
				// Prefer to anchor to previous event's phase2 END when it would
				// otherwise overlap the current provisional phase2. This causes
				// the later event to start on the same day as the earlier event's
				// phase2 end (SH/FH handling is applied by buildTimeline).
				const prevStage2EndDate = previousFinal.stage2End ? new Date(`${previousFinal.stage2End}T00:00:00`) : null;

				// New: if there is a configured gap (gapDays) between previousFinal.stage2End
				// and the current provisional phase2 start that exactly equals the
				// configured gapDays for this event, remove that gap by forcing the
				// current phase2 to start at the previous phase2 end (effectively
				// eliminating the visible gapDays).
				try {
					if (prevStage2EndDate && myP2StartDate.getTime() > prevStage2EndDate.getTime()) {
						// compute configured gap for this event using its own voltage
						const serialDetails = extractSerialDetailsFromEvent(p.evt);
						const evtHighest = getHighestVoltage(serialDetails);
						const durationKey = evtHighest === '220' ? '220' : '110';
						const configuredGap = Number((VOLTAGE_RULES[durationKey] && VOLTAGE_RULES[durationKey].gapDays) ?? GAP_DAYS);
						// compute day difference
						const ms = 24 * 60 * 60 * 1000;
						const gapBetween = Math.round((myP2StartDate.getTime() - prevStage2EndDate.getTime()) / ms);
						if (gapBetween === configuredGap) {
							try { console.log('[harmonize-special] removing configured gap for', p.evt.id || p.baseStart, 'gapBetween=', gapBetween, 'configuredGap=', configuredGap); } catch (e) {}
							const forcedISO = toISO(prevStage2EndDate);
							try {
								const pHighestRemovedGap = getHighestVoltage(extractSerialDetailsFromEvent(p.evt));
								const pDurRemovedGap = VOLTAGE_RULES[pHighestRemovedGap === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
								const rebuiltB = buildLo2Timeline(p.baseStart, pDurRemovedGap, { forcedPhase2StartISO: forcedISO, allowForcedWithinMinGap: true });
								if (rebuiltB) {
									// apply rebuilt as the finalBuilt for this pass
									// preserve variable used later
									try { console.log('[harmonize-special] rebuilt (removed-gap) stages for', p.evt?.id || p.baseStart, rebuiltB && rebuiltB.stages); } catch (e) {}
									// replace provisional built so final save uses this
									p.built = rebuiltB;
									// ensure finalBuilt used later in this loop reflects the removed-gap rebuild
									finalBuilt = rebuiltB;
									p.stage1End = rebuiltB.stages?.find(s => s.id === 'phase1')?.end || null;
									p.stage2Start = rebuiltB.stages?.find(s => s.id === 'phase2')?.start || null;
									p.stage2End = rebuiltB.stages?.find(s => s.id === 'phase2')?.end || null;
									// also set myP2StartDate so subsequent logic sees the forced start
									myP2StartDate.setTime(new Date(`${p.stage2Start}T00:00:00`).getTime());
								}
							} catch (err) {
								console.warn('[harmonize-special] removed-gap rebuild failed', err);
							}
						}
					}
				} catch (err) {
					// ignore gap-removal failures
				}
						if (prevStage2EndDate && prevStage2EndDate.getTime() >= myP2StartDate.getTime()) {
					const forcedISO = toISO(prevStage2EndDate);
					try {
						try { console.log('[harmonize] forcing phase2 start for', p.evt.id || p.baseStart, 'to', forcedISO, '(previous.stage2End)'); } catch (e) {}
						const pHighestPrevP2 = getHighestVoltage(extractSerialDetailsFromEvent(p.evt));
						const pDurPrevP2 = VOLTAGE_RULES[pHighestPrevP2 === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
						const rebuilt = buildLo2Timeline(p.baseStart, pDurPrevP2, { forcedPhase2StartISO: forcedISO, allowForcedWithinMinGap: true });
						try {
							try { console.log('[harmonize] rebuilt (forced-prevP2) stages for', p.evt?.id || p.baseStart, rebuilt && rebuilt.stages); } catch (e) {}
							if (rebuilt) {
								finalBuilt = rebuilt;
								try { console.log('[harmonize] rebuilt (forced-prevP2) for', p.evt.id || p.baseStart, '->', rebuilt.stages?.find(s => s.id === 'phase2')?.start, rebuilt.stages?.find(s => s.id === 'phase2')?.end); } catch (e) {}
							}
						} catch (err) {
							console.warn('[harmonize] forced rebuild (prevP2) failed', err);
						}
					} catch (err) {
						console.warn('[harmonize] forced rebuild failed for', p.evt.id || p.baseStart, err);
					}
				} else if (prevStage1EndDate.getTime() >= myP2StartDate.getTime()) {
					// Fallback: anchor to previous event's stage1 end (existing behavior)
					const anchor = prevStage1EndDate;
					const forcedISO = toISO(anchor);
					try {
						try { console.log('[harmonize] forcing phase2 start for', p.evt.id || p.baseStart, 'to', forcedISO, '(previous.stage1End)'); } catch (e) {}
						const pHighestPrevP1 = getHighestVoltage(extractSerialDetailsFromEvent(p.evt));
						const pDurPrevP1 = VOLTAGE_RULES[pHighestPrevP1 === '220' ? '220' : '110'] || VOLTAGE_RULES['110'];
						const rebuilt = buildLo2Timeline(p.baseStart, pDurPrevP1, { forcedPhase2StartISO: forcedISO });
						try {
							try { console.log('[harmonize] rebuilt (forced-prevP1) stages for', p.evt?.id || p.baseStart, rebuilt && rebuilt.stages); } catch (e) {}
							if (rebuilt) {
								finalBuilt = rebuilt;
								try { console.log('[harmonize] rebuilt (forced-prevP1) for', p.evt.id || p.baseStart, '->', rebuilt.stages?.find(s => s.id === 'phase2')?.start, rebuilt.stages?.find(s => s.id === 'phase2')?.end); } catch (e) {}
							}
						} catch (err) {
							console.warn('[harmonize] forced rebuild (prevP1) failed', err);
						}
					} catch (err) {
						console.warn('[harmonize] forced rebuild failed for', p.evt.id || p.baseStart, err);
					}
				}
			}

				// finalize and persist
				try {

					// Preserve each event's own voltage durations when saving the
				// finalized timeline. harmonize uses a globalDurations view to
				// compute provisional positions and anchors, but saving should
				// not blindly lengthen an event that only contains 110kV serials.
				try {
					const serialDetails = extractSerialDetailsFromEvent(p.evt);
					const evtHighest = getHighestVoltage(serialDetails);
					const durationKey = evtHighest === '220' ? '220' : '110';
					// If harmonize forced a phase2 start, respect that anchor
					// when rebuilding the per-event timeline so shifts are preserved.
					const forcedP2 = finalBuilt?.stages?.find(s => s.id === 'phase2')?.start || null;
					// When a forced phase2 start was applied during harmonization,
					// ensure the per-event rebuild respects that anchor even if it
					// violates the minimum-gap rule. Pass `allowForcedWithinMinGap: true`
					// so buildTimeline will not clamp the forced date.
					const perEventTimeline = p.baseStart ? buildLo2Timeline(p.baseStart, VOLTAGE_RULES[durationKey], forcedP2 ? { forcedPhase2StartISO: forcedP2, allowForcedWithinMinGap: true } : {}) : finalBuilt;
					p.evt.timeline = perEventTimeline || finalBuilt;
				} catch (inner) {
					// fallback: if anything fails, keep the finalized built timeline
					p.evt.timeline = finalBuilt;
				}
				refreshEventMetadata(p.evt);
					try {
						// Only persist when the timeline actually changed to avoid
						// repeated saves that cause harmonize -> render -> harmonize loops.
						const existingTimeline = p.evt.timeline || null;
						const newTimeline = p.baseStart ? buildLo2Timeline(p.baseStart, VOLTAGE_RULES[(getHighestVoltage(extractSerialDetailsFromEvent(p.evt)) === '220' ? '220' : '110')], (finalBuilt && finalBuilt.stages?.find(s=>s.id==='phase2')?.start) ? { forcedPhase2StartISO: finalBuilt.stages.find(s=>s.id==='phase2').start, allowForcedWithinMinGap: true } : {}) : finalBuilt;
						const oldStr = existingTimeline ? JSON.stringify(existingTimeline) : null;
						const newStr = newTimeline ? JSON.stringify(newTimeline) : null;
						if (oldStr !== newStr) {
							p.evt.timeline = newTimeline || finalBuilt;
							refreshEventMetadata(p.evt);
							const saved = updateEvent(scheduleId || schedule.id || 'mba', p.evt);
							try { console.log('[harmonize] updated evt', p.evt.id, 'saved=', saved && saved.id); } catch (e) {}
							if (saved) anySaved = true;
						} else {
							// no change: keep existing timeline and metadata
							p.evt.timeline = existingTimeline;
							refreshEventMetadata(p.evt);
						}
					} catch (err) { console.warn('[harmonize] save/check failed', err); }
			} catch (err) {
				console.warn('[harmonize] save final failed', err);
			}

			// set previousFinal to the timeline that was actually persisted so
			// later events anchor against the real (110 kV) durations instead of
			// the provisional global (220 kV) view. This prevents B.phase2 from
			// being forced to the longer 220 timeline when A only needs 110 logic.
			const finalTimeline = p.evt.timeline || finalBuilt;
			const finalStage1End = finalTimeline?.stages?.find(s => s.id === 'phase1')?.end || null;
			const finalStage2End = finalTimeline?.stages?.find(s => s.id === 'phase2')?.end || null;
			previousFinal = { evt: p.evt, stage1End: finalStage1End, stage2End: finalStage2End };
		}
		// If any per-event updates occurred during harmonization, dispatch a
		// single `registration:saved` event so the calendar can re-render once.
		try {
			if (typeof document !== 'undefined' && typeof anySaved !== 'undefined' && anySaved) {
				try { console.log('[harmonize] dispatching registration:saved (anySaved=true)'); } catch (e) {}
				document.dispatchEvent(new CustomEvent('registration:saved'));
			}
		} catch (e) { /* ignore dispatch errors */ }
		} catch (e) { /* harmonize-gapchain inner try catch (auto-inserted) */ }
		}
		}
		}
		} catch (err) {
			console.warn('harmonizeLo2Timelines failed', err);
		}

}

function shiftLo2PeersForUpgradedVoltage({ scheduleId, upgradedEvent }) {
	if (!scheduleId || !upgradedEvent) {
		return;
	}
	const schedule = getScheduleById(scheduleId);
	if (!schedule || !Array.isArray(schedule.events)) {
		return;
	}
	const baseStartISO = upgradedEvent.timeline?.start || upgradedEvent.date || null;
	const anchorISO = upgradedEvent.timeline?.stages?.find(stage => stage.id === 'phase1')?.end || null;
	if (!baseStartISO || !anchorISO) {
		return;
	}
	const originalBaseISO = upgradedEvent.originalTimeline?.start || null;
	const originalPhase2Start = upgradedEvent.originalTimeline?.stages?.find(stage => stage.id === 'phase2')?.start || null;
	(schedule.events || []).forEach(evt => {
		if (!evt || evt.id === upgradedEvent.id) {
			return;
		}
		if (!isLo2Furnace(evt.furnace || evt.furnaceLabel || '')) {
			return;
		}
		const evtBase = evt.timeline?.start || evt.date || null;
		if (!evtBase || evtBase !== baseStartISO) {
			return;
		}
		const voltageKey = getHighestVoltage(extractSerialDetailsFromEvent(evt));
		if (voltageKey === '220') {
			return;
		}
		if (originalBaseISO && originalBaseISO !== baseStartISO) {
			return;
		}
		const prevPhase2Start = evt.timeline?.stages?.find(stage => stage.id === 'phase2')?.start || null;
		if (prevPhase2Start && originalPhase2Start && prevPhase2Start === originalPhase2Start) {
			return;
		}
		try {
			rebuildEventPhase2Start(scheduleId, evt, anchorISO, { allowForcedWithinMinGap: true, forceExactPhase2Start: true });
		} catch (err) {
			console.warn('[shiftLo2Peers] failed to rebuild peer phase2', err);
		}
	});

	// New rule: when a Lo2 line upgrades from 110 kV to 220 kV, ensure the
	// immediately previous Lo2 event (if any) shifts its phase2 start to the
	// upgraded event's phase1 end so the furnace hands off in the same SH day.
	if (anchorISO) {
		try {
			const anchorDay = isoToDayDate(anchorISO);
			const upgradedBaseDay = isoToDayDate(baseStartISO);
			if (anchorDay && upgradedBaseDay) {
				const lo2EventsSorted = (schedule.events || [])
					.filter(evt => evt && isLo2Furnace(evt.furnace || evt.furnaceLabel || ''))
					.sort((a, b) => {
						const aStart = getEventBaseStartDate(a);
						const bStart = getEventBaseStartDate(b);
						if (!aStart && !bStart) return 0;
						if (!aStart) return -1;
						if (!bStart) return 1;
						return aStart.getTime() - bStart.getTime();
					});
				let previousLo2 = null;
				for (const evt of lo2EventsSorted) {
					if (!evt) continue;
					if (evt.id === upgradedEvent.id) {
						break;
					}
					const evtStart = getEventBaseStartDate(evt);
					if (!evtStart) continue;
					if (evtStart.getTime() >= upgradedBaseDay.getTime()) {
						break;
					}
					previousLo2 = evt;
				}
				if (previousLo2 && previousLo2.id !== upgradedEvent.id) {
					const prevPhase2 = previousLo2.timeline?.stages?.find(stage => stage.id === 'phase2');
					const prevPhase2StartDay = prevPhase2?.start ? isoToDayDate(prevPhase2.start) : null;
					const prevPhase2EndDay = prevPhase2?.end ? isoToDayDate(prevPhase2.end) : null;
					const upgradedStartDay = isoToDayDate(baseStartISO);
					const previousFinishedBeforeUpgrade = prevPhase2EndDay && upgradedStartDay && prevPhase2EndDay.getTime() < upgradedStartDay.getTime();
					const alreadyPastAnchor = prevPhase2StartDay && anchorDay && prevPhase2StartDay.getTime() >= anchorDay.getTime();
					const shouldRealignPrevious = prevPhase2 && anchorDay && !previousFinishedBeforeUpgrade && !alreadyPastAnchor;
					if (shouldRealignPrevious) {
						try {
							rebuildEventPhase2Start(scheduleId, previousLo2, anchorISO, { forceExactPhase2Start: true });
						} catch (err) {
							console.warn('[shiftLo2Peers] failed to rebuild previous Lo2 phase2', err);
						}
					}
				}
			}
		} catch (err) {
			console.warn('[shiftLo2Peers] previous-event shift failed', err);
		}
	}
}

// Demo helper: create two events matching the reported scenario and run harmonize
function harmonizeDemo() {
	try { console.log('[harmonize-demo] clearing persisted data for clean run'); clearPersistedData(); } catch (e) {}
	const scheduleId = 'mba';
	try {
		// Event A: start 2025-11-03, contains a 220 serial (so uses 220 rules)
		const aTimeline = buildTimeline('2025-11-03', VOLTAGE_RULES['220'], { allowSundaySecondHalfStart: true });
		const a = saveRegistration(scheduleId, {
			date: '2025-11-03',
			furnaceLabel: 'Lò 2',
			registrant: 'Hoàng Xuân Đức',
			quantity: 2,
			serials: ['1 (110)', '2 (220)'],
			serialDetails: [{ serial: '1', voltageValue: '110', voltageLabel: '110 kV', lineIndex: 1 }, { serial: '2', voltageValue: '220', voltageLabel: '220 kV', lineIndex: 2 }],
			voltageLabel: '220 kV',
			status: DEFAULT_STATUS,
			timeline: aTimeline
		});

		// Event B: start 2025-11-06 single 220
		const bTimeline = buildTimeline('2025-11-06', VOLTAGE_RULES['220'], { allowSundaySecondHalfStart: true });
		const b = saveRegistration(scheduleId, {
			date: '2025-11-06',
			furnaceLabel: 'Lò 2',
			registrant: 'User B',
			quantity: 1,
			serials: ['3 (220)'],
			serialDetails: [{ serial: '3', voltageValue: '220', voltageLabel: '220 kV', lineIndex: 1 }],
			voltageLabel: '220 kV',
			status: DEFAULT_STATUS,
			timeline: bTimeline
		});

		console.log('[harmonize-demo] before harmonize', getScheduleById(scheduleId).events.map(e => ({ id: e.id, start: e.timeline?.start, stages: e.timeline?.stages })));
		harmonizeLo2Timelines(scheduleId);
		console.log('[harmonize-demo] after harmonize', getScheduleById(scheduleId).events.map(e => ({ id: e.id, start: e.timeline?.start, stages: e.timeline?.stages })));
	} catch (err) {
		console.warn('[harmonize-demo] failed', err);
	}
}
try {
	if (typeof window !== 'undefined') {
		window.__harmonizeDemo = harmonizeDemo;
		window.__harmonizeLo2Timelines = harmonizeLo2Timelines;
			window.__dumpLo2SavedTimelines = function(scheduleId = 'mba') {
				try {
					const schedule = getScheduleById(scheduleId);
					if (!schedule) { console.log('[dump] schedule not found', scheduleId); return null; }
					console.log(`[dump] schedule ${scheduleId} events count=`, (schedule.events || []).length);
					(schedule.events || []).forEach(evt => {
						if (!evt) return;
						const isLo2 = isLo2Furnace(evt.furnace || evt.furnaceLabel || '');
						if (!isLo2) return;
						console.groupCollapsed(`[dump] evt ${evt.id} date=${evt.date} furnace=${evt.furnace || evt.furnaceLabel}`);
						try {
							console.log('serialDetails', evt.serialDetails);
							console.log('timeline', evt.timeline);
							console.log('timeline.stages', evt.timeline && evt.timeline.stages ? evt.timeline.stages.map(s => ({ id: s.id, start: s.start, end: s.end, startHalf: s.startHalf, durationDays: s.durationDays })) : null);
						} catch (e) { console.warn('[dump] failed to read evt', evt && evt.id, e); }
						console.groupEnd();
					});
					return schedule.events || [];
				} catch (err) {
					console.warn('[dump] __dumpLo2SavedTimelines failed', err);
					return null;
				}
			};
	}
} catch (e) {
	// noop
}

// -------- Auto placeholder helpers --------
function updateAutoLo2PlaceholderState() {
	if (!furnaceSelect || !isLo2Furnace(furnaceSelect.value) || state.linkedEvent && !state.autoPlaceholderActive) {
		disableAutoLo2PlaceholderMode();
		return;
	}
	const targetDate = dateInput?.value || state.currentDateISO;
	const candidate = findLo2PlaceholderCandidate(targetDate);
	if (candidate) {
		enableAutoLo2PlaceholderMode(candidate);
	} else {
		disableAutoLo2PlaceholderMode();
	}
}

function enableAutoLo2PlaceholderMode(candidateEvent) {
	if (!candidateEvent) {
		return;
	}
	state.autoPlaceholderActive = true;
	state.linkedEvent = { eventId: candidateEvent.id, scheduleId: state.scheduleId || "mba" };
	if (!state.hiddenQuantityValues.has("2")) {
		state.hiddenQuantityValues.add("2");
		state.autoPlaceholderInjectedQuantity = true;
	}
	if (quantitySelect && quantitySelect.value !== "1") {
		quantitySelect.value = "1";
		handleQuantityChange();
	}
	applyQuantityAvailability();
}

function disableAutoLo2PlaceholderMode() {
	if (!state.autoPlaceholderActive) {
		return;
	}
	state.autoPlaceholderActive = false;
	if (state.autoPlaceholderInjectedQuantity) {
		state.hiddenQuantityValues.delete("2");
		state.autoPlaceholderInjectedQuantity = false;
	}
	state.linkedEvent = null;
}

function findLo2PlaceholderCandidate(dateISO) {
	if (!dateISO) {
		return null;
	}
	let schedule;
	try {
		schedule = getScheduleById(state.scheduleId || "mba");
	} catch {
		return null;
	}
	try {
		const events = Array.isArray(schedule.events) ? schedule.events : [];
		for (const event of events) {
			if (!event) continue;
			if (event.date !== dateISO) continue;
			const furnaceLabel = event.furnace || event.furnaceLabel || "";
			if (!isLo2Furnace(furnaceLabel)) continue;
			if (getLo2RegisteredLineCount(event) >= 2) continue;
			return event;
		}
		return null;
	} catch (err) {
		return null;
	}
}

function getLo2RegisteredLineCount(event) {
	const serialDetailsCount = Array.isArray(event.serialDetails) ? event.serialDetails.length : 0;
	const serialSummaryCount = Array.isArray(event.serials) ? event.serials.length : 0;
	const quantity = Number(event.quantity) || 0;
	return Math.min(2, Math.max(serialDetailsCount, serialSummaryCount, quantity));
}

// -------- Serial/timeline helpers reused by placeholder merges --------
function mergeSerialDetailLists(existing, incoming) {
	const result = [];
	const seenSerials = new Set();
	const append = detail => {
		if (!detail || !detail.serial || seenSerials.has(detail.serial)) {
			return;
		}
		seenSerials.add(detail.serial);
		result.push(detail);
	};
	existing.forEach(append);
	incoming.forEach(append);
	return result;
}

function normalizeMergedSerialDetail(detail = {}) {
	const serial = (detail.serial || "").trim();
	if (!serial) {
		return null;
	}
	const voltageValue = (detail.voltageValue || "").trim();
	const statusLabel = detail.status || detail.lineStatus || DEFAULT_STATUS;
	const historyEntries = Array.isArray(detail.history) && detail.history.length
		? detail.history.map(entry => ({
			status: entry.status || statusLabel,
			actor: entry.actor || detail.registrant || "",
			timestamp: entry.timestamp || new Date().toISOString()
		}))
		: [createLineHistoryEntry(statusLabel, detail.registrant || "")];
	return {
		serial,
		voltageValue,
		voltageLabel: detail.voltageLabel || formatVoltageLabelFromValue(voltageValue),
		registrant: detail.registrant || "",
		lineIndex: detail.lineIndex || null,
		status: statusLabel,
		history: historyEntries
	};
}

function formatSerialSummary(detail = {}) {
	const serial = (detail.serial || "").trim();
	const voltageLabel = detail.voltageLabel || (detail.voltageValue ? `${detail.voltageValue} kV` : "");
	if (!serial) return "";
	return voltageLabel ? `${serial} (${voltageLabel})` : serial;
}

function formatVoltageLabelFromValue(value) {
	return value ? `${value} kV` : "";
}

function extractSerialDetailsFromEvent(event = {}) {
	const normalizedDetails = Array.isArray(event.serialDetails)
		? event.serialDetails.map(normalizeMergedSerialDetail).filter(Boolean)
		: [];
	if (normalizedDetails.length) {
		return normalizedDetails;
	}
	const summaryList = Array.isArray(event.serials) ? event.serials : [];
	return summaryList
		.map(parseSerialSummary)
		.map(normalizeMergedSerialDetail)
		.filter(Boolean);
}

function parseSerialSummary(text = "") {
	const match = text.match(/^(.*?)\s*\(([^)]+)\)/);
	const serial = (match ? match[1] : text).trim();
	const voltageLabel = match ? match[2].trim() : "";
	return {
		serial,
		voltageValue: deriveVoltageValue(voltageLabel),
		voltageLabel
	};
}

export function normalizeStatusKey(value = "") {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/gi, "d")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

export function deriveLo2EventStatus(serialDetails = [], fallback = DEFAULT_STATUS) {
	if (!Array.isArray(serialDetails) || !serialDetails.length) {
		return fallback || DEFAULT_STATUS;
	}
	let hasDelay = false;
	let bestIndex = Math.max(0, STATUS_FLOW.indexOf(fallback || DEFAULT_STATUS));
	serialDetails.forEach(detail => {
		const variant = normalizeStatusKey(detail?.status || "");
		if (variant === "delay") {
			hasDelay = true;
			return;
		}
		const idx = STATUS_FLOW.indexOf(detail?.status || "");
		if (idx > bestIndex) {
			bestIndex = idx;
		}
	});
	if (hasDelay) {
		return DELAY_LABEL;
	}
	return STATUS_FLOW[bestIndex] || fallback || DEFAULT_STATUS;
}

function deriveVoltageValue(label = "") {
	const match = label.match(/(\d+)/);
	return match ? match[1] : "";
}

function stripTime(value) {
	const date = new Date(value);
	date.setHours(0, 0, 0, 0);
	return date;
}

function refreshEventMetadata(event) {
	if (!event) {
		return;
	}
	const furnaceLabel = event.furnace || event.furnaceLabel || "";
	const registrant = event.registrant || "";
	const serials = Array.isArray(event.serials) ? event.serials : [];
	const status = event.status || DEFAULT_STATUS;
	const timeline = event.timeline;
	if (!timeline) {
		return;
	}
	event.slots = event.quantity || serials.length;
	event.summary = createSummary({
		furnaceLabel,
		registrant,
		quantity: event.quantity || serials.length,
		serials,
		voltageLabel: event.voltageLabel || "",
		status,
		timeline
	});

	// (special-case logic moved into harmonizeLo2Timelines to operate on
	// provisional timelines where the data is available)
	event.tooltip = createTooltip({
		furnaceLabel,
		registrant,
		quantity: event.quantity || serials.length,
		serials,
		voltageLabel: event.voltageLabel || "",
		status,
		timeline
	});
}


function rebuildEventPhase2Start(scheduleId, event, forcedPhase2StartISO, opts = {}) {
	if (!event || !forcedPhase2StartISO) {
		return null;
	}
	const highestVoltage = getHighestVoltage(extractSerialDetailsFromEvent(event));
	const rulesKey = highestVoltage === "220" ? "220" : "110";
	const durationRules = VOLTAGE_RULES[rulesKey] || VOLTAGE_RULES["110"];
	const baseStartISO = event.timeline?.start || event.date;
	if (!baseStartISO || !durationRules) {
		return null;
	}
	const furnaceLabel = event.furnace || event.furnaceLabel || "";
	const allowSundayStarts = isLo1Furnace(furnaceLabel) || isLo2Furnace(furnaceLabel);
	const baseOptions = {
		forcedPhase2StartISO,
		allowForcedWithinMinGap: opts.allowForcedWithinMinGap !== undefined ? opts.allowForcedWithinMinGap : true,
		forceExactPhase2Start: opts.forceExactPhase2Start !== undefined ? opts.forceExactPhase2Start : true
	};
	const timelineOptions = allowSundayStarts ? { ...baseOptions, allowSundaySecondHalfStart: true } : baseOptions;
	const rebuilt = buildTimeline(baseStartISO, durationRules, timelineOptions);
	if (!rebuilt) {
		return null;
	}
	event.timeline = rebuilt;
	refreshEventMetadata(event);
	try {
		updateEvent(scheduleId || state.scheduleId || "mba", event);
	} catch (err) {
		console.warn('rebuildEventPhase2Start: updateEvent failed', err);
	}
	return rebuilt;
}

function resolvePhaseAnchorsForRegistration({ scheduleId, furnaceValue, newTimeline, startISO, newVoltage }) {
	const result = { forcedPhase2StartISO: null, updatedExisting: false };
	if (!newTimeline || !Array.isArray(newTimeline.stages)) {
		return result;
	}
	if (!isLo1Furnace(furnaceValue || "")) {
		return result;
	}
	let schedule;
	try {
		schedule = getScheduleById(scheduleId || "mba");
	} catch (err) {
		console.warn('resolvePhaseAnchorsForRegistration: schedule lookup failed', err);
		return result;
	}
	if (!schedule || !Array.isArray(schedule.events)) {
		return result;
	}
	const targetFurnaceKey = normalizeFurnaceKey(furnaceValue || "");
	if (!targetFurnaceKey) {
		return result;
	}
	const baseStartDate = isoToDayDate(startISO);
	const newPhase1 = newTimeline.stages.find(stage => stage.id === "phase1");
	if (!baseStartDate || !newPhase1 || !newPhase1.end) {
		return result;
	}
	const anchorISO = newPhase1.end;
	const newStartDay = startISO ? isoToDayDate(startISO) : null;
	const sameFurnaceEvents = (schedule.events || [])
		.filter(evt => evt && normalizeFurnaceKey(evt.furnace || evt.furnaceLabel || "") === targetFurnaceKey)
		.sort((a, b) => {
			const aStart = getEventBaseStartDate(a);
			const bStart = getEventBaseStartDate(b);
			if (!aStart && !bStart) return 0;
			if (!aStart) return -1;
			if (!bStart) return 1;
			return aStart.getTime() - bStart.getTime();
		});
	let previousEvent = null;
	for (let i = sameFurnaceEvents.length - 1; i >= 0; i -= 1) {
		const evtStart = getEventBaseStartDate(sameFurnaceEvents[i]);
		if (evtStart && evtStart.getTime() < baseStartDate.getTime()) {
			previousEvent = sameFurnaceEvents[i];
			break;
		}
	}
	if (!previousEvent || String(newVoltage) !== "220") {
		return result;
	}
	const prevPhase2 = previousEvent.timeline?.stages?.find(stage => stage.id === "phase2");
	const anchorDay = isoToDayDate(anchorISO);
	const prevPhase2StartDay = prevPhase2?.start ? isoToDayDate(prevPhase2.start) : null;
	const prevPhase2EndDay = prevPhase2?.end ? isoToDayDate(prevPhase2.end) : null;
	if (!prevPhase2 || !anchorDay || !newStartDay || (prevPhase2StartDay && prevPhase2StartDay.getTime() >= anchorDay.getTime())) {
		return result;
	}
	// Skip anchoring when the previous event already finished before the new
	// registration begins; this matches the expected 110kV behavior.
	if (prevPhase2EndDay && prevPhase2EndDay.getTime() < newStartDay.getTime()) {
		return result;
	}
	const rebuilt = rebuildEventPhase2Start(scheduleId, previousEvent, anchorISO, { forceExactPhase2Start: true });
	if (rebuilt) {
		result.updatedExisting = true;
		const rebuiltPhase2 = rebuilt.stages?.find(stage => stage.id === "phase2");
		if (rebuiltPhase2?.end) {
			result.forcedPhase2StartISO = rebuiltPhase2.end;
		}
	}
	return result;
}

function isoToDayDate(iso) {
	if (!iso) {
		return null;
	}
	try {
		return stripTime(new Date(`${iso}T00:00:00`));
	} catch (err) {
		return null;
	}
}

function getEventBaseStartDate(evt) {
	if (!evt) {
		return null;
	}
	const baseISO = evt.timeline?.start || evt.date;
	return baseISO ? isoToDayDate(baseISO) : null;
}

function resolveLo2AnchorsForUpgrade({ scheduleId, targetEventId, furnaceValue, baseTimeline }) {
	if (!scheduleId || !targetEventId || !baseTimeline || !Array.isArray(baseTimeline.stages)) {
		return null;
	}
	const result = { forcedPhase2StartISO: null };
	const furnaceKey = normalizeFurnaceKey(furnaceValue || "");
	if (!furnaceKey) {
		return result;
	}
	let schedule;
	try {
		schedule = getScheduleById(scheduleId);
	} catch (err) {
		console.warn('resolveLo2AnchorsForUpgrade: schedule lookup failed', err);
		return result;
	}
	if (!schedule || !Array.isArray(schedule.events)) {
		return result;
	}
	const sorted = (schedule.events || [])
		.filter(evt => normalizeFurnaceKey(evt.furnace || evt.furnaceLabel || "") === furnaceKey)
		.sort((a, b) => {
			const aStart = getEventBaseStartDate(a);
			const bStart = getEventBaseStartDate(b);
			if (!aStart && !bStart) return 0;
			if (!aStart) return -1;
			if (!bStart) return 1;
			return aStart.getTime() - bStart.getTime();
		});
	if (!sorted.length) {
		return result;
	}
	const currentIndex = sorted.findIndex(evt => evt && evt.id === targetEventId);
	if (currentIndex <= 0) {
		return result;
	}
	const previousEvent = sorted[currentIndex - 1];
	if (!previousEvent) {
		return result;
	}
	const newPhase1 = baseTimeline.stages.find(stage => stage && stage.id === 'phase1');
	if (!newPhase1 || !newPhase1.end) {
		return result;
	}
	const prevPhase2Stage = previousEvent.timeline?.stages?.find(stage => stage && stage.id === 'phase2');
	const prevPhase2StartDay = prevPhase2Stage?.start ? isoToDayDate(prevPhase2Stage.start) : null;
	const prevPhase2EndDay = prevPhase2Stage?.end ? isoToDayDate(prevPhase2Stage.end) : null;
	const newStartISO = newPhase1.start || baseTimeline.start || null;
	const newStartDay = newStartISO ? isoToDayDate(newStartISO) : null;
	const anchorDay = isoToDayDate(newPhase1.end);
	if (!prevPhase2Stage || !newStartDay || !anchorDay) {
		return result;
	}
	if (prevPhase2EndDay && prevPhase2EndDay.getTime() < newStartDay.getTime()) {
		return result;
	}
	if (prevPhase2StartDay && prevPhase2StartDay.getTime() >= anchorDay.getTime()) {
		return result;
	}
	const alreadyAligned = prevPhase2Stage?.start === newPhase1.end;
	let updatedPreviousTimeline = null;
	if (!alreadyAligned) {
		try {
			updatedPreviousTimeline = rebuildEventPhase2Start(scheduleId, previousEvent, newPhase1.end, { forceExactPhase2Start: true });
		} catch (err) {
			console.warn('resolveLo2AnchorsForUpgrade: rebuildEventPhase2Start failed', err);
		}
	}
	const timelineSource = updatedPreviousTimeline || previousEvent.timeline;
	const prevPhase2 = timelineSource?.stages?.find(stage => stage && stage.id === 'phase2');
	if (!prevPhase2 || !prevPhase2.end) {
		return result;
	}
	result.forcedPhase2StartISO = prevPhase2.end;
	return result;
}


