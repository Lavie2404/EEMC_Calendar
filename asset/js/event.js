import {
	getDefaultScheduleId,
	getEventsByDate,
	getScheduleById,
	getSchedules,
	getSlotUsageForMonth,
	getEventById
} from "./data_store.js";
import { clearCurrentUser, ensureAuthenticated, getCurrentUser } from "./role.js";
import { openRegisterModal, setupRegisterModal, harmonizeLo2Timelines, buildTimeline, VOLTAGE_RULES, normalizeStatusKey } from "./modal_register.js";
import { openEditModal, setupEditModal } from "./modal_edit.js";
import { openLineDetailModal, setupLineDetailModal } from "./modal_line.js";
import { FIRST_HALF, SECOND_HALF, HALF_COLUMNS_PER_WEEK, firstHalfColForDayIndex, secondHalfColForDayIndex, clampHalfCol } from "./halves.js";
import { isLo2Furnace, isLo1Furnace, normalizeFurnaceLabel } from "./furnace.js";

// Default render delay (ms) used when re-rendering after a save to avoid
// measurement/layout races. Can be overridden at runtime via
// `window.TIMELINE_RENDER_DELAY_MS = <ms>` in the console.
if (typeof window !== 'undefined' && typeof window.TIMELINE_RENDER_DELAY_MS === 'undefined') {
	window.TIMELINE_RENDER_DELAY_MS = 300;
}

const state = {
	activeScheduleId: getDefaultScheduleId(),
	viewDate: null
};

let addEventButtonTemplate = null;

const weekdayLabels = [
	"Thứ hai",
	"Thứ ba",
	"Thứ tư",
	"Thứ năm",
	"Thứ sáu",
	"Thứ bảy",
	"Chủ nhật"
];

document.addEventListener("DOMContentLoaded", () => {
	ensureAuthenticated();
	initializeState();
	hydrateUserPanel();
	setupRegisterModal();
	setupEditModal();
	setupLineDetailModal();
	renderScheduleNav();
	bindToolbar();
	renderCalendar();

	document.addEventListener("registration:saved", () => {
		// Allow configurable delay to accommodate slow layout/paint on some devices.
		// If window.TIMELINE_RENDER_DELAY_MS is set to a positive number we'll use it;
		// otherwise fall back to double rAF for a lightweight deferral.
		try {
			const delay = (typeof window !== 'undefined' && Number(window.TIMELINE_RENDER_DELAY_MS)) ? Number(window.TIMELINE_RENDER_DELAY_MS) : 0;
			if (delay > 0) {
				try {
					console.debug('[timeline] using render delay (ms):', delay);
				} catch (e) {}
				setTimeout(() => {
					try { renderCalendar(); } catch (e) { console.error(e); }
				}, delay);
			} else {
				try { requestAnimationFrame(() => requestAnimationFrame(renderCalendar)); } catch (e) { setTimeout(renderCalendar, 0); }
			}
		} catch (e) {
			setTimeout(renderCalendar, 0);
		}
	});

	// Also update calendar immediately when a registration is deleted.
	// Use same delay configuration as saves so measurements are stable.
	document.addEventListener("registration:deleted", () => {
		try {
			const delay = (typeof window !== 'undefined' && Number(window.TIMELINE_RENDER_DELAY_MS)) ? Number(window.TIMELINE_RENDER_DELAY_MS) : 0;
			if (delay > 0) {
				setTimeout(() => { try { renderCalendar(); } catch (e) { console.error(e); } }, delay);
			} else {
				try { requestAnimationFrame(() => requestAnimationFrame(renderCalendar)); } catch (e) { setTimeout(renderCalendar, 0); }
			}
		} catch (e) {
			setTimeout(renderCalendar, 0);
		}
	});
});

function initializeState() {
	const today = new Date();
	state.viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
}

function hydrateUserPanel() {
	const { name, role } = getCurrentUser();
	const nameEl = document.getElementById("currentUserName");
	const roleEl = document.getElementById("currentUserRole");
	if (nameEl) {
		nameEl.textContent = name;
	}
	if (roleEl) {
		roleEl.textContent = role;
	}
	const logoutBtn = document.getElementById("logoutBtn");
	if (logoutBtn) {
		logoutBtn.addEventListener("click", () => {
			clearCurrentUser();
			window.location.href = "login.html";
		});
	}
}

function renderScheduleNav() {
	const nav = document.getElementById("scheduleNav");
	if (!nav) {
		return;
	}
	const schedules = getSchedules();
	if (!schedules.find(s => s.id === state.activeScheduleId)) {
		state.activeScheduleId = schedules[0]?.id ?? state.activeScheduleId;
	}
	nav.innerHTML = "";
	schedules.forEach(schedule => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "sidebar__item";
		button.dataset.schedule = schedule.id;
		button.textContent = schedule.name;
		if (schedule.id === state.activeScheduleId) {
			button.classList.add("is-active");
		}
		button.addEventListener("click", () => {
			if (state.activeScheduleId === schedule.id) {
				return;
			}
			state.activeScheduleId = schedule.id;
			updateNavSelection(nav, schedule.id);
			renderCalendar();
		});
		nav.appendChild(button);
	});
}

function updateNavSelection(nav, scheduleId) {
	nav.querySelectorAll(".sidebar__item").forEach(btn => {
		btn.classList.toggle("is-active", btn.dataset.schedule === scheduleId);
	});
}

function bindToolbar() {
	document.querySelectorAll("[data-nav]").forEach(button => {
		button.addEventListener("click", () => handleNavigation(button.dataset.nav));
	});
}

function handleNavigation(action) {
	const view = state.viewDate;
	if (!view) {
		return;
	}
	switch (action) {
		case "prev":
			state.viewDate = new Date(view.getFullYear(), view.getMonth() - 1, 1);
			break;
		case "next":
			state.viewDate = new Date(view.getFullYear(), view.getMonth() + 1, 1);
			break;
		case "today":
		default:
			const today = new Date();
			state.viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
			break;
	}
	renderCalendar();
}

function renderCalendar() {
	let schedule;
	try {
		schedule = getScheduleById(state.activeScheduleId);
	} catch (error) {
		const grid = document.getElementById("calendarGrid");
		if (grid) {
			grid.innerHTML = "<p class=\"calendar-empty-message\">Chưa có dữ liệu lịch.</p>";
		}
		console.error(error);
		return;
	}
	const year = state.viewDate.getFullYear();
	const month = state.viewDate.getMonth();

	// Ensure Lo2 timelines are harmonized on initial render so when two
	// machines exist the timeline durations reflect the highest voltage
	// (e.g., 220 kV). This adjusts any persisted events that may still
	// be using shorter durations.
	try {
		harmonizeLo2Timelines(schedule.id);
	} catch (e) {
		// ignore harmonize failures; rendering proceeds with existing data
	}

	updateCalendarHeader(schedule, year, month);
	updateUsageChip(schedule, year, month);
	buildCalendarGrid(schedule, year, month);
}

function updateCalendarHeader(schedule, year, month) {
	const scheduleTitleEl = document.getElementById("scheduleTitle");
	const monthLabelEl = document.getElementById("calendarMonthLabel");
	const currentDayEl = document.getElementById("calendarCurrentDay");

	if (scheduleTitleEl) {
		scheduleTitleEl.textContent = schedule.name;
	}
	if (monthLabelEl) {
		monthLabelEl.textContent = formatMonthLabel(year, month);
	}
	if (currentDayEl) {
		currentDayEl.textContent = formatFullDate(new Date());
	}
}

function updateUsageChip(schedule, year, month) {
	const usageCountEl220 = document.getElementById("slotUsageCount220");
	const usageCountEl110 = document.getElementById("slotUsageCount110");

	// Compute slot usage per voltage following rules:
	// - Lò 1: each start phase1 counts as 1 slot
	// - Lò 2: each start phase1 counts as 2 slots
	// - "Used" slots exclude events in plan (kehoach) or delay (delay)
	// - If totalSlots === 0 we display 0, otherwise display used/total
	const events = getEventsByDate(schedule.id, year, month);
	const eventsArr = Object.values(events).flat();

	const totals = { "110": { used: 0, total: 0 }, "220": { used: 0, total: 0 } };

	eventsArr.forEach(evt => {
		if (!evt || evt.type !== 'registration') return;
		const hasStart = Boolean(evt.timeline && Array.isArray(evt.timeline.stages) && evt.timeline.stages.length > 0);
		if (!hasStart) return;

		const voltageSlots = collectVoltageSlots(evt);
		if (!voltageSlots.length) {
			return;
		}

		voltageSlots.forEach(slot => {
			const voltageKey = slot.voltage;
			if (!totals[voltageKey]) {
				totals[voltageKey] = { used: 0, total: 0 };
			}
			totals[voltageKey].total += 1;
			const variant = slot.statusVariant || getEventStatusVariant(evt);
			const isDelay = variant === 'delay';
			const isPlan = variant === 'kehoach';
			if (!(isDelay || isPlan)) {
				totals[voltageKey].used += 1;
			}
		});
	});

	if (usageCountEl220) {
		if (totals['220'].total === 0) {
			usageCountEl220.textContent = '0';
		} else {
			usageCountEl220.textContent = `${totals['220'].used}/${totals['220'].total}`;
		}
	}
	if (usageCountEl110) {
		if (totals['110'].total === 0) {
			usageCountEl110.textContent = '0';
		} else {
			usageCountEl110.textContent = `${totals['110'].used}/${totals['110'].total}`;
		}
	}
}

function collectVoltageSlots(evt) {
	const slots = [];
	const baseVariant = getEventStatusVariant(evt);
	const ensureSlot = (voltage, variant, lineIndex = null) => {
		const normalizedVoltage = voltage || detectEventVoltage(evt) || "110";
		slots.push({ voltage: normalizedVoltage, statusVariant: variant || baseVariant, lineIndex });
	};

	try {
		if (Array.isArray(evt.serialDetails) && evt.serialDetails.length && isLo2Event(evt)) {
			evt.serialDetails.forEach(detail => {
				const normalizedVoltage = normalizeVoltageValue(detail?.voltageValue) || normalizeVoltageValue(detail?.voltageLabel);
				if (normalizedVoltage) {
					ensureSlot(normalizedVoltage, normalizeStatusKey(detail.status || evt.status || ""), Number(detail.lineIndex) || null);
				}
			});
			const desiredLines = Math.max(2, Number(evt.quantity) || evt.serialDetails.length || 0);
			while (slots.length < desiredLines) {
				ensureSlot(slots[0]?.voltage || detectEventVoltage(evt) || "110", baseVariant, slots.length + 1);
			}
			return slots;
		}
	} catch (e) {
		// ignore line detail issues
	}

	const voltages = [];
	try {
		if (Array.isArray(evt.serialDetails) && evt.serialDetails.length) {
			evt.serialDetails.forEach(detail => {
				const normalized = normalizeVoltageValue(detail?.voltageValue) || normalizeVoltageValue(detail?.voltageLabel);
				if (normalized) {
					voltages.push(normalized);
				}
			});
		}
	} catch (e) {
		/* noop */
	}
	if (!voltages.length && Array.isArray(evt.serials)) {
		evt.serials.forEach(serialText => {
			const parsed = parseVoltageFromSerialText(serialText);
			if (parsed) {
				voltages.push(parsed);
			}
		});
	}
	if (!voltages.length) {
		voltages.push(detectEventVoltage(evt) || "110");
	}
	const desiredCount = Math.max(1, Number(evt.quantity) || voltages.length || 1);
	while (voltages.length < desiredCount) {
		voltages.push(voltages[0]);
	}
	voltages.forEach(voltage => ensureSlot(voltage, baseVariant));
	return slots;
}

function detectEventVoltage(evt) {
	const fromDetails = (() => {
		try {
			if (Array.isArray(evt.serialDetails) && evt.serialDetails.length) {
				const vals = evt.serialDetails
					.map(detail => normalizeVoltageValue(detail?.voltageValue) || normalizeVoltageValue(detail?.voltageLabel))
					.filter(Boolean);
				if (vals.includes('220')) return '220';
				if (vals.includes('110')) return '110';
			}
		} catch (e) {
			// ignore
		}
		return null;
	})();
	if (fromDetails) return fromDetails;
	const label = String(evt.voltageLabel || '').toLowerCase();
	if (/220/.test(label)) return '220';
	if (/110/.test(label)) return '110';
	if (/[<≤less]/.test(label)) return '110';
	return '110';
}

function normalizeVoltageValue(value) {
	if (value === undefined || value === null) return null;
	const match = String(value).match(/(220|110)/);
	if (!match) return null;
	return match[1] === '220' ? '220' : '110';
}

function parseVoltageFromSerialText(text) {
	if (!text) return null;
	const match = String(text).match(/\(([^)]+)\)/);
	if (!match) return normalizeVoltageValue(text);
	return normalizeVoltageValue(match[1]);
}

function buildCalendarGrid(schedule, year, month) {
	const grid = document.getElementById("calendarGrid");
	if (!grid) {
		return;
	}
	grid.innerHTML = "";

	const headRow = document.createElement("div");
	headRow.className = "calendar-grid__head";
	weekdayLabels.forEach(label => {
		const weekdayCell = document.createElement("div");
		weekdayCell.className = "calendar-weekday";
		weekdayCell.textContent = label.toUpperCase();
		headRow.appendChild(weekdayCell);
	});
	grid.appendChild(headRow);

	const weeksContainer = document.createElement("div");
	weeksContainer.className = "calendar-weeks";
	grid.appendChild(weeksContainer);

	const eventsMap = getEventsByDate(schedule.id, year, month);
	const startDate = getCalendarStart(year, month);
	const todayISO = toISODate(new Date());
	const weekMeta = [];

	for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
		const weekWrapper = document.createElement("div");
		weekWrapper.className = "calendar-week";

		const cellsGrid = document.createElement("div");
		cellsGrid.className = "calendar-week__cells";

		const timelineLayer = document.createElement("div");
		timelineLayer.className = "calendar-week__timeline";

		const weekStart = addDays(startDate, weekIndex * 7);
		const weekEnd = addDays(weekStart, 6);
		weekMeta.push({ timelineLayer, startDate: weekStart, endDate: weekEnd });

		for (let weekday = 0; weekday < 7; weekday += 1) {
			const dayOffset = weekIndex * 7 + weekday;
			const currentDate = addDays(startDate, dayOffset);
			const iso = toISODate(currentDate);
			const inCurrentMonth = currentDate.getMonth() === month;
			const cell = document.createElement("div");
			cell.className = "calendar-cell";
			if (!inCurrentMonth) {
				cell.classList.add("calendar-cell--muted");
			}
			if (iso === todayISO) {
				cell.classList.add("calendar-cell--today");
			}

			const dateHeader = document.createElement("div");
			dateHeader.className = "calendar-cell__date";

			const dayNumber = document.createElement("strong");
			dayNumber.textContent = formatDayNumber(currentDate);
			dateHeader.appendChild(dayNumber);

			const monthBadge = document.createElement("span");
			monthBadge.textContent = formatMonthBadge(currentDate, inCurrentMonth);
			dateHeader.appendChild(monthBadge);

			const eventContainer = document.createElement("div");
			eventContainer.className = "calendar-cell__events";

			// Render non-registration events as pills. If a registration has no timeline
			// (older persisted entries), render it as a pill too so it's visible in the
			// day cell — otherwise registrations are only rendered in the timeline layer.
			(eventsMap[iso] || [])
				.map(evt => {
					if (evt.type === "registration" && !evt.timeline) {
						return renderEventPill(evt, schedule.color);
					}
					if (evt.type !== "registration") {
						return renderEventPill(evt, schedule.color);
					}
					return null;
				})
				.filter(Boolean)
				.forEach(node => eventContainer.appendChild(node));

			if (eventContainer.childElementCount) {
				cell.classList.add("calendar-cell--has-event");
			}

			cell.appendChild(dateHeader);
			cell.appendChild(eventContainer);

			if (inCurrentMonth) {
				const actionButton = createAddEventButton(iso, schedule);
				if (actionButton) {
					cell.appendChild(actionButton);
				}
			}
			cellsGrid.appendChild(cell);
		}

		weekWrapper.appendChild(cellsGrid);
		weekWrapper.appendChild(timelineLayer);
		weeksContainer.appendChild(weekWrapper);
	}

	renderTimelineBars(schedule, weekMeta, startDate);
}

function createAddEventButton(dateISO, schedule) {
	const template = getAddEventButtonTemplate();
	if (!template) {
		return null;
	}
	const button = template.content.firstElementChild.cloneNode(true);
	button.addEventListener("click", event => {
		event.stopPropagation();
		event.preventDefault();
		openRegisterModal({ dateISO, scheduleName: schedule?.name || "", scheduleId: schedule?.id || getDefaultScheduleId() });
	});
	return button;
}

function getAddEventButtonTemplate() {
	if (!addEventButtonTemplate) {
		addEventButtonTemplate = document.getElementById("calendarAddButtonTemplate");
	}
	return addEventButtonTemplate;
}

function renderEventPill(event, accentColor) {
	if (event.type === "registration" && event.timeline) {
		return renderTimelineEvent(event);
	}

	const wrapper = document.createElement("article");
	wrapper.className = "event-pill";
	if (accentColor) {
		wrapper.style.borderColor = `${accentColor}55`;
		wrapper.style.background = `${accentColor}22`;
	}

	const title = document.createElement("span");
	title.className = "event-pill__name";
	title.textContent = event.title;

	const meta = document.createElement("span");
	meta.className = "event-pill__meta";
	meta.textContent = buildEventMeta(event);

	wrapper.appendChild(title);
	wrapper.appendChild(meta);
	return wrapper;
}

function renderTimelineEvent(event) {
	const wrapper = document.createElement("article");
	wrapper.className = "timeline-event";
	if (event.tooltip) {
		wrapper.title = event.tooltip;
	}

	const summary = document.createElement("p");
	summary.className = "timeline-event__summary";
	summary.textContent = event.summary || buildRegistrationSummary(event);
	wrapper.appendChild(summary);

	const bar = document.createElement("div");
	bar.className = "timeline-event__bar";

	event.timeline.stages.forEach((stage, index) => {
		const segment = document.createElement("span");
		segment.className = `timeline-event__segment timeline-event__segment--${stage.id}`;
		segment.style.flex = String(stage.durationDays);
		segment.textContent = stage.label;
		segment.setAttribute("aria-label", `${stage.label}: ${formatStageRange(stage)}`);
		bar.appendChild(segment);

		if (index === 0) {
			const gap = document.createElement("span");
			gap.className = "timeline-event__gap";
			gap.style.flex = String(event.timeline.gapDays ?? 3);
			gap.setAttribute("aria-label", `Khoảng trống ${event.timeline.gapDays ?? 3} ngày`);
			bar.appendChild(gap);
		}
	});

	wrapper.appendChild(bar);
	return wrapper;
}

function formatStageRange(stage) {
	// Show half-day markers to avoid ambiguity: start may have a startHalf flag
	const startHalfLabel = (stage.startHalf === SECOND_HALF) ? 'SH' : 'FH';
	// Convention: stage end is the FH boundary (12:00) so mark as FH
	const endHalfLabel = 'FH';
	return `${formatCompactDate(stage.start)} ${startHalfLabel} → ${formatCompactDate(stage.end)} ${endHalfLabel}`;
}

function formatCompactDate(iso) {
	if (!iso) {
		return "";
	}
	const date = parseLocalISO(iso);
	return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function buildRegistrationSummary(event) {
	const serials = Array.isArray(event.serials) ? event.serials.join(", ") : "";
	return [
		event.furnace,
		event.registrant,
		event.quantity ? `SL ${event.quantity}` : "",
		serials ? `Serial ${serials}` : "",
		event.voltageLabel,
		event.status
	].filter(Boolean).join(" - ");
}

function buildEventMeta(event) {
	const tokens = [];
	if (event.team) {
		tokens.push(event.team);
	}
	if (event.status) {
		tokens.push(event.status);
	}
	if (event.slots) {
		tokens.push(`${event.slots} slot`);
	}
	return tokens.join(" • ");
}

function getCalendarStart(year, month) {
	const firstDay = new Date(year, month, 1);
	const weekday = firstDay.getDay();
	const mondayIndex = (weekday + 6) % 7; // convert Sunday-based index to Monday-based
	return addDays(firstDay, -mondayIndex);
}

function addDays(date, amount) {
	const result = new Date(date);
	result.setDate(result.getDate() + amount);
	return result;
}

function toISODate(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatDayNumber(date) {
	return String(date.getDate()).padStart(2, "0");
}

function formatMonthBadge(date, inCurrentMonth) {
	if (inCurrentMonth) {
		return "";
	}
	const month = date.getMonth() + 1;
	return `Thg${String(month).padStart(2, "0")}`;
}

function formatMonthLabel(year, month) {
	const monthNumber = month + 1;
	return `THÁNG ${String(monthNumber).padStart(2, "0")} NĂM ${year}`;
}

function formatFullDate(date) {
	const weekdays = [
		"Chủ nhật",
		"Thứ hai",
		"Thứ ba",
		"Thứ tư",
		"Thứ năm",
		"Thứ sáu",
		"Thứ bảy"
	];
	const dayName = weekdays[date.getDay()].toUpperCase();
	const day = String(date.getDate()).padStart(2, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const year = date.getFullYear();
	return `${dayName} ${day}/${month}/${year}`;
}

function renderTimelineBars(schedule, weekMeta, gridStartDate) {
	const gridEndDate = addDays(gridStartDate, weekMeta.length * 7 - 1);
	const registrationEvents = schedule.events.filter(evt => evt.type === "registration" && evt.timeline);

	function resolveStageMeta(evt, segment) {
		if (!evt || !segment || !evt.timeline || !Array.isArray(evt.timeline.stages)) {
			return null;
		}
		const stages = evt.timeline.stages;
		const parsedIndex = Number(segment.stageIndex);
		if (Number.isFinite(parsedIndex) && parsedIndex > 0 && stages[parsedIndex - 1]) {
			return stages[parsedIndex - 1];
		}
		const matchingId = segment.stageId || segment.type || segment.id;
		if (!matchingId) {
			return null;
		}
		return stages.find(stage => stage && (stage.id === matchingId || stage.label === segment.label)) || null;
	}

	// We'll compute `fhEndDateSet` after we decide the render timeline for
	// each event (including the Lo2 group-based rebuild). This ensures the
	// FH boundaries used to nudge phase2 starts into SH reflect the same
	// timelines we actually render (including any temporary 220kV builds).
	const fhEndDateSet = new Set();

	function otherPhase2EndsOnDate(targetISO, excludeEventId = null) {
		if (!targetISO) return false;
		try {
			for (const ev of registrationEvents) {
				if (!ev || ev.id === excludeEventId) continue;
				const st = ev.timeline?.stages?.find(s => s.id === 'phase2');
				if (!st || !st.end) continue;
				if (String(st.end) === String(targetISO)) return true;
			}
		} catch (e) {
			// ignore
		}
		return false;
	}

	// Precompute highest voltage per (furnace, baseDate) group so when multiple
	// Lo2 events share the same base start date we render their timeline using
	// the highest voltage present among them (e.g., 220 kV wins over 110 kV).
	const groupMaxVoltage = {};
	registrationEvents.forEach(evt => {
		try {
			if (!isLo2Event(evt)) return;
			const base = evt.timeline?.start || evt.date || '';
			const furnaceKey = normalizeFurnaceLabel(evt.furnace || evt.furnaceLabel || '');
			const key = `${furnaceKey}::${base}`;
			const v = (function deriveEventHighestVoltage(ev) {
				try {
					// serialDetails may be an array of objects OR legacy strings like "SN (110)".
					const detailsArray = Array.isArray(ev.serialDetails) ? ev.serialDetails : [];
					const normalized = detailsArray.map(d => {
						if (!d) return null;
						if (typeof d === 'string') {
							const m = String(d).match(/(\d{2,3})/);
							return { voltageValue: m ? m[1] : '' };
						}
						return { voltageValue: String(d.voltageValue || '') };
					}).filter(Boolean);

					if (normalized.some(d => String(d.voltageValue).trim() === '220')) return '220';
					if (normalized.some(d => String(d.voltageValue).trim() === '110')) return '110';

					// fallback to explicit voltage label on the event
					const label = String(ev.voltageLabel || '');
					if (/220/.test(label)) return '220';
					if (/110/.test(label)) return '110';

					// final fallback: parse `serials` string summaries like "ABC (220)"
					const serials = Array.isArray(ev.serials) ? ev.serials : [];
					if (serials.some(s => /220/.test(String(s)))) return '220';
					if (serials.some(s => /110/.test(String(s)))) return '110';
				} catch (e) {
					// ignore
				}
				return '110';
			})(evt) || '110';
			// store '220' if any event is 220
			if (groupMaxVoltage[key] === '220' || v === '220') {
				groupMaxVoltage[key] = '220';
			} else {
				groupMaxVoltage[key] = groupMaxVoltage[key] || '110';
			}
		} catch (e) {
			// ignore
		}
	});

	// Populate fhEndDateSet using the render timeline we will use for placement.
	// This respects any temporary Lo2 rebuilds done for 220kV visualization so
	// the FH boundaries match what will be rendered below.
	try {
		registrationEvents.forEach(evt => {
			let renderTimeline = evt.timeline;
			try {
				// Prefer the persisted `evt.timeline` when present. Only rebuild
				// a temporary visualization timeline for Lo2 when the persisted
				// timeline is missing so we don't override harmonize-saved shifts.
				if (isLo2Event(evt) && (!renderTimeline || !Array.isArray(renderTimeline.stages) || !renderTimeline.stages.length)) {
					const base = evt.timeline?.start || evt.date || '';
					const furnaceKey = normalizeFurnaceLabel(evt.furnace || evt.furnaceLabel || '');
					const groupKey = `${furnaceKey}::${base}`;
					if (groupMaxVoltage[groupKey] === '220') {
						const durations = VOLTAGE_RULES['220'] || VOLTAGE_RULES['110'];
						const built = buildTimeline(renderTimeline?.start || evt.date, durations, { allowSundaySecondHalfStart: true });
						if (built) renderTimeline = built;
					}
				}
			} catch (e) {
				renderTimeline = evt.timeline;
			}
			try {
				(renderTimeline?.stages || []).forEach(stage => {
					if (!stage || stage.id !== 'phase2' || !stage.end) return;
					const endDate = parseISODate(stage.end);
					if (!endDate) return;
					fhEndDateSet.add(toISODate(endDate));
				});
			} catch (e) {
				// ignore per-event failures
			}
		});
	} catch (e) {
		// noop
	}

	registrationEvents.forEach(evt => {
		const segmentChunkTracker = new Set();
		const chunkLabelSlicesShown = new Set();
		// Use a rendering timeline which may be rebuilt for Lo2 groups using the
		// group's highest voltage. Prefer persisted `evt.timeline`; only rebuild
		// a temporary visualization when no persisted timeline exists.
		let renderTimeline = evt.timeline;
		try {
			if (isLo2Event(evt) && (!renderTimeline || !Array.isArray(renderTimeline.stages) || !renderTimeline.stages.length)) {
				const base = evt.timeline?.start || evt.date || '';
				const furnaceKey = normalizeFurnaceLabel(evt.furnace || evt.furnaceLabel || '');
				const groupKey = `${furnaceKey}::${base}`;
				if (groupMaxVoltage[groupKey] === '220') {
					const durations = VOLTAGE_RULES['220'] || VOLTAGE_RULES['110'];
					const built = buildTimeline(renderTimeline?.start || evt.date, durations, { allowSundaySecondHalfStart: true });
					if (built) {
						// Preserve startHalf if present on original timeline for rendering cues
						if (renderTimeline && renderTimeline.startHalf && built.stages && built.stages[0]) built.stages[0].startHalf = renderTimeline.startHalf;
						renderTimeline = built;
					}
				}
			}
		} catch (e) {
			// fallback to original timeline
			renderTimeline = evt.timeline;
		}

			// Debug: report which timeline was chosen for rendering (helps diagnose 110/220 mismatch)
			try {
				const isDebugAll = (typeof localStorage !== 'undefined' && localStorage.getItem('timeline_debug') === '1');
				const isDebugThis = (typeof window !== 'undefined' && window.debugEventId && String(window.debugEventId) === String(evt.id));
				if (isDebugAll || isDebugThis) {
					console.log('[render-debug]', 'evt', evt.id, 'base', evt.timeline?.start || evt.date, 'groupKey', groupKey, 'groupMaxVoltage', groupMaxVoltage[groupKey]);
					console.log('[render-debug]', 'evt.serialDetails', evt.serialDetails, 'evt.serials', evt.serials, 'evt.voltageLabel', evt.voltageLabel);
					console.log('[render-debug]', 'originalTimeline', evt.timeline && { start: evt.timeline.start, stages: evt.timeline.stages && evt.timeline.stages.map(s=>({ id: s.id, durationDays: s.durationDays, start: s.start, end: s.end })) });
					console.log('[render-debug]', 'renderTimeline', renderTimeline && { start: renderTimeline.start, stages: renderTimeline.stages && renderTimeline.stages.map(s=>({ id: s.id, durationDays: s.durationDays, start: s.start, end: s.end })) });
				}
			} catch (e) {
				// noop
			}
		const stageSegments = renderTimeline?.segments?.filter(seg => seg.type !== "gap") || [];
		stageSegments.forEach(segment => {
			const stageMeta = resolveStageMeta(evt, segment);
			const resolvedStageStartHalf = stageMeta?.startHalf ?? segment.startHalf ?? null;
			const stageIndexValue = Number(segment.stageIndex);
			const stageIsFirst = (!Number.isNaN(stageIndexValue) && stageIndexValue === 1) || segment.type === 'phase1';
			const segmentStartISO = stageMeta?.start || segment.start;
			const segmentEndISO = stageMeta?.end || segment.end;
			// Interpret segment start/end with half-day precision:
			// - start: if segment.startHalf === SECOND_HALF (or timeline.startHalf indicates first stage SH) use 12:00, otherwise 00:00
			// - end: represent as FH (12:00) for the end day
			let segmentStart;
			try {
				const startIsSecond = Boolean(resolvedStageStartHalf === SECOND_HALF)
					|| (evt.timeline && evt.timeline.startHalf === SECOND_HALF && stageIsFirst)
					// If this is a phase2 segment and any other segment in the dataset
					// ends at FH on the same date, prefer to start this phase2 at SH
					// (second half) of that day to avoid overlapping the FH end.
					|| (segment.type === 'phase2' && otherPhase2EndsOnDate(segmentStartISO, evt.id));
				segmentStart = parseISODate(startIsSecond ? `${segmentStartISO}T12:00:00` : `${segmentStartISO}T00:00:00`);
			} catch (e) {
				segmentStart = parseISODate(segmentStartISO);
			}
			let segmentEnd;
			try {
				segmentEnd = parseISODate(`${segmentEndISO}T12:00:00`);
			} catch (e) {
				segmentEnd = parseISODate(segmentEndISO);
			}
			if (!segmentStart || !segmentEnd || segmentEnd < gridStartDate || segmentStart > gridEndDate) {
				return;
			}

			weekMeta.forEach(week => {
				const weekStartDay = stripTime(week.startDate).getTime();
				const weekEndDay = stripTime(week.endDate).getTime();
				const segmentStartDay = stripTime(segmentStart).getTime();
				const segmentEndDay = stripTime(segmentEnd).getTime();
				if (segmentEndDay < weekStartDay || segmentStartDay > weekEndDay) {
					return;
				}
				let sliceStart = clampDate(segmentStart, week.startDate, week.endDate);
				let sliceEnd = clampDate(segmentEnd, week.startDate, week.endDate);
				if (sliceStart > sliceEnd) {
					// When a segment crosses the week boundary the clamped end may land
					// earlier (e.g., start at SH Sunday but end is clamped to weekEnd FH).
					// Align the slice end to the same day/time as the start so the half-span
					// still renders the visible portion instead of being discarded.
					sliceEnd = new Date(sliceStart);
				}
				const startOffset = daysBetween(week.startDate, sliceStart);
				const endOffset = daysBetween(week.startDate, sliceEnd);

				// Use half-day columns: each calendar cell is split into two columns (first half, second half)
				// Use centralized helpers to compute the half-column indices so other modules can reuse them.
				const TOTAL_HALF_COLS = HALF_COLUMNS_PER_WEEK;

				const explicitSecondHalfOnTimeline = (evt.timeline && evt.timeline.startHalf === SECOND_HALF);
				const explicitSecondHalfOnStage = Boolean(resolvedStageStartHalf === SECOND_HALF);
				const isActualSegmentStart = stripTime(sliceStart).getTime() === stripTime(segmentStart).getTime()
					&& (
						(segmentStart.getHours && segmentStart.getHours() >= 12) ||
						explicitSecondHalfOnTimeline && stageIsFirst ||
						explicitSecondHalfOnStage
					);
				let startHalfCol = isActualSegmentStart
					? secondHalfColForDayIndex(startOffset)
					: firstHalfColForDayIndex(startOffset);
				startHalfCol = clampHalfCol(startHalfCol);

				const isActualSegmentEnd = stripTime(sliceEnd).getTime() === stripTime(segmentEnd).getTime()
					&& (segmentEnd.getHours && segmentEnd.getHours() <= 12);
				let endHalfCol = isActualSegmentEnd
					? firstHalfColForDayIndex(endOffset)
					: secondHalfColForDayIndex(endOffset);
				endHalfCol = clampHalfCol(endHalfCol);

				const halfSpan = Math.max(1, endHalfCol - startHalfCol + 1);

				// Optional debug logging for mapping dates -> half-columns
				try {
					const isDebugAll = (typeof localStorage !== 'undefined' && localStorage.getItem('timeline_debug') === '1');
					const isDebugThis = (typeof window !== 'undefined' && window.debugEventId && String(window.debugEventId) === String(evt.id));
					if (isDebugAll || isDebugThis) {
						console.log('[timeline-debug]', evt.id, segment.type, 'segmentStart', segment.start, 'segmentEnd', segment.end);
						console.log('[timeline-debug]', 'evt.timeline.startHalf', evt.timeline?.startHalf, 'segment.startHalf', segment.startHalf);
						console.log('[timeline-debug]', 'sliceStart', sliceStart.toISOString(), 'sliceEnd', sliceEnd.toISOString(), 'weekStart', week.startDate.toISOString());
						console.log('[timeline-debug]', 'startOffset', startOffset, 'endOffset', endOffset, 'startHalfCol', startHalfCol, 'endHalfCol', endHalfCol, 'halfSpan', halfSpan);
						// also log DOM geometry if available
						try {
							const cellsContainer = week.timelineLayer.parentElement ? week.timelineLayer.parentElement.querySelector('.calendar-week__cells') : null;
							const cellEls = week.timelineLayer.parentElement ? Array.from(week.timelineLayer.parentElement.querySelectorAll('.calendar-week__cells > .calendar-cell')) : [];
							console.log('[timeline-debug]', 'cells count', cellEls.length, 'cellsContainer exists', !!cellsContainer);
							if (cellEls.length) {
								const startCell = cellEls[startOffset];
								const endCell = cellEls[endOffset];
								console.log('[timeline-debug]', 'startCell index/offsetLeft/width', startOffset, startCell?.offsetLeft, startCell?.offsetWidth);
								console.log('[timeline-debug]', 'endCell index/offsetLeft/width', endOffset, endCell?.offsetLeft, endCell?.offsetWidth);
							}
						} catch (e) {
							// ignore DOM errors
						}
					}
				} catch (e) {
					// ignore
				}

				const furnaceLabel = evt.furnace || evt.furnaceLabel || "";
				const isLo2 = isLo2Event(evt);
				const isLo1 = isLo1Furnace(furnaceLabel);
				const configs = isLo2
					? buildLo2BarConfigs(evt, { ...segment, start: segmentStartISO, end: segmentEndISO })
					: [{
						text: buildStageBarLabel(evt, { ...segment, start: segmentStartISO, end: segmentEndISO }),
						placeholder: false,
						chunkKey: `stage-${segment.stageIndex ?? segment.type}`,
						row: 1
					}];

				configs.forEach(config => {
					const chunkKey = `${evt.id}:${config.chunkKey || segment.type}`;
					const sliceKey = `${chunkKey}:${week.startDate.toISOString()}`;
					if (segmentChunkTracker.has(sliceKey)) {
						return;
					}
					segmentChunkTracker.add(sliceKey);

					const isFirstLabelSlice = !chunkLabelSlicesShown.has(chunkKey);
					if (isFirstLabelSlice) {
						chunkLabelSlicesShown.add(chunkKey);
					}
					const baseText = config.placeholder ? config.text : (config.displayText ?? config.text);
					const labelText = isFirstLabelSlice ? baseText : "";

					const bar = document.createElement("button");
					const baseClasses = ["timeline-bar"];
					if (config.placeholder) {
						baseClasses.push("timeline-bar--placeholder");
					}
					const statusClass = config.statusVariant
						? `timeline-bar--status-${config.statusVariant}-lo2`
						: buildTimelineStatusClass(evt);
					if (statusClass) {
						baseClasses.push(statusClass);
					}
					bar.type = "button";
					bar.className = baseClasses.join(" ");
					bar.textContent = labelText;
					bar.dataset.hasLabel = isFirstLabelSlice ? "true" : "false";
					bar.title = baseText;
					bar.dataset.eventId = evt.id;
					bar.dataset.scheduleId = schedule.id;
					bar.dataset.baseDate = evt.timeline?.start || evt.date;
					bar.dataset.placeholder = config.placeholder ? "true" : "false";
					if (config.lineIndex) {
						bar.dataset.lineIndex = String(config.lineIndex);
					} else if (isLo1) {
						bar.dataset.lineIndex = bar.dataset.lineIndex || "1";
					}
					if (!config.placeholder && (isLo2 || isLo1)) {
						bar.dataset.lineDetail = "true";
					}
					if (isLo2) {
						bar.dataset.lo2Line = config.placeholder ? "false" : "true";
					} else if (isLo1) {
						bar.dataset.lo1Line = "true";
					}
					bar.addEventListener("click", handleTimelineButtonClick);

					// Compute pixel-based placement using actual cell elements (more accurate than width/14)
					try {
						const timelineRect = week.timelineLayer.getBoundingClientRect();
						const weekWrapper = week.timelineLayer.parentElement;
						const cellEls = weekWrapper ? Array.from(weekWrapper.querySelectorAll('.calendar-week__cells > .calendar-cell')) : [];
						const cellsContainer = weekWrapper ? weekWrapper.querySelector('.calendar-week__cells') : null;
						if (!cellsContainer || cellEls.length !== 7) {
							// fallback to previous heuristic when cell elements aren't available
							const cells = week.timelineLayer.previousElementSibling || week.timelineLayer;
							const cellsRect = cells.getBoundingClientRect();
							const halfWidth = (cellsRect.width || timelineRect.width) / 14;
							const offsetFromCellsLeft = (cellsRect.left - timelineRect.left) || 0;
							const leftPx = offsetFromCellsLeft + (startHalfCol - 1) * halfWidth;
							const widthPx = Math.max(8, halfSpan * halfWidth - 2);
							const cs = window.getComputedStyle(week.timelineLayer);
							const rowHeight = parseFloat(cs.gridAutoRows) || 26;
							const rowGap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 8;
							const topPx = ((config.row ?? 1) - 1) * (rowHeight + rowGap);
							bar.style.position = 'absolute';
							bar.style.left = `${leftPx}px`;
							bar.style.width = `${widthPx}px`;
							bar.style.top = `${topPx}px`;
						} else {
							// Ensure timelineLayer aligns to the cells container so offsets are local
							try {
								week.timelineLayer.style.left = `${cellsContainer.offsetLeft}px`;
								week.timelineLayer.style.width = `${cellsContainer.offsetWidth}px`;
							} catch (e) {
								// ignore if styling fails
							}
							// calculate using per-cell rects
							const startIndex = startOffset; // 0-based day index in week
							const endIndex = endOffset; // 0-based end index
							const startCell = cellEls[startIndex];
							const endCell = cellEls[endIndex];
							// Use bounding rects to compute local coordinates relative to cellsContainer.
							// This is more robust across sub-pixel, transforms, scrollbars and styles.
							const csRect = cellsContainer.getBoundingClientRect();
							const startRect = startCell.getBoundingClientRect();
							const endRect = endCell.getBoundingClientRect();
							const cellWidth = startRect.width || startCell.offsetWidth;
							const halfWidth = cellWidth / 2;
							const startIsSecondHalf = startHalfCol % 2 === 0;
							const endIsFirstHalf = (endHalfCol % 2 === 1);

							const startLeftLocal = (startRect.left - csRect.left) + (startIsSecondHalf ? halfWidth : 0);
							const endRightLocal = (endRect.left - csRect.left) + (endIsFirstHalf ? halfWidth : cellWidth);
							const leftPx = Math.max(0, startLeftLocal);
							const widthPx = Math.max(8, endRightLocal - startLeftLocal - 2);

							const cs = window.getComputedStyle(week.timelineLayer);
							const rowHeight = parseFloat(cs.gridAutoRows) || 26;
							const rowGap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 8;
							const topPx = ((config.row ?? 1) - 1) * (rowHeight + rowGap);

							bar.style.position = 'absolute';
							bar.style.left = `${leftPx}px`;
							bar.style.width = `${widthPx}px`;
							bar.style.top = `${topPx}px`;
						}
					} catch (e) {
						// fallback to grid placement if anything goes wrong
						bar.style.gridColumn = `${startHalfCol} / span ${halfSpan}`;
						bar.style.gridRow = String(config.row ?? 1);
					}

					week.timelineLayer.appendChild(bar);
				});
			});
		});
	});
}

function clampDate(date, min, max) {
	const minTime = stripTime(min).getTime();
	const maxTime = stripTime(max).getTime();
	const target = stripTime(date).getTime();
	if (target < minTime) return new Date(min);
	if (target > maxTime) return new Date(max);
	return new Date(date);
}

function daysBetween(start, end) {
	const startMs = stripTime(start).getTime();
	const endMs = stripTime(end).getTime();
	// Use trunc to avoid floating point rounding issues that produce off-by-one day.
	return Math.trunc((endMs - startMs) / 86400000);
}

function stripTime(date) {
	const clone = new Date(date);
	clone.setHours(0, 0, 0, 0);
	return clone;
}

// Parse ISO-like strings into a local Date (avoid Date(string) timezone quirks)
function parseLocalISO(iso) {
	if (!iso) return null;
	const s = String(iso);
	const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const y = Number(dateOnly[1]);
		const m = Number(dateOnly[2]) - 1;
		const d = Number(dateOnly[3]);
		return new Date(y, m, d, 0, 0, 0, 0);
	}
	const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
	if (dt) {
		const y = Number(dt[1]);
		const m = Number(dt[2]) - 1;
		const d = Number(dt[3]);
		const hh = Number(dt[4]);
		const mm = Number(dt[5]);
		const ss = Number(dt[6]);
		return new Date(y, m, d, hh, mm, ss, 0);
	}
	const fallback = new Date(s);
	if (isNaN(fallback)) return null;
	return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), fallback.getHours(), fallback.getMinutes(), fallback.getSeconds(), 0);
}

function parseISODate(iso) {
	return parseLocalISO(iso);
}

function buildStageBarLabel(event, segment) {
	const serialText = Array.isArray(event.serials) && event.serials.length
		? event.serials.join(", ")
		: "Chưa có serial";
	return `${event.furnace} • ${event.registrant} • ${serialText} • ${event.status} • ${segment.label}`;
}

function isLo2Event(event) {
	if (!event) return false;
	return isLo2Furnace(event.furnace || event.furnaceLabel || "");
}

function buildLo2BarConfigs(event, stage) {
	const details = Array.isArray(event.serialDetails) ? event.serialDetails : [];
	const quantity = Number(event.quantity || details.length || 0);
	const registrant = event.registrant || "";
	const configs = [];
	const baseKey = stage.id || stage.label || "stage";
	const linesToRender = Math.max(2, quantity || details.length || 0);

	for (let lineIndex = 1; lineIndex <= Math.min(linesToRender, 2); lineIndex += 1) {
		const detail = details.find(d => Number(d.lineIndex) === lineIndex) || details[lineIndex - 1] || null;
		if (detail) {
			const serialLabel = detail.serial || `Serial ${lineIndex}`;
			const voltageLabel = detail.voltageLabel || (detail.voltageValue ? `${detail.voltageValue} kV` : "");
			const serialWithVoltage = voltageLabel ? `${serialLabel} (${voltageLabel})` : serialLabel;
			const statusLabel = detail.status || event.status || "";
			const label = `Lò 2 • ${registrant} • ${serialWithVoltage} • ${statusLabel} • ${stage.label}`;
			configs.push({
				text: label,
				displayText: label,
				placeholder: false,
				chunkKey: `${baseKey}-serial-${lineIndex}`,
				row: lineIndex === 1 ? 2 : 3,
				lineIndex,
				statusVariant: normalizeStatusKey(statusLabel)
			});
			continue;
		}

		const placeholderLabel = "Lò 2 • Trống";
		configs.push({
			text: placeholderLabel,
			displayText: placeholderLabel,
			placeholder: true,
			chunkKey: `${baseKey}-placeholder-${lineIndex}`,
			row: lineIndex === 1 ? 2 : 3,
			lineIndex
		});
	}

	return configs;
}

function handleTimelineButtonClick(event) {
	event.stopPropagation();
	const button = event.currentTarget;
	if (button.dataset.placeholder === "true") {
		openLo2PlaceholderModal(button);
		return;
	}
	const { eventId, scheduleId } = button.dataset;
	if (!eventId || !scheduleId) {
		return;
	}
	const lineIndex = button.dataset.lineIndex ? Number(button.dataset.lineIndex) : null;
	const shouldOpenLineModal = button.dataset.lineDetail === "true" && lineIndex;
	if (shouldOpenLineModal) {
		openLineDetailModal({ scheduleId, eventId, lineIndex });
		return;
	}
	openEditModal({ scheduleId, eventId });
}

function openLo2PlaceholderModal(button) {
	const scheduleId = button.dataset.scheduleId || state.activeScheduleId;
	const eventId = button.dataset.eventId || null;
	let scheduleName = "";
	try {
		scheduleName = getScheduleById(scheduleId).name;
	} catch {
		scheduleName = "";
	}
	const placeholderLineIndex = Number(button.dataset.lineIndex) || null;
	if (eventId && !canOpenLo2Placeholder(scheduleId, eventId, placeholderLineIndex)) {
		try {
			if (typeof window !== "undefined" && typeof window.showToast === "function") {
				window.showToast("Không thể đăng ký line khi máy còn lại đang Đang thực hiện hoặc đã Kết thúc.", { type: "info" });
			}
		} catch (err) {
			// ignore toast failure
		}
		return;
	}
	openRegisterModal({
		dateISO: button.dataset.baseDate || toISODate(new Date()),
		enforcedDate: button.dataset.baseDate || null,
		scheduleId,
		scheduleName,
		lockedFurnace: "lo2",
		hideQuantityValues: ["2"],
		linkedEventId: eventId,
		openedViaPlaceholder: true
	});
}

function canOpenLo2Placeholder(scheduleId, eventId, placeholderLineIndex) {
	let event;
	try {
		event = getEventById(scheduleId, eventId);
	} catch (err) {
		event = null;
	}
	if (!event) {
		return true;
	}
	const details = Array.isArray(event.serialDetails) ? event.serialDetails : [];
	if (!details.length) {
		return true;
	}
	const normalizedIndex = Number(placeholderLineIndex) || 0;
	const counterpart = details.find(detail => Number(detail.lineIndex) !== normalizedIndex) || details[0];
	if (!counterpart) {
		return true;
	}
	const variant = normalizeStatusKey(counterpart.status || event.status || "");
	if (variant === "dangthuchien" || variant === "ketthuc") {
		return false;
	}
	const allowed = new Set(["kehoach", "dadangky"]);
	return allowed.has(variant);
}

const TIMELINE_STATUS_VARIANTS = new Set(["kehoach", "dadangky", "dangthuchien", "ketthuc"]);
const TIMELINE_DEFAULT_STATUS = "kehoach";

function buildTimelineStatusClass(event) {
	const variant = getEventStatusVariant(event);
	const tone = isLo2Event(event) ? "lo2" : "lo1";
	return `timeline-bar--status-${variant}-${tone}`;
}

function getEventStatusVariant(event) {
	if (!event) {
		return TIMELINE_DEFAULT_STATUS;
	}
	const statusValue = event.status || "";
	const delayFlag = event.isDelay === true
		|| event.delay === true
		|| String(event.delay || "").toLowerCase() === "true"
		|| /delay/i.test(statusValue);
	if (delayFlag) {
		return "delay";
	}
	const normalized = normalizeStatusKey(statusValue);
	return TIMELINE_STATUS_VARIANTS.has(normalized) ? normalized : TIMELINE_DEFAULT_STATUS;
}

// Debug helper exposed to the window so you can run checks from Console
// Usage in Console: `window.__checkPhase2Gaps('mba')`
// This does not require event IDs; it scans events in the given schedule
// and reports pairs where A.phase2.end -> B.phase2.start distance equals
// the configured gapDays (or B.timeline.gapDays) and prints timeline gap info.
try {
	if (typeof window !== 'undefined') {
		window.__checkPhase2Gaps = function(scheduleId = 'mba') {
			try {
				const schedule = getScheduleById(scheduleId);
				const events = (schedule.events || []).filter(e => e && e.timeline && Array.isArray(e.timeline.stages));
				function toDateAt12(isoDate) {
					if (!isoDate) return null;
					// take only the date portion (strip any time or timezone) then create a UTC midday
					const dateOnly = String(isoDate).split('T')[0];
					return new Date(`${dateOnly}T12:00:00Z`);
				}

				function dayDiffDays(aDate, bDate) {
					if (!aDate || !bDate) return NaN;
					// compute difference in whole UTC days to avoid timezone/offset issues
					const aUtc = Date.UTC(aDate.getUTCFullYear(), aDate.getUTCMonth(), aDate.getUTCDate());
					const bUtc = Date.UTC(bDate.getUTCFullYear(), bDate.getUTCMonth(), bDate.getUTCDate());
					const ms = 24 * 60 * 60 * 1000;
					return (bUtc - aUtc) / ms;
				}

				const pairs = [];
				events.forEach(a => {
					const aP2 = (a.timeline.stages || []).find(s => s.id === 'phase2');
					if (!aP2 || !aP2.end) return;
					const aEnd = toDateAt12(aP2.end);
					events.forEach(b => {
						if (a === b) return;
						const bP2 = (b.timeline.stages || []).find(s => s.id === 'phase2');
						if (!bP2 || !bP2.start) return;
						const bStart = toDateAt12(bP2.start);
						const diff = dayDiffDays(aEnd, bStart);
						// configured gap based on b's voltage label
						let cfgGap = 2;
						try {
							const lbl = String(b.voltageLabel || '').toLowerCase();
							const key = /220/.test(lbl) ? '220' : '110';
							cfgGap = (VOLTAGE_RULES && VOLTAGE_RULES[key] && Number(VOLTAGE_RULES[key].gapDays)) || cfgGap;
						} catch (e) { cfgGap = 2; }
						const bGapProp = (b.timeline && typeof b.timeline.gapDays !== 'undefined') ? b.timeline.gapDays : null;
						const gapDayStart = b.timeline && b.timeline.gapDay_start ? b.timeline.gapDay_start : null;
						const gapDayEnd = b.timeline && b.timeline.gapDay_end ? b.timeline.gapDay_end : null;
						const anchored = Math.abs(diff) < 0.0001;
						pairs.push({ a, b, aP2End: aP2.end, bP2Start: bP2.start, diffDays: diff, cfgGap, bGapProp, gapDayStart, gapDayEnd, sameFurnace: String((a.furnace||a.furnaceLabel||'')).trim() === String((b.furnace||b.furnaceLabel||'')).trim(), anchored });
					});
				});

				// debug: print each pair's computed diff so we can inspect offsets/timezone issues
				pairs.forEach(p => {
					try {
						console.log('__checkPhase2Pair', p.a.id, '->', p.b.id, 'diffDays=', p.diffDays, 'cfgGap=', p.cfgGap, 'bGapProp=', p.bGapProp, 'anchored=', p.anchored, 'aP2End=', p.aP2End, 'bP2Start=', p.bP2Start);
					} catch (e) { /* noop for safety */ }
				});

				// Matching rules:
				// - If two different events: do NOT apply per-event gapDays; prefer anchoring (anchored=true)
				// - If same event (unlikely here), fall back to configured gap matching
				const matches = pairs.filter(p => {
					try {
						if (p.a && p.b && p.a.id && p.b.id && p.a.id === p.b.id) {
							return Math.abs(p.diffDays - p.cfgGap) < 0.0001 || (p.bGapProp !== null && Math.abs(p.diffDays - p.bGapProp) < 0.0001);
						}
						// different events: anchored takes precedence
						if (p.anchored) return true;
						return false;
					} catch (e) {
						return false;
					}
				});
				console.group(`__checkPhase2Gaps: scanned ${pairs.length} pairs, matched ${matches.length}`);
				matches.forEach(p => {
					console.groupCollapsed(`${p.a.id} (${p.aP2End}) -> ${p.b.id} (${p.bP2Start}) diff=${p.diffDays}`);
					console.log('A title/furnace:', p.a.title || p.a.registrant || p.a.furnace);
					console.log('B title/furnace:', p.b.title || p.b.registrant || p.b.furnace);
					console.log('Configured gap (by B voltage):', p.cfgGap);
					console.log('B.timeline.gapDays:', p.bGapProp);
					console.log('B.timeline.gapDay_start/end:', p.gapDayStart, p.gapDayEnd);
					console.log('Same furnace?', p.sameFurnace);
					console.groupEnd();
				});
				console.groupEnd();
				return { totalPairs: pairs.length, matched: matches.length, matches };
			} catch (err) {
				console.error('__checkPhase2Gaps failed', err);
				return null;
			}
		};
	}
} catch (e) {
	// noop
}
