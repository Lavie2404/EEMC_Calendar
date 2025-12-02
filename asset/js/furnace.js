export function normalizeFurnaceLabel(value = "") {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

export function isLo2Furnace(value = "") {
    const v = normalizeFurnaceLabel(value);
    // Accept common variants: "lò 2", "lo 2", "lò2", "lo2" (after normalize -> spaces normalized)
    return v === "lò 2" || v === "lo 2" || v === "lò2" || v === "lo2" || v === "lo2" || v === "lò2" || v === "lo 2";
}

export function isLo1Furnace(value = "") {
    const v = normalizeFurnaceLabel(value);
    return v === "lò 1" || v === "lo 1" || v === "lò1" || v === "lo1";
}
