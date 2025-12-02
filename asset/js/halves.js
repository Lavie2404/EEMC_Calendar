// Helpers for mapping calendar cell halves to column indices in the timeline grid
export const FIRST_HALF = 'first';
export const SECOND_HALF = 'second';
export const HALF_COLUMNS_PER_WEEK = 14; // 7 days * 2 halves

export function firstHalfColForDayIndex(dayIndex) {
    return dayIndex * 2 + 1;
}

export function secondHalfColForDayIndex(dayIndex) {
    return dayIndex * 2 + 2;
}

export function clampHalfCol(col) {
    if (col < 1) return 1;
    if (col > HALF_COLUMNS_PER_WEEK) return HALF_COLUMNS_PER_WEEK;
    return col;
}
