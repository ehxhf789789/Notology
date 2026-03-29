// Shared constants for document viewers (DOCX, XLSX, PPTX, HWPX)

// Unit conversions at 96 DPI
export const EMU_PER_PIXEL = 914400 / 96;
export const TWIP_PER_PIXEL = 1440 / 96;
export const HWPUNIT_PER_PIXEL = 7200 / 96;

// Zoom bounds (shared by all viewers)
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.1;

// Dev logging
export const DEV = import.meta.env.DEV;
export const log: (...args: unknown[]) => void = DEV ? console.log.bind(console) : () => {};
