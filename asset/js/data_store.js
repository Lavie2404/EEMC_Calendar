// Data store for calendar schedules and events.

const scheduleStore = {
	mba: {
		id: "mba",
		name: "Lịch sấy MBA",
		color: "#4f81ff",
		description: "Theo dõi lịch sấy máy biến áp.",
		events: []
	},
	coil: {
		id: "coil",
		name: "Lịch quấn dây",
		color: "#38bdf8",
		description: "Tiến độ quấn dây đồng, dây điện từ cho các đơn hàng hiện tại.",
		events: []
	},
	magnet: {
		id: "magnet",
		name: "Lịch mạch từ",
		color: "#f97316",
		description: "Lịch lắp ráp và xử lý mạch từ cho các đơn hàng.",
		events: []
	}
};

// Persistence key for localStorage (versioned)
const PERSIST_KEY = "eemc.calendar.scheduleEvents.v1";

function persistEvents() {
	try {
		const payload = Object.fromEntries(
			Object.keys(scheduleStore).map(id => [id, scheduleStore[id].events || []])
		);
		localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
	} catch (err) {
		console.warn("Failed to persist calendar events:", err);
	}
}

function loadPersistedEvents() {
	try {
		const raw = localStorage.getItem(PERSIST_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			for (const id of Object.keys(parsed)) {
				if (scheduleStore[id]) {
						// normalize persisted events for backward compatibility
						scheduleStore[id].events = Array.isArray(parsed[id]) ? parsed[id].map(normalizePersistedEvent) : [];
				} else {
					// If a persisted schedule id is unknown, create a minimal placeholder
					scheduleStore[id] = {
						id,
						name: id,
						color: "#777",
						slotQuota: 0,
						description: "(Imported)",
								events: Array.isArray(parsed[id]) ? (parsed[id].map(normalizePersistedEvent)) : []
					};
				}
			}
		}
	} catch (err) {
		console.warn("Failed to load persisted calendar events:", err);
	}
}

let eventSequence = 0;
function generateEventId() {
	return `evt_${Date.now()}_${eventSequence++}`;
}

const DEFAULT_LINE_STATUS = "Kế hoạch";

// Helpers to normalize serial details stored in persisted events
function parseSerialSummary(text = "") {
	const match = String(text).match(/^(.*?)\s*\(([^)]+)\)/);
	const serial = (match ? match[1] : text).trim();
	const voltageLabel = match ? match[2].trim() : "";
	const voltageValueMatch = String(voltageLabel).match(/(\d{2,3})/);
	return {
		serial,
		voltageValue: voltageValueMatch ? voltageValueMatch[1] : "",
		voltageLabel: voltageLabel || (voltageValueMatch ? `${voltageValueMatch[1]} kV` : "")
	};
}

function normalizePersistedEvent(evt) {
	if (!evt || typeof evt !== 'object') return evt;
	try {
		// normalize serialDetails: accept array of objects or fallback to parsing serials array
		let details = Array.isArray(evt.serialDetails) ? evt.serialDetails.slice(0) : [];
		if (!details.length && Array.isArray(evt.serials) && evt.serials.length) {
			details = evt.serials.map(s => parseSerialSummary(s));
		}
		// normalize each detail to object with expected keys
		details = details.map((d, i) => {
			if (!d) return null;
			if (typeof d === 'string') {
				const parsed = parseSerialSummary(d);
				return { serial: parsed.serial, voltageValue: String(parsed.voltageValue || '').trim(), voltageLabel: parsed.voltageLabel || '' , lineIndex: i+1, status: DEFAULT_LINE_STATUS, history: [] };
			}
			const statusLabel = d.status || DEFAULT_LINE_STATUS;
			const historyEntries = Array.isArray(d.history) && d.history.length
				? d.history.map(entry => ({
					status: entry.status || statusLabel,
					actor: entry.actor || d.registrant || '',
					timestamp: entry.timestamp || new Date().toISOString()
				}))
				: [{ status: statusLabel, actor: d.registrant || '', timestamp: new Date().toISOString() }];
			return {
				serial: String(d.serial || '').trim(),
				voltageValue: String(d.voltageValue || '').trim(),
				voltageLabel: d.voltageLabel || (d.voltageValue ? `${String(d.voltageValue).trim()} kV` : ''),
				registrant: d.registrant || '',
				lineIndex: d.lineIndex || (i+1),
				status: statusLabel,
				history: historyEntries
			};
		}).filter(Boolean);

		evt.serialDetails = details;

		// ensure serials array mirrors serialDetails for compatibility
		try {
			evt.serials = Array.isArray(evt.serials) && evt.serials.length ? evt.serials : evt.serialDetails.map(d => d && d.serial ? `${d.serial} (${d.voltageLabel || ''})`.trim() : '');
		} catch (e) {
			// noop
		}

		// ensure voltageLabel is derived when missing
		if (!evt.voltageLabel) {
			const has220 = evt.serialDetails.some(d => String(d.voltageValue || '').trim() === '220');
			evt.voltageLabel = has220 ? '220 kV' : (evt.serialDetails.some(d => String(d.voltageValue || '').trim() === '110') ? '110 kV' : (evt.voltageLabel || ''));
		}
	} catch (e) {
		// ignore normalization failures
	}
	return evt;
}

// Parse ISO-like strings into a local Date (avoid Date(string) timezone quirks)
function parseLocalISO(iso) {
	if (!iso) return null;
	const s = String(iso);
	// date-only: YYYY-MM-DD -> local midnight
	const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const y = Number(dateOnly[1]);
		const m = Number(dateOnly[2]) - 1;
		const d = Number(dateOnly[3]);
		return new Date(y, m, d, 0, 0, 0, 0);
	}
	// datetime: YYYY-MM-DDTHH:mm:ss
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
	// fallback: parse then convert to local components
	const fallback = new Date(s);
	if (isNaN(fallback)) return null;
	return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), fallback.getHours(), fallback.getMinutes(), fallback.getSeconds(), 0);
}

export function parseISODate(isoDate) {
	// public API kept: parse date-only as local midnight, datetime as local time
	return parseLocalISO(isoDate);
}

export function getSchedules() {
	return Object.values(scheduleStore).map(({ events, ...meta }) => ({ ...meta }));
}

export function getScheduleById(id) {
	const schedule = scheduleStore[id];
	if (!schedule) {
		throw new Error(`Không tìm thấy lịch với id "${id}".`);
	}
	return schedule;
}

export function getEventsForMonth(scheduleId, year, month) {
	const schedule = getScheduleById(scheduleId);
	return schedule.events
		.filter(evt => {
			const date = parseISODate(evt.date);
			return date.getFullYear() === year && date.getMonth() === month;
		})
		.sort((a, b) => parseISODate(a.date) - parseISODate(b.date));
}

export function getEventsByDate(scheduleId, year, month) {
	const events = getEventsForMonth(scheduleId, year, month);
	return events.reduce((acc, evt) => {
		if (!acc[evt.date]) {
			acc[evt.date] = [];
		}
		acc[evt.date].push(evt);
		return acc;
	}, {});
}

export function getSlotUsageForMonth(scheduleId, year, month) {
	const events = getEventsForMonth(scheduleId, year, month);
	return events.reduce((total, evt) => total + (evt.slots || 0), 0);
}

export function get(scheduleId) {
	return getScheduleById(scheduleId).slotQuota ?? null;
}

export function getDefaultScheduleId() {
	return "mba";
}

export function saveRegistration(scheduleId, registration) {
	const schedule = getScheduleById(scheduleId);
	const event = {
		id: registration.id || generateEventId(),
		date: registration.date,
		title: registration.title || registration.furnaceLabel || "Đăng ký",
		slots: registration.quantity ?? 0,
		type: "registration",
		summary: registration.summary,
		tooltip: registration.tooltip,
		furnace: registration.furnaceLabel,
		registrant: registration.registrant,
		quantity: registration.quantity,
		serials: registration.serials,
		serialDetails: registration.serialDetails ?? [],
		voltageLabel: registration.voltageLabel,
		status: registration.status,
		isDelay: Boolean(registration.isDelay),
		timeline: registration.timeline,
		// optional hint whether this registration starts at the first or second half of the day
		startHalf: registration.startHalf || (registration.timeline && registration.timeline.startHalf) || null
	};
	// normalize serial details before persisting
	const normalized = normalizePersistedEvent({ ...event });
	schedule.events.push(normalized);
	// persist after change
	try {
		persistEvents();
	} catch (err) {
		console.warn('persistEvents failed after saveRegistration', err);
	}
	return event;
}

export function getEventById(scheduleId, eventId) {
	const schedule = getScheduleById(scheduleId);
	return schedule.events.find(evt => evt.id === eventId) || null;
}

// Update an existing event (by id) in the schedule and persist changes.
export function updateEvent(scheduleId, updatedEvent) {
	const schedule = getScheduleById(scheduleId);
	const idx = schedule.events.findIndex(evt => evt.id === updatedEvent.id);
	if (idx === -1) return null;
	// keep reference semantics for other code that may hold the object
	schedule.events[idx] = { ...schedule.events[idx], ...updatedEvent };
	// ensure persisted copy is normalized
	schedule.events[idx] = normalizePersistedEvent(schedule.events[idx]);
	try {
		persistEvents();
	} catch (err) {
		console.warn('persistEvents failed after updateEvent', err);
	}
	return schedule.events[idx];
}

export function deleteEvent(scheduleId, eventId) {
	const schedule = getScheduleById(scheduleId);
	const idx = schedule.events.findIndex(evt => evt.id === eventId);
	if (idx === -1) return null;
	const [removed] = schedule.events.splice(idx, 1);
	// persist after change
	try {
		persistEvents();
	} catch (err) {
		console.warn('persistEvents failed after deleteEvent', err);
	}
	return removed || null;
}

// Exported helper to clear persisted data (useful for testing)
export function clearPersistedData() {
	try {
		localStorage.removeItem(PERSIST_KEY);
	} catch (err) {
		console.warn('Failed to clear persisted data', err);
	}
	// also clear in-memory events
	Object.keys(scheduleStore).forEach(id => {
		scheduleStore[id].events = [];
	});
}

// Load persisted events on module import
loadPersistedEvents();
